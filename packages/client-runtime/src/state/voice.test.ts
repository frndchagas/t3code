import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  VoiceTranscriptionUnsupportedLocaleError,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
  type VoicePrepareInput,
  type VoicePrepareResult,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
  type VoiceCorrectInput,
  type VoiceCorrectResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { VoiceTranscriptionError } from "../voice-input/transcription.ts";
import type { AtomCommand } from "./runtime.ts";
import { createServerVoiceTranscriber, voiceDetectionLocales } from "./voice.ts";

const environmentId = EnvironmentId.make("environment-1");
const registry = {} as AtomRegistry.AtomRegistry;

type Command<I, A, E = unknown> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: I },
  A,
  E
>;

function command<I, A>(run: (input: I) => AsyncResult.AsyncResult<A, unknown>): Command<I, A> {
  return {
    label: "test",
    run: async (_registry, target) => run(target.input) as AsyncResult.Success<A, unknown>,
  };
}

function setup(options: {
  readonly prepare?: (
    input: VoicePrepareInput,
  ) => AsyncResult.AsyncResult<VoicePrepareResult, unknown>;
  readonly upload?: () => Promise<void>;
  readonly beforeTranscribe?: () => void;
  readonly correct?: (
    input: VoiceCorrectInput,
  ) => AsyncResult.AsyncResult<VoiceCorrectResult, unknown>;
}) {
  const removed: string[] = [];
  const transcribed: VoiceTranscribeInput[] = [];
  const transcriber = createServerVoiceTranscriber({
    registry,
    environmentId,
    locales: ["en", "pt"],
    prepare: command(
      options.prepare ??
        (() => AsyncResult.success({ locales: ["en-US", "pt-BR"] } as VoicePrepareResult)),
    ),
    transcribe: command<VoiceTranscribeInput, VoiceTranscribeResult>((input) => {
      transcribed.push(input);
      return AsyncResult.success({ text: "olá", locale: "pt-BR" });
    }),
    correct: command<VoiceCorrectInput, VoiceCorrectResult>((input) =>
      options.correct
        ? options.correct(input)
        : AsyncResult.success({ text: input.text.toUpperCase() }),
    ),
    createUploadUrl: command<AttachmentCreateUploadUrlInput, AttachmentCreateUploadUrlResult>(() =>
      AsyncResult.success({
        attachmentId: "pending-1-wav",
        relativeUrl: "/upload/1",
        expiresAt: 1,
      }),
    ),
    removeAttachment: command<AttachmentDeleteInput, unknown>((input) => {
      removed.push(input.attachmentId);
      return AsyncResult.success(undefined);
    }),
    resolveUploadUrl: (relativeUrl) => `http://server${relativeUrl}`,
    readRecording: async () => ({
      sizeBytes: 4,
      mimeType: "audio/wav",
      fileName: "voice-input.wav",
      upload: () => ({
        done: (options.upload ?? (async () => {}))().then(() => options.beforeTranscribe?.()),
        abort: () => {},
      }),
    }),
  });
  return { transcriber, removed, transcribed };
}

async function failure(promise: Promise<unknown>): Promise<VoiceTranscriptionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VoiceTranscriptionError) return error;
    throw error;
  }
  throw new Error("Expected a voice transcription failure.");
}

describe("createServerVoiceTranscriber", () => {
  it("reports the language the server detected and leaves cleanup to the server", async () => {
    const { transcriber, removed, transcribed } = setup({});
    const signal = new AbortController().signal;

    const prepared = await transcriber.prepare({ signal });
    const text = await prepared.transcribe("blob:recording", { signal });

    expect(text).toBe("olá");
    expect(prepared.locale).toBe("pt-BR");
    expect(transcribed).toEqual([{ attachmentId: "pending-1-wav", locales: ["en-US", "pt-BR"] }]);
    expect(removed).toEqual([]);
    expect(await prepared.correct?.("olá", { signal })).toBe("OLÁ");
  });

  it("keeps the transcript when correction fails", async () => {
    const { transcriber } = setup({
      correct: () => AsyncResult.failure(Cause.fail(new Error("offline"))),
    });
    const signal = new AbortController().signal;

    const prepared = await transcriber.prepare({ signal });

    expect(await prepared.correct?.("olá", { signal })).toBe("olá");
  });

  it("reports an unsupported language from the server", async () => {
    const { transcriber } = setup({
      prepare: (input) =>
        AsyncResult.failure(
          Cause.fail(new VoiceTranscriptionUnsupportedLocaleError({ locales: input.locales })),
        ),
    });

    const error = await failure(transcriber.prepare({ signal: new AbortController().signal }));

    expect(error.code).toBe("unsupported-locale");
  });

  it("releases the upload when the transfer fails", async () => {
    const { transcriber, removed, transcribed } = setup({
      upload: async () => {
        throw new Error("network");
      },
    });
    const signal = new AbortController().signal;
    const prepared = await transcriber.prepare({ signal });

    const error = await failure(prepared.transcribe("blob:recording", { signal }));

    expect(error.code).toBe("transcription-failed");
    expect(removed).toEqual(["pending-1-wav"]);
    expect(transcribed).toEqual([]);
  });

  it("releases the upload without transcribing when cancelled mid-upload", async () => {
    const controller = new AbortController();
    const { transcriber, removed, transcribed } = setup({
      beforeTranscribe: () => controller.abort(),
    });
    const prepared = await transcriber.prepare({ signal: controller.signal });

    const error = await failure(
      prepared.transcribe("blob:recording", { signal: controller.signal }),
    );

    expect(error.code).toBe("cancelled");
    expect(removed).toEqual(["pending-1-wav"]);
    expect(transcribed).toEqual([]);
  });
});

describe("voiceDetectionLocales", () => {
  it("keeps the first tag of each language, up to three languages", () => {
    expect(voiceDetectionLocales(["en-US", "en-BR", "pt-BR", "pt", "es-ES", "fr-FR"])).toEqual([
      "en-US",
      "pt-BR",
      "es-ES",
    ]);
  });
});
