import type { ThreadId } from "@t3tools/contracts";
import { formatPromptSuggestionContext } from "@t3tools/provider-core/server/promptSuggestionContext";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

// Past this the raw transcript serves the user better than more waiting. Opus took up to 36s
// with six corrections at once; one at a time it usually answers in under ten.
const CORRECTION_TIMEOUT = "45 seconds";

export interface VoiceTranscriptCorrectionInput {
  readonly text: string;
  /** The thread being dictated into; its conversation is the vocabulary for the correction. */
  readonly threadId?: ThreadId | undefined;
}

export class VoiceTranscriptCorrection extends Context.Service<
  VoiceTranscriptCorrection,
  {
    /** The corrected text, or the transcript as is when correction is off, fails, or looks unusable. */
    readonly correct: (input: VoiceTranscriptCorrectionInput) => Effect.Effect<string>;
  }
>()("t3/voice/VoiceTranscriptCorrection") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const threadContext = Effect.fn("VoiceTranscriptCorrection.threadContext")(function* (
    threadId: ThreadId,
  ) {
    const { thread, messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user", "assistant"],
    });
    const project = yield* projects.get(thread.projectId);
    const conversation = messages
      .filter((message) => !message.streaming)
      .toSorted(
        (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
      );
    return {
      cwd:
        thread.worktreePath ?? (Option.isSome(project) ? project.value.workspaceRoot : config.cwd),
      conversation: formatPromptSuggestionContext(
        conversation.map((message) => ({
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
    };
  });

  const correct = Effect.fn("VoiceTranscriptCorrection.correct")(
    function* (input: VoiceTranscriptCorrectionInput) {
      const current = yield* settings.getSettings;
      if (!current.voiceTranscriptCorrectionEnabled || input.text.trim() === "") {
        return input.text;
      }
      const modelSelection = current.voiceTranscriptCorrectionModelSelection;
      // The thread goes to this provider, so a provider the user turned off must not see it.
      const instance = yield* providers.getInstance(modelSelection.instanceId);
      if (!instance?.enabled) return input.text;
      // A draft has no server thread yet: correct without its conversation.
      const context = input.threadId
        ? yield* threadContext(input.threadId).pipe(Effect.orElseSucceed(() => null))
        : null;
      const result = yield* textGeneration
        .correctVoiceTranscript({
          cwd: context?.cwd ?? config.cwd,
          transcript: input.text,
          conversation: context?.conversation ?? "",
          modelSelection,
        })
        .pipe(Effect.timeout(CORRECTION_TIMEOUT));
      return result.text ?? input.text;
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("voice transcript correction skipped", { cause }).pipe(
            Effect.as(input.text),
          ),
        ),
      ),
  );

  return VoiceTranscriptCorrection.of({ correct });
});

export const layer = Layer.effect(VoiceTranscriptCorrection, make);
