import {
  BufferAttribute,
  BufferGeometry,
  IcosahedronGeometry,
  Vector3,
} from "three";

/**
 * The garden's procedural forms (Phase 15.5B/C).
 *
 * Every shape here is built from plain arrays and returned as a
 * `BufferGeometry` — no external models, no textures, no dependencies. They are
 * built once per garden and shared across instances, so the whole planting costs
 * four draw calls rather than one per plant.
 *
 * The design rule for all of them: *silhouette first, polygon count second*. The
 * scene's job is to stop reading as a box of primitives, so a blade curves and
 * tapers, a stone is irregular and smooth-shaded, and a branch tapers along its
 * length. None of them is a sphere or a cone.
 */

/** Deterministic value noise for the procedural displacement below. */
function wobble(index: number, seed: number): number {
  const x = Math.sin((index + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function geometry(
  positions: number[],
  normals: number[],
  colors: number[] | null,
  indices: number[],
): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  if (colors) geo.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geo.setIndex(indices);
  if (normals.length === positions.length) {
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  } else {
    geo.computeVertexNormals();
  }
  return geo;
}

/** `#rrggbb` to 0..1 components, so a config colour can be baked in. */
export function hexToRgb(hex: string): [number, number, number] {
  const digits = hex.replace("#", "");
  const value = Number.parseInt(
    digits.length === 3
      ? digits
          .split("")
          .map((c) => c + c)
          .join("")
      : digits,
    16,
  );
  if (!Number.isFinite(value)) return [0, 0, 0];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/**
 * A grass blade: a tapered strip that arches over as it rises, narrowing to a
 * point.
 *
 * Authored at unit height and unit width, and — importantly — the arch is
 * measured in *height* units along z, so the instance matrix scales it with the
 * blade's length. Scaling z with the width instead (the obvious choice) shrinks
 * the arch to nothing and leaves a row of upright flat cards, which is what
 * rendered as a field of dark shards: a vertical card lit from the side is lit
 * on one face and near-black on the other. A blade that leans over presents its
 * face upward, to the sky and the key, and reads as a blade from any angle.
 */
export function bladeGeometry(steps = 3): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Width swells a little at the base, then tapers to nothing.
    const half = ((1 - t ** 1.6) * (1 + 0.35 * (1 - t))) / 2;
    const y = t;
    // The arch: the tip leans over roughly a third of the blade's own length.
    const z = 0.55 * t * t;
    positions.push(-half, y, z, half, y, z);
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return geometry(positions, [], null, indices);
}

/** One leaf: a curved, pointed blade of its own, so leaves differ from grass. */
function leafStrip(
  positions: number[],
  indices: number[],
  offset: number,
  yaw: number,
  lean: number,
  length: number,
  width: number,
): void {
  const steps = 3;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const half = (width * Math.sin(Math.PI * (0.15 + 0.85 * t))) / 2;
    const along = length * t;
    const drop = -lean * t * t;
    for (const side of [-1, 1]) {
      const x = side * half;
      positions.push(x * cos - along * sin, drop, x * sin + along * cos);
    }
  }
  for (let i = 0; i < steps; i++) {
    const a = offset + i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

/**
 * A low broad-leaf plant: three leaves fanning from one short stem. Reads as a
 * plant rather than as grass, and gives the midground a rounder silhouette
 * against the blades.
 */
export function leafClumpGeometry(seed = 3): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  // A short stem so the leaves are lifted off the ground a little.
  positions.push(-0.012, 0, 0, 0.012, 0, 0);
  positions.push(-0.008, 0.09, 0, 0.008, 0.09, 0);
  indices.push(0, 2, 1, 1, 2, 3);

  for (let i = 0; i < 3; i++) {
    const yaw = (i / 3) * Math.PI * 2 + wobble(i, seed) * 0.4;
    leafStrip(
      positions,
      indices,
      positions.length / 3,
      yaw,
      0.55 + wobble(i + 7, seed) * 0.2,
      0.4 + Math.abs(wobble(i + 3, seed)) * 0.12,
      0.17,
    );
  }
  return geometry(positions, [], null, indices);
}

/**
 * A seed head: a thin stem with a pale, tapered head at the top.
 *
 * This is the vertical layer of the composition. Instances scale it, so the same
 * geometry serves every height in the band. The head is deliberately small
 * against the stem: a first pass gave it a fat 9 cm bulb on a 1.5-unit stalk and
 * the rim read as a hedge of pale lollipops several times the butterfly's
 * height, rather than as seed heads among grass.
 */
export function seedHeadGeometry(
  stemColor: [number, number, number],
  headColor: [number, number, number],
): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const sides = 5;
  const segments = 4;
  // The stem: a narrow tube with a slight lean.
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const y = t;
    const radius = 0.008 * (1 - 0.4 * t);
    const lean = 0.06 * t * t;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      positions.push(Math.cos(a) * radius + lean, y, Math.sin(a) * radius);
      colors.push(stemColor[0], stemColor[1], stemColor[2]);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * sides + s;
      const b = i * sides + ((s + 1) % sides);
      const c = (i + 1) * sides + s;
      const d = (i + 1) * sides + ((s + 1) % sides);
      indices.push(a, c, b, b, c, d);
    }
  }
  // The head: an elongated teardrop above the stem.
  const headBase = positions.length / 3;
  const rings = [
    { y: 0.7, r: 0.009 },
    { y: 0.82, r: 0.026 },
    { y: 0.95, r: 0.018 },
    { y: 1.0, r: 0.0 },
  ];
  for (const ring of rings) {
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      positions.push(Math.cos(a) * ring.r, ring.y, Math.sin(a) * ring.r);
      colors.push(headColor[0], headColor[1], headColor[2]);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = headBase + i * sides + s;
      const b = headBase + i * sides + ((s + 1) % sides);
      const c = headBase + (i + 1) * sides + s;
      const d = headBase + (i + 1) * sides + ((s + 1) % sides);
      indices.push(a, b, c, b, d, c);
    }
  }
  return geometry(positions, [], colors, indices);
}

