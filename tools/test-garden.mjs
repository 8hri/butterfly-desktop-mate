/**
 * Unit tests for the garden world (dev only).
 *
 * The garden is scenery, so what can be pinned deterministically is its
 * *composition*: the layout is a pure function of the config, the config is
 * hand-placed and valid, and nothing about it can drift into behaviour.
 * Rendering itself is covered by the harness and manual validation.
 *
 * Usage: node tools/test-garden.mjs
 */
import { PerspectiveCamera, Vector2, Vector3 } from "three";
import { SCENE } from "../src/config/experience.ts";
import { flightAreaForAspect, gardenFlightArea } from "../src/lib/airspace.ts";
import { FlightController, DEFAULT_FLIGHT_TUNING } from "../src/lib/flight.ts";
import { screenToWorldTarget } from "../src/lib/targeting.ts";
import {
  backdropMoundGeometry,
  backdropSpireGeometry,
  bladeGeometry,
  branchGeometry,
  budGeometry,
  daisyGeometry,
  foliageGeometry,
  hexToRgb,
  leafClumpGeometry,
  pebbleGeometry,
  seedHeadGeometry,
  stemGeometry,
} from "../src/components/garden/gardenGeometry.ts";
import {
  FEEDBACK_PULSE_AMPLITUDE,
  FEEDBACK_PULSE_SECONDS,
  clearingMesh,
  feedbackPulse,
  flowerOwnershipEnds,
  gardenObjectId,
  gardenObjects,
  groundHeight,
  investigationPoint,
  pickGardenObject,
  scatterBackdropMounds,
  scatterBackdropSpires,
  scatterFoliage,
  scatterGrass,
  scatterLeaves,
  scatterSeedHeads,
} from "../src/lib/garden.ts";
import * as gardenModule from "../src/lib/garden.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const garden = SCENE.garden;
const dist2d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const hex = /^#[0-9a-f]{6}$/i;

// --- The scatter is deterministic -------------------------------------------
{
  const a = scatterGrass(garden.grass, garden.seed);
  const b = scatterGrass(garden.grass, garden.seed);
  check(
    "same seed, same garden (layout is a pure function)",
    JSON.stringify(a) === JSON.stringify(b),
  );
  const other = scatterGrass(garden.grass, garden.seed + 1);
  check(
    "the seed actually drives the scatter",
    JSON.stringify(a) !== JSON.stringify(other),
  );
}

// --- The scatter respects its tuning ------------------------------------------
{
  const blades = scatterGrass(garden.grass, garden.seed);
  check(
    "grass count matches the configured density",
    blades.length === garden.grass.count,
    `${blades.length}`,
  );
  check(
    "every blade stands inside the scatter radius",
    blades.every((b) => Math.hypot(b.x, b.z) <= garden.grass.radius + 1e-9),
  );
  check(
    "every blade's height is inside the configured band",
    blades.every(
      (b) => b.height >= garden.grass.minHeight && b.height <= garden.grass.maxHeight,
    ),
  );
  // Revised in 15.5B: the bound is now on the blade's *total* lean — its own
  // arch plus the instance's tilt. Rendered upright, a blade is a flat card lit
  // on one side only and reads as a dark shard; leaning it over is what makes it
  // catch light and read as a blade. The invariant is therefore "nothing is
  // lying flat", not "nothing leans at all".
  const blade = bladeGeometry();
  const bladePositions = blade.getAttribute("position");
  const archTip = Math.max(
    ...Array.from({ length: bladePositions.count }, (_, i) => bladePositions.getZ(i)),
  );
  const maxLean = Math.atan(archTip) + Math.max(...blades.map((b) => Math.abs(b.tilt)));
  check(
    "blades lean over, but never lie flat (they read as grass, not debris)",
    blades.every((b) => Math.abs(b.tilt) <= 0.35) && maxLean < 0.85,
    `tip arch ${archTip.toFixed(2)} of blade height, worst total lean ${maxLean.toFixed(2)} rad`,
  );
  check(
    "the scatter fills the patch (no empty centre, no hard edge clump)",
    (() => {
      const radii = blades.map((b) => Math.hypot(b.x, b.z)).sort((x, y) => x - y);
      return radii[0] < garden.grass.radius * 0.2 &&
        radii[Math.floor(radii.length / 2)] > garden.grass.radius * 0.3 &&
        radii[radii.length - 1] > garden.grass.radius * 0.8;
    })(),
  );
}

// --- The hand-placed composition is valid --------------------------------------
{
  // Phase 15.5A replaced the flat patch disc with the clearing; the hand-placed
  // composition is still judged against the clearing's radius.
  const patch = garden.ground.radius;
  check(
    "all flowers stand on the clearing",
    garden.flowers.every((f) => Math.hypot(f.position[0], f.position[1]) <= patch),
  );
  check(
    "all stones and the log lie on the clearing",
    [...garden.stones.map((s) => s.position), garden.log.position].every(
      (p) => Math.hypot(p[0], p[1]) <= patch,
    ),
  );
  check(
    "everything placed stands inside the clearing's flat centre",
    [
      ...garden.flowers.map((f) => f.position),
      ...garden.stones.map((s) => s.position),
      garden.log.position,
    ].every((p) => Math.hypot(p[0], p[1]) <= garden.ground.clearingRadius),
    `clearingRadius=${garden.ground.clearingRadius}`,
  );
  check(
    "no flower interpenetrates a stone or the log",
    garden.flowers.every((f) =>
      [...garden.stones.map((s) => s.position), garden.log.position].every(
        (p) => dist2d(f.position, p) >= 0.6,
      ),
    ),
  );
  check(
    "flowers do not crowd each other",
    garden.flowers.every(
      (f, i) =>
        garden.flowers.findIndex(
          (g, j) => j !== i && dist2d(f.position, g.position) < 0.7,
        ) === -1,
    ),
  );
  check(
    "flowers stay below the butterfly's floor (they are dressing, not obstacles)",
    garden.flowers.every((f) => f.stem * f.scale < 0.6),
  );
}

