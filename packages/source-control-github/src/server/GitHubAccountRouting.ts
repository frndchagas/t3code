import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import type { GitHubPullRequestApi } from "./GitHubPullRequestApi.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

const ACCOUNTS_TTL = Duration.minutes(5);
const MAX_ROUTES = 256;

const AuthStatus = Schema.fromJsonString(
  Schema.Struct({
    hosts: Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ login: Schema.String, state: Schema.String })),
    ),
  }),
);
const decodeAuthStatus = Schema.decodeUnknownOption(AuthStatus);

interface GitHubAccount {
  readonly login: string;
  readonly credential: GitHubRequestPolicy.GitHubHeldCredential;
}

export interface GitHubAccountRoutingShape {
  /** Runs a read as whichever `gh` account can see the repository's owner. */
  readonly route: <A, E, R>(
    input: { readonly host: string; readonly repository: string },
    read: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export const GitHubAccountRouting = Context.Reference<GitHubAccountRoutingShape>(
  "@t3tools/source-control-github/server/GitHubAccountRouting",
  { defaultValue: () => ({ route: (_input, read) => read }) },
);

/**
 * GitHub answers NOT_FOUND to an account that cannot see a private repository, and `gh` holds one
 * active account per host. A not-found read tries the other logins, and the owner remembers the one
 * that answered, so later reads skip the failure and batch under that account. Only reads route:
 * writing as an account nobody chose is not this layer's call.
 */
const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const workingDirectory = yield* HostProcess.WorkingDirectory;
  const routes = new Map<string, string>();

  const runGh = (operation: string, args: ReadonlyArray<string>) =>
    process
      .run({
        operation,
        command: "gh",
        args: [...args],
        cwd: workingDirectory,
        // Never let gh print a token into a debug log.
        env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
        timeoutMs: 10_000,
        concurrency: GitHubCredentials.GH_PROCESS_CONCURRENCY,
      })
      .pipe(Effect.map((output) => output.stdout.trim()));

  const accountOf = (host: string, login: string) =>
    runGh("GitHubAccountRouting.token", [
      "auth",
      "token",
      "--hostname",
      host,
      "--user",
      login,
    ]).pipe(
      Effect.flatMap((token) =>
        token === ""
          ? Effect.succeed(Option.none<GitHubAccount>())
          : credentials.fingerprint(host, token).pipe(
              Effect.map((fingerprint) =>
                Option.some<GitHubAccount>({
                  login,
                  credential: { source: "gh", token: Redacted.make(token), fingerprint },
                }),
              ),
            ),
      ),
      Effect.orElseSucceed(() => Option.none<GitHubAccount>()),
    );

  // An account gh cannot hand over is left out rather than failing the read that wanted it.
  const accounts = yield* Cache.makeWith(
    (host: string) =>
      runGh("GitHubAccountRouting.accounts", [
        "auth",
        "status",
        "--hostname",
        host,
        "--json",
        "hosts",
      ]).pipe(
        Effect.map((output) =>
          Option.match(decodeAuthStatus(output), {
            onNone: () => [],
            onSome: (status) =>
              (status.hosts[host] ?? [])
                .filter((account) => account.state === "success")
                .map((account) => account.login),
          }),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
        Effect.flatMap((logins) =>
          Effect.forEach(logins, (login) => accountOf(host, login), { concurrency: "unbounded" }),
        ),
        Effect.map((found) => found.flatMap((account) => Option.toArray(account))),
      ),
    { capacity: 8, timeToLive: () => ACCOUNTS_TTL },
  );

  /** A token saved in Settings or set in the environment is a choice, so nothing routes around it. */
  const activeGhFingerprint = (host: string) =>
    credentials.get(host).pipe(
      Effect.map((active) => (active.source === "gh" ? active.fingerprint : null)),
      Effect.orElseSucceed(() => null),
    );

  const asAccount = <A, E, R>(host: string, account: GitHubAccount, read: Effect.Effect<A, E, R>) =>
    read.pipe(
      Effect.provideService(SourceControlRateLimit.CredentialScope, account.credential.fingerprint),
      Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
        host,
        token: account.credential.token,
        credentialFingerprint: account.credential.fingerprint,
        source: "gh",
      }),
    );

  const remember = (key: string, login: string | null) =>
    Effect.sync(() => {
      if (login === null) {
        routes.delete(key);
        return;
      }
      if (routes.size >= MAX_ROUTES && !routes.has(key)) routes.clear();
      routes.set(key, login);
    });

  const isNotFound = Schema.is(GitHubRequestPolicy.GitHubApiNotFoundError);

