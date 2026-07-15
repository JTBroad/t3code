import { cn } from "~/lib/utils";
import {
  type ProviderQuotaSnapshot,
  formatQuotaPercentage,
  formatQuotaResetDate,
} from "~/lib/providerQuota";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * Compact premium-request quota readout shown next to the context-window
 * meter. Displays the remaining entitlement as `xx.x%`; details (used /
 * entitlement, overage, reset date) live in the hover popover.
 */
export function ProviderQuotaMeter(props: {
  quota: ProviderQuotaSnapshot;
  providerDisplayName?: string | null;
}) {
  const { quota, providerDisplayName } = props;
  const label = quota.isUnlimited ? "∞" : formatQuotaPercentage(quota.remainingPercentage);
  const isLow = !quota.isUnlimited && quota.remainingPercentage <= 10;
  const resetLabel = formatQuotaResetDate(quota.resetDate);
  const showCounts =
    quota.usedRequests !== null && quota.entitlementRequests !== null && !quota.isUnlimited;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-6 cursor-pointer items-center justify-center rounded-full border border-transparent px-1.5 text-[11px] tabular-nums outline-none transition-colors",
              isLow ? "text-red-500" : "text-muted-foreground",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={
              quota.isUnlimited
                ? "Premium requests: unlimited"
                : `Premium requests: ${label} remaining`
            }
          >
            {label}
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-64 max-w-none p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Premium Requests</div>
            <div className="text-[11px] tabular-nums text-muted-foreground/70">
              {quota.isUnlimited ? "Unlimited" : `${label} left`}
            </div>
          </div>
          {!quota.isUnlimited ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(quota.remainingPercentage)}
              aria-label="Premium requests remaining"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{
                  width: `${quota.remainingPercentage}%`,
                  backgroundColor: isLow ? "var(--color-red-500)" : "var(--color-blue-500)",
                }}
              />
            </div>
          ) : null}
          {showCounts ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-muted-foreground/60">Used</span>
              <span className="font-medium tabular-nums text-muted-foreground/80">
                {Math.round(quota.usedRequests ?? 0)}/{Math.round(quota.entitlementRequests ?? 0)}
              </span>
            </div>
          ) : null}
          {quota.overage !== null && quota.overage > 0 ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-muted-foreground/60">Overage</span>
              <span className="font-medium tabular-nums text-muted-foreground/80">
                {Math.round(quota.overage)}
              </span>
            </div>
          ) : null}
          {resetLabel ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-muted-foreground/60">Resets</span>
              <span className="font-medium tabular-nums text-muted-foreground/80">
                {resetLabel}
              </span>
            </div>
          ) : null}
          <div className="mt-1 text-pretty text-[11px] font-medium text-muted-foreground/70">
            {providerDisplayName ?? "Provider"} premium request quota for your account.
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
