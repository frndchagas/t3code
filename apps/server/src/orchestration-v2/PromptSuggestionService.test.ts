import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import type { PromptSuggestionGenerationInput } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PromptSuggestions from "../provider/PromptSuggestions.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as PromptSuggestionService from "./PromptSuggestionService.ts";

const NOW = DateTime.makeUnsafe("2026-10-23T12:00:00.000Z");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const THREAD_MODEL = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "max" }],
};

interface TestRun {
  readonly id: RunId;
  readonly ordinal: number;
  status: OrchestrationV2Run["status"];
}

interface TestThread {
  readonly runs: Array<TestRun>;
  readonly messages: Array<{
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdBy: "user" | "agent" | "system";
  }>;
}

const runUpdated = (run: TestRun): OrchestrationV2DomainEvent => ({
  type: "run.updated",
  id: EventId.make(`event:${run.id}:${run.status}`),
  threadId: THREAD_ID,
  runId: run.id,
  occurredAt: NOW,
  payload: {
    id: run.id,
    threadId: THREAD_ID,
    ordinal: run.ordinal,
    providerInstanceId: THREAD_MODEL.instanceId,
    modelSelection: THREAD_MODEL,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${run.id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: run.status,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    checkpointId: null,
    contextHandoffId: null,
  },
});

type Suggestions = typeof PromptSuggestions.PromptSuggestions.Service;

const FIRST_RUN: TestRun = { id: RunId.make("run-1"), ordinal: 1, status: "completed" };

const withService = <A, E>(
  body: (harness: {
    readonly thread: TestThread;
    readonly events: Queue.Queue<OrchestrationV2DomainEvent>;
    readonly requests: Array<PromptSuggestionGenerationInput>;
    readonly suggestions: Suggestions;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const requests: Array<PromptSuggestionGenerationInput> = [];
    const thread: TestThread = {
      runs: [{ ...FIRST_RUN }],
      messages: [
        { role: "user", text: "fix the flaky checkout test", createdBy: "user" },
        {
          role: "assistant",
          text: "Fixed it. Want me to run the whole suite?",
          createdBy: "agent",
        },
      ],
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              projectId: PROJECT_ID,
              modelSelection: THREAD_MODEL,
              worktreePath: null,
              archivedAt: null,
              deletedAt: null,
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: THREAD_ID,
              },
            },
            runs: thread.runs.map((run) => ({ ...run })),
            messages: thread.messages.map((message) => ({ ...message, streaming: false })),
          } as never),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () => Effect.succeed(Option.some({ workspaceRoot: "/workspace/project" } as never)),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, promptSuggestionsEnabled: true }),
      }),
      Layer.mock(TextGeneration.TextGeneration)({
        generatePromptSuggestion: (input) =>
          Effect.sync(() => {
            requests.push(input);
            return { suggestion: "run the whole suite" };
          }),
      }),
    );
    return yield* Effect.gen(function* () {
      const suggestions = yield* PromptSuggestions.PromptSuggestions;
      const service = yield* PromptSuggestionService.make;
      yield* service.start();
      return yield* body({ thread, events, requests, suggestions });
    }).pipe(
      Effect.provide(
        Layer.merge(
          dependencies,
          PromptSuggestions.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const nextSuggestion = (suggestions: Suggestions, matches: (text: string | null) => boolean) =>
  suggestions.stream(THREAD_ID).pipe(
    Stream.filter((suggestion) => matches(suggestion?.text ?? null)),
    Stream.runHead,
  );

it.effect("suggests the next message from the thread when a run completes", () =>
  withService(({ events, requests, suggestions }) =>
    Effect.gen(function* () {
      yield* Queue.offer(events, runUpdated(FIRST_RUN));

      const published = yield* nextSuggestion(suggestions, (text) => text !== null);
      assert.deepStrictEqual(Option.getOrNull(published), {
        id: "run-1",
        runId: RunId.make("run-1"),
        text: "run the whole suite",
      });
      assert.strictEqual(requests.length, 1);
      const [request] = requests;
      assert.include(request?.conversation, "Want me to run the whole suite?");
      assert.strictEqual(request?.cwd, "/workspace/project");
      // The thread's model, without the effort picked for the work itself.
      assert.deepStrictEqual(request?.modelSelection, {
        instanceId: THREAD_MODEL.instanceId,
        model: THREAD_MODEL.model,
      });
    }),
  ),
);

it.effect("withdraws the suggestion as soon as the next run starts", () =>
  withService(({ thread, events, suggestions }) =>
    Effect.gen(function* () {
      yield* Queue.offer(events, runUpdated(FIRST_RUN));
      yield* nextSuggestion(suggestions, (text) => text !== null);

      const next: TestRun = { id: RunId.make("run-2"), ordinal: 2, status: "running" };
      thread.runs.push(next);
      yield* Queue.offer(events, runUpdated(next));

      const withdrawn = yield* nextSuggestion(suggestions, (text) => text === null);
      assert.isTrue(Option.isSome(withdrawn));
    }),
  ),
);

it.effect("clears the suggestion when its thread is deleted", () =>
  withService(({ events, suggestions }) =>
    Effect.gen(function* () {
      yield* Queue.offer(events, runUpdated(FIRST_RUN));
      yield* nextSuggestion(suggestions, (text) => text !== null);

      yield* Queue.offer(events, {
        type: "thread.deleted",
        id: EventId.make("event:thread-deleted"),
        threadId: THREAD_ID,
        occurredAt: NOW,
        payload: {} as never,
      });

      const cleared = yield* nextSuggestion(suggestions, (text) => text === null);
      assert.isTrue(Option.isSome(cleared));
    }),
  ),
);

it.effect("asks the model once when a completed run is reported again", () =>
  withService(({ thread, events, requests, suggestions }) =>
    Effect.gen(function* () {
      yield* Queue.offer(events, runUpdated(FIRST_RUN));
      yield* Queue.offer(events, runUpdated(FIRST_RUN));
      yield* nextSuggestion(suggestions, (text) => text !== null);

      // A later run's suggestion proves the repeated event was already handled.
      const second: TestRun = { id: RunId.make("run-2"), ordinal: 2, status: "completed" };
      thread.runs.push(second);
      yield* Queue.offer(events, runUpdated(second));
      yield* suggestions.stream(THREAD_ID).pipe(
        Stream.filter((suggestion) => suggestion?.runId === RunId.make("run-2")),
        Stream.runHead,
      );
      assert.strictEqual(requests.length, 2);
    }),
  ),
);
