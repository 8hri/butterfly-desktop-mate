import { Vector3, type Camera } from "three";
import type {
  DesktopEnvironment,
  LogicalRect,
  WorkAreaInsets,
} from "./desktop/environment.ts";

/**
 * Desktop awareness: pure environmental facts.
 *
 * Answers "where is the edge?" from the desktop snapshot — and nothing else.
 * The module is deliberately inert:
 *
 * - no Tauri, no Windows APIs, no cursor polling (the native layer's job),
 * - no React, no scene graph, no renderer,
 * - no knowledge of `FlightController` or `Personality`,
 * - no movement commands of any kind.
 *
 * It also does not invent a coordinate system. Screen-space facts stay in
 * logical desktop pixels, exactly as `desktop/geometry.ts` reports them, and
 * world-space facts are obtained by projecting through the *existing* camera
 * and airspace model rather than by a parallel conversion.
 *
 * Three boundaries are kept strictly apart, because they are not
 * interchangeable (at a 1920x1040 work area the reachable volume sits ~330 px
 * inside the left edge and ~160 px below the top):
 *
 *   monitor edge  ─ the physical screen
 *   work-area edge ─ the usable desktop (what the overlay covers)
 *   reachable edge ─ the volume the butterfly can currently occupy
 */

/** A point in logical desktop pixels. */
export interface LogicalPoint {
  x: number;
  y: number;
}

