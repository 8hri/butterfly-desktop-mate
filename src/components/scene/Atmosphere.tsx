/**
 * Scene lighting.
 *
 * Lighting is shared by both presentations: the browser experience and the
 * desktop shell. Only the backdrop differs (see SkyDome and Ground), so the
 * desktop window can be transparent without losing the soft, natural light.
 */
export default function Atmosphere() {
  return (
    <>
      {/* Soft ambient base: sky tint from above, ground tint from below */}
      <hemisphereLight args={["#eef6f4", "#c6d2c6", 0.75]} />

      {/* Warm key light, gently angled */}
      <directionalLight position={[4, 7, 5]} intensity={1.1} color="#fff7ec" />

      {/* Cool fill from the opposite side to avoid flat shading */}
      <directionalLight position={[-5, 3, -4]} intensity={0.35} color="#e6f0ff" />
    </>
  );
}
