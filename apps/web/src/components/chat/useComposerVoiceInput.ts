import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createServerVoiceTranscriber,
  voiceDetectionLocales,
} from "@t3tools/client-runtime/state/voice";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { uploadBytes } from "../../lib/attachmentUploadQueue";
import {
  BrowserVoiceRecorder,
  convertRecordingToWav,
  isBrowserVoiceRecordingSupported,
  requestMicrophonePermission,
} from "../../lib/voiceRecording";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { attachmentEnvironment } from "../../state/attachments";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { voiceEnvironment } from "../../state/voice";
import { toastManager } from "../ui/toast";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export interface ComposerVoiceInputTarget {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  /** BCP 47 tag; empty detects the spoken language among the browser's languages. */
  readonly language: string;
  readonly readDraft: () => Omit<VoiceDraftSnapshot, "ownerKey" | "revision"> | null;
  readonly commitDraft: (text: string, cursor: number) => void;
}

function createController(
  latest: { readonly current: ComposerVoiceInputTarget },
  onStateChange: (state: VoiceInputState) => void,
) {
  let recorder: BrowserVoiceRecorder | null = null;
  const controller: VoiceInputController = new VoiceInputController({
    recorder: (recorder = new BrowserVoiceRecorder((status) =>
      controller.handleRecorderStatus(status),
    )),
    getTranscriber: () => {
      const { environmentId, language } = latest.current;
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return null;
      return createServerVoiceTranscriber({
        registry: appAtomRegistry,
        environmentId,
        locales: language
          ? [language]
          : voiceDetectionLocales(
              navigator.languages.length > 0 ? navigator.languages : [navigator.language],
            ),
        prepare: voiceEnvironment.prepare,
        transcribe: voiceEnvironment.transcribe,
        createUploadUrl: attachmentEnvironment.createUploadUrl,
        removeAttachment: attachmentEnvironment.remove,
        resolveUploadUrl: (relativeUrl) => {
          const connection = readPreparedConnection(environmentId);
          return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
        },
        readRecording: async (uri) => {
          const wav = await convertRecordingToWav(await (await fetch(uri)).blob());
          return {
            sizeBytes: wav.size,
            mimeType: wav.type,
            fileName: "voice-input.wav",
            upload: (url) =>
              uploadBytes({ url, file: wav, mimeType: wav.type, onProgress: () => {} }),
          };
        },
      });
    },
    requestPermission: requestMicrophonePermission,
    configureRecording: async () => {},
    releaseRecording: async () => recorder?.release(),
    deleteRecording: (uri) => URL.revokeObjectURL(uri),
    readDraft: () => {
      const target = latest.current;
      const draft = target.readDraft();
      // The editor is read-only while voice input runs, so text equality is a sufficient revision.
      return draft ? { ...draft, ownerKey: target.ownerKey, revision: 0 } : null;
    },
    commitDraft: (text, selection) => latest.current.commitDraft(text, selection.start),
    onStateChange,
  });
  return controller;
}

export function useComposerVoiceInput(target: ComposerVoiceInputTarget, available: boolean) {
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const latest = useRef(target);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the controller's callbacks reading the current composer target without rebuilding it.
  useLayoutEffect(() => {
    latest.current = target;
  });
  const controllerRef = useRef<VoiceInputController | null>(null);
  const supported = available && isBrowserVoiceRecordingSupported();

  // Built on first use so composers that never record never touch the audio APIs.
  const [actions] = useState(() => {
    const controller = () => {
      if (controllerRef.current === null) {
        controllerRef.current = createController(latest, (next) => {
          setState(next);
          if (next.phase === "error" && next.error) {
            toastManager.add({ type: "error", title: next.error });
          }
        });
      }
      return controllerRef.current;
    };
    return {
      start: () => void controller().start(),
      stop: () => void controller().stop(),
      cancel: () => controllerRef.current?.cancel(),
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the microphone and recorder when the composer unmounts.
  useEffect(() => () => controllerRef.current?.dispose(), []);
  const owner = `${target.environmentId}\u0000${target.ownerKey}`;
  const recordedOwner = useRef(owner);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The composer switches threads without a handler the controller sees, so a recording learns its owner changed here.
  useEffect(() => {
    if (recordedOwner.current === owner) return;
    recordedOwner.current = owner;
    controllerRef.current?.ownerChanged();
  }, [owner]);
  // The control unmounts when voice input stops being available, e.g. a pending question takes
  // over the composer, so a recording in flight would have no way to stop.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Losing availability calls no handler, so cancel a recording in flight here.
  useEffect(() => {
    if (!supported) controllerRef.current?.cancel();
  }, [supported]);

  return { supported, state, busy: voiceInputBlocksSubmission(state), ...actions };
}
