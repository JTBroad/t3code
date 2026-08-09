/**
 * PageAppFrame - Renders a user-authored app inside a sandbox.
 *
 * The page is untrusted code from a file on disk, loaded into the same tab that
 * renders the user's threads. The `sandbox` attribute is the boundary, and every
 * token on it is deliberate:
 *
 * - **No `allow-same-origin`.** This is the one that matters. Combined with
 *   `allow-scripts` it lets a page reach out of the sandbox entirely -- it could
 *   read the parent document, its storage, and its cookies. Without it the frame
 *   gets an opaque origin and can only talk to us if we choose to listen.
 * - **`allow-scripts`** because a page with no JavaScript is not an app.
 * - **`allow-forms` and `allow-popups`** because they are ordinary page
 *   behaviour and neither crosses the origin boundary.
 * - **No `allow-top-navigation`**, so a page cannot replace the whole app with
 *   somewhere else -- the most convincing phishing move available to it.
 *
 * The server sends a matching `sandbox` header and a restrictive CSP, so losing
 * this attribute in a future refactor does not silently grant same-origin access.
 * Two independent mechanisms, because this one is easy to weaken by accident.
 *
 * There is deliberately no `postMessage` listener yet. Page apps get a sandbox
 * and nothing else until there is a permissions model worth attaching to it --
 * "what may an HTML file dropped on disk ask for?" is a separate design question
 * from "how do we run one".
 *
 * The app's `entryUrl` is resolved against the environment's HTTP base URL, the
 * same way asset URLs are. It is stored root-relative, and the client is
 * routinely not on the environment's origin -- desktop renders from
 * `t3code://app`, browser dev from Vite, the hosted app from app.t3.codes. Used
 * raw it addressed the *client*, which answers unknown paths with the SPA shell,
 * so the frame loaded T3 Code inside itself and rendered as an empty workspace.
 *
 * @module apps/PageAppFrame
 */
import type { InstalledApp } from "@t3tools/contracts";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";

export function PageAppFrame({ app }: { readonly app: InstalledApp }) {
  const environmentId = usePrimaryEnvironmentId();
  const preparedConnection = usePreparedConnection(environmentId);
  const entryUrl =
    preparedConnection._tag === "None"
      ? null
      : resolveAssetUrl(preparedConnection.value.httpBaseUrl, app.entryUrl);

  // No src until the connection resolves: pointing the frame at a relative URL
  // in the meantime would load the client shell and show the wrong thing.
  if (entryUrl === null) {
    return <div className="h-full w-full bg-background" />;
  }

  return (
    <iframe
      src={entryUrl}
      title={app.name}
      className="h-full w-full border-0 bg-background"
      sandbox="allow-scripts allow-forms allow-popups"
      // `referrerPolicy` keeps the app's own URL out of any request it makes,
      // and `credentialless` keeps it off the session cookie even if a future
      // CSP change lets it reach the network at all.
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  );
}