/**
 * A foliage mound: five leaves fanned low and wide, the darkest mass in the
 * palette. It closes the composition at the rim without becoming a wall.
 *
 * The leaves lift rather than lie flat — fanned almost horizontally they read as
 * leaves dropped on the ground, not as a growing mound.
 */
export function foliageGeometry(seed = 11): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < 5; i++) {
    const yaw = (i / 5) * Math.PI * 2 + wobble(i, seed) * 0.3;
    leafStrip(
      positions,
      indices,
      positions.length / 3,
      yaw,
      0.72 + wobble(i + 5, seed) * 0.14,
      0.42 + Math.abs(wobble(i + 2, seed)) * 0.14,
      0.24,
    );
  }
  return geometry(positions, [], null, indices);
}

/**
 * A flower stem: a slightly tapered, six-sided stalk with a small lean. The
 * bloom itself is a separate head mesh, so a flower is two draws and no more.
 */
export function stemGeometry(height: number): BufferGeometry {
  const sides = 6;
  const rings = 3;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const radius = 0.016 * (1 - 0.35 * t);
    const lean = 0.03 * t * t;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      positions.push(Math.cos(a) * radius + lean, height * t, Math.sin(a) * radius);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * sides + s;
      const b = i * sides + ((s + 1) % sides);
      const c = (i + 1) * sides + s;
      const d = (i + 1) * sides + ((s + 1) % sides);
      indices.push(a, c, b, b, c, d);
    }
  }
  return geometry(positions, [], null, indices);
}

/**
 * A daisy head: a petal ring around a centre, built as one geometry with its
 * colours baked in — so a flower with two colours still costs a single draw.
 * The petals are pointed and lift slightly, rather than being squashed spheres.
 */
