/**
 * WorkspaceRail - top-level navigation between Threads and the enabled apps.
 *
 * Rendered outside `AppSidebarLayout` so each workspace keeps its own sidebar.
 * Switching workspaces is routing and nothing else: thread stores, panel
 * stores, and selection state are deliberately untouched, which is what lets
 * the active thread survive a trip to an app and back.
 *
 * Entries come from the client app registry filtered by this environment's
 * `enabledApps`, so adding an app puts a button here with no change to this
 * file.
 *
 * @module WorkspaceRail
 */
import { Link, useLocation } from "@tanstack/react-router";
import { MessagesSquareIcon, type LucideIcon } from "lucide-react";
import { useEffect } from "react";

import { clientAppHref } from "../apps/registry";
import { useEnabledApps } from "../apps/useApps";
import {
  MACOS_TRAFFIC_LIGHTS_TOP_INSET,
  useMacosWindowControlsOverlay,
} from "../hooks/useMacosWindowControls";
import { cn } from "../lib/utils";
import {
  isAppWorkspacePath,
  rememberThreadsPath,
  resolveThreadsHref,
  THREADS_WORKSPACE_ROOT,
} from "./WorkspaceRail.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Rail width, shared with the app shell.
 *
 * The shell publishes this as `--workspace-rail-width` so window-chrome insets
 * measured from the window edge can subtract it; keeping both in one constant
 * stops them drifting apart.
 */
export const WORKSPACE_RAIL_WIDTH = "48px";

export { isAppWorkspacePath } from "./WorkspaceRail.logic";

export function WorkspaceRail() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const apps = useEnabledApps();
  const inApp = isAppWorkspacePath(pathname);
  // The desktop shell draws close/minimize/zoom over the top-left, which is
  // exactly where this rail starts. Without the offset the first icon sits
  // under them and cannot be clicked at all.
  const hasMacosWindowControls = useMacosWindowControlsOverlay();

  // Recorded on every Threads-workspace route so the button can come back to
  // the thread that was open rather than the new-thread starter at "/".
  useEffect(() => {
    rememberThreadsPath(pathname);
  }, [pathname]);

  const threadsHref = resolveThreadsHref(pathname);

  // One shared shape for the Threads button and every app button. Threads is not
  // an app -- it has no store, no RPC namespace, and cannot be disabled -- but it
  // is a rail entry, and giving it a second render path is how the two drift.
  //
  // `emoji` is the fallback for user apps, which have no compiled icon
  // component. An app with neither falls back to the first letter of its name,
  // so a manifest with no icon still produces a distinguishable button rather
  // than an empty square.
  const entries = [
    {
      key: "threads",
      label: "Threads",
      icon: MessagesSquareIcon as LucideIcon | undefined,
      emoji: undefined as string | undefined,
      to: threadsHref,
      isActive: !inApp,
    },
    ...apps.map((app) => ({
      key: app.id,
      label: app.label,
      icon: app.icon,
      emoji: app.emoji,
      to: clientAppHref(app),
      isActive: inApp && pathname.startsWith(clientAppHref(app)),
    })),
  ];

  return (
    <nav
      aria-label="Workspaces"
      style={hasMacosWindowControls ? { paddingTop: MACOS_TRAFFIC_LIGHTS_TOP_INSET } : undefined}
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border/60 bg-sidebar/40 py-2"
    >
      {entries.map((entry) => {
        const Icon = entry.icon;
        const glyph = entry.emoji ?? entry.label.slice(0, 1).toUpperCase();
        return (
          <Tooltip key={entry.key}>
            <TooltipTrigger
              render={
                <Link
                  to={entry.to || THREADS_WORKSPACE_ROOT}
                  aria-label={entry.label}
                  aria-current={entry.isActive ? "page" : undefined}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    // Active state is a visible background, not only colour --
                    // a colour-only cue is easy to miss and fails for anyone
                    // who cannot distinguish the two shades.
                    entry.isActive && "bg-accent text-accent-foreground",
                  )}
                >
                  {Icon ? (
                    <Icon className="size-[18px]" />
                  ) : (
                    <span aria-hidden className="text-sm leading-none">
                      {glyph}
                    </span>
                  )}
                </Link>
              }
            />
            <TooltipPopup side="right">{entry.label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </nav>
  );
}