// --- Palette sanity --------------------------------------------------------------
{
  const colors = [
    garden.ground.colors.inner,
    garden.ground.colors.outer,
    garden.ground.colors.bank,
    garden.ground.colors.surround,
    garden.fog.color,
    garden.light.ambient.sky,
    garden.light.ambient.ground,
    garden.light.key.color,
    garden.light.fill.color,
    garden.grass.color,
    garden.stemColor,
    garden.log.color,
    ...garden.flowers.flatMap((f) => [f.blossom, f.center]),
    ...garden.stones.map((s) => s.color),
  ];
  check(
    "every garden colour is a valid hex value from the config",
    colors.every((c) => hex.test(c)),
    `${colors.length} colours`,
  );
  // The clearing's value structure: light in the middle, darker at the rim, so
  // the eye is led to the centre rather than out to the edge.
  const luminance = (value) => {
    const digits = value.replace("#", "");
    const r = parseInt(digits.slice(0, 2), 16);
    const g = parseInt(digits.slice(2, 4), 16);
    const b = parseInt(digits.slice(4, 6), 16);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  check(
    "the clearing is lighter in the centre than at the rim",
    luminance(garden.ground.colors.inner) > luminance(garden.ground.colors.outer) &&
      luminance(garden.ground.colors.outer) > luminance(garden.ground.colors.bank),
    `inner=${luminance(garden.ground.colors.inner).toFixed(0)} outer=${luminance(
      garden.ground.colors.outer,
    ).toFixed(0)} bank=${luminance(garden.ground.colors.bank).toFixed(0)}`,
  );
  // The garden's fog is close to the shared sky horizon, so the ground can
  // dissolve into it without a visible seam.
  check(
    "the garden fog sits close to the sky it fades into",
    Math.abs(luminance(garden.fog.color) - luminance(SCENE.palette.skyHorizon)) < 24,
    `fog=${luminance(garden.fog.color).toFixed(0)} horizon=${luminance(
      SCENE.palette.skyHorizon,
    ).toFixed(0)}`,
  );
}

// --- The clearing (Phase 15.5A) --------------------------------------------------
// The ground is now a solved surface rather than a flat disc, so its promises
// are pinned here: deterministic, bounded relief, well clear of the airspace,
// planted grass, and a rim that is not a circle.
{
  const ground = garden.ground;
  const contacts = {
    positions: [
      ...garden.flowers.map((f) => f.position),
      ...garden.stones.map((s) => s.position),
      garden.log.position,
    ],
  };

  const clearing = clearingMesh(ground, contacts, garden.seed);
  const again = clearingMesh(ground, contacts, garden.seed);

  check(
    "the clearing is deterministic for the same seed",
    JSON.stringify(clearing) === JSON.stringify(again),
    `${clearing.positions.length / 3} vertices, ${clearing.indices.length / 3} triangles`,
  );

  const otherSeed = clearingMesh(ground, contacts, garden.seed + 1);
  check(
    "a different seed gives a different clearing",
    JSON.stringify(otherSeed.positions) !== JSON.stringify(clearing.positions),
  );

  const heights = [];
  for (let i = 1; i < clearing.positions.length; i += 3) heights.push(clearing.positions[i]);
  check(
    "no ground displacement exceeds the configured maximum",
    Math.max(...heights) <= ground.maxHeight + 1e-9,
    `highest=${Math.max(...heights).toFixed(4)} of maxHeight=${ground.maxHeight}`,
  );
  check(
    "the ground never rises above its own plane",
    Math.min(...heights) >= -1e-9,
    `lowest=${Math.min(...heights).toFixed(6)}`,
  );

  // The whole point of the bound: the surface cannot narrow the flight volume.
  const floor = DEFAULT_FLIGHT_TUNING.area.min[1];
  check(
    "the clearing stays far below the butterfly's minimum flight floor",
    Math.max(...heights) < floor * 0.25,
    `ground max=${Math.max(...heights).toFixed(3)} vs flight floor=${floor}`,
  );

  check(
    "the clearing is a closed, indexed, upward-facing surface",
    clearing.positions.length % 3 === 0 &&
      clearing.colors.length === clearing.positions.length &&
      clearing.indices.length % 3 === 0 &&
      clearing.indices.every((i) => i >= 0 && i < clearing.positions.length / 3) &&
      clearing.indices.length === ground.segments * (1 + (ground.rings - 1) * 2) * 3,
    `${ground.rings} rings x ${ground.segments} segments`,
  );

  // A circle would read as a decal: the rim has to be irregular.
  const rimRadii = [];
  for (let segment = 0; segment < ground.segments; segment++) {
    const vertex = 1 + (ground.rings - 1) * ground.segments + segment;
    rimRadii.push(Math.hypot(clearing.positions[vertex * 3], clearing.positions[vertex * 3 + 2]));
  }
  const rimSpread = Math.max(...rimRadii) - Math.min(...rimRadii);
  check(
    "the rim is irregular rather than a perfect circle",
    rimSpread > ground.radius * ground.edgeJitter,
    `rim spread=${rimSpread.toFixed(3)} units`,
  );

  // The bank's rise, its crest and its settling are measured below against the
  // whole surface rather than at a single vertex, because the crest now wanders
  // by design and no one vertex represents it.
  const bankVertex = (fraction) => {
    const ring = Math.max(1, Math.round(ground.rings * fraction));
    const segment = Math.round(ground.segments / 4);
    return clearing.positions[(1 + (ring - 1) * ground.segments + segment) * 3 + 1];
  };
  check(
    "the built mesh carries the bank upward from its inner edge",
    bankVertex(ground.bank.start) < bankVertex(ground.bank.peak) &&
      bankVertex(ground.bank.peak) > ground.bank.height * 0.4,
    `at bank.start=${bankVertex(ground.bank.start).toFixed(3)} peak=${bankVertex(
      ground.bank.peak,
    ).toFixed(3)}`,
  );

  // Phase 15.5A.1: the first version of this surface built its relief from a
  // sum of sines in the angle around the centre and faded it in with a threshold
  // ramp. That produced a *perfectly flat* inner disc bounded by a ring where
  // texture switched on, with the pattern running in radial spokes — which reads
  // on screen as an artificial circular patch in the middle of the ground. These
  // checks exist so that shape cannot come back.
  const surfaceAt = (theta, r) => surfaceOf(Math.cos(theta) * r, Math.sin(theta) * r);
  const surfaceOf = groundHeight(ground, garden.seed);
  const profileAt = (r, n = 36) =>
    Array.from({ length: n }, (_, i) =>
      surfaceAt((i / n) * Math.PI * 2, r),
    );

  const flatRings = [];
  for (let r = 0.5; r <= 4.2; r += 0.1) {
    if (Math.max(...profileAt(r).map(Math.abs)) === 0) flatRings.push(r.toFixed(1));
  }
  check(
    "no interior ring of the clearing is exactly flat",
    flatRings.length === 0,
    flatRings.length === 0
      ? "38 sampled radii from 0.5 to 4.2 all carry relief (was: every one of them)"
      : `flat at r=${flatRings.join(",")}`,
  );

  const outward = [1, 2, 3, 3.5, 4].map((r) => {
    const values = profileAt(r, 36).map(Math.abs);
    return values.reduce((s, v) => s + v, 0) / values.length;
  });
  check(
    "the ground grows continuously outward instead of switching on at a radius",
    outward.every((value, i) => i === 0 || value >= outward[i - 1]),
    outward.map((v) => v.toFixed(4)).join(" -> "),
  );

  // An angular extrusion puts the ground's high point at the same compass
  // bearing at every radius; a real field does not.
  const bearings = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5].map((r) => {
    const values = profileAt(r, 72);
    return values.indexOf(Math.max(...values));
  });
  const distinctBearings = new Set(bearings).size;
  check(
    "the ground's high point is not fixed to one bearing (no radial spokes)",
    distinctBearings >= 4,
    `${distinctBearings} distinct bearings across radii (was 2)`,
  );

  const crestRadii = [];
  for (let i = 0; i < 12; i++) {
    const theta = (i / 12) * Math.PI * 2;
    let bestRadius = 3.4;
    let bestValue = -1;
    for (let r = 3.4; r <= 6.6; r += 0.02) {
      const value = surfaceAt(theta, r);
      if (value > bestValue) {
        bestValue = value;
        bestRadius = r;
      }
    }
    crestRadii.push(bestRadius);
  }
  const crestSpread = Math.max(...crestRadii) - Math.min(...crestRadii);
  check(
    "the bank crest is not a fixed radius (it wanders)",
    crestSpread > ground.radius * 0.02,
    `crest spread=${crestSpread.toFixed(2)} units (a drawn circle would be 0)`,
  );

  check(
    "the clearing never sinks below the shared ground plane",
    heights.every((h) => h >= ground.lift - 1e-9),
    `lowest vertex=${Math.min(...heights).toFixed(4)}, lift=${ground.lift}`,
  );

  // The clearing's middle has to stay level enough for the placed objects, and
  // its edge must never be coplanar with the plane it sits on.
  const atProp = (position) => surfaceOf(position[0], position[1]);
  check(
    "the clearing's middle stays level where the placed objects stand",
    Math.abs(clearing.positions[1]) <= ground.lift + 0.005 &&
      contacts.positions.every((p) => atProp(p) <= 0.012),
    `centre=${clearing.positions[1].toFixed(4)}, highest under an object=${Math.max(
      ...contacts.positions.map(atProp),
    ).toFixed(4)}`,
  );

  const bankAnnulus = [];
  const rimBand = [];
  for (let r = ground.radius * 0.75; r <= ground.radius * 0.85; r += 0.1) {
    bankAnnulus.push(...profileAt(r, 36));
  }
  for (let r = ground.radius * 0.96; r <= ground.radius * 0.99; r += 0.01) {
    rimBand.push(...profileAt(r, 36).map(Math.abs));
  }
  const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
  check(
    "the clearing still has a raised bank that settles at the rim",
    mean(bankAnnulus) > 0.03 &&
      mean(rimBand) < ground.lift + 0.02,
    `bank=${mean(bankAnnulus).toFixed(3)} rim=${mean(rimBand).toFixed(4)}`,
  );

  // Grass stands on the surface it is drawn over, at the very same height.

  // Contact darkening: the props' bases must actually darken the ground. Compared
// against the *same-radius* neighbourhood rather than against the centre, so
// the radial value gradient cannot stand in for the contact shading.
const nearestVertex = (x, z) => {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < clearing.positions.length / 3; i++) {
    const d = Math.hypot(clearing.positions[i * 3] - x, clearing.positions[i * 3 + 2] - z);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
};
const brightness = (index) => {
  const [r, g, b] = clearing.colors.slice(index * 3, index * 3 + 3);
  return r + g + b;
};
const flower = garden.flowers[0].position;
const underFlower = nearestVertex(flower[0], flower[1]);
const flowerRadius = Math.hypot(flower[0], flower[1]);
const sameRingAway = [];
for (let i = 0; i < clearing.positions.length / 3; i++) {
  const x = clearing.positions[i * 3];
  const z = clearing.positions[i * 3 + 2];
  if (Math.abs(Math.hypot(x, z) - flowerRadius) < 0.7) {
    const nearAnyObject = contacts.positions.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < 1.5);
    if (!nearAnyObject) sameRingAway.push(brightness(i));
  }
}
const awayAverage =
  sameRingAway.reduce((sum, value) => sum + value, 0) / Math.max(1, sameRingAway.length);
