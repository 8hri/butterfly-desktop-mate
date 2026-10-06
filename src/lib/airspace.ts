import { PerspectiveCamera, Vector3 } from "three";
import { SCENE } from "../config/experience.ts";
import type { FlightArea } from "./flight.ts";

/**
 * The airspace solver.
 *
 * Works out which world-space box the fixed camera framing can actually see
 * at a given viewport aspect ratio, so the flight area *is* the visible
 * surface rather than a hand-tuned box. This is what lets the desktop
 * overlay treat the real work area — whatever its size and aspect — as the
 * butterfly's flight environment, with no window-size constant baked in.
 *
 * The camera's fov is vertical, so the altitude and depth bands are
 * aspect-independent shared constants; only the horizontal extent changes
 * with aspect. The solver finds the widest x bounds whose corners still
 * project inside `margin` of the half-frame (leaving room for the wingspan
 * and pointer parallax), derived from real projection — the same math
 * `tools/test-airspace.mjs` then re-verifies.
 */
export interface AirspaceBands {
  /** Shared altitude band (world units). Aspect-independent. */
  y: [number, number];
  /** Shared depth slab (world units). Kept shallow so one box stays in
   * frame and still reaches most of the surface. */
  z: [number, number];
  /** Worst allowed |ndc| for any box corner. */
  margin: number;
}

export const DEFAULT_AIRSPACE_BANDS: AirspaceBands = {
  y: [0.6, 2.75],
  z: [-0.5, 0.5],
  margin: 0.78,
};

function makeCamera(aspect: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(
    SCENE.camera.fov,
    aspect,
    SCENE.camera.near,
    SCENE.camera.far,
  );
  camera.position.set(...SCENE.camera.position);
  camera.lookAt(...SCENE.camera.lookAt);
  camera.updateMatrixWorld(true);
  return camera;
}

/** Worst |ndc.x| of one x bound across the band corners. */
function sideWorst(camera: PerspectiveCamera, x: number, bands: AirspaceBands): number {
  const probe = new Vector3();
  let worst = 0;
  for (const z of bands.z) {
    for (const y of bands.y) {
      const ndc = probe.set(x, y, z).project(camera);
      worst = Math.max(worst, Math.abs(ndc.x));
    }
  }
  return worst;
}

function solveSide(
  camera: PerspectiveCamera,
  side: "min" | "max",
  bands: AirspaceBands,
): number {
  // Seed from the view axis at the band's mid depth, then walk the bound
  // until the true projected edge converges on the margin.
  const position = SCENE.camera.position;
  const dir = new Vector3(...SCENE.camera.lookAt)
    .sub(new Vector3(...position))
    .normalize();
  const zMid = (bands.z[0] + bands.z[1]) / 2;
  const axisMid = position[0] + dir.x * ((zMid - position[2]) / dir.z);
  const sign = side === "max" ? 1 : -1;
  let value = axisMid + sign * bands.margin * 4;

  for (let i = 0; i < 24; i++) {
    const measured = sideWorst(camera, value, bands);
    if (Math.abs(measured - bands.margin) < 0.003) break;
    value += sign * (bands.margin - measured) * 1.2;
    if (!Number.isFinite(value)) return axisMid;
  }
  return value;
}

/** Widest x bounds that still project inside the frame at this aspect. */
export function solveAirspaceX(
  aspect: number,
  bands: AirspaceBands = DEFAULT_AIRSPACE_BANDS,
): [number, number] {
  const camera = makeCamera(aspect);
  return [solveSide(camera, "min", bands), solveSide(camera, "max", bands)];
}

/** The full flight area for a viewport aspect ratio. */
export function flightAreaForAspect(
  aspect: number,
  bands: AirspaceBands = DEFAULT_AIRSPACE_BANDS,
): FlightArea {
  const [xMin, xMax] = solveAirspaceX(aspect, bands);
  return {
    min: [xMin, bands.y[0], bands.z[0]],
    max: [xMax, bands.y[1], bands.z[1]],
  };
}

/**
 * The Garden's content and depth budget, as the layout config holds them.
 *
 * Structural on purpose: `SCENE.garden` satisfies it directly, so the volume
 * is solved from the configured composition rather than a second copy of it.
 */
export interface GardenAirspaceSource {
  /** Configured garden content, positioned as [x, z] on the ground plane. */
  flowers: ReadonlyArray<{ position: readonly [number, number] }>;
  stones: ReadonlyArray<{ position: readonly [number, number] }>;
  log: { position: readonly [number, number] };
  /** The Garden's flight-volume tuning (see `SCENE.garden.flightArea`). */
  flightArea: { depthMargin: number };
}

/**
 * The garden content's own depth extent, in world units.
 *
 * Every configured flower, stone and the log stand somewhere; this is simply the
 * span of their z positions — the part of the world the presentation actually
 * occupies, as opposed to a depth someone typed in by hand.
 */
export function gardenContentDepth(garden: GardenAirspaceSource): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  const consider = (position: readonly [number, number]) => {
    const z = position[1];
    if (z < min) min = z;
    if (z > max) max = z;
  };
  for (const flower of garden.flowers) consider(flower.position);
  for (const stone of garden.stones) consider(stone.position);
  consider(garden.log.position);
  return [min, max];
}

/**
 * The Garden flight volume.
 *
 * Desktop and web keep `flightAreaForAspect`: a box the *fixed* camera framing
 * can see, deliberately shallow in depth so perspective scale stays constant
 * across it. That is the right trade for a fixed shot whose butterfly position
 * IS its screen position, and it is exactly wrong for the garden, which runs
 * the follow rig over a garden that is 4.1 units deep — there the depth band
 * both capped the butterfly in a 1-unit slab and saturated the pointer mapping
 * against its two walls.
 *
 * So the garden keeps the shared solve for X and altitude (unchanged framing
 * behaviour, the same aspect-driven numbers as before) and takes its depth from
 * its own content plus the configured margin. Everything downstream — screen
 * targeting, investigation points, wandering, arrival — reads `flight.area`, so
 * one volume corrects all of them and the controller stays platform agnostic.
 */
export function gardenFlightArea(
  aspect: number,
  garden: GardenAirspaceSource,
): FlightArea {
  const framed = flightAreaForAspect(aspect);
  const [contentMin, contentMax] = gardenContentDepth(garden);
  const margin = garden.flightArea.depthMargin;
  return {
    min: [framed.min[0], framed.min[1], contentMin - margin],
    max: [framed.max[0], framed.max[1], contentMax + margin],
  };
}
