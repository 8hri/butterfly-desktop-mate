import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, type Group } from "three";
import { SCENE } from "../../config/experience";
import { clearingMesh, feedbackPulse, gardenObjectId, groundHeight } from "../../lib/garden";
import GardenPlanting from "./GardenPlanting";
import GardenBackdrop from "./GardenBackdrop";
import {
  branchGeometry,
  budGeometry,
  daisyGeometry,
  hexToRgb,
  pebbleGeometry,
  stemGeometry,
} from "./gardenGeometry";

/** The config shapes this file renders, named for the props below. */
type FlowerConfig = (typeof SCENE.garden.flowers)[number];
type StoneConfig = (typeof SCENE.garden.stones)[number];
type LogConfig = typeof SCENE.garden.log;

/**
 * Which garden object was last interacted with, and a nonce so the same
 * object clicked twice still retriggers its pulse. Pure presentation state:
 * it changes how an object *looks for a moment*, never what anything does.
 */
export interface GardenFeedback {
  id: string | null;
  nonce: number;
}

/**
 * The garden world (Phase 15.3; clearing in 15.5A): a small, pleasant place the
 * companion lives in while the garden window is visited.
 *
 * Built entirely from procedurally generated geometry — no external models,
 * textures or dependencies — and dressed entirely by `SCENE.garden`: every
 * position, scale, count and colour comes from the config; this file only maps
 * that data onto geometry. The computed elements arrive already solved from
 * `lib/garden.ts`, deterministic by seed: the clearing's surface (Phase 15.5A)
 * and the planting layout (Phase 15.5B).
 *
 * It is deliberately *scenery*: nothing here collides, targets, perches or
 * plays. The butterfly flies through it under the same flight controller,
 * and interaction stays exactly what it is everywhere else.
 */

/**
 * Where the placed objects meet the ground, so the clearing can bake a soft
 * darkening under their bases. Straight from the config — the visual change is
 * in `lib/garden.ts`, this is only the list of what stands on the surface.
 */
function contactPositions(garden: typeof SCENE.garden) {
  return [
    ...garden.flowers.map((flower) => flower.position),
    ...garden.stones.map((stone) => stone.position),
    garden.log.position,
  ];
}

/**
 * One blossom. Two silhouettes, one shared stem form, and one head mesh with its
 * colours baked in: an open daisy (petal ring around a centre) or a closed bud.
 * The five flowers are the garden's landmarks, so they read as related but not
 * identical — and they remain exactly the five objects the picker knows about.
 */
function Flower({
  spot,
  index,
  feedback,
  groundAt,
}: {
  spot: FlowerConfig;
  index: number;
  feedback: GardenFeedback;
  groundAt: (x: number, z: number) => number;
}) {
  const petals = SCENE.garden.petals;
  const id = gardenObjectId("flower", index);
  const group = useRef<Group>(null);
  /** Scene-clock time at which the current pulse started; -1 = none. */
  const pulseStart = useRef(-1);
  const lastNonce = useRef(0);

  const stem = useMemo(() => stemGeometry(spot.stem), [spot.stem]);
  const head = useMemo(
    () =>
      spot.kind === "bud"
        ? budGeometry(spot.blossom, spot.center)
        : daisyGeometry(petals, spot.blossom, spot.center),
    [spot.kind, petals, spot.blossom, spot.center],
  );

  // The feedback pulse: a gentle swell when this flower is clicked, easing
  // back to nothing — the flower's way of saying it was seen. Deterministic
  // curve from lib/garden.ts; the only state is *when* it started.
  useFrame((state) => {
    if (!group.current) return;
    if (feedback.id === id && feedback.nonce !== lastNonce.current) {
      lastNonce.current = feedback.nonce;
      pulseStart.current = state.clock.elapsedTime;
    }
    const pulse = feedbackPulse(state.clock.elapsedTime - pulseStart.current);
    const scale = spot.scale * (1 + pulse);
    group.current.scale.set(scale, scale, scale);
  });

  // Planted on the ground it stands on, not on an assumed y.
  const base = groundAt(spot.position[0], spot.position[1]);

  return (
    <group
      ref={group}
      position={[spot.position[0], base, spot.position[1]]}
      scale={spot.scale}
      rotation={[0, (index * 2.399) % (Math.PI * 2), 0]}
    >
      <mesh geometry={stem} castShadow>
        <meshStandardMaterial color={SCENE.garden.stemColor} roughness={1} metalness={0} />
      </mesh>
      {/* Double-sided: the head is a shallow open form built from hand-placed
          triangles, and a head lit from the wrong side renders as a dark speck
          against a pale garden. Two-sided costs nothing here and cannot. */}
      <mesh geometry={head} position={[0, spot.stem, 0]} castShadow>
        <meshStandardMaterial vertexColors roughness={0.9} metalness={0} side={DoubleSide} />
      </mesh>
    </group>
  );
}

