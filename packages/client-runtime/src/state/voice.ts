import {
  WS_METHODS,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
  type EnvironmentId,
  type ThreadId,
  type VoiceCorrectInput,
  type VoiceCorrectResult,
  type VoicePrepareInput,
  type VoicePrepareResult,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
} from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "../voice-input/transcription.ts";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
  type AttachmentByteUpload,
} from "./attachments.ts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "./runtime.ts";

export function createVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    prepare: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:prepare",
      tag: WS_METHODS.voicePrepare,
    }),
    transcribe: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:transcribe",
      tag: WS_METHODS.voiceTranscribe,
    }),
    correct: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:correct",
      tag: WS_METHODS.voiceCorrect,
    }),
  };
}

const MAX_DETECTED_LANGUAGES = 3;

/**
 * Candidates for automatic detection, from the client's language preferences. One tag per base
 * language: detection picks the language, and each extra candidate is another transcription pass.
 */
export function voiceDetectionLocales(preferred: ReadonlyArray<string>): ReadonlyArray<string> {
  const byLanguage = new Map<string, string>();
  for (const tag of preferred) {
    const language = tag.split("-")[0]?.toLowerCase();
    if (!language || byLanguage.has(language)) continue;
    byLanguage.set(language, tag);
    if (byLanguage.size === MAX_DETECTED_LANGUAGES) break;
  }
  return [...byLanguage.values()];
}

type EnvironmentCommand<I, A, E> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: I },
  A,
  E
>;

export interface ServerVoiceRecording {
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly fileName: string;
  readonly upload: (url: string) => AttachmentByteUpload;
}

function failureTag(error: unknown): string | null {
  return typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : null;
}

function serverFailure(
  error: unknown,
  fallback: "preparation-failed" | "transcription-failed",
): VoiceTranscriptionError {
  switch (failureTag(error)) {
    case "VoiceTranscriptionUnavailableError":
      return new VoiceTranscriptionError(
        "unavailable",
        "Voice transcription needs whisper.cpp on the server's Mac: run brew install whisper-cpp.",
        { cause: error },
      );
    case "VoiceTranscriptionUnsupportedLocaleError":
      return new VoiceTranscriptionError(
        "unsupported-locale",
        "Voice transcription does not support this language.",
        { cause: error },
      );
    default:
      return new VoiceTranscriptionError(
        fallback,
        fallback === "preparation-failed"
          ? "Voice transcription could not prepare this language."
          : "Voice transcription failed.",
        { cause: error },
      );
  }
}

/**
 * Transcribes on the environment's host: the recording travels through the attachment upload
 * route, which every connection mode already serves, and the server deletes it afterwards.
 */
export function createServerVoiceTranscriber<PE, TE, CE, UE, RE>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentId: EnvironmentId;
  /** Candidate languages, most preferred first; with several, the server detects the spoken one. */
  readonly locales: ReadonlyArray<string>;
  /** The server thread being dictated into, so the server can correct terms from its conversation. */
  readonly threadId?: ThreadId | null | undefined;
  readonly prepare: EnvironmentCommand<VoicePrepareInput, VoicePrepareResult, PE>;
  readonly transcribe: EnvironmentCommand<VoiceTranscribeInput, VoiceTranscribeResult, TE>;
  readonly correct: EnvironmentCommand<VoiceCorrectInput, VoiceCorrectResult, CE>;
  readonly createUploadUrl: EnvironmentCommand<
    AttachmentCreateUploadUrlInput,
    AttachmentCreateUploadUrlResult,
    UE
  >;
  readonly removeAttachment: EnvironmentCommand<AttachmentDeleteInput, unknown, RE>;
  readonly resolveUploadUrl: (relativeUrl: string) => string | null;
  readonly readRecording: (uri: string) => Promise<ServerVoiceRecording>;
}): VoiceTranscriber {
  const { registry, environmentId } = input;
  const release = (attachmentId: string) =>
    deletePendingAttachmentUpload({
      registry,
      remove: input.removeAttachment,
      environmentId,
      attachmentId,
    });

  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      const prepared = await runAtomCommand(
        registry,
        input.prepare,
        { environmentId, input: { locales: input.locales } },
        { reportFailure: false },
      );
      throwIfVoiceTranscriptionAborted(signal);
      if (prepared._tag !== "Success") {
        throw serverFailure(squashAtomCommandFailure(prepared), "preparation-failed");
      }
      const locales = prepared.value.locales;
      // The controller reads this after each transcript to pick spacing rules for its language.
      let locale = locales[0] ?? "";
      return {
        get locale() {
          return locale;
        },
        transcribe: async (uri, { signal }) => {
          throwIfVoiceTranscriptionAborted(signal);
          let recording: ServerVoiceRecording;
          try {
            recording = await input.readRecording(uri);
          } catch (error) {
            throw new VoiceTranscriptionError(
              "transcription-failed",
              "Could not read the recording.",
              { cause: error },
            );
          }
          throwIfVoiceTranscriptionAborted(signal);
          const uploaded = await runAttachmentUploadCycle({
            registry,
            createUploadUrl: input.createUploadUrl,
            remove: input.removeAttachment,
            environmentId,
            upload: {
              type: "file",
              name: recording.fileName,
              mimeType: recording.mimeType,
              sizeBytes: recording.sizeBytes,
            },
            resolveUploadUrl: input.resolveUploadUrl,
            transport: recording.upload,
            onMinted: () => (signal.aborted ? "cancel" : "continue"),
            onTransferStart: (abort) => signal.addEventListener("abort", abort, { once: true }),
          });
          if (uploaded.status !== "uploaded") {
            if (uploaded.status === "failed" && uploaded.attachmentId) {
              release(uploaded.attachmentId);
            }
            throwIfVoiceTranscriptionAborted(signal);
            throw new VoiceTranscriptionError(
              "transcription-failed",
              "Could not upload the recording.",
              uploaded.status === "failed" ? { cause: uploaded.error } : undefined,
            );
          }
          if (signal.aborted) {
            release(uploaded.attachmentId);
            throwIfVoiceTranscriptionAborted(signal);
          }
          const transcribed = await runAtomCommand(
            registry,
            input.transcribe,
            {
              environmentId,
              input: { attachmentId: uploaded.attachmentId, locales },
            },
            { reportFailure: false },
          );
          throwIfVoiceTranscriptionAborted(signal);
          if (transcribed._tag !== "Success") {
            throw serverFailure(squashAtomCommandFailure(transcribed), "transcription-failed");
          }
          locale = transcribed.value.locale;
          return transcribed.value.text;
        },
        correct: async (text, { signal }) => {
          const corrected = await runAtomCommand(
            registry,
            input.correct,
            {
              environmentId,
              input: { text, ...(input.threadId ? { threadId: input.threadId } : {}) },
            },
            { reportFailure: false },
          );
          throwIfVoiceTranscriptionAborted(signal);
          return corrected._tag === "Success" ? corrected.value.text : text;
        },
      };
    },
  };
}
