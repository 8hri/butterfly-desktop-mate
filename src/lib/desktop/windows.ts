import type { LogicalRect } from "./environment.ts";
import { isDesktop } from "../platform.ts";

/**
 * Desktop window facts — Phase 13B.1.
 *
 * One fact, and only one: *which external application window currently has
 * focus, and where is it on the desktop*. Nothing here moves the butterfly,
 * changes personality, touches animation or interaction, or chooses a
 * destination. Interpretation belongs to `awareness.ts` (13B.2), refreshing to
 * 13B.3; this module is the source the rest of the environment layer will read.
 *
 * Deliberately **not** here, and not coming later without a decision of its
 * own: window enumeration, titles, window classes, z-order, occlusion, the
 * taskbar, per-window DPI, or any notion of a landing surface. The overlay is
 * transparent, so nothing here can say what is *painted* underneath it — a
 * window rectangle is geometry, never proof of visibility.
 *
 * Coordinates: the native side reports Win32 **physical** desktop pixels in
 * virtual-desktop space (so `x`/`y` may be negative). The conversion to the
 * project's single logical-desktop space happens here, once, using the scale
 * factor the environment snapshot already carries — the same physical→logical
 * division `desktop/geometry.ts` performs for the cursor, applied at exactly
 * one place so a third DPI formula can never creep in elsewhere.
 */

/** A window rectangle as Win32 reports it: physical desktop pixels. */
export interface NativeWindowRect {
  /** Left edge in virtual-desktop physical pixels (may be negative). */
  x: number;
  /** Top edge in virtual-desktop physical pixels (may be negative). */
  y: number;
  width: number;
  height: number;
}

/**
 * Where the fact came from.
 *
 * - `native` — read from the OS just now.
 * - `retained` — the read failed; the previous valid fact was kept.
 * - `unavailable` — no fact has ever been read (browser, harness, or a first
 *   read that failed with nothing valid to fall back on).
 */
export type ForegroundWindowSource = "native" | "retained" | "unavailable";

export interface ForegroundWindowLoad {
  /** Logical desktop rectangle, or `null` when no external window has focus. */
  window: LogicalRect | null;
  source: ForegroundWindowSource;
}

/**
 * The seam that lets deterministic tests supply fixtures instead of a real
 * desktop. Production uses {@link tauriForegroundWindowReader}.
 */
export interface NativeWindowReader {
  /** Resolves the focused window's physical rectangle, or `null` if there is none. */
  read(): Promise<NativeWindowRect | null>;
}

/**
 * Reads the fact through the one native command this phase adds.
 *
 * The native handle never crosses into JavaScript: the command returns a plain
 * rectangle (or nothing), and self-exclusion of the butterfly's own overlay is
 * decided natively where the handle lives.
 */
export const tauriForegroundWindowReader: NativeWindowReader = {
  async read() {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<[number, number, number, number] | null>(
      "foreground_window",
    );
    if (!raw) return null;
    const [x, y, width, height] = raw;
    return { x, y, width, height };
  },
};

/**
 * Whether a rectangle can be treated as a fact at all.
 *
 * Enforced here — at the single point where any fact enters this module, no
 * matter which reader produced it — so an empty, minimised or nonsensical
 * rectangle can never be handed to the environment layer as if it were real.
 * The native side already refuses those; this is the belt to its braces.
 */
