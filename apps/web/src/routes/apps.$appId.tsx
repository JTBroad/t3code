import { createFileRoute } from "@tanstack/react-router";

import { PageAppFrame } from "../apps/PageAppFrame";
import { useApp } from "../apps/useApps";

/**
 * One route for every app workspace, built-in or user-authored.
 *
 * Registry lookup rather than a file per app: a user app has no route file to
 * add, so the shell has to mount an app it did not know about at build time.
 *
 * The redirect-on-unknown that guarded this before is gone. User apps arrive
 * over the wire, so "not found" is indistinguishable from "not loaded yet" at
 * the moment `beforeLoad` runs -- bouncing to the thread list would have made a
 * bookmarked app route unusable on a cold start. Unknown ids render an explicit
 * message instead, which also tells someone whose app failed to load what
 * actually happened.
 */
function AppWorkspaceRoute() {
  const { appId } = Route.useParams();
  const app = useApp(appId);

  if (app === null) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div className="max-w-sm space-y-2">
          <p className="text-sm font-medium">This app isn't available</p>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{appId}</span> isn't installed in this environment, or it's
            still loading.
          </p>
        </div>
      </div>
    );
  }

  if (app.kind === "page") {
    return app.installed ? <PageAppFrame app={app.installed} /> : null;
  }

  const Component = app.component;
  return Component ? <Component /> : null;
}

export const Route = createFileRoute("/apps/$appId")({
  component: AppWorkspaceRoute,
});
