/**
 * Garden layout (Phase 15.3, clearing in 15.5A).
 *
 * Everything about the garden's *composition* that is computed rather than
 * hand-placed lives here — the clearing's surface (Phase 15.5A) and the grass.
 *
 * The hand-placed elements (flowers, stones, the log) come straight from
 * `SCENE.garden` and need no computation. What matters here is the property
 * the whole feature leans on: **the garden looks the same on every launch**
 * — same seed, same blades, same ground, forever — which is also what makes it
 * testable without a renderer.
 *
 * This module imports nothing and renders nothing: it returns plain data,
 * which `GardenWorld.tsx` maps onto Three.js primitives. The seeded
 * generator below is a *layout* concern — it runs once at mount to build a
 * static world and is never consulted by flight, personality or memory,
 * whose own determinism is unchanged (and pinned by their suites).
 */

/** One grass blade: where it stands, how tall it is and how it leans. */
export interface GrassBlade {
  x: number;
  z: number;
  /** Height of the ground the blade stands on (0 unless a surface is given). */
  y: number;
  height: number;
  /** Lean away from vertical (radians), small so blades read as grass. */
  tilt: number;
  rotationY: number;
  /** 0..1 tonal position, for the per-instance value variation. */
  tone: number;
}

/** The grass tuning this module needs (structurally: `SCENE.garden.grass`). */
export interface GrassLayoutConfig {
  count: number;
  radius: number;
  bladeRadius: number;
  minHeight: number;
  maxHeight: number;
}

/**
 * Deterministic PRNG (mulberry32), local to the layout. One stream, consumed
 * in a fixed order, so the scatter is a pure function of `(config, seed)`.
 */
function layoutRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Blades may lean up to this far from vertical (radians). */
const MAX_TILT = 0.3;

/** Planting may lean up to this far from vertical (radians). */
const MAX_LEAN = 0.22;

/**
 * How far (in fractions of the clearing radius) the bank's crest may wander
 * with the ground's own relief field.
 *
 * Without this the bank is a ring of *constant* onset radius, and a constant
 * radius is exactly what the eye reads as a drawn circle. Letting where the
 * bank starts and peaks move with the ground makes the boundary felt rather
 * than traced.
 */
const BANK_WANDER = 0.12;

/* ------------------------------------------------------------------------- *
 * The clearing (Phase 15.5A)
 *
 * Phase 15.3 drew the garden as a flat coloured disc: a hard circular decal on
 * a larger flat plane, with no relief, no edge and no grounding — which is
 * exactly what made it read as a game level rather than a place. The clearing
 * replaces that disc with a small piece of habitat: gentle relief, a soft
 * raised bank around the rim, an irregular (not circular) boundary, and a baked
 * value gradient that is warmer where the butterfly flies and cooler at the
 * edge.
 *
 * Everything below is arithmetic on plain numbers — no geometry types, no
 * renderer, no imports — so the surface can be built and asserted headlessly.
 * The relief is tiny by construction and hard-capped by `maxHeight`, and the
 * whole surface stays far below the butterfly's minimum flight floor: this can
 * shape how the ground *looks*, never where the butterfly can fly.
 * ------------------------------------------------------------------------- */

/** The clearing tuning this module needs (structurally: `SCENE.garden.ground`). */
export interface ClearingConfig {
  radius: number;
  rings: number;
  segments: number;
  maxHeight: number;
  /** How far the clearing sits above the shared ground plane (never negative). */
  lift: number;
  clearingRadius: number;
  relief: { gradient: number; height: number };
  bank: { start: number; peak: number; height: number };
  /** Lowest fraction of the bank that survives where the relief field is low. */
  bankStrength: number;
  edgeJitter: number;
  contact: { radius: number; strength: number };
  colors: { inner: string; outer: string; bank: string; surround: string };
}

/** Placed objects whose bases darken the ground beneath them. */
export interface ClearingContacts {
  /** Ground-plane positions, as [x, z]. */
  readonly positions: readonly (readonly [number, number])[];
}

/** A built clearing surface: plain arrays, ready to hand to Three.js. */
export interface ClearingMesh {
  /** x, y, z triples. */
  positions: number[];
  /** r, g, b triples in 0..1, matched vertex-for-vertex with `positions`. */
  colors: number[];
  /** Triangle indices. */
  indices: number[];
  /** Measured extremes, so the relief can be asserted rather than assumed. */
  maxHeight: number;
  minHeight: number;
}

