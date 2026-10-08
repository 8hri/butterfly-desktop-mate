/**
 * Central configuration for the experience.
 *
 * The butterfly is a replaceable external asset: swapping the GLB (and, if
 * needed, the clip names below) requires no other code changes.
 */
// Explicit extensions so the module also loads under Node's type stripping,
// which the headless tests use. `allowImportingTsExtensions` is enabled.
import { DEFAULT_FLIGHT_TUNING, type FlightTuning } from "../lib/flight.ts";
import type { TargetingOptions } from "../lib/targeting.ts";
export const BUTTERFLY_ASSET = {
  /** Path of the model, relative to the `public` folder. */
  url: "/assets/animated_butterfly.glb",
  /**
   * Animation clip names to use for each logical state. Resolved with a
   * case-insensitive fallback so a re-exported model with slightly different
   * clip naming still works.
   */
  clips: {
    idle: "Idle",
    flying: "Flying",
    /**
     * Airborne hover: reuses the flap clip at a slower rate. The GLB's
     * perched "Idle" clip has folded, frozen wings — right for a future
     * perched-on-a-surface state, wrong for holding station mid-air.
     */
    hover: "Flying",
  },
  /** Playback rate of the hover flap (1 = the Flying clip's own speed). */
  hoverTimeScale: 0.55,
  /**
   * Auto-fit target: the model's largest bounding-box dimension is scaled to
   * this many world units, so any replacement GLB lands at a sane size.
   */
  targetSize: 1.35,
  /** Yaw offset if the replacement model faces another direction (radians). */
  yawOffset: 0,
} as const;

/**
 * Everything the renderer needs to present one butterfly GLB. This is the
 * whole "species" concept: no behaviour, no state — just the asset and how
 * to fit it. The shared auto-fit (targetSize) and the wrapper yaw keep a
 * replacement model at the same size, facing the same way, with the same
 * flight behaviour.
 */
export interface ButterflyAssetSpec {
  url: string;
  clips: {
    /** Optional perched pose; currently unused by the player. */
    idle?: string;
    flying: string;
    hover: string;
  };
  hoverTimeScale: number;
  targetSize: number;
  yawOffset: number;
}

/**
 * The second selectable butterfly (final phase): the repaired Ulysses GLB.
 *
 * Only the clip names and the yaw differ from the default asset. Its single
 * clip is called `fly`, which maps to both airborne states — the global
 * animation system is untouched. The model faces −Z in model space
 * (measured from its antenna-to-body joint vector; the default asset faces
 * +Z), so the wrapper turns it 180°. Its bounding box (≈2.3 units) is close
 * to the default model's, so the shared auto-fit needs no extra scale.
 */
export const ULYSSES_ASSET: ButterflyAssetSpec = {
  url: "/assets/ulysses_butterfly.fixed.glb",
  clips: { flying: "fly", hover: "fly" },
  hoverTimeScale: 0.55,
  targetSize: 1.35,
  yawOffset: Math.PI,
};

/**
 * The third selectable butterfly: a repaint of the original model — same
 * skeleton, same `Flying`/`Idle` clips, same +Z facing and the same bounding
 * box, so it maps exactly like the default asset and needs no yaw. The
 * source export contained an accidental Blender default cube (a visible 2×2×2
 * box around the model); the fixed file detaches that node from the scene
 * graph — nothing else was touched.
 */
export const CLOWN_ASSET: ButterflyAssetSpec = {
  url: "/assets/clown_butterfly.fixed.glb",
  clips: { idle: "Idle", flying: "Flying", hover: "Flying" },
  hoverTimeScale: 0.55,
  targetSize: 1.35,
  yawOffset: 0,
};

/** The selectable companions' stable identifiers. */
export type ButterflySpeciesId = "classic" | "ulysses" | "clown";

/** One selectable companion visual: an id, a label and its asset. */
export interface ButterflySpecies {
  id: ButterflySpeciesId;
  name: string;
  asset: ButterflyAssetSpec;
}

/**
 * The whole selection list. A short, deliberate set of visuals for the same
 * companion — not the start of a collection.
 */