/** Signed distance to each work-area edge, in logical pixels (positive = inside). */
export interface EdgeDistances {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type CornerName = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface CornerFact {
  name: CornerName;
  /** Corner position in logical desktop pixels. */
  x: number;
  y: number;
}

/**
 * A world-space volume, structurally compatible with `FlightArea` but declared
 * here on purpose: awareness must not depend on the flight controller.
 */
export interface AwarenessVolume {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Where the work-area edges fall in world space, and how far the reachable
 * volume stays inside them.
 *
 * `reference` is the depth at which the mapping is taken: with a fixed camera
 * a vertical screen line maps to a family of world positions, so a reference
 * point is required for the answer to be single-valued. It defaults to the
 * middle of the reachable volume.
 */
export interface WorldEdgeMap {
  /** World x of the work area's left edge, at the reference depth. */
  left: number;
  /** World x of the work area's right edge. */
  right: number;
  /** World y of the work area's top edge. */
  top: number;
  /** World y of the work area's bottom edge. */
  bottom: number;
  /** How far the reachable volume stays inside each work-area edge. */
  reachableInsets: EdgeDistances;
  /** The depth the mapping was taken at. */
  reference: { y: number; z: number };
}

/** Factual summary of the environment, derived once from a snapshot. */
export interface WorkAreaAwareness {
  workArea: LogicalRect;
  monitor: LogicalRect;
  insets: WorkAreaInsets;
  /** True when the usable desktop differs from the physical monitor at all. */
  workAreaDiffersFromMonitor: boolean;
  /** The four work-area corners, in logical desktop pixels. */
  corners: Record<CornerName, CornerFact>;
}

/** An axis-aligned world-space box: the flight layer's only window-shaped input. */
export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** True when any inset is non-zero. */
export function workAreaDiffersFromMonitor(env: DesktopEnvironment): boolean {
  const { left, right, top, bottom } = env.insets;
  return left > 0 || right > 0 || top > 0 || bottom > 0;
}

/** The four work-area corners, in logical desktop pixels. */
export function workAreaCorners(env: DesktopEnvironment): Record<CornerName, CornerFact> {
  const { originX, originY, width, height } = env.workArea;
  const right = originX + width;
  const bottom = originY + height;
  return {
    "top-left": { name: "top-left", x: originX, y: originY },
    "top-right": { name: "top-right", x: right, y: originY },
    "bottom-left": { name: "bottom-left", x: originX, y: bottom },
    "bottom-right": { name: "bottom-right", x: right, y: bottom },
  };
}

/** Everything screen-space the awareness layer knows, from one snapshot. */
export function describeWorkArea(env: DesktopEnvironment): WorkAreaAwareness {
  return {
    workArea: { ...env.workArea },
    monitor: { ...env.monitor },
    insets: { ...env.insets },
    workAreaDiffersFromMonitor: workAreaDiffersFromMonitor(env),
    corners: workAreaCorners(env),
  };
}

/**
 * Signed distance from a point to each work-area edge, in logical pixels.
 *
 * Negative values mean the point lies outside that edge, which is how an
 * off-desktop cursor stays detectable instead of being clamped away.
 */
export function distancesToWorkAreaEdges(
  point: LogicalPoint,
  env: DesktopEnvironment,
): EdgeDistances {
  const { originX, originY, width, height } = env.workArea;
  return {
    left: point.x - originX,
    right: originX + width - point.x,
    top: point.y - originY,
    bottom: originY + height - point.y,
  };
}

/** Euclidean distance from a point to the nearest work-area edge, in logical pixels. */
export function distanceToNearestWorkAreaEdge(
  point: LogicalPoint,
  env: DesktopEnvironment,
): number {
  const d = distancesToWorkAreaEdges(point, env);
  return Math.min(d.left, d.right, d.top, d.bottom);
}

/** Distance from a point to a named corner, in logical pixels. */
export function distanceToCorner(
  point: LogicalPoint,
  corner: CornerFact,
): number {
  return Math.hypot(point.x - corner.x, point.y - corner.y);
}

/**
 * Is a cursor position inside the usable desktop?
 *
 * Takes **unclamped logical desktop coordinates** on purpose. The world-space
 * cursor point produced by `screenToWorldTarget()` is clamped into the flight
 * area per axis, so a cursor far outside the desktop arrives there as a point
 * on the reachable boundary and would read as "inside". This check must
 * therefore always run before that conversion.
 */
export function cursorInsideWorkArea(
  cursor: LogicalPoint,
  env: DesktopEnvironment,
): boolean {
  const d = distancesToWorkAreaEdges(cursor, env);
  return d.left >= 0 && d.right >= 0 && d.top >= 0 && d.bottom >= 0;
}

/**
 * Logical desktop pixels -> overlay client pixels (the space the webview and
 * `desktop/geometry.ts` use). Same origin shift as `desktopToClient`, expressed
 * on the snapshot so callers holding only an environment need not convert.
 */
export function toWorkAreaLocal(
  point: LogicalPoint,
  env: DesktopEnvironment,
): LogicalPoint {
  return { x: point.x - env.workArea.originX, y: point.y - env.workArea.originY };
}

/** Logical desktop pixels -> NDC, using the work area as the viewport. */
export function desktopPointToNdc(
  point: LogicalPoint,
  env: DesktopEnvironment,
): LogicalPoint {
  const { originX, originY, width, height } = env.workArea;
  return {
    x: ((point.x - originX) / width) * 2 - 1,
    y: -((point.y - originY) / height) * 2 + 1,
  };
}

/**
 * Is a point inside a rectangle?
 *
 * Half-open on purpose (`>=` low edge, `<` high edge): the boundary belongs to
 * the inside, so "exactly on the edge" is inside and the outside is a
 * measurable distance rather than an ambiguous case. All coordinates are the
 * project's logical desktop pixels — no conversion happens here.
 */
export function isPointInsideRect(point: LogicalPoint, rect: LogicalRect): boolean {
  return (
    point.x >= rect.originX &&
    point.x < rect.originX + rect.width &&
    point.y >= rect.originY &&
    point.y < rect.originY + rect.height
  );
}

/**
 * Is a point inside the foreground window?
 *
 * With no foreground window there is nothing to be inside, so the answer is
 * `false` — the honest reading of "no window is in front", rather than a
 * fabricated one.
 */
export function isPointInsideForegroundWindow(
  point: LogicalPoint,
  window: LogicalRect | null,
): boolean {
  return window !== null && isPointInsideRect(point, window);
}

/**
 * Distance from a point to a rectangle: `0` inside, otherwise the Euclidean
 * distance to the nearest point on it.
 *
 * Computed per axis — an axis the point is already within contributes nothing —
 * so the result is a true point-to-shape distance, not a scaled approximation.
 */
export function distanceToRect(point: LogicalPoint, rect: LogicalRect): number {
  const dx =
    point.x < rect.originX
      ? rect.originX - point.x
      : point.x > rect.originX + rect.width
        ? point.x - (rect.originX + rect.width)
        : 0;
  const dy =
    point.y < rect.originY
      ? rect.originY - point.y
      : point.y > rect.originY + rect.height
        ? point.y - (rect.originY + rect.height)
        : 0;
  return Math.hypot(dx, dy);
}

/**
 * Distance from a point to the foreground window.
 *
 * With no foreground window the distance is infinite: there is nothing to be
 * near, and a finite fallback would quietly invent a window.
 */
export function distanceToForegroundWindow(
  point: LogicalPoint,
  window: LogicalRect | null,
): number {
  return window === null ? Number.POSITIVE_INFINITY : distanceToRect(point, window);
}

/** The logical-desktop bounding box of a rectangle (identity, named for clarity). */
export function rectBounds(rect: LogicalRect): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  return {
    minX: rect.originX,
    maxX: rect.originX + rect.width,
    minY: rect.originY,
    maxY: rect.originY + rect.height,
  };
}

const probe = new Vector3();

/**
 * Solves the world coordinate on one axis whose projection lands on
 * `targetNdc`, at a fixed depth.
 *
 * Perspective projection is linear in x and in y at a fixed view depth, so a
 * bisection converges; the bracket is grown outwards from the reachable volume
 * because the work-area edges always lie outside it.
 */
function solveAxis(
  camera: Camera,
  axis: "x" | "y",
  targetNdc: number,
  reference: { y: number; z: number },
  volume: AwarenessVolume,
): number {
  const read = (value: number) =>
    axis === "x"
      ? probe.set(value, reference.y, reference.z).project(camera).x
      : probe.set(0, value, reference.z).project(camera).y;

  const low0 =
    axis === "x"
      ? Math.min(volume.min[0], volume.max[0])
      : Math.min(volume.min[1], volume.max[1]);
  const high0 =
    axis === "x"
      ? Math.max(volume.min[0], volume.max[0])
      : Math.max(volume.min[1], volume.max[1]);

  let low = low0 - 8;
  let high = high0 + 8;
  for (let i = 0; i < 24; i++) {
    if (read(low) <= targetNdc && read(high) >= targetNdc) break;
    const span = high - low;
    low -= span;
    high += span;
  }

  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2;
    if (read(mid) < targetNdc) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Maps the work-area edges into world space through the real camera, and
 * reports how far the reachable volume stays inside them.
 *
 * The overlay covers the work area exactly (1:1 after the origin shift, as
 * `desktop/geometry.ts` documents), so the work-area edges *are* the frame
 * borders — NDC -1 / +1 — and no separate rectangle needs converting here.
 * That is why this takes the camera and the reachable volume, not a snapshot.
 *
 * Same technique as `lib/airspace.ts` run in the opposite direction (there:
 * pick a margin, solve the bound; here: pick an edge, solve the world
 * coordinate), so both agree on one projection model. The camera's world
 * matrix must be current; callers already refresh it per frame.
 */
export function worldEdgeMap(
  camera: Camera,
  volume: AwarenessVolume,
  reference?: { y: number; z: number },
): WorldEdgeMap {
  const ref = reference ?? {
    y: (volume.min[1] + volume.max[1]) / 2,
    z: (volume.min[2] + volume.max[2]) / 2,
  };
  const left = solveAxis(camera, "x", -1, ref, volume);
  const right = solveAxis(camera, "x", 1, ref, volume);
  const top = solveAxis(camera, "y", 1, ref, volume);
  const bottom = solveAxis(camera, "y", -1, ref, volume);

  return {
    left,
    right,
    top,
    bottom,
    // The reachable volume is strictly inside the work area, so each inset is
    // the gap between the two, measured along the same axis and depth.
    reachableInsets: {
      left: volume.min[0] - left,
      right: right - volume.max[0],
      top: top - volume.max[1],
      bottom: volume.min[1] - bottom,
    },
    reference: { y: ref.y, z: ref.z },
  };
}

/**
 * Maps a logical-desktop rectangle into world space as an axis-aligned box.
 *
 * This is how a *desktop-space* fact (a foreground window) reaches the flight
 * layer without the flight layer ever learning what a desktop, a window or a
 * pixel is: the scene shell converts once, hands over four numbers, and the
 * controller compares candidates against a plain box — exactly the shape
 * `setArea()` already works with.
 *
 * Uses the same projection and solver as `worldEdgeMap`, so both agree on where
 * anything is. A degenerate rectangle (no area, or off in a way that cannot be
 * solved) yields `null`, which the flight layer reads as "no preference" rather
 * than as a broken box.
 */
export function worldBoundsForDesktopRect(
  camera: Camera,
  rect: LogicalRect,
  env: DesktopEnvironment,
  volume: AwarenessVolume,
  reference?: { y: number; z: number },
): WorldBounds | null {
  const bounds = rectBounds(rect);
  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxY) ||
    bounds.maxX <= bounds.minX ||
    bounds.maxY <= bounds.minY
  ) {
    return null;
  }

