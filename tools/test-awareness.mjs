/**
 * Desktop awareness tests (dev only, fully deterministic).
 *
 * Awareness is pure fact-keeping, so every case here is a table: a synthetic
 * desktop snapshot in, exact numbers out. No Windows, no Tauri, no rendering.
 * World-space cases compare against the real camera projection with a
 * tolerance rather than exact floats, because they invert a projection.
 *
 * Usage: node tools/test-awareness.mjs
 */
import { PerspectiveCamera, Vector3 } from "three";
import {
  computeWorkAreaInsets,
  viewportEnvironment,
} from "../src/lib/desktop/environment.ts";
import {
  cursorInsideWorkArea,
  desktopPointToNdc,
  describeWorkArea,
  distanceToCorner,
  distanceToNearestWorkAreaEdge,
  distanceToRect,
  distanceToForegroundWindow,
  distancesToWorkAreaEdges,
  isPointInsideForegroundWindow,
  isPointInsideRect,
  rectBounds,
  toWorkAreaLocal,
  worldBoundsForDesktopRect,
  worldEdgeMap,
  } from "../src/lib/awareness.ts";
import { flightAreaForAspect } from "../src/lib/airspace.ts";
import { SCENE } from "../src/config/experience.ts";
import { FlightController } from "../src/lib/flight.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

/** Builds a snapshot the way the native loader would, from logical rects. */
const environment = (monitor, workArea, scaleFactor = 1) => ({
  scaleFactor,
  monitor,
  workArea,
  insets: computeWorkAreaInsets(monitor, workArea),
});

const rect = (originX, originY, width, height) => ({ originX, originY, width, height });

// --- Case 1: normal monitor with a bottom-docked bar ------------------------
{
  const env = environment(rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1040));
  check(
    "bottom inset is the monitor/work-area difference",
    env.insets.bottom === 40 &&
      env.insets.left === 0 &&
      env.insets.right === 0 &&
      env.insets.top === 0,
    JSON.stringify(env.insets),
  );

  const awareness = describeWorkArea(env);
  check(
    "work area is recognised as smaller than the monitor",
    awareness.workAreaDiffersFromMonitor === true,
  );

  const corners = awareness.corners;
  check(
    "corners are the work area's, in logical desktop pixels",
    corners["top-left"].x === 0 &&
      corners["top-left"].y === 0 &&
      corners["bottom-right"].x === 1920 &&
      corners["bottom-right"].y === 1040 &&
      Object.keys(corners).length === 4,
  );

  // Centre of the work area: equidistant from left/right, 520 from each
  // vertical edge.
  const centre = distancesToWorkAreaEdges({ x: 960, y: 520 }, env);
  check(
    "edge distances are measured to the work area",
    near(centre.left, 960) &&
      near(centre.right, 960) &&
      near(centre.top, 520) &&
      near(centre.bottom, 520),
    JSON.stringify(centre),
  );
  check(
    "nearest-edge distance is the smallest of the four",
    near(distanceToNearestWorkAreaEdge({ x: 100, y: 500 }, env), 100),
  );
}

// --- Case 2: left/top insets, non-zero work-area origin ----------------------
{
  const env = environment(rect(0, 0, 1920, 1080), rect(80, 60, 1840, 1020));
  check(
    "left and top insets are derived independently",
    env.insets.left === 80 && env.insets.top === 60,
    JSON.stringify(env.insets),
  );
  check(
    "the far edges stay flush when only left/top are inset",
    env.insets.right === 0 && env.insets.bottom === 0,
    JSON.stringify(env.insets),
  );
  check(
    "a work-area origin shifts every edge, not just the first",
    near(distancesToWorkAreaEdges({ x: 80, y: 60 }, env).left, 0) &&
      near(distancesToWorkAreaEdges({ x: 1920, y: 1080 }, env).right, 0) &&
      near(distancesToWorkAreaEdges({ x: 1920, y: 1080 }, env).bottom, 0),
  );

  // A point left of the work-area origin reads as negative (outside), not clamped.
  const outside = distancesToWorkAreaEdges({ x: 10, y: 500 }, env);
  check(
    "a point outside the work area reports a negative distance",
    outside.left === -70,
    `left=${outside.left}`,
  );
}

