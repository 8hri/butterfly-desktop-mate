# design.md

# Project Design Document

## Product Vision

Create an interactive digital experience centered around a living 3D butterfly.

The goal is not simply to display a 3D model, but to create the feeling of interacting with a small living creature inside a digital environment.

The experience should feel:

* Calm
* Organic
* Beautiful
* Curious
* Lightweight
* Memorable

The butterfly should feel like a presence, not an object.

---

# Core Experience

The user enters an environment where a butterfly exists naturally.

The first impression should be:

"Something alive is here."

The experience should encourage exploration and interaction without requiring complex instructions.

The user should understand the environment naturally through observation.

---

# Visual Direction

## Overall Style

The visual style should combine:

* Minimalism
* Natural elements
* Soft lighting
* Modern 3D aesthetics

Avoid:

* Gaming-style interfaces
* Excessive HUD elements
* Overly technical visuals
* Distracting effects

The focus should remain on the butterfly.

---

# 3D Environment

The environment should support the butterfly rather than compete with it.

Possible elements:

* Soft natural background
* Gentle atmosphere
* Subtle depth
* Simple environmental objects

Examples of suitable environments:

* A quiet garden
* A forest clearing
* A dreamy digital nature space
* A minimal abstract world

The environment should remain lightweight for web performance.

---

# Butterfly Behavior

The butterfly should feel alive.

## Idle State

When the user is not interacting:

The butterfly should:

* Slowly move
* Occasionally flap wings
* Hover naturally
* Have subtle random motion

Avoid robotic movement patterns.

---

## Flying State

During movement:

The butterfly should:

* Move smoothly
* Avoid instant direction changes
* Use natural acceleration and deceleration
* Maintain believable flight behavior

Movement should feel organic.

---

# Interaction Design

Interaction should be intuitive.

Possible interactions:

* Mouse movement influences butterfly attention
* Clicking/tapping attracts the butterfly
* Hovering creates awareness
* Camera movement follows naturally

The user should feel like they are interacting with a living creature.

Avoid requiring:

* Complex controls
* Multiple buttons
* Tutorial-heavy onboarding

---

# Camera Design

The camera should create immersion.

Requirements:

* Smooth movement
* Natural perspective
* No aggressive camera motion

The user should always maintain a comfortable view of the butterfly.

Camera behavior should prioritize:

* Beauty
* Awareness
* Interaction

---

# Lighting

Lighting should create atmosphere.

Preferred:

* Soft shadows
* Natural gradients
* Gentle highlights

Avoid:

* Harsh lighting
* Excessive bloom
* Heavy post-processing

Performance is more important than visual effects.

---

# UI Design

The UI should be minimal.

The interface should support the experience without becoming the experience.

Possible UI elements:

* Small navigation elements
* Settings
* Credits
* Optional interaction hints

The butterfly and environment should remain the primary focus.

---

# Animation Principles

Animations should feel natural.

Prioritize:

* Smooth transitions
* Organic timing
* Subtle variation

Avoid:

* Repetitive mechanical loops
* Sudden movements
* Excessive animation frequency

The existing butterfly animations:

* Idle
* Flying

should be used as the foundation.

Additional movement logic should enhance them, not replace them.

---

# Responsive Experience

The experience should work across:

* Desktop
* Tablet
* Mobile

Consider:

* Different screen sizes
* Touch interaction
* Performance limitations
* Reduced effects on weaker devices

The core experience must remain enjoyable everywhere.

---

# Loading Experience

Loading should feel intentional.

During loading:

Provide:

* Elegant transition
* Simple progress indication if needed
* Smooth entrance into the experience

Avoid showing technical loading states.

---

# Accessibility

The experience should consider accessibility.

Include:

* Clear controls where needed
* Reduced motion considerations
* Readable UI elements
* Appropriate contrast

---

# Asset Philosophy

The butterfly model is an external visual asset.

The design should not depend on one specific model forever.

The system should allow:

* Replacing the butterfly model
* Changing animations
* Adjusting appearance

without redesigning the entire experience.

The model's CC BY attribution is part of the product, not an afterthought: it
appears in the browser presentation, in the README, and ships inside every
release as a `CREDITS.txt` file — while the transparent desktop overlay itself
keeps rendering nothing but the butterfly.

---

# Desktop Environment (Phase 13, foundations)

In desktop mode the butterfly lives on the real desktop, so it eventually needs
to know *where* it is. The environment model is deliberately factual and
separate from behaviour:

```
monitor bounds ─┐
work-area bounds├─► environment facts ─► awareness (pure) ─► behaviour
scale factor    ─┘
```

Three boundaries must not be collapsed, because on a real desktop they differ
substantially:

* **Monitor edge** — the physical screen.
* **Work-area edge** — the usable desktop the overlay covers.
* **Reachable edge** — the volume the butterfly can actually occupy, which is
  intentionally **smaller** than the work area so the wingspan and framing
  always fit.

