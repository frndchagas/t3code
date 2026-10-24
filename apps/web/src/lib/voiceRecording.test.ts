import { describe, expect, it } from "vite-plus/test";

import { encodePcm16Wav } from "./voiceRecording";

describe("encodePcm16Wav", () => {
  it("writes a mono 16-bit PCM header and clamps samples to the 16-bit range", () => {
    const bytes = encodePcm16Wav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16_000);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...bytes.subarray(offset, offset + length));

    expect(ascii(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(ascii(8, 8)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(12);
    const samples = Array.from({ length: 6 }, (_, index) => view.getInt16(44 + index * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});