/** Smooth 0..1 ramp between two edges. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** `#rrggbb` (or `#rgb`) to 0..1 components. Config-driven, so trusted. */
function hexToRgb(hex: string): [number, number, number] {
  const digits = hex.trim().replace(/^#/, "");
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((c) => c + c)
          .join("")
      : digits.padEnd(6, "0").slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [0, 0, 0];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/**
 * A lattice value in [-1, 1], hashed from its integer cell and the seed.
 *
 * A plain integer mix rather than a stream: the ground needs a value at
 * *arbitrary* positions (the sampler is asked for heights between vertices), so
 * the field has to be a function of place, not of evaluation order.
 */
function latticeValue(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/**
 * Smooth 2D value noise in [-1, 1]: lattice values blended with smoothstep
 * weights, so the result is continuous *and* has no visible lattice creases.
 *
 * Isotropic by construction — this is the fix for the first version of the
 * clearing, which built its relief from a sum of sines in the angle around the
 * centre. That made the ground an angular extrusion: its crests ran in radial
 * spokes and the pattern at one radius was nearly identical at another
 * (measured correlation 0.955), which the eye reads as a procedural starburst
 * rather than as ground.
 */
function valueNoise2D(x: number, z: number, cell: number, seed: number): number {
  const gx = x / cell;
  const gz = z / cell;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const wx = smoothstep(0, 1, gx - ix);
  const wz = smoothstep(0, 1, gz - iz);
  const v00 = latticeValue(ix, iz, seed);
  const v10 = latticeValue(ix + 1, iz, seed);
  const v01 = latticeValue(ix, iz + 1, seed);
  const v11 = latticeValue(ix + 1, iz + 1, seed);
  const a = v00 + (v10 - v00) * wx;
  const b = v01 + (v11 - v01) * wx;
  return a + (b - a) * wz;
}

/**
 * The clearing's organic relief field, in [-1, 1].
 *
 * Two octaves at different scales — the coarse one gives the ground its broad
 * unevenness, the fine one keeps it from looking smoothed — summed with weights
 * that already add up to one, so the result needs no further normalising.
 */
function groundNoise(x: number, z: number, seed: number): number {
  return 0.62 * valueNoise2D(x, z, 2.7, seed) + 0.38 * valueNoise2D(x, z, 6.3, seed + 1013);
}

/** The local radius of the rim at an angle — irregular, but the same twice. */
function edgeRadius(ground: ClearingConfig, angle: number, seed: number): number {
  // Sampled *on the circle* rather than from the angle, so the outline is a
  // closed, smooth curve that cannot seam where it wraps around.
  const rim = ground.radius;
  const wave = valueNoise2D(
    Math.cos(angle) * rim,
    Math.sin(angle) * rim,
    3.1,
    (seed ^ 0x1f2e3d4c) | 0,
  );
  return rim * (1 + ground.edgeJitter * wave);
}

/**
 * The clearing's height at a point, above the shared ground plane.
 *
 * Two contributions, both continuous everywhere:
 *
 * - a **raised bank** that rises, peaks and settles back to the plane by the
 *   rim, so the clearing has a silhouette but no cliff edge;
 * - an **isotropic relief** whose amplitude grows gently outward from the very
 *   centre (`t^gradient`) and never switches on at a radius.
 *
 * The gradient matters as much as the noise. The first version faded the relief
 * in with a threshold ramp, which left the inner two thirds of the clearing
 * *exactly* flat and then switched texture on over half a unit — a hard change
 * of regime at a specific radius, which is precisely the circular seam that was
 * visible in the middle of the ground. A power envelope is non-zero at every
 * radius and has no derivative jump, so the surface simply gets more interesting
 * toward the bank.
 *
 * The result is hard-capped by `maxHeight`, which keeps the whole surface far
 * below the butterfly's flight floor.
 */
function clearingHeight(ground: ClearingConfig, x: number, z: number, seed: number): number {
  const radius = Math.hypot(x, z);
  const angle = Math.atan2(z, x);
  // Normalised against the *local* rim, so the sampler and the built mesh
  // always agree about where the boundary is. Just outside the clearing the
  // surface simply continues at its base level — continuous across the edge,
  // rather than dropping to the shared plane and leaving a step.
  const t = radius / edgeRadius(ground, angle, seed);
  if (t > 1) return ground.lift;

  const noise = groundNoise(x, z, seed);
  // Where the ground already rises, the bank starts earlier and peaks later;
  // where the ground is low, it barely appears at all. Both the crest's radius
  // and its strength wander, which is what stops a raised boundary from reading
  // as a circle drawn around the clearing.
  const wander = noise * 0.5 + 0.5;
  const bankStart = ground.bank.start - BANK_WANDER * (1 - wander);
  const bankPeak = ground.bank.peak + BANK_WANDER * 0.5 * wander;
  const bank =
    smoothstep(bankStart, bankPeak, t) * (1 - smoothstep(bankPeak, 1, t));
  const bankStrength = ground.bankStrength + (1 - ground.bankStrength) * wander;
  // The envelope is zero at the centre *and* at the rim: the relief is
  // effectively level where the objects stand, grows through the open ground,
  // and settles back to the rim, so the boundary meets the surrounding ground
  // rather than ending in a lip.
  const envelope = Math.pow(Math.max(0, t), ground.relief.gradient) * (1 - Math.pow(t, 6));
  // Bias the noise to its positive half. A signed field would be pushed below the
  // plane and clipped there, and clipping leaves perfectly flat patches with a
  // visible edge — the same class of defect as the ring this fixed. Gentle
  // hummocks instead of hummocks-and-hollows costs almost nothing at this
  // amplitude and cannot produce a false edge.
  const relief = ground.relief.height * envelope * (noise * 0.5 + 0.5);
  // The clearing sits a few millimetres proud of the shared ground plane, so
  // its edge is never coplanar with it (and the two cannot z-fight along the rim).
  return Math.min(ground.maxHeight, ground.lift + ground.bank.height * bank * bankStrength + relief);
}

/**
 * A sampler for the clearing's surface, for anything that has to *stand* on it
 * (grass today, planting in 15.5B). Built once per seed.
 */
export function groundHeight(
  ground: ClearingConfig,
  seed: number,
): (x: number, z: number) => number {
  return (x, z) => clearingHeight(ground, x, z, seed);
}

/**
 * Builds the clearing surface: positions, vertex colours and triangle indices.
 *
 * The value structure is baked into the vertex colours rather than textured —
 * warm and light through the usable centre, cooler and darker toward the rim,
 * with the bank reading as earthier still. Placed props contribute a soft
 * contact darkening under their bases, which is what makes them sit in the
 * ground instead of on it, at no extra draw call.
 */
export function clearingMesh(
  ground: ClearingConfig,
  contacts: ClearingContacts,
  seed: number,
): ClearingMesh {
  const inner = hexToRgb(ground.colors.inner);
  const outer = hexToRgb(ground.colors.outer);
  const bankColor = hexToRgb(ground.colors.bank);

  const rings = Math.max(2, Math.round(ground.rings));
  const segments = Math.max(3, Math.round(ground.segments));

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let maxHeight = 0;
  let minHeight = 0;

  /** Colour of one surface point, from its place in the clearing. */
  const shade = (x: number, z: number, t: number, bank: number, noise: number) => {
    const mix = smoothstep(0.12, 0.92, t);
    let r = inner[0] + (outer[0] - inner[0]) * mix;
    let g = inner[1] + (outer[1] - inner[1]) * mix;
    let b = inner[2] + (outer[2] - inner[2]) * mix;
    r += (bankColor[0] - r) * bank;
    g += (bankColor[1] - g) * bank;
    b += (bankColor[2] - b) * bank;

    // Contact darkening beneath the placed props.
    let contact = 0;
    for (const [cx, cz] of contacts.positions) {
      const d = Math.hypot(x - cx, z - cz);
      if (d < ground.contact.radius) {
        contact += (1 - d / ground.contact.radius) ** 1.5;
      }
    }
    const shade = 1 - Math.min(0.55, contact * ground.contact.strength);
    // A whisper of variation so the surface is never perfectly flat in value
    // either, taken from the same isotropic field as the relief so the two
    // cannot disagree about where the ground varies.
    const jitter = 1 + noise * 0.03;
    return [r * shade * jitter, g * shade * jitter, b * shade * jitter];
  };

  const emit = (x: number, z: number) => {
    const y = clearingHeight(ground, x, z, seed);
    if (y > maxHeight) maxHeight = y;
    if (y < minHeight) minHeight = y;
    positions.push(x, y, z);
    const angle = Math.atan2(z, x);
    const t = Math.hypot(x, z) / edgeRadius(ground, angle, seed);
    const bank =
      smoothstep(ground.bank.start, ground.bank.peak, t) *
      (1 - smoothstep(ground.bank.peak, 1, t));
    const [r, g, b] = shade(x, z, t, bank, groundNoise(x, z, seed));
    colors.push(r, g, b);
    return positions.length / 3 - 1;
  };

  // The centre of the clearing, flat by construction.
  const centre = emit(0, 0);
  /** Vertex indices per ring, so the quads below stay readable. */
  const grid: number[][] = [];

  for (let ring = 1; ring <= rings; ring++) {
    const fraction = ring / rings;
    const row: number[] = [];
    for (let segment = 0; segment < segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      const radius = fraction * edgeRadius(ground, angle, seed);
      row.push(emit(Math.cos(angle) * radius, Math.sin(angle) * radius));
    }
    grid.push(row);
  }

  // Triangles wind so the surface faces up: the centre fan first, then a quad
  // strip between each pair of rings.
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices.push(centre, grid[0][next], grid[0][segment]);
  }
  for (let ring = 1; ring < rings; ring++) {
    const inner = grid[ring - 1];
    const outer = grid[ring];
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;
      const a = inner[segment];
      const b = inner[next];
      const c = outer[segment];
      const d = outer[next];
      indices.push(a, d, c, a, b, d);
    }
  }

  return { positions, colors, indices, maxHeight, minHeight };
}

/* ------------------------------------------------------------------------- *
 * Interactive objects (Phase 15.4)
 *
 * The garden stops being only scenery here, without becoming a game: an
 * interactive object is a *place a click can mean*. This layer answers three
 * deterministic questions and nothing else:
 *
 * - Which objects exist?        (`gardenObjects` — straight from the config)
 * - Did this click mean one?    (`pickGardenObject` — a ray-vs-point test)
 * - Where does that send the    (`investigationPoint` — the nearest reachable
 *   butterfly?                     spot to the blossom, hovering above it)
 * - When is the flower done      (`flowerOwnershipEnds` — completion signal
 *   owning the click?               or bounded hold, nothing else)
 *
 * What the butterfly *does* about it is not decided here and never will be:
 * the interaction layer hands the answer to the existing public surface
 * (`seekTo` / `notice` / personality reporting), exactly as a click anywhere
 * else would. Future kinds (stones, leaves, a drifting light) join by adding
 * entries to `gardenObjects`; the picking and the reporting do not change.
 * ------------------------------------------------------------------------- */

/** The kinds of interactive objects that exist so far. */
export type GardenObjectKind = "flower";

/**
 * One interactive garden object: a stable identity and the world position a
 * click aims at (for flowers: the blossom, not the ground it grows from).
 */
export interface GardenObject {
  id: string;
  kind: GardenObjectKind;
  /** World position of the clickable part, in scene units. */
  position: readonly [number, number, number];
}

/** The flower shape this module needs (structurally: `SCENE.garden`). */
export interface GardenObjectsConfig {
  flowers: ReadonlyArray<{
    position: readonly [number, number];
    stem: number;
    scale: number;
  }>;
}

/**
 * Stable object ids, shared by the renderer and the picker so "flower #2"
 * means the same blossom everywhere, on every launch.
 */
export function gardenObjectId(kind: GardenObjectKind, index: number): string {
  return `${kind}-${index}`;
}

/**
 * Derives the interactive objects from the garden config. Deterministic:
 * same config, same objects, same ids, same aim points.
 */
export function gardenObjects(garden: GardenObjectsConfig): GardenObject[] {
  return garden.flowers.map((flower, index) => ({
    id: gardenObjectId("flower", index),
    kind: "flower",
    // The blossom sits at the top of its stem, inside the flower's scaled
    // group — the same arithmetic the renderer uses.
    position: [
      flower.position[0],
      (flower.stem + 0.03) * flower.scale,
      flower.position[1],
    ],
  }));
}

/**
 * Picks the interactive object a click ray meant, if any.
 *
 * The test is the ray's closest approach to each object's aim point: within
 * `radius` counts, the nearest one wins, ties break to the earlier object
 * (stable). Rays pointing away from an object never pick it. Pure — plain
 * vectors, no three.js, no scene.
 */
export function pickGardenObject(
  ray: {
    origin: readonly [number, number, number];
    direction: readonly [number, number, number];
  },
  objects: readonly GardenObject[],
  radius: number,
): { object: GardenObject; distance: number } | null {
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 0) || !(radius > 0)) return null;
  const nx = dx / length;
  const ny = dy / length;
  const nz = dz / length;

  let best: { object: GardenObject; distance: number } | null = null;
  for (const object of objects) {
    const cx = object.position[0] - ox;
    const cy = object.position[1] - oy;
    const cz = object.position[2] - oz;
    const along = cx * nx + cy * ny + cz * nz;
    if (along <= 0) continue; // behind the camera
    const px = ox + nx * along;
    const py = oy + ny * along;
    const pz = oz + nz * along;
    const distance = Math.hypot(
      object.position[0] - px,
      object.position[1] - py,
      object.position[2] - pz,
    );
    if (distance <= radius && (best === null || distance < best.distance)) {
      best = { object, distance };
    }
  }
  return best;
}

