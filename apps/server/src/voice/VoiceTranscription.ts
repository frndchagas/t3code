import {
  VoiceTranscriptionFailedError,
  VoiceTranscriptionUnavailableError,
  VoiceTranscriptionUnsupportedLocaleError,
  VoicePrepareResult,
  VoiceTranscribeResult,
  type VoicePrepareInput,
  type VoiceTranscribeInput,
  type VoiceTranscriptionError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { APPLE_SPEECH_HELPER_SOURCE } from "./appleSpeechHelperSource.ts";

// Bump with every change to the Swift source so hosts rebuild their cached binary.
const HELPER_BINARY_NAME = "t3-speech-2";
const HELPER_EXIT_UNAVAILABLE = 2;
const HELPER_EXIT_UNSUPPORTED_LOCALE = 3;
const COMPILE_TIMEOUT = "3 minutes";
// The first use of a language downloads Apple's speech model.
const PREPARE_TIMEOUT = "10 minutes";
const TRANSCRIBE_TIMEOUT = "5 minutes";

const decodePrepareOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ locales: VoicePrepareResult.fields.locales })),
);
const decodeTranscribeOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(VoiceTranscribeResult),
);

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly prepare: (
      input: VoicePrepareInput,
    ) => Effect.Effect<VoicePrepareResult, VoiceTranscriptionError>;
    /** Always deletes the pending audio upload, whether or not transcription succeeds. */
    readonly transcribe: (
      input: VoiceTranscribeInput,
    ) => Effect.Effect<VoiceTranscribeResult, VoiceTranscriptionError>;
  }
>()("t3/voice/VoiceTranscription") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const buildLock = yield* Semaphore.make(1);
  const helperDirectory = path.join(config.providerStatusCacheDir, "voice");
  const helperPath = path.join(helperDirectory, HELPER_BINARY_NAME);

  const helperExists = fileSystem.exists(helperPath).pipe(Effect.orElseSucceed(() => false));

  const buildHelper = Effect.gen(function* () {
    if (yield* helperExists) return;
    const unavailable = (cause: unknown) => new VoiceTranscriptionUnavailableError({ cause });
    yield* fileSystem
      .makeDirectory(helperDirectory, { recursive: true })
      .pipe(Effect.mapError(unavailable));
    const workDirectory = yield* fileSystem
      .makeTempDirectory({ directory: helperDirectory, prefix: "build-" })
      .pipe(Effect.mapError(unavailable));
    const sourcePath = path.join(workDirectory, "main.swift");
    const outputPath = path.join(workDirectory, HELPER_BINARY_NAME);
    yield* Effect.gen(function* () {
      yield* fileSystem
        .writeFileString(sourcePath, APPLE_SPEECH_HELPER_SOURCE)
        .pipe(Effect.mapError(unavailable));
      const result = yield* runner
        .run({
          command: "xcrun",
          args: ["swiftc", "-O", "-parse-as-library", sourcePath, "-o", outputPath],
          cwd: workDirectory,
          timeout: COMPILE_TIMEOUT,
        })
        .pipe(Effect.mapError(unavailable));
      if (result.code !== 0) {
        yield* Effect.logWarning("Could not build the voice transcription helper.", {
          code: result.code,
          timedOut: result.timedOut,
        });
        return yield* new VoiceTranscriptionUnavailableError({});
      }
      yield* fileSystem.rename(outputPath, helperPath).pipe(Effect.mapError(unavailable));
    }).pipe(
      Effect.ensuring(fileSystem.remove(workDirectory, { recursive: true }).pipe(Effect.ignore)),
    );
  }).pipe(buildLock.withPermits(1));

  const runHelper = Effect.fn("VoiceTranscription.runHelper")(function* (
    stage: "prepare" | "transcribe",
    args: ReadonlyArray<string>,
    locales: ReadonlyArray<string>,
  ) {
    if (platform !== "darwin") {
      return yield* new VoiceTranscriptionUnavailableError({});
    }
    yield* buildHelper;
    const result = yield* runner
      .run({
        command: helperPath,
        args,
        timeout: stage === "prepare" ? PREPARE_TIMEOUT : TRANSCRIBE_TIMEOUT,
      })
      .pipe(Effect.mapError((cause) => new VoiceTranscriptionFailedError({ stage, cause })));
    switch (result.code) {
      case 0:
        return result.stdout;
      case HELPER_EXIT_UNAVAILABLE:
        return yield* new VoiceTranscriptionUnavailableError({});
      case HELPER_EXIT_UNSUPPORTED_LOCALE:
        return yield* new VoiceTranscriptionUnsupportedLocaleError({ locales });
      default:
        yield* Effect.logWarning("Voice transcription helper failed.", {
          stage,
          code: result.code,
          timedOut: result.timedOut,
        });
        return yield* new VoiceTranscriptionFailedError({ stage });
    }
  });

  const prepare: VoiceTranscription["Service"]["prepare"] = Effect.fn("VoiceTranscription.prepare")(
    function* (input) {
      const stdout = yield* runHelper("prepare", ["prepare", ...input.locales], input.locales);
      const output = decodePrepareOutput(stdout);
      if (output._tag === "None") {
        return yield* new VoiceTranscriptionFailedError({ stage: "prepare" });
      }
      return output.value;
    },
  );

  const transcribe: VoiceTranscription["Service"]["transcribe"] = Effect.fn(
    "VoiceTranscription.transcribe",
  )(function* (input) {
    // Only pending uploads: a persisted chat attachment must never be read or deleted here.
    const audioPath =
      parseThreadSegmentFromAttachmentId(input.attachmentId) === PENDING_ATTACHMENT_THREAD_SEGMENT
        ? resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: input.attachmentId,
          })
        : null;
    if (!audioPath) {
      return yield* new VoiceTranscriptionFailedError({ stage: "transcribe" });
    }
    return yield* Effect.gen(function* () {
      const stdout = yield* runHelper(
        "transcribe",
        ["transcribe", audioPath, ...input.locales],
        input.locales,
      );
      const output = decodeTranscribeOutput(stdout);
      if (output._tag === "None") {
        return yield* new VoiceTranscriptionFailedError({ stage: "transcribe" });
      }
      return { text: output.value.text.trim(), locale: output.value.locale };
    }).pipe(Effect.ensuring(fileSystem.remove(audioPath, { force: true }).pipe(Effect.ignore)));
  });

  return VoiceTranscription.of({ prepare, transcribe });
});

export const layer = Layer.effect(VoiceTranscription, make);
