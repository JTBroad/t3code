import { createFileRoute, redirect } from "@tanstack/react-router";

import { findClientApp } from "../apps/registry";

/**
 * One route for every app workspace.
 *
 * Registry lookup rather than a file per app: a user-authored app will not have
 * a route file to add, so the shell has to be able to mount an app it did not
 * know about at build time.
 *
 * An unknown or disabled app id redirects to the thread list instead of
 * rendering a not-found. A stale bookmark or a link from another environment is
 * the normal way to arrive at one, and dropping someone on an error page for it
 * is worse than putting them somewhere useful.
 */
function AppWorkspaceRoute() {
  const { appId } = Route.useParams();
  const app = findClientApp(appId);
  if (app === null) {
    return null;
  }
  const Component = app.component;
  return <Component />;
}

export const Route = createFileRoute("/apps/$appId")({
  beforeLoad: ({ params }) => {
    if (findClientApp(params.appId) === null) {
      throw redirect({ to: "/" });
    }
  },
  component: AppWorkspaceRoute,
});
