import { isDesktop } from "../platform.ts";
import type { AppMode } from "../appMode.ts";

/**
 * Bridge to the native window-mode transition (Phase 15.2).
 *
 * The transition itself is one atomic Rust command (`set_window_mode`), which
 * owns every native detail: size, position, always-on-top, click-through and
 * focus. Keeping it atomic on the native side means the window can never be
 * observed halfway between profiles (e.g. interactive but still
 * always-on-top), and the frontend stays declarative: it asks for a mode and
 * learns whether the window actually adopted it.
 *
 * Loaded lazily like the other desktop bridges; a no-op outside the desktop
 * shell. The boolean result is the whole contract — the caller switches its
 * scene mode only when the window truly followed.
 */
let core: Promise<typeof import("@tauri-apps/api/core") | null> | undefined;

function loadCore() {
  if (!core) {
    core = import("@tauri-apps/api/core").catch(() => null);
  }
  return core;
}

/**
 * Asks the native layer to adopt the window profile for `mode`.
 *
 * `gardenSize` is required only when entering the garden (the desktop profile
 * re-reads the work area natively). Returns `false` — never throws — when the
 * transition could not be performed, so a failed call leaves the app fully in
 * its previous mode rather than half-switched.
 */
export async function applyWindowMode(
  mode: AppMode,
  gardenSize?: { width: number; height: number },
): Promise<boolean> {
  if (!isDesktop) return false;
  try {
    const api = await loadCore();
    if (!api) return false;
    await api.invoke("set_window_mode", {
      mode,
      gardenWidth: gardenSize?.width ?? 0,
      gardenHeight: gardenSize?.height ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}
