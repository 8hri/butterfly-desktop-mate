import {
  refreshDesktopEnvironment,
  sameEnvironment,
  workAreaAspect,
  type DesktopEnvironment,
  type EnvironmentSource,
} from "./environment.ts";
import { refreshDesktopGeometry, type DesktopGeometry } from "./geometry.ts";
import { isDesktop } from "../platform.ts";

/**
 * Desktop environment refresh (Phase 13A.3).
 *
 * The display can change under a running companion: a resolution change, a
 * work-area change, a DPI change, a different monitor. Until now the snapshot
 * was read once and kept forever, so the application could keep describing a
 * desktop that no longer existed.
 *
 * This module makes the *facts* fresh, and nothing else:
 *
 *   native event ──► coalesce (one refresh per frame boundary)
 *                 ──► re-read authoritative native values
 *                 ──► compare with the previous snapshot
 *                 ──► report what changed
 *
 * Design constraints it keeps, deliberately:
 *
 * - **Event-driven, never polled.** It listens to window events the installed
 *   Tauri API already exposes (`tauri://resize`, `tauri://scale-change`,
 *   `tauri://move`); no interval, no per-frame work, and no second cursor
 *   poller. The events are treated purely as "something may have changed" —
 *   the values themselves are always re-read from the OS.
 * - **A fact update, not a behaviour event.** This module has no import of the
 *   flight controller, the personality or React, issues no movement command,
 *   and cannot touch animation. It says `aspectChanged`; what to do about it is
 *   the caller's decision.
 * - **Idempotent.** If the facts are the same, nothing is reported as changed,
 *   the geometry cache is not even re-read, and no consumer is disturbed.
 * - **Failure tolerant.** A failed native read keeps the previous valid
 *   snapshot (`source: "retained"`) instead of substituting a fallback, so a
 *   transient failure can never make the companion believe it is somewhere it
 *   is not.
 */

/** Runs work at the next frame/task boundary. Injectable so tests are exact. */
export type RefreshScheduler = (run: () => void) => void;

/** Default: the next animation frame, falling back to a macrotask. */
export const frameScheduler: RefreshScheduler = (run) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => run());
  else setTimeout(run, 0);
};

/**
 * Whether two work areas really have a different aspect.
 *
 * Compared with a relative tolerance: display geometry arrives in fractional
 * units, and re-solving the flight area for a 1e-9 difference would be churn,
 * not correctness.
 */
