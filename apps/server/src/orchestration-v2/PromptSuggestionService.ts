import type { RunId, ThreadId } from "@t3tools/contracts";
import { formatPromptSuggestionContext } from "@t3tools/provider-core/server/promptSuggestionContext";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as PromptSuggestions from "../provider/PromptSuggestions.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * When a run completes with prompt suggestions on, asks a model for the user's
 * likely next message and publishes it to the thread's composer. Any other run
 * change outdates it: the suggestion is withdrawn and a generation still in
 * flight for that thread is interrupted.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const suggestions = yield* PromptSuggestions.PromptSuggestions;

  const suggest = Effect.fn("PromptSuggestionService.suggest")(
    function* (threadId: ThreadId, runId: RunId) {
      const current = yield* settings.getSettings;
      if (!current.promptSuggestionsEnabled) return;
      const { thread, runs, messages } = yield* projections.getThreadRecords(
        threadId,
        ["runs", "messages"],
        { messageRoles: ["user", "assistant"] },
      );
      // Nobody types into a subagent's thread.
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.lineage.relationshipToParent === "subagent"
      )
        return;
      const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (latest?.id !== runId || latest.status !== "completed") return;
      if (runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return;
      const conversation = messages.filter((message) => !message.streaming);
      if (conversation.at(-1)?.role !== "assistant") return;
      const project = yield* projects.get(thread.projectId);
      if (Option.isNone(project)) return;

      const result = yield* textGeneration.generatePromptSuggestion({
        cwd: thread.worktreePath ?? project.value.workspaceRoot,
        conversation: formatPromptSuggestionContext(
          conversation.map((message) => ({
            role:
              message.role === "assistant"
                ? "assistant"
                : message.createdBy === "user"
                  ? "user"
                  : "event",
            text: message.text,
            attachments: message.attachments,
          })),
        ),
        instructions: current.promptSuggestionInstructions,
        // The thread's own model at its default options: an effort picked for
        // the work itself would only make the suggestion slow to arrive.
        modelSelection:
          current.promptSuggestionModelSelection ??
          createModelSelection(thread.modelSelection.instanceId, thread.modelSelection.model),
      });
      if (result.suggestion === null) return;
      // One suggestion per run, so the run id also lets a client remember a dismissal.
      yield* suggestions.publish(threadId, { id: runId, runId, text: result.suggestion });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("prompt suggestion skipped", { threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("PromptSuggestionService.start")(function* () {
    // Keyed by thread: a newer run interrupts the generation for the older one.
    const generations = yield* FiberMap.make<ThreadId>();
    // A completed run can be reported more than once; generate for it once.
    const requestedRuns = new Map<ThreadId, RunId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        // Suggestions are stored, so a deleted thread must not leave one behind.
        if (event.type !== "run.updated" && event.type !== "thread.deleted") return Effect.void;
        const threadId = event.threadId;
        if (event.type === "run.updated" && event.payload.status === "completed") {
          if (requestedRuns.get(threadId) === event.payload.id) return Effect.void;
          requestedRuns.set(threadId, event.payload.id);
          return FiberMap.run(generations, threadId, suggest(threadId, event.payload.id));
        }
        requestedRuns.delete(threadId);
        return FiberMap.remove(generations, threadId).pipe(
          Effect.andThen(suggestions.publish(threadId, null)),
        );
      }),
    );
  });

  return { start };
});
