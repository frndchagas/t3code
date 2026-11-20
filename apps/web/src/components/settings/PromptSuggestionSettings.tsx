import { T, useGT } from "gt-react";
import { useRef } from "react";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";

import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useTextGenerationTargets } from "../../textGenerators";
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
import { useSearchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function PromptSuggestionSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
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
  const textGenerationTargets = useTextGenerationTargets({
    environmentId,
    settings,
    providers: serverProviders.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: target?.projectId ?? null,
    selections: [settings.promptSuggestionModelSelection, settings.textGenerationModelSelection],
  });
  const textGenerationProviders = textGenerationTargets.providers;
  const instanceEntries = textGenerationTargets.entries;
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries, true);
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
  const modelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const rejectModel = (reason: string) =>
    toastManager.add({
      type: "error",
      title: gt("Prompt suggestion model not saved"),
      description: reason,
    });

  return (
    <>
      {settings.promptSuggestionsEnabled || mixedEnabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["promptSuggestionModelSelection"]}
            {...searchableSetting("prompt-suggestion-model")}
            description={gt("Model that writes the suggestions. Off uses each thread's own model.")}
            control={
              !hasServerTargets ? (
                <span className="text-sm text-muted-foreground">
                  <T>Connect an environment to choose its prompt suggestion model.</T>
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
                      triggerAriaLabel={gt("Prompt suggestion model")}
                      {...(mixedModel ? { triggerLabel: gt("Mixed") } : {})}
                      getModelDisabledReason={modelDisabledReason}
                      onInstanceModelChange={(instanceId, model) => {
                        const reason = modelDisabledReason(instanceId, model);
                        if (reason) {
                          rejectModel(reason);
                          return;
                        }
                        updateSettings({
                          promptSuggestionModelSelection: pickModelSelection(
                            selection,
                            instanceId,
                            model,
                          ),
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
                      includePlanAgent={selectsPlanAgent(selection.options)}
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
                    aria-label={gt("Use a separate prompt suggestion model")}
                  />
                </div>
              )
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["promptSuggestionInstructions"]}
            {...searchableSetting("prompt-suggestion-instructions")}
            description={gt(
              "Your preferences for suggestions, such as language, length, or what to leave out.",
            )}
            resetAction={
              mixedInstructions || settings.promptSuggestionInstructions !== "" ? (
                <SettingResetButton
                  ariaLabel={gt("Reset prompt suggestion instructions")}
                  onClick={() => updateSettings({ promptSuggestionInstructions: "" })}
                />
              ) : null
            }
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                key={`${scopeKey}:${mixedInstructions}:${settings.promptSuggestionInstructions}`}
                aria-label={gt("Prompt suggestion instructions")}
                onChange={() => {
                  instructionsEdited.current = true;
                }}
                rows={4}
                defaultValue={mixedInstructions ? "" : settings.promptSuggestionInstructions}
                placeholder={
                  mixedInstructions
                    ? gt("Mixed. Enter instructions to apply to all selected targets.")
                    : gt("Write in Portuguese. Prefer one concrete next step over a summary.")
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
