/**
 * Unit tests for the airspace solver (dev only).
 *
 * The flight area is derived from the camera pose and the viewport aspect —
 * never from a hard-coded window size — so the desktop overlay can treat the
 * real work area as the flight environment. These checks pin that
 * derivation: reference parity, containment at any aspect, and sane
 * monotonic behaviour.
 *
 * Usage: node tools/test-airspace.mjs
 */
import { PerspectiveCamera, Vector3 } from "three";
import {
  DEFAULT_AIRSPACE_BANDS,
  flightAreaForAspect,
  gardenContentDepth,
  gardenFlightArea,
  solveAirspaceX,
} from "../src/lib/airspace.ts";
import { DEFAULT_FLIGHT_TUNING } from "../src/lib/flight.ts";
import { SCENE } from "../src/config/experience.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const bands = DEFAULT_AIRSPACE_BANDS;

function makeCamera(aspect) {
  const camera = new PerspectiveCamera(45, aspect, 0.1, 120);
  camera.position.set(...SCENE.camera.position);
  camera.lookAt(...SCENE.camera.lookAt);
  camera.updateMatrixWorld(true);
  return camera;
}

function worstCorner(area, aspect) {
  const camera = makeCamera(aspect);
  let worst = 0;
  for (const x of [area.min[0], area.max[0]])
    for (const y of [area.min[1], area.max[1]])
      for (const z of [area.min[2], area.max[2]]) {
        const ndc = new Vector3(x, y, z).project(camera);
        worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y));
      }
  return worst;
}

// --- The shipped default IS the solver's output at the reference aspect ---
{
  const solved = flightAreaForAspect(420 / 320);
  const reference = DEFAULT_FLIGHT_TUNING.area;
  const close = (a, b) => Math.abs(a - b) < 0.05;
  check(
    "default tuning area is the reference solve (420/320)",
    close(solved.min[0], reference.min[0]) &&
      close(solved.max[0], reference.max[0]) &&
      close(solved.min[1], reference.min[1]) &&
      close(solved.max[1], reference.max[1]) &&
      close(solved.min[2], reference.min[2]) &&
      close(solved.max[2], reference.max[2]),
    `solved x=[${solved.min[0].toFixed(2)}, ${solved.max[0].toFixed(2)}] ` +
      `reference x=[${reference.min[0]}, ${reference.max[0]}]`,
  );
}

// --- Containment holds for any desktop aspect the overlay might meet ---
{
  const aspects = [
    ["4:3", 4 / 3],
    ["3:2", 3 / 2],
    ["16:10", 16 / 10],
    ["16:9", 16 / 9],
    ["21:9", 21 / 9],
    ["harness", 1000 / 700],
  ];
  for (const [label, aspect] of aspects) {
    const area = flightAreaForAspect(aspect);
    const worst = worstCorner(area, aspect);
    check(
      `airspace corners stay in frame at ${label}`,
      worst <= bands.margin + 0.01,
      `worst |ndc|=${worst.toFixed(3)} margin=${bands.margin}`,
    );
  }
}

// --- Wider viewports must yield wider airspace, never narrower ---
{
  let previous = 0;
  let monotonic = true;
  for (const aspect of [4 / 3, 3 / 2, 16 / 10, 16 / 9, 21 / 9]) {
    const [min, max] = solveAirspaceX(aspect);
    const width = max - min;
    if (width <= previous) monotonic = false;
    previous = width;
  }
  check("wider aspect yields wider airspace", monotonic);
}

// --- Vertical/depth bands are shared, so altitude semantics never drift ---
{
  const a = flightAreaForAspect(4 / 3);
  const b = flightAreaForAspect(21 / 9);
  check(
    "altitude and depth bands are aspect-independent",
    a.min[1] === b.min[1] &&
      a.max[1] === b.max[1] &&
      a.min[2] === b.min[2] &&
      a.max[2] === b.max[2],
    `y=[${a.min[1]}, ${a.max[1]}] z=[${a.min[2]}, ${a.max[2]}]`,
  );
}

// --- The solved airspace is usable: targets at the solved bounds are sane ---
{
  const area = flightAreaForAspect(16 / 9);
  const width = area.max[0] - area.min[0];
  check(
    "16:9 airspace spans a meaningful share of the work area",
    width > 4.5,
    `x width=${width.toFixed(2)} world units`,
  );
}

