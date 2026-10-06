# Butterfly — interactive 3D butterfly experience

A calm, lightweight experience built around a single living 3D butterfly —
in the browser, and as a **Desktop Mate-style companion** that lives on your
actual Windows desktop. It flies across the whole screen after your cursor,
hovers, and comes when you call it — on curved, airborne paths rather than
straight slides.

Built with **React + TypeScript + Three.js (React Three Fiber)**.

## Getting started

```bash
npm install
npm run dev      # development server on http://localhost:5173
npm run build    # type-check + production build
npm run preview  # serve the production build
```

## Desktop runtime (Tauri 2)

The same frontend runs as a native Windows desktop companion: a transparent,
click-through overlay covering the primary monitor's work area, with the
butterfly living in real desktop coordinates rather than inside a small app
window.

**Prerequisites** (Windows):

- [Rust](https://rustup.rs/) — `rustup` toolchain
- [Microsoft C++ Build Tools](https://aka.ms/vs/17/release/vs_BuildTools.exe)
  with the **MSVC** and **Windows SDK** components
- WebView2 runtime (already present on current Windows 10/11)

**Commands:**

```bash
npm run tauri dev      # run the desktop app against the Vite dev server
npm run tauri build    # bundle a distributable Windows app
```

Development URLs and build commands are configured in
`src-tauri/tauri.conf.json`, not hardcoded in scripts, so the host and the
frontend stay in sync.

### The desktop overlay

The native window is the desktop's rendering surface, not an app window:

| Setting | Value | Purpose |
| --- | --- | --- |
| `transparent` | `true` | the desktop shows through everywhere the scene doesn't paint |
| `decorations` | `false` | no title bar or browser-like chrome |
| `shadow` | `false` | no hard shadow around the overlay |
| `alwaysOnTop` | `true` | the butterfly floats above other applications |
| `resizable` | `false` | size comes from the work area, not the user |
| `visible` | `false` | hidden until the native layer has sized it |
| `width` / `height` | `420` / `320` | creation placeholder only — replaced at startup |

At startup (`src-tauri/src/lib.rs`) the window is resized to the primary
monitor's **work area** (origin + size, taskbar excluded), repositioned to
the work-area origin, set to **ignore cursor events**, and only then shown —
so there is no visible placeholder flash and the overlay never blocks input
by default. Multi-monitor support is a later phase.

### Desktop coordinates

`src/lib/desktop/geometry.ts` is the single source of truth for desktop
geometry: work-area origin and size (logical pixels), the monitor scale
factor, and the conversions

```
desktop px → (÷ scaleFactor) → logical desktop px → (− work-area origin)
  → overlay client px → (÷ overlay size) → NDC → screenToWorldTarget
```

which the desktop input path uses end to end. No monitor math lives anywhere
else, and no window-size constant appears in flight logic.

### Desktop environment facts (awareness)

`src/lib/desktop/environment.ts` is the second, deliberately separate view of
the desktop: where the butterfly *is*, as opposed to how the overlay maps
pixels. One immutable snapshot — monitor bounds, work-area bounds, scale
factor, and the derived difference between them — obtained from permissions
`core:default` already grants (`primaryMonitor()` needs no new capability and
no new Rust code):

```
monitor bounds  ─┐
work-area bounds├─► DesktopEnvironment ─► awareness.ts (pure) ─► (behaviour, later)
scale factor    ─┘
```

- All rectangles are **logical desktop pixels** (multiply by `scaleFactor` for
  physical); `scaleFactor` is physical pixels per logical pixel.
- The difference is reported as four neutral **work-area insets** (`left`,
  `right`, `top`, `bottom`), derived independently per edge — never as a
  taskbar size, because the native layer cannot yet tell a taskbar from any
  other reservation, and cannot detect an auto-hiding one at all. All four may
  legitimately be zero.
- Non-zero and negative origins are handled by construction (a left-docked bar
  shifts the work-area origin; a secondary monitor sits at negative desktop
  coordinates).
- `loadDesktopEnvironment()` caches; `refreshDesktopEnvironment()` re-reads on
  demand. **Nothing calls it yet** and nothing polls — the refresh *wiring*
  (resize / DPI events) is a separate step. Outside Tauri, including the dev
  harness, it resolves to a deterministic viewport snapshot.
- `desktop/geometry.ts` is untouched and remains authoritative for cursor
  mapping, hit-testing and targeting. The two coexist on purpose: geometry is
  the *overlay-mapping* view (work area only), the environment is the
  *desktop-facts* view.

`src/lib/awareness.ts` turns a snapshot into facts and nothing else — no
Tauri, no React, no polling, no knowledge of the flight controller or the
personality, and no movement commands (`tools/check-desktop.mjs` enforces all
of that). It keeps three boundaries apart, because they are **not** the same
thing:

```
monitor edge   the physical screen
work-area edge the usable desktop — what the overlay covers
reachable edge the volume the butterfly can currently occupy
```

At a 1920×1040 work area the reachable volume sits ~330 px inside the left
edge, ~195 px inside the right and ~160 px below the top, so it can never
physically reach a screen edge. Awareness reports both sets of numbers
separately: screen-space edge and corner distances in logical pixels, and
`worldEdgeMap()`, which inverts the same projection `airspace.ts` uses
(perspective is linear per axis at a fixed depth, so a bisection solves it) to
give the world-space position of each work-area edge plus `reachableInsets` —
how far the reachable volume stays inside them.

The cursor rule that matters: `screenToWorldTarget()` clamps the cursor into
the flight area per axis, so a cursor far outside the desktop arrives as a
point on the reachable boundary. `cursorInsideWorkArea()` therefore takes
**unclamped logical desktop coordinates** and must be consulted before that
conversion, never after.

What awareness does **not** know, by design: what is painted underneath the
transparent overlay, which windows are open or in front, whether a bar is a
taskbar, and anything about monitors other than the one it is placed on.

#### Keeping the facts fresh (Phase 13A.3)

The display can change under a running companion — resolution, work area, DPI,
or a different monitor — so the snapshot is no longer read once and kept
forever. `src/lib/desktop/refresh.ts` keeps the *facts* current and nothing
else:

```
tauri://resize · tauri://scale-change · tauri://move
        ↓  (a hint only — never trusted as data)
   coalesce: one refresh per frame boundary
        ↓
   re-read the authoritative values (monitor, work area, scale)
        ↓
   compare with the snapshot in use → report what changed
```

- **Triggers.** The three window events the installed Tauri 2.12.1 API already
  exposes (`onResized`, `onScaleChanged`, `onMoved`). They need no new
  capability — they go through `listen`, and `core:default` (already granted)
  includes `core:event:default`. **No dependency, no Rust and no capability
  change.**
- **Coalesced.** Display changes arrive in clusters; a burst collapses into
  exactly one refresh at the next animation frame, so the outcome does not
  depend on how noisy the event source is.
- **Cheap and idempotent.** If the facts are unchanged, the geometry cache is
  not even re-read, `flight.setArea()` is not called, and nothing downstream is
  disturbed. A redundant event costs one native call. The flight area is
  re-solved only when the work area's *aspect* actually differs (within a
  tolerance), so a pure size change at a fixed ratio changes no geometry.
- **Failure tolerant.** A failed native read keeps the previous valid snapshot
  (`source: "retained"`) rather than substituting the viewport fallback or
  zeros — a transient failure can never make the companion believe it is
  somewhere it is not.
- **A fact update, not a behaviour event.** The coordinator imports neither the
  flight controller, the personality nor React, issues no movement command, and
  touches no animation. It reports `changed` / `aspectChanged` / `failed`; the
  scene shell decides what that means, and the only thing it does is re-solve
  the flight area through the existing `flightAreaForAspect()` +
  `setArea()` path. No destination is regenerated, no personality reset, no
  `seekTo()`/`aimAt()`.
- **Coordinate authority unchanged.** `desktop/geometry.ts` remains the single
  source for desktop → logical → client → NDC conversion and for the hit-test
  zone. The environment is a facts layer, never a competing coordinate system.
  To keep the cursor mapping correct after a change, `geometry.ts` gained
  `refreshDesktopGeometry()` plus a tiny change-notification channel
  (`onDesktopGeometryChange`), which the desktop input path subscribes to once —
  event-driven, not a second poller.
- **Still unsupported.** A resolution change that alters neither DPI nor the
  window geometry produces no event in the current stack, and the native layer
  still sizes the overlay only at startup — so the *overlay itself* would not
  follow such a change. That is a native-layer follow-up, deliberately not
  solved here with a poller. Multi-monitor placement remains primary-monitor
  only, though nothing in the refresh path makes it harder to extend later.

### The edge preference (Phase 13A.2) and the foreground preference (Phase 13B.2)

Awareness facts reach the butterfly as exactly one number each on the profile,
and both act in the same place — `pickDestination()` — and nowhere else.

**`edgeAversion`** — how much it prefers not to *choose* the extreme of its
reachable volume when picking its next autonomous hop:

- A candidate that overshoots the reachable volume is drawn back inward by
  `0.5 × edgeAversion` of the overshoot, capped at one volume span. Candidates
  that land inside are untouched, the leg bands and cadence are unchanged, and
  no extra randomness is drawn.
- Measured effect (8 seeds × 10 min, share of autonomous destinations landing
  within 5% of the reachable boundary): **55%** with no aversion → **45%** calm
  → **36%** shy, while 30% still land near the edge at the strongest setting.

**`foregroundAffinity`** — how much it prefers to be wandering over the window
its owner is currently working in:

- The desktop-space window rectangle is converted **once**, in the scene shell,
  into a plain world-space box (`worldBoundsForDesktopRect()`, using the same
  projection `airspace.ts` uses — a round-trip is exact to 0.1 px in tests). The
  flight controller only ever sees four numbers; it has no idea what a window,
  a monitor or a pixel is.
- While choosing an autonomous destination, a candidate that landed outside the
  box is eased toward it by `0.45 × foregroundAffinity` of the distance — and
  only on the axes that are actually outside, so the pull vanishes as the
  candidate approaches. A candidate already inside is untouched.
- Measured effect (5 seeds × 10 min, share of destinations inside the box):
  **47%** with no window or no preference → **55%** with affinity 0.6, still
  leaving **44%** of destinations outside. It is a preference, never a wall.
- With no foreground window — closed, focus moved away, browser, or the dev
  harness — the pull is not merely small, it is *skipped entirely*, and the
  simulation is byte-identical to the reference profile (asserted by walking two
  controllers and comparing every position).

Both preferences default to `0`, so the reference profile is exactly the
Phase 12.3 flight (`transitions=36 travelled=38.7 maxSpeed=0.91 avgSpeed=0.32`,
re-verified in every suite). Explicit targets are structurally outside both:
`seekTo()` and `aimAt()` set `overrideTarget` and never go through
`pickDestination()`; the shy hop, crowding, presence and the flight-area clamp
are untouched. Click the extreme edge, or a spot outside the window, and the
butterfly goes there.

The two orderings deliberately run in **opposite** directions — a shy butterfly
avoids edges most (`edgeAversion` 0.6) and engages least with what is in front
of it (`foregroundAffinity` 0.1), while a curious one does the reverse — so they
can never conspire to trap it in one corner of its world.

### Foreground-window fact (Phase 13B.1 — fact only)

The environment layer can now answer one new question about the desktop:
**which external application window currently has focus, and where is it.**

`src/lib/desktop/windows.ts` is a fact source and nothing else. It does not
move the butterfly, touch personality, flight, animation or interaction, and it
has no consumer yet:

- **One native command.** `foreground_window()` (in `src-tauri/src/lib.rs`) calls
  `GetForegroundWindow()`, compares the handle against our own
  `WebviewWindow::hwnd()`, and only then calls `GetWindowRect()`. Our own
  always-on-top overlay is therefore excluded by **native window identity** —
  never by title text or executable name — so the companion never mistakes
  itself for an application.
- **One window, no enumeration.** There is no `EnumWindows`, no list of open
  applications, no titles, no classes, no z-order, no taskbar query, no
  per-window DPI and no occlusion test. A window rectangle is *geometry*: the
  overlay is transparent, so nothing here can say what is actually painted
  underneath it.
- **Coordinates.** Win32 reports **physical** desktop pixels in virtual-desktop
  space (so `x`/`y` may be negative on a multi-monitor desktop). The command
  returns a plain `(x, y, width, height)` — the HWND never crosses into
  JavaScript — and `windows.ts` converts it once to the project's logical
  desktop pixels using the scale factor from the environment snapshot, the same
  physical→logical division `desktop/geometry.ts` performs for the cursor. That
  conversion exists in exactly one place, enforced by a static check.
- **Failure retention.** A failed native read keeps the last valid fact
  (`source: "retained"`) instead of reporting "no window"; only a first failure
  with nothing valid to keep reports `unavailable`. An empty or non-finite
  rectangle is never treated as a fact.
- **Dependencies.** `windows` **0.62** as a direct Windows-only dependency with
  exactly two features (`Win32_Foundation`, `Win32_UI_WindowsAndMessaging`) —
  the same major version Tauri 2.12.1 already uses internally, so Cargo unifies
  them into one copy. No other crate was added and no capability was needed.
- **Not yet, deliberately.** No polling or refresh of this fact (that is
  13B.3), no interpretation of it (13B.2 adds the pure awareness helpers), and
  no behaviour of any kind attached to it. A single one-shot read happens at
  startup purely to prove the end-to-end path.

#### Phase 13B — what the companion knows about the desktop (complete)

Phase 13B ended with a deliberate boundary. The capability it adds is exactly
this:

> The butterfly has a native foreground-window fact and a weak
> autonomous-flight preference associated with that fact.

`src/lib/awareness.ts` gained pure helpers — `isPointInsideForegroundWindow()`,
`distanceToForegroundWindow()` (0 inside, Euclidean to the nearest point
outside), `distanceToRect()`, `rectBounds()` — and one bridge,
`worldBoundsForDesktopRect()`, which maps a logical-desktop rectangle into a
world box through the existing camera projection. No DPI conversion, no Tauri, no
Windows API and no behaviour live in that module.

Refreshing reuses the existing coalescer: Tauri's `onFocusChanged` announces
"the window in front may have changed", the burst collapses into one refresh at
the next frame, and the fact is re-read from the OS. There is no interval, no
second coordinator and no 30 Hz window polling. The trigger is a hint, not
proof — which is why the reliable signal (`SetWinEventHook` /
`EVENT_SYSTEM_FOREGROUND`) was deliberately left out of this phase; any gap
closes on the next refresh, and a withdrawn window restores neutral behaviour
immediately.

**Limitations, stated plainly:**

- Only the *current* foreground window is known. This is **not** window
  enumeration: the app cannot list what is open.
- **Visual occlusion is not known.** The overlay is transparent; a window
  rectangle is geometry, never proof that anything is visible there.
- **Z-order is not modelled.** The app knows which window has focus, not what is
  painted, nor what sits above or below it.
- **Per-window DPI is not modelled** — the existing monitor scale factor is used.
- **Multi-monitor is not implemented**: the overlay stays on the primary monitor,
  and a window on another monitor is simply outside the work area.
- **Foreground awareness is a preference, not a surface.** There is no landing,
  no perching, no `LandingSurface`, and the GLB's `Idle` clip remains reserved.

### Two window modes: desktop companion ↔ garden (Phase 15.2)

The app has two window *profiles* over one window, one scene and one
companion (`src/lib/appMode.ts` is the vocabulary):

- **Desktop mode** (default, launch state): the transparent work-area overlay
  described above — always-on-top, click-through, global cursor presence.
- **Garden mode**: a temporary windowed visit — a borderless, centered,
  normally-interactive window (size from `SCENE.garden.windowSize`) showing
  the same companion in the opaque presentation the web build uses — plus the
  garden world itself (Phase 15.3): a soft patch with grass, flowers, stones
  and a log, built entirely from Three.js primitives, with every position,
  scale, count and colour tuned in `SCENE.garden` and the grass scattered
  deterministically from its seed (`src/lib/garden.ts` — same seed, same
  garden, on every launch).

  The flowers are quietly interactive (Phase 15.4): clicking one asks the
  butterfly to investigate it. The pick happens inside the single existing
  click path — a deterministic ray test against the config's blossoms
  (`pickGardenObject` in `src/lib/garden.ts`) — and the response rides the
  ordinary public surface: a `seekTo` to the flower's investigation point,
  the usual personality click report, and a memory summon, exactly as any
  click would produce. The butterfly flies over, hovers, and then simply
  goes back to its own rhythm; the flower answers with a small swell
  (`feedbackPulse`, prop-driven — no popups, no rewards, no UI). The same
  mechanism fits future objects (stones, leaves, a drifting light) with no
  new interaction code.

  Two details make the flower actually win (15.4 fixes 1 and 2). First,
  the investigation point is the flower's own position *pulled into the
  reachable flight area* (plus the hover offset): resolving the pull here
  hands `seekTo` a target it can reach exactly, as close to the blossom as
  the airspace allows. Second, the garden's cursor is a *live
  target* that re-aims an explicit flight every frame while armed, so a
  flower click disarms it *before* seeking and takes ownership of the
  click unconditionally — whether or not `seekTo` agreed to start a
  flight. Ownership ends deterministically (`flowerOwnershipEnds`), and the
  two cases are deliberately different clocks: a real flight is released by
  the controller's completion signal (the explicit target cleared on
  arrival) plus a **post-arrival stay** of three seconds
  (`interact.stayMs`) — the butterfly actually lingers with the flower it
  flew to, and the cursor cannot reclaim it while it does. The stay is
  armed by arrival, never by the click. A *refused* click (the butterfly
  already within `arriveRadius`, so no flight and no completion signal)
  keeps the original short bounded hold instead (`FLOWER_HOLD_MS`): long
  enough that the click plainly lands on the flower, short enough that the
  cursor resumes normally the moment there is nothing to investigate.
  Either way normal cursor behaviour resumes on the very next move, and an
  ordinary ground click supersedes a flower at any point in the stay. Ground clicks keep the ordinary web-style behaviour: a
  moving cursor still redirects their flight.

  A runtime trace of a whole flower click (15.4 fix 3) proved the latch
  itself was never the problem: the explicit target survived every frame
  to arrival. The real cause sat one layer below, in the garden's *flight
  volume* — which brings us to fix 4.

  The garden has its own flight volume (15.4 fix 4). The desktop's depth
  band is a fixed-camera trade: shallow depth keeps perspective scale
  nearly constant so one box both stays in frame and reaches most of the
  work-area surface. The garden runs the *follow* rig over content that
  spans z = −2.6 … +1.5, so inheriting a 1.0-unit slab capped the
  butterfly and saturated pointer targeting against its two walls — the
  garden's depth felt weak and flower flights were pulled to the nearest
  wall, short of every blossom. Garden mode therefore solves its own
  volume from its own content: `gardenFlightArea()` keeps the shared
  X/altitude solve (identical numbers to before) and takes depth from the
  configured flowers, stones and log plus the config's `depthMargin`
  (0.5) — z = −3.9 … +2.6, 6.5× the desktop span. It is pure, config-driven
  and applied through the existing `setArea` path, so the controller stays
  platform agnostic and desktop keeps its slab, framing and work-area
  behaviour untouched. With the blossom depth inside the volume,
  `investigationPoint()` resolves naturally: no depth pull at all, and a
  refusal now means "already at the flower".

