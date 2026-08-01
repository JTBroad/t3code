/**
 * Tracks whether the macOS traffic lights are overlaying the client area.
 *
 * On macOS the desktop shell draws close/minimize/zoom over the top-left of the
 * page, so anything rendered there is unreachable. In fullscreen the controls
 * are hidden and the inset must go away again, which is why this subscribes
 * rather than reading once.
 *
 * @module useMacosWindowControls
 */
import { useEffect, useState } from "react";

import { isElectron } from "../env";
import { isMacPlatform } from "../lib/utils";

/** Clearance the traffic lights need, measured from the window's left edge. */
export const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "90px";

/**
 * Vertical clearance for a control rendered flush to the top-left.
 *
 * The traffic lights are vertically centred in the title bar strip, so a
 * full-strip offset is what clears them.
 */
export const MACOS_TRAFFIC_LIGHTS_TOP_INSET = "var(--workspace-topbar-height)";

export function useMacosWindowControlsOverlay(): boolean {
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

  return isMacosDesktop && !isWindowFullscreen;
}
