import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, DoubleSide, type Group, type Mesh, type MeshBasicMaterial } from "three";
import { SCENE } from "../../config/experience";
import type { MiniGameRuntime } from "../../lib/minigame";
import type { ButterflyChaseGame } from "../../lib/butterflyChase";

/**
 * The Butterfly Chase target marker (Phase 16.1).
 *
 * A small glowing orb with a faint turning ring, placed from the game's own
 * state each frame. It pulses gently, and the pulse quickens as the target's
 * expiry approaches — the tell that it is about to vanish — so urgency is
 * readable without a number on screen. Not rendered at all while there is no
 * live target.
 *
 * Deliberately cheap: two meshes, two materials, no textures, no shadows, no
 * post-processing, and nothing allocated in the frame loop. Two draw calls.
 */
export default function ChaseTargetMarker({ runtime }: { runtime: MiniGameRuntime }) {
  const chase = SCENE.garden.chase;
  const group = useRef<Group>(null);
  const orb = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);

  const orbColor = useRef(new Color(chase.color));
  const ringColor = useRef(new Color(chase.color).multiplyScalar(0.72));

  useFrame((state) => {
    const holder = group.current;
    if (!holder) return;
    const game = runtime.activeGame as ButterflyChaseGame | null;
    const target = runtime.currentState === "playing" && game ? game.target : null;
    holder.visible = target !== null;
    if (!target || !game) return;

    const [x, y, z] = target.position;
    holder.position.set(x, y, z);

    // The pulse must follow the *game's* clock, not the scene clock — a paused
    // game freezes everything, including the marker. The game's elapsed time
    // is its duration minus its remaining seconds; the target's expiry is on
    // the same clock.
    const gameElapsed = SCENE.garden.chase.durationSeconds - game.remainingSeconds;
    const lifeLeft = Math.max(0, target.expiresAt - gameElapsed);
    const expiring = lifeLeft <= chase.expiringSeconds;
    // The catchable state is the *game's* fact (computed from the butterfly's
    // real position), so the visual can never disagree with the hit test:
    // a steady, bright, fast pulse means "the butterfly is there — click now".
    const catchable = game.catchable;

    const t = state.clock.elapsedTime;
    const pulse = 1 + Math.sin(t * (catchable ? 9 : expiring ? 9 : 3.2)) * (catchable ? 0.08 : expiring ? 0.2 : 0.1);
    // Small: the butterfly is ~0.24 units across, and a marker near that size
    // reads as a second subject rather than as a target. The ring, not the
    // orb, carries the readability.
    holder.scale.setScalar(chase.targetRadius * pulse);

    const orbMaterial = orb.current?.material as MeshBasicMaterial | undefined;
    if (orbMaterial) {
      orbMaterial.opacity = catchable ? 1 : expiring ? 0.62 + Math.sin(t * 12) * 0.28 : 0.92;
    }
    const ringMaterial = ring.current?.material as MeshBasicMaterial | undefined;
    if (ring.current && ringMaterial) {
      ring.current.rotation.z = t * (catchable ? 2.4 : 0.9);
      ringMaterial.opacity = catchable ? 0.7 : expiring ? 0.5 : 0.35;
    }
  });

  return (
    <group ref={group} visible={false}>
      {/* The orb: a soft point of light. Unlit, so its value is its own and it
          reads the same against sky and ground. */}
      <mesh ref={orb}>
        <sphereGeometry args={[1, 12, 10]} />
        <meshBasicMaterial
          color={orbColor.current}
          transparent
          opacity={0.92}
          depthWrite={false}
          fog={false}
        />
      </mesh>
      {/* The ring: a faint halo turning slowly, so the marker reads as alive
          even at the edge of vision. */}
      <mesh ref={ring} rotation={[Math.PI / 2.6, 0, 0]}>
        <torusGeometry args={[1.55, 0.08, 6, 24]} />
        <meshBasicMaterial
          color={ringColor.current}
          transparent
          opacity={0.35}
          depthWrite={false}
          side={DoubleSide}
          fog={false}
        />
      </mesh>
    </group>
  );
}
