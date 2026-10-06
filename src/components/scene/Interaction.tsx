import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { Vector2, Vector3 } from "three";
import { SCENE } from "../../config/experience";
import type { FlightController } from "../../lib/flight";
import type { Personality } from "../../lib/personality";
import { screenToWorldTarget } from "../../lib/targeting";
import { isDesktop } from "../../lib/platform";
import { desktopSystemsActive, type AppMode } from "../../lib/appMode";
import {
  flowerOwnershipEnds,
  gardenObjects,
  investigationPoint,
  pickGardenObject,
} from "../../lib/garden";
import type { MiniGameRuntime } from "../../lib/minigame";
import {
  desktopToNdc,
  fallbackGeometry,
  loadDesktopGeometry,
  onDesktopGeometryChange,
  type DesktopGeometry,
} from "../../lib/desktop/geometry";
import { startCursorPolling } from "../../lib/desktop/cursor";
import { HitZone } from "../../lib/desktop/hittest";
import { setIgnoreCursorEvents } from "../../lib/desktop/window";
import type { PointerState } from "./CameraRig";

/** Polling interval of the desktop cursor source (see `desktop/cursor.ts`). */
const CURSOR_POLL_INTERVAL_MS = 33;
/**
 * A click this close to the butterfly (world units) counts as a *near* click —
 * direct interaction with it rather than a movement instruction across the
 * screen. World units are used because both input paths already resolve to the
 * same world point; the pixel-based hit zone stays where it is (it governs
 * click-through, not intent).
 */
const NEAR_CLICK_DISTANCE = 1.2;

/**
 * How long a flower keeps the cursor out when `seekTo` correctly refused to
 * fly (the butterfly was already within `arriveRadius` of the flower): long
 * enough that the click plainly lands on the flower, short enough that
 * ordinary cursor behaviour resumes promptly afterwards. A real flight is not
 * covered by this timer — arrival earns its own stay instead (below).
 */
const FLOWER_HOLD_MS = 1500;

/**
 * How long the butterfly stays with a flower it actually flew to, counted from
 * arrival (the controller's completion signal) rather than from the click.
 * Arriving at a flower is a response worth a moment of the companion's
 * attention; the cursor simply takes over again afterwards, with no new mode,
 * attraction or re-targeting involved — the butterfly is already there, and its
 * ordinary hover carries it while the stay runs.
 */
const FLOWER_STAY_MS = SCENE.garden.interact.stayMs;

/**
 * Translates pointer input into world-space intent for the butterfly, along
 * two clearly separated paths:
 *
 * WEB — DOM pointer events on the canvas:
 *   pointermove/click -> canvas-local NDC -> targeting -> aimAt/seekTo.
 *
 * DESKTOP — the global OS cursor (the overlay is click-through most of the
 * time, so DOM events cannot be the source):
 *   cursorPosition (desktop px) -> logical px -> NDC -> targeting -> notice.
 *   The cursor is an environmental *presence* the butterfly reacts to
 *   subtly — it is never a target to chase; summoning stays with the click.
 *   The same loop drives the hit-test zone: the overlay only accepts cursor
 *   events while the cursor is near the butterfly, and passes everything
 *   else through to the applications underneath.
 *
 * Both paths end in the same `screenToWorldTarget` mapping and the same
 * live-target call, so "there" means the same place on either platform.
 *
 * Both paths additionally *report* what they already know — cursor proximity,
 * crowding and clicks — to the personality, which alone decides what those
 * events mean. Nothing here reads the resulting state: no movement call is
 * conditional on it, so personality can never intercept, redirect or
 * prioritise a movement request.
 */