### The visual foundation (Phase 15.5A)

  The garden worked, but it *looked* like primitives on a flat plane: a
  hard-edged coloured disc on a larger flat plane, nothing taller than
  0.46 units against a 0.6–2.75 flight band, no shadows anywhere, and a
  fog tuned for a desktop-sized world. 15.5A replaces the foundation
  only — deliberately no planting yet, which arrives in 15.5B–D.

  **The clearing** (`clearingMesh` in `src/lib/garden.ts`, drawn by
  `GardenWorld.tsx`). The flat disc is gone. In its place: a low-poly
  surface with gentle relief, a **soft raised bank** that rises, peaks
  and settles back to the plane by the rim — so there is no cliff edge —
  and an **irregular boundary**, because a perfect circle is exactly what
  reads as a decal. All of it is solved deterministically from the garden
  seed (9 rings × 36 segments, 325 vertices, 612 triangles) and hard-capped
  at **0.12 units**, an order of magnitude below the flight floor: the
  ground can change how the place *looks*, never where the butterfly can
  fly. Grass now stands on that surface (its base height comes from
  `groundHeight`, the same solve), so nothing floats and nothing is buried.

  **Value structure, baked rather than textured.** The clearing's vertex
  colours carry the composition: warm and light through the usable centre,
  cooler and darker toward the rim, earthier through the bank — which leads
  the eye inward instead of out to the edge. Under every placed object the
  ground darkens softly, so flowers, stones and the log sit *in* the ground
  rather than on it, at no extra draw call. No textures are involved.

  **The garden's own atmosphere.** The shared fog (near 6 / far 46) was
  sized for a world many times larger than a garden, which left the far
  distance reading as an empty plane; the garden brings its own (near 4 /
  far 16), matched to the sky horizon so the ground dissolves into it
  seamlessly. Desktop and web keep the shared values untouched — this is a
  mode choice made in `Experience.tsx`, not a change to the shared setup.

  **The garden's own light** (`GardenLight.tsx`, garden-only; the shared
  `Atmosphere` is unchanged for desktop and web). One warm low key at
  ~27° with a tight 4.2-unit shadow box and a single 1024² map — the
  shadow-casting budget for the whole garden — plus a cool fill from the
  opposite side so silhouettes separate from the sky. The stones and the log
  cast into it and the clearing receives. No post-processing of any kind.

  **The garden's own framing** (`SCENE.garden.camera`). The follow
  architecture is unchanged — same rig, damping, parallax and focus lean —
  but the garden gets its own numbers: slightly closer (distance 5.39 →
  4.72) and slightly flatter (pitch 11.8° → 11.0°), so vertical structure
  and the rim read instead of flattening into the ground. It has to be
  separate: `SCENE.camera.position` is also the desktop overlay's fixed
  shot, so tuning it for the garden would move the desktop. Its travel
  clamps are sized from the flight volume itself (including pointer
  parallax), so the framing now holds at the volume's edges instead of
  drifting where the butterfly investigates the near-wall flowers.

  Everything the foundation promised is asserted rather than assumed:
  determinism per seed, the relief ceiling, the distance below the flight
  floor, the bank profile, the irregular rim, contact darkening, planted
  grass, garden-only fog and light, one bounded shadow caster, and the
  desktop camera configuration untouched (`tools/test-garden.mjs`,
  `tools/test-camera.mjs`, `tools/check-desktop.mjs`).

  **Phase 15.5A.1 — the circular artifact.** Manually, the clearing showed a
  conspicuous circular pattern in its middle. It was not the flat disc it
  looked like, and it was not the mesh topology. The relief had been built as a
  sum of sines in the *angle* around the centre and faded in with a threshold
  ramp, which produced three measurable defects: **every** interior radius up
  to ~4.4 was *exactly* flat (34 of 38 sampled rings), the pattern was an
  angular extrusion so the ground's high point sat at one of only **two**
  bearings at *every* radius, and the bank's onset was a fixed radius. Flat
  disc + ring where texture switches on + radial spokes = a procedural circle.

  The fix is mathematical, not cosmetic: the relief is now **isotropic 2D value
  noise** (a lattice hash blended with smoothstep weights, two octaves), so it
  has no preferred direction; its envelope is a **power gradient** rather than a
  threshold ramp, so it is non-zero at every radius with no derivative jump;
  and the bank — the one thing meant to be a ring — has its **strength and crest
  radius modulated by that same field**, so it wanders instead of being traced.
  Two smaller corrections came out of the diagnosis: the relief is biased to its
  positive half (a signed field was clipped at the plane, and clipping leaves
  flat patches with a visible edge), and the clearing sits 4 mm proud of the
  shared plane (`lift`) so its rim is never coplanar with it.

  Measured after the fix: **0** exactly-flat interior rings, the high point now
  moves across 5 distinct bearings, crest spread 0.60 units, max height 0.090 of
  the 0.12 ceiling, ground still 0.6 below the flight floor. The invariants are
  now asserted rather than re-observed: no exactly-flat interior ring, relief
  growing monotonically outward, the high point not fixed to one bearing, the
  crest not a fixed radius, and a static gate forbidding amplitude-weighted
  sines in the angle from returning.

