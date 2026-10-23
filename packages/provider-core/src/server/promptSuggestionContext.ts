import type { ChatAttachment } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

import { limitTitleMessage } from "./threadTitleContext.ts";

export type PromptSuggestionMessage = {
  /** `event` is a message T3 or an agent sent on the user's behalf, such as a task wake-up. */
  readonly role: "user" | "assistant" | "event";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

const MAX_CONTEXT = 24_000;
const MAX_LATEST_REPLY = 10_000;
const MAX_FIRST_REQUEST = 3_000;
const MAX_EARLIER_MESSAGE = 2_000;
// Below this a message keeps too little to be worth its label.
const MIN_MESSAGE = 200;
const OMITTED = "[Earlier messages omitted]";

/**
 * Keeps what predicts the user's next message: the agent's latest reply almost
 * whole, the request that started the thread, then as many recent messages as
 * fit, newest first, so the model also sees how this user writes.
 */
export function formatPromptSuggestionContext(
  messages: ReadonlyArray<PromptSuggestionMessage>,
): string {
  const entries = messages.flatMap((message, index) => {
    const text = assistantCitationsToPlainText(message.text).trim();
    const names = message.attachments?.map((attachment) => attachment.name).join(", ");
    const contents = [text, ...(names ? [`[Attachments: ${names}]`] : [])]
      .filter(Boolean)
      .join("\n");
    if (!contents) return [];
    const label = message.role === "user" ? "USER" : message.role === "event" ? "EVENT" : "AGENT";
    return [{ index, label, contents }];
  });

  const selected = new Map<number, string>();
  // The first request plus a contiguous recent run leave at most two gaps:
  // before that request and after it.
  let remaining = MAX_CONTEXT - 2 * (OMITTED.length + 2);
  const add = (entry: (typeof entries)[number] | undefined, limit: number) => {
    if (entry === undefined || selected.has(entry.index)) return;
    const prefix = `${entry.label}:\n`;
    const budget = Math.min(limit, remaining - prefix.length - 2);
    if (budget < MIN_MESSAGE) return;
    const text = prefix + limitTitleMessage(entry.contents, budget);
    selected.set(entry.index, text);
    remaining -= text.length + 2;
  };

  const latest = entries.at(-1);
  add(latest, latest?.label === "AGENT" ? MAX_LATEST_REPLY : MAX_EARLIER_MESSAGE);
  add(
    entries.find((entry) => entry.label === "USER"),
    MAX_FIRST_REQUEST,
  );
  for (const entry of entries.toReversed()) add(entry, MAX_EARLIER_MESSAGE);

  const sections: Array<string> = [];
  for (const entry of entries) {
    const text = selected.get(entry.index);
    if (text !== undefined) sections.push(text);
    else if (sections.at(-1) !== OMITTED) sections.push(OMITTED);
  }
  return sections.join("\n\n");
}
