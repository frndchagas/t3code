import { describe, expect, it } from "vite-plus/test";

import {
  limitSection,
  sanitizeCommitSubject,
  sanitizePromptSuggestion,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

describe("limitSection", () => {
  it("cuts a long section without splitting an emoji", () => {
    expect(limitSection(`${"a".repeat(9)}🚀 more`, 10)).toBe(`${"a".repeat(9)}\n\n[truncated]`);
  });
});

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

describe("sanitizeThreadTitle", () => {
  it.each([
    { name: "a split surrogate pair", prefixLength: 116, character: "🚀", retained: "" },
    { name: "a complete surrogate pair", prefixLength: 115, character: "🚀", retained: "🚀" },
    { name: "a BMP character", prefixLength: 116, character: "界", retained: "界" },
  ])("truncates without splitting $name", ({ prefixLength, character, retained }) => {
    const prefix = "a".repeat(prefixLength);
    const title = `${prefix}${character} more`;

    expect(sanitizeThreadTitle(title)).toBe(`${prefix}${retained}...`);
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
