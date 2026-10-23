import * as Schema from "effect/Schema";

import { RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A model's guess at the user's next prompt after a completed run, written from
 * the thread. The server keeps only the latest one per thread, in memory: it is
 * never persisted, is cleared when the next run starts, and is gone after a restart.
 */
export const PromptSuggestion = Schema.Struct({
  /** Stable for one suggestion, so a client can remember that the user dismissed it. */
  id: TrimmedNonEmptyString,
  /** The run it follows; clients show it only while that run is still the latest. */
  runId: RunId,
  text: TrimmedNonEmptyString,
});
export type PromptSuggestion = typeof PromptSuggestion.Type;

export const PromptSuggestionSubscribeInput = Schema.Struct({
  threadId: ThreadId,
});
export type PromptSuggestionSubscribeInput = typeof PromptSuggestionSubscribeInput.Type;

/** Null means the thread has no suggestion. Sent first, then after every change. */
export const PromptSuggestionStreamEvent = Schema.NullOr(PromptSuggestion);
export type PromptSuggestionStreamEvent = typeof PromptSuggestionStreamEvent.Type;
