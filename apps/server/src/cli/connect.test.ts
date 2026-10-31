import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { acquireRelayClientForLink, formatCloudStatus } from "./connect.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

const statusBase = {
  desired: false,
  exposed: false,
  authenticated: false,
  linked: false,
  revoked: false,
  cloudUserId: null,
  relayUrl: null,
  publishAgentActivity: false,
  relayClient: managedExecutable,
  linkMode: "managed",
  reachability: null,
} as const;

it.each([
  {
    label: "a link the desktop app made reports its tunnel, not the CLI's empty state",
    status: {
      ...statusBase,
      exposed: true,
      linked: true,
      reachability: {
        status: "reachable",
        checkedAt: "2026-10-31T18:06:14.587Z",
        readyConnections: 4,
        protocol: "quic",
      },
    },
    lines: ["  Exposure: enabled", "  CLI sign-in: not signed in", "✓ Other devices can reach"],
    absent: ["Next:", "No running server answered"],
  },
  {
    label: "a desktop link with the app closed says no server answered and asks for no sign-in",
    status: { ...statusBase, exposed: true, linked: true },
    lines: ["  Exposure: enabled", "No running server answered"],
    absent: ["Next:"],
  },
  {
    label: "a publish-only link exposes nothing and needs no sign-in or reachability check",
    status: { ...statusBase, desired: true, linked: true, linkMode: "publish_only" },
    lines: ["  Exposure: disabled"],
    absent: ["Next:", "No running server answered"],
  },
  {
    label: "a machine with no link is told to link",
    status: statusBase,
    lines: ["  Exposure: disabled", "Next: Run `t3 connect link` to authorize and enable"],
    absent: ["No running server answered"],
  },
  {
    label: "a revoked link is told to link again even when the CLI is signed out",
    status: { ...statusBase, linked: true, revoked: true },
    lines: ["  Environment link: removed", "Next: Run `t3 connect link` to link this environment"],
    absent: ["No running server answered"],
  },
  {
    label: "a signed-in link waiting for the server is told to start T3",
    status: { ...statusBase, desired: true, exposed: true, authenticated: true },
    lines: ["  CLI sign-in: stored credential", "Next: Start T3 to provision"],
    absent: [],
  },
] satisfies ReadonlyArray<{
  label: string;
  status: Parameters<typeof formatCloudStatus>[0];
  lines: ReadonlyArray<string>;
  absent: ReadonlyArray<string>;
}>)("status: $label", ({ status, lines, absent }) => {
  const output = formatCloudStatus(status);
  for (const line of lines) assert.include(output, line);
  for (const line of absent) assert.notInclude(output, line);
});

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);