export function daisyGeometry(
  petals: number,
  blossom: string,
  center: string,
): BufferGeometry {
  const blossomRgb = hexToRgb(blossom);
  const centerRgb = hexToRgb(center);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const sides = 5;
  const rings = [
    { y: 0.0, r: 0.026 },
    { y: 0.05, r: 0.075 },
    { y: 0.042, r: 0.0 },
  ];
  for (const ring of rings) {
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      positions.push(Math.cos(a) * ring.r, ring.y, Math.sin(a) * ring.r);
      colors.push(centerRgb[0], centerRgb[1], centerRgb[2]);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * sides + s;
      const b = i * sides + ((s + 1) % sides);
      const c = (i + 1) * sides + s;
      const d = (i + 1) * sides + ((s + 1) % sides);
      indices.push(a, b, c, b, d, c);
    }
  }
  // The petal ring: pointed blades lying almost flat, lifted and tipped. The
  // blossom is sized to read as a *landmark* from the follow camera — a first
  // pass kept the stems and shrank nothing, and five small blossoms vanished
  // into the turf. Growing the head rather than the stem is what keeps every
  // flower below the butterfly's floor.
  const petalBase = positions.length / 3;
  for (let p = 0; p < petals; p++) {
    const angle = (p / petals) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const inner = 0.05;
    const outer = 0.16;
    const halfWidth = 0.05;
    const lift = 0.026;
    const tip = 0.042;
    const points: [number, number, number][] = [
      [cos * inner - sin * -halfWidth, 0.004, sin * inner + cos * -halfWidth],
      [cos * (inner + 0.03) - sin * 0, lift * 0.6, sin * (inner + 0.03) + cos * 0],
      [cos * inner - sin * halfWidth, 0.004, sin * inner + cos * halfWidth],
      [cos * outer, tip, sin * outer],
    ];
    for (const [x, y, z] of points) {
      positions.push(x, y, z);
      colors.push(blossomRgb[0], blossomRgb[1], blossomRgb[2]);
    }
    const a = petalBase + p * 4;
    indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
    indices.push(a + 1, a + 2, a + 3);
  }
  return geometry(positions, [], colors, indices);
}

/**
 * A bud: a closed teardrop, tipped slightly over. Cheaper than a daisy and a
 * genuinely different silhouette, so the five landmarks are not five copies of
 * one shape.
 *
 * It carries vertex colours like the daisy does — a head is rendered with one
 * `vertexColors` material, and a material that expects colours on a geometry
 * without them renders **black**, not white.
 */
export function budGeometry(blossom: string, tip: string): BufferGeometry {
  const bodyRgb = hexToRgb(blossom);
  const tipRgb = hexToRgb(tip);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const sides = 5;
  const rings = [
    { y: 0.0, r: 0.034 },
    { y: 0.07, r: 0.072 },
    { y: 0.19, r: 0.066 },
    { y: 0.27, r: 0.034 },
    { y: 0.31, r: 0.0 },
  ];
  rings.forEach((ring, index) => {
    // Darker at the base, lighter toward the tip: the shading of a closed bud.
    const mix = index / (rings.length - 1);
    const rgb = [
      bodyRgb[0] + (tipRgb[0] - bodyRgb[0]) * mix,
      bodyRgb[1] + (tipRgb[1] - bodyRgb[1]) * mix,
      bodyRgb[2] + (tipRgb[2] - bodyRgb[2]) * mix,
    ];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      positions.push(Math.cos(a) * ring.r, ring.y, Math.sin(a) * ring.r);
      colors.push(rgb[0], rgb[1], rgb[2]);
    }
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * sides + s;
      const b = i * sides + ((s + 1) % sides);
      const c = (i + 1) * sides + s;
      const d = (i + 1) * sides + ((s + 1) % sides);
      indices.push(a, b, c, b, d, c);
    }
  }
  return geometry(positions, [], colors, indices);
}

/**
 * A stone: an icosahedron pushed around by seeded noise and squashed flat.
 *
 * The displacement is *radial*, so the blob stays star-shaped about its origin —
 * which means the outward normal at any vertex is simply the direction of that
 * vertex, and the stone can be smooth-shaded analytically. (Calling
 * `computeVertexNormals()` on an icosahedron would not: it is non-indexed, so
 * that computes one normal per *triangle* and the "rounded" stone comes out as
 * a pile of dark facets. This was the fix.)
 *
 * The noise is weighted towards the base, so the silhouette is irregular where
 * it meets the ground and calmer on top.
 */
