import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import type {
  VoiceTranscriptCorrectionInput,
  VoiceTranscriptCorrectionResult,
} from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as VoiceTranscriptCorrection from "./VoiceTranscriptCorrection.ts";

const NOW = DateTime.makeUnsafe("2026-10-29T12:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-1");
const TRANSCRIPT = "faz o rebeise da fork nightly";

const withService = <A, E>(
  options: {
    readonly settings?: Partial<ServerSettingsValue>;
    readonly providerEnabled?: boolean;
    readonly reply?: Effect.Effect<VoiceTranscriptCorrectionResult, TextGenerationError>;
  },
  body: (harness: {
    readonly correct: (threadId?: ThreadId) => Effect.Effect<string>;
    readonly requests: Array<VoiceTranscriptCorrectionInput>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const requests: Array<VoiceTranscriptCorrectionInput> = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(ServerConfig.ServerConfig)({ cwd: "/server" } as never),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...options.settings }),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId: ProjectId.make("project-1"), worktreePath: null },
            messages: [
              {
                role: "assistant",
                text: "fork/nightly is ready for a rebase onto the new tag.",
                createdBy: "agent",
                createdAt: NOW,
                streaming: false,
              },
            ],
          } as never),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed({ enabled: options.providerEnabled ?? true } as never),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () => Effect.succeedSome({ workspaceRoot: "/workspace/project" } as never),
      }),
      Layer.mock(TextGeneration.TextGeneration)({
        correctVoiceTranscript: (input) =>
          Effect.sync(() => requests.push(input)).pipe(
            Effect.andThen(
              options.reply ?? Effect.succeed({ text: "faz o rebase da fork/nightly" }),
            ),
          ),
      }),
    );
    const service = yield* VoiceTranscriptCorrection.VoiceTranscriptCorrection.pipe(
      Effect.provide(VoiceTranscriptCorrection.layer.pipe(Layer.provide(dependencies))),
    );
    return yield* body({
      correct: (threadId) => service.correct({ text: TRANSCRIPT, threadId }),
      requests,
    });
  });

it.effect("corrects with Opus by default, using the thread's conversation", () =>
  withService({}, ({ correct, requests }) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* correct(THREAD_ID), "faz o rebase da fork/nightly");
      const [request] = requests;
      assert.strictEqual(request?.transcript, TRANSCRIPT);
      assert.include(request?.conversation, "fork/nightly is ready");
      assert.strictEqual(request?.cwd, "/workspace/project");
      assert.deepStrictEqual(request?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      });
    }),
  ),
);

it.effect("corrects a draft without a server thread", () =>
  withService({}, ({ correct, requests }) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* correct(), "faz o rebase da fork/nightly");
      assert.strictEqual(requests[0]?.conversation, "");
      assert.strictEqual(requests[0]?.cwd, "/server");
    }),
  ),
);

it.effect("leaves the transcript alone when correction is off", () =>
  withService({ settings: { voiceTranscriptCorrectionEnabled: false } }, ({ correct, requests }) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* correct(THREAD_ID), TRANSCRIPT);
      assert.lengthOf(requests, 0);
    }),
  ),
);

it.effect("leaves the transcript alone when the correction model's provider is off", () =>
  withService({ providerEnabled: false }, ({ correct, requests }) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* correct(THREAD_ID), TRANSCRIPT);
      assert.lengthOf(requests, 0);
    }),
  ),
);

it.effect("keeps the transcript when the model fails or its reply is unusable", () =>
  Effect.gen(function* () {
    yield* withService(
      {
        reply: Effect.fail(
          new TextGenerationError({ operation: "correctVoiceTranscript", detail: "offline" }),
        ),
      },
      ({ correct }) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* correct(THREAD_ID), TRANSCRIPT);
        }),
    );
    yield* withService({ reply: Effect.succeed({ text: null }) }, ({ correct }) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* correct(THREAD_ID), TRANSCRIPT);
      }),
    );
  }),
);
