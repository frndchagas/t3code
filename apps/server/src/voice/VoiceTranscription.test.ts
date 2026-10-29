import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

type WhisperReply = { readonly language: string; readonly segments: ReadonlyArray<string> };

const makeHarness = Effect.fn("test.make_voice_transcription_harness")(function* (options: {
  readonly platform?: NodeJS.Platform;
  readonly whisperInstalled?: boolean;
  /** Receives the `-l` argument: a language code or `auto`. */
  readonly reply?: (language: string) => WhisperReply;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-test-" });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
  const commands: string[] = [];
  const argument = (args: ReadonlyArray<string>, flag: string) =>
    args[args.indexOf(flag) + 1] ?? "";
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "whisper-cli" && options.whisperInstalled === false) {
          return yield* new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("ENOENT"),
          });
        }
        if (input.command === "curl") {
          commands.push("download");
          yield* fs.writeFileString(argument(input.args, "--output"), "model").pipe(Effect.orDie);
        } else if (input.args[0] === "--help") {
          commands.push("check");
        } else {
          const language = argument(input.args, "-l");
          commands.push(`transcribe:${language}`);
          const reply = options.reply?.(language) ?? { language, segments: [] };
          const output = {
            result: { language: reply.language },
            transcription: reply.segments.map((text) => ({ text })),
          };
          yield* fs
            .writeFileString(`${argument(input.args, "-of")}.json`, JSON.stringify(output))
            .pipe(Effect.orDie);
        }
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const service = yield* VoiceTranscription.VoiceTranscription.pipe(
    Effect.provide(
      VoiceTranscription.layer.pipe(
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
      ),
    ),
  );
  const writeUpload = (attachmentId: string) =>
    fs
      .writeFileString(path.join(config.attachmentsDir, `${attachmentId}.wav`), "RIFF")
      .pipe(Effect.as(path.join(config.attachmentsDir, `${attachmentId}.wav`)));
  const leftovers = fs.readDirectory(config.attachmentsDir);
  return { service, commands, writeUpload, leftovers, exists: fs.exists };
});

it.layer(NodeServices.layer)("VoiceTranscription", (it) => {
  it.effect("downloads the models once and keeps one locale per language", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* makeHarness({});

      const results = yield* Effect.all(
        [
          service.prepare({ locales: ["pt-BR"] }),
          service.prepare({ locales: ["pt-BR", "pt-PT", "en-US"] }),
        ],
        { concurrency: "unbounded" },
      );

      expect(results).toEqual([{ locales: ["pt-BR"] }, { locales: ["pt-BR", "en-US"] }]);
      expect(commands.filter((command) => command === "download")).toHaveLength(2);
    }),
  );

  it.effect("transcribes in the only language and deletes the uploaded audio", () =>
    Effect.gen(function* () {
      const { service, commands, writeUpload, leftovers } = yield* makeHarness({
        reply: (language) => ({ language, segments: [" Olá,", " mundo. "] }),
      });
      const attachmentId = createPendingAttachmentId(".wav");
      yield* writeUpload(attachmentId);

      const result = yield* service.transcribe({ attachmentId, locales: ["pt-BR"] });

      expect(result).toEqual({ text: "Olá, mundo.", locale: "pt-BR" });
      expect(commands).toContain("transcribe:pt");
      expect(yield* leftovers).toEqual([]);
    }),
  );

  it.effect("detects among the languages and retries in the preferred one outside them", () =>
    Effect.gen(function* () {
      const detected = { auto: "en" };
      const { service, commands, writeUpload } = yield* makeHarness({
        reply: (language) =>
          language === "auto"
            ? { language: detected.auto, segments: [" Ship it."] }
            : { language, segments: [" Pode mandar."] },
      });
      const locales = ["pt-BR", "en-US"];

      const english = createPendingAttachmentId(".wav");
      yield* writeUpload(english);
      expect(yield* service.transcribe({ attachmentId: english, locales })).toEqual({
        text: "Ship it.",
        locale: "en-US",
      });

      detected.auto = "gl";
      const portuguese = createPendingAttachmentId(".wav");
      yield* writeUpload(portuguese);
      expect(yield* service.transcribe({ attachmentId: portuguese, locales })).toEqual({
        text: "Pode mandar.",
        locale: "pt-BR",
      });
      expect(commands.filter((command) => command.startsWith("transcribe:"))).toEqual([
        "transcribe:auto",
        "transcribe:auto",
        "transcribe:pt",
      ]);
    }),
  );

  it.effect("reports an unsupported language and still deletes the uploaded audio", () =>
    Effect.gen(function* () {
      const { service, writeUpload, exists } = yield* makeHarness({});
      const attachmentId = createPendingAttachmentId(".wav");
      const audioPath = yield* writeUpload(attachmentId);

      const exit = yield* service
        .transcribe({ attachmentId, locales: ["xx-YY"] })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain(
        "VoiceTranscriptionUnsupportedLocaleError",
      );
      expect(yield* exists(audioPath)).toBe(false);
    }),
  );

  it.effect("never reads or deletes an attachment that is not a pending upload", () =>
    Effect.gen(function* () {
      const { service, commands, writeUpload, exists } = yield* makeHarness({});
      const attachmentId = createPendingAttachmentId(".wav").replace(/^pending-/, "thread_1-");
      const audioPath = yield* writeUpload(attachmentId);

      const exit = yield* service
        .transcribe({ attachmentId, locales: ["pt-BR"] })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(commands).toEqual([]);
      expect(yield* exists(audioPath)).toBe(true);
    }),
  );

  it.effect("is unavailable without whisper.cpp or on servers that are not macOS", () =>
    Effect.gen(function* () {
      const missing = yield* makeHarness({ whisperInstalled: false });
      const linux = yield* makeHarness({ platform: "linux" });

      for (const { service, commands } of [missing, linux]) {
        const exit = yield* service.prepare({ locales: ["pt-BR"] }).pipe(Effect.exit);

        expect(Exit.isFailure(exit) && exit.cause.toString()).toContain(
          "VoiceTranscriptionUnavailableError",
        );
        expect(commands).toEqual([]);
      }
    }),
  );
});
