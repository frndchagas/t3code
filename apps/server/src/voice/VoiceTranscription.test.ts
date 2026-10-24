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

type HelperReply = { readonly code: number; readonly stdout?: string };

const makeHarness = Effect.fn("test.make_voice_transcription_harness")(function* (options: {
  readonly platform?: NodeJS.Platform;
  readonly reply: (args: ReadonlyArray<string>) => HelperReply;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-test-" });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
  const commands: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        const command = path.basename(input.command);
        commands.push(command === "xcrun" ? "compile" : (input.args[0] ?? ""));
        const reply =
          command === "xcrun"
            ? yield* fs
                .writeFileString(input.args[input.args.indexOf("-o") + 1] ?? "", "binary")
                .pipe(Effect.orDie, Effect.as<HelperReply>({ code: 0 }))
            : options.reply(input.args);
        return {
          stdout: reply.stdout ?? "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(reply.code),
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
  return { service, commands, writeUpload, exists: fs.exists };
});

it.layer(NodeServices.layer)("VoiceTranscription", (it) => {
  it.effect("builds the helper once, then reports the resolved language", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* makeHarness({
        reply: (args) => ({
          code: 0,
          stdout: JSON.stringify({ locales: args.slice(1).map((locale) => `${locale}-X`) }),
        }),
      });

      const results = yield* Effect.all(
        [service.prepare({ locales: ["pt-BR"] }), service.prepare({ locales: ["pt-BR", "en-US"] })],
        { concurrency: "unbounded" },
      );

      expect(results).toEqual([{ locales: ["pt-BR-X"] }, { locales: ["pt-BR-X", "en-US-X"] }]);
      expect(commands.filter((command) => command === "compile")).toHaveLength(1);
    }),
  );

  it.effect("returns the transcript in the detected language and deletes the uploaded audio", () =>
    Effect.gen(function* () {
      const { service, writeUpload, exists } = yield* makeHarness({
        reply: () => ({
          code: 0,
          stdout: JSON.stringify({ text: " Olá, mundo. ", locale: "pt-BR" }),
        }),
      });
      const attachmentId = createPendingAttachmentId(".wav");
      const audioPath = yield* writeUpload(attachmentId);

      const result = yield* service.transcribe({ attachmentId, locales: ["en-US", "pt-BR"] });

      expect(result).toEqual({ text: "Olá, mundo.", locale: "pt-BR" });
      expect(yield* exists(audioPath)).toBe(false);
    }),
  );

  it.effect("reports an unsupported language and still deletes the uploaded audio", () =>
    Effect.gen(function* () {
      const { service, writeUpload, exists } = yield* makeHarness({
        reply: () => ({ code: 3 }),
      });
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
      const { service, commands, writeUpload, exists } = yield* makeHarness({
        reply: () => ({ code: 0, stdout: JSON.stringify({ text: "leaked", locale: "pt-BR" }) }),
      });
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

  it.effect("is unavailable on servers that are not macOS", () =>
    Effect.gen(function* () {
      const { service, commands } = yield* makeHarness({
        platform: "linux",
        reply: () => ({ code: 0, stdout: JSON.stringify({ locales: ["pt-BR"] }) }),
      });

      const exit = yield* service.prepare({ locales: ["pt-BR"] }).pipe(Effect.exit);

      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain(
        "VoiceTranscriptionUnavailableError",
      );
      expect(commands).toEqual([]);
    }),
  );
});