### Butterfly Chase (Phase 16.1)

**The hit/expiry fix.** The first version had two different world spaces
disguised as one, and it showed as "the butterfly is on the target but clicking
does nothing, then it counts as skipped":

1. **The hit test used the wrong coordinate space.** Clicks were tested as
   *point-vs-point*: the click, resolved through the flight-targeting pipeline
   (`screenToWorldTarget`), against the target's world position. But that
   resolved point is a targeting construct — its altitude is remapped from the
   vertical screen offset and its depth is clamped into the flight band — so
   clicking exactly on a target at altitude or depth routinely measured further
   away than the hit radius. The flowers never had this problem because
   `pickGardenObject` measures the *actual click ray's* closest approach to the
   blossom. The game now receives the same real camera ray from `Interaction`
   (`MiniGameDefinition.onClick(context, point, ray)`), and hit-tests exactly
   the same way. The seek target and the hit target are the identical world
   point.
2. **The hit is gated on the butterfly's actual arrival.** A target is
   `catchable` only when the butterfly is within `catchRadius` (0.56 =
   `arriveRadius` × 2, covering arrival plus the measured hover carry) of it —
   recomputed every tick from the flight controller's real position, so the
   visual, the butterfly and the hit state cannot disagree. A click while the
   butterfly is still chasing is not a catch; the marker's pulse turns quick,
   bright and tight when the gate opens.
3. **Accounting is exact.** A hit scores once, consumes the target (it can
   never score again, never be counted as skipped), and the next target comes
   from the same deterministic stream. An expiry skips once, removes the
   target, and can never score later. A target still alive when the clock ends
   is neither. Spawns anchor on the *previous target's* position rather than
   the butterfly's live position, so the stream is deterministic from the seed
   alone — flight noise never leaks into placement.

### The original design

The first mini-game, and deliberately the smallest one that can be fun — a
proof that the Phase 16 foundation can host something real without
contaminating anything.

**The game.** While it runs, one glowing target at a time appears in the
garden. The butterfly is sent after it; the player clicks the target before it
vanishes. Each hit is a point. After thirty seconds the game completes and
reports the score. No level, no streak, no reward, no persistent score — a
visit, not a session.

**Determinism.** The target stream is drawn from a seeded RNG keyed to the
garden's own seed (`seed ^ CHASE_SEED_OFFSET`), so the same garden always
offers the same sequence of targets. No `Math.random()`.

**Placement is measured, not guessed.** Each target spawns within
`spawnDistance` (1.8–3.0 units) of the butterfly's *current* position, still
inside the flight area, and never within `minLandmarkDistance` (0.9) of a
flower, stone or the log. The lifetime (5 s) is sized against the measured
arrival curve of the real flight controller (mean 2.5 s at 1.6 units, 4.2 s at
3.2 units), so nearly every target is genuinely reachable before it vanishes.
The first version spawned anywhere in the whole area and arrival was measured
impossible in most cases.

**What the game borrows, and gives back.** While playing: pointer clicks and
moves (the ordinary summon/flower/live-target path is not consulted), and the
autonomous wander rhythm (`setAutonomySuppressed`, the Phase 16 seam). The
butterfly moves only through `seekTo` — the same verb a person's click has. On
completion, cancel or reset, all of it returns through the foundation's single
teardown path, and the garden is exactly as it was.

**The UI is three facts.** A start affordance ("Butterfly chase"), a score and
countdown while playing, a one-line result. The HUD reads the definition's
public getters and re-renders on the game's own change notifications; the
target marker is two meshes, two draw calls, nothing allocated per frame.

Two defects were caught only by rendering the components through a temporary
probe (since removed): the marker was first scaled to near the butterfly's own
size and read as a beach ball dominating the clearing — it is now a small
glowing point where the ring, not the orb, carries readability; and the HUD
failed to show its live pill when the game was already active at mount time —
it now initialises from the runtime on mount.

### The mini-game foundation (Phase 16)

A mini-game is an *activity layered on top of the companion*, never a
replacement for it. Same butterfly, same flight controller, same personality,
same memory — a game borrows two things for a while and gives them back
cleanly. Phase 16 builds only the boundary; no game exists yet.

**The state machine** (`src/lib/minigame.ts`) is deliberately tiny:
`inactive → ready → playing`, with `paused`, `completed` and the two exit
paths. Invalid transitions are rejected, never coerced. `ready` exists so a
game's start hook runs while the runtime is visibly mid-transition — no
half-started game can be observed.

**The two seams a game borrows:**

1. **Input ownership.** `Interaction` checks exactly one flag —
   `minigame.ownsPointer()` — and only in garden mode. While it holds, clicks
   and moves route to the game's hooks; the ordinary summon / flower /
   live-target path is not consulted, so a click can never fire a flower
   flight *and* a game action. While no game owns input, every path behaves
   exactly as before — the runtime is invisible. Presence reporting to the
   personality continues (the companion is still the companion); memory's
   summon counter does not count game clicks (a game click is not an answered
   summon).
2. **Autonomy suppression.** `FlightController.setAutonomySuppressed(true)` —
   the phase's one new flight seam — suspends the wander rhythm and the shy
   hop, and nothing else: position, velocity, destinations, presence
   awareness, explicit targets and soft landings are untouched. It is a
   suspension, not a mode: on release the resting rhythm is re-armed from now
   rather than firing instantly. Measured in `tools/test-minigame.mjs`: while
   suppressed, **zero** new autonomous legs in 20 simulated seconds (same-seed
   unsuppressed controller: 7 transitions); the ordinary rhythm resumes
   afterwards.

**The narrow flight surface** (`miniGameFlightSurface`) is what a game actually
sees: `seekTo`, `aimAt`, and a read-only position — the two verbs a person's
click already has, no internals. A game cannot touch position, velocity,
destinations or flight state because it never sees the controller.