  const ndc = (x: number, y: number) =>
    desktopPointToNdc({ x, y }, env);
  const leftEdge = ndc(bounds.minX, env.workArea.originY);
  const rightEdge = ndc(bounds.maxX, env.workArea.originY);
  const topEdge = ndc(env.workArea.originX, bounds.minY);
  const bottomEdge = ndc(env.workArea.originX, bounds.maxY);

  const ref = reference ?? {
    y: (volume.min[1] + volume.max[1]) / 2,
    z: (volume.min[2] + volume.max[2]) / 2,
  };

  const minX = solveAxis(camera, "x", leftEdge.x, ref, volume);
  const maxX = solveAxis(camera, "x", rightEdge.x, ref, volume);
  const minY = solveAxis(camera, "y", bottomEdge.y, ref, volume);
  const maxY = solveAxis(camera, "y", topEdge.y, ref, volume);

  const world: WorldBounds = {
    minX: Math.min(minX, maxX),
    maxX: Math.max(minX, maxX),
    minY: Math.min(minY, maxY),
    maxY: Math.max(minY, maxY),
  };
  const usable =
    Number.isFinite(world.minX) &&
    Number.isFinite(world.maxX) &&
    Number.isFinite(world.minY) &&
    Number.isFinite(world.maxY) &&
    world.maxX > world.minX &&
    world.maxY > world.minY;
  return usable ? world : null;
}