import { isDesktop } from "../platform.ts";

/**
 * Desktop environment facts.
 *
 * This module is the desktop layer's answer to "where am I?". It reports only
 * what the OS already knows, in one immutable snapshot:
 *
 *   monitor bounds ─┐
 *   work-area bounds├─► DesktopEnvironment ─► awareness (pure) ─► behaviour
 *   scale factor    ─┘
 *
 * Units, stated once so nothing downstream has to guess:
 *
 * - Every rectangle is in **logical desktop pixels** (CSS pixels, origin at the
 *   desktop's top-left corner). Multiply by `scaleFactor` for physical pixels.
 * - `scaleFactor` is **physical pixels per logical pixel** (the Windows DPI
 *   scale), the same conversion `desktop/geometry.ts` performs.
 *
 * Relationship to `desktop/geometry.ts` (unchanged, still authoritative for
 * cursor mapping and hit-testing): geometry is the *overlay view* — it needs
 * only the work area, because after the origin shift desktop and overlay
 * pixels are 1:1. The environment is the *desktop-facts view* — it adds the
 * physical monitor bounds so the difference between "the screen" and "the
 * usable desktop" stays visible instead of being silently discarded.
 *
 * Deliberately **not** here: anything that identifies *why* the work area is
 * smaller than the monitor. On Windows the work area excludes the taskbar, but
 * the native layer cannot currently tell a taskbar from any other reservation,
 * and cannot detect an auto-hiding one at all. The difference is therefore
 * reported as four neutral **work-area insets** — never as a taskbar size.
 */

export interface LogicalRect {
  /** Left edge, in logical desktop pixels (may be negative). */
  originX: number;
  /** Top edge, in logical desktop pixels (may be negative). */
  originY: number;
  /** Width in logical pixels. */
  width: number;
  /** Height in logical pixels. */
  height: number;
}

export interface WorkAreaInsets {
  /** Usable desktop is inset by this much from the monitor's left edge. */
  left: number;
  /** ...from the monitor's right edge. */
  right: number;
  /** ...from the monitor's top edge. */
  top: number;
  /** ...from the monitor's bottom edge. */
  bottom: number;
}

export interface DesktopEnvironment {
  /** Physical pixels per logical pixel (Windows DPI scale, 1 = 100%). */
  scaleFactor: number;
  /** The physical monitor the overlay is placed on. */
  monitor: LogicalRect;
  /** The usable desktop area the overlay actually covers. */
  workArea: LogicalRect;
  /** `monitor` minus `workArea`, per edge, in logical pixels. */
  insets: WorkAreaInsets;
}

/**
 * Derives the four work-area insets from the two rectangles.
 *
 * Pure, and deliberately tolerant: the result is clamped at zero so a monitor
 * that reports a work area marginally larger than itself (rounding at
 * fractional scale factors) yields `0` rather than a negative "inset".
 * Asymmetric insets are normal — a taskbar on the left produces a non-zero
 * `left` and nothing else.
 */
export function computeWorkAreaInsets(
  monitor: LogicalRect,
  workArea: LogicalRect,
): WorkAreaInsets {
  const at = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);
  return {
    left: at(workArea.originX - monitor.originX),
    top: at(workArea.originY - monitor.originY),
    right: at(
      monitor.originX + monitor.width - (workArea.originX + workArea.width),
    ),
    bottom: at(
      monitor.originY + monitor.height - (workArea.originY + workArea.height),
    ),
  };
}

/** A rectangle as a plain, comparable object (used by the loader and tests). */
function rect(
  originX: number,
  originY: number,
  width: number,
  height: number,
): LogicalRect {
  return { originX, originY, width, height };
}

