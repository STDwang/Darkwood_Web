// Tier 1 & Tier 2 Headless Simulation & Invariant Gate (penpen-gamePlus-skill §05)
// Run with: npx tsx tools/checks/sim-check.ts

import { FIXED_DT, GameEngine } from '../../src/game/engine';
import { dist } from '../../src/game/util';
import { computeVisibilityPolygon } from '../../src/game/visibility';
import { GENERATOR_POS, HIDEOUT_RECT, WORLD_HALF, resolveWorldCollision } from '../../src/game/world';

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

  // 6. T2.1 永久探针：可拖拽重型家具移动与防穿墙碰撞断言
  engine.reset(19847, true);
  assert(engine.world.movables.length >= 3, 'Expected at least 3 movable furniture pieces in Hideout');
  const sofa = engine.world.movables.find((m) => m.kind === 'sofa');
  assert(Boolean(sofa), 'Expected sofa movable furniture');
  if (sofa) {
    const initX = sofa.x;
    const initY = sofa.y;
    // 将玩家移动到沙发旁并按 E 抓取
    engine.player.x = sofa.x + sofa.w + 18;
    engine.player.y = sofa.y + sofa.h * 0.5;
    engine.player.angle = Math.PI; // 面向沙发
    engine.triggerInstantInteract();
    assert(engine.draggedFurnitureId === sofa.id, 'Pressing E near sofa should start dragging');

    // 向西墙方向持续移动 1.5s，验证家具随动且不会穿入西墙（HIDEOUT_RECT.x + 18）
    for (let i = 0; i < 90; i++) {
      engine.step(FIXED_DT, 1280, 720, {
        mx: -1,
        my: 0,
        aimAngle: Math.PI,
        sprint: true,
        attack: false,
        interact: false,
        toggleLight: false,
      });
    }
    const movedDist = dist(initX, initY, sofa.x, sofa.y);
    assert(movedDist > 2, `Dragged sofa did not move meaningfully (${movedDist.toFixed(2)}px)`);
    assert(
      sofa.x >= HIDEOUT_RECT.x + 17.5,
      `Dragged sofa penetrated west wall: sofa.x=${sofa.x.toFixed(2)} < ${HIDEOUT_RECT.x + 18}`
    );
    // 再按 E 松开家具
    engine.triggerInstantInteract();
    assert(engine.draggedFurnitureId === null, 'Pressing E again should drop dragged furniture');
    console.log(
      `✓ Movable furniture drag & anti-clipping gate passed (shift=${movedDist.toFixed(1)}px, x=${sofa.x.toFixed(1)})`
    );
  }

  // 7. T2.2 永久探针：闪避无敌帧消耗体力 + 蓄力重击伤害提升断言
  engine.reset(19847, true);
  const staminaBeforeDodge = engine.player.stamina;
  const dodged = engine.triggerDodge(1, 0);
  assert(dodged, 'triggerDodge() should succeed with full stamina');
  assert(
    engine.player.stamina <= staminaBeforeDodge - 27.5,
    `Dodge should consume 28 stamina (before=${staminaBeforeDodge}, after=${engine.player.stamina})`
  );
  assert(engine.player.dodgeInvuln > 0.15, `Dodge should grant invulnerability frames (${engine.player.dodgeInvuln})`);

  // 验证无敌帧期间贴脸怪物攻击不扣血
  const hpBeforeHit = engine.player.hp;
  const testEnemy = engine.enemies[0];
  assert(Boolean(testEnemy), 'Expected ambient enemy for combat probe');
  testEnemy.x = engine.player.x + 18;
  testEnemy.y = engine.player.y;
  testEnemy.attackCd = 0;
  testEnemy.stalkTimer = 0;
  testEnemy.state = 'chase';
  engine.step(FIXED_DT, 1280, 720);
  assert(engine.player.hp === hpBeforeHit, 'Player should take 0 damage during dodge invulnerability frames');

  // 对比轻快横扫 vs 蓄力重击伤害提升
  engine.reset(19847, true);
  const eLight = engine.enemies[0];
  engine.player.x = 0;
  engine.player.y = 200; // 室外开阔处，确保无遮挡视线
  engine.player.angle = 0;
  eLight.x = 38;
  eLight.y = 200;
  eLight.hp = 200;
  eLight.maxHp = 200;
  const hpStartLight = eLight.hp;
  engine.triggerAttack(false);
  const lightDmg = hpStartLight - eLight.hp;

  engine.reset(19847, true);
  const eHeavy = engine.enemies[0];
  engine.player.x = 0;
  engine.player.y = 200;
  engine.player.angle = 0;
  eHeavy.x = 38;
  eHeavy.y = 200;
  eHeavy.hp = 200;
  eHeavy.maxHp = 200;
  const hpStartHeavy = eHeavy.hp;
  engine.triggerAttack(true);
  const heavyDmg = hpStartHeavy - eHeavy.hp;

  assert(
    lightDmg > 0 && heavyDmg > lightDmg * 1.6,
    `Charged heavy attack damage (${heavyDmg}) should be significantly higher than light (${lightDmg})`
  );
  console.log(
    `✓ Dodge invuln & charged heavy attack gate passed (lightDmg=${lightDmg}, heavyDmg=${heavyDmg})`
  );

  // 8. T2.3 永久探针：3 件信号中继零件拾取 → 发电机安装 → 破晓触发 mode === 'victory' 闭环断言
  engine.reset(19847, true);
  assert(engine.world.relayNodes.length === 3, `Expected 3 relay nodes, got ${engine.world.relayNodes.length}`);
  for (const rn of engine.world.relayNodes) {
    // 校验零件节点与静态几何零重叠
    const res = resolveWorldCollision(engine.world, rn.x, rn.y, 12, true);
    const shift = dist(rn.x, rn.y, res.x, res.y);
    assert(shift < 18, `Relay node ${rn.id} overlaps solid geometry by ${shift.toFixed(1)}px`);

    // 靠近并拾取零件
    engine.player.x = rn.x;
    engine.player.y = rn.y + 12;
    engine.triggerInstantInteract();
    assert(rn.collected, `Failed to collect relay node ${rn.id}`);
  }
  assert(engine.inv.relayParts === 3, `Expected 3 collected relayParts, got ${engine.inv.relayParts}`);

  // 返回庇护所发电机旁安装 3 件零件
  engine.player.x = GENERATOR_POS.x + 28;
  engine.player.y = GENERATOR_POS.y + 24;
  for (let i = 0; i < 3; i++) {
    engine.triggerInstantInteract();
  }
  assert(engine.relayInstalled === 3, `Expected relayInstalled === 3, got ${engine.relayInstalled}`);
  assert(engine.inv.relayParts === 0, `Expected relayParts === 0 after install, got ${engine.inv.relayParts}`);

  // 推进至破晓，触发通关结算
  engine.dayTime = 0.999;
  engine.step(FIXED_DT * 20, 1280, 720);
  assert(engine.mode === 'victory', `Expected mode === 'victory' at dawn with 3/3 relays, got ${engine.mode}`);

  // 验证选择无尽模式后恢复游玩且下次破晓不再重复弹窗
  engine.continueEndless();
  assert(engine.mode === 'play' && engine.endlessMode, 'continueEndless() should resume play in endless mode');
  engine.dayTime = 0.999;
  engine.step(FIXED_DT * 20, 1280, 720);
  assert(engine.mode === 'play', `Endless mode should not re-trigger victory at next dawn (got ${engine.mode})`);
  console.log('✓ 3-Part Relay collection -> install -> Dawn Victory & Endless mode gate passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
