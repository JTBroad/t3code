/**
 * WorkspaceRail - top-level navigation between Threads and Memory.
 *
 * Rendered outside `AppSidebarLayout` so each workspace keeps its own sidebar.
 * Switching workspaces is routing and nothing else: thread stores, panel
 * stores, and selection state are deliberately untouched, which is what lets
 * the active thread survive a trip to Memory and back.
 *
 * @module WorkspaceRail
 */
import { Link, useLocation } from "@tanstack/react-router";
import { BrainIcon, MessagesSquareIcon, type LucideIcon } from "lucide-react";

import {
  MACOS_TRAFFIC_LIGHTS_TOP_INSET,
  useMacosWindowControlsOverlay,
} from "../hooks/useMacosWindowControls";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Rail width, shared with the app shell.
 *
 * The shell publishes this as `--workspace-rail-width` so window-chrome insets
 * measured from the window edge can subtract it; keeping both in one constant
 * stops them drifting apart.
 */
export const WORKSPACE_RAIL_WIDTH = "48px";

interface WorkspaceRailEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

const WORKSPACES: ReadonlyArray<WorkspaceRailEntry> = [
  { to: "/", label: "Threads", icon: MessagesSquareIcon },
  { to: "/memory", label: "Memory", icon: BrainIcon },
];

/** Threads owns every route that is not Memory, including settings. */
export function isMemoryWorkspacePath(pathname: string): boolean {
  return pathname === "/memory" || pathname.startsWith("/memory/");
}

export function WorkspaceRail() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const memoryActive = isMemoryWorkspacePath(pathname);
  // The desktop shell draws close/minimize/zoom over the top-left, which is
  // exactly where this rail starts. Without the offset the first icon sits
  // under them and cannot be clicked at all.
  const hasMacosWindowControls = useMacosWindowControlsOverlay();

  return (
    <nav
      aria-label="Workspaces"
      style={hasMacosWindowControls ? { paddingTop: MACOS_TRAFFIC_LIGHTS_TOP_INSET } : undefined}
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border/60 bg-sidebar/40 py-2"
    >
      {WORKSPACES.map((workspace) => {
        const isActive = workspace.to === "/memory" ? memoryActive : !memoryActive;
        const Icon = workspace.icon;
        return (
          <Tooltip key={workspace.to}>
            <TooltipTrigger
              render={
                <Link
                  to={workspace.to}
                  aria-label={workspace.label}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    // Active state is a visible background, not only colour --
                    // a colour-only cue is easy to miss and fails for anyone
                    // who cannot distinguish the two shades.
                    isActive && "bg-accent text-accent-foreground",
                  )}
                >
                  <Icon className="size-[18px]" />
                </Link>
              }
            />
            <TooltipPopup side="right">{workspace.label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </nav>
  );
}
