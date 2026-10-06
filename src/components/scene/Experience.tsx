import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import { SCENE, type ButterflySpecies } from "../../config/experience";
import { FlightController } from "../../lib/flight";
import { Personality } from "../../lib/personality";
import { CompanionMemory } from "../../lib/memory";
import { flightAreaForAspect, gardenFlightArea } from "../../lib/airspace";
import { fallbackGeometry, type DesktopGeometry } from "../../lib/desktop/geometry";
import { loadDesktopEnvironment } from "../../lib/desktop/environment";
import {
  createCoalescedRefresh,
  refreshEnvironmentFacts,
  watchDesktopEnvironment,
} from "../../lib/desktop/refresh";
import type { DesktopEnvironment } from "../../lib/desktop/environment";
import { loadForegroundWindow, watchForegroundChanges } from "../../lib/desktop/windows";
import { worldBoundsForDesktopRect } from "../../lib/awareness";
import { isDesktop } from "../../lib/platform";
import { desktopSystemsActive, type AppMode } from "../../lib/appMode";
import { MiniGameRuntime, miniGameFlightSurface } from "../../lib/minigame";
import { detectQuality } from "../../lib/quality";
import Atmosphere from "./Atmosphere";
import Ground from "./Ground";
import SkyDome from "./SkyDome";
import GardenLight from "../garden/GardenLight";
import GardenWorld from "../garden/GardenWorld";
import ChaseTargetMarker from "../garden/ChaseTargetMarker";
import ChaseHud from "../garden/ChaseHud";
import Butterfly from "../butterfly/Butterfly";
import CameraRig, { createPointerState } from "./CameraRig";
import Interaction from "./Interaction";
import VisibilityGate from "./VisibilityGate";

/**
 * The 3D scene shell: renderer, camera, fog, environment, butterfly and
 * interaction. Quality settings are resolved once from device capabilities.
 *
 * The desktop shell runs the same scene, but without the backdrop, ground and
 * fog so the native window's transparency shows through. Lighting, the
 * butterfly, its animation and all interaction stay identical.
 */
/**
 * Keeps the flight layer's foreground preference in step with the desktop.
 *
 * Lives *inside* the Canvas because it needs the live camera: a desktop-space
 * fact (the foreground window) has to be projected into world space before the
 * flight controller can compare anything against it, and only the camera knows
 * the current aspect. It reuses the existing coalesced refresh — the same
 * mechanism, no second coordinator and no timer — and publishes four numbers,
 * or withdraws them when there is no window.
 */
function ForegroundAwareness({ flight, mode }: { flight: FlightController; mode: AppMode }) {
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    if (!isDesktop || !desktopSystemsActive(mode).foregroundAwareness) return;
    let cancelled = false;

    const apply = async () => {
      const environment = await loadDesktopEnvironment(
        window.innerWidth,
        window.innerHeight,
      );
      const foreground = await loadForegroundWindow(environment.scaleFactor);
      if (cancelled) return;
      flight.setForegroundBounds(
        foreground.window
          ? worldBoundsForDesktopRect(
              camera,
              foreground.window,
              environment,
              flight.area,
            )
          : null,
      );
    };

    void apply();
    const refresh = createCoalescedRefresh(apply);
    // Both triggers are hints that something *may* have changed; the fact is
    // always re-read from the OS above.
    const stopEnvironment = watchDesktopEnvironment(() => refresh.invalidate());
    const stopForeground = watchForegroundChanges(() => refresh.invalidate());

    return () => {
      cancelled = true;
      refresh.cancel();
      stopEnvironment();
      stopForeground();
      // Nothing stale may outlive the component that published it.
      flight.setForegroundBounds(null);
    };
  }, [camera, flight, mode]);

  return null;
}