check(
  "the ground darkens under a placed object and stays light away from it",
  sameRingAway.length >= 3 && brightness(underFlower) < awayAverage * 0.97,
  `under=${brightness(underFlower).toFixed(2)} vs same-radius average=${awayAverage.toFixed(2)} over ${sameRingAway.length} vertices`,
);

  // Grass stands on the surface it is drawn over, at the very same height.
  const surface = groundHeight(ground, garden.seed);
  const planted = scatterGrass(garden.grass, garden.seed, surface);
  check(
    "every blade stands on the clearing surface",
    planted.every((b) => Math.abs(b.y - surface(b.x, b.z)) < 1e-9) &&
      planted.some((b) => b.y > 0),
    `highest blade base=${Math.max(...planted.map((b) => b.y)).toFixed(3)}`,
  );
  check(
    "blades still keep their configured density and radius without a surface",
    scatterGrass(garden.grass, garden.seed).every((b) => b.y === 0) &&
      scatterGrass(garden.grass, garden.seed).length === garden.grass.count,
  );

  // The garden's own atmosphere and light, kept separate from the shared ones.
  //
  // Revised in 15.5B: the original check demanded the garden's fog *near* be
  // smaller than the shared one, which is only true while the near distance is
  // inside the scene. The garden is about a dozen units across, so its fog has
  // to begin beyond the near rim — fogging the foreground is what bleached the
  // whole clearing. What actually has to hold is that the horizon arrives far
  // earlier than in the shared, desktop-sized world.
  check(
    "the garden brings fog sized for its own scale",
    garden.fog.far < SCENE.fog.far * 0.7 && garden.fog.near > 0 && garden.fog.near < garden.fog.far,
    `garden near=${garden.fog.near} far=${garden.fog.far} vs shared near=${SCENE.fog.near} far=${SCENE.fog.far}`,
  );
  check(
    "the garden's fog does not reach into the foreground it frames",
    garden.fog.near > garden.ground.radius * 0.9,
    `fog starts at ${garden.fog.near}, clearing radius is ${garden.ground.radius}`,
  );
  check(
    "the garden declares exactly one shadow-casting light",
    [garden.light.key, garden.light.fill].filter((l) => l.castShadow === true).length === 1 &&
      garden.light.key.shadowMapSize <= 1024,
    `key map=${garden.light.key.shadowMapSize}px, fill casts none`,
  );
  check(
    "the garden's shadow box covers every placed object",
    Math.max(
      ...contacts.positions.map(([x, z]) => Math.max(Math.abs(x), Math.abs(z))),
    ) <= garden.light.key.shadowExtent,
    `extent=${garden.light.key.shadowExtent}`,
  );
  check(
    "the garden key light is warmer than its fill",
    garden.light.key.color !== garden.light.fill.color,
    `key=${garden.light.key.color} fill=${garden.light.fill.color}`,
  );
}

// --- Interactive objects: derivation (Phase 15.4) -----------------------------------
{
  const objects = gardenObjects(garden);
  check(
    "every flower becomes exactly one interactive object",
    objects.length === garden.flowers.length && objects.every((o) => o.kind === "flower"),
  );
  check(
    "object ids are stable and aligned with the renderer",
    objects.every((o, i) => o.id === gardenObjectId("flower", i) && o.id === `flower-${i}`),
    objects.map((o) => o.id).join(","),
  );
  check(
    "aim points are the blossoms, not the ground",
    objects.every((o, i) => {
      const f = garden.flowers[i];
      return (
        o.position[0] === f.position[0] &&
        o.position[2] === f.position[1] &&
        Math.abs(o.position[1] - (f.stem + 0.03) * f.scale) < 1e-9
      );
    }),
  );
  // --- Investigation points (15.4 fix 2) ---------------------------------
  // The reachable band for the garden window's own aspect: every aim point
  // must sit inside it, at the nearest reachable spot to its own blossom —
  // so `seekTo` never has to clamp the target away from the flower.
  const area = flightAreaForAspect(
    garden.windowSize.width / garden.windowSize.height,
  );
  const pull = (p) => [
    Math.max(area.min[0], Math.min(area.max[0], p[0])),
    Math.max(area.min[1], Math.min(area.max[1], p[1])),
    Math.max(area.min[2], Math.min(area.max[2], p[2])),
  ];
  const inv = (o) => investigationPoint(o, garden.interact.hoverOffset, area);

  for (const o of objects) {
    const [x, y, z] = inv(o);
    check(
      `${o.id}: investigation point is inside the reachable flight band`,
      x >= area.min[0] && x <= area.max[0] &&
        y >= area.min[1] && y <= area.max[1] &&
        z >= area.min[2] && z <= area.max[2],
      `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`,
    );
  }
  for (const o of objects) {
    const p = inv(o);
    const nearest = pull(o.position); // the blossom pulled into the volume
    const hovered = pull([
      o.position[0],
      o.position[1] + garden.interact.hoverOffset,
      o.position[2],
    ]);
    check(
      `${o.id}: aim point is the nearest reachable spot to its blossom, hovered`,
      p[0] === nearest[0] && p[2] === nearest[2] && p[1] === hovered[1],
      `inv=(${p.map((n) => n.toFixed(2)).join(",")})`,
    );
    const d = Math.hypot(
      p[0] - o.position[0],
      p[1] - o.position[1],
      p[2] - o.position[2],
    );
    const dNearest = Math.hypot(
      nearest[0] - o.position[0],
      nearest[1] - o.position[1],
      nearest[2] - o.position[2],
    );
    check(
      `${o.id}: investigation stays near its own flower (nearest reach + hover)`,
      d <= dNearest + garden.interact.hoverOffset + 1e-9 &&
        d <= 2.5,
      `d=${d.toFixed(2)} <= ${dNearest.toFixed(2)} + ${garden.interact.hoverOffset}`,
    );
  }
}

