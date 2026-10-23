import { describe, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PromptSuggestions from "./PromptSuggestions.ts";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const runId = RunId.make("run-1");
const suggestion = { id: "suggestion-1", runId, text: "Add a regression test" };

const currentSuggestion = (suggestions: typeof PromptSuggestions.PromptSuggestions.Service) =>
  suggestions.stream(threadId).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([value]) => value),
  );

describe("PromptSuggestions", () => {
  it.effect("sends a late subscriber the current suggestion", () =>
    Effect.gen(function* () {
      const suggestions = yield* PromptSuggestions.make;
      yield* suggestions.publish(threadId, suggestion);

      expect(yield* currentSuggestion(suggestions)).toEqual(suggestion);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("keeps the suggestion, and its withdrawal, across a server restart", () =>
    Effect.gen(function* () {
      yield* (yield* PromptSuggestions.make).publish(threadId, suggestion);

      const afterRestart = yield* PromptSuggestions.make;
      expect(yield* currentSuggestion(afterRestart)).toEqual(suggestion);

      yield* afterRestart.publish(threadId, null);
      expect(yield* currentSuggestion(yield* PromptSuggestions.make)).toBeNull();
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("streams a thread's own changes until its suggestion is cleared", () =>
    Effect.gen(function* () {
      const suggestions = yield* PromptSuggestions.make;
      yield* suggestions.publish(threadId, suggestion);
      const subscribed = yield* Deferred.make<void>();
      const collected = yield* suggestions.stream(threadId).pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.takeUntil((value) => value === null),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* suggestions.publish(otherThreadId, { id: "suggestion-2", runId, text: "Elsewhere" });
      yield* suggestions.publish(threadId, null);

      expect(yield* Fiber.join(collected)).toEqual([suggestion, null]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
