/**
 * Copilot custom agents — composer-side descriptor injection.
 *
 * GitHub Copilot custom agents (`.github/agents` in the workspace, plus the
 * user-level agent directory) are discovered per thread cwd through the
 * `providers.listAgents` RPC. The composer merges them into the selected
 * copilot model's option descriptors as an `"agent"` select, which the
 * existing traits controls render as an Agent dropdown next to Reasoning.
 * The selection then flows through `modelSelection.options` to the copilot
 * adapter untouched.
 */
import type {
  ProviderCustomAgent,
  ProviderDriverKind,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";

export const COPILOT_PROVIDER_KIND = "copilot";

/**
 * Sentinel option representing "no custom agent" (the built-in default
 * agent). Mirrors `COPILOT_DEFAULT_AGENT_OPTION` on the server adapter.
 */
export const COPILOT_DEFAULT_AGENT_OPTION_ID = "default";

export function isCopilotProvider(provider: ProviderDriverKind | null | undefined): boolean {
  return provider === COPILOT_PROVIDER_KIND;
}

export function buildCopilotAgentDescriptor(
  agents: ReadonlyArray<ProviderCustomAgent>,
): SelectProviderOptionDescriptor {
  return {
    id: "agent",
    label: "Agent",
    type: "select",
    options: [
      { id: COPILOT_DEFAULT_AGENT_OPTION_ID, label: "Default", isDefault: true },
      ...agents.map((agent) => ({
        id: agent.name,
        label: agent.displayName,
        ...(agent.description !== undefined && agent.description.trim().length > 0
          ? { description: agent.description.trim() }
          : {}),
      })),
    ],
  };
}

/**
 * Return `models` with the `"agent"` select descriptor appended to every
 * model's capabilities. Appending (not prepending) keeps the reasoning
 * descriptor first, so effort-derived UI state is unaffected.
 *
 * Returns the input array unchanged when the provider is not copilot, no
 * agents were discovered, or a model already carries an agent descriptor.
 */
export function withCopilotAgentDescriptor(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  agents: ReadonlyArray<ProviderCustomAgent> | undefined;
}): ReadonlyArray<ServerProviderModel> {
  const { provider, models, agents } = input;
  if (!isCopilotProvider(provider) || agents === undefined || agents.length === 0) {
    return models;
  }
  const agentDescriptor = buildCopilotAgentDescriptor(agents);
  return models.map((model) => {
    const existing = model.capabilities?.optionDescriptors ?? [];
    if (existing.some((descriptor) => descriptor.id === agentDescriptor.id)) {
      return model;
    }
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: [...existing, agentDescriptor],
      },
    };
  });
}