// --- The Garden flight volume (Phase 15.4 Fix 4) ---------------------------------
// Garden runs the follow rig over its own content, so it does NOT inherit the
// desktop slab: it keeps the shared X/altitude solve and takes depth from the
// configured content plus a margin. Desktop keeps the slab exactly as before.
{
  const aspect = 1100 / 700;
  const desktop = flightAreaForAspect(aspect);
  const area = gardenFlightArea(aspect, SCENE.garden);

  check(
    "the desktop area still carries its shallow depth slab",
    desktop.min[2] === -0.5 && desktop.max[2] === 0.5,
    `z=[${desktop.min[2]}, ${desktop.max[2]}]`,
  );

  const [contentMin, contentMax] = gardenContentDepth(SCENE.garden);
  check(
    "the garden content's own depth extent is the flowers, stones and log",
    contentMin === -3.4 && contentMax === 2.1,
    `z=[${contentMin}, ${contentMax}]`,
  );

  const margin = SCENE.garden.flightArea.depthMargin;
  check(
    "garden depth covers the configured content plus the configured margin",
    area.min[2] === contentMin - margin && area.max[2] === contentMax + margin,
    `z=[${area.min[2].toFixed(2)}, ${area.max[2].toFixed(2)}] margin=${margin}`,
  );

  check(
    "every configured garden position is inside the garden depth",
    [...SCENE.garden.flowers, ...SCENE.garden.stones, SCENE.garden.log].every(
      (item) => {
        const z = item.position[1];
        return z >= area.min[2] && z <= area.max[2];
      },
    ),
  );

  const desktopSpan = desktop.max[2] - desktop.min[2];
  const gardenSpan = area.max[2] - area.min[2];
  check(
    "garden depth is materially larger than the desktop depth",
    gardenSpan > desktopSpan * 3,
    `desktop=${desktopSpan.toFixed(2)} garden=${gardenSpan.toFixed(2)} (x${(gardenSpan / desktopSpan).toFixed(1)})`,
  );

  check(
    "garden X and altitude are exactly the desktop solve",
    area.min[0] === desktop.min[0] &&
      area.max[0] === desktop.max[0] &&
      area.min[1] === desktop.min[1] &&
      area.max[1] === desktop.max[1],
    `x=[${area.min[0].toFixed(3)}, ${area.max[0].toFixed(3)}] y=[${area.min[1]}, ${area.max[1]}]`,
  );

  check("the garden volume is deterministic", JSON.stringify(gardenFlightArea(aspect, SCENE.garden)) === JSON.stringify(area));

  // Config-driven, not a literal: moving the configured margin moves the volume
  // by exactly that much, and nothing else about it.
  const wider = gardenFlightArea(aspect, {
    ...SCENE.garden,
    flightArea: { depthMargin: margin + 1 },
  });
  check(
    "the depth margin in the config drives the volume",
    wider.min[2] === area.min[2] - 1 &&
      wider.max[2] === area.max[2] + 1 &&
      wider.min[0] === area.min[0] &&
      wider.max[0] === area.max[0] &&
      wider.min[1] === area.min[1] &&
      wider.max[1] === area.max[1],
    `margin ${margin} -> ${margin + 1} shifts z by 1 unit`,
  );

  // Solving the garden must leave the desktop solve (and the shared bands)
  // exactly as they were.
  gardenFlightArea(aspect, SCENE.garden);
  const after = flightAreaForAspect(aspect);
  check(
    "solving the garden volume leaves the desktop solve untouched",
    JSON.stringify(after) === JSON.stringify(desktop) &&
      DEFAULT_AIRSPACE_BANDS.z[0] === -0.5 &&
      DEFAULT_AIRSPACE_BANDS.z[1] === 0.5,
  );

  check(
    "the garden volume is wider than its own clearing radius in depth",
    Math.abs(area.min[2]) <= SCENE.garden.ground.radius &&
      Math.abs(area.max[2]) <= SCENE.garden.ground.radius,
    `clearing radius=${SCENE.garden.ground.radius} z=[${area.min[2].toFixed(2)}, ${area.max[2].toFixed(2)}]`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