/**
 * Where the butterfly goes to investigate an object: the flower's own aim
 * point **pulled into the reachable flight area** (the nearest reachable
 * spot to the blossom) and raised by the hover offset — again inside the
 * area.
 *
 * Flowers grow where they look good; the butterfly flies inside a fixed
 * slab (every configured flower's depth sits outside the reachable z-band,
 * two of them outside it in x as well). A naive "above the blossom" point
 * would be clamped by `seekTo` on the way to it, and the butterfly would
 * stop a unit or more short of the flower it was meant to investigate.
 * Resolving the volume pull *here* — deterministically, per flower, in
 * world space — means `seekTo` receives a target it can reach exactly as
 * given: the butterfly ends up hovering directly over the nearest reachable
 * part of its flower, as close to investigating that blossom as the
 * airspace allows. Neither the slab, nor the camera, nor the flower's
 * placement is changed to make room.
 */
export function investigationPoint(
  object: GardenObject,
  hoverOffset: number,
  area: {
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  },
): readonly [number, number, number] {
  const [ox, oy, oz] = object.position;
  const pull = (value: number, low: number, high: number) =>
    Math.max(low, Math.min(high, value));
  return [
    pull(ox, area.min[0], area.max[0]),
    pull(oy + hoverOffset, area.min[1], area.max[1]),
    pull(oz, area.min[2], area.max[2]),
  ];
}

