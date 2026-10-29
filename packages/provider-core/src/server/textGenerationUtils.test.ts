import { describe, expect, it } from "vite-plus/test";

import {
  sanitizeCommitSubject,
  sanitizePromptSuggestion,
  sanitizeVoiceTranscriptCorrection,
} from "./textGenerationUtils.ts";

describe("sanitizeCommitSubject", () => {
  // regression: #19181 truncation split grapheme clusters at the subject limit
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});

describe("sanitizePromptSuggestion", () => {
  it("unwraps a reply the model put in quotes", () => {
    expect(sanitizePromptSuggestion(' "run the checkout tests" ')).toBe("run the checkout tests");
    expect(sanitizePromptSuggestion("\u201cfaz o commit\u201d")).toBe("faz o commit");
  });

  it("keeps quotes that belong to the message", () => {
    expect(sanitizePromptSuggestion('rename the flag to "beta"')).toBe('rename the flag to "beta"');
    expect(sanitizePromptSuggestion('"a" and "b" both')).toBe('"a" and "b" both');
  });

  it("treats an empty or overlong reply as no suggestion", () => {
    expect(sanitizePromptSuggestion("  ")).toBeNull();
    expect(sanitizePromptSuggestion('""')).toBeNull();
    expect(sanitizePromptSuggestion("x".repeat(1_001))).toBeNull();
  });
});

describe("sanitizeVoiceTranscriptCorrection", () => {
  it("keeps a correction that restores longer terms", () => {
    expect(
      sanitizeVoiceTranscriptCorrection(
        " Pode dar push com force e pedir review do Naveen e do Joel no PR 379. ",
        "Pode dar push com voz e pedir revio na via do BR três79.",
      ),
    ).toBe("Pode dar push com force e pedir review do Naveen e do Joel no PR 379.");
  });

  it("rejects an empty or truncated reply, or one that answers the message instead", () => {
    const transcript = "Como está o build da release? Já publicou no prod-0?";
    expect(sanitizeVoiceTranscriptCorrection("  ", transcript)).toBeNull();
    expect(sanitizeVoiceTranscriptCorrection("Como está o build?", transcript)).toBeNull();
    expect(
      sanitizeVoiceTranscriptCorrection(
        "O build da release terminou há 10 minutos e já está no prod-0. O deploy passou nos health checks e a versão nova responde no domínio.",
        transcript,
      ),
    ).toBeNull();
  });
});
