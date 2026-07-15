import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Latest premium-request quota snapshot for the thread's provider account
 * (currently emitted by the Copilot adapter via `provider-quota.updated`
 * activities; the payload mirrors the Copilot SDK's `AccountQuotaSnapshot`).
 */
export type ProviderQuotaSnapshot = {
  /** Percentage of the premium-request entitlement remaining (0-100). */
  readonly remainingPercentage: number;
  readonly usedRequests: number | null;
  readonly entitlementRequests: number | null;
  readonly overage: number | null;
  readonly isUnlimited: boolean;
  /** ISO 8601 date when the quota resets, if known. */
  readonly resetDate: string | null;
  readonly updatedAt: string;
};

export function deriveLatestProviderQuotaSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderQuotaSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "provider-quota.updated") {
      continue;
    }

    const snapshots = asRecord(activity.payload);
    const premium = asRecord(snapshots?.premium_interactions);
    if (!premium) {
      continue;
    }

    const isUnlimited = premium.isUnlimitedEntitlement === true;
    const remainingPercentage = asFiniteNumber(premium.remainingPercentage);
    if (remainingPercentage === null && !isUnlimited) {
      continue;
    }

    return {
      remainingPercentage: Math.max(0, Math.min(100, remainingPercentage ?? 100)),
      usedRequests: asFiniteNumber(premium.usedRequests),
      entitlementRequests: asFiniteNumber(premium.entitlementRequests),
      overage: asFiniteNumber(premium.overage),
      isUnlimited,
      resetDate: typeof premium.resetDate === "string" ? premium.resetDate : null,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

/** Format a remaining-quota percentage as `xx.x%` (one decimal place). */
export function formatQuotaPercentage(value: number): string {
  return `${value.toFixed(1)}%`;
}

/** Human-readable reset date, e.g. "Aug 1". Returns null when unparsable. */
export function formatQuotaResetDate(resetDate: string | null): string | null {
  if (!resetDate) {
    return null;
  }
  const parsed = new Date(resetDate);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