/**
 * Whether a picked flower's ownership of its click has ended (Phase 15.4
 * fix 2). Ownership starts on the pick itself — regardless of whether
 * `seekTo` agreed to fly — and ends by exactly one of two deterministic
 * signals:
 *
 * - **a flight started**: the controller's completion signal
 *   (`explicitFlightActive` clearing — the explicit target is dropped when
 *   the directed flight arrives), and then the post-arrival stay: arrival is
 *   what earns the linger, so ownership ends once the stay has elapsed;
 * - **no flight started** (`seekTo` correctly refused because the butterfly
 *   was already within `arriveRadius` of the flower): a bounded hold — long
 *   enough that the click plainly lands on the flower, short enough that
 *   the cursor resumes normally the moment there is nothing to investigate.
 *
 * A flight still in progress is never a release: `explicitFlightActive` means
 * arrival has not happened, so neither timer is consulted yet. The stay timer
 * starts on the completion signal, never on the original click.
 *
 * Pure: the clock is the caller's, so the rule itself is testable without
 * a controller or a timer.
 */
export function flowerOwnershipEnds(
  startedFlight: boolean,
  explicitFlightActive: boolean,
  holdExpired: boolean,
  stayExpired: boolean,
): boolean {
  if (!startedFlight) return holdExpired;
  if (explicitFlightActive) return false;
  return stayExpired;
}