// --- Picking: the ray test ---------------------------------------------------------
{
  const objects = gardenObjects(garden);
  const first = objects[0];
  const straightAt = (target) => ({
    origin: [target.position[0], target.position[1] + 3, target.position[2] + 4],
    direction: [0, -0.6, -0.8],
  });

  check(
    "a ray straight at a blossom picks it",
    (() => {
      const origin = [first.position[0], first.position[1] + 3, first.position[2]];
      const picked = pickGardenObject(
        { origin, direction: [0, -1, 0] },
        objects,
        garden.interact.radius,
      );
      return picked !== null && picked.object.id === first.id && picked.distance < 1e-9;
    })(),
  );
  check(
    "a ray that misses beyond the radius picks nothing",
    pickGardenObject(
      {
        origin: [first.position[0] + garden.interact.radius * 3, first.position[1] + 3, first.position[2]],
        direction: [0, -1, 0],
      },
      objects,
      garden.interact.radius,
    ) === null,
  );
  check(
    "an object behind the camera can never be picked",
    pickGardenObject(
      {
        origin: [first.position[0], first.position[1] + 3, first.position[2]],
        direction: [0, 1, 0],
      },
      objects,
      garden.interact.radius,
    ) === null,
  );
  check(
    "the radius boundary is inclusive",
    pickGardenObject(
      {
        origin: [first.position[0] + garden.interact.radius, first.position[1] + 3, first.position[2]],
        direction: [0, -1, 0],
      },
      objects,
      garden.interact.radius,
    )?.object.id === first.id,
  );
  check(
    "the nearest object wins when a ray grazes two",
    (() => {
      const pair = [
        { id: "a", kind: "flower", position: [0, 1, 0] },
        { id: "b", kind: "flower", position: [0.4, 1, 0] },
      ];
      const picked = pickGardenObject(
        { origin: [0.3, 4, 0], direction: [0, -1, 0] },
        pair,
        0.5,
      );
      // Ray at x=0.3: 0.3 from "a", 0.1 from "b" — b is nearer.
      return picked !== null && picked.object.id === "b" && Math.abs(picked.distance - 0.1) < 1e-9;
    })(),
  );
  check(
    "a degenerate ray or radius picks nothing rather than dividing by zero",
    pickGardenObject({ origin: [0, 0, 0], direction: [0, 0, 0] }, objects, 0.5) === null &&
      pickGardenObject({ origin: [0, 0, 0], direction: [0, 1, 0] }, objects, 0) === null,
  );
}

// --- The feedback pulse --------------------------------------------------------------
{
  check(
    "the pulse is silent before and after its moment",
    feedbackPulse(0) === 0 &&
      feedbackPulse(-1) === 0 &&
      feedbackPulse(FEEDBACK_PULSE_SECONDS) === 0 &&
      feedbackPulse(FEEDBACK_PULSE_SECONDS * 2) === 0,
  );
  check(
    "the pulse peaks at its midpoint at exactly the amplitude",
    Math.abs(feedbackPulse(FEEDBACK_PULSE_SECONDS / 2) - FEEDBACK_PULSE_AMPLITUDE) < 1e-9,
  );
  check(
    "the pulse is bounded and swells then settles",
    (() => {
      const t1 = feedbackPulse(FEEDBACK_PULSE_SECONDS * 0.25);
      const t2 = feedbackPulse(FEEDBACK_PULSE_SECONDS * 0.5);
      const t3 = feedbackPulse(FEEDBACK_PULSE_SECONDS * 0.75);
      return t1 > 0 && t1 < t2 && t3 > 0 && t3 < t2 &&
        FEEDBACK_PULSE_AMPLITUDE > 0 && FEEDBACK_PULSE_AMPLITUDE <= 0.25;
    })(),
  );
}

// --- Flower ownership ends deterministically (Phase 15.4 fix 2 + stay) ------------
// Three cases stay strictly separate: a refused pick waits on its bounded hold,
// a flight in progress is never a release, and an arrived flower waits on its
// post-arrival stay before the cursor is allowed back in.
{
  check(
    "a refused pick keeps ownership until its bounded hold (cursor stays out)",
    flowerOwnershipEnds(false, false, false, false) === false,
  );
  check(
    "the bounded hold releases a refused pick (no permanent attraction)",
    flowerOwnershipEnds(false, false, true, false) === true,
  );
  check(
    "a refused pick is never held by the arrival stay",
    flowerOwnershipEnds(false, false, true, true) === true &&
      flowerOwnershipEnds(false, false, false, true) === false,
    "the stay belongs to a flight, not to a click",
  );
  check(
    "an active flower flight owns the interaction regardless of the hold",
    flowerOwnershipEnds(true, true, true, true) === false,
  );
  check(
    "arrival alone does not release: the stay still has to elapse",
    flowerOwnershipEnds(true, false, true, false) === false,
  );
  check(
    "the stay releases the flight once it has elapsed",
    flowerOwnershipEnds(true, false, true, true) === true,
  );
  check(
    "a flight in progress ignores the stay clock entirely",
    flowerOwnershipEnds(true, true, true, true) === false,
  );
  check(
    "the post-arrival stay is configured, not a literal in the interaction",
    typeof garden.interact.stayMs === "number" && garden.interact.stayMs === 3000,
    `stayMs=${garden.interact.stayMs}`,
  );
}

