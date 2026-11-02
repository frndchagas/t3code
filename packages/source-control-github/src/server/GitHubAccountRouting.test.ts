import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import { services } from "./driver.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";

const ACTIVE = "token-personal";
const OTHER = "token-work";

const pullRequest = (number: number) => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  author: null,
  baseRefName: "main",
  headRefName: `feat/${number}`,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  latestReviews: { nodes: [] },
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  updatedAt: "2026-08-24T12:34:56.000Z",
  mergedAt: null,
  closedAt: null,
  commits: { nodes: [] },
  stack: null,
  stackEntry: null,
});

function harness(options?: { readonly savedToken?: string }) {
  const visibleTo: Record<string, ReadonlyArray<string>> = {
    [ACTIVE]: ["personal"],
    [OTHER]: ["work"],
    "token-saved": ["personal"],
  };
  const requests: Array<{ readonly token: string; readonly owners: ReadonlyArray<string> }> = [];
  const ghCalls: Array<string> = [];

  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
    Effect.sync(() => {
      if (input.args[0] === "config") {
        // No `http_unix_socket`, so every request reaches the test HTTP client.
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      ghCalls.push(input.args.join(" "));
      const user = input.args.includes("--user")
        ? input.args[input.args.indexOf("--user") + 1]
        : undefined;
      const stdout = input.args.includes("status")
        ? JSON.stringify({
            hosts: {
              "github.com": [
                { login: "personal", state: "success", active: true },
                { login: "work", state: "success", active: false },
                { login: "expired", state: "timeout", active: false },
              ],
            },
          })
        : `${user === undefined ? ACTIVE : `token-${user}`}\n`;
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });

  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const token = (request.headers["authorization"] ?? "").replace("Bearer ", "");
        const body = JSON.parse(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
        ) as { readonly variables?: Record<string, unknown> };
        const variables = body.variables ?? {};
        const aliases = Object.keys(variables)
          .filter((name) => name.endsWith("owner"))
          .map((name) => name.slice(0, -"owner".length));
        const owners = aliases.map((alias) => String(variables[`${alias}owner`]));
        requests.push({ token, owners });
        const data: Record<string, unknown> = {};
        const errors: Array<unknown> = [];
        for (const alias of aliases) {
          const field = `${alias}repository`;
          const owner = String(variables[`${alias}owner`]).toLowerCase();
          const visible = visibleTo[token]?.includes(owner) === true;
          data[field] = visible
            ? { pullRequest: pullRequest(Number(variables[`${alias}number`])) }
            : null;
          if (!visible) {
            errors.push({ type: "NOT_FOUND", path: [field], message: "Could not resolve." });
          }
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ data, ...(errors.length > 0 ? { errors } : {}) }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

  const layer = services.pipe(
    Layer.provideMerge(SourceControlRateLimit.layer),
    Layer.provideMerge(
      TestSourceControlHost.layer({
        settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          sourceControlHosts: {
            github: options?.savedToken ? { tokens: { "github.com": options.savedToken } } : {},
          },
        }),
        process: { run },
      }),
    ),
    Layer.provide(http),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  );
  return { layer, requests, ghCalls, visibleTo };
}

const read = (owner: string, number = 1) =>
  Effect.gen(function* () {
    const provider = yield* GitHubPullRequestProvider.make;
    return yield* provider.getChangeRequestSummary!({
      cwd: "/w",
      host: "github.com",
      repository: `${owner}/repository`,
      number,
    });
  });

describe("GitHubAccountRouting", () => {
  beforeEach(() => {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.live("reads through the account that sees the owner, then goes straight to it", () => {
    const { layer, requests, ghCalls } = harness();
    return Effect.gen(function* () {
      const first = yield* read("work", 526);
      assert.strictEqual(first.number, 526);
      assert.deepStrictEqual(
        requests.map((request) => request.token),
        [ACTIVE, OTHER],
      );

      const second = yield* read("Work", 7);
      assert.strictEqual(second.number, 7);
      assert.deepStrictEqual(
        requests.map((request) => request.token),
        [ACTIVE, OTHER, OTHER],
        "the same owner skips the account that cannot see it",
      );
      assert.lengthOf(
        ghCalls.filter((call) => call.includes("status")),
        1,
      );
      assert.isFalse(
        ghCalls.some((call) => call.includes("--user expired")),
        "a login gh reports as broken is never asked for its token",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("batches each account's reads apart so none is sent the other's repository", () => {
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      yield* read("work", 1);
      requests.length = 0;
      const [personal, work] = yield* Effect.all([read("personal", 2), read("work", 3)], {
        concurrency: "unbounded",
      });
      assert.strictEqual(personal.number, 2);
      assert.strictEqual(work.number, 3);
      assert.sameDeepMembers(requests, [
        { token: ACTIVE, owners: ["personal"] },
        { token: OTHER, owners: ["work"] },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps accounts apart when a routed read starts ahead of an active one", () => {
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      yield* read("work", 1);
      requests.length = 0;
      const answers = yield* Effect.all(
        [read("work", 2), read("work", 3), read("personal", 4), read("personal", 5)],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(
        answers.map((answer) => answer.number),
        [2, 3, 4, 5],
      );
      assert.sameDeepMembers(requests, [
        { token: OTHER, owners: ["work", "work"] },
        { token: ACTIVE, owners: ["personal", "personal"] },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("answers not-found when no account sees it, and remembers nothing", () => {
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(read("nobody"));
      assert.strictEqual(error.reason, "not-found");
      assert.deepStrictEqual(
        requests.map((request) => request.token),
        [ACTIVE, OTHER],
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("goes back to the active account when the remembered one loses access", () => {
    const { layer, requests, visibleTo } = harness();
    return Effect.gen(function* () {
      yield* read("work");
      visibleTo[OTHER] = [];
      visibleTo[ACTIVE] = ["personal", "work"];
      requests.length = 0;

      yield* read("work");
      assert.deepStrictEqual(
        requests.map((request) => request.token),
        [OTHER, ACTIVE],
      );
      requests.length = 0;

      yield* read("work");
      assert.deepStrictEqual(
        requests.map((request) => request.token),
        [ACTIVE],
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("never routes around a token saved in Settings", () => {
    const { layer, requests, ghCalls } = harness({ savedToken: "token-saved" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(read("work"));
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(
        requests.map((request) => request.token),
        ["token-saved"],
      );
      assert.deepStrictEqual(ghCalls, []);
    }).pipe(Effect.provide(layer));
  });

  it.live("leaves writes on the active account even where a read was routed", () => {
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      yield* read("work");
      requests.length = 0;
      const provider = yield* GitHubPullRequestProvider.make;
      const exit = yield* Effect.exit(
        provider.comment({
          cwd: "/w",
          host: "github.com",
          repository: "work/repository",
          number: 1,
          body: "hello",
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.isNotEmpty(requests);
      assert.isTrue(requests.every((request) => request.token === ACTIVE));
    }).pipe(Effect.provide(layer));
  });
});
