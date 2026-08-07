import { APP_ID_MEMORY, appWorkspaceRoot } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy Memory route.
 *
 * Memory shipped at `/memory` before app workspaces existed, so this path is in
 * users' history, bookmarks, and any link they shared. It redirects rather than
 * rendering so there is exactly one canonical URL per app.
 */
export const Route = createFileRoute("/memory")({
  beforeLoad: () => {
    throw redirect({ to: appWorkspaceRoot(APP_ID_MEMORY), replace: true });
  },
});
