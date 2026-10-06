import { BackSide } from "three";
import { SCENE } from "../../config/experience";
import { verticalGradientTexture } from "../../lib/gradient";

/**
 * Gradient sky dome.
 *
 * Kept separate from the lights so the desktop shell can drop the backdrop
 * for a transparent window without giving up the lighting.
 *
 * `palette` is optional and defaults to the shared scene palette, so desktop and
 * web are untouched; the garden passes its own three tones (Phase 15.5D). The
 * gradient mechanism is unchanged either way — same texture, same cache, same
 * three stops.
 */
export default function SkyDome({
  palette = SCENE.palette,
}: {
  palette?: { skyTop: string; skyHorizon: string; skyBelow: string };
}) {
  const skyTexture = verticalGradientTexture([
    palette.skyTop,
    palette.skyHorizon,
    palette.skyBelow,
  ]);

  return (
    <mesh renderOrder={-1}>
      <sphereGeometry args={[70, 32, 16]} />
      <meshBasicMaterial
        map={skyTexture}
        side={BackSide}
        fog={false}
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  );
}
