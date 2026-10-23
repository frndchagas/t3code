import { useRef } from "react";
import { createModelSelection } from "@t3tools/shared/model";

import { providerInstanceEntriesFor } from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
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

export function PromptSuggestionSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, targets, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const scopeKey = targets.map((entry) => `${entry.environmentId}:${entry.projectId}`).join(",");
  const mixedEnabled = useScopedSettingsMixed(["promptSuggestionsEnabled"]);
  const mixedModel = useScopedSettingsMixed(["promptSuggestionModelSelection"]);
  const mixedInstructions = useScopedSettingsMixed(["promptSuggestionInstructions"]);
  const instructionsEdited = useRef(false);

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
  const usesDedicatedModel = settings.promptSuggestionModelSelection !== null;
  // Off starts from the text generation model; the switch then saves it as the dedicated model.
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection:
        settings.promptSuggestionModelSelection ?? settings.textGenerationModelSelection,
    },
    textGenerationProviders,
  );
  const canEnableDedicatedModel = instanceEntries.some(
    (entry) => entry.instanceId === selection.instanceId && entry.enabled && entry.isAvailable,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const rejectModel = (reason: string) =>
    toastManager.add({
      type: "error",
      title: "Prompt suggestion model not saved",
      description: reason,
    });

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["promptSuggestionsEnabled"]}
        mixed={mixedEnabled}
        {...searchableSetting("prompt-suggestions")}
        description="After each reply, a model reads the thread and suggests your next message in the empty composer. Press Right Arrow or Tab to use it, Esc to hide it. Costs one extra model call per reply."
        control={
          <Switch
            mixed={mixedEnabled}
            checked={mixedEnabled ? false : settings.promptSuggestionsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
            }
            aria-label="Prompt suggestions"
          />
        }
      />

      {settings.promptSuggestionsEnabled || mixedEnabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["promptSuggestionModelSelection"]}
            {...searchableSetting("prompt-suggestion-model")}
            description="Model that writes the suggestions. Off uses each thread's own model."
            control={
              !hasServerTargets ? (
                <span className="text-sm text-muted-foreground">
                  Connect an environment to choose its prompt suggestion model.
                </span>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {(usesDedicatedModel || mixedModel) && canEnableDedicatedModel ? (
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={selection.instanceId}
                      model={selection.model}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      triggerAriaLabel="Prompt suggestion model"
                      {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
                      getModelDisabledReason={modelDisabledReason}
                      onInstanceModelChange={(instanceId, model) => {
                        const reason = modelDisabledReason(instanceId, model);
                        if (reason) {
                          rejectModel(reason);
                          return;
                        }
                        updateSettings({
                          promptSuggestionModelSelection: createModelSelection(instanceId, model),
                        });
                      }}
                    />
                  ) : null}
                  {usesDedicatedModel && canEnableDedicatedModel && !mixedModel && instanceEntry ? (
                    <TraitsPicker
                      provider={instanceEntry.driverKind}
                      models={instanceEntry.models}
                      model={selection.model}
                      modelOptions={selection.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={
                        settings.planModeEnabled || selectsPlanAgent(selection.options)
                      }
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        updateSettings({
                          promptSuggestionModelSelection: createModelSelection(
                            selection.instanceId,
                            selection.model,
                            options,
                          ),
                        })
                      }
                    />
                  ) : null}
                  <Switch
                    mixed={mixedModel}
                    checked={mixedModel ? false : usesDedicatedModel}
                    disabled={!usesDedicatedModel && !canEnableDedicatedModel}
                    onCheckedChange={(checked) => {
                      if (!checked) {
                        updateSettings({ promptSuggestionModelSelection: null });
                        return;
                      }
                      const reason = modelDisabledReason(selection.instanceId, selection.model);
                      if (reason) {
                        rejectModel(reason);
                        return;
                      }
                      updateSettings({
                        promptSuggestionModelSelection: createModelSelection(
                          selection.instanceId,
                          selection.model,
                          selection.options,
                        ),
                      });
                    }}
                    aria-label="Use a separate prompt suggestion model"
                  />
                </div>
              )
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["promptSuggestionInstructions"]}
            {...searchableSetting("prompt-suggestion-instructions")}
            description="Your preferences for suggestions, such as language, length, or what to leave out."
            resetAction={
              mixedInstructions || settings.promptSuggestionInstructions !== "" ? (
                <SettingResetButton
                  label="prompt suggestion instructions"
                  onClick={() => updateSettings({ promptSuggestionInstructions: "" })}
                />
              ) : null
            }
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                key={`${scopeKey}:${mixedInstructions}:${settings.promptSuggestionInstructions}`}
                aria-label="Prompt suggestion instructions"
                onChange={() => {
                  instructionsEdited.current = true;
                }}
                rows={4}
                defaultValue={mixedInstructions ? "" : settings.promptSuggestionInstructions}
                placeholder={
                  mixedInstructions
                    ? "Mixed. Enter instructions to apply to all selected targets."
                    : "Write in Portuguese. Prefer one concrete next step over a summary."
                }
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (
                    instructionsEdited.current &&
                    (mixedInstructions || value !== settings.promptSuggestionInstructions)
                  )
                    updateSettings({ promptSuggestionInstructions: value });
                  instructionsEdited.current = false;
                }}
              />
            </div>
          </SettingsRow>
        </>
      ) : null}
    </>
  );
}
