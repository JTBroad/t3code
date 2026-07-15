import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveLatestProviderQuotaSnapshot,
  formatQuotaPercentage,
  formatQuotaResetDate,
} from "./providerQuota";

function quotaActivity(
  payload: unknown,
  overrides: Partial<Record<keyof OrchestrationThreadActivity, unknown>> = {},
): OrchestrationThreadActivity {
  return {
    id: "event-1",
    tone: "info",
    kind: "provider-quota.updated",
    summary: "Provider quota updated",
    payload,
    turnId: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  } as OrchestrationThreadActivity;
}

describe("deriveLatestProviderQuotaSnapshot", () => {
  it("returns null when no quota activities exist", () => {
    expect(deriveLatestProviderQuotaSnapshot([])).toBeNull();
  });

  it("derives the premium interactions snapshot", () => {
    const snapshot = deriveLatestProviderQuotaSnapshot([
      quotaActivity({
        premium_interactions: {
          isUnlimitedEntitlement: false,
          entitlementRequests: 300,
          usedRequests: 142,
          remainingPercentage: 52.7,
          overage: 0,
          resetDate: "2026-08-01",
        },
      }),
    ]);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.remainingPercentage).toBe(52.7);
    expect(snapshot?.usedRequests).toBe(142);
    expect(snapshot?.entitlementRequests).toBe(300);
    expect(snapshot?.isUnlimited).toBe(false);
    expect(snapshot?.resetDate).toBe("2026-08-01");
  });

  it("uses the most recent quota activity", () => {
    const snapshot = deriveLatestProviderQuotaSnapshot([
      quotaActivity({ premium_interactions: { remainingPercentage: 80 } }, { id: "event-1" }),
      quotaActivity({ premium_interactions: { remainingPercentage: 60.5 } }, { id: "event-2" }),
    ]);
    expect(snapshot?.remainingPercentage).toBe(60.5);
  });

  it("clamps remaining percentage to 0-100", () => {
    const snapshot = deriveLatestProviderQuotaSnapshot([
      quotaActivity({ premium_interactions: { remainingPercentage: -5 } }),
    ]);
    expect(snapshot?.remainingPercentage).toBe(0);
  });

  it("supports unlimited entitlements without a percentage", () => {
    const snapshot = deriveLatestProviderQuotaSnapshot([
      quotaActivity({ premium_interactions: { isUnlimitedEntitlement: true } }),
    ]);
    expect(snapshot?.isUnlimited).toBe(true);
    expect(snapshot?.remainingPercentage).toBe(100);
  });

  it("skips malformed payloads", () => {
    const snapshot = deriveLatestProviderQuotaSnapshot([
      quotaActivity({ premium_interactions: { remainingPercentage: 42 } }, { id: "event-1" }),
      quotaActivity("garbage", { id: "event-2" }),
    ]);
    expect(snapshot?.remainingPercentage).toBe(42);
  });
});

describe("formatQuotaPercentage", () => {
  it("formats to one decimal place", () => {
    expect(formatQuotaPercentage(52.74)).toBe("52.7%");
    expect(formatQuotaPercentage(100)).toBe("100.0%");
    expect(formatQuotaPercentage(0)).toBe("0.0%");
  });
});

describe("formatQuotaResetDate", () => {
  it("returns null for missing or invalid dates", () => {
    expect(formatQuotaResetDate(null)).toBeNull();
    expect(formatQuotaResetDate("not-a-date")).toBeNull();
  });

  it("formats a valid date", () => {
    expect(formatQuotaResetDate("2026-08-01T12:00:00")).toMatch(/Aug/);
  });
});