export const BUTTERFLY_SPECIES: readonly ButterflySpecies[] = [
  { id: "classic", name: "Existing Butterfly", asset: BUTTERFLY_ASSET },
  { id: "ulysses", name: "Ulysses Butterfly", asset: ULYSSES_ASSET },
  { id: "clown", name: "Clown Butterfly", asset: CLOWN_ASSET },
];

/** Scene-level tuning values. Kept in one place so phases stay decoupled. */
interface SceneConfig {
  camera: {
    fov: number;
    near: number;
    far: number;
    /**
     * Raised 3/4 view: the butterfly's wings sit in a near-horizontal plane,
     * so the camera looks slightly down on it instead of edge-on.
     * A small lateral offset keeps the composition from feeling symmetrical.
     */
    position: [number, number, number];
    /** Point the camera keeps in view (where the butterfly lives). */
    lookAt: [number, number, number];
  };
  /** Pixel-ratio cap: 2 on desktop, lower on weak/mobile devices (Phase 7). */
  maxDpr: number;
  /** Linear fog: keeps depth subtle and hides the edge of the ground. */
  fog: { color: string; near: number; far: number };
  /** Palette shared by sky, fog and ground so everything blends softly. */
  palette: {
    skyTop: string;
    skyHorizon: string;
    skyBelow: string;
    ground: string;
  };
  /** Where the butterfly begins (also the anchor for camera follow). */
  butterfly: { start: [number, number, number] };
  /** Movement behaviour; tuned in `lib/flight.ts`. */
  flight: FlightTuning;
  /** Screen-to-world targeting surface; see `lib/targeting.ts`. */
  interaction: TargetingOptions;
  /** Garden mode (Phase 15.2+): the windowed presentation's tuning. */
  garden: {
    /** Garden window size in logical px, centered on the work area. */
    windowSize: { width: number; height: number };
    /**
     * Deterministic scatter seed for the grass. The garden looks the same on
     * every launch by construction; change the seed to rearrange the blades.
     */
    seed: number;
    /**
     * The clearing itself (Phase 15.5A): a small, bounded piece of habitat
     * instead of a flat coloured disc. A low-poly surface with gentle relief,
     * a soft raised bank around the rim, and a baked value gradient — solved
     * deterministically by `lib/garden.ts` from the seed below.
     *
     * The relief is deliberately tiny: `maxHeight` is a hard ceiling on *any*
     * displacement, and the whole surface stays far below the butterfly's
     * minimum flight floor, so this can never narrow the flight volume.
     */
    ground: {
      /** Outer radius of the clearing (world units). */
      radius: number;
      /** Radial rings and arc segments — the low-poly budget. */
      rings: number;
      segments: number;
      /** Hard ceiling on any displacement from the plane (≤ the flight floor). */
      maxHeight: number;
      /** How far the clearing sits above the shared ground plane. */
      lift: number;
      /** Within this radius the surface is effectively flat (props stand here). */
      clearingRadius: number;
      /**
       * The gentle relief, and how quickly it grows outward. `gradient` is the
       * exponent of the envelope: above 1 the relief is non-zero at *every*
       * radius and has no derivative jump, so the surface simply gets more
       * interesting toward the bank. (Phase 15.5A.1: a threshold ramp here left
       * the inner two thirds exactly flat and switched texture on over half a
       * unit — a visible circular seam.)
       */
      relief: { gradient: number; height: number };
      /** The soft raised bank: rises at `start`, peaks at `peak`, settles by the rim. */
      bank: { start: number; peak: number; height: number };
      /** Lowest fraction of the bank that survives where the relief field is low. */
      bankStrength: number;
      /**
       * Boundary irregularity (fraction of `radius`): the rim is not a perfect
       * circle, which is what stops it reading as a decal.
       */
      edgeJitter: number;
      /** Baked contact darkening under the placed props (see `lib/garden.ts`). */
      contact: { radius: number; strength: number };
      /** Value structure: warm/light where the butterfly flies, cooler at the rim. */
      colors: {
        inner: string;
        outer: string;
        bank: string;
        /** The larger surface the clearing sits on, fading into the fog. */
        surround: string;
      };
    };
    /**
     * The garden's own atmosphere (Phase 15.5A). The shared `fog` is tuned for
     * a desktop-sized world; the garden is about a dozen units across, so its
     * far distance has to arrive much sooner for depth to read at all. Desktop
     * and web keep `SCENE.fog` untouched.
     */
    fog: { color: string; near: number; far: number };
    /**
     * The garden's own sky (Phase 15.5D).
     *
     * The shared `SCENE.palette` sky belongs to desktop and web and stays
     * untouched. The garden needs its own because it is a dozen units across and
     * sits at the edge of a wood: a cool green-grey above, a pale warm band at
     * the horizon.
     *
     * `horizon` is deliberately within a whisker of `fog.color`. The ground
     * plane fades *to the fog colour* by `fog.far`, so if the sky at the horizon
     * is a different value the two meet in a hard horizontal line — the clearest
     * "flat disc on an infinite plane" tell there is. They must meet, not match.
     */
    sky: { top: string; horizon: string; below: string };
    /**
     * The far boundary (Phase 15.5D): the lightest possible statement that the
     * clearing ends and something else continues.
     *
     * Deliberately almost free. Two instanced silhouette families — low mounds
     * and thin spires — placed beyond the clearing, sized and coloured to sit
     * *under* the fog rather than in front of it. They are not a hedge and not a
     * wall: irregular, varying in height by more than half, and far enough out
     * that the fog has taken most of their contrast by the time the camera sees
     * them. The whole backdrop costs two draw calls and roughly 1.2k triangles:
     * the depth here comes from atmosphere and value, not from polygon count.
     */
    backdrop: {
      /** The band they stand in — outside the clearing *and* the flight volume. */
      inner: number;
      outer: number;
      /** Low dark humps: the mass that reads as undergrowth. */
      mounds: {
        count: number;
        minHeight: number;
        maxHeight: number;
        minWidth: number;
        maxWidth: number;
      };
      /** Thin tapered spikes: the texture that reads as distant grass. */
      spires: { count: number; minHeight: number; maxHeight: number; width: number };
      colors: { mound: string; spire: string; spireTip: string };
      /** How much tonal variation a silhouette may carry (0..1). */
      toneSpread: number;
    };
    /**
     * Garden-only lighting (Phase 15.5A). Deliberately *not* the shared
     * `Atmosphere`: the garden wants a lower, warmer key and a tighter
     * shadow box so objects read as planted rather than pasted. One shadow
     * caster, one small map, no post-processing.
     */
    light: {
      /** Sky/ground bounce; cool from above, warm from the earth. */
      ambient: { sky: string; ground: string; intensity: number };
      /** The warm low key. Angle is implied by `position`. */
      key: {
        color: string;
        intensity: number;
        position: readonly [number, number, number];
        castShadow: boolean;
        /** Half-extent of the orthographic shadow box (world units). */
        shadowExtent: number;
        shadowMapSize: number;
        /** Depth bias / normal bias, small enough to avoid peter-panning. */
        shadowBias: number;
        shadowNormalBias: number;
      };
      /** Cool fill from the opposite side, so silhouettes separate from the sky. */
      fill: { color: string; intensity: number; position: readonly [number, number, number] };
    };
    /**
     * Garden-only camera tuning (Phase 15.5A).
     *
     * `SCENE.camera.position` cannot be used for this: it is also the desktop
     * fixed shot's absolute home, so tuning it here would move the overlay. The
     * garden therefore gets its own offset, aim drop and travel clamps, fed
     * into the same follow-camera architecture.
     */
    camera: {
      /** Camera offset from the butterfly (relative home framing). */
      offset: readonly [number, number, number];
      /** Aim slightly below the butterfly so it rests above the frame centre. */
      lookAtDrop: number;
      /**
       * Travel clamps (see `lib/camera.ts`). Sized to cover the whole garden
       * flight volume so the framing never gives out at its edges.
       */
      travel: readonly [number, number, number];
    };
    /**
     * Turf: individual grass blades, placed with a density gradient and in
     * clusters (Phase 15.5B) rather than scattered uniformly.
     */
    grass: {
      count: number;
      radius: number;
      color: string;
      /** Blade width at the base; blades taper to a point. */
      bladeRadius: number;
      minHeight: number;
      maxHeight: number;
      /** Blades per cluster (a lone blade reads as debris, not turf). */
      clusterSize: number;
      /** Spread of a cluster around its seed point. */
      clusterSpread: number;
    };
    /**
     * The planting (Phase 15.5B): four families, one instanced draw each, so
     * the garden gains vertical structure without gaining draw calls.
     *
     * Placement is *composed*, never uniform: a radial density gradient keeps
     * the middle quiet, the rim carries the mass, and hand-placed clusters tie
     * planting to the landmarks. The central airspace is protected by
     * construction, not by convention — tall families can only stand beyond
     * `tallInnerRadius`, which is outside the flight volume's own reach, and
     * everything shorter stays under the butterfly's floor.
     */
    planting: {
      /** Nothing may stand inside this radius. */
      clearRadius: number;
      /** Tall families may only stand beyond this (outside the flight volume). */
      tallInnerRadius: number;
      /** How much tonal variation each instance may carry (0..1). */
      toneSpread: number;
      /** Low broad-leaf plants: three leaves on a short stem. */
      leaves: { count: number; radius: number; minHeight: number; maxHeight: number };
      /** The vertical layer: a thin stem with a pale head. */
      seedHeads: { count: number; radius: number; minHeight: number; maxHeight: number };
      /** Low foliage mounds that close the composition at the rim. */
      foliage: { count: number; radius: number; minHeight: number; maxHeight: number };
      /** Hand-placed clusters, one per landmark, so nothing looks dropped in. */
      clusters: ReadonlyArray<{
        at: readonly [number, number];
        radius: number;
        tufts: number;
        leaves: number;
        seedHeads: number;
      }>;
      /** The background band: heavier planting just inside the rim. */
      rim: { inner: number; outer: number; tufts: number; leaves: number; seedHeads: number; foliage: number };
      colors: {
        leaf: string;
        seedStem: string;
        seedHead: string;
        foliage: string;
      };
    };
    /** Flower dressing shared by all blossoms. */
    petals: number;
    stemColor: string;
    /**
     * Hand-placed composition: position is [x, z] on the ground plane.
     * `kind` picks the silhouette — an open daisy or a closed bud — so the five
     * landmarks read as related but not identical.
     */
    flowers: ReadonlyArray<{
      position: readonly [number, number];
      stem: number;
      blossom: string;
      center: string;
      scale: number;
      kind: "daisy" | "bud";
    }>;
    stones: ReadonlyArray<{
      position: readonly [number, number];
      scale: number;
      rotationY: number;
      color: string;
    }>;
    log: {
      position: readonly [number, number];
      rotationY: number;
      length: number;
      radius: number;
      color: string;
      /** Lighter cut end, so the branch reads as wood rather than a tube. */
      endColor: string;
    };
    /**
     * Interactive garden objects (Phase 15.4): how generously a click ray may
     * miss a blossom and still count as "that flower", how high above the
     * blossom the butterfly investigates from, and how long it stays once it
     * gets there.
     */
    interact: { radius: number; hoverOffset: number; stayMs: number };
    /**
     * Butterfly Chase (Phase 16.1): the one mini-game's tuning.
     *
     * Everything about the game that is a *number* or a *colour* lives here —
     * the game definition (`src/lib/butterflyChase.ts`) reads it, so tuning the
     * game never means touching its logic. Determinism note: the spawn stream
     * is seeded from the garden's own `seed`, so the same garden always offers
     * the same sequence of targets.
     */
    chase: {
      /** Total game length, seconds. Short: a visit, not a session. */
      durationSeconds: number;
      /** How long one target stays before it vanishes. */
      targetLifetimeSeconds: number;
      /**
       * How far from the *butterfly* a new target appears, as [min, max].
       *
       * Measured, not guessed: the butterfly's own arrival times for a directed
       * seek are ~2.5s at 1.6 units and ~4.2s at 3.2 units (mean, real
       * controller, 20 trials). The lifetime below is sized against these
       * numbers, so most targets are genuinely reachable before they vanish —
       * the chase is a chase, not a slideshow of unreachable lights. Spawning
       * anywhere in the whole area instead was measured to make arrival
       * impossible in most cases.
       */
      spawnDistance: readonly [number, number];
      /** Pause between one target going and the next appearing. */
      spawnGapSeconds: number;
      /** The click ray's closest approach to a target must be within this. */
      hitRadius: number;
      /**
       * The butterfly must be this close to a target for the target to be
       * catchable (Phase 16.1 fix).
       *
       * Measured from the flight model: arrivals settle within `arriveRadius`
       * (0.28) and the hover's own carry keeps the butterfly within roughly
       * 0.2 past that, so 0.56 (`arriveRadius` × 2) covers arrival plus the
       * hover envelope — no more, no less. The chase's seek target and its hit
       * test refer to the exact same world point, so this is the same distance
       * the flight controller itself uses to declare arrival.
       */
      catchRadius: number;
      /** Targets keep this far from flowers, stones and the log (world units). */
      minLandmarkDistance: number;
      /** Visual size of the target marker (world radius). */
      targetRadius: number;
      /** The target pulses visibly for its last this-many seconds. */
      expiringSeconds: number;
      color: string;
    };
    /**
     * The Garden's own flight volume (Phase 15.4 Fix 4).
     *
     * Desktop keeps the shared shallow depth slab: there the camera is FIXED,
     * the butterfly's screen position *is* its position on the work area, and a
     * thin slab keeps perspective scale constant so one box both stays in frame
     * and reaches most of the surface. Garden uses the follow rig and has its
     * own content, so it does not inherit that slab — its depth follows the
     * configured garden content (flowers, stones, log) plus this margin, while X
     * and altitude keep the shared framing behaviour unchanged.
     *
     * Solved by `gardenFlightArea` in `lib/airspace.ts`, from these numbers and
     * the layout above — never a hand-typed volume.
     */
    flightArea: {
      /** Modest, deterministic margin beyond the content extent (world units). */
      depthMargin: number;
    };
  };
}