// --- Case 3: negative monitor origin (secondary-monitor coordinates) ---------
{
  const env = environment(rect(-1920, 0, 1920, 1080), rect(-1920, 0, 1920, 1040));
  check(
    "negative origins are preserved, not normalised away",
    env.monitor.originX === -1920 && env.workArea.originX === -1920,
  );
  check(
    "insets are unaffected by a negative origin",
    env.insets.bottom === 40 &&
      env.insets.left === 0 &&
      env.insets.right === 0 &&
      env.insets.top === 0,
    JSON.stringify(env.insets),
  );
  const centre = distancesToWorkAreaEdges({ x: -960, y: 520 }, env);
  check(
    "edge distances stay correct in negative desktop space",
    near(centre.left, 960) && near(centre.right, 960),
    JSON.stringify(centre),
  );
  check(
    "cursor inside/outside is decided in negative desktop space",
    // The work area spans x = -1920 .. 0 here, so -1900 is inside it and
    // -2000 is beyond the monitor's left edge.
    cursorInsideWorkArea({ x: -1900, y: 100 }, env) === true &&
      cursorInsideWorkArea({ x: -2000, y: 100 }, env) === false &&
      cursorInsideWorkArea({ x: -100, y: 1100 }, env) === false,
  );
  // Local (overlay) coordinates are still origin-relative.
  const local = toWorkAreaLocal({ x: -1820, y: 300 }, env);
  check(
    "desktop -> overlay local conversion subtracts the origin",
    local.x === 100 && local.y === 300,
    JSON.stringify(local),
  );
}

// --- Case 4: asymmetric insets on all four sides -----------------------------
{
  const env = environment(
    rect(100, 200, 2560, 1440),
    rect(140, 240, 2400, 1160),
  );
  check(
    "all four insets are derived independently",
    env.insets.left === 40 &&
      env.insets.top === 40 &&
      env.insets.right === 120 &&
      env.insets.bottom === 240,
    JSON.stringify(env.insets),
  );
  const middle = distancesToWorkAreaEdges({ x: 140 + 1200, y: 240 + 580 }, env);
  check(
    "an asymmetric work area measures each edge correctly",
    near(middle.left, 1200) &&
      near(middle.right, 1200) &&
      near(middle.top, 580) &&
      near(middle.bottom, 580),
    JSON.stringify(middle),
  );
  check(
    "the monitor rect is reported alongside the work area",
    describeWorkArea(env).monitor.width === 2560 &&
      describeWorkArea(env).monitor.originY === 200,
  );
}

// --- Case 5: no insets at all (auto-hide / no reserved edges) ---------------
{
  const env = environment(rect(0, 0, 2560, 1400), rect(0, 0, 2560, 1400));
  check(
    "identical monitor and work area produce zero insets",
    Object.values(env.insets).every((v) => v === 0),
    JSON.stringify(env.insets),
  );
  check(
    "zero insets are valid, not an error",
    describeWorkArea(env).workAreaDiffersFromMonitor === false,
  );
  // Degenerate input is clamped rather than reported as a negative inset.
  const rounded = computeWorkAreaInsets(
    rect(0, 0, 100, 100),
    rect(0, 0, 100.4, 100.4),
  );
  check(
    "a work area marginally larger than the monitor clamps to zero",
    Object.values(rounded).every((v) => v === 0),
    JSON.stringify(rounded),
  );
}

// --- Case 6: web fallback ----------------------------------------------------
{
  const a = viewportEnvironment(1440, 900);
  const b = viewportEnvironment(1440, 900);
  check(
    "the viewport fallback is deterministic",
    JSON.stringify(a) === JSON.stringify(b),
  );
  check(
    "the viewport fallback treats the viewport as the whole desktop",
    a.workArea.width === 1440 &&
      a.workArea.height === 900 &&
      a.monitor.width === 1440 &&
      a.scaleFactor === 1 &&
      a.insets.bottom === 0,
    JSON.stringify(a),
  );
  const degenerate = viewportEnvironment(0, Number.NaN);
  check(
    "a degenerate viewport still yields a usable snapshot",
    degenerate.workArea.width > 0 &&
      degenerate.workArea.height > 0 &&
      Number.isFinite(degenerate.workArea.width),
    JSON.stringify(degenerate.workArea),
  );
  check(
    "cursor containment works on the fallback snapshot",
    cursorInsideWorkArea({ x: 10, y: 10 }, a) === true &&
      cursorInsideWorkArea({ x: -1, y: 10 }, a) === false &&
      cursorInsideWorkArea({ x: 1441, y: 10 }, a) === false,
  );
  check(
    "logical desktop -> NDC uses the work area as the viewport",
    near(desktopPointToNdc({ x: 0, y: 0 }, a).x, -1) &&
      near(desktopPointToNdc({ x: 1440, y: 900 }, a).x, 1) &&
      near(desktopPointToNdc({ x: 0, y: 0 }, a).y, 1),
  );
}