export default function Experience({
  mode,
  species,
  onEnterGarden,
  onReady,
}: {
  /**
   * The current window mode (`lib/appMode.ts`). Passed *down* — never used to
   * recreate anything: the flight, personality and memory instances below are
   * mode-independent and survive every desktop ↔ garden transition.
   */
  mode: AppMode;
  /**
   * The selected butterfly visual (final phase). Like the mode, it only flows
   * down to the one component that renders the model; every behaviour
   * instance below is species-independent and survives a switch.
   */
  species: ButterflySpecies;
  /** Reports the entry gesture (double-click near the butterfly) upward. */
  onEnterGarden: () => void;
  onReady: () => void;
}) {
  const { camera, fog, butterfly } = SCENE;
  // The garden visits a world about a dozen units across. At the shared
  // desktop-scale distances its far ground simply ran out into a pale empty
  // plane, so the garden brings its own fog (Phase 15.5A). Desktop and web keep
  // `SCENE.fog` exactly as it was.
  const atmosphere = mode === "garden" ? SCENE.garden.fog : fog;
  const handleReady = useCallback(() => onReady(), [onReady]);

  const quality = useMemo(() => detectQuality(), []);

  /** Movement + input state lives here so every scene layer shares it. */
  const flight = useMemo(
    () =>
      new FlightController(
        { ...SCENE.flight, motionScale: quality.motionScale },
        new Vector3(...butterfly.start),
      ),
    [quality.motionScale, butterfly.start],
  );
  const pointer = useMemo(() => createPointerState(), []);
  /**
   * The butterfly's personality: owns reaction intensity (attention, state,
   * profile), never movement. Interaction reports events to it (cursor
   * proximity, crowding, clicks); it decides what they mean. With no
   * interaction history it stays in its reference state and the behavior is
   * identical to before this layer existed.
   */
  const personality = useMemo(() => new Personality(), []);
  /**
   * The companion's long-term memory (Phase 14). Local, tiny and inert until
   * a meaningful event lands: it is loaded from localStorage (falling back to
   * empty on any failure), and it never touches the flight controller — it
   * only feeds an abstract companion state into the personality.
   */
  const companion = useMemo(() => new CompanionMemory(), []);

  /**
   * The mini-game runtime (Phase 16). One instance for the app's lifetime, like
   * the flight, personality and memory instances: a game borrows the companion
   * and returns it, so the runtime must not remount and lose the game mid-way.
   *
   * It is constructed with the two narrow seams it needs and nothing else: the
   * flight *surface* (the two verbs a person's click already has) and the
   * autonomy-suppression toggle. With no game started it owns nothing and costs
   * nothing.
   */
  const minigame = useMemo(
    () =>
      new MiniGameRuntime({
        flight: miniGameFlightSurface(flight),
        setAutonomySuppressed: (suppressed) => flight.setAutonomySuppressed(suppressed),
      }),
    [flight],
  );

  // Session lifecycle: open exactly one session per launch (idempotent —
  // StrictMode re-runs effects), publish the derived companion state, and
  // persist best-effort on page hide / unmount. A failed save is swallowed
  // inside the runtime; a crash loses at most the debounce window.
  useEffect(() => {
    companion.beginSession();
    personality.setCompanion(companion.state);
    const persist = () => companion.flush();
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("pagehide", persist);
      companion.flush();
    };
  }, [companion, personality]);

  /**
   * Interaction reports one *answered* summon — a click the butterfly
   * actually flew to. Memory grows only through this callback and session
   * start; cursor presence never reaches it.
   */
  const handleSummon = useCallback(() => {
    companion.recordSummon();
    personality.setCompanion(companion.state);
  }, [companion, personality]);

  /**
   * Garden object feedback (Phase 15.4): which object was last clicked, plus
   * a nonce so clicking the same flower twice still retriggers the pulse.
   * It is *presentation* state only — the companion's response was already
   * requested through the ordinary interaction surface by the same click.
   */
  const [gardenFeedback, setGardenFeedback] = useState<{ id: string | null; nonce: number }>({
    id: null,
    nonce: 0,
  });
  const handleGardenObject = useCallback((id: string) => {
    setGardenFeedback((previous) => ({ id, nonce: previous.nonce + 1 }));
  }, []);

  /**
   * Drives the mini-game runtime's clock from the frame loop (Phase 16.1).
   * The runtime owns the state machine; this is the only tick source, and it
   * runs only while a game is actually playing, so it costs nothing otherwise.
   */
  function MiniGameTicker() {
    useFrame((_, dt) => {
      minigame.update(Math.min(dt, 1 / 20));
    });
    return null;
  }

  // Desktop: the airspace is the visible desktop itself. The overlay covers
  // the primary monitor's work area, so once the native geometry is known
  // the flight area is re-solved for its real aspect ratio — no window-size
  // constant anywhere in the flight logic.
  //
  // The facts behind that are kept fresh by the desktop refresh coordinator:
  // window resize / scale-change / move events mark them stale, a burst of them
  // collapses into one refresh at the next frame, and the flight area is only
  // re-solved when the work area's aspect actually changed. Nothing about the
  // butterfly is reset by a refresh — no destination, no personality, no
  // animation.
  useEffect(() => {
    if (!isDesktop || !desktopSystemsActive(mode).environmentRefresh) return;
    let cancelled = false;
    let previous: DesktopEnvironment | undefined;
    let geometry: DesktopGeometry | null = null;

    const apply = async () => {
      const outcome = await refreshEnvironmentFacts(
        { width: window.innerWidth, height: window.innerHeight },
        previous,
      );
      if (cancelled) return;
      previous = outcome.environment;

      // Desktop geometry: an unchanged or failed read leaves everything exactly
      // as it was.
      if (outcome.changed) {
        geometry = outcome.geometry ?? geometry;
        const area =
          geometry ?? fallbackGeometry(window.innerWidth, window.innerHeight);
        if (outcome.aspectChanged) {
          flight.setArea(flightAreaForAspect(area.width / area.height));
        }
      }
    };

    // First read at startup: identical to the original one-shot load.
    void apply();
    const refresh = createCoalescedRefresh(apply);
    const stopWatching = watchDesktopEnvironment(() => refresh.invalidate());

    return () => {
      cancelled = true;
      refresh.cancel();
      stopWatching();
    };
  }, [flight, mode]);

  // Garden mode: the windowed presentation, and the garden's OWN flight volume
  // — the desktop slab is not inherited here. That slab is a fixed-camera
  // trade (shallow depth keeps perspective scale constant so one box both stays
  // in frame and reaches most of the work-area surface); the garden follows the
  // butterfly with the same rig over a garden several units deep, where a 1-unit
  // depth band both capped the butterfly and saturated the pointer mapping. So
  // the volume comes from the configured garden content (see
  // `gardenFlightArea`), while X and altitude keep the shared framing solve.
  //
  // The window's own aspect still drives X, re-solved on resize — events, not
  // polling. The desktop effect above re-solves the desktop area from the work
  // area when the overlay is restored, so the two volumes never meet.
  useEffect(() => {
    if (mode !== "garden") return;
    const solve = () =>
      flight.setArea(gardenFlightArea(window.innerWidth / window.innerHeight, SCENE.garden));
    solve();
    window.addEventListener("resize", solve);
    return () => window.removeEventListener("resize", solve);
  }, [flight, mode]);

  return (
    <>
      {/* Butterfly Chase HUD (Phase 16.1): a DOM layer *above* the canvas, so
          the game's chrome is ordinary accessible markup, not a second scene.
          It is invisible while no game is active. Garden only. */}
      {mode === "garden" && <ChaseHud runtime={minigame} flight={flight} />}
      <Canvas
      className="app__canvas"
      dpr={[1, Math.min(SCENE.maxDpr, quality.maxDpr)]}
      camera={{
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
        position: camera.position,
      }}
      onCreated={({ camera: cam }) => cam.lookAt(...camera.lookAt)}
      gl={{
        antialias: quality.antialias,
        // A transparent window needs an alpha-enabled canvas.
        alpha: isDesktop,
        powerPreference: "high-performance",
      }}
    >
      {/* The opaque presentation: the web build always has it, the desktop
          shell only while the garden is being visited. */}
      {(!isDesktop || mode === "garden") && <color attach="background" args={[atmosphere.color]} />}
      {(!isDesktop || mode === "garden") && (
        <fog attach="fog" args={[atmosphere.color, atmosphere.near, atmosphere.far]} />
      )}

      <VisibilityGate />
      {/* Desktop fact -> world box. Inside the Canvas: it needs the live camera. */}
      <ForegroundAwareness flight={flight} mode={mode} />

      {/*
        Lighting: the shared atmosphere for the desktop overlay and the web
        build, and the garden's own rig while visiting (Phase 15.5A) — the
        garden wants a lower, warmer key and a tight shadow box, which is a
        look decision, not a mode the desktop should inherit. Backdrop stays
        browser-only either way.
      */}
      {mode === "garden" ? <GardenLight /> : <Atmosphere />}
      {/* The garden brings its own sky tones (Phase 15.5D); desktop and web keep
          the shared palette exactly as they were. */}
      {(!isDesktop || mode === "garden") && (
        <SkyDome
          palette={
            mode === "garden"
              ? {
                  skyTop: SCENE.garden.sky.top,
                  skyHorizon: SCENE.garden.sky.horizon,
                  skyBelow: SCENE.garden.sky.below,
                }
              : undefined
          }
        />
      )}
      {(!isDesktop || mode === "garden") && (
        <Ground color={mode === "garden" ? SCENE.garden.ground.colors.surround : undefined} />
      )}
      {/* The garden world itself — scenery plus its quiet feedback pulse. */}
      {mode === "garden" && <GardenWorld feedback={gardenFeedback} />}

      {/* Butterfly Chase (Phase 16.1): the target marker lives in the world,
          and the game's clock is driven from the frame loop. Both are inert
          while no game is playing. */}
      {mode === "garden" && <MiniGameTicker />}
      {mode === "garden" && <ChaseTargetMarker runtime={minigame} />}

      {/* Only the model is async: the environment appears immediately. The
          key makes a species switch remount just this component — the same
          flight, personality, memory and game keep running underneath. */}
      <Suspense fallback={null}>
        <Butterfly
          key={species.id}
          asset={species.asset}
          flight={flight}
          personality={personality}
          onReady={handleReady}
        />
      </Suspense>

      <Interaction
        flight={flight}
        personality={personality}
        pointer={pointer}
        mode={mode}
        minigame={minigame}
        onEnterGarden={onEnterGarden}
        onGardenObject={handleGardenObject}
        onSummon={handleSummon}
      />
      <CameraRig flight={flight} pointer={pointer} mode={mode} />
      </Canvas>
    </>
  );
}