function isUsableRect(rect: NativeWindowRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * Physical desktop pixels → the project's logical desktop pixels.
 *
 * The one and only conversion for this fact, kept here (rather than in
 * `desktop/geometry.ts`) so that the authoritative geometry module stays
 * untouched; the formula is deliberately identical to its
 * `toLogicalDesktop()`: divide by physical-per-logical. Sizes are divided by
 * the same factor, so a rectangle keeps its aspect across the conversion.
 */
export function toLogicalWindowRect(
  rect: NativeWindowRect,
  scaleFactor: number,
): LogicalRect {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  return {
    originX: rect.x / scale,
    originY: rect.y / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };
}

/** The last fact read, and where it came from; the fallback after a failure. */
let lastKnown: ForegroundWindowLoad | undefined;

/**
 * Reads the foreground-window fact once.
 *
 * A one-shot read, deliberately with no cache and no timer: Phase 13B.1 only
 * establishes the fact source, and refreshing it is 13B.3's job. Outside the
 * desktop shell there is nothing to report, so the honest answer is "no
 * external window" rather than a fabricated rectangle.
 */
export async function loadForegroundWindow(
  scaleFactor: number,
  reader: NativeWindowReader = tauriForegroundWindowReader,
): Promise<ForegroundWindowLoad> {
  // The platform guard belongs to the *default* native path only: a caller
  // that injects a reader is supplying the fact itself (that is exactly how the
  // deterministic suite runs without a desktop), so it is never second-guessed.
  if (reader === tauriForegroundWindowReader && !isDesktop) {
    return { window: null, source: "unavailable" };
  }
  try {
    const rect = await reader.read();
    const loaded: ForegroundWindowLoad = {
      window: rect && isUsableRect(rect) ? toLogicalWindowRect(rect, scaleFactor) : null,
      source: "native",
    };
    lastKnown = loaded;
    return loaded;
  } catch {
    return retained();
  }
}

/**
 * Re-reads the fact, keeping the previous valid one if the read fails.
 *
 * Mirrors the environment snapshot's discipline: a failed native read is not
 * new information, so it never replaces a good fact with `null` or with a
 * fabricated rectangle.
 */
export async function refreshForegroundWindow(
  scaleFactor: number,
  reader: NativeWindowReader = tauriForegroundWindowReader,
): Promise<ForegroundWindowLoad> {
  return loadForegroundWindow(scaleFactor, reader);
}

/** The retained fact, or "unavailable" when a first read already failed. */
function retained(): ForegroundWindowLoad {
  return lastKnown
    ? { window: lastKnown.window, source: "retained" }
    : { window: null, source: "unavailable" };
}

/**
 * Forgets the retained fact.
 *
 * Only for tests (and a future refresh path): it lets a deterministic suite
 * start from a known state, and is not a runtime mechanism.
 */
export function resetForegroundWindowCache(): void {
  lastKnown = undefined;
}

/**
 * The fact as it currently stands, without reading the OS again.
 *
 * The four states stay distinguishable, exactly as a read reports them: a
 * native window, a native "no external window", a retained value after a failed
 * read, or unavailable before anything valid is known.
 */
export function currentForegroundSnapshot(): ForegroundWindowLoad {
  return lastKnown ?? { window: null, source: "unavailable" };
}

/**
 * Announces that the foreground window may have changed.
 *
 * Deliberately a *notification*, not a poller: there is no interval here, and
 * none in the caller either. The signal comes from Tauri's own
 * `onFocusChanged` — when the user clicks into another application, our overlay
 * loses focus, which is the one event the current stack already exposes that
 * actually correlates with "the foreground window changed".
 *
 * As with every event in this codebase, the payload is only a hint: the fact is
 * re-read from the OS by the refresh that follows. Returns a stop function, and
 * is a no-op outside the desktop shell (including the dev harness).
 *
 * Known limitation, documented rather than papered over: focus changes are a
 * proxy, not proof. A window can come to the front without our overlay's focus
 * state changing, and the *reliable* signal (`SetWinEventHook` with
 * `EVENT_SYSTEM_FOREGROUND`) needs a native hook this phase deliberately does
 * not add. Any such gap closes itself on the next environment refresh.
 */
export function watchForegroundChanges(onChange: () => void): () => void {
  if (!isDesktop) return () => {};

  let stopped = false;
  let unlisten: (() => void) | null = null;

  void import("@tauri-apps/api/window")
    .then(async ({ getCurrentWindow }) => {
      const stop = await getCurrentWindow().onFocusChanged(() => onChange());
      if (stopped) {
        stop();
        return;
      }
      unlisten = stop;
    })
    // No native runtime, or the capability is absent: the fact simply stays as
    // it was, and no polling takes over.
    .catch(() => {});

  return () => {
    stopped = true;
    unlisten?.();
    unlisten = null;
  };
}