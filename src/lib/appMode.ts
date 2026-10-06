/**
 * The application's two window modes (Phase 15.2).
 *
 * `desktop` is the default and the core experience: the transparent,
 * always-on-top overlay where the butterfly lives over the real desktop.
 * `garden` is a temporary, windowed, interactive presentation of the same
 * companion — a place to visit, never a replacement.
 *
 * This module is the single vocabulary for the distinction. It imports
 * nothing and knows nothing about React, Tauri or the scene, so every layer
 * can share one definition and the architecture checks can pin its purity.
 * What a mode *does* to the window lives in `desktop/mode.ts` and the native
 * `set_window_mode` command; which subsystems a mode *runs* is described
 * here, as data.
 */

export const APP_MODES = ["desktop", "garden"] as const;
export type AppMode = (typeof APP_MODES)[number];

/** The application always launches as the desktop companion. */
export const DEFAULT_APP_MODE: AppMode = "desktop";

/**
 * Validates a mode string coming from a boundary (event payload, native
 * result). Unknown values are rejected rather than coerced.
 */
export function isAppMode(value: unknown): value is AppMode {
  return typeof value === "string" && (APP_MODES as readonly string[]).includes(value);
}

/**
 * Which desktop-overlay subsystems run in a mode.
 *
 * All four belong to the overlay's way of being present on a desktop:
 * polling the global cursor, toggling click-through around the butterfly,
 * keeping the environment facts fresh, and tracking the foreground window.
 * None of them means anything inside a windowed garden — in garden mode the
 * window receives ordinary DOM input instead — so they are all off there,
 * and all resume when the overlay is restored.
 */
export interface DesktopSystems {
  cursorPolling: boolean;
  hitTesting: boolean;
  environmentRefresh: boolean;
  foregroundAwareness: boolean;
}

export function desktopSystemsActive(mode: AppMode): DesktopSystems {
  const active = mode === "desktop";
  return {
    cursorPolling: active,
    hitTesting: active,
    environmentRefresh: active,
    foregroundAwareness: active,
  };
}
