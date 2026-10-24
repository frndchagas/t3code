import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Ticks once a second while mounted, so only this label repaints during a recording. */
function RecordingElapsed() {
  const [startedAt] = useState(() => Date.now());
  const [seconds, setSeconds] = useState(0);
  // oxlint-disable-next-line t3code/react-effect-budget -- Own the one-second timer for the elapsed label and clear it on unmount.
  useEffect(() => {
    const interval = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(interval);
  }, [startedAt]);
  return (
    <span className="min-w-8 text-center text-muted-foreground text-xs tabular-nums">
      {formatElapsed(seconds)}
    </span>
  );
}

function ActionTooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function ComposerVoiceControl({
  state,
  disabled,
  onStart,
  onStop,
  onCancel,
}: {
  readonly state: VoiceInputState;
  readonly disabled: boolean;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}) {
  const keepFocus = (event: React.PointerEvent) => event.preventDefault();

  if (state.phase === "idle" || state.phase === "error") {
    return (
      <ActionTooltip label="Voice input">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          onPointerDown={keepFocus}
          onClick={onStart}
          aria-label="Start voice input"
        >
          <MicIcon />
        </Button>
      </ActionTooltip>
    );
  }

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Voice input">
      <ActionTooltip label="Discard recording">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onPointerDown={keepFocus}
          onClick={onCancel}
          aria-label="Discard recording"
        >
          <XIcon />
        </Button>
      </ActionTooltip>
      {state.phase === "recording" ? (
        <>
          <RecordingElapsed />
          <ActionTooltip label="Transcribe recording">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={keepFocus}
              onClick={onStop}
              aria-label="Transcribe recording"
            >
              <CheckIcon />
            </Button>
          </ActionTooltip>
        </>
      ) : (
        <span
          className="flex items-center gap-1.5 px-1 text-muted-foreground text-xs"
          role="status"
        >
          <Spinner size="sm" aria-hidden="true" />
          {state.phase === "preparing" ? "Preparing" : "Transcribing"}
        </span>
      )}
    </div>
  );
}
