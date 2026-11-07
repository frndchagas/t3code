import {
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentSpeechPostProcessingRequest,
  type ThreadId,
} from "@t3tools/contracts";
import { formatPromptSuggestionContext } from "@t3tools/provider-core/server/promptSuggestionContext";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildTranscriptionPostProcessingPrompt } from "../textGeneration/TranscriptionPostProcessing.ts";
import { applySpeechAliases } from "./customWords.ts";
import { SpeechOperationError } from "./SpeechService.ts";

export class SpeechPostProcessing extends Context.Service<
  SpeechPostProcessing,
  {
    readonly process: (
      input: EnvironmentSpeechPostProcessingRequest,
    ) => Effect.Effect<{ readonly text: string }, SpeechOperationError>;
  }
>()("t3/speech/postProcessing/SpeechPostProcessing") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  /** The thread's conversation, oldest first; cleanup without it still beats no cleanup. */
  const threadConversation = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["messages"], { messageRoles: ["user", "assistant"] })
      .pipe(
        Effect.map(({ messages }) =>
          formatPromptSuggestionContext(
            messages
              .filter((message) => !message.streaming)
              .toSorted(
                (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
              )
              .map((message) => ({
                role:
                  message.role === "assistant"
                    ? "assistant"
                    : message.createdBy === "user"
                      ? "user"
                      : "event",
                text: message.text,
                attachments: message.attachments,
              })),
          ),
        ),
        Effect.orElseSucceed(() => ""),
      );

  return SpeechPostProcessing.of({
    process: Effect.fn("SpeechPostProcessing.process")(
      function* (input) {
        if (input.transcript.trim().length === 0) return { text: input.transcript };
        const settings = yield* settingsService.getSettings;
        const { mode, customInstructions } = input.options.speechPostProcessingPrompt;
        const instructions =
          (mode === "custom" ? customInstructions.trim() : "") ||
          DEFAULT_SPEECH_POST_PROCESSING_PROMPT;
        const conversation =
          input.threadId === undefined ? "" : yield* threadConversation(input.threadId);
        // Providers run in a working directory; cleanup must not read a checkout.
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-cleanup-" });
        const generated = yield* textGeneration.generateTranscriptionPostProcessing({
          cwd,
          prompt: buildTranscriptionPostProcessingPrompt(
            instructions,
            input.transcript,
            input.draft,
            input.options.speechCorrectionWord,
            conversation,
          ),
          modelSelection: resolveSpeechPostProcessingModelSelection(settings),
        });
        const text = generated.transcription.trim();
        return {
          text:
            text.length > 0
              ? applySpeechAliases(text, input.options.speechCustomWords)
              : input.transcript,
        };
      },
      Effect.scoped,
      Effect.mapError((cause) => new SpeechOperationError({ operation: "post-processing", cause })),
    ),
  });
});

export const layer = Layer.effect(SpeechPostProcessing, make);
