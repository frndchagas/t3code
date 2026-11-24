import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const SPLIT_VIEW_STORAGE_KEY = "t3code:split-view:v1";
export const SPLIT_VIEW_MIN_WIDTH_MEDIA_QUERY = "(min-width: 1024px)";
export const SPLIT_VIEW_DEFAULT_RATIO = 0.5;
export const SPLIT_VIEW_MIN_RATIO = 0.28;
export const SPLIT_VIEW_MAX_RATIO = 0.72;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_VIEW_DEFAULT_RATIO;
  return Math.min(SPLIT_VIEW_MAX_RATIO, Math.max(SPLIT_VIEW_MIN_RATIO, ratio));
}

export function isSameScopedThreadRef(
  a: ScopedThreadRef | null | undefined,
  b: ScopedThreadRef | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

function normalizeScopedThreadRef(value: unknown): ScopedThreadRef | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.environmentId !== "string" || candidate.environmentId.length === 0) {
    return null;
  }
  if (typeof candidate.threadId !== "string" || candidate.threadId.length === 0) {
    return null;
  }
  return {
    environmentId: candidate.environmentId as ScopedThreadRef["environmentId"],
    threadId: candidate.threadId as ScopedThreadRef["threadId"],
  };
}

interface SplitViewState {
  isOpen: boolean;
  secondaryThreadRef: ScopedThreadRef | null;
  ratio: number;
  openSplit: (threadRef?: ScopedThreadRef | null) => void;
  setSecondaryThread: (threadRef: ScopedThreadRef | null) => void;
  closeSplit: () => void;
  toggleSplit: () => void;
  setRatio: (ratio: number) => void;
  resetRatio: () => void;
}

export const useSplitViewStore = create<SplitViewState>()(
  persist(
    (set) => ({
      isOpen: false,
      secondaryThreadRef: null,
      ratio: SPLIT_VIEW_DEFAULT_RATIO,
      openSplit: (threadRef) =>
        set((state) => ({
          isOpen: true,
          secondaryThreadRef: threadRef === undefined ? state.secondaryThreadRef : threadRef,
        })),
      setSecondaryThread: (threadRef) =>
        set({
          secondaryThreadRef: threadRef,
        }),
      closeSplit: () => set({ isOpen: false }),
      toggleSplit: () =>
        set((state) => ({
          isOpen: !state.isOpen,
        })),
      setRatio: (ratio) => set({ ratio: clampSplitRatio(ratio) }),
      resetRatio: () => set({ ratio: SPLIT_VIEW_DEFAULT_RATIO }),
    }),
    {
      name: SPLIT_VIEW_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        isOpen: state.isOpen,
        secondaryThreadRef: state.secondaryThreadRef,
        ratio: state.ratio,
      }),
      merge: (persisted, current) => {
        const record =
          persisted && typeof persisted === "object"
            ? (persisted as Record<string, unknown>)
            : null;
        if (!record) return current;
        return {
          ...current,
          isOpen: record.isOpen === true,
          secondaryThreadRef: normalizeScopedThreadRef(record.secondaryThreadRef),
          ratio:
            typeof record.ratio === "number"
              ? clampSplitRatio(record.ratio)
              : SPLIT_VIEW_DEFAULT_RATIO,
        };
      },
    },
  ),
);
