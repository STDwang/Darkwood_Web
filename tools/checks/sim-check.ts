// Tier 1 & Tier 2 Headless Simulation & Invariant Gate (penpen-gamePlus-skill §05)
// Run with: npx tsx tools/checks/sim-check.ts

import { FIXED_DT, GameEngine } from '../../src/game/engine';
import { dist } from '../../src/game/util';
import { computeVisibilityPolygon } from '../../src/game/visibility';
import { WORLD_HALF, resolveWorldCollision } from '../../src/game/world';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
}

async function main() {
  const engine = new GameEngine(19847);
  engine.reset(19847, true);

  // 1. World reachability & clearance invariant
  for (const c of engine.world.containers) {
    const resolved = resolveWorldCollision(engine.world, c.x, c.y, 12, true);
    const shift = dist(c.x, c.y, resolved.x, resolved.y);
    assert(shift < 22, `Container ${c.id} overlaps solid geometry by ${shift.toFixed(1)}px`);
  }
  console.log(`✓ Clearance gate passed (${engine.world.containers.length} loot containers verified)`);

  // 2. Visibility polygon stability across 360° & directional cones
  const poly: { x: number; y: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2 - Math.PI;
    computeVisibilityPolygon(engine.world, 0, 25, 435, poly, ang, 0.54);
    assert(poly.length >= 16, `Cone visibility polygon too sparse (${poly.length})`);
    for (const pt of poly) {
      assert(Number.isFinite(pt.x) && Number.isFinite(pt.y), 'NaN vertex in visibility polygon');
    }
  }
  console.log('✓ Raycast 2D visibility polygon gate passed');

  // 3. Weather storm, lightning, wetness & roof cutaway convergence check
  engine.jumpWeather('storm');
  assert(engine.weather.lightningFlash > 0.5, 'Storm jump should trigger initial lightning flash');
  const startRoofAlpha = engine.hideoutRoofAlpha;
  engine.player.x = 0;
  engine.player.y = 220; // step outdoors
  for (let i = 0; i < 45; i++) engine.step(FIXED_DT, 1280, 720);
  assert(
    engine.hideoutRoofAlpha > startRoofAlpha + 0.5,
    `Hideout roof failed to fade in outdoors (${engine.hideoutRoofAlpha.toFixed(2)})`
  );
  console.log(
    `✓ Weather & Roof Cutaway gate passed (wetness=${engine.weather.wetness.toFixed(
      2
    )}, outdoorRoofAlpha=${engine.hideoutRoofAlpha.toFixed(2)})`
  );

  // 4. 120-second headless pilot soak test + JS frame time budget (p50 / p95)
  engine.reset(19847, true);
  const pilot = engine.createPilot();
  const totalSteps = 120 * 60;
  const times: number[] = [];

  for (let i = 0; i < totalSteps; i++) {
    const t0 = performance.now();
    const inp = pilot(engine.simTime);
    engine.step(FIXED_DT, 1280, 720, inp);
    const dtMs = performance.now() - t0;
    times.push(dtMs);

    assert(
      Number.isFinite(engine.player.x) && Number.isFinite(engine.player.y),
      `Player position became NaN at step ${i}`
    );
    assert(
      Math.abs(engine.player.x) <= WORLD_HALF && Math.abs(engine.player.y) <= WORLD_HALF,
      `Player exited world bounds at step ${i}`
    );
    if (engine.mode === 'dead') break;
  }

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const maxMs = times[times.length - 1];

  console.log(
    `✓ Soak & Perf gate: ${times.length} frames · p50=${p50.toFixed(3)}ms · p95=${p95.toFixed(
      3
    )}ms · max=${maxMs.toFixed(2)}ms · looted=${engine.containersLooted} · decals=${
      engine.pendingDecals.length
    } · journal=${engine.journal.length}`
  );

  assert(p95 < 4.0, `JS frame p95 exceeded 4ms budget: ${p95.toFixed(3)}ms`);
  assert(engine.containersLooted >= 1, 'Autopilot failed to scavenge any container in 120s');
  assert(engine.pendingDecals.length >= 1, 'Expected persistent decals to be emitted during wet play');

  // 5. Crafting & time-of-day state machine check
  engine.reset(19847, true);
  assert(engine.craft('bandage'), 'Crafting bandage with starting herbs should succeed');
  engine.jumpTimeOfDay('night');
  assert(engine.phase === 'night', 'jumpTimeOfDay("night") failed');
  assert(engine.journal.length >= 1, 'Field journal should initialize with Day 1 entry');
  console.log('✓ Crafting, Journal & Day/Dusk/Night state machine gate passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
