import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A BCP 47 tag such as `pt-BR`; the server resolves it to the closest supported language. */
const VoiceLocale = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** One language transcribes as-is; several let the server pick the one being spoken. */
const VoiceLocales = Schema.Array(VoiceLocale).check(Schema.isMinLength(1), Schema.isMaxLength(4));

export const VoicePrepareInput = Schema.Struct({
  locales: VoiceLocales,
});
export type VoicePrepareInput = typeof VoicePrepareInput.Type;

export const VoicePrepareResult = Schema.Struct({
  locales: VoiceLocales,
});
export type VoicePrepareResult = typeof VoicePrepareResult.Type;

/** The audio is a pending attachment upload; the server deletes it once transcription ends. */
export const VoiceTranscribeInput = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  locales: VoiceLocales,
  /** The thread being written to, whose conversation helps correct misheard terms. */
  threadId: Schema.optionalKey(ThreadId),
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;

export const VoiceTranscribeResult = Schema.Struct({
  text: Schema.String,
  /** The language the speech was transcribed in. */
  locale: VoiceLocale,
});
export type VoiceTranscribeResult = typeof VoiceTranscribeResult.Type;

export class VoiceTranscriptionUnavailableError extends Schema.TaggedError<VoiceTranscriptionUnavailableError>()(
  "VoiceTranscriptionUnavailableError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Voice transcription needs whisper.cpp on the server's Mac: run brew install whisper-cpp.";
  }
}

export class VoiceTranscriptionUnsupportedLocaleError extends Schema.TaggedError<VoiceTranscriptionUnsupportedLocaleError>()(
  "VoiceTranscriptionUnsupportedLocaleError",
  {
    locales: Schema.Array(VoiceLocale),
  },
) {
  override get message(): string {
    return `Voice transcription does not support ${this.locales.join(", ")}.`;
  }
}

export class VoiceTranscriptionFailedError extends Schema.TaggedError<VoiceTranscriptionFailedError>()(
  "VoiceTranscriptionFailedError",
  {
    stage: Schema.Literals(["prepare", "transcribe"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.stage === "prepare"
      ? "Voice transcription could not prepare this language."
      : "Voice transcription failed.";
  }
}

export const VoiceTranscriptionError = Schema.Union([
  VoiceTranscriptionUnavailableError,
  VoiceTranscriptionUnsupportedLocaleError,
  VoiceTranscriptionFailedError,
]);
export type VoiceTranscriptionError = typeof VoiceTranscriptionError.Type;
