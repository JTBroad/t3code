/**
 * CopilotAdapter — shape type for the GitHub Copilot provider adapter.
 *
 * Mirrors the other per-driver shape modules (`OpenCodeAdapter`,
 * `GrokAdapter`, …): the driver model bundles one adapter per instance as
 * a captured closure, so there is no Context tag — the shape interface is
 * retained purely as a naming anchor for the driver bundle.
 *
 * @module CopilotAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * CopilotAdapterShape — per-instance GitHub Copilot adapter contract.
 */
export interface CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