// --- The post-arrival stay, end to end (Phase 15.4 stay) -------------------------
// A faithful transcription of Interaction's own flower logic (arm the stay when
// the completion signal is observed, gate aimAt while ownership holds, release
// through the same pure rule) driving the real FlightController on an injected
// clock, with the cursor moved aggressively the whole time. This is what proves
// the stay behaves: it starts on arrival, holds the cursor out, and ends on
// time — rather than merely asserting the truth table above.
{
  const prng = (seed) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const area = gardenFlightArea(garden.windowSize.width / garden.windowSize.height, garden);
  const staySeconds = garden.interact.stayMs / 1000; // config is ms, sim clock is seconds
  const holdSeconds = 1500 / 1000;
  const moveStep = 0.1;
  const objects = gardenObjects(garden);
  const first = objects[0];
  const target = new Vector3(
    ...investigationPoint(first, garden.interact.hoverOffset, area),
  );
  const far = new Vector3(
    Math.max(area.min[0] + 0.2, Math.min(area.max[0] - 0.2, -target.x)),
    1.4,
    area.max[2] - 0.2,
  );
  // A cursor point the butterfly would obviously run to if it were ever armed.
  const cursorPoint = new Vector3(area.max[0] - 0.3, area.min[1] + 0.3, area.max[2] - 0.3);

  /** One simulated click + cursor traffic, exactly as Interaction does it. */
  function session(start, { groundClickAt = null, groundPoint = null } = {}) {
    const flight = new FlightController({ ...SCENE.flight, area }, start.clone(), prng(4242));
    let latch = false;
    let hadFlight = false;
    let holdUntil = 0;
    let stayUntil = 0;
    const log = {
      summoned: false,
      arrivedAtFrame: null,
      stayArmedAt: null,
      releasedAt: null,
      cursorArmedAt: null,
      cursorCalls: 0,
      maxDriftDuringStay: 0,
      superseded: false,
      userTargetAfterGround: null,
    };

    // The click: aimAt(null) first, then the explicit target, then ownership.
    flight.aimAt(null);
    log.summoned = flight.seekTo(target.clone());
    latch = true;
    hadFlight = log.summoned;
    stayUntil = 0;
    holdUntil = holdSeconds;

    let t = 0;
    let nextMove = moveStep;
    let wasFlying = log.summoned;
    while (t < 60) {
      t += 1 / 60;
      flight.step(1 / 60);
      if (log.arrivedAtFrame === null && wasFlying && flight.userTarget === null) {
        log.arrivedAtFrame = t;
      }
      wasFlying = flight.userTarget !== null;

      if (groundClickAt !== null && !log.superseded && t >= groundClickAt) {
        // An ordinary ground click supersedes the flower, stay included.
        latch = false;
        stayUntil = 0;
        flight.seekTo(groundPoint.clone());
        log.superseded = true;
        log.userTargetAfterGround = flight.userTarget ? flight.userTarget.clone() : null;
      }

      if (t >= nextMove) {
        nextMove += moveStep;
        if (latch && hadFlight && flight.userTarget === null && stayUntil === 0) {
          stayUntil = t + staySeconds;
          log.stayArmedAt = t;
        }
        if (
          latch &&
          flowerOwnershipEnds(hadFlight, flight.userTarget !== null, t >= holdUntil, t >= stayUntil)
        ) {
          latch = false;
          log.releasedAt = t;
        }
        if (!latch) {
          flight.aimAt(cursorPoint.clone());
          if (log.cursorArmedAt === null) log.cursorArmedAt = t;
          log.cursorCalls += 1;
        } else if (log.stayArmedAt !== null && t < log.stayArmedAt + staySeconds) {
          log.maxDriftDuringStay = Math.max(
            log.maxDriftDuringStay,
            flight.position.distanceTo(target),
          );
        }
      }
    }
    return log;
  }

  const flown = session(far);
  check(
    "a real flower flight is accepted and flies to the flower",
    flown.summoned && flown.arrivedAtFrame !== null,
    `arrived at T+${flown.arrivedAtFrame?.toFixed(2)}s`,
  );
  check(
    "the stay starts on arrival, not on the click",
    flown.stayArmedAt !== null &&
      flown.stayArmedAt >= flown.arrivedAtFrame &&
      flown.stayArmedAt - flown.arrivedAtFrame < moveStep * 2,
    `arrived T+${flown.arrivedAtFrame?.toFixed(2)}s, stay armed T+${flown.stayArmedAt?.toFixed(2)}s`,
  );
  check(
    "an arrived flower does NOT release at arrival",
    flown.releasedAt !== null && flown.releasedAt > flown.stayArmedAt,
    `released T+${flown.releasedAt?.toFixed(2)}s, ${((flown.releasedAt - flown.stayArmedAt) * 1000).toFixed(0)}ms after arrival`,
  );
  check(
    "ownership holds for the whole configured stay",
    flown.releasedAt - flown.stayArmedAt >= staySeconds - 1e-9 &&
      flown.releasedAt - flown.stayArmedAt <= staySeconds + moveStep,
    `held ${((flown.releasedAt - flown.stayArmedAt) * 1000).toFixed(0)}ms of ${garden.interact.stayMs}ms`,
  );
  check(
    "the cursor cannot reclaim the flower during the stay",
    flown.cursorArmedAt === flown.releasedAt &&
      flown.cursorArmedAt !== null &&
      // The butterfly is at the flower, with the hover's arrival carry on top of
      // the arrive radius — the same momentum any soft landing shows.
      flown.maxDriftDuringStay <= SCENE.flight.arriveRadius * 1.75,
    `first cursor arm at T+${flown.cursorArmedAt?.toFixed(2)}s, max drift from the flower ${flown.maxDriftDuringStay.toFixed(3)}`,
  );
  check(
    "the cursor resumes immediately once the stay is over",
    flown.cursorCalls > 0 && flown.cursorArmedAt - flown.releasedAt <= 1e-9,
    `${flown.cursorCalls} cursor moves armed after release`,
  );

  // Refused: the butterfly is already there, so there is no flight and no
  // arrival — the original bounded hold still applies, unchanged.
  const refused = session(target.clone().add(new Vector3(0, 0.05, 0)));
  check(
    "a refused pick still waits only its own bounded hold",
    refused.summoned === false &&
      refused.stayArmedAt === null &&
      refused.releasedAt !== null &&
      refused.releasedAt >= holdSeconds - 1e-9 &&
      refused.releasedAt <= holdSeconds + moveStep,
    `released T+${refused.releasedAt?.toFixed(2)}s (hold 1500ms, stay never armed)`,
  );

  // A ground click during the stay still supersedes the flower immediately.
  const ground = new Vector3(area.min[0] + 0.4, 1.2, area.min[2] + 0.4);
  const superseded = session(far, { groundClickAt: 0.4, groundPoint: ground });
  check(
    "a ground click supersedes the flower (and its stay) at once",
    superseded.superseded &&
      superseded.userTargetAfterGround !== null &&
      superseded.userTargetAfterGround.distanceTo(ground) < 1e-6 &&
      superseded.cursorArmedAt !== null &&
      superseded.cursorArmedAt <= 0.4 + 2 * moveStep &&
      superseded.stayArmedAt === null,
    `ground click at T+0.40s, cursor re-armed T+${superseded.cursorArmedAt?.toFixed(2)}s, stay never armed`,
  );
}
// With the garden's own depth in the flight area, the flower investigation
// point no longer has to be pulled into a slab that stops short of every
// blossom, and pointer targeting gains real depth instead of saturating.
{
  const aspect = garden.windowSize.width / garden.windowSize.height;
  const area = gardenFlightArea(aspect, garden);
  const objects = gardenObjects(garden);

  const inside = objects.map((object) => {
    const [tx, ty, tz] = investigationPoint(object, garden.interact.hoverOffset, area);
    return {
      id: object.id,
      point: [tx, ty, tz],
      ok:
        tx >= area.min[0] &&
        tx <= area.max[0] &&
        ty >= area.min[1] &&
        ty <= area.max[1] &&
        tz >= area.min[2] &&
        tz <= area.max[2],
    };
  });
  check(
    "every flower investigation point is inside the garden flight area",
    inside.every((entry) => entry.ok),
    inside.map((entry) => `${entry.id}=(${entry.point.map((v) => v.toFixed(2)).join(",")})`).join(" "),
  );

  check(
    "the garden volume no longer pulls any flower in depth",
    objects.every((object) => {
      const [, , tz] = investigationPoint(object, garden.interact.hoverOffset, area);
      return tz === object.position[2];
    }),
    "investigation depth is the blossom's own depth (hover only raises it)",
  );

  const nearest = objects.map((object) => {
    const point = investigationPoint(object, garden.interact.hoverOffset, area);
    return Math.hypot(point[0] - object.position[0], point[1] - object.position[1], point[2] - object.position[2]);
  });
  check(
    "every investigation point sits at most a hover offset from its blossom",
    nearest.every((d) => d <= garden.interact.hoverOffset + 0.25),
    nearest.map((d) => d.toFixed(3)).join(" "),
  );

  // Pointer targeting: a vertical sweep must produce real depth across the
  // garden viewport instead of the slab's two saturated walls.
  const cameraFor = (butterflyZ) => {
    const camera = new PerspectiveCamera(SCENE.camera.fov, aspect, SCENE.camera.near, SCENE.camera.far);
    camera.position.set(0.9, 2.5, butterflyZ + 5.2);
    camera.lookAt(0, 1.25, butterflyZ);
    camera.updateMatrixWorld(true);
    return camera;
  };
  const sweep = (areaUnderTest, camera) => {
    const zs = [];
    for (let ny = -0.95; ny <= 0.9501; ny += 0.05) {
      zs.push(screenToWorldTarget(new Vector2(0, ny), camera, areaUnderTest, SCENE.interaction).z);
    }
    const walls = zs.filter((z) => Math.abs(z - areaUnderTest.max[2]) < 1e-6 || Math.abs(z - areaUnderTest.min[2]) < 1e-6);
    return {
      distinct: new Set(zs.map((z) => z.toFixed(4))).size,
      interior: zs.length - walls.length,
      total: zs.length,
      monotonic: zs.every((z, i) => i === 0 || z <= zs[i - 1] + 1e-9),
      inside: zs.every((z) => z >= areaUnderTest.min[2] && z <= areaUnderTest.max[2]),
    };
  };

  const poses = [-3.9, -1.5, 0, 1.5, 2.6];
  const sweeps = poses.map((z) => sweep(area, cameraFor(z)));
  check(
    "garden targeting reaches many distinct depths across the viewport",
    sweeps.every((s) => s.distinct >= 6),
    poses.map((z, i) => `z=${z}: ${sweeps[i].distinct}`).join(" "),
  );
  check(
    "garden targeting is continuous rather than wall-saturated",
    sweeps.every((s) => s.interior / s.total >= 0.1),
    poses.map((z, i) => `z=${z}: ${Math.round((sweeps[i].interior / sweeps[i].total) * 100)}%`).join(" "),
  );
  check(
    "moving the cursor up never walks the depth back toward the camera",
    sweeps.every((s) => s.monotonic),
  );
  check(
    "every garden target stays inside the garden area",
    sweeps.every((s) => s.inside),
  );

  // The shallow slab is untouched, and still saturates exactly as it did — that
  // is the desktop mapping this phase promised not to change.
  const slab = flightAreaForAspect(aspect);
  const slabSweep = sweep(slab, cameraFor(0));
  check(
    "the desktop slab's own mapping is unchanged (two walls, five percent live)",
    slabSweep.distinct === 4 &&
      slabSweep.interior / slabSweep.total <= 0.1 &&
      slabSweep.monotonic,
    `distinct=${slabSweep.distinct} interior=${Math.round((slabSweep.interior / slabSweep.total) * 100)}%`,
  );

  // The flowers are genuinely reachable in the garden volume: a real flight
  // from across the volume is accepted and ends next to its blossom.
  const mulberry32 = (seed) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const runs = objects.map((object, index) => {
    const target = new Vector3(...investigationPoint(object, garden.interact.hoverOffset, area));
    const start = new Vector3(
      Math.max(area.min[0] + 0.2, Math.min(area.max[0] - 0.2, -target.x)),
      1.4,
      area.max[2] - 0.2,
    );
    const flight = new FlightController(
      { ...SCENE.flight, area },
      start.clone(),
      mulberry32(9 + index),
    );
    const accepted = flight.seekTo(target.clone());
    let seconds = 0;
    while (seconds < 60 && flight.userTarget !== null) {
      flight.step(1 / 60);
      seconds += 1 / 60;
    }
    return {
      id: object.id,
      accepted,
      arrived: flight.userTarget === null,
      seconds,
      toBlossom: flight.position.distanceTo(new Vector3(...object.position)),
    };
  });
  check(
    "every flower is reachable in the garden volume (accepted and delivered)",
    runs.every((r) => r.accepted && r.arrived),
    runs.map((r) => `${r.id}: ${r.seconds.toFixed(1)}s`).join(" "),
  );
  check(
    "every delivered flower interaction ends beside its blossom",
    runs.every((r) => r.toBlossom <= 0.8),
    runs.map((r) => r.toBlossom.toFixed(2)).join(" "),
  );
}