**Cleanup is one path.** Complete, cancel and reset all end in the same
`teardown`: the game's `onStop` runs with the reason, every registered
resource disposes exactly once in reverse order, suppression releases, the
runtime goes inactive with no stale clock or state. A game registers real
resources (timers, listeners) through `context.addResource()` — which is why
"no timers remain" is a guarantee and not a hope.

**Camera ownership decision: none, on purpose.** No second camera system was
introduced. The garden camera stays the base camera; if the first real game
needs a temporary move, the smallest seam will be added then, when the
requirement is concrete. The desktop camera is untouched.

**Memory decision: no persistence yet.** The future `mini_game_started` /
`completed` / `failed` events have an optional non-persistent seam nowhere —
deliberately: this phase adds no memory events at all. When a real game
exists, the events it earns will be worth recording, and the existing
`CompanionMemory` event model (`applyCompanionEvent`) already has the shape.

**What is NOT here:** no game engine, ECS, plugin registry, event bus, scene
graph, save system, HUD framework, game menu, or debug panel. A game is a
plain object with lifecycle hooks; the runtime is a plain state machine. The
test stub (`TestMiniGame` in `tools/test-minigame.mjs`) is a lifecycle harness,
not a game.

### The far boundary and the garden's own sky (Phase 15.5D)

The clearing, the planting and the landmarks were all correct by the end of
15.5B/C, and the garden still read as *a disc on an infinite plane* — because
that is what it was. Past the clearing there was nothing but a ground plane
fading to a shared sky.

**The sky** (`SCENE.garden.sky`) is now the garden's own: a cool green-grey
above, easing to a pale warm band at the horizon. `SkyDome` takes an optional
palette and defaults to the shared one, so desktop and web are untouched even by
accident. The horizon band is deliberately within a whisker of the fog colour,
because the ground fades *to the fog colour* by `fog.far` — if the sky at the
horizon is a different value, the two meet in a hard horizontal line, which is
the clearest tell there is.

**The far boundary** (`GardenBackdrop.tsx`) is two instanced silhouette families
standing beyond the clearing: low mounds for mass, thin spires for texture. Two
draw calls, 1,764 triangles — **7% of the scene** — and no shadow caster, because
at that distance and value a cast shadow would spend the single-caster budget to
make the darkest part of the frame darker.

#### What rendering it actually showed

The dome was wrong three times, and the failures are worth recording because each
looked fine as geometry:

1. **A dome rendered as pale polygonal hills.** A closed convex form has a
   silhouette that is a *curve*, and at 15+ units the eye reads that curve as
   terrain.
2. **Breaking the crown's heights turned it into slabs** with vertical sides and
   flat tops — pale grey boxes floating in the haze.
3. **A nine-blade fan still showed its own facets** wide enough on screen to read
   as folded paper.

The fix is that **a silhouette made of a few large facets reads as folded
paper**: twelve narrow blades, each its own triangle, so no single facet is large
enough to read as a plane. Two other things came out of looking at it:

- **A lit material is the wrong tool at this distance.** The garden's key is a
  warm 1.75, so every upward-facing facet caught it and rendered *brighter* than
  the hazy sky behind — a row of pale origami shapes. The backdrop is now unlit
  (`meshBasicMaterial`): its value is its own, and fog does the rest. That is
  exactly the atmospheric perspective it exists to provide.
- **It was far larger than intended.** The camera sits ~4.5 units from the origin
  and the band is at 15..21, but a mound 1.9 tall still subtends a large angle and
  came out as spikes the height of the clearing's own bank. Heights and widths
  roughly halved; undergrowth belongs *under* the horizon line.

Placement was measured rather than reasoned about, and the first guess was badly
wrong. The follow camera trails the butterfly by up to 4.6 in z and the butterfly
reaches z +2.6, so **the camera itself roams out to 7.83 units** — a rim placed
just past the clearing ends up *beside the camera*. Measured at `inner: 7.6`,
106,737 of 109,350 camera-pose/silhouette pairs sat at under half fog and the
nearest silhouette came within 0.95 units: crisp, and in your face. Sweeping the
band outward against the current fog put the least-fogged visible silhouette at
11% (inner 12.5), 23% (15) and 33% (17); it stands at 15, where it is always at
least 23 percentage points more atmospheric than the nearest flower or stone.

One test was measuring the wrong thing and had to be rewritten rather than
tuned: it compared the rim's *worst* view against the clearing's *most* fogged
edge, which are different moments and says nothing. It now compares them at the
same pose — and against the *content* (flowers and stones, within ~3.5 units),
not the clearing's far edge, which can legitimately be further away than the rim.

### The planting, the stones and the limb (Phase 15.5B/C)

The foundation fixed the ground. It did not fix the fact that everything
standing on it was a primitive at a fixed scale in a circle. Four problems,
each with a specific cause:

**No vertical structure.** The only planting was 240 five-sided cones on an
evenly-spread grid — the classic "grass" that reads as *Minecraft*. Now there
are four families, each one instanced draw, each a procedurally generated
silhouette (`gardenGeometry.ts`): **turf blades** (a tapered strip that arches
over, authored at unit size so width and height scale independently — a short
blade stays a believable width instead of shrinking to a hair), **leaf clumps**
(three leaves on a short stem), **seed heads** (a thin stem with a pale teardrop
head — the vertical layer) and **foliage mounds** (five leaves fanned low, the
darkest value in the palette).

**Uniform scatter.** Positions were `sqrt(uniform)` over the whole disc:
statistically correct and compositionally dead. Placement is now solved in
three ordered phases from one seeded stream — hand-placed clusters at each of
the seven landmarks, then the rim band, then the open ground by rejection
sampling against a radial **density gradient** (`densityAt`). Measured as area
density, the tiers now read: centre **0.33** blades/unit² (empty — this is the
butterfly's airspace), open midground **2.33**, rim **4.00**. The landmark mats
are a fourth, deliberate tier on top. "Grass count matches config" used to mean
an even sprinkle; it now means a composed clearing.

**The primitive landmarks.** Stones were flat-shaded `icosahedronGeometry`
detail-0 — the single most "untextured game asset" element in the garden. They
are now `pebbleGeometry`: an icosahedron pushed around by seeded per-vertex
noise, weighted towards the base so the silhouette is irregular where it meets
the ground, then **smooth-shaded** (`computeVertexNormals`) and seated at
`groundHeight + scale * 0.3` so most of each stone is below its base. The log
was a 12-sided cylinder lying on its side; it is now `branchGeometry` — a tube
that tapers along its length, bends, wobbles per-side, and carries a lighter
cut end through vertex colours. Flowers became two silhouettes (open daisy with
a pointed petal ring, or a closed bud) with the blossom and centre colours
baked into a single head geometry, so a two-colour flower still costs two
draws, and each stands on the sampler rather than at y = 0.

**Airspace.** Tall families (seed heads, foliage) are **barred by
construction** from standing inside `tallInnerRadius` (4.9), which is outside
the flight volume's own reach — measured at 4.63, the closest tall plant is at
4.92. Everything shorter stays under the butterfly's floor (tallest low plant
0.40 vs floor 0.60). No collider, no runtime special case: the layout simply
cannot put anything there. The stone trio moved to the near foreground, which
is both a stronger compositional device and deliberately reaches as deep as the
old placement, so the garden's content depth — and therefore its flight volume
— is bit-for-bit unchanged.

Budget after: **38** draw calls of 60 (22 colour + 16 shadow) and **22,469**
triangles of 25k, measured from the real geometry builders rather than
estimated. Per-instance tone (`setColorAt`) gives each family internal value
variation without extra materials, which is what stops a field of instances
reading as one flat green shape.

#### What rendering it actually showed

Geometry measurements say nothing about whether a scene *looks* right, and the
desktop harness cannot render garden mode. A throwaway probe page mounting the
real `GardenWorld`, `GardenLight`, `SkyDome`, `Ground` and the garden fog was
therefore screenshotted over CDP and **looked at**, and every problem below was
found that way rather than reasoned about in advance. Each was fixed at its
cause:

- **The whole garden was bleached.** Fog at near 4 / far 26 over a scene the
  camera sits 4.7 units from meant the far rim was two-thirds fogged and all
  value went to white. Now near 7 / far 26: a real depth gradient, and the
  foreground left alone.
- **The turf rendered as dark shards**, not grass. Two causes. A blade is a flat
  card, and an upright card is lit on one face and near-black on the other —
  real grass solves this with translucency, which a `meshStandardMaterial`
  cannot do. And the blade's arch was being scaled away: the geometry's curve
  runs along z, and z was scaled by the blade's *width*, so a 0.55 arch became
  0.015. Scaling z with the blade's **length** instead lets it lean over, which
  presents its face to the light and reads as a blade from any angle.
- **Coverage, not count.** Bare ground between blades is what made it read as
  debris. Coverage was bought with blade *width* (0.028 → 0.05) rather than
  blade count, because width is free and count is triangles.
- **The stones came out as a jagged blue-black mass.** `computeVertexNormals()`
  on an icosahedron does not smooth-shade anything: the geometry is non-indexed,
  so it computes one normal per *triangle*. The stone now derives its normals
  analytically from the radial displacement — the blob is star-shaped, so the
  outward normal simply *is* the vertex direction. Noise amplitude came down
  from 0.22 to 0.10 (it was spiking), and the colours warmed and lightened.
- **The limb rendered as a dark lump.** Hand-wound tube triangles lit from
  inside; the head and limb materials are two-sided now, so a hand-built form
  cannot render inside-out.
- **The blossoms were too small to be landmarks** and vanished into the turf.
  Fixed by growing the *head*, not the stem — which is also what keeps every
  flower below the butterfly's flight floor.
- **The clearing read as a disc floating on a platform** from a low angle: a
  bright clearing against a much darker surround. The surround colour is now
  close to the clearing's own outer value.

Two 15.5A/15.3 invariants were revised, deliberately and with the reason
recorded in place: the garden's fog `near` no longer has to be below the shared
`near` (the garden's is a dozen units across — its fog *must* start beyond the
near rim), and blade lean is now bounded by the blade's *total* lean rather than
its instance tilt alone.

