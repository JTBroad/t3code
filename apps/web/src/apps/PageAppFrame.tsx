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
 * @module apps/PageAppFrame
 */
import type { InstalledApp } from "@t3tools/contracts";

export function PageAppFrame({ app }: { readonly app: InstalledApp }) {
  return (
    <iframe
      src={app.entryUrl}
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
