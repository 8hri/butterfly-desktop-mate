import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AnimationMixer,
  Box3,
  Euler,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Group,
} from "three";
import {
  BUTTERFLY_ASSET,
  SCENE,
  type ButterflyAssetSpec,
} from "../../config/experience";
import { resolveClip } from "../../lib/animation";
import { preloadGLTF, useGLTF } from "../../lib/gltf";
import { FlightController, type FlightMode } from "../../lib/flight";
import type { Personality } from "../../lib/personality";

// The GLB is cached by URL, so StrictMode re-renders and preloading are cheap.
// (Warms the default species; switching species preloads the other one.)
preloadGLTF(BUTTERFLY_ASSET.url);

interface ButterflyProps {
  /** Which butterfly to render. Only the asset — behaviour never changes. */
  asset: ButterflyAssetSpec;
  /** Movement simulation owned by the scene, shared with camera and input. */
  flight: FlightController;
  /** Reaction-intensity model: ticks alongside flight and feeds its profile. */
  personality?: Personality;
  /** Called once the model is mounted (used by the loading transition). */
  onReady?: () => void;
}

/**
 * Loads the external butterfly GLB and drives it: flight behaviour from the
 * FlightController, animation state crossfaded between the GLB's own clips.
 *
 * The model is treated as replaceable: size is auto-fitted from its bounding
 * box, clip names resolve with a fuzzy fallback, and all scene behaviour
 * (position, heading, bank) is applied to wrapper groups — never the model.
 */
export default function Butterfly({ asset, flight, personality, onReady }: ButterflyProps) {
  const { scene, animations } = useGLTF(asset.url);
  /**
   * Clips resolved once per load; null-safe against differently named GLBs.
   * `hover` normally resolves to the same clip as `flying` — airborne rest
   * reuses the flap at a slower rate, because the GLB's perched "Idle" clip
   * holds the wings folded and frozen (a perched pose, not a hover).
   */
  const clips = useMemo(
    () => ({
      flying: resolveClip(animations, asset.clips.flying),
      hover: resolveClip(animations, asset.clips.hover),
    }),
    [animations],
  );

  /**
   * Fit the model to the scene: scale by bounding box, recentre so the
   * actor's origin sits at the butterfly's body (a natural pivot for
   * banking and turning).
   */
  const fit = useMemo(() => {
    const box = new Box3().setFromObject(scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    return { scale: asset.targetSize / maxDim, center };
  }, [scene]);

  const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
  const actorRef = useRef<Group>(null!);

  /**
   * Playback slots: which action each flight mode drives, and at what rate.
   * Hover normally shares the flying action (same clip — the mixer hands
   * back the same instance), so each slot keeps its own target timeScale
   * and transitions only retarget the rate, never restart the action.
   */
  const slots = useRef<{
    flying: { action: AnimationAction | null; timeScale: number };
    hover: { action: AnimationAction | null; timeScale: number };
    active: FlightMode | null;
  }>({
    flying: { action: null, timeScale: 1 },
    hover: { action: null, timeScale: asset.hoverTimeScale },
    active: null,
  });

  const play = (clip: AnimationClip | null, timeScale: number) => {
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    action.timeScale = timeScale;
    action.reset().play();
    action.fadeIn(0.45);
    return action;
  };

  useEffect(() => {
    const current = slots.current;
    const flyingClip = clips.flying ?? clips.hover;
    const hoverClip = clips.hover ?? clips.flying;
    current.flying.action = play(flyingClip, current.flying.timeScale);
    current.hover.action =
      hoverClip === flyingClip
        ? // Same clip: reuse the one action; the slot still owns its rate.
          current.flying.action
        : play(hoverClip, current.hover.timeScale);
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    };
  }, [mixer, clips, scene]);

  useEffect(() => {
    onReady?.();
  }, [onReady]);

  const euler = useMemo(() => new Euler(0, 0, 0, "YXZ"), []);

  useFrame((_, rawDelta) => {
    // Clamp the step so a stalled tab cannot teleport the butterfly.
    const delta = Math.min(rawDelta, 1 / 20);

    // The personality sets *how intensely* to react; the controller then
    // decides *how* to move, exactly as before.
    if (personality) flight.setBehaviorProfile(personality.step(delta));

    const mode = flight.step(delta);

    const current = slots.current;
    if (mode !== current.active) {
      const next = mode === "flying" ? current.flying : current.hover;
      const previous = mode === "flying" ? current.hover : current.flying;
      if (next.action && next.action === previous.action) {
        // Shared action (same clip): only the playback rate changes. The
        // wings keep their exact position in the loop — no snap, no
        // restart, and the rate always returns to normal on take-off.
        next.action.timeScale = next.timeScale;
        if (!next.action.isRunning()) next.action.reset().play();
      } else if (next.action) {
        // Distinct clips: the normal crossfade path.
        next.action.reset().play().fadeIn(0.45);
        next.action.timeScale = next.timeScale;
        previous.action?.fadeOut(0.45);
      }
      current.active = mode;
    }

    const actor = actorRef.current;
    if (actor) {
      actor.position.copy(flight.position);
      euler.set(flight.euler.x, flight.euler.y, flight.euler.z);
      actor.quaternion.setFromEuler(euler);
    }

    mixer.update(delta);
  });

  return (
    // Actor: the movement system positions and turns this group.
    <group ref={actorRef} position={SCENE.butterfly.start}>
      {/* Heading offset for models that face another direction. */}
      <group rotation={[0, asset.yawOffset, 0]}>
        <group
          scale={fit.scale}
          position={[
            -fit.center.x * fit.scale,
            -fit.center.y * fit.scale,
            -fit.center.z * fit.scale,
          ]}
        >
          <primitive object={scene} />
        </group>
      </group>
    </group>
  );
}
