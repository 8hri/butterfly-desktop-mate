/**
 * Behavioural test for CameraRig (dev only). Asserts the framing guarantees
 * that matter for immersion: the butterfly stays on screen, the camera never
 * snaps, and travel is bounded so the shot stays composed.
 *
 * Usage: node tools/test-camera.mjs
 */
import { PerspectiveCamera, Vector3 } from "three";
import { CameraRig, DEFAULT_CAMERA_TUNING } from "../src/lib/camera.ts";
import { FlightController, DEFAULT_FLIGHT_TUNING } from "../src/lib/flight.ts";
import { flightAreaForAspect, gardenFlightArea } from "../src/lib/airspace.ts";
import { SCENE } from "../src/config/experience.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

/** Deterministic PRNG so runs are reproducible. */
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const tuning = DEFAULT_CAMERA_TUNING;
const flight = new FlightController(DEFAULT_FLIGHT_TUNING, new Vector3(0, 1.4, 0));
const rig = new CameraRig(tuning);
const camera = new PerspectiveCamera(45, 16 / 9, 0.1, 120);
camera.position.set(0.9, 2.5, 5.2);

const dt = 1 / 60;
let maxStep = 0;
let maxDistanceToButterfly = 0;
let minDistanceToButterfly = Infinity;
let finite = true;

const previous = camera.position.clone();
let pointer = { x: 0, y: 0 };

for (let i = 0; i < 60 * 90; i++) {
  // Pointer sweeps back and forth, as a user would.
  if (i % 240 === 0) pointer = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
  flight.step(dt);
  rig.update(dt, flight.position, pointer, camera.position);
  camera.lookAt(rig.lookPoint);
  camera.updateMatrixWorld();

  if (!Number.isFinite(camera.position.x + camera.position.y + camera.position.z)) finite = false;
  maxStep = Math.max(maxStep, camera.position.distanceTo(previous));

  // Project the butterfly and confirm it stays comfortably inside the frame.
  const ndc = flight.position.clone().project(camera);
  const margin = 0.85;
  if (
    Math.abs(ndc.x) > margin ||
    Math.abs(ndc.y) > margin ||
    ndc.z > 1
  ) {
    failures++;
    console.log(`      frame ${i}: butterfly at ndc ${ndc.toArray().map((v) => v.toFixed(2))}`);
  }

  const distance = camera.position.distanceTo(flight.position);
  maxDistanceToButterfly = Math.max(maxDistanceToButterfly, distance);
  minDistanceToButterfly = Math.min(minDistanceToButterfly, distance);
  previous.copy(camera.position);
}

check("camera position stays finite", finite);
check("no snapping", maxStep < 0.25, `maxStep=${maxStep.toFixed(3)}/frame`);
check(
  "travel stays bounded around the home framing",
  Math.abs(camera.position.x) <= tuning.travel[0] + 0.01 &&
    camera.position.y >= tuning.offset[1] - tuning.travel[1] - 0.01 &&
    camera.position.z <= tuning.offset[2] + tuning.travel[2] + 0.01,
  `end=${camera.position.toArray().map((v) => v.toFixed(2)).join(", ")}`,
);
check(
  "keeps a comfortable viewing distance",
  minDistanceToButterfly > 3 && maxDistanceToButterfly < 9,
  `${minDistanceToButterfly.toFixed(2)}–${maxDistanceToButterfly.toFixed(2)} units`,
);