The transition is one atomic native command (`set_window_mode` in
`src-tauri/src/lib.rs`): garden drops click-through and always-on-top,
resizes, centers and focuses the window; desktop re-reads the *current* work
area and restores the overlay exactly as startup created it. The React mode
is only adopted once the native window has actually followed, so scene and
window can never disagree.

Enter with a **double-click near the butterfly** (the hit-test zone already
guarantees "near" — no global hotkey, no new native surface); leave with
**Esc** or the small "Back to desktop" button in the garden's minimal chrome.
The double-click's two clicks count as ordinary clicks — a summon and
attention, exactly as if you had clicked twice.

While in the garden: cursor polling, hit-testing, environment refresh and
foreground awareness are all off (`desktopSystemsActive()` is the single
gate), the flight area is solved from the garden window's aspect, and the
camera uses the follow framing — a short glide marks the switch. Returning
restarts those systems fresh: the overlay is re-sized from a fresh work-area
read, the flight area re-solved from its aspect, and foreground awareness
re-subscribes. The `FlightController`, `Personality` and `CompanionMemory`
instances are never remounted — the same companion simply visits the garden
and comes home. There is no second window, no second scene, no second
butterfly.

### Global cursor and selective click-through

Because the overlay is click-through most of the time, WebView DOM events
cannot be the cursor source. `src/lib/desktop/cursor.ts` polls the OS-level
cursor position (~30 Hz, `cursorPosition` — desktop-relative physical
pixels, already covered by `core:default`) and feeds it through the
coordinate pipeline into the same `aimAt` live target the web uses, so the
butterfly reacts to the mouse anywhere on the desktop.

The same loop runs the hit-test zone (`src/lib/desktop/hittest.ts`): the
overlay stays click-through except while the cursor is near the butterfly —
interaction turns on inside 90 px and off beyond 150 px, with hysteresis so
the boundary never flickers, and the native `setIgnoreCursorEvents` toggle
fires once per transition. Everywhere else, clicks land on the applications
underneath: Chrome, VS Code, Discord, text selection — all unaffected.

The Tauri API bridge stays in `src/lib/desktop/window.ts`, imported lazily so
the browser bundle never pays for it.

### Architecture boundary

`src-tauri/` is a thin native host. It owns the desktop surface — sizing the
overlay to the work area, the initial click-through state — and nothing
else: no 3D logic, no animation, no flight behaviour. All rendering,
butterfly behaviour, camera and interaction remain in `src/`. The Rust side
still has exactly one dependency (`tauri`); native plugins are added only
when a feature needs them.

### Transparency

A transparent window means the scene must not paint a background of its own.
`src/lib/platform.ts` detects the Tauri webview at runtime (Tauri injects its
marker before the app boots), and in desktop mode the scene omits the sky
dome, the ground and the fog, while keeping the same lighting, butterfly,
camera and interaction.

This is the smallest change that achieves it:

- `Experience.tsx` renders `<SkyDome/>`, `<Ground/>`, fog and the background
  colour only in the browser, and enables `alpha` on the renderer.
- `SkyDome.tsx` was split out of `Atmosphere.tsx` so lighting is shared by both
  presentations and only the backdrop differs.
- A single `is-desktop` class (set before first paint on **both** `<html>` and
  `<body>`) removes the page background of each element — `body` paints its own,
  so matching only the root used to leave an opaque rectangle — hides the
  loading veil entirely, makes the failure state paint nothing, and drops the
  web-only title, hints and attribution line.

The browser experience is unchanged and keeps its full sky, ground and fog.
`BG_CHECK=1` in `tools/verify.mjs` asserts this from computed styles: every
page surface transparent, the veil hidden and no overlay text rendered on the
desktop — and, in the browser, the theme background, the veil and the
attribution line present.

## Checks

```bash
npm run build     # required first: the desktop check verifies dist/
npm run check     # movement, camera, screen-targeting, airspace, desktop-space,
                  # personality, memory, modes, drag and desktop checks
```

`tools/verify.mjs` is a headless-browser harness used during development. It
captures console output, runtime errors and failed requests, takes
screenshots, and can simulate pointer input, touch devices, reduced motion and
the Tauri environment:

```bash
node tools/verify.mjs http://localhost:4173/ out.png 1280 800
DESKTOP=1 PROBE_BG=1 node tools/verify.mjs ...   # desktop mode, probe backdrop
DESKTOP=1 BG_CHECK=1 node tools/verify.mjs ...   # desktop page transparency
TARGET_CHECK=right node tools/verify.mjs ...     # click-targeting assertion
DESKTOP=1 TRACK_CHECK=right TRACK_MS=30000 node tools/verify.mjs ...  # post-click trace
```

`TARGET_CHECK` (`right` / `left` / `upper` / `lower` / `center`, plus the four
corners `topleft` / `topright` / `bottomleft` / `bottomright`) clicks a known
screen position, then measures the butterfly's on-screen centroid through the
ensuing flight: the side checks assert real travel toward the clicked region
(or arrival in it), the centre check asserts it ends up centred without any
teleport-sized jump, and the corners assert both axes of the reach.

`BG_CHECK=1` asserts the page paints nothing in desktop mode (html, body and
app surfaces transparent, loading veil `display: none`, no attribution line
in the DOM) — and, in the browser, that the theme background, the veil and
the attribution line are still there, so the desktop rules can never leak
into the web build.

`TRACK_CHECK` (same regions, `TRACK_MS=<ms>` defaults to 30000) clicks like
`TARGET_CHECK`, then traces the butterfly for several seconds: on-screen
position, wing-pixel area and a raw `requestAnimationFrame` counter. The
three signals distinguish a stalled page from a stalled scene from an idle
butterfly, and show whether a click settles into visible idle life instead
of a freeze.

### Manual desktop verification

Everything checkable without a Rust toolchain is covered by `npm run check`.
The native behaviour (real work-area overlay, click-through, global cursor,
always-on-top) needs one manual pass on a machine with the toolchain:

```bash
npm run tauri dev
```

- [ ] The overlay covers the primary monitor's whole work area (taskbar
      excluded), with no visible placeholder flash at startup — the window
      appears already full-size.
- [ ] The desktop shows through everywhere the scene does not paint; the
      loading veil never appears on the desktop.
- [ ] The overlay stays above other applications, everywhere on the desktop.
- [ ] Click-through: with the cursor far from the butterfly, clicking Chrome,
      VS Code, Discord or selecting text works exactly as if the overlay
      were not there.
