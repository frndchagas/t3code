import { describe, expect, it } from "vite-plus/test";

import { buildPromptSuggestionPrompt, buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("names the project to leave out and puts the user's instructions above the limits", () => {
    for (const previousTitle of [undefined, "Hyperdrive Config Crash"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "hyperdrive init crashes without a config",
        previousTitle,
        projectTitle: "Hyperdrive",
        instructions: "Prefix every title with the team name.",
      });
      expect(prompt).toContain('Never include the project name ("Hyperdrive")');
      expect(prompt).not.toContain("fewer than 40 characters");
      expect(prompt).toContain("Title instructions from the user:\nPrefix every title");
    }
    expect(buildThreadTitlePrompt({ message: "Fix login", instructions: " " }).prompt).toContain(
      "3-8 words, fewer than 40 characters.",
    );
  });
});

describe("buildPromptSuggestionPrompt", () => {
  it("never offers to publish or send what the developer only approved", () => {
    const { prompt } = buildPromptSuggestionPrompt({
      conversation:
        "USER: Draft the reply to Lucas.\n\nAGENT: Here is the draft. Do you approve it?",
    });

    expect(prompt).toContain("Never suggest publishing, posting, or sending anything");
    expect(prompt).toContain("the developer asked in this thread to send that same content");
    expect(prompt).toContain(
      "approving a draft, its wording, or a change is not permission to publish it",
    );
    expect(prompt).toContain("keep something reserved or unsent");
    // Other irreversible actions still follow what the developer already asked for.
    expect(prompt).toContain("Do not propose other irreversible actions");
  });
});
