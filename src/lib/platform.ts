declare global {
  interface Window {
    /**
     * Injected by the Tauri webview before the app boots. Presence of this
     * marker is what distinguishes the desktop shell from a plain browser.
     */
    __TAURI_INTERNALS__?: unknown;
  }
}

/**
 * True when the app is running inside the Tauri desktop window.
 *
 * Detection is done at runtime rather than through a separate build, so one
 * compiled bundle serves both the browser experience and the desktop shell
 * and neither needs environment-specific configuration.
 */
export const isDesktop =
  typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

/** Adds the marker class used by the stylesheet for desktop-only styling. */
export function markPlatform(root: HTMLElement) {
  if (!isDesktop) return;
  root.classList.add("is-desktop");
  // `body` paints its own background, so it needs the marker as well. The
  // stylesheet covers both elements; tests can query either.
  document.body?.classList.add("is-desktop");
}
