// Tier 1 & Tier 2 Headless Simulation & Invariant Gate (penpen-gamePlus-skill §05)
// Run with: npx tsx tools/checks/sim-check.ts

import { FIXED_DT, GameEngine } from '../../src/game/engine';
import { dist } from '../../src/game/util';
import { computeVisibilityPolygon } from '../../src/game/visibility';
import { GENERATOR_POS, HIDEOUT_RECT, WORLD_HALF, resolveWorldCollision } from '../../src/game/world';
import { THOUGHT_GLOBAL_GAP, THOUGHT_MAX, THOUGHT_RISE, ThoughtSystem } from '../../src/game/thoughts';

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

  // 1b. Feedback-to-Gate：夜里钉死全部门板后，玩家仍须能从门外走进庇护所，怪物仍被完好门板阻挡
  {
    for (const b of engine.world.barricades) b.hp = b.maxHp;
    const doors = engine.world.barricades.filter((b) => b.kind === 'door');
    assert(doors.length > 0, 'Hideout must have at least one door');
    for (const d of doors) {
      const cx = d.x + d.w * 0.5;
      const cy = d.y + d.h * 0.5;
      // 门外法向：按门中心相对庇护所中心的方向
      const hx = HIDEOUT_RECT.x + HIDEOUT_RECT.w * 0.5;
      const hy = HIDEOUT_RECT.y + HIDEOUT_RECT.h * 0.5;
      const horiz = d.orientation === 'h';
      const ox = horiz ? 0 : Math.sign(cx - hx);
      const oy = horiz ? Math.sign(cy - hy) : 0;
      // 从门外 40px 逐步走到门内 40px（每步 3px，与真实移动相同的“约束最后”解算）
      let px = cx + ox * 40;
      let py = cy + oy * 40;
      let ex = px;
      let ey = py;
      for (let k = 0; k < 28; k++) {
        const pr = resolveWorldCollision(engine.world, px - ox * 3, py - oy * 3, 12, true, undefined, true);
        px = pr.x;
        py = pr.y;
        const er = resolveWorldCollision(engine.world, ex - ox * 3, ey - oy * 3, 12, false);
        ex = er.x;
        ey = er.y;
      }
      const playerInside = (px - cx) * ox + (py - cy) * oy < -20;
      const enemyOutside = (ex - cx) * ox + (ey - cy) * oy > 0;
      assert(playerInside, `Player locked out of hideout through boarded ${d.id}`);
      assert(enemyOutside, `Enemy walked through intact boarded ${d.id}`);
    }
    engine.reset(19847, true);
    console.log(`✓ Boarded-door entry gate passed (${doors.length} doors: player passes, enemies blocked)`);
  }

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

  // 9. 新增探针：Darkwood 式限时交互（按下开始、移动打断不结算、静止自动完成、钉板完成时才扣木材）
  {
    const idle = {
      mx: 0,
      my: 0,
      aimAngle: Math.PI * 0.5,
      sprint: false,
      attack: false,
      interact: false,
      toggleLight: false,
    };
    const walk = { ...idle, mx: 1 };

    engine.reset(19847, true);
    engine.enemies.length = 0; // 排除环境怪物干扰
    const box = engine.world.containers.find((c) => c.id === 'c_starter_backpack') ?? engine.world.containers[0];
    engine.player.x = box.x;
    engine.player.y = box.y - 26;
    engine.player.vx = 0;
    engine.player.vy = 0;
    engine.triggerInstantInteract();
    assert(
      engine.player.action.kind === 'search',
      `Pressing E near a container should start a timed search (got ${engine.player.action.kind})`
    );
    for (let i = 0; i < 18; i++) engine.step(FIXED_DT, 1280, 720, idle);
    assert(!box.searched, 'Timed search must not settle instantly');
    for (let i = 0; i < 6; i++) engine.step(FIXED_DT, 1280, 720, walk);
    assert(engine.player.action.kind === 'none', 'Movement should interrupt a timed search');
    assert(!box.searched && engine.containersLooted === 0, 'Interrupted search must not grant loot');

    engine.player.x = box.x;
    engine.player.y = box.y - 26;
    engine.player.vx = 0;
    engine.player.vy = 0;
    engine.triggerInstantInteract();
    let searchFrames = 0;
    while (!box.searched && searchFrames < 120) {
      engine.step(FIXED_DT, 1280, 720, idle);
      searchFrames++;
    }
    assert(box.searched && engine.containersLooted === 1, 'Uninterrupted timed search should complete within 2s');
    assert(searchFrames >= 50, `Timed search finished too fast (${searchFrames} frames)`);

    engine.reset(19847, true);
    engine.enemies.length = 0;
    const win = engine.world.barricades.find((b) => b.id === 'bar_north_win');
    assert(Boolean(win) && win!.hp < win!.maxHp, 'Expected damaged north window for barricade probe');
    if (win) {
      const woodBefore = engine.inv.wood;
      engine.player.x = win.x + win.w * 0.5;
      engine.player.y = win.y + win.h * 0.5 + 31;
      engine.player.vx = 0;
      engine.player.vy = 0;
      engine.triggerInstantInteract();
      assert(engine.player.action.kind === 'barricade', 'Pressing E at a damaged window should start nailing');
      for (let i = 0; i < 30; i++) engine.step(FIXED_DT, 1280, 720, idle);
      assert(engine.player.action.hitsDone >= 1, 'Nailing should land the first hammer hit within 0.5s');
      assert(engine.inv.wood === woodBefore && win.hp < win.maxHp, 'Wood must only be consumed when nailing completes');
      for (let i = 0; i < 90 && engine.player.action.kind !== 'none'; i++) engine.step(FIXED_DT, 1280, 720, idle);
      assert(
        win.hp === win.maxHp && engine.inv.wood === woodBefore - 2,
        `Completed nailing should repair window and cost 2 wood (hp=${win.hp}, wood=${engine.inv.wood})`
      );
    }
    console.log(`✓ Timed interaction gate passed (search ${searchFrames} frames, interrupt refunds, 3-hit nailing)`);
  }

  // 9b. 角色动作基线：真实位移驱动疾跑步态、火把火焰与交互收势不得脱相；动作打断保留有限状态。
  {
    engine.reset(19847, true);
    engine.enemies.length = 0;
    const startX = engine.player.x;
    const startY = engine.player.y;
    for (let i = 0; i < 45; i++) {
      engine.step(FIXED_DT, 1280, 720, {
        mx: 1,
        my: 0,
        aimAngle: 0,
        sprint: true,
        attack: false,
        interact: false,
        toggleLight: false,
      });
    }
    assert(engine.player.isSprinting, 'Sprint pilot should set the real sprint state');
    assert(engine.player.pose.sprint > 0.85, `Sprint pose blend did not settle: ${engine.player.pose.sprint}`);
    assert(engine.player.pose.gait >= 0 && engine.player.pose.gait <= 2, 'Sprint gait phase left 0..2 range');
    assert(dist(startX, startY, engine.player.x, engine.player.y) > 80, 'Sprint pilot should produce meaningful displacement');
    assert(
      Number.isFinite(engine.equip.flameH) &&
        Number.isFinite(engine.equip.flameStretch) &&
        engine.equip.torchInHand &&
        engine.equip.torchLit,
      'Held torch motion state became invalid during sprint'
    );
    for (let i = 0; i < 30; i++) engine.step(FIXED_DT, 1280, 720);
    assert(engine.player.pose.sprint < 0.15, `Sprint pose blend failed to settle after stopping: ${engine.player.pose.sprint}`);
    assert(
      Number.isFinite(engine.player.pose.move) &&
        Number.isFinite(engine.player.pose.action) &&
        Number.isFinite(engine.player.pose.gait),
      'Player pose produced NaN during sprint-to-stop transition'
    );
    console.log(
      `✓ Locomotion & held-torch motion gate passed (sprint=${engine.player.isSprinting}, gait=${engine.player.pose.gait.toFixed(2)}, flame=${engine.equip.flameH.toFixed(2)})`
    );
  }

  // 10. 新增探针：怪物攻击前摇（起手不扣血，前摇结束扑击才结算）
  {
    const idle = {
      mx: 0,
      my: 0,
      aimAngle: 0,
      sprint: false,
      attack: false,
      interact: false,
      toggleLight: false,
    };
    engine.reset(19847, true);
    const foe = engine.enemies[0];
    engine.enemies.length = 1;
    engine.player.x = 0;
    engine.player.y = 200;
    engine.player.vx = 0;
    engine.player.vy = 0;
    foe.x = 26;
    foe.y = 200;
    foe.vx = 0;
    foe.vy = 0;
    foe.attackCd = 0;
    foe.stalkTimer = 0;
    foe.state = 'chase';
    const hp0 = engine.player.hp;
    engine.step(FIXED_DT, 1280, 720, idle);
    assert(foe.windup > 0 && engine.player.hp === hp0, 'Enemy attack must begin with a wind-up (no instant damage)');
    let strikeFrames = 1;
    while (engine.player.hp === hp0 && strikeFrames < 45) {
      engine.step(FIXED_DT, 1280, 720, idle);
      strikeFrames++;
    }
    assert(engine.player.hp < hp0, 'Enemy strike should land after the wind-up when the player does not dodge');
    assert(strikeFrames >= 12, `Wind-up window too short for a dodge read (${strikeFrames} frames)`);
    console.log(`✓ Enemy wind-up gate passed (strike after ${strikeFrames} frames)`);
  }

  // 11. 新增探针：乌鸦生态（白昼 3–6 群落地；玩家靠近整群受惊起飞并离场回收）
  {
    const idle = {
      mx: 0,
      my: 0,
      aimAngle: 0,
      sprint: false,
      attack: false,
      interact: false,
      toggleLight: false,
    };
    engine.reset(19847, true);
    engine.enemies.length = 0;
    const flocks = engine.crowFlocks.filter((f) => f.active);
    assert(flocks.length >= 3 && flocks.length <= 6, `Expected 3-6 daytime crow flocks, got ${flocks.length}`);
    const fl = flocks[0];
    const fi = engine.crowFlocks.indexOf(fl);
    const members = () => engine.crows.filter((c) => c.active && c.flock === fi).length;
    const startCount = members();
    assert(startCount >= 2 && startCount <= 6, `Crow flock should hold 2-6 birds (got ${startCount})`);
    engine.player.x = fl.x + 60;
    engine.player.y = fl.y;
    engine.player.vx = 0;
    engine.player.vy = 0;
    engine.step(FIXED_DT, 1280, 720, idle);
    assert(fl.alarmed, 'Crow flock should be startled when the player comes within ~150px');
    for (let i = 0; i < 420; i++) engine.step(FIXED_DT, 1280, 720, idle);
    assert(members() === 0 && !fl.active, 'Startled crows should fly off screen and despawn');
    console.log(`✓ Crow ecology gate passed (${flocks.length} flocks, ${startCount} birds startled & despawned)`);
  }

  // 12. R3 新增探针：装备（右手火把 ⇄ 手枪）——切枪丢火把、地上火把燃烧、射击耗弹、空仓、换弹、E 捡回、火焰拖曳
  {
    // 面朝西（右手侧 = 南方，火把向远离庇护所的空地抛出）
    const idle = {
      mx: 0,
      my: 0,
      aimAngle: Math.PI,
      sprint: false,
      attack: false,
      interact: false,
      toggleLight: false,
    };
    engine.reset(19847, true);
    const foe = engine.enemies[0];
    engine.enemies.length = 1;
    foe.x = -900;
    foe.y = -900;
    foe.vx = 0;
    foe.vy = 0;
    engine.player.x = 0;
    engine.player.y = 200;
    engine.player.vx = 0;
    engine.player.vy = 0;
    engine.player.angle = Math.PI;
    const eq = engine.equip;
    assert(eq.mode === 'torch' && eq.torchInHand && eq.torchLit, 'Player should start with a lit torch in the right hand');

    // 切枪：侧身甩手丢火把 → 抛物线落地弹一下 → 拔枪
    assert(engine.toggleWeapon(), 'Q should start the drop-torch / draw-pistol gesture');
    for (let i = 0; i < 90; i++) engine.step(FIXED_DT, 1280, 720, idle);
    assert(eq.mode === 'pistol' && !eq.torchInHand && eq.gesture === 'none', 'Swap should end in pistol mode with torch dropped');
    const gt = eq.groundTorches.find((t) => t.active);
    assert(Boolean(gt), 'Dropped torch must become a ground torch entity');
    if (gt) {
      assert(!gt.airborne && gt.z === 0 && gt.bounces >= 1, 'Dropped torch should land (and bounce) within 1.5s');
      assert(gt.lit && gt.flameH > 0.3, `Ground torch should keep burning (flameH=${gt.flameH.toFixed(2)})`);
      assert(dist(gt.x, gt.y, engine.player.x, engine.player.y) < 150, 'Torch should land beside the player');
    }

    // 射击：消耗 1 发、高伤害
    foe.x = engine.player.x - 90;
    foe.y = engine.player.y;
    foe.vx = 0;
    foe.vy = 0;
    foe.hp = 200;
    foe.maxHp = 200;
    foe.windup = 0;
    const mag0 = eq.mag;
    const ammo0 = engine.inv.ammo;
    assert(engine.fireWeapon(), 'Pistol should fire with a loaded magazine');
    assert(eq.mag === mag0 - 1 && engine.inv.ammo === ammo0, `Shot should consume exactly one chambered round (mag ${mag0}->${eq.mag})`);
    assert(foe.hp <= 200 - 60, `Pistol hit should deal heavy damage (hp=${foe.hp})`);
    engine.enemies.length = 0;

    // 空仓：扣扳机只有空响，不消耗备弹
    for (let i = 0; i < 25; i++) engine.step(FIXED_DT, 1280, 720, idle);
    eq.mag = 0;
    const dry0 = eq.dryFires;
    const ammo1 = engine.inv.ammo;
    assert(!engine.fireWeapon(), 'Empty magazine must not fire');
    assert(eq.dryFires === dry0 + 1 && engine.inv.ammo === ammo1 && eq.mag === 0, 'Dry fire should click without consuming reserve');

    // 换弹：从备弹装填，完成时才结算
    engine.inv.ammo = 4;
    assert(engine.reloadWeapon() && eq.gesture === 'reload', 'R should start a reload gesture');
    for (let i = 0; i < 20; i++) engine.step(FIXED_DT, 1280, 720, idle);
    assert(eq.mag === 0 && engine.inv.ammo === 4, 'Reload must not transfer rounds before the magazine is seated');
    for (let i = 0; i < 70; i++) engine.step(FIXED_DT, 1280, 720, idle);
    assert(eq.mag === 4 && engine.inv.ammo === 0, `Reload should move reserve into magazine (mag=${eq.mag}, ammo=${engine.inv.ammo})`);

    // E 捡回火把 → 自动切回火把模式
    if (gt) {
      engine.player.x = gt.x;
      engine.player.y = gt.y - 20;
      engine.player.vx = 0;
      engine.player.vy = 0;
      engine.triggerInstantInteract();
      assert(eq.gesture === 'pickup', 'Pressing E near the ground torch should start the pickup gesture');
      for (let i = 0; i < 40; i++) engine.step(FIXED_DT, 1280, 720, idle);
      assert(eq.mode === 'torch' && eq.torchInHand && !gt.active, 'Torch should be picked back up and re-equipped');
    }

    // 火焰物理：向西（-x）行走时火焰向运动反方向（+x）拖曳
    const walkX = { ...idle, mx: -1 };
    let flameSum = 0;
    for (let i = 0; i < 40; i++) {
      engine.step(FIXED_DT, 1280, 720, walkX);
      if (i >= 25) flameSum += eq.flameX;
    }
    const flameAvg = flameSum / 15;
    assert(flameAvg > 1.0, `Torch flame should trail behind while walking (avg offset=${flameAvg.toFixed(2)})`);
    console.log(
      `✓ Equipment gate passed (torch drop/land/burn, shot dmg, dry fire, reload ${eq.mag}/${engine.inv.ammo}, pickup, flame drag ${flameAvg.toFixed(
        2
      )}px)`
    );
  }

  // 12. 新增探针：超自然异象（雨天跳舞幽灵出现次数合理、只在近处显形、永不伤害；砸桌只做渲染偏移不改碰撞；全程无 NaN）
  {
    const hs = engine.haunts;
    engine.reset(19847, true);
    const pilotH = engine.createPilot();
    let farVisible = 0;
    for (let i = 0; i < 120 * 60; i++) {
      if (i % (40 * 60) === 0) engine.jumpWeather('drizzle'); // 保持 120s 雨天
      engine.enemies.length = 0; // 排除怪物干扰，只观察异象
      engine.step(FIXED_DT, 1280, 720, pilotH(engine.simTime));
      const g = hs.dance;
      if (g.alpha > 0.001 && dist(engine.player.x, engine.player.y, g.x, g.y) > 201) farVisible++;
      assert(
        Number.isFinite(g.alpha) &&
          Number.isFinite(g.x) &&
          Number.isFinite(g.y) &&
          Number.isFinite(hs.level) &&
          Number.isFinite(hs.table.offX) &&
          Number.isFinite(hs.table.offY) &&
          Number.isFinite(hs.apparition.alpha),
        `HauntSystem produced NaN at step ${i}`
      );
      if (engine.mode !== 'play') break;
    }
    const danceSpawns = hs.dance.spawnCount;
    const danceSeen = hs.dance.seenCount;
    assert(farVisible === 0, `Dancing ghost must only manifest near the player (visible beyond 200px on ${farVisible} steps)`);
    assert(danceSpawns >= 1 && danceSpawns <= 12, `Rainy 120s should manifest the dancing ghost 1-12 times (spawn=${danceSpawns})`);
    assert(danceSeen <= 6, `Dancing ghost seen too often in 120s rain (seen=${danceSeen}, cooldown 25-60s)`);

    // 永不伤害：近处放置跳舞幽灵，只推进异象系统 4s，玩家 hp / 坐标不变，且确实显形
    engine.reset(19847, true);
    hs.update(engine, FIXED_DT, 1280, 720); // 绑定新 world
    engine.player.x = 0;
    engine.player.y = 200;
    engine.player.vx = 0;
    engine.player.vy = 0;
    const hpH = engine.player.hp;
    hs.debugPlaceDance(45, 200);
    for (let i = 0; i < 240; i++) hs.update(engine, FIXED_DT, 1280, 720);
    assert(
      engine.player.hp === hpH && engine.player.x === 0 && engine.player.y === 200,
      'Haunts must never damage or move the player'
    );
    assert(hs.dance.seenCount >= 1, `Dancing ghost 45px away should manifest (alpha=${hs.dance.alpha.toFixed(2)})`);

    // 砸桌：桌子只做渲染偏移，碰撞数据（墙体/家具矩形与碰撞解算结果）完全不变
    engine.reset(19847, true);
    hs.update(engine, FIXED_DT, 1280, 720);
    const tb = hs.table;
    assert(tb.source !== 'none', 'Table haunt should resolve a table (building / movable / fallback)');
    const wallSnap = engine.world.walls.map((w) => `${w.id}:${w.x},${w.y},${w.w},${w.h}`).join('|');
    const movSnap = engine.world.movables.map((m) => `${m.id}:${m.x},${m.y},${m.w},${m.h}`).join('|');
    const probe0 = resolveWorldCollision(engine.world, tb.seatX, tb.seatY, 12, true);
    const away = Math.hypot(tb.seatX, tb.seatY) || 1;
    engine.player.x = tb.seatX - (tb.seatX / away) * 700;
    engine.player.y = tb.seatY - (tb.seatY / away) * 700;
    engine.player.flashlightOn = false;
    assert(hs.debugPrimeTable(), 'debugPrimeTable() should arm the table haunt');
    let maxOff = 0;
    for (let i = 0; i < 600; i++) {
      hs.update(engine, FIXED_DT, 1280, 720);
      maxOff = Math.max(maxOff, Math.abs(tb.offX), Math.abs(tb.offY));
    }
    const probe1 = resolveWorldCollision(engine.world, tb.seatX, tb.seatY, 12, true);
    assert(tb.bangCount >= 2, `Table haunt should bang periodically (bangs=${tb.bangCount} in 10s)`);
    assert(maxOff > 0.8 && maxOff <= 3.2, `Table render jitter should be ~2-3px (max=${maxOff.toFixed(2)})`);
    assert(
      engine.world.walls.map((w) => `${w.id}:${w.x},${w.y},${w.w},${w.h}`).join('|') === wallSnap &&
        engine.world.movables.map((m) => `${m.id}:${m.x},${m.y},${m.w},${m.h}`).join('|') === movSnap &&
        probe0.x === probe1.x &&
        probe0.y === probe1.y,
      'Table banging must not alter collision data'
    );
    // 走到她身后：停止砸桌（抬头或消失）
    engine.player.x = tb.seatX - Math.cos(tb.faceAngle) * 34;
    engine.player.y = tb.seatY - Math.sin(tb.faceAngle) * 34;
    for (let i = 0; i < 30; i++) hs.update(engine, FIXED_DT, 1280, 720);
    assert(tb.interruptCount >= 1 && tb.phase !== 'banging', `Approaching the woman should stop the banging (phase=${tb.phase})`);
    console.log(
      `✓ Haunt gate passed (rain 120s: dance spawn=${danceSpawns} seen=${danceSeen}, apparitions=${hs.apparition.count}; table[${tb.source}${
        tb.name ? ' ' + tb.name : ''
      }] bangs=${tb.bangCount} jitter=${maxOff.toFixed(2)}px, collision unchanged)`
    );
  }

  // 13. 新增探针：内心独白浮字（同句冷却 ≥90s、全局间隔 ≥6s、同显 ≤2 且 FIFO 顶替、包络无 NaN；engine 接入）
  {
    const th = new ThoughtSystem();
    th.reset(7);
    const A = '树在低语，听起来如此平静……';
    const B = '这里的空气不对劲。';
    const C = '我的腿快撑不住了。';
    assert(th.think(A) && th.activeCount() === 1, 'think() should show the first thought immediately');
    assert(!th.think(A), 'Same thought must be rejected while showing / within its 90s cooldown');
    th.think(B); // 6s 全局间隔内：进入等待队列
    let maxActive = 0;
    let shown = th.shownCount;
    let lastStart = th.lastShowAt;
    let minGap = 1e9;
    let badEnv = 0;
    let rejectedAt30 = false;
    for (let i = 0; i < 100 * 60; i++) {
      if (i === 30 * 60) rejectedAt30 = !th.think(A);
      th.tick(FIXED_DT);
      if (th.shownCount !== shown) {
        minGap = Math.min(minGap, th.lastShowAt - lastStart);
        lastStart = th.lastShowAt;
        shown = th.shownCount;
      }
      maxActive = Math.max(maxActive, th.activeCount());
      for (const it of th.items) {
        if (!Number.isFinite(it.alpha) || !Number.isFinite(it.rise)) badEnv++;
        else if (it.alpha < 0 || it.alpha > 1 || it.rise < 0 || it.rise > THOUGHT_RISE + 1e-6) badEnv++;
      }
    }
    assert(rejectedAt30, 'Same thought must stay on cooldown 30s later (cooldown >= 90s)');
    assert(th.shownCount === 2, `Queued thought should surface once the global gap elapses (shown=${th.shownCount})`);
    assert(minGap >= THOUGHT_GLOBAL_GAP - 1e-6, `Two thoughts started only ${minGap.toFixed(3)}s apart (< 6s)`);
    assert(badEnv === 0, `Thought envelope produced NaN / out-of-range values (${badEnv})`);
    assert(th.activeCount() === 0, 'Thoughts should fully fade out after their lifetime');
    assert(th.think(A) && th.shownCount === 3, 'Same thought should be allowed again after 90s');
    // 队列上限与 FIFO：强制塞入 3 条，同显不超过 2，最旧一条被顶替
    th.debugForce(B);
    th.debugForce(C);
    maxActive = Math.max(maxActive, th.activeCount());
    let oldestStill = false;
    for (const it of th.items) if (it.active && it.key === A) oldestStill = true;
    assert(maxActive <= THOUGHT_MAX && th.activeCount() === THOUGHT_MAX, `At most ${THOUGHT_MAX} thoughts may show at once`);
    assert(!oldestStill, 'A third thought should replace the oldest one (FIFO)');

    // engine 接入：think() 冷却生效；10s 自动驾驶内队列不越界、无 NaN
    engine.reset(19847, true);
    const tE = engine.thoughts;
    assert(engine.think('灯灭了。黑暗在靠近。'), 'engine.think() should accept a fresh thought');
    assert(!engine.think('灯灭了。黑暗在靠近。'), 'engine.think() must honour the per-line cooldown');
    const pilotT = engine.createPilot();
    for (let i = 0; i < 10 * 60; i++) {
      engine.enemies.length = 0;
      engine.step(FIXED_DT, 1280, 720, pilotT(engine.simTime));
      assert(tE.activeCount() <= THOUGHT_MAX, 'Engine thought queue exceeded its display limit');
      for (const it of tE.items) assert(Number.isFinite(it.alpha) && Number.isFinite(it.rise), `Thought NaN at step ${i}`);
      if (engine.mode !== 'play') break;
    }
    console.log(
      `✓ Thought gate passed (cooldown 90s, gap ${minGap.toFixed(2)}s, max ${maxActive} on screen, FIFO replace, engine shown=${tE.shownCount})`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