- [ ] Move the cursor close to the butterfly (~within a hand's width): the
      butterfly's surroundings become interactive — a click summons it.
      Move away again: the desktop is click-through once more, without any
      visible flicker between the two states.
- [ ] Move the cursor slowly near the butterfly: it turns to watch and
      drifts a little closer — it does **not** chase the cursor around the
      desktop.
- [ ] Put the cursor right on top of the butterfly: after a moment it makes
      one small hop away and settles (shy, not panicked); it does not keep
      fleeing while the cursor holds still.
- [ ] Click inside the butterfly's interaction zone: it flies to the clicked
      spot on a curved path, arrives, and stays there briefly even with the
      cursor parked on it.
- [ ] Watch it for a few minutes with the cursor elsewhere: mostly short
      local hops with varied pauses — sometimes still, sometimes a burst of
      short flights — no repeating pattern, no straight-line paths.
- [ ] Landings glide out (it decelerates into rest) rather than freezing
      instantly, and a resting butterfly keeps a subtle idle bob.
- [ ] Move the cursor to any desktop corner and click there (interaction
      zone aside, targeting itself): the butterfly can be summoned across
      the work area and stays on screen at all times.
- [ ] On a scaled display (e.g. 125%/150% DPI): cursor tracking still lands
      on the right spot (physical/logical conversion is correct), and the
      overlay still covers the full work area.
- [ ] Leave it alone for several minutes and watch where it chooses to settle:
      it now tends *not* to come to rest hard against the extreme edge of the
      area it can reach. The impression should be "it prefers the middle" —
      **not** "something is pushing it away". If it looks magnetically drawn to
      the centre, or afraid of the edges, `edgeAversion` in
      `src/lib/personality.ts` is too strong.
- [ ] Garden mode (Phase 15.2/15.3): double-click near the butterfly — the
      window becomes a normal centered interactive window showing the garden
      (patch, grass, flowers, stones, a log), cursor polling/hit-testing stop,
      and the butterfly is visibly the same companion (it does not teleport or
      reset) flying naturally through the scene; summon and cursor aim work.
      Click a flower: the butterfly flies over and investigates it (and the
      flower gives a small pulse), then resumes its own rhythm — it is not
      stuck on the flower. Esc or the "Back to desktop" button returns: work-area sizing,
      always-on-top, click-through and cursor tracking all come back. Repeat
      the round trip at least 3 times; familiarity and personality must
      survive it.
- [ ] **Garden depth and flower travel (15.4 fix 4) — needs a real display
      check.** In garden mode, move the cursor up and down through the window:
      the butterfly should now travel *toward and away from* the camera as
      well as sideways, and depth should read as a real axis rather than a
      faint extra. Then click each of the five flowers from a spot away from
      it: the butterfly should visibly travel toward that flower — including
      through depth — and stop hovering close above the blossom (a hover
      offset above it, not a point near the middle of the scene). While it is
      flying, move the cursor aggressively: the butterfly must stay committed
      to the flower until it arrives (the ownership latch) — and then stays
      there for about three seconds before the cursor resumes, so the click
      reads as something the companion responded to rather than an instant it
      passed through. Click a flower while already next to it: the interaction
      should be brief and harmless (the bounded hold), not ignored or stuck.
      Afterwards click ordinary ground: normal cursor targeting resumes.
      Then return to desktop and confirm nothing about it
      changed — transparent overlay, click-through, cursor tracking,
      autonomous flight, click targeting, foreground awareness and memory all
      behave exactly as before.
- [ ] **Butterfly selection (final phase) — needs a real session check.** In
      garden mode, use the selector bottom left:
      1. "Existing Butterfly" is active on first launch and the companion looks
         and behaves exactly as before.
      2. Click "Ulysses Butterfly": the same companion now wears the Ulysses —
         a sensible size, facing its direction of travel, flapping naturally
         (wings sweep up over the body, never folding underneath it).
      3. It still answers clicks, still follows the cursor, still visits
         flowers, and the Butterfly chase still works with it.
      4. Click "Existing Butterfly": the original companion is back, unchanged.
      5. Reload (or leave for the desktop and come back): the last choice is
         remembered. On the desktop, the selected butterfly appears with
         everything else exactly as before.
- [ ] **Butterfly Chase (Phase 16.1, post-fix) — needs a real session check.**
      In garden mode, press "Butterfly chase" (bottom right).
      1. A glowing target appears; the butterfly flies after it.
      2. Watch the marker: a slow, soft pulse while the butterfly chases; a
         quick, tight, bright pulse once the butterfly is *on* it.
      3. Click it while the butterfly is on it — the score (✦) increases
         immediately and exactly once. Click again at the same spot: nothing.
      4. Click a target *before* the butterfly arrives: nothing happens (it is
         not a catch, and it is not a skip either — the target stays alive).
      5. Repeat a few hits; then deliberately let one target expire: the
         "escaped" count increases by exactly one, and that target can never be
         clicked afterwards.
      6. When the 30 seconds end: the result line shows hits and escaped counts
         that match what you actually saw happen (a target still alive at the
         end counts as neither).
      7. Press "Again": a fresh round with zeroed counters begins.
      8. Throughout: clicking a flower does nothing, the cursor does not pull
         the butterfly off the chase, and when the game ends or is cancelled,
         flowers, cursor-follow and summoning all work immediately as before.
- [ ] **Mini-game foundation (Phase 16) — needs a real session check.** The
      foundation is invisible by design, so the check is that *nothing changed*:
      open the garden, click flowers (each one still answers with a visit and a
      stay), move the cursor (the butterfly still follows), and confirm there is
      no visible game UI, no debug panel, and no way to start a game yet. Return
      to desktop and confirm everything there is exactly as before. The runtime
      itself is asserted by `tools/test-minigame.mjs` — what a person can verify
      is that the garden and desktop still feel identical.
- [ ] **Garden visual foundation (Phase 15.5A) — needs a real display
      check.** In garden mode, judge the *foundation*, not the detail
      (planting is deliberately deferred to 15.5B): does the clearing read
      as a piece of habitat rather than a circular decal? Is the raised bank
      doing the work of a boundary? Do the stones and the log have contact
      shadows, so they look planted? Does the far ground dissolve into haze
      instead of running out into an empty plane? Can you read vertical space
      better, and does the garden feel more intimate? Is the butterfly still
      the focus, and still comfortably framed when it reaches the edges of
      its volume (especially the near-wall flowers at z +1.1 and +1.5)?
      Nothing here should look *emptier* than before by itself — an empty
      clearing is expected until 15.5B.
- [ ] **Garden ground artifact (Phase 15.5A.1) — needs a real display check.**
      Inspect the clearing's middle from several butterfly positions: there
      should be no circular boundary, no ring where the ground changes
      character, and no spokes converging on the centre. The ground should read
      as one continuous surface, still with gentle variation (not a flat plane),
      with the bank rising unevenly rather than as an even ring.
- [ ] **Garden visual identity (Phase 15.5B/C).** Partly pre-verified: the real
      garden components were rendered through a temporary probe page and
      inspected (see "What rendering it actually showed" above), which is how the
      bleached fog, dark-shard turf, jagged stones, dark limb and undersized
      blossoms were found and fixed. What that could **not** check is how it
      feels in the real garden window at the real window size, with the real
      butterfly and pointer parallax — so this still needs a display:
      - Fly it for a minute: does the garden hold up *while the butterfly moves*
        (the probe only ever saw it from a fixed camera at one instant)?
      - Does it still read as calm over time, or does the planting look busy
        once the camera is gliding through it?
      - With the pointer moving, does the parallax framing keep the rim from
        swinging distractingly across the frame?
      - Confirm the five flowers are all still easy to click and read as
        landmarks at the real window size.
      - The probe used a plain web canvas: the native window's own size, DPI and
        transparency are unverified here.
      - **And now the far boundary (15.5D)** — also rendered through the probe and
        inspected, so pre-verified the same way: does the garden feel *bounded*?
        Does the far edge dissolve into haze rather than ending at a line? Is the
        sky its own, or still the desktop's? Is there any obvious flat infinite
        plane left? Does the rim read as low undergrowth at the edge of a wood,
        or as a row of distant hills? Does it stay *under* the horizon line
        rather than spiking above it? Still unverified by that probe: the real
        window size and DPI, the real butterfly, and the scene in motion.
      Then the same judgement as before:
      - Does the garden read as a tended clearing at the edge of a wood, rather
        than a flat platform with objects on it? Specifically: does it look
        like *Minecraft* any more (five-sided grass cones, flat-shaded
        faceted spheres, a cylinder lying on the ground)?
      - Is there real depth — a distinguishable foreground, midground and
        background? The rim of taller grass, seed heads and foliage should
        frame the scene without becoming a wall.
      - Is the butterfly still clearly the focal point, and is the middle of
        the garden still visually quiet where it flies?
      - Do the three stones read as rounded natural stones (irregular
        silhouette, sitting *in* the ground) and the log as a small fallen
        limb (tapered, slightly bent) rather than geometric props?
      - Do the five flowers read as intentional landmarks with planting
        around them, rather than as five identical objects on a circle?
      - Does the planting look *composed* — gathered in groups and heavier at
        the rim — rather than sprinkled at random? Look for obvious
        repetition, floating instances, clipping through the ground or through
        each other, and anything that looks oversized for the butterfly.
      - The chrome reads "Esc to leave" — it no longer calls the garden "a first
        look".
- [ ] Memory survives a restart (Phase 14): summon the butterfly a few times,
      quit, relaunch. The app behaves normally, and a
      `butterfly.companion.memory` entry exists in the WebView's localStorage
      (DevTools → Application → Local Storage). Deleting that entry makes the
      next launch behave like a first run — nothing breaks.
- [ ] **Unverified in automation — needs a real display change.** Change the
      display resolution, or move the window between monitors with different
      scaling, and confirm the butterfly keeps tracking the cursor accurately
      and stays inside the (possibly new) work area, without restarting,
      jumping, or re-appearing. Note that the native layer sizes the overlay
      only at startup, so a change that alters *neither* DPI nor the window
      geometry produces no event and the overlay will not follow it — that is a
      known native-layer gap, not a refresh bug.
- [ ] No overlay text of any kind — title, hints and the attribution line are
      all omitted on the desktop (the attribution stays in the browser view
      and in this README).
- [ ] No one-pixel border/artifact around the window edges (DWM can add one to
      transparent windows; if it appears, record it before trying workarounds).
- [ ] The overlay cannot be resized (no edge/corner cursors) and does not
      appear as a normal window (no taskbar preview of a 420×320 placeholder).

## Interaction

| Input | Effect |
| --- | --- |
| Move the cursor (web) | The cursor becomes a live target: the butterfly flies towards it along a curved path, and keeps re-aiming while the cursor moves |
| Move the cursor (desktop) | The cursor is a **presence**, not a target: the butterfly notices it (turns to watch, drifts a little closer), and shies away with a small hop if the cursor gets right on top of it — tracked anywhere on the monitor via the global cursor source |
| Click / tap | Calls the butterfly to that spot — an explicit commitment that finishes even if the pointer leaves. On the desktop this works while the cursor is inside the butterfly's interaction zone |
| Near the cursor | It settles into a gentle idle hover instead of freezing |
| Leave the window (web) | It returns to free wandering across the whole airspace |

### Click targeting

`src/lib/targeting.ts` converts a screen position into a world target:

1. The click ray is intersected with a **fixed horizontal plane** at the
   camera's look height, which fixes how far along the ray the click sits.
2. That depth is clamped into the flight area's z-band and the point is taken
   **back on the ray** at the clamped depth. Because the result lies on the
   click ray, it projects back to exactly the clicked spot — so corner clicks
   reach the corner region instead of collapsing towards the middle.
3. Altitude comes from the **vertical screen offset**, mapped across the
   flight area's own altitude band.
4. The result is clamped by `clampToArea`, the same rules the flight
   controller uses, so a target is always reachable.

On the web the follow camera still applies: while a directed flight is in
progress the framing trails slightly back along the flight path (capped by
`maxTrailDistance`), which keeps the butterfly visible on the side of the
frame it is travelling towards. On the desktop the framing is fixed — the
butterfly's own travel reads as travel across the window — so no lean is
applied at all.

### Flight model

`src/lib/flight.ts` is a small state machine with a continuous physical
state, driven by three ranked influences — explicit targets (click, web
cursor), presence reactions (desktop cursor), and autonomous life:

```
IDLE_HOVER      layered-bob hovering; arrival momentum glides out through
   |            the anchor; awareness drifts toward what is near
   |            explicit target, shy hop, or the resting rhythm ending
TARGET_ACQUIRED destination set, take-off lift, cruise and leg seeds
   v
FLYING          steering along a weaving curve with a fluttering pace; a
   |            moving live target re-aims every frame
   v
ARRIVING        braking eases the speed out; the weave carries it slightly
   |            past — a soft landing, never a timed stop
   v
IDLE_HOVER
```

The trajectory is deliberately not Cartesian A→B: the seek direction is
layered with incommensurate sine sways (sideways + vertical), so every leg
curves, and the exponential steering keeps velocity continuous through every
retarget. There is no flight timer on directed flights — they end on arrival,
never on a fixed duration.

### Personality

`src/lib/personality.ts` decides *how intensely* the butterfly reacts, never
*how* it moves. It holds a tiny deterministic state model — **CALM /
CURIOUS / PLAYFUL / SHY** — driven by an attention accumulator (cursor
proximity feeds it slowly, clicks feed it strongly, time decays it), and
maps each state to a `BehaviorProfile`: the handful of reaction knobs
(notice/crowd radii, curiosity, shy cooldown, rest/hop/speed/weave scales)
that the flight controller reads in place of what used to be embedded
constants.

The layering is strict:

```
interaction events → Personality (state + attention)
                   → BehaviorProfile
                   → FlightController (mechanics)
                   → movement
```

`CALM` is bit-identical to the pre-personality behavior — with no
interaction history the butterfly behaves exactly as before (pinned by
`tools/test-personality.mjs` and a controller default-profile check in
`tools/test-flight.mjs`). The module is fully deterministic: no randomness,
so the same event sequence always yields the same states.

The profile is applied every frame in `Butterfly.tsx`, and the interaction
paths report events to the personality (below).

### Personality events (what Interaction reports)

`Interaction.tsx` reports three events and decides none of them. Both input
paths (DOM pointer on web, the 30 Hz global cursor poll on desktop) resolve
through the same `screenToWorldTarget` mapping, so the distances reported are
the distances the flight controller already uses — there is no second
coordinate conversion and no second hit-test.

| Event | Reported when | Weight |
| --- | --- | --- |
| `onCursorProximity` | the cursor **moved** within the current notice radius; `closeness = 1 − distance / noticeRadius`, `dt` = time since this source last moved | low, continuous |
| `onCrowding` | any observation where the cursor is within the current crowd radius (reported while still) | none — feeds shyness only |
| `onClick` | every click, classified near (< 1.2 world units) or far | near strong, far light |

Notes:

- **Proximity is movement-gated.** A cursor parked near the butterfly reports
  nothing further, so attention keeps decaying instead of saturating on a
  still mouse. On web, proximity advances only on `pointermove` events; on
  desktop the poller samples it while the cursor moves.
- **Crowding is a position, not an act**, so it is reported on every sample
  where it holds — that is what lets shyness build when someone rests the
  cursor on the butterfly. It feeds *only* the shyness timer; the Phase 11
  shy hop (which lives in the flight controller) is untouched.
- **Clicks never move anything new.** A far click still calls `seekTo()`
  exactly as before and additionally reports a light attention signal; a near
  click reports a strong one. A single click — near or far — can never change
  the state (0.35 attention vs a 0.45 threshold), so interaction has to
  persist to matter.

No personality value is visible in a new movement reaction yet: for now it
only shifts *how intensely* existing reactions happen.

### What each state looks like

The states are preferences, not commands — the profile is twelve numbers, and the
flight controller still decides every movement. `CALM` is the reference
behavior (identical to the pre-personality constants).

| | CALM | CURIOUS | PLAYFUL | SHY |
| --- | --- | --- | --- | --- |
| feel | relaxed, self-contained | "something caught its eye" | lively, restless | wants more room |
| attention yaw | 0.55 | **0.85** | 0.65 | **0.9** |
| notice radius | 2.4 | **3.0** | 2.6 | 1.7 |
| curiosity drift | 0.10 | **0.20** | 0.12 | 0.05 |
| crowd radius | 0.4 | 0.32 | 0.35 | **0.65** |
| crowd push | 0.25 | 0.25 | 0.25 | **0.45** |
| rest scale | 1.0 | **0.65** | **0.45** | **1.4** |
| hop scale | 1.0 | 0.85 | **1.35** | 0.6 |
| speed scale | 1.0 | 1.03 | **1.18** | 0.85 |
| weave scale | 1.0 | 1.05 | **1.3** | 0.85 |
| shy cooldown | 5 s | 6 s | 7 s | **3 s** |
| edge aversion | 0.25 | **0.4** | **0.12** | **0.6** |
| foreground affinity | 0.4 | **0.55** | 0.25 | **0.1** |

What you should be able to see:

- **CALM** — ordinary Phase 11 rhythm: local hops, long irregular rests, mild
  reaction to a nearby cursor, no interest. It also keeps a mild distance from
  the extreme reachable edge.
- **CURIOUS** — it turns its head toward a nearby cursor sooner and further,
  drifts gently closer while it rests, and sits still for noticeably less time.
  The drift is an anchor rate, not a target: it notices, leans, drifts, then
  resumes its own rhythm. It cannot follow the cursor — there is no target in
  the profile to follow.
- **PLAYFUL** — more legs per minute, shorter rests, livelier weave, slightly
  quicker and longer hops. A willingness to move, not a willingness to chase:
  nothing in the profile aims anywhere, and every leg is still an ordinary
  autonomous leg inside the same flight area.
- **SHY** — the clearest state. It starts easing away from a cursor much
  sooner (crowd radius 0.65 vs 0.4) and pushes off harder, so a cursor
  resting on it visibly loses its grip; if the cursor follows, it hops away
  again after 3 s instead of 5. Its own legs are small, slow and infrequent,
  which is also why it does not come straight back. It relaxes as soon as the
  cursor leaves — no permanent avoidance lock.

For a state change to be *felt* immediately rather than at the next sampled
leg, the controller samples cruise speed and weave amplitude unscaled and
applies `speedScale`/`weaveScale` per frame, and rescales the remaining rest
when `restScale` changes. Only elapsed time and amplitudes change — never a
position, velocity or destination.

What makes it read as a creature rather than a command-driven object:

- **Local autonomous hops**: when nothing is asked of it, the butterfly
  potters around its patch — mostly short 0.7–2.2 unit legs, sometimes a
  medium excursion, rarely a longer flight, biased a little forward.
- **An irregular resting rhythm**: ordinary pauses, quick stops that chain
  into active spells, and occasional long still rests — never a metronome.
- **Per-leg variation**: every flight leg samples its own weave alignment,
  amplitude and cruise speed, and the pace itself breathes (bounded
  flutter), so no two legs share the same wobble.
- **Glide-out arrivals**: residual landing momentum drains through the hover
  anchor over about a second — it decelerates into rest instead of freezing.
- **Presence, not pursuit** (desktop): a nearby cursor earns a turn of the
  head and a shy drift; a cursor right on top earns one small hop away, on
  a cooldown — and never while a directed flight owns the motion.

### Memory and familiarity (Phase 14)

The butterfly keeps a tiny, local record of the time you spend together — and
slowly becomes familiar because of it. Memory here means six numbers in
`localStorage`, derived only from your interaction with this application.

**What it remembers** (`src/lib/memory.ts`, one storage key):

| field | meaning |
| --- | --- |
| `summons` | clicks that successfully called the butterfly |
| `sessions` | application launches it shared with you |
| `togetherMs` | committed time spent in sessions (bounded) |
| `firstMetAt` / `lastSeenAt` | when you first met / were last together |
| `version` | the record's schema version |

**What it deliberately does not remember:** cursor positions, frames, flight
destinations, window titles, applications, documents — nothing about the
desktop, and nothing continuous. A cursor parked on the butterfly produces no
memory at all; only answered summons and session boundaries count. Memory
never leaves the machine (the module makes no network calls), and there are
no accounts, no sync, no analytics.

From those counters it derives one of four companion states — `new`,
`familiar`, `comfortable`, `attached` — with plain, explainable thresholds
(e.g. `comfortable` = 25+ summons across 3+ sessions). Counters only grow, so
familiarity never falls; and only `new → familiar` is reachable in a single
sitting — the rest requires coming back on later days, which keeps it a
relationship rather than a streak. There is no XP, no level, no reward.

Familiarity reaches the flight controller the same way personality does:
through the behavior profile, and nowhere else. `applyFamiliarity()`
multiplies five fields by small factors (±15% at most): a familiar companion
notices you from a little further away and turns to watch more readily
(`noticeRadius`, `attentionYaw`), is a little harder to spook and hops away
less frantically (`crowdRadius`, `shyCooldown`), and flies slightly calmer
paths (`weaveScale`). Everything else — both environment preferences
included — passes through untouched, and with empty memory (`new`) the
profile is returned unchanged: a first launch is bit-for-bit the pre-memory
behavior, and the deterministic flight baseline is untouched.

**Persistence** is `localStorage` under one versioned key, written debounced
(1 s) after meaningful events and flushed best-effort on page hide — never
per frame. A corrupt, unreadable or foreign-version record falls back to
empty memory; a failed save is swallowed. Losing memory costs familiarity,
never correctness.

The companion communicates familiarity purely through behavior: there is no
memory panel, no settings screen, no notification. (If a later phase ever
adds optional settings, the web overlay's chrome is the non-intrusive place
for them — the desktop shows no UI by design.)

The **flight area is the visible surface's airspace**, derived — never
hand-picked per window size. `src/lib/airspace.ts` solves, from the shipped
camera pose and the actual viewport aspect, the widest world box whose
corners still project inside the frame (worst case ≈ 0.78 of the half-frame,
leaving room for the wingspan and pointer parallax). The desktop overlay
re-solves it for the real work-area aspect at startup
(`FlightController.setArea`); the web build keeps the reference solve.
`tools/test-airspace.mjs` and `tools/test-camera.mjs` re-check the
containment every run. The altitude and depth bands are aspect-independent
shared constants, and the z-band is kept shallow so one world box can both
stay in frame and reach most of the surface.

**Each presentation gets the volume its camera can actually use** (15.4 fix
4). That shallow z-band is the right trade for the desktop's *fixed* shot —
the butterfly's screen position *is* its position on the work area, and a
thin slab keeps perspective scale constant. The garden runs the follow rig
over a garden several units deep, so `gardenFlightArea()` solves a
garden-specific volume instead: the same X/altitude solve (unchanged), with
depth derived from the configured garden content plus a small margin
(`SCENE.garden.flightArea.depthMargin`). Desktop and web keep
`flightAreaForAspect()` and its bands, exactly as before; the two volumes
never mix, and the flight controller is unaware of either.

One consequence worth naming: the depth reference used for clicks that pass
above the horizon (`SCENE.interaction.maxRayDistance`) has to reach past the
*deepest* volume's far wall, or moving the cursor up would quietly resolve to
a depth nearer than the rays just below it. With a shallow band any reach is
clamped away and the value is invisible; with the garden's depth it is not,
so the value now clears the deepest volume at every follow pose.

## Architecture

The butterfly is a **replaceable external asset**. No application behaviour is
built into the model: movement, animation states, interaction, camera and
environment are all driven by code around the GLB.

```
public/assets/animated_butterfly.glb   the model (external, replaceable)
src/
  config/experience.ts                 single source of tuning values
  lib/
    flight.ts      FlightController    live-target flight state machine: curved
                                       steering, hovering, banking, arrival
    personality.ts Personality         reaction-intensity states + BehaviorProfile
                                       + familiarity adjustments
    memory.ts      CompanionMemory     local companion memory: bounded counters,
                                       companion states, debounced localStorage
                                       persistence (no imports, no network)
    appMode.ts     AppMode             the two window modes + which desktop
                                        subsystems each runs (pure)
    minigame.ts    MiniGameRuntime     the mini-game lifecycle boundary: state
                                        machine, narrow flight surface, one
                                        teardown path (pure, no rendering)
    butterflyChase.ts createButterflyChase  the first mini-game: deterministic
                                        target spawns, click-to-hit, timed
                                        completion (pure, no rendering)
    garden.ts      clearingMesh +        the clearing's surface and value structure,
                   groundHeight +         the height everything stands on, the planting
                   scatterGrass +         layout (turf clusters, leaf clumps, seed heads,
                   scatterLeaves +        foliage mounds) with the density gradient and
                   scatterSeedHeads +      airspace guards, flower picking and the
                   scatterFoliage,        ownership rule (pure, no renderer)
                   pickGardenObject
    airspace.ts    flightAreaForAspect derives the desktop flight area from camera + viewport;
                   gardenFlightArea derives the garden's own volume from the garden content
    awareness.ts   desktop facts: edge/corner distances, cursor containment,
                   work-area edges in world space (pure, no host access)
    targeting.ts   screenToWorldTarget screen position -> world target (ray-anchored)
    camera.ts      CameraRig           follow camera (web) / fixed shot (desktop) + parallax
    animation.ts   resolveClip         clip lookup with fuzzy fallback
    gltf.ts        useGLTF             cached, suspending GLB loader
    gradient.ts    verticalGradient    canvas texture for the sky
    quality.ts     detectQuality       device tier + reduced-motion
    desktop/geometry.ts  work-area geometry + desktop coordinate conversions
    desktop/environment.ts DesktopEnvironment  monitor + work area + scale +
                   work-area insets (cached, explicitly refreshable)
    desktop/refresh.ts    refreshEnvironmentFacts  event-driven, coalesced
                   re-read of the desktop facts (never behaviour)
    desktop/windows.ts  foreground-window fact: one external focused window,
                   logical desktop rect, failure retention, focus-change
                   notification (no polling)
    desktop/cursor.ts    global cursor polling (desktop cursor source)
    desktop/hittest.ts   HitZone          selective click-through with hysteresis
    desktop/window.ts    lazy Tauri window bridge (dragging, click-through toggle)
    desktop/mode.ts    applyWindowMode   lazy bridge to the atomic native
                       window-profile transition
    desktop/drag.ts      DragGesture      window-drag gesture (future phases)
  components/
    scene/       Experience, Atmosphere, Ground, CameraRig,
                 Interaction, VisibilityGate
    garden/      GardenChrome           the garden window's minimal exit chrome
                 GardenWorld            the garden environment: the clearing, the
                                          flowers, stones and limb (procedural)
                 GardenPlanting         the four planting families, one instanced
                                          draw each (renderer only, no input)
                 gardenGeometry         procedural forms: blades, leaf clumps, seed
                                          heads, foliage, pebbles, branch, flower heads
                 GardenBackdrop         the far boundary: two instanced silhouette
                                          families, unlit, no shadow caster
                 GardenLight            the garden's own light rig (garden-only)
    butterfly/   Butterfly              loads the GLB, applies fit + rotation
    ui/          Loader, Overlay, ErrorBoundary
tools/
  verify.mjs        headless browser checks (console, errors, screenshots,
                    TARGET_CHECK click-targeting, BG_CHECK transparency,
                    TRACK_CHECK post-click life trace,
                    EDGE_CHECK autonomous edge-preference observation)
  test-flight.mjs   behavioural tests for movement
  test-camera.mjs   behavioural tests for camera framing
  test-targeting.mjs behavioural tests for screen-to-world targeting
  test-airspace.mjs airspace derivation (containment at any aspect) + the garden volume
  test-awareness.mjs desktop environment + awareness facts (deterministic)
  test-desktop-refresh.mjs environment refresh: change detection, coalescing,
                       failure tolerance (deterministic, injected readers)
  test-desktop-windows.mjs foreground-window fact: fixtures, physical→logical
                       conversion, failure retention (injected reader)
  test-desktop-space.mjs desktop coordinates + hit-test zone hysteresis
  test-personality.mjs personality states, attention, profile identity,
                        familiarity bounds
  test-memory.mjs   companion memory: model, exact thresholds, persistence
                        and failure seams, stationary-cursor neutrality
  test-app-mode.mjs the window-mode vocabulary and subsystem gating
  test-minigame.mjs mini-game lifecycle: transitions, ownership, cleanup,
                    suppression, re-entry, no stale state
  test-chase.mjs    Butterfly Chase: determinism, spawns, hits, misses,
                    completion, cancel, pause, interaction restoration
  test-garden.mjs   garden layout determinism, planting composition and its
                        airspace guards, the draw/triangle budget, object picking
                        and the feedback curve
  test-drag.mjs     behavioural tests for the window-drag gesture
  butterfly-centroid.mjs measures the butterfly's on-screen position
  check-desktop.mjs desktop runtime boundary checks
  inspect-glb.mjs   prints a GLB's world-space bounds and orientation
```

### The Ulysses asset's wing-flap defect (diagnosed and fixed)

`public/assets/ulysses_butterfly.glb` was added as a candidate butterfly. Its
only animation (`fly`, 0.5 s loop, 84 channels) looked broken: the wings
appeared to flip ~180° during the flap. Diagnosis (by evaluating the skinned
mesh directly, not by eye):

- **Root cause is in the clip itself**, not in quaternion interpolation (adjacent
  keyframe dots stay positive — slerp takes the short path), not in the bind
  pose, not in the model orientation, and not in the Three.js playback.
- Each wing's rotation channel sweeps a signed **−90° … +89°** about its
  parent-space Y axis: the up half is a correct flap (wings meet over the
  body), but the down half folds the wings to ~90° *below* the abdomen, where
  they nearly touch. Real butterflies end the downstroke near horizontal.
  Affected joints: `RightUpperWing_1`, `LeftUpperWing_25`, `RightLowerWing_46`,
  `LeftLowerWing_47`. There is no second clip to fall back to.
- **Fix (in the asset, not at runtime)**: `ulysses_butterfly.fixed.glb` —
  each wing's *down-side* keyframe angles scaled to a maximum of 8° below the
  rest pose; the up side untouched (verified frame-identical at the up
  extreme). The original file is kept; the active butterfly remains
  `animated_butterfly.glb`.
- **Verified** by re-evaluating the skinned mesh at 9 clip times (wings no
  longer pass below the body: +0.24 vs −0.29 before) and by rendering both
  files at the up/down extremes.

The fixed asset is the second selectable butterfly (below).

### Butterfly selection (final phase)

The user can choose between two visuals for the **same** companion — the
original asset and the repaired Ulysses — from the garden chrome (bottom
left, next to the exit button). The desktop overlay stays UI-free by design;
it simply wears whatever was last selected.

The whole feature is deliberately small:

- **Definitions** (`src/config/experience.ts`): `BUTTERFLY_ASSET` (untouched)
  and `ULYSSES_ASSET`, both plain `ButterflyAssetSpec`s — url, clip mapping,
  `hoverTimeScale`, `targetSize`, `yawOffset`. `ULYSSES_ASSET` maps the GLB's
  single `fly` clip to both airborne states and carries `yawOffset: Math.PI`
  (the model faces −Z; measured from its antenna-to-body joint vector — the
  original faces +Z). Its bounding box is close to the original's, so the
  shared auto-fit needs no bespoke scale. `BUTTERFLY_SPECIES` is the
  two-entry list: id, label, asset.
- **Selection seam** (`src/lib/species.ts`): id validation, resolution, and a
  guarded one-key `localStorage` record (`butterfly.companion.species`) in
  the same never-throwing style as the companion memory. Forgetting the
  choice just means the default (`classic`).
- **Wiring**: `App` owns the selection next to the window mode and passes the
  species down; `Experience` renders `<Butterfly key={species.id} …>`, so a
  switch remounts *only* the model component. The flight controller,
  personality, memory, interaction and the mini-game runtime are
  species-independent and live through every switch; no behaviour module may
  read the selection (asserted by `check-desktop.mjs`).

Verified deterministically (`tools/test-species.mjs`, including that every
mapped clip really exists in the GLB it names) and live: clicking the real
selector swapped the rendered model, persisted the choice and restored it
after a reload, with zero page errors.

### Replacing the butterfly

1. Drop the new GLB into `public/assets/`.
2. Update `BUTTERFLY_ASSET` in `src/config/experience.ts`:
   - `url` — path to the file
   - `clips.flying` — flap clip used for flight (matched case-insensitively,
     with a substring fallback)
   - `clips.hover` — clip used for airborne hovering; normally the same flap
     clip, played at `hoverTimeScale` speed, because a perched "idle" clip
     holds the wings folded and frozen. The GLB's own `Idle` clip
     (`clips.idle`) stays mapped for a future perched-on-a-surface state.
   - `yawOffset` — only if the model faces a different direction

Nothing else needs to change. Size is auto-fitted from the model's bounding
box (`targetSize`), so models in different units still appear correctly.

## Performance and accessibility

- Renderer pixel ratio and antialiasing adapt to device capability.
- `prefers-reduced-motion` slows and softens all movement.
- Rendering pauses automatically while the tab is hidden.
- The 3D runtime is loaded as a separate chunk so the interface paints
  immediately.
- Touch devices get touch-appropriate hints; the overlay is keyboard- and
  screen-reader-friendly.

## Credits

3D model **Animated Butterfly** by **Artistic_side**, licensed under
[Creative Commons Attribution (CC BY)](https://creativecommons.org/licenses/).
Attribution is shown in the browser presentation and recorded here; the
transparent desktop companion renders no overlay text at all, so the installed
desktop app ships the same attribution as **`CREDITS.txt`** next to the
executable (bundled via Tauri `bundle.resources` — see the project root file
of the same name).