/* ------------------------------------------------------------------------- *
 * Interaction feedback: a small, honest "I saw that" from the object itself.
 * ------------------------------------------------------------------------- */

/** How long one feedback pulse lasts, in seconds. */
export const FEEDBACK_PULSE_SECONDS = 1.4;
/** How much the object swells at the peak of the pulse (fraction of scale). */
export const FEEDBACK_PULSE_AMPLITUDE = 0.18;

/**
 * The feedback curve: a single gentle swell-and-settle — `0` before the
 * interaction, up to the amplitude halfway through, back to `0` by the end.
 * Bounded, non-repeating, and quiet enough to read as the flower noticing,
 * not a reward animation.
 */
export function feedbackPulse(elapsed: number): number {
  if (!(elapsed > 0) || elapsed >= FEEDBACK_PULSE_SECONDS) return 0;
  return Math.sin((elapsed / FEEDBACK_PULSE_SECONDS) * Math.PI) * FEEDBACK_PULSE_AMPLITUDE;
}

/**
 * Scatters the turf (Phase 15.5B).
 *
 * Positions were uniform over the disc in earlier phases; they are not any more.
 * Blades now arrive in **clusters** around a limited number of seed points, and
 * the seed points themselves follow a radial **density gradient** — sparse in
 * the middle where the butterfly flies, heavy toward the rim. That is the whole
 * difference between "a lawn with specks in it" and "a clearing that has been
 * left to grow".
 *
 * `surface` is the clearing's height sampler: given one, every blade stands on
 * the ground it can see instead of on the flat plane.
 */
