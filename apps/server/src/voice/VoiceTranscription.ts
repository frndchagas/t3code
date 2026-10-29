import {
  VoiceTranscriptionFailedError,
  VoiceTranscriptionUnavailableError,
  VoiceTranscriptionUnsupportedLocaleError,
  type VoicePrepareInput,
  type VoicePrepareResult,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
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

// Homebrew's whisper.cpp (`brew install whisper-cpp`), which runs Whisper on the Mac's GPU.
const WHISPER_COMMAND = "whisper-cli";
const WHISPER_MODEL = {
  file: "ggml-large-v3-turbo-q8_0.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
};
// Voice activity detection: without it, silence and noise come back as "Thank you."
const VAD_MODEL = {
  file: "ggml-silero-v5.1.2.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
};
// The first use downloads the models, about 870 MB.
const DOWNLOAD_TIMEOUT = "30 minutes";
const TRANSCRIBE_TIMEOUT = "5 minutes";

// Whisper's language codes; a BCP 47 tag maps to its base language.
const WHISPER_LANGUAGES = new Set(
  (
    "en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th " +
    "ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr " +
    "pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt " +
    "haw ln ha ba jw su yue"
  ).split(" "),
);

const decodeWhisperOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({ language: Schema.String }),
      transcription: Schema.Array(Schema.Struct({ text: Schema.String })),
    }),
  ),
);

interface Candidate {
  readonly locale: string;
  readonly language: string;
}

/** One candidate per Whisper language, in the client's order of preference. */
function whisperCandidates(locales: ReadonlyArray<string>): ReadonlyArray<Candidate> {
  const candidates: Candidate[] = [];
  for (const locale of locales) {
    const language = locale.split("-")[0]?.toLowerCase() ?? "";
    if (!WHISPER_LANGUAGES.has(language)) continue;
    if (candidates.some((candidate) => candidate.language === language)) continue;
    candidates.push({ locale, language });
  }
  return candidates;
}

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
  const downloadLock = yield* Semaphore.make(1);
  const modelDirectory = path.join(config.providerStatusCacheDir, "voice");
  const whisperModelPath = path.join(modelDirectory, WHISPER_MODEL.file);
  const vadModelPath = path.join(modelDirectory, VAD_MODEL.file);

  const candidatesFor = Effect.fn("VoiceTranscription.candidatesFor")(function* (
    locales: ReadonlyArray<string>,
  ) {
    if (platform !== "darwin") {
      return yield* new VoiceTranscriptionUnavailableError({});
    }
    const [preferred, ...others] = whisperCandidates(locales);
    if (!preferred) {
      return yield* new VoiceTranscriptionUnsupportedLocaleError({ locales });
    }
    return [preferred, ...others] as const;
  });

  const ensureWhisper = Effect.gen(function* () {
    const result = yield* runner
      .run({ command: WHISPER_COMMAND, args: ["--help"] })
      .pipe(Effect.mapError((cause) => new VoiceTranscriptionUnavailableError({ cause })));
    if (result.code !== 0) {
      return yield* new VoiceTranscriptionUnavailableError({});
    }
  });

  const download = Effect.fn("VoiceTranscription.download")(function* (model: {
    readonly file: string;
    readonly url: string;
  }) {
    const modelPath = path.join(modelDirectory, model.file);
    if (yield* fileSystem.exists(modelPath).pipe(Effect.orElseSucceed(() => false))) return;
    const failed = (cause?: unknown) =>
      new VoiceTranscriptionFailedError({ stage: "prepare", cause });
    yield* fileSystem
      .makeDirectory(modelDirectory, { recursive: true })
      .pipe(Effect.mapError(failed));
    const partialPath = `${modelPath}.partial`;
    yield* Effect.gen(function* () {
      const result = yield* runner
        .run({
          command: "curl",
          args: [
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--output",
            partialPath,
            model.url,
          ],
          timeout: DOWNLOAD_TIMEOUT,
        })
        .pipe(Effect.mapError(failed));
      if (result.code !== 0) {
        yield* Effect.logWarning("Could not download a Whisper model.", {
          model: model.file,
          code: result.code,
          timedOut: result.timedOut,
          stderr: result.stderr.slice(-500),
        });
        return yield* failed();
      }
      yield* fileSystem.rename(partialPath, modelPath).pipe(Effect.mapError(failed));
    }).pipe(Effect.ensuring(fileSystem.remove(partialPath, { force: true }).pipe(Effect.ignore)));
  });

  const ensureModels = Effect.all([download(WHISPER_MODEL), download(VAD_MODEL)]).pipe(
    downloadLock.withPermits(1),
  );

  const runWhisper = Effect.fn("VoiceTranscription.runWhisper")(function* (
    audioPath: string,
    language: string,
  ) {
    const failed = (cause?: unknown) =>
      new VoiceTranscriptionFailedError({ stage: "transcribe", cause });
    const outputBase = `${audioPath}.whisper`;
    return yield* Effect.gen(function* () {
      const result = yield* runner
        .run({
          command: WHISPER_COMMAND,
          args: [
            "-m",
            whisperModelPath,
            "--vad",
            "-vm",
            vadModelPath,
            "-f",
            audioPath,
            "-l",
            language,
            "-nt",
            "-np",
            "-oj",
            "-of",
            outputBase,
          ],
          timeout: TRANSCRIBE_TIMEOUT,
        })
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProcessSpawnError"
              ? new VoiceTranscriptionUnavailableError({ cause })
              : failed(cause),
          ),
        );
      if (result.code !== 0) {
        yield* Effect.logWarning("Whisper transcription failed.", {
          code: result.code,
          timedOut: result.timedOut,
          stderr: result.stderr.slice(-500),
        });
        return yield* failed();
      }
      const json = yield* fileSystem
        .readFileString(`${outputBase}.json`)
        .pipe(Effect.mapError(failed));
      const output = decodeWhisperOutput(json);
      if (output._tag === "None") return yield* failed();
      return {
        language: output.value.result.language,
        text: output.value.transcription
          .map((segment) => segment.text)
          .join("")
          .trim(),
      };
    }).pipe(
      Effect.ensuring(fileSystem.remove(`${outputBase}.json`, { force: true }).pipe(Effect.ignore)),
    );
  });

  const prepare: VoiceTranscription["Service"]["prepare"] = Effect.fn("VoiceTranscription.prepare")(
    function* (input) {
      const candidates = yield* candidatesFor(input.locales);
      yield* ensureWhisper;
      yield* ensureModels;
      return { locales: candidates.map((candidate) => candidate.locale) };
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
      const candidates = yield* candidatesFor(input.locales);
      const [preferred] = candidates;
      yield* ensureModels;
      let output = yield* runWhisper(
        audioPath,
        candidates.length === 1 ? preferred.language : "auto",
      );
      let spoken = candidates.find((candidate) => candidate.language === output.language);
      // Detection can land on a language the user does not speak, such as Galician for Portuguese.
      if (!spoken) {
        output = yield* runWhisper(audioPath, preferred.language);
        spoken = preferred;
      }
      return { text: output.text, locale: spoken.locale };
    }).pipe(Effect.ensuring(fileSystem.remove(audioPath, { force: true }).pipe(Effect.ignore)));
  });

  return VoiceTranscription.of({ prepare, transcribe });
});

export const layer = Layer.effect(VoiceTranscription, make);
