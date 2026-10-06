import { SCENE } from "../../config/experience";

/**
 * The garden's own light (Phase 15.5A).
 *
 * The shared `Atmosphere` stays exactly as it is for desktop and web; the
 * garden renders this instead. It exists for one reason: objects should look
 * *planted* rather than pasted on. Two things do that job here, and nothing
 * else is added:
 *
 * 1. A warm, low key light with a tight shadow box around the clearing. The
 *    placed props cast into it and the clearing receives, so stones and the log
 *    have a real contact shadow. One caster, one 1024 map, a 4.2-unit box —
 *    everything hand-placed stands within about 3.5 units of the centre, so the
 *    map's texels stay dense instead of being spread over empty ground.
 * 2. A cool fill from the opposite side, so silhouettes separate from the sky
 *    instead of flattening into it.
 *
 * No post-processing, no second shadow caster, and no per-frame work: this is
 * static scene lighting.
 */
export default function GardenLight() {
  const light = SCENE.garden.light;
  return (
    <>
      {/* Sky above, warm earth bounce below. */}
      <hemisphereLight
        args={[light.ambient.sky, light.ambient.ground, light.ambient.intensity]}
      />

      {/* The key: low, warm, and the only shadow caster in the garden. */}
      <directionalLight
        color={light.key.color}
        intensity={light.key.intensity}
        position={light.key.position as unknown as [number, number, number]}
        castShadow={light.key.castShadow}
        shadow-mapSize-width={light.key.shadowMapSize}
        shadow-mapSize-height={light.key.shadowMapSize}
        shadow-camera-left={-light.key.shadowExtent}
        shadow-camera-right={light.key.shadowExtent}
        shadow-camera-top={light.key.shadowExtent}
        shadow-camera-bottom={-light.key.shadowExtent}
        shadow-camera-near={0.5}
        shadow-camera-far={40}
        shadow-bias={light.key.shadowBias}
        shadow-normalBias={light.key.shadowNormalBias}
      />

      {/* Cool counter-light for silhouette separation. */}
      <directionalLight
        color={light.fill.color}
        intensity={light.fill.intensity}
        position={light.fill.position as unknown as [number, number, number]}
      />
    </>
  );
}