export function scatterGrass(
  grass: GrassLayoutConfig,
  seed: number,
  surface?: (x: number, z: number) => number,
  planting?: PlantingConfig,
): GrassBlade[] {
  const rand = layoutRng(seed);
  const blades: GrassBlade[] = [];
  const clusterSize = Math.max(1, Math.round(grass.clusterSize));

  const emit = (clusterX: number, clusterZ: number, amount: number) => {
    for (let i = 0; i < amount && bladesPlaced < grass.count; i++) {
      const spread = grass.clusterSpread * Math.sqrt(rand());
      const spreadAngle = rand() * Math.PI * 2;
      let x = clusterX + Math.cos(spreadAngle) * spread;
      let z = clusterZ + Math.sin(spreadAngle) * spread;
      // A cluster must never push a blade past the scatter radius.
      const distance = Math.hypot(x, z);
      if (distance > grass.radius) {
        x = (x / distance) * grass.radius;
        z = (z / distance) * grass.radius;
      }
      bladesPlaced += 1;
      blades.push({
        x,
        z,
        y: surface ? surface(x, z) : 0,
        height: grass.minHeight + rand() * (grass.maxHeight - grass.minHeight),
        tilt: (rand() - 0.5) * 2 * MAX_TILT,
        rotationY: rand() * Math.PI * 2,
        tone: rand(),
      });
    }
  };
  let bladesPlaced = 0;

  // 1. The hand-placed clusters: a dense mat of turf gathering around each
  //    landmark. This is what makes the flowers, the limb and the stones look
  //    like they grew there rather than being dropped onto the ground.
  if (planting) {
    for (const cluster of planting.clusters) {
      for (let i = 0; i < cluster.tufts && bladesPlaced < grass.count; i++) {
        const angle = rand() * Math.PI * 2;
        const radius = Math.sqrt(rand()) * cluster.radius;
        emit(cluster.at[0] + Math.cos(angle) * radius, cluster.at[1] + Math.sin(angle) * radius, 1);
      }
    }
    // 2. The rim band: the heaviest turf, closing the composition.
    for (let i = 0; i < planting.rim.tufts && bladesPlaced < grass.count; i++) {
      const angle = rand() * Math.PI * 2;
      const radius = planting.rim.inner + rand() * (planting.rim.outer - planting.rim.inner);
      emit(Math.cos(angle) * radius, Math.sin(angle) * radius, 1);
    }
  }

  // 3. The open ground in tufts, rejection-sampled against the density
  //    gradient — quiet in the middle where the butterfly flies, denser toward
  //    the rim. The total is the configured count, not an average.
  //
  //    The corridor guard is applied here too, not only to the tall families:
  //    at a few hundred blades the density rejection alone left the middle
  //    almost empty by luck, but at the density turf actually needs it starts
  //    dropping blades into the flight corridor. The quiet middle has to be
  //    enforced, not hoped for.
  let attempts = 0;
  while (bladesPlaced < grass.count && attempts < grass.count * 60) {
    attempts += 1;
    const radius = Math.sqrt(rand()) * grass.radius;
    const theta = rand() * Math.PI * 2;
    if (planting) {
      if (radius < planting.clearRadius * 0.45) continue;
      if (rand() > densityAt(planting, radius)) continue;
    }
    emit(Math.cos(theta) * radius, Math.sin(theta) * radius, 1 + Math.floor(rand() * clusterSize));
  }
  return blades;
}

/* ------------------------------------------------------------------------- *
 * Planting (Phase 15.5B)
 *
 * Four families of instanced forms, one draw call each. The rules that matter:
 *
 * - **Composed, not scattered.** Families are placed from a density gradient
 *   plus hand-placed clusters around the landmarks, so the eye reads groups.
 * - **The airspace is protected by construction.** Tall families (seed heads,
 *   foliage) may only stand beyond `tallInnerRadius`, which lies outside the
 *   butterfly's flight volume; everything shorter stays under its floor. Nothing
 *   here needs a collider or a special case at runtime.
 * - **Planted, never floating.** Every instance takes its base from the same
 *   ground sampler the clearing is built from.
 * ------------------------------------------------------------------------- */

/** One placed plant: where it stands, how big, which way it faces, how light. */
export interface PlantInstance {
  x: number;
  z: number;
  /** Ground height under the plant — it stands on this. */
  y: number;
  /** Uniform scale for the family — its height, for everything planted. */
  scale: number;
  /**
   * Width, when the family's geometry is authored at unit size and its width is
   * independent of its height (the backdrop silhouettes). Unused elsewhere.
   */
  width?: number;
  rotationY: number;
  /** Slight lean, so a row of instances is never a row. */
  tilt: number;
  /** 0..1 tonal position within the family's value range. */
  tone: number;
}

/** The planting tuning this module needs (structurally: `SCENE.garden.planting`). */
export interface PlantingConfig {
  clearRadius: number;
  tallInnerRadius: number;
  toneSpread: number;
  leaves: { count: number; radius: number; minHeight: number; maxHeight: number };
  seedHeads: { count: number; radius: number; minHeight: number; maxHeight: number };
  foliage: { count: number; radius: number; minHeight: number; maxHeight: number };
  clusters: ReadonlyArray<{
    at: readonly [number, number];
    radius: number;
    tufts: number;
    leaves: number;
    seedHeads: number;
  }>;
  rim: { inner: number; outer: number; tufts: number; leaves: number; seedHeads: number; foliage: number };
  colors: { leaf: string; seedStem: string; seedHead: string; foliage: string };
}

/** The grass tuning this module needs (structurally: `SCENE.garden.grass`). */
export interface GrassLayoutConfig {
  count: number;
  radius: number;
  bladeRadius: number;
  minHeight: number;
  maxHeight: number;
  clusterSize: number;
  clusterSpread: number;
}

/**
 * Radial density: quiet in the middle, dense at the rim. Never zero inside the
 * clearing — the middle is *sparse*, not bare, so the ground still reads as
 * living ground rather than a runway.
 */
function densityAt(planting: PlantingConfig, radius: number): number {
  return 0.22 + 0.78 * smoothstep(planting.clearRadius, planting.tallInnerRadius, radius);
}

/** A point in the rim band, where the composition closes. */
function rimPoint(planting: PlantingConfig, rand: () => number): [number, number] {
  const theta = rand() * Math.PI * 2;
  const radius = planting.rim.inner + rand() * (planting.rim.outer - planting.rim.inner);
  return [Math.cos(theta) * radius, Math.sin(theta) * radius];
}