export default function Interaction({
  flight,
  personality,
  pointer,
  mode,
  minigame,
  onEnterGarden,
  onGardenObject,
  onSummon,
}: {
  flight: FlightController;
  /**
   * Reaction-intensity model. Interaction only *reports* events (proximity,
   * crowding, clicks); it never decides what they mean — that is entirely the
   * personality's job, and no movement call below depends on it.
   */
  personality: Personality;
  pointer: PointerState;
  /**
   * The current window mode (Phase 15.2). It selects the input *path*: the
   * desktop overlay treats the cursor as a presence and keeps its global
   * polling and hit-testing; the garden (and the web build) uses ordinary DOM
   * input with a live aim target. Same companion, same calls — never a
   * second interaction architecture.
   */
  mode: AppMode;
  /**
   * The mini-game runtime (Phase 16). Interaction checks exactly one thing on
   * it — `ownsPointer()` — and only in garden mode: while a game owns input,
   * clicks and pointer moves are routed to it and the ordinary summon / flower
   * / live-target path below is not consulted. While no game owns input, every
   * path behaves exactly as before (the runtime is invisible).
   */
  minigame?: MiniGameRuntime;
  /**
   * Reports the garden-entry gesture: a double-click that reached the canvas
   * while in desktop mode. It can only arrive when the hit-test zone has made
   * the overlay interactive — i.e. when the cursor is near the butterfly — so
   * no extra proximity test is needed here.
   */
  onEnterGarden?: () => void;
  /**
   * Reports a click that picked an interactive garden object (Phase 15.4) —
   * a fact for the object layer (subtle visual feedback), delivered after
   * the companion's own response has already been requested through the
   * ordinary public surface.
   */
  onGardenObject?: (id: string) => void;
  /**
   * Reports one *answered* summon (a click the butterfly actually flew to),
   * for the companion's long-term memory (Phase 14). Interaction does not
   * know what memory is or where it lives — it reports a fact upward, exactly
   * as it does with personality events.
   */
  onSummon?: () => void;
}) {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);

  const ndc = useMemo(() => new Vector2(), []);
  /** Last cursor position seen by the desktop poller, for movement detection. */
  const lastCursor = useRef<{ x: number; y: number } | null>(null);
  /**
   * The garden's interactive objects, derived once from the config. The same
   * list the renderer uses — one source of truth for "where the blossoms
   * are", deterministic on every launch.
   */
  const gardenObjectList = useMemo(() => gardenObjects(SCENE.garden), []);
  /**
   * Garden flower ownership (15.4 fix 2): a picked flower owns the click
   * from the moment of the pick — whether or not `seekTo` agreed to fly —
   * so the live cursor target cannot reclaim it on the next pointermove
   * (`trackLiveTarget` would otherwise overwrite the flower's target with
   * the cursor position on the very next frame). Ownership ends
   * deterministically via `flowerOwnershipEnds`: after a real flight, on the
   * controller's completion signal plus the post-arrival stay; or on a bounded
   * hold when no flight started because the butterfly was already at the
   * flower.
   */
  const flowerFlight = useRef(false);
  /** Whether the owning click actually started a flight. */
  const flowerHadFlight = useRef(false);
  /** Refusal-case deadline: release stays bounded even with no signal. */
  const flowerHoldUntil = useRef(0);
  /**
   * Post-arrival stay deadline, armed only once the controller's completion
   * signal is observed (0 = the stay has not started). Deliberately separate
   * from the refusal hold: this is the successful flight's own clock, and it
   * cannot begin before the butterfly has actually arrived.
   */
  const flowerStayUntil = useRef(0);

  /**
   * Reports a cursor observation to the personality.
   *
   * `point` is the already-mapped world point — the very same point the flight
   * controller receives as presence — so this is a distance measurement, not
   * a second coordinate conversion. `dt` is how long this observation covers,
   * measured by the source that produced it.
   *
   * Two different things are reported, deliberately:
   *
   * - **proximity** is fed only while the cursor is *moving* (`moved`). A
   *   cursor parked near the butterfly reports nothing further, so attention
   *   keeps decaying instead of saturating on a still mouse.
   * - **crowding** is a position, not an act, so it is reported on every
   *   observation where it holds — which is what makes shyness possible when
   *   someone rests the cursor on the butterfly.
   *
   * The radii come from the personality's current profile, so the geometry
   * reported here is always the geometry the controller is using.
   */
  const reportPresence = (point: Vector3, dt: number, moved: boolean) => {
    const profile = personality.currentProfile;
    const distance = point.distanceTo(flight.position);
    if (moved) {
      const closeness = Math.max(
        0,
        Math.min(1, 1 - distance / profile.noticeRadius),
      );
      personality.onCursorProximity(closeness, dt);
    }
    if (distance < profile.crowdRadius) personality.onCrowding(dt);
  };

  // --- Shared mapping: current NDC -> world target inside the live area ---
  // (the flight area may be re-solved for the work-area aspect at runtime,
  // so it is read from the controller, never from the config).
  useEffect(() => {
    const element = gl.domElement;
    const interaction = SCENE.interaction;

    const mapNdc = () => {
      // The ray is built from the camera's world matrix, which the renderer
      // updates per frame; refresh it so a target between frames is exact.
      camera.updateMatrixWorld();
      return screenToWorldTarget(ndc, camera, flight.area, interaction);
    };

    /** Client point (WebView CSS px) -> stable world target. */
    const toWorld = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      return mapNdc();
    };

    // Personality reporting is per-source: `dt` is the time since this source
    // last observed a *change*, so a long pause cannot be fed as one huge
    // sample when the cursor finally moves again.
    let lastMoveAt = performance.now();

    // Desktop overlay mode: the cursor is a *presence* the butterfly
    // notices, not a target it chases (a click still summons). Garden mode
    // and the web build: the live target.
    const cursorIsPresence = isDesktop && mode === "desktop";

    const onPointerMove = (event: PointerEvent) => {
      const point = toWorld(event.clientX, event.clientY);
      if (!point) return;
      pointer.x = ndc.x;
      pointer.y = ndc.y;
      pointer.active = true;
      // Mini-game ownership (Phase 16): while a game owns garden input, the
      // move is offered to it first. Only if the game does not consume it does
      // the ordinary path below continue — so a game that does nothing with
      // the pointer never changes how the garden feels.
      if (mode === "garden" && minigame?.ownsPointer() && minigame.handlePointerMove(point)) {
        const now = performance.now();
        const dt = Math.min(0.5, Math.max(0, (now - lastMoveAt) / 1000));
        lastMoveAt = now;
        reportPresence(point, dt, true);
        return;
      }
      // Flower ownership ends deterministically: after a real flight, on the
      // controller's completion signal (its explicit target cleared) plus the
      // post-arrival stay; when the pick was correctly refused — no flight to
      // wait for — on a bounded hold instead. Either way the cursor takes over
      // again on this very event, so normal behaviour resumes immediately.
      const now = performance.now();
      // The stay is armed by the arrival itself, never by the click: the first
      // move that observes the completion signal starts the clock.
      if (
        mode === "garden" &&
        flowerFlight.current &&
        flowerHadFlight.current &&
        flight.userTarget === null &&
        flowerStayUntil.current === 0
      ) {
        flowerStayUntil.current = now + FLOWER_STAY_MS;
      }
      if (
        mode === "garden" &&
        flowerFlight.current &&
        flowerOwnershipEnds(
          flowerHadFlight.current,
          flight.userTarget !== null,
          now >= flowerHoldUntil.current,
          now >= flowerStayUntil.current,
        )
      ) {
        flowerFlight.current = false;
      }
      const holdForFlower = mode === "garden" && flowerFlight.current;
      if (cursorIsPresence) flight.notice(point);
      else if (!holdForFlower) flight.aimAt(point);

      // Report to the personality (reaction intensity only — never movement).
      const dt = Math.min(0.5, Math.max(0, (now - lastMoveAt) / 1000));
      lastMoveAt = now;
      reportPresence(point, dt, true);
    };

    const onPointerLeave = () => {
      pointer.active = false;
      // On the desktop overlay the global cursor is the authority — a DOM
      // leave only means the hit-test flipped off, not that the mouse is
      // gone.
      if (cursorIsPresence) flight.notice(null);
      else flight.aimAt(null);
    };

    // Double-click near the butterfly enters the garden. The hit-test zone
    // only lets DOM events through while the cursor is in the butterfly's
    // interaction zone, so "reached the canvas in desktop mode" already means
    // "near the butterfly".
    const onDoubleClick = () => {
      if (isDesktop && mode === "desktop") onEnterGarden?.();
    };

    const onClick = (event: MouseEvent) => {
      const point = toWorld(event.clientX, event.clientY);
      if (!point) return;

      // Mini-game ownership (Phase 16): while a game owns garden input, the
      // click belongs to it. The ordinary paths below — flower picking, summon,
      // live target — are not consulted, so a click can never fire a flower
      // flight *and* a game action at the same time. The click is still
      // reported to the personality as attention (the companion is still the
      // companion), but memory's summon counter is not: a game click is not an
      // answered summon.
      if (mode === "garden" && minigame?.ownsPointer()) {
        personality.onClick(point.distanceTo(flight.position) < NEAR_CLICK_DISTANCE);
        // The game gets the *actual click ray* as well as the resolved target
        // point: hit-testing against world objects has to measure the ray's
        // closest approach (how the flower picking works), because the resolved
        // point's altitude and depth are remapped for flight targeting and do
        // not correspond to the thing that was clicked.
        camera.updateMatrixWorld();
        const through = new Vector3(ndc.x, ndc.y, 0.5).unproject(camera);
        const direction = through.sub(camera.position).normalize();
        minigame.handleClick(point, {
          origin: [camera.position.x, camera.position.y, camera.position.z],
          direction: [direction.x, direction.y, direction.z],
        });
        return;
      }

      // Garden mode: a click ray that passes near an interactive object is
      // about the OBJECT, not the raw ground point. The response rides the
      // existing public surface — `seekTo` to the investigation point above
      // the blossom, plus the same personality and memory reporting any click
      // gets — so the butterfly investigates and then simply resumes being
      // autonomous. Nothing here reaches into the controller.
      if (mode === "garden") {
        camera.updateMatrixWorld();
        const through = new Vector3(ndc.x, ndc.y, 0.5).unproject(camera);
        const origin = camera.position;
        const direction = through.sub(origin).normalize();
        const picked = pickGardenObject(
          {
            origin: [origin.x, origin.y, origin.z],
            direction: [direction.x, direction.y, direction.z],
          },
          gardenObjectList,
          SCENE.garden.interact.radius,
        );
        if (picked) {
          const [tx, ty, tz] = investigationPoint(
            picked.object,
            SCENE.garden.interact.hoverOffset,
            flight.area,
          );
          const target = new Vector3(tx, ty, tz);
          // The flower must win this click: while the cursor stays armed as
          // a live target, `trackLiveTarget` would overwrite the flower's
          // override target on the very next frame. It is disarmed *before*
          // the explicit target is set, and `onPointerMove` holds the cursor
          // off until the flower's ownership ends (see the latch above).
          flight.aimAt(null);
          const summoned = flight.seekTo(target);
          // Ownership is taken on EVERY pick — `seekTo` may correctly refuse
          // (the butterfly is already within arriveRadius of the flower),
          // and a refused click must not hand the next pointermove straight
          // back to the cursor. The stay clock is disarmed here; it is armed
          // by arrival, not by the click.
          flowerFlight.current = true;
          flowerHadFlight.current = summoned;
          flowerStayUntil.current = 0;
          flowerHoldUntil.current = performance.now() + FLOWER_HOLD_MS;
          personality.onClick(target.distanceTo(flight.position) < NEAR_CLICK_DISTANCE);
          if (summoned) onSummon?.();
          onGardenObject?.(picked.object.id);
          return;
        }
      }

      // A new explicit click supersedes any flower flight in progress — including
      // a flower that is still being stayed with — and clears its stay clock.
      flowerFlight.current = false;
      flowerStayUntil.current = 0;
      // A click that resolves to where the butterfly already is is ignored,
      // so summoning it never triggers a pointless take-off.
      const summoned = flight.seekTo(point);
      // Reported after seekTo, and independently of it: the click is a fact
      // about attention, not a movement instruction. A near click (right by
      // the butterfly) is direct interaction and weighs much more than a far
      // click, which is mostly a movement request. A single click of either
      // kind cannot change the state — only repeated interaction can.
      personality.onClick(point.distanceTo(flight.position) < NEAR_CLICK_DISTANCE);
      // Memory counts only *answered* summons: a click the butterfly actually
      // flew to. Clicking the spot it occupies is not interaction history.
      if (summoned) onSummon?.();
    };

    element.addEventListener("pointermove", onPointerMove, { passive: true });
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("click", onClick);
    element.addEventListener("dblclick", onDoubleClick);

    return () => {
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("click", onClick);
      element.removeEventListener("dblclick", onDoubleClick);
    };
  }, [gl, camera, flight, personality, pointer, ndc, mode, minigame, onEnterGarden, onGardenObject, onSummon, gardenObjectList]);

  // --- Desktop: global cursor tracking + selective click-through ----------
  // Overlay-only systems: both polling and hit-testing stop in garden mode
  // (the garden window receives ordinary DOM input instead) and resume when
  // the overlay is restored.
  useEffect(() => {
    if (!isDesktop || !desktopSystemsActive(mode).cursorPolling) return;
    let cancelled = false;
    let stop: () => void = () => {};
    let stopGeometry: (() => void) | null = null;

    void loadDesktopGeometry().then((geometry) => {
      if (cancelled) return;
      // The authoritative geometry is re-read by the desktop refresh
      // coordinator when the display changes; this long-lived value follows it,
      // so cursor mapping and the hit-test zone never keep using a stale
      // work-area origin or scale factor. One subscription, event-driven — no
      // extra polling here.
      let current: DesktopGeometry =
        geometry ?? fallbackGeometry(window.innerWidth, window.innerHeight);
      // Assigned inside the geometry promise so the effect cleanup can remove the
      // subscription whether or not the geometry resolved before unmount.
      stopGeometry = onDesktopGeometryChange((next) => {
        current = next ?? fallbackGeometry(window.innerWidth, window.innerHeight);
      });
      const zone = new HitZone();
      let lastIgnore: boolean | null = null;
      const butterflyNdc = new Vector3();
      let lastTickAt = performance.now();

      stop = startCursorPolling((cursor) => {
        // Physical desktop px -> logical desktop px (DPI conversion).
        const scale = current.scaleFactor || 1;
        const dx = cursor.x / scale;
        const dy = cursor.y / scale;

        // Desktop px -> NDC -> the shared targeting pipeline. The global
        // cursor is a *presence* the butterfly notices (attention, shyness) —
        // never a target it chases. Explicit interaction stays with the
        // click/hit-test path.
        desktopToNdc(current, dx, dy, ndc);
        camera.updateMatrixWorld();
        const point = screenToWorldTarget(ndc, camera, flight.area, SCENE.interaction);
        flight.notice(point);
        pointer.x = ndc.x;
        pointer.y = ndc.y;
        pointer.active = true;

        // Personality: proximity only while the cursor actually moves (a
        // parked mouse must not keep attention saturated); crowding on every
        // tick where the cursor is on top of the butterfly, so resting it
        // there is enough to build shyness. The poll interval doubles as dt.
        const now = performance.now();
        const dt = Math.min(0.5, Math.max(0, (now - lastTickAt) / 1000));
        lastTickAt = now;
        const previous = lastCursor.current;
        const moved =
          !previous || Math.abs(previous.x - dx) > 1e-3 || Math.abs(previous.y - dy) > 1e-3;
        lastCursor.current = { x: dx, y: dy };
        reportPresence(point, dt, moved);

        // Hit-test zone: interactive only while the cursor is near the
        // butterfly; click-through everywhere else. The toggle fires once
        // per transition, never per frame.
        butterflyNdc.copy(flight.position).project(camera);
        const bx = ((butterflyNdc.x + 1) / 2) * current.width + current.originX;
        const by = ((1 - butterflyNdc.y) / 2) * current.height + current.originY;
        const interactive = zone.update(Math.hypot(dx - bx, dy - by));
        const ignore = !interactive;
        if (ignore !== lastIgnore) {
          lastIgnore = ignore;
          void setIgnoreCursorEvents(ignore);
        }
      }, CURSOR_POLL_INTERVAL_MS);
    });

    return () => {
      cancelled = true;
      stopGeometry?.();
      stop();
    };
  }, [camera, flight, personality, pointer, ndc, mode]);

  return null;
}
