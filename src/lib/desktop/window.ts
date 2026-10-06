import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { isDesktop } from "../platform.ts";

/**
 * Thin, typed bridge to the Tauri window API.
 *
 * The module is loaded lazily so the browser bundle never pays for it and a
 * web session never touches Tauri internals. Every export is a no-op outside
 * the desktop shell, so call sites need no platform checks of their own.
 *
 * Only what a phase actually needs is wrapped here; window features are added
 * to this bridge as they are adopted, never sprinkled through the scene.
 */

let api: Promise<TauriWindow | null> | undefined;

function load(): Promise<TauriWindow | null> {
  if (!api) {
    api = import("@tauri-apps/api/window")
      .then((module) => module.getCurrentWindow())
      // Not running under Tauri, or the API could not be reached at all.
      .catch(() => null);
  }
  return api;
}

/** Warms the import so the first drag does not wait for it. */
export function preloadWindowApi(): void {
  if (isDesktop) void load();
}

/**
 * Hands the window to the operating system's move loop: it follows the cursor
 * until the button is released, and the webview receives no further pointer
 * events for that gesture.
 *
 * Requires `core:window:allow-start-dragging`; if the capability is missing
 * the promise rejects and dragging simply does nothing.
 */
export async function startDragging(): Promise<void> {
  if (!isDesktop) return;
  try {
    await load()?.then((window) => window?.startDragging());
  } catch {
    // Denied by the capability list: the window just stays put.
  }
}

/**
 * Toggles click-through for the whole overlay window (desktop only).
 *
 * The native layer starts the overlay click-through; the hit-test zone
 * (`desktop/hittest.ts`) calls this only on state transitions, so the IPC
 * cost is one call per enter/leave, never per frame.
 *
 * Requires `core:window:allow-set-ignore-cursor-events`; if the capability
 * is missing the overlay simply keeps its current hit-test state.
 */
export async function setIgnoreCursorEvents(ignore: boolean): Promise<void> {
  if (!isDesktop) return;
  try {
    await load()?.then((window) => window?.setIgnoreCursorEvents(ignore));
  } catch {
    // Denied by the capability list: the hit-test state stays as it is.
  }
}