/**
 * One stone: an irregular, smooth-shaded pebble, seated on the ground it stands
 * on rather than at an assumed height. Each gets its own seeded displacement, so
 * the three never read as three copies of one object.
 */
function Stone({
  stone,
  seed,
  groundAt,
}: {
  stone: StoneConfig;
  seed: number;
  groundAt: (x: number, z: number) => number;
}) {
  const pebble = useMemo(() => pebbleGeometry(seed), [seed]);
  return (
    <mesh
      castShadow
      receiveShadow
      geometry={pebble}
      position={[
        stone.position[0],
        // Seated: most of the stone below its base, as a real one sits.
        groundAt(stone.position[0], stone.position[1]) + stone.scale * 0.3,
        stone.position[1],
      ]}
      rotation={[0, stone.rotationY, 0]}
      // Wider than tall, so a stone never reads as a ball on the ground.
      scale={[stone.scale * 1.05, stone.scale * 0.72, stone.scale]}
    >
      <meshStandardMaterial color={stone.color} roughness={0.95} metalness={0} />
    </mesh>
  );
}

/**
 * The fallen limb: tapered along its length, slightly bent, resting on the
 * ground, with a lighter cut end. A small environmental landmark, not a trunk.
 */
function Limb({ log, groundAt }: { log: LogConfig; groundAt: (x: number, z: number) => number }) {
  const branch = useMemo(
    () =>
      branchGeometry(
        log.length,
        log.radius,
        5,
        hexToRgb(log.endColor),
        hexToRgb(log.color),
      ),
    [log],
  );
  const [x, z] = log.position;
  return (
    <mesh
      castShadow
      receiveShadow
      geometry={branch}
      // Half-sunk: a fallen branch rests *on* the ground, not above it.
      position={[x, groundAt(x, z) + log.radius * 0.5, z]}
      rotation={[0, log.rotationY, 0]}
    >
      {/* Two-sided: the tube's triangles are hand-wound, and a limb lit from
          inside reads as a dark lump rather than as wood. */}
      <meshStandardMaterial vertexColors roughness={1} metalness={0} side={DoubleSide} />
    </mesh>
  );
}

export default function GardenWorld({ feedback }: { feedback: GardenFeedback }) {
  const garden = SCENE.garden;

  // The clearing's surface, the flowers' and the planting's ground height all
  // come from the same seeded solve, so everything stands on the ground it is
  // drawn over.
  const clearing = useMemo(
    () => clearingMesh(garden.ground, { positions: contactPositions(garden) }, garden.seed),
    [garden],
  );
  const surface = useMemo(() => groundHeight(garden.ground, garden.seed), [garden]);

  return (
    <group>
      {/*
        The clearing (Phase 15.5A): relief, a soft raised bank and an irregular
        rim, with its value structure and the props' contact darkening baked
        into the vertex colours — one mesh, one draw call, no textures.
      */}
      <mesh receiveShadow>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array(clearing.positions), 3]}
          />
          <bufferAttribute
            attach="attributes-color"
            args={[new Float32Array(clearing.colors), 3]}
          />
          <bufferAttribute
            attach="index"
            args={[new Uint16Array(clearing.indices), 1]}
          />
        </bufferGeometry>
        <meshStandardMaterial vertexColors roughness={1} metalness={0} />
      </mesh>

      {/* Flowers: the five interaction landmarks, unchanged in contract. */}
      {garden.flowers.map((spot, i) => (
        <Flower key={i} spot={spot} index={i} feedback={feedback} groundAt={surface} />
      ))}

      {/* Stones. */}
      {garden.stones.map((stone, i) => (
        <Stone key={i} stone={stone} seed={i + 1} groundAt={surface} />
      ))}

      {/* The fallen limb. */}
      <Limb log={garden.log} groundAt={surface} />

      {/*
        The planting (Phase 15.5B): four instanced families — turf, leaf clumps,
        seed heads and foliage — placed by `lib/garden.ts`.
      */}
      <GardenPlanting />

      {/*
        The far boundary (Phase 15.5D): silhouettes beyond the clearing, drawn
        *after* the planting so the blend order matches their depth. Two draw
        calls, no shadow caster — the rim is meant to be nearly atmosphere.
      */}
      <GardenBackdrop />
    </group>
  );
}
