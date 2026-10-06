import { isDesktop } from "../platform.ts";

/**
 * Desktop geometry: the single source of truth for where the overlay window
 * sits on the Windows desktop and how coordinates convert between spaces.
 *
 *   desktop (logical px) ──(− origin)──► overlay client px ──(÷ size)──► NDC
 *
 * The native layer sizes the overlay to the primary monitor's work area, so
 * after the origin shift the mapping between desktop pixels and overlay
 * pixels is 1:1. The OS reports physical pixels; everything here works in
 * logical (CSS) pixels, converted once with the monitor scale factor.
 */
export interface DesktopGeometry {
  /** Work-area origin, in logical desktop pixels. */
  originX: number;
  originY: number;
  /** Work-area size, in logical pixels (== the overlay's client size). */
  width: number;
  height: number;
  /** Physical pixels per logical pixel (the Windows DPI scale factor). */
  scaleFactor: number;
}

let cached: DesktopGeometry | null | undefined;

/** Notified whenever a refresh actually changed the desktop geometry. */
type GeometryListener = (geometry: DesktopGeometry | null) => void;
const listeners = new Set<GeometryListener>();

/**
 * Subscribes to *actual* geometry changes.
 *
 * The desktop input path resolves its coordinates once per poll tick from a
 * long-lived geometry value, so it needs to be told when that value becomes
 * stale — by a refresh, never by a poller of its own. Listeners fire only when a
 * refresh produced a genuinely different geometry.
 */
export function onDesktopGeometryChange(listener: GeometryListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when two geometries describe the same desktop mapping. */
function sameGeometry(a: DesktopGeometry | null, b: DesktopGeometry | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.originX === b.originX &&
    a.originY === b.originY &&
    a.width === b.width &&
    a.height === b.height &&
    a.scaleFactor === b.scaleFactor
  );
}

/**
 * Loads the primary monitor's work area (desktop mode only). The result is
 * cached: geometry only changes with the display setup, which is out of
 * scope for this phase. Returns null when no real Tauri runtime is present
 * (the dev harness), so callers fall back to the browser viewport.
 */
export async function loadDesktopGeometry(): Promise<DesktopGeometry | null> {
  if (!isDesktop) return null;
  if (cached !== undefined) return cached;
  try {
    const { primaryMonitor } = await import("@tauri-apps/api/window");
    const monitor = await primaryMonitor();
    if (!monitor) return (cached = null);
    const scale = monitor.scaleFactor || 1;
    cached = {
      originX: monitor.workArea.position.x / scale,
      originY: monitor.workArea.position.y / scale,
      width: monitor.workArea.size.width / scale,
      height: monitor.workArea.size.height / scale,
      scaleFactor: scale,
    };
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Re-reads the desktop geometry, dropping the cache first.
 *
 * This is the only way the geometry becomes fresh again, and it is deliberately
 * explicit: nothing polls it, and `Phase 13A.3`'s refresh coordinator calls it
 * when the native layer says the display may have changed. Listeners are
 * notified only if the result actually differs, so an event storm or a
 * redundant event costs one native call and nothing downstream.
 */
export async function refreshDesktopGeometry(): Promise<DesktopGeometry | null> {
  const previous = cached ?? null;
  cached = undefined;
  const next = await loadDesktopGeometry();
  if (!sameGeometry(previous, next)) {
    for (const listener of listeners) listener(next);
  }
  return next;
}

/**
 * Geometry to use when the real work area cannot be queried (the headless
 * dev harness): the overlay is then just the browser viewport.
 */
export function fallbackGeometry(width: number, height: number): DesktopGeometry {
  return { originX: 0, originY: 0, width, height, scaleFactor: 1 };
}

/** Physical desktop pixels -> logical desktop pixels (DPI conversion). */
export function toLogicalDesktop(
  geometry: DesktopGeometry,
  x: number,
  y: number,
): { x: number; y: number } {
  const scale = geometry.scaleFactor || 1;
  return { x: x / scale, y: y / scale };
}

/** Logical desktop pixels -> overlay client pixels (origin shift). */
export function desktopToClient(
  geometry: DesktopGeometry,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: x - geometry.originX, y: y - geometry.originY };
}

/** Overlay client pixels -> normalized device coordinates. */
export function clientToNdc(
  geometry: DesktopGeometry,
  clientX: number,
  clientY: number,
  out: { set: (x: number, y: number) => unknown },
): void {
  out.set(
    (clientX / geometry.width) * 2 - 1,
    -(clientY / geometry.height) * 2 + 1,
  );
}

/** Logical desktop pixels -> normalized device coordinates, in one step. */
export function desktopToNdc(
  geometry: DesktopGeometry,
  x: number,
  y: number,
  out: { set: (x: number, y: number) => unknown },
): void {
  const client = desktopToClient(geometry, x, y);
  clientToNdc(geometry, client.x, client.y, out);
}
