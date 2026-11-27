# Architecture & Automated QA Gates (`Blackwood Ember`)

This document explains how `Blackwood Ember` achieves a **369 KB offline WebGL2 survival-horror engine** without Unity/Godot/Phaser, and how its **automated Playwright + simulation gates** prevent AI-assisted coding sessions from introducing visual or physics regressions.

---

## 1. High-Level Module Map (Single Source of Truth)

To avoid state drift between physics, visibility, rendering, and UI, every degree of freedom has exactly **one authoritative owner**:

```text
src/
├── game/
│   ├── world.ts          # Static world geometry (walls, buildings, trees, hideout bounds)
│   ├── engine.ts         # Fixed-timestep (1/60s) simulation: player, AI, combat, barricades, weather
│   ├── visibility.ts     # 2D raycast visibility polygon & line-of-sight occlusion
│   ├── webglComposer.ts  # Custom WebGL2 deferred normal-mapped lighting & ACES Filmic post-processing
│   ├── renderer.ts       # Layered scene drawing, top-down tree parallax, rain/embers & Canvas2D fallback
│   ├── textures.ts       # Procedural offscreen canvas textures & normal maps (zero external PNGs)
│   ├── audio.ts          # Procedural Web Audio synthesizer (rain, footsteps by material, monster foley)
│   ├── variants.ts       # Runtime A/B switch registry (?v-shader, ?v-palette, ?v-vision, ?v-cine...)
│   └── runtime.ts        # Decoupled UI bridge & deterministic step hooks for headless QA
└── components/
    ├── GameHud.tsx       # Minimalist diegetic HUD
    └── Minimap.tsx       # Fog-of-war exploration minimap
```

### Strict Ownership Rules
- `renderer.ts` and `webglComposer.ts` are **strictly read-only** consumers of `engine.ts` and `world.ts`. They never mutate coordinates, spawn camera spring lag, or invent shadow geometry.
- Every displacement (movement, dodge roll, melee knockback, furniture dragging) ends with a single unified `resolveWorldCollision()` pass (`Constraints Last`), guaranteeing zero wall clipping and zero corner soft-locks.

---

## 2. Core Graphics & Visibility Techniques

1. **Dual Visibility Law (`visibility.ts`)**
   - Wall segments and dynamic barricades/furniture feed into the same occlusion list.
   - Inside the player's narrow flashlight cone (`31°` default), full lighting and entities render.
   - Outside the cone, explored terrain persists as low-contrast cold-gray memory while dynamic monsters remain invisible unless revealed by lightning flashes, traps, or sound ripples.
2. **Zero-Asset Procedural PBR-Lite (`textures.ts` + `webglComposer.ts`)**
   - Ground moss, cracked floorboards, rotten bark, and puddle specular masks are procedurally baked into offscreen canvases at boot—keeping the entire zipped build down to **369 KB**.
   - Light accumulation is clamped to finite ranges before ACES Filmic tone mapping to prevent `NaN`/`Inf` black-box artifacts on mobile GPUs.

---

## 3. Automated "Art Director + QA" Gate Pipeline (`tools/checks/`)

A major problem in AI-assisted game development is **silent regression**: asking an LLM to tweak lighting or UI often breaks contrast, blows up draw calls, or causes subtle wall-clipping bugs.

We solved this by codifying design invariants ([DESIGN_INVARIANTS.md](../DESIGN_INVARIANTS.md)) into automated scripts:

| Gate Script | What It Verifies | Latest Release v1 Baseline |
| :--- | :--- | :--- |
| `npm run check:sim` | 7,200-frame headless simulation (combat, i-frames, furniture collision, extraction) | `p50=0.021ms`, `p95=0.112ms`, 0 `NaN`/clipping |
| `npm run check:smoke` | WebGL2 + Canvas2D boot, 0 console errors, 0 `404`s, 0 external CDN calls | `drawCalls=158` (budget ≤ 180) |
| `npm run check:layout` | 4 viewports (desktop + mobile) × 2 states, touch targets ≥ 44px, zero overlap | All pass |
| `npm run check:layer` | 5 modal stacks × 4 exit paths (button / backdrop / `Esc` / `popstate`) | All pass |
| `npm run check:palette` | Automated luminance `L`, dark-ratio, and chroma check across 4 camera shots | 4/4 shots within target envelopes |
| `npm run check:perf` | 1x & 2x CPU throttled 1,200-frame benchmark | 0 frames > `16.7ms` |
| `npm run check:shotdiff` | Deterministic pixel diff across A/B visual variants (`?v-palette=a\|b`) | Baseline noise `0.000%` |