// --- Case 7: world mapping agrees with the real projection -------------------
{
  const makeCamera = (width, height) => {
    const camera = new PerspectiveCamera(
      SCENE.camera.fov,
      width / height,
      SCENE.camera.near,
      SCENE.camera.far,
    );
    camera.position.set(...SCENE.camera.position);
    camera.lookAt(...SCENE.camera.lookAt);
    camera.updateMatrixWorld(true);
    return camera;
  };

  for (const [width, height] of [
    [1920, 1040],
    [1920, 1080],
    [2560, 1400],
    [1280, 680],
  ]) {
    const env = environment(rect(0, 0, width, height + 40), rect(0, 0, width, height));
    const camera = makeCamera(width, height);
    const volume = flightAreaForAspect(width / height);
    const map = worldEdgeMap(camera, volume);

    // The solved edges must actually project onto the frame borders.
    const leftNdc = new Vector3(map.left, map.reference.y, map.reference.z).project(camera);
    const rightNdc = new Vector3(map.right, map.reference.y, map.reference.z).project(camera);
    const topNdc = new Vector3(0, map.top, map.reference.z).project(camera);
    const bottomNdc = new Vector3(0, map.bottom, map.reference.z).project(camera);

    check(
      `world edges land on the frame borders at ${width}x${height}`,
      near(leftNdc.x, -1, 1e-4) &&
        near(rightNdc.x, 1, 1e-4) &&
        near(topNdc.y, 1, 1e-4) &&
        near(bottomNdc.y, -1, 1e-4),
      `ndc x=[${leftNdc.x.toFixed(4)}, ${rightNdc.x.toFixed(4)}] y=[${bottomNdc.y.toFixed(4)}, ${topNdc.y.toFixed(4)}]`,
    );

    // The reachable volume must be strictly inside the work area on every edge.
    const insets = map.reachableInsets;
    check(
      `the reachable volume stays inside the work area at ${width}x${height}`,
      insets.left > 0 && insets.right > 0 && insets.top > 0 && insets.bottom > 0,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(insets).map(([k, v]) => [k, Number(v.toFixed(2))]),
        ),
      ),
    );
    check(
      `edge ordering is left < right and bottom < top at ${width}x${height}`,
      map.left < map.right && map.bottom < map.top,
    );
  }

  // A real FlightArea is structurally accepted: awareness does not import the
  // flight controller, yet its own volume works with one.
  const controller = new FlightController(
    SCENE.flight,
    new Vector3(0, 1.4, 0),
  );
  const camera = makeCamera(1920, 1040);
  const withController = worldEdgeMap(camera, controller.area);
  check(
    "a FlightController area can be passed straight in",
    Number.isFinite(withController.left) && withController.left < controller.area.min[0],
    `left=${withController.left.toFixed(2)} area.min.x=${controller.area.min[0].toFixed(2)}`,
  );

  // Corner distance uses the same authoritative geometry.
  const env = environment(rect(0, 0, 1920, 1040), rect(0, 0, 1920, 1040));
  const corners = describeWorkArea(env).corners;
  check(
    "corner distance is euclidean from the same geometry",
    near(distanceToCorner({ x: 0, y: 0 }, corners["top-left"]), 0) &&
      near(distanceToCorner({ x: 300, y: 400 }, corners["top-left"]), 500) &&
      near(distanceToCorner({ x: 1920, y: 1040 }, corners["bottom-right"]), 0),
  );
}