export const SCENE: SceneConfig = {
  camera: {
    fov: 45,
    near: 0.1,
    far: 120,
    position: [0.9, 2.5, 5.2],
    lookAt: [0, 1.25, 0],
  },
  maxDpr: 2,
  fog: { color: "#e9f0ec", near: 6, far: 46 },
  palette: {
    skyTop: "#bcd8d6",
    skyHorizon: "#eaf1ee",
    skyBelow: "#f4f7f4",
    ground: "#cfdbd4",
  },
  butterfly: { start: [0, 1.4, 0] },
  flight: { ...DEFAULT_FLIGHT_TUNING },
  interaction: {
    // The camera's look height: a click at the centre of the frame then
    // resolves to roughly the point the camera is already framing.
    planeY: 1.25,
    // How far along the ray a click sits when it passes above the horizon
    // (used as the depth reference before clamping into the area's z-band).
    // It has to reach past the DEEPEST area's far wall, or an above-horizon
    // click would resolve to a depth *nearer* than the rays just below the
    // horizon — moving the cursor up would quietly move the butterfly toward
    // the camera. The follow rig keeps the camera up to 5.2 behind the
    // butterfly and the garden reaches z = -3.9, so the shallowest
    // above-horizon ray still has to get past 11.7 units here. Desktop and web
    // clamp any such depth into their own shallow band either way, which is why
    // this is invisible there.
    maxRayDistance: 13,
    // Calibrated so a click near the top/bottom of the window maps to the top
    // /bottom of the flight area's altitude band (1.675 ± 1.35 -> clamped to
    // 0.60..2.75), while the centre of the frame stays neutral. The outer
    // ~10% of the window saturates at the bounds, which keeps a target
    // reachable. The band's centre is the area's own centre, so the altitude
    // rules stay in lockstep with `flight.area` (see `lib/flight.ts`).
    verticalRange: 1.35,
  },
  garden: {
    windowSize: { width: 1100, height: 700 },
    seed: 20260,
    ground: {
      radius: 7,
      rings: 9,
      segments: 36,
      // 0.12 is the brief's ceiling and an order of magnitude below the 0.6
      // flight floor, so the surface can never intrude into the airspace.
      maxHeight: 0.12,
      // A few millimetres proud of the shared ground plane: the clearing's rim
      // then meets that plane instead of lying exactly on it.
      lift: 0.004,
      // Everything hand-placed stands within ~3.5 units of the centre, so the
      // usable clearing is kept flat and only the outer ground carries relief.
      clearingRadius: 3.5,
      relief: { gradient: 2.4, height: 0.03 },
      bank: { start: 0.56, peak: 0.86, height: 0.085 },
      // How far the bank's strength is allowed to wander with the ground's own
      // relief field. Lower = more broken-up boundary, less drawn circle.
      bankStrength: 0.45,
      edgeJitter: 0.05,
      // Wide and soft on purpose: the clearing is baked into vertex colours, so
      // the pool of shade under each object has to be comfortably larger than
      // the mesh's vertex spacing to survive at all.
      contact: { radius: 0.75, strength: 0.34 },
      colors: {
        inner: "#b3bd8e",
        outer: "#8b9a72",
        bank: "#75875f",
        surround: "#94a37f",
      },
    },
    // A dozen units across, so the horizon has to arrive early: at far 46 the
    // garden simply ran out into a pale empty plane. But it must not arrive so
    // early that it bleaches the *whole* clearing — rendered at near 4 / far 16
    // the far rim was two thirds fogged and every value in the garden went to
    // white, which flattened the new planting into paper. Near 7 / far 26 keeps
    // a real depth gradient and leaves the middle of the scene alone.
    fog: { color: "#dfe8dc", near: 7, far: 26 },
    // The garden's own atmosphere. Cool green-grey above — it belongs to a
    // clearing under trees, not to open sky — easing to a pale warm band at the
    // horizon that meets the fog colour (which is what the far ground fades to).
    // No saturated blue, no sunset: the sky is the softest layer in the frame
    // and must never compete with the butterfly.
    sky: { top: "#8fa89f", horizon: "#dde4d6", below: "#cdd6c4" },
    // The far boundary (Phase 15.5D). Sits well outside the clearing (6.5) and
    // far outside the flight volume's reach (4.63), in the band where the fog
    // has already taken most of its contrast. Heights vary by more than half so
    // it never reads as a hedge; the mounds are the mass, the spires the texture.
    backdrop: {
      // Measured, not guessed. The follow camera's own reach across the whole
      // flight volume is 7.83 units from the origin — it trails the butterfly by
      // up to 4.6 in z, and the butterfly reaches z +2.6 — so a rim placed just
      // past the clearing ends up *beside the camera*. Measured at inner 7.6:
      // 106,737 of 109,350 camera-pose/silhouette pairs sat at under half fog and
      // the nearest silhouette came within 0.95 units, i.e. crisp and in your
      // face. Sweeping the band outward against the current fog (near 7 / far
      // 26), the least-fogged *visible* silhouette goes 11% at 12.5, 23% at 15,
      // 33% at 17. This sits at the point where the rim is unmistakably further
      // away than the clearing's own content, and still inside the fog's far
      // plane rather than erased by it.
      inner: 15,
      outer: 21,
      // Read from inside the clearing, these are far larger than intended. The
      // camera sits only ~4.5 units from the origin and the band is at 15..21,
      // but a mound 1.9 tall and 2.1 wide still subtends a large angle: it came
      // out as a row of pale triangular *spikes* the height of the clearing's
      // own bank. Undergrowth at the edge of a wood is low — it should sit
      // under the horizon line, not above it. Heights and widths are roughly
      // halved, and the count raised to keep the boundary continuous.
      // Counted against the triangle budget, not picked by eye: at 12 triangles
      // per mound the count is the only real lever, and 84 + 190 overran 25k.
      // 72 + 150 keeps the boundary continuous at 1,764 triangles.
      mounds: { count: 72, minHeight: 0.45, maxHeight: 0.95, minWidth: 0.5, maxWidth: 1.0 },
      spires: { count: 150, minHeight: 0.35, maxHeight: 1.1, width: 0.05 },
      // Darker than the clearing and desaturated: at this distance the fog does
      // the rest. A rim lighter than the ground would read as a bright wall —
      // rendered at these values the first pass caught enough key light on the
      // mound flanks to make them glow against the haze.
      colors: { mound: "#5c6b52", spire: "#66755c", spireTip: "#7f8d72" },
      toneSpread: 0.1,
    },
    light: {
      // Warm, and dimmer: a cool 0.55 ambient over a pale ground was what made
      // the garden read cold and washed out. Less bounce, more key, so the
      // contact shadows that plant the objects are actually visible.
      ambient: { sky: "#dfe4d2", ground: "#c3a97a", intensity: 0.42 },
      key: {
        color: "#ffe6bd",
        intensity: 1.75,
        position: [7, 3.2, 5],
        castShadow: true,
        // Tight box: every placed prop stands within ~3.5 units, so this keeps
        // the map's texels dense instead of spreading them over empty ground.
        shadowExtent: 4.2,
        shadowMapSize: 1024,
        shadowBias: -0.0006,
        shadowNormalBias: 0.02,
      },
      fill: { color: "#cfdcec", intensity: 0.3, position: [-6, 3.5, -5] },
    },
    // Same follow architecture, a little closer and a little flatter than the
    // shared framing (distance 5.40 -> 4.72, pitch 13.3deg -> 11.0deg): enough to
    // read vertical structure and the rim, not a different camera. Travel is
    // sized so no clamp engages anywhere in the garden flight volume.
    camera: {
      offset: [0.8, 0.7, 4.6],
      lookAtDrop: 0.2,
      // Sized from the flight volume itself (plus pointer parallax), so no clamp
      // engages anywhere the butterfly can reach: the world is small enough that
      // the follow shot never needs rescuing at its edges.
      travel: [3.6, 2.8, 4.1],
    },
    grass: {
      // Gradient: nothing where the butterfly flies, sparse open ground, the
      // heaviest continuous field at the rim, with denser mats around the
      // landmarks themselves (the clusters below).
      //
      // Turf has to read as a *mat*, not as scattered spikes or bare ground with
      // sprigs on it. Coverage is bought with blade *width*, not with blade
      // count: 1900 wide blades close the ground for the same triangles that
      // 1900 narrow ones left as visible gaps. The value sits close to the
      // clearing's own so the mat reads as texture rather than as debris, and
      // the clusters are tight enough that a tuft is a tuft.
      count: 1900,
      radius: 6.1,
      color: "#a9b78d",
      bladeRadius: 0.05,
      minHeight: 0.12,
      maxHeight: 0.26,
      clusterSize: 5,
      clusterSpread: 0.1,
    },
    planting: {
      clearRadius: 1.7,
      tallInnerRadius: 4.9,
      // Softer per-instance variation than 15.5B's first pass: at 0.13 the
      // families read as speckled rather than as one plant with depth in it.
      toneSpread: 0.09,
      // `count` is each family's total in the garden: the landmark clusters and the
      // rim band take part of it, the density gradient fills the rest.
      leaves: { count: 120, radius: 6.0, minHeight: 0.2, maxHeight: 0.4 },
      // Seed heads are a *grass* seed head, not a cattail: at up to 1.55 units
      // they stood six times the butterfly's height and the rim became a hedge.
      seedHeads: { count: 34, radius: 6.3, minHeight: 0.45, maxHeight: 0.85 },
      foliage: { count: 80, radius: 6.4, minHeight: 0.35, maxHeight: 0.7 },
      // A cluster per landmark — all five flowers, the limb and the stones. These
      // are what make the planting look tended rather than scattered.
      clusters: [
        { at: [-2.2, -1.6], radius: 0.85, tufts: 24, leaves: 14, seedHeads: 2 },
        { at: [2.1, -1.5], radius: 0.75, tufts: 22, leaves: 12, seedHeads: 2 },
        { at: [-2.7, 1.1], radius: 0.75, tufts: 18, leaves: 10, seedHeads: 1 },
        { at: [2.5, 1.5], radius: 0.7, tufts: 18, leaves: 10, seedHeads: 1 },
        { at: [-0.4, -3.4], radius: 0.95, tufts: 26, leaves: 14, seedHeads: 3 },
        { at: [-2.5, 2.1], radius: 0.8, tufts: 24, leaves: 16, seedHeads: 2 },
        { at: [0.5, -2.6], radius: 0.7, tufts: 20, leaves: 12, seedHeads: 2 },
      ],
      rim: { inner: 4.9, outer: 6.5, tufts: 300, leaves: 26, seedHeads: 22, foliage: 40 },
      colors: {
        leaf: "#7d9a68",
        seedStem: "#8aa06f",
        // Not white: a pale head against a pale sky is the brightest thing in
        // the frame, and 58 of them pulled the eye straight to the rim.
        seedHead: "#c9bf94",
        foliage: "#6b8759",
      },
    },
    petals: 5,
    stemColor: "#6f8f6a",
    flowers: [
      { position: [-2.2, -1.6], stem: 0.46, blossom: "#e8b7c8", center: "#e8c46a", scale: 1.05, kind: "bud" },
      { position: [2.1, -1.5], stem: 0.42, blossom: "#d8c0e4", center: "#e8c46a", scale: 0.95, kind: "daisy" },
      { position: [-2.7, 1.1], stem: 0.4, blossom: "#f0d78c", center: "#c98f5f", scale: 1.1, kind: "bud" },
      { position: [2.5, 1.5], stem: 0.5, blossom: "#eeb8c4", center: "#e8c46a", scale: 1.0, kind: "daisy" },
      { position: [0.5, -2.6], stem: 0.36, blossom: "#f4efe0", center: "#ddc27e", scale: 0.9, kind: "daisy" },
    ],
    stones: [
      // A trio in the near foreground: close enough to the camera to frame the
      // shot, and — deliberately — reaching z +2.1 exactly as the old placement
      // did, so the garden's content depth, and therefore its flight volume, is
      // unchanged. Warm grey and a touch lighter: rendered cool and dark, three
      // overlapping stones read as one jagged blue-black mass.
      { position: [-2.5, 2.1], scale: 0.46, rotationY: 0.6, color: "#c6c6ba" },
      { position: [-1.55, 1.95], scale: 0.32, rotationY: 1.9, color: "#b8bbaf" },
      { position: [-3.05, 1.6], scale: 0.38, rotationY: 0.2, color: "#d0cfc2" },
    ],
    log: {
      position: [-0.4, -3.4],
      rotationY: 0.5,
      length: 1.7,
      radius: 0.17,
      color: "#8a7053",
      endColor: "#b39a74",
    },
    interact: {
      radius: 0.5,
      hoverOffset: 0.4,
      // Post-arrival stay for a *successful* flower flight: once the butterfly
      // has actually arrived, the flower keeps it for this long before the
      // cursor is allowed to take over again. Distinct from the refusal hold
      // (`FLOWER_HOLD_MS`), which covers the case where no flight started at
      // all — arriving is what earns a stay, not clicking.
      stayMs: 3000,
    },
    // Butterfly Chase (Phase 16.1). A half-minute visit: targets last long
    // enough to be clicked but not to linger, and the butterfly is sent after
    // each one, so the garden reads as a chase rather than a shooting range.
    chase: {
      durationSeconds: 30,
      // Sized against the measured arrival curve (see `spawnDistance`): at the
      // farthest spawn the butterfly needs ~4.2s, so a target lives long enough
      // to be genuinely reachable, with a little left over to click it.
      targetLifetimeSeconds: 5,
      spawnDistance: [1.8, 3.0],
      spawnGapSeconds: 0.9,
      hitRadius: 0.7,
      // arriveRadius (0.28) × 2: arrival plus the hover's measured carry.
      catchRadius: 0.56,
      minLandmarkDistance: 0.9,
      targetRadius: 0.09,
      expiringSeconds: 1.1,
      color: "#f2d38a",
    },
    // The garden content spans z = -3.4 (log) ... +2.1 (stone), so the volume
    // reaches -3.9 ... +2.6: every flower, stone and log is inside the butterfly's
    // reachable depth, with half a unit of breathing room past the furthest one.
    flightArea: { depthMargin: 0.5 },
  },
};
