import { useLayoutEffect, useMemo, useRef } from "react";
import {
  Color,
  DoubleSide,
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type InstancedMesh,
} from "three";
import { SCENE } from "../../config/experience";
import {
  groundHeight,
  scatterFoliage,
  scatterGrass,
  scatterLeaves,
  scatterSeedHeads,
  type PlantInstance,
} from "../../lib/garden";
import {
  bladeGeometry,
  foliageGeometry,
  hexToRgb,
  leafClumpGeometry,
  seedHeadGeometry,
} from "./gardenGeometry";

/**
 * The garden's planting (Phase 15.5B).
 *
 * Four families — turf blades, leaf clumps, seed heads and foliage mounds — each
 * drawn as a single instanced mesh, so the whole vertical layer costs four draw
 * calls. Placement comes from `lib/garden.ts`: composed clusters around the
 * landmarks, a rim band, and a radial density gradient that keeps the middle
 * quiet. Nothing here reacts to input, and no instance is ever placed where the
 * butterfly flies — that rule is enforced in the layout, not hoped for here.
 *
 * Per-instance tone gives each family internal value variation without extra
 * materials, which is what stops a field of instances reading as one flat shape.
 */
function Instances({
  geometry,
  items,
  color,
  spread,
  width,
  arch = false,
  vertexColors = false,
  castShadow = false,
}: {
  geometry: BufferGeometry;
  items: PlantInstance[];
  color: string;
  spread: number;
  /** Fixed world width for a family whose geometry is authored at unit size. */
  width?: number;
  /** Scale z with the length, not the width, so the blade's arch survives. */
  arch?: boolean;
  vertexColors?: boolean;
  castShadow?: boolean;
}) {
  const ref = useRef<InstancedMesh>(null!);
  const base = useMemo(() => new Color(color), [color]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3();
    const euler = new Euler();
    const quaternion = new Quaternion();
    const tint = new Color();
    items.forEach((plant, i) => {
      // A lean on both axes, so a row of instances is never a row.
      euler.set(plant.tilt * 0.6, plant.rotationY, plant.tilt, "YXZ");
      quaternion.setFromEuler(euler);
      position.set(plant.x, plant.y, plant.z);
      if (width !== undefined) {
        // `arch` families (the turf) are authored at unit size with their arch
        // measured in *height* units, so z scales with the length: an upright
        // flat card is lit on one side only and reads as a dark shard, while a
        // leaning one presents its face to the light.
        scale.set(width, plant.scale, arch ? plant.scale : width);
      } else {
        scale.setScalar(plant.scale);
      }
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      // Value variation around the family colour: lighter or darker, never a
      // different hue.
      tint.copy(base).multiplyScalar(1 + (plant.tone - 0.5) * 2 * spread);
      mesh.setColorAt(i, tint);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [items, base, spread, width, arch]);

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, undefined, items.length]}
      castShadow={castShadow}
      frustumCulled={false}
    >
      <meshStandardMaterial
        vertexColors={vertexColors}
        roughness={1}
        metalness={0}
        side={DoubleSide}
      />
    </instancedMesh>
  );
}

export default function GardenPlanting() {
  const garden = SCENE.garden;
  const planting = garden.planting;

  const surface = useMemo(() => groundHeight(garden.ground, garden.seed), [garden]);
  const blades = useMemo(
    () => scatterGrass(garden.grass, garden.seed, surface, planting),
    [garden, surface],
  );
  const leaves = useMemo(
    () => scatterLeaves(planting, garden.seed, surface),
    [planting, garden.seed, surface],
  );
  const seedHeads = useMemo(
    () => scatterSeedHeads(planting, garden.seed, surface),
    [planting, garden.seed, surface],
  );
  const foliage = useMemo(
    () => scatterFoliage(planting, garden.seed, surface),
    [planting, garden.seed, surface],
  );

  // Geometries are built once and shared by every instance of the family.
  const blade = useMemo(() => bladeGeometry(), []);
  const leaf = useMemo(() => leafClumpGeometry(), []);
  // The seed head carries its own two-tone colouring (green stem, pale head) so
  // the family does not need two materials.
  const head = useMemo(
    () =>
      seedHeadGeometry(
        hexToRgb(planting.colors.seedStem),
        hexToRgb(planting.colors.seedHead),
      ),
    [planting.colors.seedStem, planting.colors.seedHead],
  );
  const mound = useMemo(() => foliageGeometry(), []);

  const grassBlades: PlantInstance[] = useMemo(
    () =>
      blades.map((item) => ({
        x: item.x,
        z: item.z,
        y: item.y,
        scale: item.height,
        rotationY: item.rotationY,
        tilt: item.tilt,
        tone: item.tone,
      })),
    [blades],
  );

  return (
    <group>
      {/* Turf: the ground's own texture, thinned where the butterfly flies. */}
      <Instances
        geometry={blade}
        items={grassBlades}
        color={garden.grass.color}
        spread={planting.toneSpread}
        width={garden.grass.bladeRadius}
        arch
      />
      {/* Leaf clumps: rounder silhouettes against the blades. */}
      <Instances
        geometry={leaf}
        items={leaves}
        color={planting.colors.leaf}
        spread={planting.toneSpread}
      />
      {/* Seed heads: the vertical layer. Their shadows are what plant them. */}
      <Instances
        geometry={head}
        items={seedHeads}
        color="#ffffff"
        spread={planting.toneSpread * 0.5}
        vertexColors
        castShadow
      />
      {/* Foliage: the darkest mass, closing the composition at the rim. */}
      <Instances
        geometry={mound}
        items={foliage}
        color={planting.colors.foliage}
        spread={planting.toneSpread}
        castShadow
      />
    </group>
  );
}
