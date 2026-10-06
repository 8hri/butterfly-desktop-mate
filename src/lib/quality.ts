/**
 * Device capability and accessibility detection.
 *
 * Keeps the experience smooth on weaker hardware and honours the user's
 * motion preferences, without shipping separate builds or effects.
 */
export interface QualitySettings {
  /** Upper bound for the renderer pixel ratio. */
  maxDpr: number;
  antialias: boolean;
  /** True when the user asked for reduced motion. */
  reducedMotion: boolean;
  /** Multiplier applied to movement speed and hover amplitude. */
  motionScale: number;
}

interface NavigatorWithHints extends Navigator {
  deviceMemory?: number;
}

/** Reads hints the browser exposes about the current device. */
function readDeviceTier(): "low" | "standard" | "high" {
  if (typeof navigator === "undefined") return "high";

  const nav = navigator as NavigatorWithHints;
  const memory = nav.deviceMemory ?? 8;
  const cores = nav.hardwareConcurrency ?? 8;
  const coarsePointer =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  if (memory <= 4 || cores <= 4) return "low";
  if (coarsePointer && (memory <= 8 || cores <= 8)) return "standard";
  return "high";
}

const DPR_BY_TIER = { low: 1.25, standard: 1.5, high: 2 } as const;

export function detectQuality(): QualitySettings {
  const tier = readDeviceTier();
  const reducedMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  return {
    maxDpr: DPR_BY_TIER[tier],
    antialias: tier !== "low",
    reducedMotion,
    // Slower, gentler movement rather than a static scene: the experience
    // still feels alive, just without fast motion.
    motionScale: reducedMotion ? 0.45 : 1,
  };
}