/** A point inside a hand-placed cluster. */
function clusterPoint(
  cluster: { at: readonly [number, number]; radius: number },
  rand: () => number,
): [number, number] {
  const radius = Math.sqrt(rand()) * cluster.radius;
  const theta = rand() * Math.PI * 2;
  return [cluster.at[0] + Math.cos(theta) * radius, cluster.at[1] + Math.sin(theta) * radius];
}

interface FamilyOptions {
  count: number;
  radius: number;
  minHeight: number;
  maxHeight: number;
  /** Tall families may not stand inside the butterfly's reach. */
  tall?: boolean;
  /** Only inside the rim band (tall families and rim-only masses). */
  rimOnly?: boolean;
}

/**
 * Places one family of plants.
 *
 * Every instance comes from a named *source* — a landmark cluster, the rim
 * band, or the gradient field — and the sources are drawn in a fixed order from
 * one seeded stream, so the composition is identical on every launch.
 */
function placeFamily(
  planting: PlantingConfig,
  seed: number,
  stream: number,
  options: FamilyOptions,
  perCluster: number,
  rimCount: number,
  surface: (x: number, z: number) => number,
): PlantInstance[] {
  const rand = layoutRng((seed ^ stream) | 0);
  const plants: PlantInstance[] = [];
  const push = (x: number, z: number) => {
    const radius = Math.hypot(x, z);
    // The airspace guards, enforced here rather than trusted to layout luck.
    if (options.tall && radius < planting.tallInnerRadius) return;
    if (!options.tall && radius < planting.clearRadius * 0.45) return;
    plants.push({
      x,
      z,
      y: surface(x, z),
      scale: options.minHeight + rand() * (options.maxHeight - options.minHeight),
      rotationY: rand() * Math.PI * 2,
      tilt: (rand() - 0.5) * 2 * MAX_LEAN,
      tone: rand(),
    });
  };

  // 1. The landmark clusters: the planting that makes objects look tended.
  for (const cluster of planting.clusters) {
    for (let i = 0; i < perCluster && plants.length < options.count; i++) {
      const [x, z] = clusterPoint(cluster, rand);
      push(x, z);
    }
  }
  // 2. The rim band: the background layer that closes the composition.
  for (let i = 0; i < rimCount && plants.length < options.count; i++) {
    const [x, z] = rimPoint(planting, rand);
    push(x, z);
  }
  // 3. The gradient field, filling what the clusters and the rim left.
  let placed = 0;
  let attempts = 0;
  while (plants.length < options.count && attempts < options.count * 40) {
    attempts += 1;
    const theta = rand() * Math.PI * 2;
    const radius = Math.sqrt(rand()) * options.radius;
    if (rand() > densityAt(planting, radius)) continue;
    if (options.rimOnly && radius < planting.tallInnerRadius) continue;
    push(Math.cos(theta) * radius, Math.sin(theta) * radius);
    placed += 1;
  }
  return plants;
}

/** Low broad-leaf plants, clustered around the landmarks and thinning inward. */
export function scatterLeaves(
  planting: PlantingConfig,
  seed: number,
  surface: (x: number, z: number) => number,
): PlantInstance[] {
  return placeFamily(
    planting,
    seed,
    0x51e,
    {
      count: planting.leaves.count,
      radius: planting.leaves.radius,
      minHeight: planting.leaves.minHeight,
      maxHeight: planting.leaves.maxHeight,
    },
    8,
    planting.rim.leaves,
    surface,
  );
}

/**
 * Seed heads: the vertical layer.
 *
 * Restricted to the rim band, which lies outside the butterfly's flight volume
 * (whose corners reach about 4.6 units from the centre) — so they add depth and
 * scale cues without ever standing in the airspace.
 */
export function scatterSeedHeads(
  planting: PlantingConfig,
  seed: number,
  surface: (x: number, z: number) => number,
): PlantInstance[] {
  return placeFamily(
    planting,
    seed,
    0x5e2d,
    {
      count: planting.seedHeads.count,
      radius: planting.seedHeads.radius,
      minHeight: planting.seedHeads.minHeight,
      maxHeight: planting.seedHeads.maxHeight,
      tall: true,
      rimOnly: true,
    },
    2,
    planting.rim.seedHeads,
    surface,
  );
}