Two honest limitations, stated rather than hidden:

* The overlay is transparent, so the application knows **desktop geometry but
  not what is painted underneath it**.
* The difference between monitor and work area is reported as neutral
  **work-area insets**, not as a taskbar: a taskbar cannot currently be
  distinguished from any other reservation, and an auto-hiding one is
  invisible to this model entirely.

Behaviour follows the environment, never the other way round: the environment
reports facts, personality expresses preferences, and the flight controller
remains the only authority that moves the butterfly.

The first preference built on this is deliberately small: when choosing where
to hop next on its own, the butterfly is *slightly* less likely to end up
pressed against the extreme of the volume it can reach. It is expressed as a
single number on the behaviour profile, applied only to autonomous destination
choice — never to a destination the user asked for, and never as a wall it
could bounce off. "It tends not to choose the extreme edge" is the whole
intent; "something is forcing it away from the edge" would be a failure.

Environment facts must also stay *true*. A companion whose idea of the desktop
was fixed at launch would quietly describe a display that no longer exists, so
the facts are re-read when the system says the display may have changed. Three
rules keep that honest: the events are treated as a hint and the values are
always re-read from the OS; several events collapse into one refresh, because a
display change is a burst rather than a moment; and a refresh that cannot read
anything keeps what it already knew rather than inventing new geometry. It
remains a fact update — the creature is never reset by it.

Knowing *where* the desktop ends is the first half of being present on a
desktop. The second half is knowing what else is there, and the first step
there is deliberately the smallest honest one: the window that currently holds
focus. Not a list of applications, not the taskbar, not what is painted
underneath a transparent overlay — one window, its rectangle, and the
knowledge of which window is *not* us.

That exclusion matters more than it sounds. The companion's own window is
always on top and covers the work area; a companion that cannot tell itself
from an application would end up reacting to its own reflection. Native window
identity is the answer, not a name.

A rectangle is geometry, not truth about pixels. Nothing here can see through
the overlay, and a window being "in front" in z-order says nothing about what
is visible there. Keeping that distinction explicit is what stops an
environment system from quietly becoming a claim it cannot support.

So what did the companion *do* with the window in front? Very little, and on
purpose: when it chooses where to hop next on its own, a window that is there
becomes slightly more attractive — a fraction of the way back, not a wall. The
whole distance between those two things is the entire design: a companion that
drifts toward what you are doing, and that can always wander off again. Any
future feature that turns this preference into a boundary, a target, or a place
to land has stopped being an improvement and started being a cage.

The companion lives in two places without ever becoming two companions. The
desktop is home: the transparent overlay where it shares your workspace. The
garden is a visit: one small windowed world you step into together — same
flight, same personality, same memory — and step back out of. The modes are
window *profiles*, not applications: entering the garden never creates
anything, and leaving it never loses anything. If a mode switch ever reads as
a different creature arriving, the design has failed.

The garden itself follows the same law as everything else here: it is the
butterfly's place, not the butterfly's stage. A patch of grass, a few
flowers, some stones, a log — arranged once, the same every time, because a
place you know is a place you can come back to. It asks nothing of the
creature and does nothing to it; it is simply where it lives when you visit.

It is a small clearing at the edge of a wood, not a stage set: turf gathered
in tufts, leaf clumps and seed heads around the landmarks, a heavier fringe
of grass and foliage closing the rim, and the middle left quiet, because the
middle is where the creature flies. Composed, slightly wild, tended — never
a circle of props on a disc.

When something in the garden does answer a touch — a flower that the
butterfly drifts over to inspect — it answers the way the creature itself
would: by being interesting for a moment, not by paying out. The butterfly
investigates and moves on; the flower settles. A garden that rewarded every
touch would be a vending machine. This one is just glad you came.

So what does the companion *remember*? Very little, and on purpose — the same
restraint as everything else it knows. A count of answered summons, a count of
shared sessions, the time spent together, and two timestamps. Six numbers, kept
on the machine, never sent anywhere. A companion that logged your cursor, your
windows or your habits would not be more familiar; it would be more invasive.
Familiarity here is the residue of interaction, not surveillance.

The states that grow out of it — new, familiar, comfortable, attached — are not
a progression system. There is nothing to earn and nothing to lose: the numbers
only move forward, and most of them cannot be reached in one sitting. Familiarity
that can be farmed is a game; familiarity that accrues by returning is a
relationship. What changes with it is small on purpose: a familiar companion
notices you a little sooner, spooks a little less, settles a little calmer. The
creature stays the same creature — it simply knows you.

---

# Emotional Goal

The final experience should create a small moment of connection between the user and a digital creature.

It should feel closer to:

* Watching nature
* Discovering something alive
* A peaceful interactive artwork

rather than:

* Using a traditional application
* Playing a game
* Viewing a technical demo

---

# Final Design Principle

The butterfly is the soul of the experience.

Every technical and visual decision should answer one question:

"Does this make the butterfly feel more alive?"