/** Rejects non-finite / non-positive sizes so a snapshot is always usable. */
function size(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The environment used when no desktop information exists: a plain browser (or
 * the headless dev harness, where Tauri is stubbed but answers nothing). The
 * viewport *is* the desktop there, so monitor and work area coincide and all
 * insets are zero.
 *
 * Deterministic by construction — same viewport in, same snapshot out — which
 * is what lets the awareness layer be consumed and tested without Windows.
 */
export function viewportEnvironment(width: number, height: number): DesktopEnvironment {
  const w = size(width, 1);
  const h = size(height, 1);
  const bounds = rect(0, 0, w, h);
  return {
    scaleFactor: 1,
    monitor: { ...bounds },
    workArea: { ...bounds },
    insets: { left: 0, right: 0, top: 0, bottom: 0 },
  };
}

/** Where a snapshot came from — used to tell a real reading from a fallback. */
export type EnvironmentSource = "native" | "viewport" | "retained";

export interface EnvironmentLoad {
  environment: DesktopEnvironment;
  source: EnvironmentSource;
}

/** True when two snapshots describe the same desktop (facts, not identity). */
export function sameEnvironment(
  a: DesktopEnvironment | undefined,
  b: DesktopEnvironment | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const sameRect = (x: LogicalRect, y: LogicalRect) =>
    x.originX === y.originX &&
    x.originY === y.originY &&
    x.width === y.width &&
    x.height === y.height;
  const sameInsets = (x: WorkAreaInsets, y: WorkAreaInsets) =>
    x.left === y.left && x.right === y.right && x.top === y.top && x.bottom === y.bottom;
  return (
    a.scaleFactor === b.scaleFactor &&
    sameRect(a.monitor, b.monitor) &&
    sameRect(a.workArea, b.workArea) &&
    sameInsets(a.insets, b.insets)
  );
}

/** Work-area aspect ratio — the input the flight-area solver needs. */
export function workAreaAspect(env: DesktopEnvironment): number {
  return env.workArea.height > 0 ? env.workArea.width / env.workArea.height : 1;
}

let cached: DesktopEnvironment | undefined;

/**
 * Reads the desktop environment from the OS.
 *
 * Never throws, and distinguishes three outcomes so callers can react without
 * guessing: a real reading (`native`), the viewport stand-in used when no
 * desktop is present (`viewport`), or — on a refresh — the previously valid
 * snapshot kept because the read failed (`retained`). Valid data is never
 * replaced with zeros or with a fabricated rectangle.
 */
async function readEnvironment(
  viewportWidth: number,
  viewportHeight: number,
): Promise<{ environment: DesktopEnvironment; source: EnvironmentSource }> {
  if (!isDesktop) {
    return {
      environment: viewportEnvironment(viewportWidth, viewportHeight),
      source: "viewport",
    };
  }
  try {
    const { primaryMonitor } = await import("@tauri-apps/api/window");
    const monitor = await primaryMonitor();
    if (!monitor) throw new Error("no monitor reported");
    const scale = monitor.scaleFactor || 1;
    const toLogical = (value: number) => value / scale;
    const monitorRect = rect(
      toLogical(monitor.position.x),
      toLogical(monitor.position.y),
      toLogical(monitor.size.width),
      toLogical(monitor.size.height),
    );
    const workAreaRect = rect(
      toLogical(monitor.workArea.position.x),
      toLogical(monitor.workArea.position.y),
      toLogical(monitor.workArea.size.width),
      toLogical(monitor.workArea.size.height),
    );
    return {
      environment: {
        scaleFactor: scale,
        monitor: monitorRect,
        workArea: workAreaRect,
        insets: computeWorkAreaInsets(monitorRect, workAreaRect),
      },
      source: "native",
    };
  } catch {
    // A failed read is not new information: keep whatever was already known.
    return cached
      ? { environment: cached, source: "retained" }
      : {
          environment: viewportEnvironment(viewportWidth, viewportHeight),
          source: "viewport",
        };
  }
}

/**
 * Loads the desktop environment, caching the result.
 *
 * Never fails and never returns null: outside the Tauri shell (or when the
 * native query is unavailable) it resolves to the viewport environment, so
 * callers need no platform branch of their own. The cache exists because
 * display geometry only changes when the display setup does — a caller that
 * needs it re-read must ask explicitly via `refreshDesktopEnvironment`.
 */
export async function loadDesktopEnvironment(
  viewportWidth: number,
  viewportHeight: number,
): Promise<DesktopEnvironment> {
  if (!isDesktop) return viewportEnvironment(viewportWidth, viewportHeight);
  if (cached) return cached;
  const loaded = await readEnvironment(viewportWidth, viewportHeight);
  cached = loaded.environment;
  return cached;
}

/**
 * Drops the cached snapshot and re-reads it, reporting where the result came
 * from.
 *
 * This is the explicit way to pick up a changed display setup (resolution,
 * work-area change, DPI change) without adding a polling loop: the native layer
 * announces a possible change, and this re-reads the authoritative values —
 * the event itself is never trusted as data. If the read fails, the previous
 * snapshot is returned untouched (`source: "retained"`) rather than being
 * replaced with a fallback.
 */
export async function refreshDesktopEnvironment(
  viewportWidth: number,
  viewportHeight: number,
): Promise<EnvironmentLoad> {
  if (!isDesktop) {
    return {
      environment: viewportEnvironment(viewportWidth, viewportHeight),
      source: "viewport",
    };
  }
  cached = undefined;
  const loaded = await readEnvironment(viewportWidth, viewportHeight);
  cached = loaded.environment;
  return loaded;
}