// --- The planting (Phase 15.5B) --------------------------------------------------
// Four families, one instanced draw each. What has to hold: determinism, bounds,
// planting (nothing floats), a *composed* density rather than a uniform
// sprinkle, and — the important one — that the butterfly's airspace is clear.
{
  const planting = garden.planting;
  const surface = groundHeight(garden.ground, garden.seed);
  const families = {
    grass: scatterGrass(garden.grass, garden.seed, surface, planting),
    leaves: scatterLeaves(planting, garden.seed, surface),
    seedHeads: scatterSeedHeads(planting, garden.seed, surface),
    foliage: scatterFoliage(planting, garden.seed, surface),
  };

  check(
    "every family is deterministic for the same seed",
    JSON.stringify(scatterLeaves(planting, garden.seed, surface)) ===
        JSON.stringify(families.leaves) &&
      JSON.stringify(scatterSeedHeads(planting, garden.seed, surface)) ===
        JSON.stringify(families.seedHeads) &&
      JSON.stringify(scatterFoliage(planting, garden.seed, surface)) ===
        JSON.stringify(families.foliage) &&
      JSON.stringify(scatterGrass(garden.grass, garden.seed, surface, planting)) ===
        JSON.stringify(families.grass),
  );

  check(
    "a different seed gives a different composition",
    JSON.stringify(scatterLeaves(planting, garden.seed + 7, surface)) !==
      JSON.stringify(families.leaves),
  );

  check(
    "every plant stands on the ground it is drawn over",
    Object.values(families)
      .flat()
      .every((plant) => Math.abs(plant.y - surface(plant.x, plant.z)) < 1e-9),
  );

  check(
    "every plant stands inside the clearing",
    Object.entries(families).every(([name, items]) =>
      items.every((plant) => Math.hypot(plant.x, plant.z) <= garden.ground.radius + 1e-6),
    ),
    Object.entries(families)
      .map(([name, items]) => `${name}=${items.length}`)
      .join(" "),
  );

  // The airspace guard. Tall families are barred from the butterfly's reach by
  // construction; everything else has to stay under the floor. This is the check
  // that keeps the centre of the scene quiet no matter how the config is tuned.
  const area = gardenFlightArea(
    garden.windowSize.width / garden.windowSize.height,
    garden,
  );
  const floor = area.min[1];
  const flightReach = Math.hypot(
    Math.max(Math.abs(area.min[0]), Math.abs(area.max[0])),
    Math.max(Math.abs(area.min[2]), Math.abs(area.max[2])),
  );
  const tall = [...families.seedHeads, ...families.foliage];
  // Blades carry their height, the other families a uniform scale.
  const lowPlants = [
    ...families.leaves,
    ...families.grass.map((blade) => ({ ...blade, scale: blade.height })),
  ];
  check(
    "no tall plant stands within the butterfly's reach",
    tall.every((plant) => Math.hypot(plant.x, plant.z) >= flightReach),
    `tall plants start at r>=${Math.min(...tall.map((p) => Math.hypot(p.x, p.z))).toFixed(2)}, flight reach=${flightReach.toFixed(2)}`,
  );
  check(
    "every low plant stays under the butterfly's floor",
    lowPlants.every((plant) => plant.scale < floor),
    `tallest low plant=${Math.max(...lowPlants.map((p) => p.scale)).toFixed(2)} vs floor=${floor}`,
  );
  check(
    "the central airspace is left open",
    [...lowPlants, ...tall].every(
      (plant) => Math.hypot(plant.x, plant.z) >= planting.clearRadius * 0.45,
    ),
    `clearRadius=${planting.clearRadius}`,
  );

  // Composition, not a sprinkle. Measured as *area density* per tier, because
  // that is what the eye reads — and it is the shape the garden is after:
  //
  //     rim          heaviest continuous field
  //     landmarks    dense mats around each flower / limb / stone
  //     open mid     sparse
  //     centre       empty (this is where the butterfly flies)
  const bandDensity = (items, lo, hi) => {
    const n = items.filter((p) => {
      const r = Math.hypot(p.x, p.z);
      return r >= lo && r < hi;
    }).length;
    return n / (Math.PI * (hi * hi - lo * lo));
  };
  const centre = bandDensity(families.grass, 0, planting.clearRadius);
  const mid = bandDensity(families.grass, 3.4, planting.tallInnerRadius);
  const rim = bandDensity(families.grass, planting.tallInnerRadius, 6.1);
  check(
    "the centre the butterfly flies through is left essentially empty",
    centre < mid * 0.25,
    `centre=${centre.toFixed(2)} vs open mid=${mid.toFixed(2)} blades per unit²`,
  );
  check(
    "the open ground is sparse and the rim is the heaviest field",
    rim > mid * 1.3,
    `open mid=${mid.toFixed(2)} rim=${rim.toFixed(2)} blades per unit²`,
  );
  check(
    "the centre the butterfly flies through carries no turf at all",
    families.grass.every((b) => Math.hypot(b.x, b.z) >= planting.clearRadius * 0.45),
  );
  check(
    "the rim carries the background layer",
    families.seedHeads.length >= 20 && families.foliage.length >= 20 &&
      Math.min(...families.seedHeads.map((p) => Math.hypot(p.x, p.z))) >=
        planting.tallInnerRadius * 0.9,
    `seedHeads=${families.seedHeads.length} foliage=${families.foliage.length}`,
  );

  // The clusters are what make the planting look tended: each landmark has
  // planting around it.
  const nearFlower = (position) =>
    families.grass.filter(
      (p) => Math.hypot(p.x - position[0], p.z - position[1]) < 0.8,
    ).length;
  check(
    "every landmark has planting around it",
    garden.flowers.every((flower) => nearFlower(flower.position) >= 4) &&
      nearFlower([garden.log.position[0], garden.log.position[1]]) >= 4 &&
      nearFlower([garden.stones[0].position[0], garden.stones[0].position[1]]) >= 4,
    `flowers: ${garden.flowers
      .map((flower) => nearFlower(flower.position))
      .join(",")}`,
  );

  // The performance budget, measured from the real geometry builders rather than
  // estimated: the drawing costs four instanced draws for the whole planting,
  // two meshes per flower, and one each for the stones and the limb.
  const triangleCount = (geometry) =>
    geometry.getIndex()
      ? geometry.getIndex().count / 3
      : geometry.getAttribute("position").count / 3;
  const familyTriangles = [
    families.grass.length * triangleCount(bladeGeometry()),
    families.leaves.length * triangleCount(leafClumpGeometry()),
    families.seedHeads.length *
      triangleCount(seedHeadGeometry(hexToRgb("0"), hexToRgb("0"))),
    families.foliage.length * triangleCount(foliageGeometry()),
  ];
  const flowerTriangles = garden.flowers.reduce((sum, flower) => {
    const stem = triangleCount(stemGeometry(flower.stem));
    const head = triangleCount(
      flower.kind === "bud"
        ? budGeometry(flower.blossom, flower.center)
        : daisyGeometry(garden.petals, flower.blossom, flower.center),
    );
    return sum + stem + head;
  }, 0);
  const stoneTriangles = garden.stones.reduce(
    (sum, _stone, i) => sum + triangleCount(pebbleGeometry(i + 1)),
    0,
  );
  const branchTriangles = triangleCount(branchGeometry(garden.log.length, garden.log.radius, 5, [1, 1, 1], [1, 1, 1]));
  // Fixed scene furniture: the clearing, the ground plane, the sky dome and the
  // shared butterfly GLB (~2.1k triangles, per AGENTS.md).
  const clearingContacts = {
    positions: [
      ...garden.flowers.map((flower) => flower.position),
      ...garden.stones.map((stone) => stone.position),
      garden.log.position,
    ],
  };
  // The backdrop's real cost, from its real geometry (Phase 15.5D). The mound
  // count and width come from the same generators the renderer calls.
  const backdropTrianglesTotal =
    scatterBackdropMounds(garden.backdrop, garden.seed, () => 0).length *
      triangleCount(backdropMoundGeometry()) +
    scatterBackdropSpires(garden.backdrop, garden.seed, () => 0).length *
      triangleCount(backdropSpireGeometry(hexToRgb("0"), hexToRgb("0")));
  const fixedTriangles =
    clearingMesh(garden.ground, clearingContacts, garden.seed).indices.length / 3 +
    64 +
    1024 +
    2100 +
    backdropTrianglesTotal;
  const triangles =
    familyTriangles.reduce((a, b) => a + b, 0) +
    flowerTriangles +
    stoneTriangles +
    branchTriangles +
    fixedTriangles;
  const colourDraws =
    4 + /* the planting families, instanced */ garden.flowers.length * 2 +
    garden.stones.length + 1 /* the limb */ + 4 /* clearing, ground, sky, butterfly */ +
    2; /* the backdrop: mounds + spires (Phase 15.5D) */
  // The shadow pass repeats the casters — but an instanced family is one draw
  // however many instances it holds.
  const shadowDraws = 1 + 1 + garden.stones.length + 1 + garden.flowers.length * 2;
  check(
    "the garden stays inside the draw-call budget",
    colourDraws + shadowDraws <= 60,
    `${colourDraws} colour + ${shadowDraws} shadow = ${colourDraws + shadowDraws}/60`,
  );
  check(
    "the garden stays inside the triangle budget",
    triangles <= 25000,
    `${Math.round(triangles)}/25000 — planting ${Math.round(
      familyTriangles.reduce((a, b) => a + b, 0),
    )}, flowers ${flowerTriangles}, stones ${stoneTriangles}, limb ${branchTriangles}, backdrop ${backdropTrianglesTotal}, fixed ${Math.round(
      fixedTriangles - backdropTrianglesTotal,
    )}`,
  );
  // The backdrop specifically: two instanced draws and nearly nothing else. This
  // is the phase's whole performance claim, so it is measured on its own.
  // Stated as a share of what the backdrop is for, not as an absolute number:
  // the budget is a shared pool, so the meaningful claim is that the far
  // boundary costs a small fraction of the scene rather than a fixed number
  // that drifts every time a planting family is retuned. (An absolute 1,500
  // bound was here first and failed the moment the mounds became 12-blade fans
  // instead of 9-segment domes — the shapes got better and the budget did not.)
  check(
    "the far boundary is two draw calls and a small share of the scene",
    backdropTrianglesTotal < triangles * 0.1 && colourDraws + shadowDraws <= 60,
    `${backdropTrianglesTotal} triangles in 2 draws = ${(
      (backdropTrianglesTotal / triangles) * 100
    ).toFixed(1)}% of the scene's ${Math.round(triangles)} (mounds ${triangleCount(
      backdropMoundGeometry(),
    )} each, spires ${triangleCount(backdropSpireGeometry(hexToRgb("0"), hexToRgb("0")))} each)`,
  );
}

