/**
 * Unit tests for the desktop coordinate space and the hit-test zone (dev
 * only). These are the pieces that make the overlay desktop-level: explicit
 * coordinate conversions and selective click-through with hysteresis.
 *
 * Usage: node tools/test-desktop-space.mjs
 */
import { Vector2 } from "three";
import {
  clientToNdc,
  desktopToClient,
  desktopToNdc,
  fallbackGeometry,
  toLogicalDesktop,
} from "../src/lib/desktop/geometry.ts";
import { HitZone } from "../src/lib/desktop/hittest.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

// A 1920x1080-class work area at 125% DPI, offset from the desktop origin
// (taskbar on the left edge, for example).
const geometry = {
  originX: 64,
  originY: 0,
  width: 1536,
  height: 1080,
  scaleFactor: 1.25,
};

// --- DPI: physical -> logical is a pure scale ---------------------------
{
  const logical = toLogicalDesktop(geometry, 1920, 540);
  check(
    "physical cursor px converts to logical px via the scale factor",
    Math.abs(logical.x - 1536) < 1e-9 && Math.abs(logical.y - 432) < 1e-9,
    `1920px @1.25 -> ${logical.x}`,
  );
}

// --- Desktop -> client: pure origin shift (the overlay covers the area) --
{
  const client = desktopToClient(geometry, 64, 0);
  check(
    "work-area origin maps to overlay (0,0)",
    client.x === 0 && client.y === 0,
    `(${client.x}, ${client.y})`,
  );
  const far = desktopToClient(geometry, 64 + 1536, 1080);
  check(
    "work-area far corner maps to overlay (width,height)",
    far.x === 1536 && far.y === 1080,
    `(${far.x}, ${far.y})`,
  );
}

// --- Client -> NDC: the full overlay maps onto the full NDC range -------
{
  const ndc = new Vector2();
  clientToNdc(geometry, 0, 0, ndc);
  const topLeft = ndc.clone();
  clientToNdc(geometry, geometry.width, geometry.height, ndc);
  const bottomRight = ndc.clone();
  clientToNdc(geometry, geometry.width / 2, geometry.height / 2, ndc);
  check(
    "overlay corners map to NDC corners",
    topLeft.x === -1 &&
      topLeft.y === 1 &&
      bottomRight.x === 1 &&
      bottomRight.y === -1 &&
      Math.abs(ndc.x) < 1e-9 &&
      Math.abs(ndc.y) < 1e-9,
    `TL=(${topLeft.x},${topLeft.y}) BR=(${bottomRight.x},${bottomRight.y}) centre=(${ndc.x},${ndc.y})`,
  );
}

// --- Desktop -> NDC in one step -----------------------------------------
{
  const ndc = new Vector2();
  desktopToNdc(geometry, 64, 0, ndc);
  check(
    "desktop work-area origin maps to NDC (-1, 1)",
    ndc.x === -1 && ndc.y === 1,
    `(${ndc.x}, ${ndc.y})`,
  );
  desktopToNdc(geometry, 64 + 1536 / 2, 540, ndc);
  check(
    "desktop work-area centre maps to NDC (0, 0)",
    Math.abs(ndc.x) < 1e-9 && Math.abs(ndc.y) < 1e-9,
    `(${ndc.x.toFixed(3)}, ${ndc.y.toFixed(3)})`,
  );
}

// --- Fallback geometry (dev harness) is the plain viewport ---------------
{
  const fallback = fallbackGeometry(1000, 700);
  const ndc = new Vector2();
  desktopToNdc(fallback, 500, 350, ndc);
  check(
    "fallback geometry treats the viewport as the desktop",
    fallback.originX === 0 &&
      fallback.scaleFactor === 1 &&
      Math.abs(ndc.x) < 1e-9 &&
      Math.abs(ndc.y) < 1e-9,
    `centre -> (${ndc.x}, ${ndc.y})`,
  );
}

// --- Hit-test zone: hysteresis, no flicker -------------------------------
{
  const zone = new HitZone(90, 150);

  check("overlay starts click-through", zone.isInteractive === false);

  // Far away: stays click-through.
  check("far cursor keeps click-through", zone.update(500) === false);

  // Close: becomes interactive.
  check("close cursor enables interaction", zone.update(60) === true);

  // Inside the hysteresis band the state must not change — in either
  // direction and however often it oscillates.
  let stable = true;
  for (const d of [95, 145, 100, 140, 120, 95, 145]) {
    if (zone.update(d) !== true) stable = false;
  }
  check("hysteresis band never flickers (interactive holds)", stable);

  // Beyond the exit radius: back to click-through.
  check("distant cursor restores click-through", zone.update(160) === false);

  // And the band also holds from the click-through side.
  stable = true;
  for (const d of [95, 145, 100, 140, 120, 95, 145]) {
    if (zone.update(d) !== false) stable = false;
  }
  check("hysteresis band never flickers (click-through holds)", stable);

  // Re-entering re-enables.
  check("re-entering the zone re-enables interaction", zone.update(50) === true);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