  const route = Effect.fnUntraced(function* <A, E, R>(
    input: { readonly host: string; readonly repository: string },
    read: Effect.Effect<A, E, R>,
  ) {
    // A pinned read already belongs to the account an operation verified.
    if ((yield* GitHubRequestPolicy.PinnedGitHubCredential) !== null) return yield* read;
    // A batch runs in the fiber of whichever read started it, so an active read joining a window a
    // routed one opened would inherit its pin unless it states its own.
    const asActive = read.pipe(
      Effect.provideService(
        SourceControlRateLimit.CredentialScope,
        yield* SourceControlRateLimit.CredentialScope,
      ),
      Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, null),
    );
    const host = normalizeHost(input.host);
    const active = yield* activeGhFingerprint(host);
    if (active === null) return yield* read;
    const key = `${host}/${input.repository.split("/")[0]?.toLowerCase() ?? ""}`;

    const tryEach = (
      remaining: ReadonlyArray<GitHubAccount>,
      original: E,
    ): Effect.Effect<A, E, R> => {
      const [account, ...rest] = remaining;
      if (account === undefined) return Effect.fail(original);
      const isActive = account.credential.fingerprint === active;
      return (isActive ? asActive : asAccount(host, account, read)).pipe(
        Effect.tap(() => remember(key, isActive ? null : account.login)),
        Effect.catchIf(isNotFound, () => tryEach(rest, original)),
      );
    };
    const others = (tried: (account: GitHubAccount) => boolean) =>
      Cache.get(accounts, host).pipe(
        Effect.map((held) => held.filter((account) => !tried(account))),
      );

    const login = routes.get(key);
    const remembered =
      login === undefined
        ? undefined
        : (yield* Cache.get(accounts, host)).find((held) => held.login === login);
    if (remembered === undefined) {
      if (login !== undefined) yield* remember(key, null);
      return yield* asActive.pipe(
        Effect.catchIf(isNotFound, (error) =>
          others((account) => account.credential.fingerprint === active).pipe(
            Effect.flatMap((rest) => tryEach(rest, error)),
          ),
        ),
      );
    }
    return yield* asAccount(host, remembered, read).pipe(
      Effect.catchIf(isNotFound, (error) =>
        others((account) => account.login === remembered.login).pipe(
          Effect.flatMap((rest) => tryEach(rest, error)),
        ),
      ),
    );
  });

  return { route } satisfies GitHubAccountRoutingShape;
});

export const layer = Layer.effect(GitHubAccountRouting, make);

type Api = GitHubPullRequestApi["Service"];

/** The API with its pull request reads routed; everything else, writes included, stays as it is. */
export const withRoutedReads = (api: Api, { route }: GitHubAccountRoutingShape): Api => {
  const reads: Pick<
    Api,
    | "getPullRequestSummary"
    | "getPullRequestWatchFingerprint"
    | "revalidateChecks"
    | "getPullRequestDetail"
    | "getPullRequestPreview"
    | "getPullRequestStack"
    | "getPullRequestActivity"
    | "getPullRequestDiff"
    | "getPullRequestDiffFileContents"
    | "getPullRequestFilesViewed"
    | "getPullRequestFileStats"
    | "listReviewThreadComments"
    | "getReviewThreadComments"
    | "getViewerAccess"
  > = {
    getPullRequestSummary: (input) => route(input, api.getPullRequestSummary(input)),
    getPullRequestWatchFingerprint: (input) =>
      route(input, api.getPullRequestWatchFingerprint(input)),
    revalidateChecks: (input, read) => route(input, api.revalidateChecks(input, read)),
    getPullRequestDetail: (input) => route(input, api.getPullRequestDetail(input)),
    getPullRequestPreview: (input) => route(input, api.getPullRequestPreview(input)),
    getPullRequestStack: (input) => route(input, api.getPullRequestStack(input)),
    getPullRequestActivity: (input) => route(input, api.getPullRequestActivity(input)),
    getPullRequestDiff: (input) => route(input, api.getPullRequestDiff(input)),
    getPullRequestDiffFileContents: (input) =>
      route(input, api.getPullRequestDiffFileContents(input)),
    getPullRequestFilesViewed: (input) => route(input, api.getPullRequestFilesViewed(input)),
    getPullRequestFileStats: (input) => route(input, api.getPullRequestFileStats(input)),
    listReviewThreadComments: (input) => route(input, api.listReviewThreadComments(input)),
    getReviewThreadComments: (input) => route(input, api.getReviewThreadComments(input)),
    getViewerAccess: (input) => route(input, api.getViewerAccess(input)),
  };
  // Inherit rather than copy: a mocked API answers for the methods it does not implement.
  return Object.assign(Object.create(api) as Api, reads);
};