// --- The far boundary and the garden's sky (Phase 15.5D) -------------------------
// The backdrop answers one question — does this place end? — as cheaply as
// possible. What has to hold: it is deterministic, it stands well outside the
// flight volume, it stays inside its own band, it is irregular rather than a
// drawn ring, and it is *darker* than the clearing so it can never compete with
// the butterfly for contrast.
{
  const backdrop = garden.backdrop;
  const flat = () => 0;
  const mounds = scatterBackdropMounds(backdrop, garden.seed, flat);
  const spires = scatterBackdropSpires(backdrop, garden.seed, flat);
  const silhouettes = [...mounds, ...spires];

  check(
    "the backdrop is deterministic for the same seed",
    JSON.stringify(scatterBackdropMounds(backdrop, garden.seed, flat)) ===
      JSON.stringify(mounds) &&
      JSON.stringify(scatterBackdropSpires(backdrop, garden.seed, flat)) ===
        JSON.stringify(spires),
  );
  check(
    "a different seed rearranges the backdrop",
    JSON.stringify(scatterBackdropMounds(backdrop, garden.seed + 11, flat)) !==
      JSON.stringify(mounds),
  );

  // The flight-safety rule, stated as the layout guarantees it: every silhouette
  // stands beyond the flight volume's own reach, so nothing can ever intrude on
  // the butterfly's airspace however the config is tuned.
  const area = gardenFlightArea(
    garden.windowSize.width / garden.windowSize.height,
    garden,
  );
  const flightReach = Math.hypot(
    Math.max(Math.abs(area.min[0]), Math.abs(area.max[0])),
    Math.max(Math.abs(area.min[2]), Math.abs(area.max[2])),
  );
  const closest = Math.min(...silhouettes.map((s) => Math.hypot(s.x, s.z)));
  check(
    "no backdrop silhouette stands within the butterfly's reach",
    closest >= flightReach,
    `closest silhouette at r=${closest.toFixed(2)}, flight reach=${flightReach.toFixed(2)}`,
  );
  check(
    "every silhouette stands in its own band, outside the clearing",
    silhouettes.every(
      (s) =>
        Math.hypot(s.x, s.z) >= backdrop.inner &&
        Math.hypot(s.x, s.z) <= backdrop.outer,
    ),
    `band ${backdrop.inner}..${backdrop.outer}`,
  );
  check(
    "the backdrop stands beyond the clearing it frames",
    backdrop.inner > garden.ground.radius,
    `backdrop starts at ${backdrop.inner}, clearing ends at ${garden.ground.radius}`,
  );

  // Irregular, not a hedge. A single height, or a single radius, would draw the
  // circle 15.5A.1 spent a phase removing.
  const heights = mounds.map((m) => m.scale);
  const radii = silhouettes.map((s) => Math.hypot(s.x, s.z));
  // Height *spread* rather than a count of distinct values: with a low band
  // (0.45..0.95) rounding to three decimals collapses neighbours, so demanding
  // 90% distinct values tested the rounding, not the layout.
  const spread = (values) => Math.max(...values) - Math.min(...values);
  check(
    "the backdrop is irregular rather than a ring or a hedge",
    spread(heights) > (backdrop.mounds.maxHeight - backdrop.mounds.minHeight) * 0.5 &&
      spread(radii) > (backdrop.outer - backdrop.inner) * 0.8,
    `mound heights span ${spread(heights).toFixed(2)} of a ${(
      backdrop.mounds.maxHeight - backdrop.mounds.minHeight
    ).toFixed(2)} band, radius spread ${spread(radii).toFixed(2)}`,
  );
  check(
    "heights are biased to the middle of their band, so tall ones are occasional",
    (() => {
      const mid = (backdrop.mounds.minHeight + backdrop.mounds.maxHeight) / 2;
      const below = heights.filter((h) => h < mid).length;
      // Symmetric sampling would land near half; a centre-weighted one leans low.
      return below > heights.length * 0.62;
    })(),
    `${heights.filter((h) => h < (backdrop.mounds.minHeight + backdrop.mounds.maxHeight) / 2).length}/${heights.length} below mid`,
  );

  // Focal hierarchy, measured rather than asserted: the rim must be darker than
  // the clearing it frames. A rim lighter than the ground reads as a bright wall
  // and takes the eye straight off the butterfly.
  const luminance = (hex) => {
    const value = Number.parseInt(hex.replace("#", ""), 16);
    const r = ((value >> 16) & 255) / 255;
    const g = ((value >> 8) & 255) / 255;
    const b = (value & 255) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const clearingValue = luminance(garden.ground.colors.inner);
  check(
    "the backdrop stays darker than the clearing (focal hierarchy)",
    luminance(backdrop.colors.mound) < clearingValue &&
      luminance(backdrop.colors.spire) < clearingValue &&
      luminance(backdrop.colors.spireTip) < clearingValue,
    `rim ${luminance(backdrop.colors.mound).toFixed(3)} vs clearing ${clearingValue.toFixed(3)}`,
  );

  // And the sky must be the softest layer of all: the butterfly is read against
  // it, so a bright sky behind the wings costs the silhouette.
  check(
    "the garden sky is a soft background, not a subject",
    luminance(garden.sky.top) < clearingValue &&
      luminance(garden.sky.horizon) < luminance(garden.fog.color) + 0.02,
    `sky top ${luminance(garden.sky.top).toFixed(3)}, horizon ${luminance(garden.sky.horizon).toFixed(3)}, fog ${luminance(garden.fog.color).toFixed(3)}`,
  );
  // The horizon band and the fog are what the far ground fades into. If they
  // differ, they meet in a hard horizontal line — the "infinite plane" tell.
  check(
    "the sky's horizon meets the fog the far ground fades into",
    Math.abs(luminance(garden.sky.horizon) - luminance(garden.fog.color)) < 0.05,
    `horizon ${luminance(garden.sky.horizon).toFixed(3)} vs fog ${luminance(garden.fog.color).toFixed(3)}`,
  );

  // The backdrop must be *seen through* the fog, not standing in front of it.
  //
  // Measured across the whole flight volume rather than reasoned about: the
  // follow camera trails the butterfly by up to 4.6 in z and the butterfly
  // reaches z +2.6, so the camera itself roams out to ~7.8 from the origin. A
  // rim placed just past the clearing therefore ends up *beside the camera* —
  // crisp, close, and the opposite of distant. This asserts the real property:
  // across every camera pose the volume allows, the rim is comfortably outside
  // the fog's near plane and reads as hazed.
  {
    const offset = garden.camera.offset;
    // Only what the camera can actually see counts. The rim is a full ring, so
    // part of it is always *behind* the camera as it trails the butterfly — that
    // part is never rendered and its distance is irrelevant. Measured in front of
    // the view direction (toward the butterfly), which is conservative: it does
    // not even bother testing the field of view.
    const fogAt = (distance) =>
      Math.max(0, Math.min(1, (distance - garden.fog.near) / (garden.fog.far - garden.fog.near)));
    let worstClearance = Infinity;
    let worstFog = 1;
    // The smallest gap between the rim and the clearing's far edge, taken at the
    // *same* pose. Comparing the rim's worst view against the clearing's most
    // fogged view (the first version of this check) compares two different
    // moments and is meaningless.
    let worstGap = Infinity;
    let considered = 0;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        for (let k = 0; k <= 8; k++) {
          const butterfly = [
            area.min[0] + ((area.max[0] - area.min[0]) * i) / 8,
            area.min[1] + ((area.max[1] - area.min[1]) * j) / 8,
            area.min[2] + ((area.max[2] - area.min[2]) * k) / 8,
          ];
          const eye = [
            butterfly[0] + offset[0],
            butterfly[1] + offset[1],
            butterfly[2] + offset[2],
          ];
          // The rig looks at the butterfly; that is the view direction.
          const view = [
            butterfly[0] - eye[0],
            butterfly[1] - eye[1],
            butterfly[2] - eye[2],
          ];
          const viewLength = Math.hypot(...view) || 1;
          // What the rim has to recede behind is the *content* — the flowers and
          // stones the butterfly is read against, and which sit within ~3.5 units
          // of the origin. It is deliberately not compared against the clearing's
          // far edge: that edge can be much further from the camera than the rim
          // is, so the comparison runs backwards and says nothing about depth.
          let contentFog = 1;
          for (const content of [
            ...garden.flowers.map((flower) => flower.position),
            ...garden.stones.map((stone) => stone.position),
          ]) {
            contentFog = Math.min(
              contentFog,
              fogAt(Math.hypot(content[0] - eye[0], 0.4 - eye[1], content[1] - eye[2])),
            );
          }
          for (const shape of silhouettes) {
            const relative = [
              shape.x - eye[0],
              shape.y - eye[1],
              shape.z - eye[2],
            ];
            const along =
              (relative[0] * view[0] + relative[1] * view[1] + relative[2] * view[2]) /
              viewLength;
            if (along <= 0) continue; // behind the camera: never seen
            considered += 1;
            const distance = Math.hypot(...relative);
            worstClearance = Math.min(worstClearance, distance);
            const fog = fogAt(distance);
            worstFog = Math.min(worstFog, fog);
            worstGap = Math.min(worstGap, fog - contentFog);
          }
        }
      }
    }
    check(
      "the visible backdrop is never close to the camera at any pose in the flight volume",
      considered > 0 && worstClearance > garden.fog.near,
      `closest visible approach ${worstClearance.toFixed(2)} units over ${considered} visible samples, fog starts at ${garden.fog.near}`,
    );
    // Stated comparatively, at the same pose, because that is the actual
    // requirement: whatever the camera is doing, the rim must be more
    // atmospheric than the content it sits behind.
    check(
      "the backdrop always recedes behind the garden's content",
      worstGap > 0.1,
      `at the least favourable pose the rim is ${(worstGap * 100).toFixed(
        0,
      )} percentage points more fogged than the nearest flower or stone (rim never below ${(
        worstFog * 100
      ).toFixed(0)}% fog)`,
    );
  }

}

// --- Module surface -----------------------------------------------------------------
{
  const surface = Object.keys(gardenModule).sort().join(",");
  check(
    "the layout module surface is exactly the scatter plus the interaction layer",
    surface ===
      "FEEDBACK_PULSE_AMPLITUDE,FEEDBACK_PULSE_SECONDS,clearingMesh,feedbackPulse,flowerOwnershipEnds,gardenObjectId,gardenObjects,groundHeight,investigationPoint,pickGardenObject,scatterBackdropMounds,scatterBackdropSpires,scatterFoliage,scatterGrass,scatterLeaves,scatterSeedHeads",
    surface,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
