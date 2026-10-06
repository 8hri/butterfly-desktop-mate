import { useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CameraRig, DEFAULT_CAMERA_TUNING } from "../../lib/camera";
import { SCENE } from "../../config/experience";
import { isDesktop } from "../../lib/platform";
import type { AppMode } from "../../lib/appMode";
import type { FlightController } from "../../lib/flight";

/** Mutable pointer state shared between interaction and camera parallax. */
export type PointerState = { x: number; y: number; active: boolean };

/**
 * Keeps the camera composed around the butterfly.
 *
 * Web: the home framing comes from `SCENE.camera.position` relative to the
 * butterfly's start, and the rig follows the flight.
 *
 * Desktop: the rig holds that same shot as a **fixed** framing (parallax
 * only), so the butterfly's position within the frame is its screen position
 * and it can travel across the whole window — the config stays the single
 * source of truth for where the camera sits either way.
 *
 * Garden: still the follow shot, but with its own numbers (Phase 15.5A) —
 * `SCENE.garden.camera` — because the desktop shot may not be moved to suit it.
 */
export default function CameraRig3D({
  flight,
  pointer,
  mode,
}: {
  flight: FlightController;
  pointer: PointerState;
  /**
   * The current window mode (Phase 15.2): the desktop overlay holds a fixed
   * framing so the butterfly's screen position is its desktop position; the
   * garden (and the web build) uses the follow shot. Switching recreates the
   * rig, and since `update` consumes the live camera position every frame the
   * change reads as a short glide rather than a snap.
   */
  mode: AppMode;
}) {
  const camera = useThree((state) => state.camera);

  const gardenPresentation = !isDesktop || mode === "garden";
  // Garden-only tuning (Phase 15.5A). It has to be separate rather than a change
  // to `SCENE.camera`, because that is also the desktop fixed shot's absolute
  // home: moving it here would move the overlay. The follow architecture, the
  // damping, the parallax and the focus lean are all unchanged — only this
  // mode's numbers differ.
  const isGarden = isDesktop && mode === "garden";
  const rig = useMemo(() => {
    const offset: [number, number, number] = isGarden
      ? [SCENE.garden.camera.offset[0], SCENE.garden.camera.offset[1], SCENE.garden.camera.offset[2]]
      : gardenPresentation
        ? [
            SCENE.camera.position[0] - SCENE.butterfly.start[0],
            SCENE.camera.position[1] - SCENE.butterfly.start[1],
            SCENE.camera.position[2] - SCENE.butterfly.start[2],
          ]
        : // Absolute home position: the fixed shot never trails the flight.
          [SCENE.camera.position[0], SCENE.camera.position[1], SCENE.camera.position[2]];
    return new CameraRig({
      ...DEFAULT_CAMERA_TUNING,
      ...(gardenPresentation
        ? null
        : { framing: "fixed" as const, lookAt: SCENE.camera.lookAt }),
      offset,
      // Garden framing sits a touch lower and further forward, so vertical
      // structure and the rim read instead of flattening into the ground.
      ...(isGarden
        ? {
            lookAtDrop: SCENE.garden.camera.lookAtDrop,
            travel: [
              SCENE.garden.camera.travel[0],
              SCENE.garden.camera.travel[1],
              SCENE.garden.camera.travel[2],
            ] as [number, number, number],
          }
        : null),
    });
  }, [gardenPresentation, isGarden]);

  // Default priority (0) keeps R3F's automatic rendering — any priority > 0
  // takes over the render loop. Mounted after Butterfly, so at equal priority
  // this callback runs after the butterfly has already moved this frame.
  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 1 / 20);
    rig.update(
      dt,
      flight.position,
      pointer.active ? pointer : null,
      camera.position,
      // Leans towards the clicked spot while the butterfly is flying to it.
      flight.userTarget,
    );
    camera.lookAt(rig.lookPoint);
  });

  return null;
}

export const createPointerState = (): PointerState => ({ x: 0, y: 0, active: false });