export function pebbleGeometry(seed = 1): BufferGeometry {
  const base = new IcosahedronGeometry(1, 1);
  const position = base.getAttribute("position") as BufferAttribute;
  const point = new Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i).normalize();
    const noise = 1 + 0.1 * wobble(i, seed);
    // Heavier distortion low down, so the silhouette is irregular where it
    // meets the ground and calmer on top.
    const low = Math.max(0, -point.y);
    const squash = 0.66 - 0.14 * low;
    position.setXYZ(
      i,
      point.x * noise * (1.04 + 0.06 * low),
      point.y * noise * squash,
      point.z * noise * (1.0 + 0.08 * low),
    );
  }
  // Smooth shading from the radial direction: one normal per vertex, shared by
  // the faces that meet there, so the stone reads as a rounded solid.
  const normals = new Float32Array(position.count * 3);
  const normal = new Vector3();
  for (let i = 0; i < position.count; i++) {
    normal.fromBufferAttribute(position, i).normalize();
    normals[i * 3] = normal.x;
    normals[i * 3 + 1] = normal.y;
    normals[i * 3 + 2] = normal.z;
  }
  base.setAttribute("normal", new BufferAttribute(normals, 3));
  return base;
}

/**
 * A backdrop mound: a low, wide mass with a broken, uneven crown.
 *
 * The far boundary (Phase 15.5D) needs *mass*, not detail — something for the
 * fog to swallow that reads as undergrowth rather than as a bump.
 *
 * The first attempt was a dome: a crown ring over a wider base ring, closed with
 * an apex. Rendered, it looked like nothing so much as a row of pale grey
 * polygonal hills floating in the haze — the silhouette was a smooth arc, the
 * flanks were bright enough to catch the key light, and because each mound was
 * wider than it was tall they read as *distant hills*, not as bushes at the
 * edge of a wood. Three things fix it:
 *
 * 1. **The crown breaks hard.** Each segment gets its own height, and the
 *    variation is large, so the outline is a ragged skyline rather than an arc.
 * 2. **The base pinches in.** A wide base with a domed top is a hill; the same
 *    form with a narrower, irregular footprint reads as a mass of foliage.
 * 3. **It is wider than it is tall, but only just** — see `backdrop.mounds` in
 *    the config, where the aspect ratio is part of the silhouette.
 *
 * Authored at unit size so the instance sets width and height independently.
 */
export function backdropMoundGeometry(seed = 17): BufferGeometry {
  const blades = 12;
  const positions: number[] = [];
  const indices: number[] = [];
  // A clump of narrow blades fanning from one point, each its own triangle.
  //
  // Three earlier attempts failed here, and all three failed for the same reason:
  // **a silhouette made of a few large facets reads as folded paper.** A dome
  // rendered as pale polygonal hills; breaking its crown heights turned it into
  // slabs with vertical sides; a nine-blade fan still had facets wide enough on
  // screen to show their own edges. Narrow and many is what fixes it — no single
  // triangle is large enough to read as a plane, so the shape resolves as a
  // ragged mass of foliage from every angle, which is what a bush is.
  for (let i = 0; i < blades; i++) {
    const angle = (i / blades) * Math.PI * 2 + 0.4 * wobble(i, seed);
    // Two interfering frequencies, so the skyline is uneven without repeating.
    const variation =
      0.5 + 0.34 * wobble(i, seed) + 0.2 * wobble(Math.floor(i / 3) + 11, seed + 3);
    // Blades reach high or barely at all; few sit at half height.
    const height = 0.2 + 0.8 * Math.max(0.05, variation);
    // Half-width of the blade, small enough that neighbouring blades overlap
    // rather than leaving gaps between them.
    const halfWidth = 0.13 + 0.1 * (0.5 + 0.5 * wobble(i + 5, seed));
    const reach = 0.42 + 0.34 * (0.5 + 0.5 * wobble(i + 7, seed));
    const centreX = Math.cos(angle) * reach;
    const centreZ = Math.sin(angle) * reach;
    // The blade lies in the plane containing its own direction and the vertical.
    const sideX = -Math.sin(angle) * halfWidth;
    const sideZ = Math.cos(angle) * halfWidth;
    const base = positions.length / 3;
    positions.push(centreX - sideX, 0, centreZ - sideZ);
    positions.push(centreX + sideX, 0, centreZ + sideZ);
    // The tip leans outward as well as up, so the clump is not a vertical fan.
    positions.push(centreX * 1.35, height, centreZ * 1.35);
    indices.push(base, base + 1, base + 2);
  }
  return geometry(positions, [], null, indices);
}