// --- User-directed flights: the framing trails the destination so the
// butterfly is visibly displaced toward where it was asked to go ---
{
  const directedRig = new CameraRig(DEFAULT_CAMERA_TUNING);
  const butterfly = new Vector3(0, 1.4, 0);
  const destination = new Vector3(2.5, 1.4, 0);
  const position = new PerspectiveCamera(45, 16 / 9, 0.1, 120).position.clone();
  for (let i = 0; i < 120; i++) {
    directedRig.update(1 / 60, butterfly, null, position, destination);
  }
  const lead = butterfly.x - directedRig.lookPoint.x;
  check(
    "framing trails a right-hand destination",
    lead > 0.2,
    `lookPoint.x=${directedRig.lookPoint.x.toFixed(2)} butterfly.x=${butterfly.x.toFixed(2)} lead=${lead.toFixed(2)}`,
  );

  // Without an active destination the framing returns to the butterfly.
  const idleRig = new CameraRig(DEFAULT_CAMERA_TUNING);
  for (let i = 0; i < 240; i++) {
    idleRig.update(1 / 60, butterfly, null, position);
  }
  check(
    "framing recentres once the directed flight ends",
    Math.abs(butterfly.x - idleRig.lookPoint.x) < 0.05,
    `offset=${(butterfly.x - idleRig.lookPoint.x).toFixed(3)}`,
  );

  // The lean must stay capped even on the longest flight the area allows,
  // or the butterfly would leave the frame on a far-side click.
  const farRig = new CameraRig(DEFAULT_CAMERA_TUNING);
  const farTarget = new Vector3(7.5, 1.4, -4); // ~9 units from the butterfly
  let worstOffset = 0;
  for (let i = 0; i < 180; i++) {
    farRig.update(1 / 60, butterfly, null, position, farTarget);
    worstOffset = Math.max(worstOffset, Math.abs(butterfly.x - farRig.lookPoint.x));
  }
  const { maxTrailDistance } = DEFAULT_CAMERA_TUNING;
  check(
    "framing lean stays capped on long flights",
    worstOffset <= maxTrailDistance + 0.01,
    `worst=${worstOffset.toFixed(2)} cap=${maxTrailDistance}`,
  );
}

// --- Fixed framing (desktop): the camera holds its home shot, so the
// butterfly's position within the frame *is* its screen position and it can
// travel across the whole window. This is the geometry the desktop area was
// solved against, so the in-frame guarantee is asserted against real
// projection, not hand-waving.
{
  const fixedTuning = {
    ...DEFAULT_CAMERA_TUNING,
    framing: "fixed",
    offset: [0.9, 2.5, 5.2], // absolute home position
    lookAt: [0, 1.25, 0],
  };
  const fixedRig = new CameraRig(fixedTuning);
  const desktopFlight = new FlightController(
    DEFAULT_FLIGHT_TUNING,
    new Vector3(0, 1.4, 0),
    mulberry32(99),
  );
  const cam = new PerspectiveCamera(45, 420 / 320, 0.1, 120);
  cam.position.set(0.9, 2.5, 5.2);
  const homePos = new Vector3(0.9, 2.5, 5.2);
  const probe = new Vector3();

  let outOfFrame = 0;
  let maxDrift = 0;
  let maxStepFixed = 0;
  let prevFixed = cam.position.clone();
  let pointer = null;
  for (let i = 0; i < 60 * 60; i++) {
    if (i % 180 === 0) {
      pointer = { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 };
    }
    desktopFlight.step(1 / 60);
    fixedRig.update(1 / 60, desktopFlight.position, pointer, cam.position, desktopFlight.userTarget);
    cam.lookAt(fixedRig.lookPoint);
    cam.updateMatrixWorld();

    const ndc = probe.copy(desktopFlight.position).project(cam);
    // The design containment is 0.78; transient pointer parallax may add a
    // little more while the butterfly is opposite the cursor.
    if (Math.abs(ndc.x) > 0.92 || Math.abs(ndc.y) > 0.92) outOfFrame++;
    maxDrift = Math.max(maxDrift, cam.position.distanceTo(homePos));
    maxStepFixed = Math.max(maxStepFixed, cam.position.distanceTo(prevFixed));
    prevFixed.copy(cam.position);
  }
  check(
    "fixed camera holds its shot (parallax only)",
    maxDrift < 0.45,
    `drift=${maxDrift.toFixed(2)} units`,
  );
  check("fixed camera never snaps", maxStepFixed < 0.05, `maxStep=${maxStepFixed.toFixed(4)}/frame`);
  check(
    "butterfly stays in frame under the fixed camera",
    outOfFrame === 0,
    `${outOfFrame} out-of-frame frames over 60s of wandering`,
  );

  // A directed flight must not lean the fixed framing: real travel already
  // reads as travel, and leaning would shove an edge butterfly off-frame.
  const leanRig = new CameraRig(fixedTuning);
  const leanPos = new Vector3(0.9, 2.5, 5.2);
  for (let i = 0; i < 120; i++) {
    leanRig.update(1 / 60, new Vector3(0, 1.4, 0), null, leanPos, new Vector3(7.5, 1.4, -4));
  }
  check(
    "fixed framing does not lean toward a directed flight",
    leanRig.lookPoint.distanceTo(new Vector3(0, 1.25, 0)) < 1e-9,
    `aim drift=${leanRig.lookPoint.distanceTo(new Vector3(0, 1.25, 0)).toExponential(1)}`,
  );

  // The flight area itself must project inside the desktop frame — this is
  // what "the desktop is the flight environment" means numerically. The
  // shipped default area is the reference solve at 420/320; the desktop
  // overlay re-solves the area for the real work-area aspect at runtime, so
  // a representative 16:9 work area is checked the same way.
  const cases = [
    ["reference 420/320", 420 / 320, DEFAULT_FLIGHT_TUNING.area],
    ["work-area 16:9", 16 / 9, flightAreaForAspect(16 / 9)],
  ];
  for (const [label, aspect, area] of cases) {
    const frame = new PerspectiveCamera(45, aspect, 0.1, 120);
    frame.position.set(0.9, 2.5, 5.2);
    frame.lookAt(0, 1.25, 0);
    frame.updateMatrixWorld(true);
    let worst = 0;
    for (const x of [area.min[0], area.max[0]])
      for (const y of [area.min[1], area.max[1]])
        for (const z of [area.min[2], area.max[2]]) {
          const ndc = new Vector3(x, y, z).project(frame);
          worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y));
        }
    check(
      `flight area corners project inside the frame (${label})`,
      worst <= 0.8,
      `worst corner |ndc|=${worst.toFixed(3)} (design margin 0.78)`,
    );
  }
}

