/**
 * Unit tests for screen-to-world targeting (dev only).
 *
 * These cover the properties the click behaviour depends on: a stable world
 * mapping, real horizontal and vertical intent, graceful handling of rays that
 * miss the surface, and targets that always stay inside the flight area.
 *
 * Usage: node tools/test-targeting.mjs
 */
import { PerspectiveCamera, Vector2, Vector3 } from "three";
import { screenToWorldTarget } from "../src/lib/targeting.ts";
import { DEFAULT_FLIGHT_TUNING, clampToArea } from "../src/lib/flight.ts";
import { SCENE } from "../src/config/experience.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const area = DEFAULT_FLIGHT_TUNING.area;
const options = { planeY: 1.25, maxRayDistance: 9, verticalRange: 1.05 };

/** Camera matching the experience's default framing. */
function makeCamera(width = 900, height = 640) {
  const camera = new PerspectiveCamera(45, width / height, 0.1, 120);
  camera.position.set(0.9, 2.5, 5.2);
  camera.lookAt(0, 1.25, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

const camera = makeCamera();
const target = (x, y) => screenToWorldTarget(new Vector2(x, y), camera, area, options);

const inArea = (p) =>
  p.x >= area.min[0] - 1e-6 &&
  p.x <= area.max[0] + 1e-6 &&
  p.y >= area.min[1] - 1e-6 &&
  p.y <= area.max[1] + 1e-6 &&
  p.z >= area.min[2] - 1e-6 &&
  p.z <= area.max[2] + 1e-6;

const finite = (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

// --- Horizontal intent ---
const left = target(-0.8, 0);
const centre = target(0, 0);
const right = target(0.8, 0);
check("left of centre targets left in world space", left.x < centre.x, `${left.x.toFixed(2)} < ${centre.x.toFixed(2)}`);
check("right of centre targets right in world space", right.x > centre.x, `${right.x.toFixed(2)} > ${centre.x.toFixed(2)}`);

let monotonic = true;
let previous = -Infinity;
for (let x = -1; x <= 1.0001; x += 0.05) {
  const p = target(x, 0);
  if (p.x < previous - 1e-6) monotonic = false;
  previous = p.x;
}
check("horizontal mapping is monotonic", monotonic);

// --- Vertical intent ---
const low = target(0, -0.8);
const high = target(0, 0.8);
check("clicking higher targets a higher altitude", high.y > low.y, `${high.y.toFixed(2)} > ${low.y.toFixed(2)}`);
check(
  "vertical intent is distinct across the window",
  target(0, -0.4).y !== target(0, 0.4).y,
  `${target(0, -0.4).y.toFixed(2)} vs ${target(0, 0.4).y.toFixed(2)}`,
);

// Calibration of the shipped altitude range: near-edge clicks must reach the
// ends of the reachable band (so the excursion is actually visible), while
// mid-window clicks must stay unclamped (so intent stays continuous).
{
  const shippedRange = 1.35;
  const shipped = { ...options, verticalRange: shippedRange };
  const top = screenToWorldTarget(new Vector2(0, 0.72), camera, area, shipped);
  const bottom = screenToWorldTarget(new Vector2(0, -0.72), camera, area, shipped);
  const centre = screenToWorldTarget(new Vector2(0, 0), camera, area, shipped);
  check(
    "near-edge clicks reach the ends of the altitude band",
    top.y > area.max[1] - 0.15 && bottom.y < area.min[1] + 0.15,
    `top=${top.y.toFixed(2)} bottom=${bottom.y.toFixed(2)}`,
  );
  check(
    "mid-window altitude stays unclamped",
    centre.y === (area.min[1] + area.max[1]) / 2 &&
      screenToWorldTarget(new Vector2(0, 0.4), camera, area, shipped).y <
        area.max[1],
    `centre=${centre.y.toFixed(2)}`,
  );
}

// --- Stability: the mapping is camera-relative and ray-anchored ---
{
  // The function takes no actor state at all; identical inputs must give
  // identical output, and a moved camera must move the result (the mapping
  // depends on the viewpoint, never on where the butterfly is).
  const a = target(0.35, 0.2);
  const b = target(0.35, 0.2);
  check(
    "deterministic for the same camera and NDC",
    a.distanceTo(b) < 1e-9,
    `delta=${a.distanceTo(b).toExponential(1)}`,
  );

  const moved = makeCamera();
  moved.position.x += 3;
  moved.updateMatrixWorld(true);
  const shifted = screenToWorldTarget(new Vector2(0.35, 0.2), moved, area, options);
  check(
    "mapping follows the viewpoint, not the butterfly",
    shifted.distanceTo(a) > 0.05,
    `target moved ${shifted.distanceTo(a).toFixed(2)} after camera +3x`,
  );

  // Ray-anchored: the target lies on the click ray, so projecting it back
  // with the same camera lands on the clicked column of the window. Only the
  // altitude band may shift it vertically — the horizontal component is
  // preserved (this is what lets the butterfly reach the clicked region).
  for (const nx of [-0.6, -0.3, 0, 0.3, 0.6]) {
    const back = target(nx, 0).clone().project(camera);
    check(
      `target for x=${nx} stays on the click ray`,
      Math.abs(back.x - nx) < 0.1,
      `back=${back.x.toFixed(2)}`,
    );
  }

  // Depth-clamped rays keep the ray too: clicks above the horizon (missed
  // plane) and in the lower corners used to be dragged sideways by the area
  // clamp; they must still return to the clicked column/side.
  const topBack = screenToWorldTarget(new Vector2(0, 0.9), camera, area, options)
    .clone()
    .project(camera);
  check(
    "depth-clamped top click lands on the clicked column",
    Math.abs(topBack.x) < 0.1,
    `back=(${topBack.x.toFixed(2)}, ${topBack.y.toFixed(2)})`,
  );
  const cornerBack = screenToWorldTarget(new Vector2(-0.8, -0.75), camera, area, options)
    .clone()
    .project(camera);
  check(
    "bottom-corner click reaches the side, not the centre",
    cornerBack.x < -0.5,
    `back=(${cornerBack.x.toFixed(2)}, ${cornerBack.y.toFixed(2)})`,
  );
}

// --- Missed ray (click above the horizon) ---
{
  const top = target(0, 1);
  check("ray above the horizon still yields a target", finite(top), top.toArray().map((v) => v.toFixed(2)).join(", "));
  check("missed ray stays in the flight area", inArea(top));
  check("missed ray still responds horizontally", target(-0.8, 1).x < target(0.8, 1).x);
}

// --- Corners and degenerate input ---
let allInArea = true;
let allFinite = true;
for (const x of [-1, -0.5, 0, 0.5, 1]) {
  for (const y of [-1, -0.5, 0, 0.5, 1]) {
    const p = target(x, y);
    if (!inArea(p)) allInArea = false;
    if (!finite(p)) allFinite = false;
  }
}
check("all screen positions resolve inside the area", allInArea);
check("all screen positions are finite", allFinite);

const nan = screenToWorldTarget(new Vector2(NaN, NaN), camera, area, options);
check("non-finite input is handled safely", finite(nan) && inArea(nan));

// --- Area rules are shared with the controller ---
{
  const min = new Vector3(...area.min);
  const max = new Vector3(...area.max);
  const outside = new Vector3(999, 999, 999);
  const clamped = clampToArea(outside, new Vector3(), min, max);
  check(
    "clampToArea matches the shared area rules",
    clamped.equals(max) || (clamped.x === max.x && clamped.y === max.y && clamped.z === max.z),
    clamped.toArray().join(", "),
  );
}

// --- Different aspect ratios must not invert or collapse the mapping ---
{
  const wide = makeCamera(1600, 500);
  const tall = makeCamera(500, 1600);
  const wideRight = screenToWorldTarget(new Vector2(0.8, 0), wide, area, options);
  const tallRight = screenToWorldTarget(new Vector2(0.8, 0), tall, area, options);
  check(
    "aspect ratio changes scale, not direction",
    wideRight.x > 0 && tallRight.x > 0,
    `wide=${wideRight.x.toFixed(2)} tall=${tallRight.x.toFixed(2)}`,
  );
}

// --- The shipped above-horizon reach is invisible to a shallow band (15.4 fix 4) ---
// The garden's deeper volume needs the depth reference to reach past its far
// wall; desktop and web clamp that reach into their own shallow z-band, so the
// two must be indistinguishable there. This pins that claim rather than
// asserting it: identical targets across the whole viewport, either reach.
{
  const shallow = { ...options, maxRayDistance: 9 };
  const shipped = { ...options, maxRayDistance: SCENE.interaction.maxRayDistance };
  let identical = SCENE.interaction.maxRayDistance !== 9;
  let aboveHorizon = 0;
  let samples = 0;
  outer: for (let nx = -1; nx <= 1.0001; nx += 0.05) {
    for (let ny = -1; ny <= 1.0001; ny += 0.05) {
      const a = screenToWorldTarget(new Vector2(nx, ny), camera, area, shallow);
      const b = screenToWorldTarget(new Vector2(nx, ny), camera, area, shipped);
      if (ny > 0.6) aboveHorizon += 1;
      samples += 1;
      if (Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.y - b.y) > 1e-9 || Math.abs(a.z - b.z) > 1e-9) {
        identical = false;
        break outer;
      }
    }
  }
  check(
    "a deeper above-horizon reach cannot change the shallow-band mapping",
    identical,
    `maxRayDistance=${SCENE.interaction.maxRayDistance} vs 9 over ${samples} viewport samples (${aboveHorizon} above the horizon)`,
  );
}

console.log(
  `\nsample targets: left=${left.toArray().map((v) => v.toFixed(2))} centre=${centre
    .toArray()
    .map((v) => v.toFixed(2))} right=${right.toArray().map((v) => v.toFixed(2))}`,
);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
