import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const DEFAULT_MODEL_SELECTION = DEFAULT_UNIFIED_SETTINGS.voiceTranscriptCorrectionModelSelection;

export function VoiceTranscriptCorrectionSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const mixedEnabled = useScopedSettingsMixed(["voiceTranscriptCorrectionEnabled"]);
  const mixedModel = useScopedSettingsMixed(["voiceTranscriptCorrectionModelSelection"]);

  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: settings.voiceTranscriptCorrectionModelSelection,
    },
    textGenerationProviders,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const savedSelection = settings.voiceTranscriptCorrectionModelSelection;
  const savedEntry = instanceEntries.find(
    (entry) => entry.instanceId === savedSelection.instanceId,
  );
  // The server skips correction on a provider that is off rather than fall back to another one.
  const savedModelUsable = savedEntry !== undefined && savedEntry.enabled && savedEntry.isAvailable;
  const usesDefaultModel =
    savedSelection.instanceId === DEFAULT_MODEL_SELECTION.instanceId &&
    savedSelection.model === DEFAULT_MODEL_SELECTION.model;

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["voiceTranscriptCorrectionEnabled"]}
        mixed={mixedEnabled}
        {...searchableSetting("voice-transcript-correction")}
        description="A model reads the thread and fixes misheard terms in dictated text, such as English words, file and branch names, before it reaches the composer. Costs one model call per recording and adds a few seconds."
        control={
          <Switch
            mixed={mixedEnabled}
            checked={mixedEnabled ? false : settings.voiceTranscriptCorrectionEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ voiceTranscriptCorrectionEnabled: Boolean(checked) })
            }
            aria-label="Voice transcript correction"
          />
        }
      />

      {settings.voiceTranscriptCorrectionEnabled || mixedEnabled ? (
        <SettingsRow
          serverScoped
          settingKeys={["voiceTranscriptCorrectionModelSelection"]}
          mixed={mixedModel}
          {...searchableSetting("voice-transcript-correction-model")}
          description={
            savedModelUsable || mixedModel
              ? "Model that corrects dictated text, and the provider that receives the thread. If it fails or takes too long, the text arrives as transcribed."
              : "The chosen model's provider is off or missing, so dictated text arrives uncorrected. Pick another model or turn the provider on."
          }
          resetAction={
            mixedModel || !usesDefaultModel ? (
              <SettingResetButton
                label="voice correction model"
                onClick={() =>
                  updateSettings({
                    voiceTranscriptCorrectionModelSelection: DEFAULT_MODEL_SELECTION,
                  })
                }
              />
            ) : null
          }
          control={
            connectedEnvironments.length === 0 ? (
              <span className="text-sm text-muted-foreground">
                Connect an environment to choose its voice correction model.
              </span>
            ) : (
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel="Voice correction model"
                {...(mixedModel
                  ? { triggerLabel: "Mixed" }
                  : savedModelUsable
                    ? {}
                    : { triggerLabel: "Unavailable" })}
                getModelDisabledReason={modelDisabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = modelDisabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: "Voice correction model not saved",
                      description: reason,
                    });
                    return;
                  }
                  updateSettings({
                    voiceTranscriptCorrectionModelSelection: createModelSelection(
                      instanceId,
                      model,
                    ),
                  });
                }}
              />
            )
          }
        />
      ) : null}
    </>
  );
}
