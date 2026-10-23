import { PromptSuggestion, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";

interface PromptSuggestionChange {
  readonly threadId: ThreadId;
  readonly suggestion: PromptSuggestion | null;
}

const PromptSuggestionJson = Schema.fromJsonString(PromptSuggestion);

const SuggestionRow = Schema.Struct({ suggestion: PromptSuggestionJson });

/**
 * The latest suggested next prompt per thread, kept across restarts until the thread's next run
 * publishes `null`. The default reference drops everything so publishers stay dependency-free in
 * tests; provide the live layer once, above the WebSocket routes and `PromptSuggestionService`.
 */
export class PromptSuggestions extends Context.Reference<{
  readonly publish: (
    threadId: ThreadId,
    suggestion: PromptSuggestion | null,
  ) => Effect.Effect<void>;
  readonly stream: (threadId: ThreadId) => Stream.Stream<PromptSuggestion | null>;
}>("t3/provider/PromptSuggestions", {
  defaultValue: () => ({
    publish: () => Effect.void,
    stream: () => Stream.make(null),
  }),
}) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<PromptSuggestionChange>();

  // Created here, not by a migration: this table ships in a fork, and a fork
  // migration id would collide with the next one upstream adds.
  yield* sql`
    CREATE TABLE IF NOT EXISTS prompt_suggestions (
      thread_id TEXT PRIMARY KEY,
      suggestion_json TEXT NOT NULL
    ) WITHOUT ROWID
  `.pipe(Effect.orDie);

  const findSuggestion = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SuggestionRow,
    execute: (threadId) =>
      sql`SELECT suggestion_json AS "suggestion" FROM prompt_suggestions WHERE thread_id = ${threadId}`,
  });
  const encodeSuggestion = Schema.encodeEffect(PromptSuggestionJson);

  const current = Effect.fn("PromptSuggestions.current")(
    function* (threadId: ThreadId) {
      const row = yield* findSuggestion(threadId);
      return Option.match(row, { onNone: () => null, onSome: (found) => found.suggestion });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("prompt suggestion unreadable", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      ),
  );

  const publish: (typeof PromptSuggestions.Service)["publish"] = Effect.fn(
    "PromptSuggestions.publish",
  )(
    function* (threadId, suggestion) {
      // RETURNING yields a row only when the stored suggestion actually changed,
      // so run updates that clear an empty slot notify nobody.
      const changed =
        suggestion === null
          ? yield* sql`DELETE FROM prompt_suggestions WHERE thread_id = ${threadId} RETURNING thread_id`
          : yield* sql`
              INSERT INTO prompt_suggestions (thread_id, suggestion_json)
              VALUES (${threadId}, ${yield* encodeSuggestion(suggestion)})
              ON CONFLICT (thread_id) DO UPDATE SET suggestion_json = excluded.suggestion_json
              WHERE suggestion_json IS NOT excluded.suggestion_json
              RETURNING thread_id
            `;
      if (changed.length > 0) yield* PubSub.publish(changes, { threadId, suggestion });
    },
    // A generation interrupted by a newer run must not leave its row unannounced.
    Effect.uninterruptible,
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("prompt suggestion not saved", { threadId, cause }),
        ),
      ),
  );

  /**
   * One-slot sliding mailbox per subscriber: each value replaces the last, so
   * a slow socket only ever holds the current suggestion.
   */
  const stream: (typeof PromptSuggestions.Service)["stream"] = (threadId) =>
    Stream.callback<PromptSuggestion | null>(
      (mailbox) =>
        Effect.gen(function* () {
          // Subscribe before reading, so a change made during the read still
          // arrives; once one has, the stored value it replaced is stale.
          let changed = false;
          const subscription = yield* PubSub.subscribe(changes);
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((change) =>
              Effect.sync(() => {
                if (change.threadId !== threadId) return;
                changed = true;
                Queue.offerUnsafe(mailbox, change.suggestion);
              }),
            ),
            Effect.forkScoped,
          );
          const initial = yield* current(threadId);
          if (!changed) Queue.offerUnsafe(mailbox, initial);
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return { publish, stream } satisfies typeof PromptSuggestions.Service;
});

export const layer = Layer.effect(PromptSuggestions, make);
