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
import { scatterBackdropMounds, scatterBackdropSpires, type PlantInstance } from "../../lib/garden";
import { backdropMoundGeometry, backdropSpireGeometry, hexToRgb } from "./gardenGeometry";

/**
 * The far boundary (Phase 15.5D).
 *
 * The garden's last visual problem was not the clearing — it was what happened
 * past it. A dozen units of ground fading into an empty pale band reads as *a
 * disc on an infinite plane*, however good the disc is.
 *
 * This is the cheapest thing that answers it. Two instanced silhouette families
 * standing beyond the clearing, in the band where the fog has already taken most
 * of their contrast: low dark mounds for mass, thin spikes for texture. Two draw
 * calls and about 1.2k triangles for the whole thing.
 *
 * The restraint is the point. There is no tree, no canopy, no wall, no
 * post-processing, and nothing here is lit into focus — the rim is meant to be
 * *nearly* atmosphere, so that the butterfly, the flowers and the clearing keep
 * every bit of the contrast. No shadow caster: at this distance and this value,
 * a cast shadow would cost the single shadow-caster budget to make the darkest
 * part of the frame darker.
 *
 * Placement comes from `lib/garden.ts` and is deterministic per seed, like
 * everything else in the garden. Nothing here reacts to input.
 */
function Silhouettes({
  geometry,
  items,
  color,
  spread,
  vertexColors = false,
}: {
  geometry: BufferGeometry;
  items: PlantInstance[];
  color: string;
  spread: number;
  vertexColors?: boolean;
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
    items.forEach((shape, i) => {
      euler.set(shape.tilt * 0.5, shape.rotationY, shape.tilt, "YXZ");
      quaternion.setFromEuler(euler);
      position.set(shape.x, shape.y, shape.z);
      // Width and height are independent: a tall silhouette is not automatically
      // a wide one, which is what stops the band reading as one extruded curve.
      scale.set(shape.width ?? shape.scale, shape.scale, shape.width ?? shape.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      tint.copy(base).multiplyScalar(1 + (shape.tone - 0.5) * 2 * spread);
      mesh.setColorAt(i, tint);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [items, base, spread]);

  return (
    <instancedMesh ref={ref} args={[geometry, undefined, items.length]} frustumCulled={false}>
      {/*
        Unlit on purpose. A lit material at this distance is the wrong tool: the
        garden's key is a warm 1.75, so every upward-facing facet of every mound
        caught it and rendered *brighter* than the hazy sky behind — a row of pale
        origami shapes floating above the horizon, which is the opposite of a
        treeline. (Rendered, exactly that.) What the far boundary needs is its
        own value and nothing else, so it takes no lighting at all: fog still
        blends it toward the horizon, which is precisely the atmospheric
        perspective this is for.
      */}
      <meshBasicMaterial
        vertexColors={vertexColors}
        side={DoubleSide}
        fog
      />
    </instancedMesh>
  );
}

export default function GardenBackdrop() {
  const backdrop = SCENE.garden.backdrop;
  const seed = SCENE.garden.seed;

  // The surround plane is flat and outside the clearing, so the backdrop stands
  // on y = 0 — the same surface the ground plane it silhouettes provides.
  const surface = useMemo(() => () => 0, []);

  const mounds = useMemo(
    () => scatterBackdropMounds(backdrop, seed, surface),
    [backdrop, seed, surface],
  );
  const spires = useMemo(
    () => scatterBackdropSpires(backdrop, seed, surface),
    [backdrop, seed, surface],
  );

  const mound = useMemo(() => backdropMoundGeometry(), []);
  const spire = useMemo(
    () =>
      backdropSpireGeometry(
        hexToRgb(backdrop.colors.spire),
        hexToRgb(backdrop.colors.spireTip),
      ),
    [backdrop.colors.spire, backdrop.colors.spireTip],
  );

  return (
    <group>
      <Silhouettes
        geometry={mound}
        items={mounds}
        color={backdrop.colors.mound}
        spread={backdrop.toneSpread}
      />
      <Silhouettes
        geometry={spire}
        items={spires}
        color="#ffffff"
        spread={backdrop.toneSpread * 0.6}
        vertexColors
      />
    </group>
  );
}
