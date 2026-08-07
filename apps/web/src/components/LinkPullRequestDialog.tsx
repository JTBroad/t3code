import type { EnvironmentId, GitResolvedPullRequest } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  readCachedPullRequestResolution,
  usePullRequestResolution,
} from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

interface LinkPullRequestDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  /** Repo the reference resolves against — the thread's worktree when it has
      one, else the project root. Stored on the link so refreshes ask the same
      repo the user linked from. */
  cwd: string | null;
  /** Number of the PR already linked, shown so a re-link is obviously a
      replacement rather than an addition. */
  currentNumber: number | null;
  onOpenChange: (open: boolean) => void;
  onLink: (pullRequest: GitResolvedPullRequest) => Promise<void> | void;
}

/**
 * Attach a specific PR to a thread.
 *
 * Deliberately does NOT touch the working tree: unlike PullRequestThreadDialog
 * (which checks the PR out), linking only records "this thread is about that
 * PR". The user may be on any branch, or none.
 */
export function LinkPullRequestDialog({
  open,
  environmentId,
  cwd,
  currentNumber,
  onOpenChange,
  onLink,
}: LinkPullRequestDialogProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const { data: gitStatus } = useEnvironmentQuery(
    cwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const terminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;

  // Reopening must not offer the previous attempt's reference or error: the
  // dialog is reused across threads, and a stale value would read as a
  // suggestion for the thread now in front of the user.
  useEffect(() => {
    if (!open) {
      setReference("");
      setReferenceDirty(false);
      setLinkError(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const sourceControlScope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const pullRequestResolution = usePullRequestResolution({
    ...sourceControlScope,
    reference: open ? parsedDebouncedReference : null,
  });
  const cachedPullRequest = useMemo(
    () =>
      readCachedPullRequestResolution({ ...sourceControlScope, reference: parsedReference })
        ?.pullRequest ?? null,
    [parsedReference, sourceControlScope],
  );

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (pullRequestResolution.data?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest ?? cachedPullRequest;
  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      pullRequestResolution.isPending ||
      pullRequestResolution.isFetching);
  const statusTone = useMemo(() => {
    switch (resolvedPullRequest?.state) {
      case "merged":
        return "text-violet-600 dark:text-violet-300/90";
      case "closed":
        return "text-zinc-500 dark:text-zinc-400/80";
      case "open":
        return "text-emerald-600 dark:text-emerald-300/90";
      default:
        return "text-muted-foreground";
    }
  }, [resolvedPullRequest?.state]);

  const handleConfirm = useCallback(async () => {
    if (!parsedReference) {
      setReferenceDirty(true);
      return;
    }
    if (!resolvedPullRequest) {
      return;
    }
    setIsLinking(true);
    setLinkError(null);
    try {
      await onLink(resolvedPullRequest);
      onOpenChange(false);
    } catch (error) {
      setLinkError(
        error instanceof Error ? error.message : `Failed to link ${terminology.singular}.`,
      );
    } finally {
      setIsLinking(false);
    }
  }, [onLink, onOpenChange, parsedReference, resolvedPullRequest, terminology.singular]);

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? `Paste a ${terminology.singular} URL, checkout command, or enter 123 / #123.`
      : parsedReference === null
        ? `Use a ${terminology.singular} URL, checkout command, 123, or #123.`
        : null;
  const errorMessage =
    validationMessage ??
    linkError ??
    (resolvedPullRequest === null && pullRequestResolution.error
      ? pullRequestResolution.error
      : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isLinking) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SourceControlIcon className="size-4" />
            {currentNumber === null ? "Link" : "Change linked"} {terminology.singular}
          </DialogTitle>
          <DialogDescription>
            {currentNumber === null
              ? `Attach a ${terminology.singular} to this thread. Nothing is checked out — this only records which ${terminology.singular} the thread is about.`
              : `Replaces the currently linked ${terminology.singular} #${currentNumber}. Nothing is checked out.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground capitalize">
              {terminology.singular}
            </span>
            <Input
              ref={referenceInputRef}
              placeholder={`${terminology.shortLabel} URL, checkout command, or #42`}
              value={reference}
              onChange={(event) => {
                setReferenceDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                if (!isResolving && !isLinking) {
                  void handleConfirm();
                }
              }}
            />
          </label>

          {resolvedPullRequest ? (
            <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{resolvedPullRequest.title}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} to{" "}
                    {resolvedPullRequest.baseBranch}
                  </p>
                </div>
                <span className={cn("shrink-0 text-xs capitalize", statusTone)}>
                  {resolvedPullRequest.state}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              Resolving {terminology.singular}...
            </div>
          ) : null}

          {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isLinking}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={!cwd || !resolvedPullRequest || isResolving || isLinking}
          >
            {isLinking ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
