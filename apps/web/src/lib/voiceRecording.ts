import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

const TRANSCRIPTION_SAMPLE_RATE = 16_000;

export function isBrowserVoiceRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

/** 16-bit mono PCM, which server transcribers read without a codec. */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(view.buffer);
}

/** MediaRecorder emits Opus or AAC depending on the browser; decoding here keeps the server codec-free. */
export async function convertRecordingToWav(recording: Blob): Promise<Blob> {
  // An offline context sidesteps autoplay rules, and decoding resamples to its rate.
  const decoded = await new OfflineAudioContext(1, 1, TRANSCRIPTION_SAMPLE_RATE).decodeAudioData(
    await recording.arrayBuffer(),
  );
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const samples = decoded.getChannelData(channel);
    for (let index = 0; index < mono.length; index += 1) {
      mono[index] = (mono[index] ?? 0) + (samples[index] ?? 0) / decoded.numberOfChannels;
    }
  }
  return new Blob([encodePcm16Wav(mono, TRANSCRIPTION_SAMPLE_RATE)], { type: "audio/wav" });
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export async function requestMicrophonePermission(): Promise<{
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}> {
  try {
    // Asking through getUserMedia shows the prompt; the stream is reopened when recording starts
    // so the microphone stays off while the server prepares.
    stopStream(await navigator.mediaDevices.getUserMedia({ audio: true }));
    return { granted: true, canAskAgain: true };
  } catch (error) {
    const blocked =
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "SecurityError");
    return { granted: false, canAskAgain: !blocked };
  }
}

/** Each recording becomes a blob URL that the voice controller owns and revokes. */
export class BrowserVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private limitTimer: number | null = null;
  private stopped: Promise<void> = Promise.resolve();
  private readonly onStatus: (status: VoiceRecorderStatus) => void;

  constructor(onStatus: (status: VoiceRecorderStatus) => void) {
    this.onStatus = onStatus;
  }

  async prepareToRecordAsync(): Promise<void> {
    this.uri = null;
    this.stream ??= await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    const stream = this.stream;
    if (!stream) throw new Error("The microphone is not ready.");
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    let resolve = () => {};
    this.stopped = new Promise<void>((settle) => {
      resolve = settle;
    });
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      this.clearLimit();
      this.uri =
        chunks.length > 0
          ? URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }))
          : null;
      this.release();
      resolve();
      // The controller ignores this once it stopped the recorder itself; it matters when the
      // time limit or a disconnected microphone ends the recording.
      this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri });
    });
    recorder.addEventListener("error", () => {
      this.onStatus({
        isFinished: false,
        hasError: true,
        error: "Voice recording was interrupted.",
        url: null,
      });
    });
    recorder.start();
    this.recorder = recorder;
    this.limitTimer = window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, forDuration * 1000);
  }

  async stop(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    await this.stopped;
    this.release();
  }

  release(): void {
    this.clearLimit();
    stopStream(this.stream);
    this.stream = null;
  }

  private clearLimit(): void {
    if (this.limitTimer !== null) window.clearTimeout(this.limitTimer);
    this.limitTimer = null;
  }
}
