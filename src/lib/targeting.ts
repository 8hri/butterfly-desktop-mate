import { Plane, Raycaster, Vector2, Vector3, type Camera } from "three";
// Explicit extension so the module also loads under Node's type stripping,
// which the headless tests use. `allowImportingTsExtensions` is enabled.
import { clampToArea, type FlightArea } from "./flight.ts";

/**
 * Screen-space to world-space targeting.
 *
 * Strategy — deliberately independent of where the butterfly currently is:
 *
 * 1. The click ray is intersected with a **world-aligned horizontal plane** at
 *    `planeY` (the camera's look height). This fixes how far along the ray the
 *    click "sits": a stable world location, whatever the butterfly is doing.
 * 2. That depth is clamped into the flight area's own z-band, and the point is
 *    taken **back on the ray** at the clamped depth. Because the result lies
 *    on the click ray, it projects back to exactly the clicked screen spot —
 *    even for steep clicks (corners) whose raw plane hit would sit outside the
 *    reachable volume. This is what lets a target reach every region of the
 *    window instead of collapsing towards the middle.
 * 3. Altitude comes from the **vertical screen offset**, mapped onto the
 *    flight area's own altitude band, so "click higher / lower" carries real
 *    vertical intent across the whole window instead of collapsing at a bound.
 * 4. The result is clamped with the controller's own area rules, so a target
 *    can never land outside the volume the butterfly can reach.
 *
 * The function is pure with respect to its arguments: same camera + same NDC +
 * same options always yields the same target.
 */
export interface TargetingOptions {
  /** Height of the horizontal targeting plane (world units). */
  planeY: number;
  /** Distance used along the ray when it misses the plane. */
  maxRayDistance: number;
  /** Half-range of altitude mapped from the vertical screen position. */
  verticalRange: number;
}

/** Module-level scratch objects: targeting is synchronous and allocation-free. */
const raycaster = new Raycaster();
const plane = new Plane();
const hit = new Vector3();
const planePoint = new Vector3();
const areaMin = new Vector3();
const areaMax = new Vector3();
/** Safe stand-in used when the incoming coordinate is not finite. */
const centerNdc = new Vector2();

const UP = new Vector3(0, 1, 0);

/** Centre of the flight area's altitude band. */
const altitudeCenter = (area: FlightArea) =>
  (area.min[1] + area.max[1]) / 2;

const isFiniteVec = (v: Vector2) => Number.isFinite(v.x) && Number.isFinite(v.y);

/**
 * Converts a normalised device coordinate (x right, y up, both in [-1, 1]) into
 * a world-space target inside the flight area.
 *
 * @param ndc       Pointer position in NDC.
 * @param camera    Camera to ray through; its world matrix must be current.
 * @param area      Flight area the target is constrained to.
 * @param options   Targeting surface and altitude tuning.
 * @param out       Optional destination vector, to avoid allocation.
 */
export function screenToWorldTarget(
  ndc: Vector2,
  camera: Camera,
  area: FlightArea,
  options: TargetingOptions,
  out: Vector3 = new Vector3(),
): Vector3 {
  areaMin.set(...area.min);
  areaMax.set(...area.max);

  // Guard against non-finite input from a degenerate pointer or transform.
  const coords = isFiniteVec(ndc) ? ndc : centerNdc.set(0, 0);

  raycaster.setFromCamera(coords, camera);

  // Depth reference from a stable world plane: where along the ray does this
  // click sit? Rays above the horizon miss it, so fall back to a capped
  // distance — a target is always produced.
  plane.setFromNormalAndCoplanarPoint(UP, planePoint.copy(UP).multiplyScalar(options.planeY));
  const onPlane = raycaster.ray.intersectPlane(plane, hit);
  if (!onPlane) raycaster.ray.at(options.maxRayDistance, hit);

  // Clamp that depth into the reachable z-band and return to the ray at the
  // clamped depth. The point now lies on the click ray, so it projects back
  // onto the clicked screen spot: the butterfly can be sent to any region of
  // the window, and only the final area clamp (the window's own bounds) can
  // pull it in from the edge.
  const z = Math.max(areaMin.z, Math.min(areaMax.z, hit.z));
  const dirZ = raycaster.ray.direction.z;
  if (Math.abs(dirZ) > 1e-6) {
    const t = (z - raycaster.ray.origin.z) / dirZ;
    if (t > 0) raycaster.ray.at(t, hit);
  }
  out.set(hit.x, 0, hit.z);

  // Altitude from the vertical screen offset, centred on the reachable band.
  const vertical = Math.max(-1, Math.min(1, coords.y)) * options.verticalRange;
  out.y = altitudeCenter(area) + vertical;

  return clampToArea(out, out, areaMin, areaMax);
}