/* ------------------------------------------------------------------------- *
 * The far boundary (Phase 15.5D)
 *
 * Two silhouette families standing beyond the clearing, in the band where the
 * fog has already taken most of their contrast. They exist to answer one
 * question — *does this place end?* — and to break the horizon, nothing more.
 *
 * They are the cheapest possible statement of that: two instanced draws, a few
 * triangles each, and placement that reuses the same density machinery as the
 * planting. The rules they must never break:
 *
 * - **Outside the flight volume.** The band starts beyond `backdrop.inner`,
 *   which is well outside the volume's own reach, so the airspace rules hold by
 *   construction rather than by luck.
 * - **Irregular, never a ring.** A single uniform height would read as a hedge
 *   and a uniform radius would draw the very circle 15.5A.1 removed. Heights
 *   span more than half their range and the radius is sampled across the whole
 *   band.
 * - **Darker than the clearing, and desaturated.** At this distance the fog does
 *   the rest; a rim lighter than the ground would read as a bright wall.
 * ------------------------------------------------------------------------- */

/** The backdrop tuning this module needs (structurally: `SCENE.garden.backdrop`). */
export interface BackdropConfig {
  inner: number;
  outer: number;
  mounds: {
    count: number;
    minHeight: number;
    maxHeight: number;
    minWidth: number;
    maxWidth: number;
  };
  spires: { count: number; minHeight: number; maxHeight: number; width: number };
  colors: { mound: string; spire: string; spireTip: string };
  toneSpread: number;
}

/**
 * Places one silhouette family across the backdrop band.
 *
 * `spread` biases height toward the middle of its range: a uniform sample would
 * put the extremes at the same frequency as everything else, which reads as
 * noise. A mound or spire is usually near its own average size, and the tall
 * ones should feel like occasional.
 */
function placeBackdrop(
  backdrop: BackdropConfig,
  seed: number,
  stream: number,
  count: number,
  minHeight: number,
  maxHeight: number,
  minWidth: number,
  maxWidth: number,
  surface: (x: number, z: number) => number,
): PlantInstance[] {
  const rand = layoutRng((seed ^ stream) | 0);
  const shapes: PlantInstance[] = [];
  for (let i = 0; i < count; i++) {
    const theta = rand() * Math.PI * 2;
    // Sampled across the whole band rather than pinned to one radius, so the
    // boundary has depth of its own instead of being a drawn line.
    const radius = backdrop.inner + rand() * (backdrop.outer - backdrop.inner);
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    // Bias height towards the *low* end of its band. A uniform sample puts the
    // extremes at the same frequency as everything else, which reads as noise;
    // this way most silhouettes are small and a tall one is occasional, which is
    // what keeps the band from reading as a hedge. (Squaring a uniform sample
    // moves its mean to a third of the range — 71% land below mid, against the
    // 50% a uniform sample gives. The first attempt centre-weighted them instead
    // and measured 20/54 below mid, i.e. biased *towards* being tall.)
    const heightBias = rand() ** 2;
    const height = minHeight + heightBias * (maxHeight - minHeight);
    shapes.push({
      x,
      z,
      // They stand on the shared plane, not on the clearing's sampler: the
      // clearing does not reach out here, and the surround is flat.
      y: surface(x, z),
      scale: height,
      // Width varies independently of height, so a tall shape is not always a
      // wide one.
      width: minWidth + rand() * (maxWidth - minWidth),
      rotationY: rand() * Math.PI * 2,
      // A slight lean only; a backdrop silhouette that tilts reads as broken.
      tilt: (rand() - 0.5) * 2 * MAX_LEAN * 0.4,
      tone: rand(),
    });
  }
  return shapes;
}

/** Low dark humps: the mass that reads as undergrowth at the wood's edge. */
export function scatterBackdropMounds(
  backdrop: BackdropConfig,
  seed: number,
  surface: (x: number, z: number) => number,
): PlantInstance[] {
  return placeBackdrop(
    backdrop,
    seed,
    0xb4d0,
    backdrop.mounds.count,
    backdrop.mounds.minHeight,
    backdrop.mounds.maxHeight,
    backdrop.mounds.minWidth,
    backdrop.mounds.maxWidth,
    surface,
  );
}

/** Thin tapered spikes: the texture that reads as distant grass. */
export function scatterBackdropSpires(
  backdrop: BackdropConfig,
  seed: number,
  surface: (x: number, z: number) => number,
): PlantInstance[] {
  return placeBackdrop(
    backdrop,
    seed,
    0x5f1e,
    backdrop.spires.count,
    backdrop.spires.minHeight,
    backdrop.spires.maxHeight,
    backdrop.spires.width,
    backdrop.spires.width,
    surface,
  );
}

/** Low foliage masses at the rim: the darkest value in the palette. */
export function scatterFoliage(
  planting: PlantingConfig,
  seed: number,
  surface: (x: number, z: number) => number,
): PlantInstance[] {
  return placeFamily(
    planting,
    seed,
    0x3c0f,
    {
      count: planting.foliage.count,
      radius: planting.foliage.radius,
      minHeight: planting.foliage.minHeight,
      maxHeight: planting.foliage.maxHeight,
      tall: true,
      rimOnly: true,
    },
    4,
    planting.rim.foliage,
    surface,
  );
}
