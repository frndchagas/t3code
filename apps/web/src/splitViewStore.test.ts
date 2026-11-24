import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  SPLIT_VIEW_DEFAULT_RATIO,
  SPLIT_VIEW_MAX_RATIO,
  SPLIT_VIEW_MIN_RATIO,
  clampSplitRatio,
  isSameScopedThreadRef,
  useSplitViewStore,
} from "./splitViewStore";

const threadA = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-a"),
};
const threadB = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-b"),
};
const threadOtherEnv = {
  environmentId: EnvironmentId.make("env-2"),
  threadId: ThreadId.make("thread-a"),
};

describe("splitViewStore", () => {
  beforeEach(() => {
    useSplitViewStore.setState({
      isOpen: false,
      secondaryThreadRef: null,
      ratio: SPLIT_VIEW_DEFAULT_RATIO,
    });
  });

  it("clamps split ratio within safe bounds and handles non-finite inputs", () => {
    expect(clampSplitRatio(0.1)).toBe(SPLIT_VIEW_MIN_RATIO);
    expect(clampSplitRatio(0.9)).toBe(SPLIT_VIEW_MAX_RATIO);
    expect(clampSplitRatio(0.45)).toBe(0.45);
    expect(clampSplitRatio(Number.NaN)).toBe(SPLIT_VIEW_DEFAULT_RATIO);
    expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(SPLIT_VIEW_DEFAULT_RATIO);
  });

  it("compares scoped thread refs by both environmentId and threadId", () => {
    expect(isSameScopedThreadRef(threadA, { ...threadA })).toBe(true);
    expect(isSameScopedThreadRef(threadA, threadB)).toBe(false);
    expect(isSameScopedThreadRef(threadA, threadOtherEnv)).toBe(false);
    expect(isSameScopedThreadRef(threadA, null)).toBe(false);
  });

  it("opens, switches, toggles, resizes, and preserves last secondary thread on close", () => {
    const store = useSplitViewStore.getState();
    store.openSplit(threadA);
    expect(useSplitViewStore.getState().isOpen).toBe(true);
    expect(useSplitViewStore.getState().secondaryThreadRef).toEqual(threadA);

    store.setSecondaryThread(threadB);
    expect(useSplitViewStore.getState().secondaryThreadRef).toEqual(threadB);

    store.setRatio(0.62);
    expect(useSplitViewStore.getState().ratio).toBe(0.62);

    store.closeSplit();
    expect(useSplitViewStore.getState().isOpen).toBe(false);
    expect(useSplitViewStore.getState().secondaryThreadRef).toEqual(threadB);

    store.toggleSplit();
    expect(useSplitViewStore.getState().isOpen).toBe(true);
    expect(useSplitViewStore.getState().secondaryThreadRef).toEqual(threadB);

    store.resetRatio();
    expect(useSplitViewStore.getState().ratio).toBe(SPLIT_VIEW_DEFAULT_RATIO);
  });
});