/**
 * A backdrop spire: a thin tapered spike, dark at the base and lighter at the
 * tip.
 *
 * The far boundary's *texture*. One triangle's worth of silhouette each, so a
 * hundred and fifty of them cost almost nothing, and the two-tone vertex colour
 * keeps them from reading as one flat mass of sticks. It leans very slightly,
 * because a perfectly vertical spike at distance reads as a fence post.
 */
export function backdropSpireGeometry(
  baseColor: [number, number, number],
  tipColor: [number, number, number],
): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  // Two crossed blades: a single flat card vanishes when seen edge-on, which at
  // this distance happens constantly as the camera moves.
  for (const angle of [0, Math.PI / 2]) {
    const dx = Math.cos(angle) * 0.5;
    const dz = Math.sin(angle) * 0.5;
    const base = positions.length / 3;
    positions.push(-dx, 0, -dz, dx, 0, dz);
    colors.push(baseColor[0], baseColor[1], baseColor[2]);
    positions.push(-dx * 0.25, 0.55, -dz * 0.25, dx * 0.25, 0.55, dz * 0.25);
    colors.push(
      baseColor[0] + (tipColor[0] - baseColor[0]) * 0.5,
      baseColor[1] + (tipColor[1] - baseColor[1]) * 0.5,
      baseColor[2] + (tipColor[2] - baseColor[2]) * 0.5,
    );
    positions.push(dx * 0.12, 1.0, dz * 0.12);
    colors.push(tipColor[0], tipColor[1], tipColor[2]);
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    indices.push(base + 2, base + 3, base + 4);
  }
  return geometry(positions, [], colors, indices);
}

/**
 * A fallen branch: a tube that tapers along its length and bends slightly, with
 * a lighter cut end. Small — a fallen limb, not a tree trunk — but the taper and
 * the bend are what stop it reading as a cylinder.
 */
export function branchGeometry(
  length = 1.55,
  radius = 0.15,
  seed = 5,
  endColor: [number, number, number],
  barkColor: [number, number, number],
): BufferGeometry {
  const sides = 7;
  const segments = 6;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
  // Taper from the thick end. The mid-swell is small on purpose: a strong one
    // turns the limb into a bulging worm.
    const r = radius * (1 - 0.4 * t);
    const z = -length * t;
    // The bend: a fallen branch is never straight, but it is not curled either.
    const y = 0.05 * Math.sin(Math.PI * t) + 0.02 * t;
    const x = 0.035 * wobble(i, seed) * Math.sin(Math.PI * t);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      // A little per-side variation is enough to break the machined look.
      const wobbleR = r * (1 + 0.04 * wobble(i * 7 + s, seed));
      const px = x + Math.cos(a) * wobbleR;
      const py = y + Math.sin(a) * wobbleR;
      positions.push(px, py, z);
      normals.push(Math.cos(a), Math.sin(a), 0);
      // The cut end is lighter, and the bark darkens slightly along its length.
      const isEnd = i === 0;
      const shade = isEnd ? endColor : barkColor;
      const falloff = isEnd ? 1 : 0.86 + 0.14 * (1 - t);
      colors.push(shade[0] * falloff, shade[1] * falloff, shade[2] * falloff);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * sides + s;
      const b = i * sides + ((s + 1) % sides);
      const c = (i + 1) * sides + s;
      const d = (i + 1) * sides + ((s + 1) % sides);
      indices.push(a, c, b, b, c, d);
    }
  }
  return geometry(positions, normals, colors, indices);
}