// --- Garden framing (Phase 15.5A) ---------------------------------------------------
// The garden tunes the follow shot for itself, but it must do so *beside* the
// desktop framing rather than through it: `SCENE.camera` is the desktop fixed
// shot's home, so the garden gets its own numbers and leaves those alone.
{
  const garden = SCENE.garden.camera;

  check(
    "the desktop camera configuration is untouched",
    SCENE.camera.position.join(",") === "0.9,2.5,5.2" &&
      SCENE.camera.lookAt.join(",") === "0,1.25,0" &&
      SCENE.camera.fov === 45,
    `position=[${SCENE.camera.position}] lookAt=[${SCENE.camera.lookAt}] fov=${SCENE.camera.fov}`,
  );

  check(
    "the garden carries its own camera tuning",
    Array.isArray(garden.offset) &&
      garden.offset.length === 3 &&
      typeof garden.lookAtDrop === "number" &&
      Array.isArray(garden.travel) &&
      garden.travel.length === 3,
    `offset=[${garden.offset}] lookAtDrop=${garden.lookAtDrop} travel=[${garden.travel}]`,
  );

  // Same architecture, gently re-aimed: closer and flatter than the shared
  // framing, never a different camera.
  const shared = new Vector3(...SCENE.camera.position).sub(new Vector3(...SCENE.butterfly.start));
  const gardenOffset = new Vector3(...garden.offset);
  const sharedPitch = Math.asin(shared.y / shared.length());
  const gardenPitch = Math.asin(
    (gardenOffset.y + garden.lookAtDrop) / gardenOffset.length(),
  );
  check(
    "the garden framing is the same shot, a little closer and flatter",
    gardenOffset.length() < shared.length() && gardenPitch < sharedPitch,
    `distance ${shared.length().toFixed(2)} -> ${gardenOffset.length().toFixed(2)}, pitch ${(
      (sharedPitch * 180) /
      Math.PI
    ).toFixed(1)}deg -> ${((gardenPitch * 180) / Math.PI).toFixed(1)}deg`,
  );

  // The travel clamps are sized so no clamp engages anywhere in the garden
  // flight volume: the framing has to hold at the edges, because that is
  // exactly where the butterfly investigates the near-wall flowers.
  const area = gardenFlightArea(
    SCENE.garden.windowSize.width / SCENE.garden.windowSize.height,
    SCENE.garden,
  );
  const parallax = DEFAULT_CAMERA_TUNING.parallax;
  const clamped = [];
  for (const x of [area.min[0], area.max[0]]) {
    for (const y of [area.min[1], area.max[1]]) {
      for (const z of [area.min[2], area.max[2]]) {
        for (const px of [-parallax, parallax]) {
          const desired = new Vector3(x, y, z).add(gardenOffset).add(new Vector3(px, 0, 0));
          const cx = Math.max(-garden.travel[0], Math.min(garden.travel[0], desired.x));
          const cy = Math.max(
            gardenOffset.y - garden.travel[1],
            Math.min(gardenOffset.y + garden.travel[1], desired.y),
          );
          const cz = Math.max(
            gardenOffset.z - garden.travel[2],
            Math.min(gardenOffset.z + garden.travel[2], desired.z),
          );
          if (
            Math.abs(cx - desired.x) > 1e-9 ||
            Math.abs(cy - desired.y) > 1e-9 ||
            Math.abs(cz - desired.z) > 1e-9
          ) {
            clamped.push(`(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`);
          }
        }
      }
    }
  }
  check(
    "the garden travel clamps never engage inside the flight volume",
    clamped.length === 0,
    clamped.length === 0
      ? `8 volume corners x parallax stay inside travel=[${garden.travel}]`
      : clamped.join(" "),
  );

  // And the rig still behaves on the garden's tuning: a real flight across the
  // garden keeps the butterfly framed and the rig smooth.
  const gardenRig = new CameraRig({
    ...DEFAULT_CAMERA_TUNING,
    offset: [garden.offset[0], garden.offset[1], garden.offset[2]],
    lookAtDrop: garden.lookAtDrop,
    travel: [garden.travel[0], garden.travel[1], garden.travel[2]],
  });
  const gardenFlight = new FlightController(
    { ...DEFAULT_FLIGHT_TUNING, area },
    new Vector3(0, 1.4, 0),
    mulberry32(55),
  );
  const gardenCamera = new PerspectiveCamera(
    SCENE.camera.fov,
    SCENE.garden.windowSize.width / SCENE.garden.windowSize.height,
    SCENE.camera.near,
    SCENE.camera.far,
  );
  // Start at the garden's home framing, or the first frames would measure the
  // rig's catch-up from the origin rather than the flight.
  gardenCamera.position
    .set(SCENE.butterfly.start[0], SCENE.butterfly.start[1], SCENE.butterfly.start[2])
    .add(gardenOffset);
  gardenFlight.seekTo(new Vector3(area.max[0] - 0.3, area.max[1] - 0.3, area.max[2] - 0.3));
  let gardenSnap = 0;
  let gardenOnScreen = true;
  const before = new Vector3();
  for (let i = 0; i < 60 * 30; i++) {
    gardenFlight.step(dt);
    before.copy(gardenCamera.position);
    gardenRig.update(
      dt,
      gardenFlight.position,
      { x: 0, y: 0 },
      gardenCamera.position,
      gardenFlight.userTarget,
    );
    gardenCamera.lookAt(gardenRig.lookPoint);
    gardenSnap = Math.max(gardenSnap, gardenCamera.position.distanceTo(before));
    gardenCamera.updateMatrixWorld(true);
    const ndc = gardenFlight.position.clone().project(gardenCamera);
    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z > 1) gardenOnScreen = false;
  }
  check(
    "the butterfly stays framed and the garden rig never snaps",
    gardenOnScreen && gardenSnap < 0.5,
    `max step=${gardenSnap.toFixed(3)}/frame`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
