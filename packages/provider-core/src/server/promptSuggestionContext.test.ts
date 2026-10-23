import { describe, expect, it } from "vite-plus/test";

import { formatPromptSuggestionContext } from "./promptSuggestionContext.ts";

describe("prompt suggestion context", () => {
  it("keeps the request, the latest exchange, and the reply's ending in a long thread", () => {
    const result = formatPromptSuggestionContext([
      { role: "user", text: "Migrate the billing worker to the new queue." },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
        text: `Step ${index}. ${"Working notes. ".repeat(200)}`,
      })),
      { role: "user", text: "Now drop the old queue tables." },
      {
        role: "assistant",
        text: `${"Migration details. ".repeat(1_000)}Should I also delete the backup snapshot?`,
      },
    ]);

    expect(result.startsWith("USER:\nMigrate the billing worker to the new queue.")).toBe(true);
    expect(result).toContain("[Earlier messages omitted]");
    expect(result).toContain("USER:\nNow drop the old queue tables.");
    expect(result.endsWith("Should I also delete the backup snapshot?")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(24_000);
  });

  it("keeps messages in thread order and marks those the user did not write", () => {
    const result = formatPromptSuggestionContext([
      { role: "user", text: "Watch the PR checks." },
      { role: "event", text: "Checks finished: lint failed." },
      { role: "assistant", text: "Lint fails on an unused import. Fix it?" },
    ]);

    expect(result).toBe(
      [
        "USER:\nWatch the PR checks.",
        "EVENT:\nChecks finished: lint failed.",
        "AGENT:\nLint fails on an unused import. Fix it?",
      ].join("\n\n"),
    );
  });
});
