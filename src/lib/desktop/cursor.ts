import { isDesktop } from "../platform.ts";

/**
 * Global cursor source for the desktop overlay.
 *
 * The overlay is click-through most of the time, so WebView DOM events can
 * never be the cursor source: this polls the OS-level position instead.
 * Tauri's `cursorPosition` is desktop-relative (physical pixels, origin at
 * the desktop's top-left corner) and works regardless of the window's
 * hit-test state — so the butterfly can react to the mouse anywhere on the
 * actual desktop, not just over the app.
 */

export interface CursorSample {
  /** Physical desktop pixels (see `desktop/geometry.ts` for conversion). */
  x: number;
  y: number;
}

/**
 * Polls the global cursor at `intervalMs` and invokes `onCursor` with each
 * sample. Returns a stop function. Outside the desktop shell (or without a
 * reachable Tauri API, e.g. the dev harness) this is a no-op.
 */
export function startCursorPolling(
  onCursor: (sample: CursorSample) => void,
  intervalMs = 33,
): () => void {
  if (!isDesktop) return () => {};

  let stopped = false;
  let inFlight = false;
  let api: Promise<typeof import("@tauri-apps/api/window") | null> | undefined;
  const load = () => (api ??= import("@tauri-apps/api/window").catch(() => null));

  const timer = setInterval(() => {
    if (inFlight) return; // never stack IPC round-trips
    inFlight = true;
    void load()
      .then((module) => (module ? module.cursorPosition() : null))
      .then((position) => {
        if (!stopped && position) onCursor({ x: position.x, y: position.y });
      })
      .catch(() => {
        // Permission denied or runtime gone: keep polling, stay silent.
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
