import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentSpeechPostProcessingRequest,
  type OrchestrationV2ConversationMessage,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SpeechPostProcessing from "./postProcessing.ts";

const threadId = ThreadId.make("thread-dictated-into");

const message = (
  role: "user" | "assistant",
  text: string,
  minute: number,
  streaming = false,
): OrchestrationV2ConversationMessage =>
  ({
    role,
    text,
    streaming,
    createdBy: role === "user" ? "user" : "provider",
    attachments: [],
    createdAt: DateTime.makeUnsafe(Date.UTC(2026, 10, 7, 12, minute)),
  }) as unknown as OrchestrationV2ConversationMessage;

const request = (
  overrides: Partial<EnvironmentSpeechPostProcessingRequest> = {},
): EnvironmentSpeechPostProcessingRequest => ({
  transcript: "faz o push com force",
  draft: { text: "", selection: { start: 0, end: 0 } },
  options: {
    speechCustomWords: [],
    speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
  },
  ...overrides,
});

const run = (
  input: EnvironmentSpeechPostProcessingRequest,
  getThreadRecords: (
    id: ThreadId,
  ) => Effect.Effect<unknown, ProjectionStore.ProjectionStoreV2Error>,
) => {
  const prompts: Array<string> = [];
  const reads: Array<ThreadId> = [];
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateTranscriptionPostProcessing: (generation) =>
        Effect.sync(() => {
          prompts.push(generation.prompt);
          return { transcription: "Faz o push com --force-with-lease." };
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: ((id: ThreadId) => {
        reads.push(id);
        return getThreadRecords(id);
      }) as unknown as ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"],
    }),
  );
  return Effect.gen(function* () {
    const cleanup = yield* SpeechPostProcessing.SpeechPostProcessing;
    const result = yield* cleanup.process(input);
    return { result, prompt: prompts[0] ?? "", reads };
  }).pipe(Effect.provide(SpeechPostProcessing.layer.pipe(Layer.provide(dependencies))));
};

it.effect("cleans up with the conversation of the thread being dictated into", () =>
  Effect.gen(function* () {
    const { result, prompt, reads } = yield* run(request({ threadId }), () =>
      Effect.succeed({
        messages: [
          message("assistant", "Rebased onto development; ready to push.", 2),
          message("user", "Faça o rebase na development.", 1),
          message("assistant", "Still writing this reply", 3, true),
          message("user", "Use git push --force-with-lease from now on.", 4),
        ],
      }),
    );
    expect(reads).toEqual([threadId]);
    expect(result.text).toBe("Faz o push com --force-with-lease.");
    const conversation = prompt.slice(prompt.indexOf("<conversation>"));
    expect(conversation).toContain("--force-with-lease");
    // Oldest first, and a reply still streaming is not part of the thread yet.
    expect(conversation.indexOf("Faça o rebase")).toBeLessThan(
      conversation.indexOf("Rebased onto development"),
    );
    expect(conversation).not.toContain("Still writing this reply");
  }),
);

it.effect("cleans up without the conversation when the thread cannot be read", () =>
  Effect.gen(function* () {
    const { result, prompt } = yield* run(request({ threadId }), (id) =>
      Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id })),
    );
    expect(result.text).toBe("Faz o push com --force-with-lease.");
    expect(prompt).toContain("<transcript>\nfaz o push com force\n</transcript>");
    expect(prompt).not.toContain("<conversation>");
  }),
);

it.effect("reads no thread for a draft that has none", () =>
  Effect.gen(function* () {
    const { prompt, reads } = yield* run(request(), () => Effect.die("not read"));
    expect(reads).toEqual([]);
    expect(prompt).not.toContain("<conversation>");
  }),
);