export function sameAspect(a: number, b: number, tolerance = 1e-6): boolean {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

export interface RefreshOutcome {
  /** The environment facts as they stand now. */
  environment: DesktopEnvironment;
  /**
   * The overlay-mapping geometry, re-read only when the facts changed.
   * `null` when no desktop geometry is available (browser/harness).
   */
  geometry: DesktopGeometry | null;
  /** Where the snapshot came from: a real reading, the viewport, or a retained one. */
  source: EnvironmentSource;
  /** The facts differ from the snapshot that was compared against. */
  changed: boolean;
  /** The work area's aspect changed, so the flight area would need re-solving. */
  aspectChanged: boolean;
  /** The native read failed; the previous valid snapshot was kept. */
  failed: boolean;
}

/** The two native reads, injectable so the semantics can be tested offline. */
export interface EnvironmentReaders {
  readEnvironment: (
    width: number,
    height: number,
  ) => Promise<{ environment: DesktopEnvironment; source: EnvironmentSource }>;
  readGeometry: () => Promise<DesktopGeometry | null>;
}

const defaultReaders: EnvironmentReaders = {
  readEnvironment: (width, height) => refreshDesktopEnvironment(width, height),
  readGeometry: () => refreshDesktopGeometry(),
};

/**
 * Re-reads the authoritative desktop facts and reports what changed.
 *
 * `previous` is the snapshot the caller is currently using; pass `undefined`
 * for the first read. The work-area *size* changing at all implies a new
 * aspect only when the ratio actually differs, so a pure size change that
 * preserves the ratio does not force the flight area to be re-solved.
 */
export async function refreshEnvironmentFacts(
  viewport: { width: number; height: number },
  previous?: DesktopEnvironment,
  readers: EnvironmentReaders = defaultReaders,
): Promise<RefreshOutcome> {
  const loaded = await readers.readEnvironment(viewport.width, viewport.height);
  const environment = loaded.environment;
  const changed = !sameEnvironment(previous, environment);
  const failed = loaded.source === "retained";

  // Nothing changed: keep the caller's geometry and report nothing. This is
  // what makes a redundant event free.
  if (!changed) {
    return {
      environment,
      geometry: null,
      source: loaded.source,
      changed: false,
      aspectChanged: false,
      failed,
    };
  }

  const geometry = await readers.readGeometry();
  const aspectChanged =
    previous === undefined ||
    !sameAspect(workAreaAspect(previous), workAreaAspect(environment));

  return { environment, geometry, source: loaded.source, changed: true, aspectChanged, failed };
}

export interface CoalescedRefresh {
  /**
   * Marks the facts as possibly stale. Many calls before the scheduled
   * boundary collapse into exactly one refresh.
   */
  invalidate(): void;
  /** True while a refresh is scheduled but has not run yet. */
  readonly pending: boolean;
  /** Cancels a scheduled refresh (used when the owner goes away). */
  cancel(): void;
}

/**
 * Collapses a burst of change notifications into a single refresh.
 *
 * Display changes arrive in clusters (moving a window between monitors emits
 * move, resize and scale-change within milliseconds). Rather than reacting to
 * each one, a burst schedules one run at the next frame boundary — the smallest
 * amount of machinery that makes the outcome independent of how noisy the
 * event source is, and one that tests can drive deterministically.
 */
export function createCoalescedRefresh(
  run: () => void | Promise<void>,
  schedule: RefreshScheduler = frameScheduler,
): CoalescedRefresh {
  let scheduled = false;
  let cancelled = false;

  const fire = () => {
    scheduled = false;
    if (cancelled) return;
    void run();
  };

  return {
    invalidate() {
      if (scheduled || cancelled) return;
      scheduled = true;
      schedule(fire);
    },
    get pending() {
      return scheduled;
    },
    cancel() {
      cancelled = true;
      scheduled = false;
    },
  };
}

/**
 * Subscribes to the desktop events that can change the facts.
 *
 * Desktop only, and silent everywhere else: off the desktop shell — including
 * the dev harness, where the Tauri API answers nothing — it subscribes to
 * nothing at all and returns a no-op. Every event calls the same `onChange`,
 * because the events carry no facts worth trusting: the values are re-read from
 * the OS by the refresh itself.
 *
 * Returns a stop function that removes the listeners.
 */
export function watchDesktopEnvironment(onChange: () => void): () => void {
  if (!isDesktop) return () => {};

  let stopped = false;
  const unlisteners: Array<() => void> = [];

  void import("@tauri-apps/api/window")
    .then(async ({ getCurrentWindow }) => {
      const window = getCurrentWindow();
      // Resize, scale and move cover the changes the current stack can see:
      // resolution, work-area and DPI changes. There is no core display-change
      // event to add, and none is needed for those three.
      const subscriptions = await Promise.all([
        window.onResized(() => onChange()),
        window.onScaleChanged(() => onChange()),
        window.onMoved(() => onChange()),
      ]);
      if (stopped) {
        for (const unlisten of subscriptions) unlisten();
        return;
      }
      unlisteners.push(...subscriptions);
    })
    // No native runtime, or the capability is absent: the companion simply
    // keeps the facts it already has.
    .catch(() => {});

  return () => {
    stopped = true;
    for (const unlisten of unlisteners) unlisten();
    unlisteners.length = 0;
  };
}