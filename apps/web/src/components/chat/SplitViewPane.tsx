import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { sideThreadKindOf } from "@t3tools/client-runtime/side-thread";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  ArrowLeftRightIcon,
  ChevronDownIcon,
  Columns2Icon,
  Maximize2Icon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { useRightPanelStore } from "../../rightPanelStore";
import { isSameScopedThreadRef, useSplitViewStore } from "../../splitViewStore";
import { useProjects, useQuietThreadShell, useVisibleThreadShells } from "../../state/entities";
import { useEnvironmentShellStatus } from "../../state/shell";
import { useEnvironmentThread } from "../../state/threads";
import {
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
} from "../../threadRoutes";
import { cn } from "~/lib/utils";
import ChatView from "../ChatView";
import { useOpenThreadFamily } from "../ThreadRouteView";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundThreadContext } from "./backgroundThread";

function sortCandidateThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  primaryThreadRef: ScopedThreadRef | null,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads
    .filter((thread) => {
      if (thread.archivedAt !== null) return false;
      if (sideThreadKindOf(thread) !== null) return false;
      const ref = scopeThreadRef(thread.environmentId, thread.id);
      if (isSameScopedThreadRef(ref, primaryThreadRef)) return false;
      return true;
    })
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function SplitThreadPickerList(props: {
  readonly primaryThreadRef: ScopedThreadRef | null;
  readonly selectedThreadRef: ScopedThreadRef | null;
  readonly onSelect: (ref: ScopedThreadRef) => void;
  readonly autoFocus?: boolean;
  readonly tall?: boolean;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const visibleThreads = useVisibleThreadShells();
  const projects = useProjects();

  const projectNameByKey = new Map<string, string>();
  for (const project of projects) {
    projectNameByKey.set(
      `${project.environmentId}:${project.id}`,
      project.isScratch ? gt("No project") : project.title,
    );
  }

  const sorted = sortCandidateThreads(visibleThreads, props.primaryThreadRef);
  const trimmed = query.trim().toLowerCase();
  const candidates = (
    trimmed.length === 0
      ? sorted
      : sorted.filter((thread) => {
          const projectName =
            projectNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? "";
          return (
            thread.title.toLowerCase().includes(trimmed) ||
            projectName.toLowerCase().includes(trimmed) ||
            (thread.branch?.toLowerCase().includes(trimmed) ?? false)
          );
        })
  ).slice(0, 40);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
        <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={gt("Search threads…")}
          autoFocus={props.autoFocus}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ScrollArea className={cn("min-h-0", props.tall ? "max-h-80" : "max-h-72")}>
        <div className="flex flex-col gap-0.5 p-1.5">
          {candidates.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              <T>No other threads available.</T>
            </p>
          ) : (
            candidates.map((thread) => {
              const ref = scopeThreadRef(thread.environmentId, thread.id);
              const isSelected = isSameScopedThreadRef(ref, props.selectedThreadRef);
              const projectName =
                projectNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null;
              const isRunning = thread.runtime !== null && thread.runtime.status === "running";
              return (
                <button
                  key={scopedThreadKey(ref)}
                  type="button"
                  onClick={() => props.onSelect(ref)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                    isSelected && "bg-accent",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {isRunning ? (
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {thread.title}
                    </span>
                  </div>
                  {projectName || thread.branch ? (
                    <span className="truncate text-2xs text-muted-foreground">
                      {[projectName, thread.branch].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function SplitViewPane(props: { readonly primaryThreadRef: ScopedThreadRef | null }) {
  const gt = useGT();
  const navigate = useNavigate();
  const secondaryThreadRef = useSplitViewStore((state) => state.secondaryThreadRef);
  const setSecondaryThread = useSplitViewStore((state) => state.setSecondaryThread);
  const closeSplit = useSplitViewStore((state) => state.closeSplit);
  const [pickerOpen, setPickerOpen] = useState(false);

  const effectiveSecondaryRef = isSameScopedThreadRef(secondaryThreadRef, props.primaryThreadRef)
    ? null
    : secondaryThreadRef;

  const shell = useQuietThreadShell(effectiveSecondaryRef);
  const projects = useProjects();
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(
    useEnvironmentShellStatus(effectiveSecondaryRef?.environmentId ?? null),
  );
  const unlistedDetail = useEnvironmentThread(
    effectiveSecondaryRef && shell === null ? effectiveSecondaryRef.environmentId : null,
    effectiveSecondaryRef && shell === null ? effectiveSecondaryRef.threadId : null,
  );
  useOpenThreadFamily(
    effectiveSecondaryRef,
    effectiveSecondaryRef !== null && bootstrapComplete && shell === null,
  );

  const renderState = effectiveSecondaryRef
    ? resolveThreadRouteRenderState({
        bootstrapComplete,
        serverThreadExists: shell !== null,
        serverThreadDeleted: shell?.deletedAt != null,
        unlistedThreadDetail: unlistedDetail,
        draftThreadExists: false,
      })
    : "missing";

  const matchedProject = shell
    ? (projects.find(
        (candidate) =>
          candidate.environmentId === shell.environmentId && candidate.id === shell.projectId,
      ) ?? null)
    : null;
  const projectName = matchedProject
    ? matchedProject.isScratch
      ? gt("No project")
      : matchedProject.title
    : null;

  const splitParentPanel: SideChatParentPanel | null = effectiveSecondaryRef
    ? {
        hostRef: effectiveSecondaryRef,
        openToolDiff: () => {
          closeSplit();
          useRightPanelStore.getState().open(effectiveSecondaryRef, "diff");
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(effectiveSecondaryRef),
          });
        },
        runShellCommand: () => {
          closeSplit();
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(effectiveSecondaryRef),
          });
        },
      }
    : null;

  const canSwap = effectiveSecondaryRef !== null && props.primaryThreadRef !== null;

  const handleSwap = () => {
    if (!effectiveSecondaryRef || !props.primaryThreadRef) return;
    const nextPrimary = effectiveSecondaryRef;
    const nextSecondary = props.primaryThreadRef;
    setSecondaryThread(nextSecondary);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(nextPrimary),
    });
  };

  const handlePromote = () => {
    if (!effectiveSecondaryRef) return;
    closeSplit();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(effectiveSecondaryRef),
    });
  };

  const handleSelectThread = (ref: ScopedThreadRef) => {
    setSecondaryThread(ref);
    setPickerOpen(false);
  };

  const secondaryReady =
    effectiveSecondaryRef !== null &&
    splitParentPanel !== null &&
    (renderState === "ready" || (renderState === "loading" && shell !== null));

  return (
    <div
      data-side-chat-pane={effectiveSecondaryRef?.threadId ?? "split-picker"}
      data-split-view-pane="secondary"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      {/* Reserve right inset so fixed WorkspaceTitlebarControls never overlap split header actions. */}
      <div
        data-chat-header
        className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 border-b border-border/60 pr-40 pl-3"
      >
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent [-webkit-app-region:no-drag]"
              >
                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                  {shell ? shell.title : gt("Choose a thread…")}
                </span>
                {projectName ? (
                  <span className="hidden shrink-0 truncate text-2xs text-muted-foreground xl:inline">
                    {projectName}
                  </span>
                ) : null}
                <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            }
          />
          <PopoverPopup align="start" padding="none" width="md">
            <SplitThreadPickerList
              primaryThreadRef={props.primaryThreadRef}
              selectedThreadRef={effectiveSecondaryRef}
              onSelect={handleSelectThread}
              autoFocus
            />
          </PopoverPopup>
        </Popover>

        <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
          {canSwap ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={gt("Swap split panes")}
                    onClick={handleSwap}
                  >
                    <ArrowLeftRightIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">
                <T>Swap split panes</T>
              </TooltipPopup>
            </Tooltip>
          ) : null}

          {effectiveSecondaryRef ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={gt("Open as main thread")}
                    onClick={handlePromote}
                  >
                    <Maximize2Icon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">
                <T>Open as main thread</T>
              </TooltipPopup>
            </Tooltip>
          ) : null}

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={gt("Close split view")}
                  onClick={closeSplit}
                >
                  <XIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              <T>Close split view</T>
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {secondaryReady ? (
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              key={scopedThreadKey(effectiveSecondaryRef)}
              environmentId={effectiveSecondaryRef.environmentId}
              threadId={effectiveSecondaryRef.threadId}
              routeKind="server"
              embedded={splitParentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6">
          <div className="flex w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <Columns2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">
                  <T>Split view</T>
                </p>
                <p className="text-2xs text-muted-foreground">
                  <T>Pick a thread to run side by side.</T>
                </p>
              </div>
            </div>
            <SplitThreadPickerList
              primaryThreadRef={props.primaryThreadRef}
              selectedThreadRef={effectiveSecondaryRef}
              onSelect={handleSelectThread}
              tall
            />
          </div>
        </div>
      )}
    </div>
  );
}
