import type { AnimationClip } from "three";

/**
 * Resolves a logical animation name against the clips actually present in a
 * GLB. Tries exact match, then case-insensitive, then substring — so a
 * replacement model with slightly different clip naming still works.
 */
export function resolveClip(
  clips: readonly AnimationClip[],
  name: string,
): AnimationClip | null {
  const wanted = name.toLowerCase();
  return (
    clips.find((c) => c.name === name) ??
    clips.find((c) => c.name.toLowerCase() === wanted) ??
    clips.find((c) => c.name.toLowerCase().includes(wanted)) ??
    null
  );
}
