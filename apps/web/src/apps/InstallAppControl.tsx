/**
 * InstallAppControl - "Add to sidebar", on an HTML drive artifact.
 *
 * This button is the security boundary for user apps. The drive is written by a
 * tool the model can call on any turn, so nothing on disk becomes runnable UI
 * until a person clicks here. That makes what it *shows* part of the boundary,
 * not decoration: the file being installed, the thread it came from, and what
 * the app will and will not be able to do. A one-click "Add to sidebar" that
 * reveals none of that is the same escalation with an extra step.
 *
 * The name is typed by the user rather than taken from the artifact or the
 * model, because it becomes the rail label -- an app that could name itself
 * could impersonate a built-in.
 *
 * @module apps/InstallAppControl
 */
import { isInstallableArtifactPath } from "@t3tools/contracts";
import { useState } from "react";

import { useInstallApp } from "./useInstallApp";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";

/** Strip directories and the extension, so `out/foliage.html` suggests "foliage". */
function suggestName(relativePath: string): string {
  const base = relativePath.split("/").pop() ?? relativePath;
  return base
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .slice(0, 64);
}

export function InstallAppControl({
  artifact,
}: {
  readonly artifact: {
    readonly id: string;
    readonly relativePath: string;
    readonly threadId: string | null;
  };
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(() => suggestName(artifact.relativePath));
  const { install, isInstalling, error } = useInstallApp();

  // Only HTML is installable, and the check mirrors the server's. A button that
  // appears and then fails is worse than no button.
  if (!isInstallableArtifactPath(artifact.relativePath)) {
    return null;
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add to sidebar
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-md">
          <DialogTitle>Add to sidebar</DialogTitle>
          <DialogDescription>
            This adds the page as an app in your workspace rail.
          </DialogDescription>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="install-name">
                Name
              </label>
              <Input
                id="install-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={64}
                placeholder="Fall foliage map"
              />
            </div>

            {/* What is actually being installed, and where it came from. */}
            <dl className="flex flex-col gap-1 rounded-md border border-border/60 p-3 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">File</dt>
                <dd className="truncate font-mono">{artifact.relativePath}</dd>
              </div>
              {artifact.threadId ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">From thread</dt>
                  <dd className="truncate font-mono">{artifact.threadId}</dd>
                </div>
              ) : null}
            </dl>

            {/* Stated plainly rather than assumed. Someone deciding whether to
                trust a generated page needs to know what it can reach. */}
            <p className="text-xs text-muted-foreground">
              The page runs sandboxed: it cannot reach the network, read your threads or notes, or
              see anything else in this app.
            </p>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>
              Cancel
            </DialogClose>
            <Button
              type="button"
              size="sm"
              disabled={isInstalling || name.trim().length === 0}
              onClick={() => {
                void install({ artifactId: artifact.id, name: name.trim() }).then((ok) => {
                  if (ok) setOpen(false);
                });
              }}
            >
              {isInstalling ? "Adding…" : "Add to sidebar"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