// --- Phase 13B.2: pure foreground-window awareness --------------------------
{
  const windowRect = { originX: 100, originY: 80, width: 1200, height: 800 };
  // Inside / outside / exactly on the edge.
  check(
    "a point inside the window is inside",
    isPointInsideForegroundWindow({ x: 700, y: 500 }, windowRect),
  );
  check(
    "a point outside the window is outside",
    !isPointInsideForegroundWindow({ x: 10, y: 500 }, windowRect),
  );
  check(
    "a point exactly on the edge belongs to the inside",
    isPointInsideForegroundWindow({ x: windowRect.originX, y: windowRect.originY }, windowRect) &&
      isPointInsideForegroundWindow(
        { x: windowRect.originX + windowRect.width - 1, y: windowRect.originY + windowRect.height - 1 },
        windowRect,
      ),
  );
  check(
    "a point past the far edge is outside",
    !isPointInsideForegroundWindow(
      { x: windowRect.originX + windowRect.width, y: windowRect.originY + windowRect.height },
      rect,
    ),
  );
  check(
    "no foreground window means nothing is inside it",
    !isPointInsideForegroundWindow({ x: 700, y: 500 }, null),
  );

  // Distance: zero inside, nearest-point Euclidean outside.
  check(
    "distance inside the window is zero",
    distanceToForegroundWindow({ x: 700, y: 500 }, windowRect) === 0,
  );
  check(
    "distance to a side is the perpendicular distance",
    near(distanceToForegroundWindow({ x: 40, y: 500 }, windowRect), 60),
    `${distanceToForegroundWindow({ x: 40, y: 500 }, windowRect)}`,
  );
  check(
    "distance to a corner is euclidean to the nearest point",
    near(distanceToForegroundWindow({ x: 40, y: 20 }, windowRect), Math.hypot(60, 60)),
    `${distanceToForegroundWindow({ x: 40, y: 20 }, windowRect)}`,
  );
  check(
    "distance works below and to the left of the desktop origin",
    near(
      distanceToForegroundWindow({ x: -1000, y: 100 }, { originX: -900, originY: 50, width: 700, height: 600 }),
      100,
    ),
  );
  check(
    "no foreground window means an infinite distance, not a fake one",
    distanceToForegroundWindow({ x: 0, y: 0 }, null) === Number.POSITIVE_INFINITY,
  );

  // The desktop -> world bridge the flight layer consumes.
  {
    const env = environment(rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1040));
    const camera = new PerspectiveCamera(
      SCENE.camera.fov,
      1920 / 1040,
      SCENE.camera.near,
      SCENE.camera.far,
    );
    camera.position.set(...SCENE.camera.position);
    camera.lookAt(...SCENE.camera.lookAt);
    camera.updateMatrixWorld(true);
    const volume = flightAreaForAspect(1920 / 1040);
    const world = worldBoundsForDesktopRect(camera, windowRect, env, volume);
    check(
      "a desktop rectangle maps to a world box",
      world !== null && world.maxX > world.minX && world.maxY > world.minY,
      JSON.stringify(world),
    );
    // The left/top edges of the window must land left/below the reachable area,
    // and the right/bottom edges right/above it, because the window covers most
    // of the screen.
    // The invariant that matters: each world edge projects back onto the
    // window's own screen edge, so the box really is "that window" in world
    // space rather than an approximation.
    const px = (x, y) => {
      const v = new Vector3(x, y, world.referenceZ ?? (volume.min[2] + volume.max[2]) / 2).project(camera);
      return [((v.x + 1) / 2) * 1920, ((1 - v.y) / 2) * 1040];
    };
    const leftPx = px(world.minX, (volume.min[1] + volume.max[1]) / 2);
    const rightPx = px(world.maxX, (volume.min[1] + volume.max[1]) / 2);
    check(
      "the world box edges project back onto the window's screen edges",
      near(leftPx[0], windowRect.originX, 0.5) &&
        near(rightPx[0], windowRect.originX + windowRect.width, 0.5),
      `projected x=[${leftPx[0].toFixed(1)}, ${rightPx[0].toFixed(1)}] expected=[${windowRect.originX}, ${windowRect.originX + windowRect.width}]`,
    );
    check(
      "a degenerate rectangle yields no box rather than a broken one",
      worldBoundsForDesktopRect(camera, { originX: 10, originY: 10, width: 0, height: 0 }, env, volume) === null,
    );
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
