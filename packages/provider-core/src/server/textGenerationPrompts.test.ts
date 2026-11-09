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
  it("names the project to leave out of initial and regenerated titles", () => {
    for (const previousTitle of [undefined, "Hyperdrive Config Crash"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "hyperdrive init crashes without a config",
        previousTitle,
        projectTitle: "Hyperdrive",
      });
      expect(prompt).toContain('Never include the project name ("Hyperdrive")');
    }
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
