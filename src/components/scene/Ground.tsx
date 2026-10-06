import { SCENE } from "../../config/experience";

/**
 * Soft ground plane; fog fades it into the sky at the horizon.
 *
 * `color` is optional and defaults to the shared palette, so desktop and web are
 * untouched. The garden passes its own surround tone (Phase 15.5A) so the
 * surface the clearing sits on belongs to the same world as the clearing.
 */
export default function Ground({ color = SCENE.palette.ground }: { color?: string }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
      <circleGeometry args={[70, 64]} />
      <meshStandardMaterial color={color} roughness={1} metalness={0} />
    </mesh>
  );
}
