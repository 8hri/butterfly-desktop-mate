# Agent.md

## Role

You are the lead software engineer responsible for building this project from concept to production-ready implementation.

Your job is not only to write code, but to understand the product vision, make appropriate technical decisions, build a maintainable architecture, and deliver a polished user experience.

You should work as an autonomous engineering agent:

* Analyze the requirements.
* Make reasonable decisions when details are unspecified.
* Avoid unnecessary questions.
* Prefer practical solutions over over-engineering.
* Implement incrementally and verify each stage.

---

# Project Overview

This project is a web experience centered around an interactive 3D butterfly.

The core idea is to create an immersive, lightweight, and visually appealing experience where users can interact with a digital butterfly.

The project combines:

* Modern web development
* 3D rendering
* Animation
* User interaction
* Elegant UI/UX design

The butterfly is not just a visual element; it is the main interactive subject of the experience.

---

# Development Philosophy

Follow these principles:

## 1. Build incrementally

Do not attempt to create the entire project in one step.

Work in phases:

1. Project foundation
2. 3D environment setup
3. Butterfly integration
4. Animation and movement system
5. User interaction
6. UI implementation
7. Performance optimization
8. Final polish

After completing each phase:

* Test the implementation.
* Fix obvious issues.
* Continue to the next phase.

---

## 2. Avoid unnecessary complexity

Do not introduce technologies, libraries, or systems unless they provide clear value.

Prefer:

* Simple architecture
* Clear code
* Maintainability
* Performance

The goal is a beautiful and reliable experience, not a technically complicated demo.

---

# Technical Requirements

## 3D Engine

Use a modern WebGL-based solution.

Preferred stack:

* Three.js
* React Three Fiber (if using React)
* Drei helpers where appropriate

The implementation should support:

* GLB loading
* Animation playback
* Camera control
* Lighting
* Responsive rendering

---

# Butterfly Asset

The project uses an external GLB butterfly model.

Current asset:

* Format: GLB
* Type: Rigged animated 3D model
* Approximate complexity:

  * ~2.1k triangles
  * ~1.1k vertices

Available animations:

* Idle
* Flying

The model is created by:

* Artistic_side

License:

* Creative Commons Attribution (CC BY)

Required:

* Include proper attribution in the final application.

---

## Asset Rules

The butterfly model must be treated as a replaceable external asset.

Do not:

* Recreate the butterfly model from scratch.
* Modify the project architecture around a specific model.

The application should control:

* Movement
* Animation states
* Interaction
* Camera behavior
* Environment

through code.

Replacing the GLB file should not require rewriting the application.

---

# Performance Requirements

The experience should run smoothly in modern browsers.

Prioritize:

* Fast loading
* Low memory usage
* Smooth animation
* Responsive rendering

Consider:

* Asset optimization
* Efficient rendering loops
* Lazy loading when appropriate
* Mobile performance

Avoid unnecessary heavy effects.

---

# Code Quality Rules

Write production-quality code.

Requirements:

* Clean file organization
* Meaningful naming
* Reusable components
* Minimal duplication
* Clear comments only where necessary
* Avoid temporary hacks

Before adding a dependency, evaluate whether it is actually needed.

---

# User Experience Requirements

The experience should feel:

* Calm
* Natural
* Elegant
* Immersive

Avoid:

* Overcrowded interfaces
* Excessive controls
* Distracting animations

The butterfly should feel alive rather than like a simple animated object.

---

# Decision Making

When requirements are unclear:

1. Prefer the option that improves user experience.
2. Prefer simplicity.
3. Prefer solutions that keep future changes easy.
4. Do not stop progress because of minor uncertainty.

Only ask for clarification when a decision would significantly affect the architecture.

---

# Testing

After meaningful changes:

Verify:

* The application builds successfully.
* The 3D model loads correctly.
* Animations work.
* No console errors exist.
* Performance remains acceptable.

---

# Final Goal

Create a polished interactive butterfly web experience that feels like a complete product, not a technical experiment.

The final result should combine:

* Beautiful visuals
* Smooth interaction
* Clean engineering
* Strong user experience
* Maintainable architecture