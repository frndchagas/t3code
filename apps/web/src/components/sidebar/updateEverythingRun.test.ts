import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import type { UpdateEverythingRun, UpdateRunMachine } from "./updateEverything.logic";
import {
  retryFailedUpdateRunServers,
  setUpdateEverythingRun,
  startDesktopUpdateLaunchNotice,
} from "./updateEverythingRun";

const serverVersions = vi.hoisted(() => new Map<string, string>());

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: ((environmentId: string) => {
        const serverVersion = serverVersions.get(environmentId);
        return Atom.make(serverVersion === undefined ? null : { environment: { serverVersion } });
      }) as never,
    },
  };
});

function relaunchWhileRestarting(environmentId: EnvironmentId) {
  const now = 1_800_000_000_000;
  vi.useFakeTimers({ now });
  const store = new Map([
    [
      "t3code:update-everything-result:v1",
      JSON.stringify({
        savedAt: now,
        localVersion: null,
        updatedServers: 0,
        updatedProviders: 0,
        failures: [],
        handedOff: [{ environmentId, label: "Slow", targetVersion: "9.9.9", startedAt: now }],
      }),
    ],
  ]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
    },
  });
  return startDesktopUpdateLaunchNotice();
}

describe("startDesktopUpdateLaunchNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a server that is still restarting from looking idle after the app relaunches", async () => {
    const environmentId = EnvironmentId.make("slow-machine");
    const stop = relaunchWhileRestarting(environmentId);
    try {
      // Lets the registry run its cleanup of unobserved atoms before the UI mounts.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(appAtomRegistry.get(serverEnvironment.updateStateAtom(environmentId))).toMatchObject({
        status: "running",
        stage: "resuming",
        targetVersion: "9.9.9",
      });
    } finally {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      stop();
    }
  });

  it("clears the restored state when the server never comes back", async () => {
    const environmentId = EnvironmentId.make("lost-machine");
    const stateAtom = serverEnvironment.updateStateAtom(environmentId);
    const stop = relaunchWhileRestarting(environmentId);
    // Observed like the UI does, so the registry cannot reset it by dropping the atom.
    const release = appAtomRegistry.mount(stateAtom);
    try {
      await vi.advanceTimersByTimeAsync(32 * 60 * 1000);
      expect(appAtomRegistry.get(stateAtom)).toEqual({ status: "idle" });
    } finally {
      release();
      stop();
    }
  });
});

function failedMachine(environmentId: EnvironmentId, targetVersion: string): UpdateRunMachine {
  return {
    environmentId,
    label: environmentId,
    updatesProviders: false,
    server: {
      environmentId,
      serverLabel: environmentId,
      selfUpdate: "desktop-managed",
      desktopAppUpdate: true,
      targetVersion,
    },
    handedOffVersion: null,
    startedAt: 0,
    result: "failed",
    failure: "The desktop app update failed.",
    providerFailure: null,
  };
}

describe("retryFailedUpdateRunServers", () => {
  it("settles a server that reached its target since it failed instead of updating it again", () => {
    const current = EnvironmentId.make("updated-elsewhere");
    const behind = EnvironmentId.make("still-behind");
    serverVersions.set(current, "0.1.7-nightly.20261103.4119");
    serverVersions.set(behind, "0.1.7-nightly.20261102.4067");
    setUpdateEverythingRun(() => ({
      localVersion: null,
      phase: "servers",
      restartAt: null,
      machines: [
        failedMachine(current, "0.1.7-nightly.20261103.4119"),
        failedMachine(behind, "0.1.7-nightly.20261103.4119"),
      ],
    }));
    const update = vi.fn<Parameters<typeof retryFailedUpdateRunServers>[0]>(
      () => new Promise(() => {}),
    );

    retryFailedUpdateRunServers(update);

    expect(update.mock.calls.map(([target]) => target.environmentId)).toEqual([behind]);
    let run: UpdateEverythingRun | null = null;
    setUpdateEverythingRun((latest) => (run = latest));
    expect(run).toMatchObject({
      machines: [
        { environmentId: current, result: "done", failure: null, server: null },
        { environmentId: behind, result: null, failure: null },
      ],
    });
    setUpdateEverythingRun(() => null);
  });
});
