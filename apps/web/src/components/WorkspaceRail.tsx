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
import { appWorkspaceRoot, type ContextMenuItem } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, type MouseEvent as ReactMouseEvent } from "react";

import { clientAppHref } from "../apps/registry";
import { useEnabledApps } from "../apps/useApps";
import { useUninstallApp } from "../apps/useUninstallApp";
import { readLocalApi } from "../localApi";
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
  const navigate = useNavigate();
  const { uninstall } = useUninstallApp();

  /**
   * Right-click to remove a user app.
   *
   * On the rail rather than in a settings page because this is where the app
   * is: a button someone added by clicking is one they should be able to
   * remove by clicking on it. Page apps only -- a built-in has no directory to
   * delete, and its rail entry is governed by `enabledApps`.
   *
   * Confirmed before it runs, since removal deletes the app's directory and the
   * page came from a thread that may be long gone.
   */
  const handleAppContextMenu = useCallback(
    (event: ReactMouseEvent, app: { readonly id: string; readonly label: string }) => {
      const api = readLocalApi();
      if (!api) return;
      event.preventDefault();
      event.stopPropagation();
      const items: ContextMenuItem<"remove-app">[] = [
        { id: "remove-app", label: "Remove from sidebar", icon: "trash", destructive: true },
      ];
      void api.contextMenu
        .show(items, { x: event.clientX, y: event.clientY })
        .then(async (action) => {
          if (action !== "remove-app") return;
          const confirmed = await api.dialogs.confirm(
            `Remove "${app.label}" from the sidebar? This deletes the installed app's files.`,
          );
          if (!confirmed) return;
          const removed = await uninstall(app.id);
          // Leaving the route mounted would strand the user on an app that no
          // longer exists, which renders as the "isn't available" placeholder.
          if (removed && pathname.startsWith(appWorkspaceRoot(app.id))) {
            void navigate({ to: threadsHref || THREADS_WORKSPACE_ROOT });
          }
        });
    },
    [navigate, pathname, threadsHref, uninstall],
  );

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
      isRemovable: false,
    },
    ...apps.map((app) => ({
      key: app.id,
      label: app.label,
      icon: app.icon,
      emoji: app.emoji,
      to: clientAppHref(app),
      isActive: inApp && pathname.startsWith(clientAppHref(app)),
      isRemovable: app.kind === "page",
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
                  onContextMenu={
                    entry.isRemovable
                      ? (event) =>
                          handleAppContextMenu(event, { id: entry.key, label: entry.label })
                      : undefined
                  }
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
            <TooltipPopup side="right">
              {entry.label}
              {entry.isRemovable ? (
                <span className="ml-1.5 opacity-60">right-click to remove</span>
              ) : null}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </nav>
  );
}
