// Core simulation engine for Blackwood Ember
// Enforces penpen-gamePlus-skill invariants:
// 1. Single Source of Truth (world.ts geometry shared with physics & visibility)
// 2. One Clock, No Stacked Springs (fixed dt = 1/60, single expDecay camera & roof cutaway)
// 3. Constraints Last (resolveWorldCollision runs after all displacements/knockback)
// 4. Single Budget Ledger (unified speed & lighting calculations)
// 5. Headless window.__game test contract with sim(), noDraw(), pilot()

import { AudioFX } from './audio';
import { I18n } from './i18n';
import { Quality } from './quality';
import {
  ActiveFlare,
  BarricadeSlot,
  BearTrap,
  DecalEvent,
  Enemy,
  EnemyKind,
  Footprint,
  GameMode,
  HudSnapshot,
  InteractPrompt,
  Inventory,
  JournalEntry,
  LootContainer,
  MovableFurniture,
  Particle,
  PilotInput,
  RainDrop,
  RainRipple,
  RelayNode,
  ResourceKey,
  SoundRipple,
  TimePhase,
  ToastMessage,
  WeatherKind,
  WeatherState,
} from './types';
import {
  LiveRing,
  Vec2,
  angleDiff,
  clamp,
  createRng,
  dist,
  expDecay,
  resolveCircleRect,
  wrapAngle,
} from './util';
import { Variants } from './variants';
import { hasLineOfSight } from './visibility';
import {
  CAMPFIRE_POS,
  CRAFT_RECIPES,
  GENERATOR_POS,
  HIDEOUT_BRAZIER_POS,
  HIDEOUT_RECT,
  HIDEOUT_STOVE_POS,
  SHELTER_LAMPS,
  WORKBENCH_POS,
  WORLD_HALF,
  WorldData,
  createWorld,
  getSurfaceAt,
  getZoneNameAt,
  isPointInHideout,
  resolveFurnitureCollision,
  resolveWorldCollision,
} from './world';

export const FIXED_DT = 1 / 60;
const CYCLE_SECONDS = 190; // 90s day + 25s dusk + 75s night
const DAY_END = 90 / CYCLE_SECONDS;
const DUSK_END = 115 / CYCLE_SECONDS;

const RESOURCE_LABELS: Record<ResourceKey, string> = {
  wood: '木材',
  scrap: '废铁',
  fuel: '燃油',
  herbs: '布草',
  battery: '电池',
  essence: '幽光菇',
};

export const SAWMILL_ROOF_RECT = { x: 620, y: -610, w: 220, h: 230 };

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  angle: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  battery: number;
  flashlightOn: boolean;
  flickerVal: number;
  swingTimer: number;
  swingDuration: number;
  swingCd: number;
  swingDir: number;
  hitFlash: number;
  stepDist: number;
  leftFoot: boolean;
  walkPhase: number;
  breathePhase: number;
  searchingId: string | null;
  searchProgress: number;
  // 蓄力重击与闪避急退状态
  isCharging: boolean;
  chargeTimer: number;
  dodgeTimer: number;
  dodgeInvuln: number;
  dodgeCd: number;
  dodgeDirX: number;
  dodgeDirY: number;
}

export class GameEngine {
  world: WorldData;
  mode: GameMode = 'title';
  simTime = 0;
  day = 1;
  dayTime = 0.08;
  phase: TimePhase = 'day';
  generatorFuel = 58;
  generatorOn = true;

  // Dynamic Weather State Machine
  weather: WeatherState = {
    kind: 'drizzle',
    rainIntensity: 0.45,
    wetness: 0.42,
    lightningFlash: 0,
    lightningAngle: -0.6,
    windAngle: 1.78,
  };
  private weatherTimer = 42;
  private lightningCd = 14;
  private thunderQueue: Array<{ delay: number; intensity: number }> = [];

  // Roof cutaway alphas (0 = transparent indoors, 1 = opaque roof outdoors)
  hideoutRoofAlpha = 0;
  sawmillRoofAlpha = 1;

  // Persistent world decal queue drained by renderer into offscreen Decal FBO
  pendingDecals: DecalEvent[] = [];
  decalResetCounter = 0;

  // Parchment Field Journal
  discoveredZones = new Set<string>(['庇护所']);
  journal: JournalEntry[] = [];
  private nextJournalId = 1;

  player: PlayerState;
  inv: Inventory;
  activeSlot = 0;

  enemies: Enemy[] = [];
  traps: BearTrap[] = [];
  flares: ActiveFlare[] = [];
  toasts: ToastMessage[] = [];

  particles: LiveRing<Particle>;
  ripples: LiveRing<SoundRipple>;
  footprints: LiveRing<Footprint>;
  rainDrops: LiveRing<RainDrop>;
  rainRipples: LiveRing<RainRipple>;

  // Camera (One Clock — single exponential follower + decaying trauma shake)
  camX = 0;
  camY = 20;
  camLockX: number | null = null;
  camLockY: number | null = null;
  shake = 0;
  shakeOffsetX = 0;
  shakeOffsetY = 0;
  hitStop = 0;

  // Input state
  keys = new Set<string>();
  mouseScreenX = 0;
  mouseScreenY = 0;
  mouseDownLeft = false;
  touchMoveX = 0;
  touchMoveY = 0;
  touchAimX = 0;
  touchAimY = 0;
  touchAimActive = false;
  touchSprint = false;
  touchInteract = false;

  // Stats & counters
  containersLooted = 0;
  enemiesDefeated = 0;
  essenceCollected = 0;
  dangerLevel = 0;
  draggedFurnitureId: string | null = null;
  relayInstalled = 0;
  endlessMode = false;
  backendName: 'webgl2' | 'canvas2d' = 'webgl2';
  fps = 60;

  private rng = createRng(19847);
  private nextEntityId = 1;
  private nextToastId = 1;
  private spawnTimer = 4;
  private sporeTimer = 0;
  private emberTimer = 0;
  private rainSpawnAccum = 0;
  private openerHookTriggered = false;
  private currentPrompt: InteractPrompt | null = null;
  private onOpenWorkbench: (() => void) | null = null;
  private hudSubscribers = new Set<(snap: HudSnapshot) => void>();
  private hudAccum = 0;

  constructor(seed = 19847) {
    this.world = createWorld(seed);
    this.particles = new LiveRing<Particle>(420, () => ({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      size: 2,
      life: 0,
      maxLife: 1,
      color: '#fff',
      kind: 'ember',
    }));
    this.ripples = new LiveRing<SoundRipple>(42, () => ({
      active: false,
      x: 0,
      y: 0,
      radius: 0,
      maxRadius: 90,
      alpha: 0,
      color: '#e5d5b7',
    }));
    this.footprints = new LiveRing<Footprint>(110, () => ({
      active: false,
      x: 0,
      y: 0,
      angle: 0,
      left: true,
      life: 0,
      maxLife: 14,
    }));
    this.rainDrops = new LiveRing<RainDrop>(280, () => ({
      active: false,
      x: 0,
      y: 0,
      len: 16,
      speed: 520,
      alpha: 0.35,
      layer: 0,
    }));
    this.rainRipples = new LiveRing<RainRipple>(90, () => ({
      active: false,
      x: 0,
      y: 0,
      radius: 2,
      maxRadius: 16,
      alpha: 0.4,
    }));

    this.player = this.createInitialPlayer();
    this.inv = this.createInitialInventory();
    this.initJournal();
    this.seedAmbientEnemies();
  }

  private createInitialPlayer(): PlayerState {
    return {
      x: 0,
      y: 25,
      vx: 0,
      vy: 0,
      r: 14,
      angle: Math.PI * 0.45,
      hp: 100,
      maxHp: 100,
      stamina: 100,
      maxStamina: 100,
      battery: 100,
      flashlightOn: true,
      flickerVal: 1,
      swingTimer: 0,
      swingDuration: 0.28,
      swingCd: 0,
      swingDir: 1,
      hitFlash: 0,
      stepDist: 0,
      leftFoot: true,
      walkPhase: 0,
      breathePhase: 0,
      searchingId: null,
      searchProgress: 0,
      isCharging: false,
      chargeTimer: 0,
      dodgeTimer: 0,
      dodgeInvuln: 0,
      dodgeCd: 0,
      dodgeDirX: 0,
      dodgeDirY: 0,
    };
  }

  private createInitialInventory(): Inventory {
    return {
      wood: 3,
      scrap: 2,
      fuel: 1,
      herbs: 2,
      battery: 1,
      essence: 0,
      flares: 2,
      bandages: 1,
      traps: 1,
      weaponTier: 1,
      relayParts: 0,
    };
  }

  private initJournal() {
    this.discoveredZones = new Set<string>(['庇护所']);
    this.journal = [];
    this.nextJournalId = 1;
    this.addJournal(
      '迷雾中的庇护所',
      '发电机还能勉强运转。林子深处藏着旧锯木厂、坠毁货车、猎人营地与一处枯林祭坛——必须在天黑前带回木材、燃油和废铁。'
    );
  }

  addJournal(title: string, body: string) {
    if (this.journal.some((j) => j.title === title && j.day === this.day)) return;
    this.journal.unshift({
      id: this.nextJournalId++,
      day: this.day,
      phase: this.phase,
      title,
      body,
    });
    if (this.journal.length > 24) this.journal.pop();
  }

  pushDecal(evt: DecalEvent) {
    this.pendingDecals.push(evt);
    if (this.pendingDecals.length > 180) this.pendingDecals.shift();
  }

  setWorkbenchCallback(cb: () => void) {
    this.onOpenWorkbench = cb;
  }

  subscribeHud(fn: (snap: HudSnapshot) => void): () => void {
    this.hudSubscribers.add(fn);
    fn(this.getHudSnapshot());
    return () => this.hudSubscribers.delete(fn);
  }

  emitHud() {
    const snap = this.getHudSnapshot();
    this.hudSubscribers.forEach((fn) => fn(snap));
  }

  reset(seed = 19847, startPlaying = false) {
    this.rng = createRng(seed);
    this.world = createWorld(seed);
    this.simTime = 0;
    this.day = 1;
    this.dayTime = 0.08;
    this.phase = 'day';
    this.generatorFuel = 58;
    this.generatorOn = true;

    this.weather = {
      kind: 'drizzle',
      rainIntensity: 0.45,
      wetness: 0.42,
      lightningFlash: 0,
      lightningAngle: -0.6,
      windAngle: 1.78,
    };
    this.weatherTimer = 42;
    this.lightningCd = 14;
    this.thunderQueue = [];

    this.hideoutRoofAlpha = 0;
    this.sawmillRoofAlpha = 1;
    this.pendingDecals = [];
    this.decalResetCounter++;

    this.player = this.createInitialPlayer();
    this.inv = this.createInitialInventory();
    this.activeSlot = 0;
    this.initJournal();

    this.enemies = [];
    this.traps = [];
    this.flares = [];
    this.toasts = [];
    this.particles.clear();
    this.ripples.clear();
    this.footprints.clear();
    this.rainDrops.clear();
    this.rainRipples.clear();

    this.camX = this.player.x;
    this.camY = this.player.y;
    this.camLockX = null;
    this.camLockY = null;
    this.shake = 0;
    this.hitStop = 0;
    this.containersLooted = 0;
    this.enemiesDefeated = 0;
    this.essenceCollected = 0;
    this.dangerLevel = 0;
    this.draggedFurnitureId = null;
    this.relayInstalled = 0;
    this.endlessMode = false;
    this.openerHookTriggered = false;
    this.spawnTimer = 6;
    this.currentPrompt = null;

    this.seedAmbientEnemies();
    this.mode = startPlaying ? 'play' : 'title';
    if (startPlaying) {
      this.pushToast('天黑前搜集木材、燃油与废铁，返回庇护所加固门窗。', 'info');
    }
    this.emitHud();
  }

  /**
   * 临时锁定或解除测试检查相机坐标（供 window.__game.view 使用）
   * 传入 null/undefined 解除锁定，恢复默认跟随逻辑
   */
  setCameraLock(x?: number | null, y?: number | null) {
    if (x === null || x === undefined || y === null || y === undefined) {
      this.camLockX = null;
      this.camLockY = null;
      return;
    }
    this.camLockX = x;
    this.camLockY = y;
    this.camX = x;
    this.camY = y;
    this.shake = 0;
    this.shakeOffsetX = 0;
    this.shakeOffsetY = 0;
  }

  startPlay() {
    AudioFX.unlock();
    if (this.mode === 'dead' || this.mode === 'victory') {
      this.reset(this.world.seed + 13, true);
      return;
    }
    this.mode = 'play';
    if (this.simTime < 1) {
      this.pushToast('天黑前搜集木材、燃油与废铁，返回庇护所加固门窗。', 'info');
    }
    this.emitHud();
  }

  /**
   * 通关后选择继续无尽求生模式（不再重复触发通关结算）
   */
  continueEndless() {
    if (this.mode !== 'victory') return;
    this.endlessMode = true;
    this.mode = 'play';
    this.pushToast('你决定留在幽林深处，继续无尽求生……', 'info');
    this.emitHud();
  }

  setMode(next: GameMode) {
    this.mode = next;
    this.keys.clear();
    this.mouseDownLeft = false;
    this.touchInteract = false;
    this.player.isCharging = false;
    this.player.chargeTimer = 0;
    this.emitHud();
  }

  jumpTimeOfDay(target: TimePhase) {
    if (target === 'day') this.dayTime = 0.1;
    else if (target === 'dusk') this.dayTime = DAY_END + 0.02;
    else this.dayTime = DUSK_END + 0.03;
    this.updatePhase(true);
    this.emitHud();
  }

  jumpWeather(kind: WeatherKind) {
    this.weather.kind = kind;
    this.weatherTimer = 50;
    if (kind === 'storm') {
      this.weather.rainIntensity = 0.92;
      this.weather.wetness = Math.max(this.weather.wetness, 0.78);
      this.triggerLightning();
    } else if (kind === 'drizzle') {
      this.weather.rainIntensity = 0.45;
      this.weather.wetness = Math.max(this.weather.wetness, 0.45);
    } else {
      this.weather.rainIntensity = 0;
    }
    this.emitHud();
  }

  triggerLightning() {
    this.weather.lightningFlash = 1.0;
    this.weather.lightningAngle = -0.9 + this.rng() * 1.2;
    this.thunderQueue.push({
      delay: 0.65 + this.rng() * 1.15,
      intensity: 0.65 + this.rng() * 0.35,
    });
  }

  pushToast(text: string, tone: ToastMessage['tone'] = 'info') {
    this.toasts.push({
      id: this.nextToastId++,
      text,
      tone,
      timer: 4.2,
    });
    if (this.toasts.length > 4) this.toasts.shift();
    this.emitHud();
  }

  private seedAmbientEnemies() {
    const spots: Array<{ x: number; y: number; kind: EnemyKind }> = [
      { x: -720, y: -440, kind: 'hound' },
      { x: 760, y: -380, kind: 'stalker' },
      { x: 640, y: 540, kind: 'stalker' },
    ];
    for (const s of spots) {
      this.spawnEnemyAt(s.x, s.y, s.kind);
    }
  }

  private spawnEnemyAt(x: number, y: number, kind: EnemyKind, initialStalk = 0) {
    const spec =
      kind === 'hound'
        ? { r: 13, hp: 52, speed: 122, damage: 15 }
        : kind === 'banshee'
        ? { r: 18, hp: 110, speed: 84, damage: 24 }
        : { r: 15, hp: 72, speed: 92, damage: 18 };

    this.enemies.push({
      id: this.nextEntityId++,
      kind,
      x,
      y,
      vx: 0,
      vy: 0,
      angle: this.rng() * Math.PI * 2,
      r: spec.r,
      hp: spec.hp,
      maxHp: spec.hp,
      speed: spec.speed,
      damage: spec.damage,
      state: 'prowl',
      attackCd: 0.4,
      hitFlash: 0,
      snareTimer: 0,
      stalkTimer: initialStalk,
      stalkRippleCd: 0.35,
      stepTimer: 0,
      walkPhase: this.rng() * Math.PI * 2,
      clawPhase: 0,
      targetBarricadeId: null,
      patrolX: x,
      patrolY: y,
    });
  }

  private spawnNightHorror() {
    const angle = this.rng() * Math.PI * 2;
    const radius = 560 + this.rng() * 240;
    const x = clamp(this.player.x + Math.cos(angle) * radius, -WORLD_HALF + 80, WORLD_HALF - 80);
    const y = clamp(this.player.y + Math.sin(angle) * radius, -WORLD_HALF + 80, WORLD_HALF - 80);

    if (isPointInHideout(x, y)) return;

    const roll = this.rng();
    let kind: EnemyKind = 'stalker';
    if (roll < 0.34) kind = 'hound';
    else if (this.day >= 2 && roll > 0.76) kind = 'banshee';
    // 夜袭怪物自带 1.4s - 2.4s 门窗外窥伺试探期，杜绝入夜秒杀
    const stalkDuration = 1.4 + this.rng() * 1.0;
    this.spawnEnemyAt(x, y, kind, stalkDuration);
  }

  // --- Player Actions ---

  toggleFlashlight() {
    if (this.mode !== 'play') return;
    if (!this.player.flashlightOn && this.player.battery <= 0.5) {
      this.pushToast('手电电量耗尽！寻找电池或在工作台制作备用电池。', 'warn');
      AudioFX.playClick(false);
      return;
    }
    this.player.flashlightOn = !this.player.flashlightOn;
    AudioFX.playClick(this.player.flashlightOn);
    this.emitHud();
  }

  /**
   * 按下左键开始蓄力（拖拽家具或冷却中禁止进入蓄力）
   */
  beginAttackCharge() {
    if (this.mode !== 'play') return;
    if (this.draggedFurnitureId) return;
    const p = this.player;
    if (p.swingCd > 0 || p.dodgeTimer > 0 || p.stamina < 16) return;
    p.isCharging = true;
    p.chargeTimer = 0;
    p.searchingId = null;
    p.searchProgress = 0;
  }

  /**
   * 松开左键：短按 (<0.22s) 触发轻快横扫；长按 (>=0.22s) 爆发蓄力重击
   */
  releaseAttackCharge() {
    const p = this.player;
    if (!p.isCharging) return;
    const held = p.chargeTimer;
    p.isCharging = false;
    p.chargeTimer = 0;
    if (this.mode !== 'play' || this.draggedFurnitureId) return;
    this.triggerAttack(held >= 0.22);
  }

  /**
   * Space 闪避急退：消耗 28 体力，提供 0.18s 无敌帧与爆发位移，步末重跑碰撞解算
   */
  triggerDodge(dirX?: number, dirY?: number): boolean {
    if (this.mode !== 'play') return false;
    const p = this.player;
    if (p.dodgeCd > 0 || p.dodgeTimer > 0 || p.stamina < 28) return false;

    // 闪避时自动松开家具与取消蓄力/搜刮，保证保命手感顺滑
    if (this.draggedFurnitureId) {
      this.draggedFurnitureId = null;
    }
    p.isCharging = false;
    p.chargeTimer = 0;
    p.searchingId = null;
    p.searchProgress = 0;

    let dx = dirX ?? 0;
    let dy = dirY ?? 0;
    if (dx === 0 && dy === 0) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dy -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) dy += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) dx -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx += 1;
      if (Math.hypot(this.touchMoveX, this.touchMoveY) > 0.1) {
        dx = this.touchMoveX;
        dy = this.touchMoveY;
      }
    }

    const mag = Math.hypot(dx, dy);
    if (mag > 0.08) {
      dx /= mag;
      dy /= mag;
    } else {
      // 静止时向面朝反方向急退
      dx = -Math.cos(p.angle);
      dy = -Math.sin(p.angle);
    }

    p.stamina = Math.max(0, p.stamina - 28);
    p.dodgeTimer = 0.18;
    p.dodgeInvuln = 0.18;
    p.dodgeCd = 0.65;
    p.dodgeDirX = dx;
    p.dodgeDirY = dy;
    p.vx = dx * 340;
    p.vy = dy * 340;

    // 爆发尘土/雨地水花粒子、衣料破风声与急退脚步声
    const wet = this.weather.wetness > 0.35 && !isPointInHideout(p.x, p.y);
    this.spawnBurst(p.x, p.y, 8, wet ? 'splash' : 'dust', wet ? '#b8ccd4' : '#9c927d');
    AudioFX.playDodgeWhoosh();
    AudioFX.playFootstep(getSurfaceAt(this.world, p.x, p.y), true, this.weather.wetness);
    this.emitHud();
    return true;
  }

  /**
   * 近战挥击（支持轻快横扫与蓄力重击）
   */
  triggerAttack(heavy = false) {
    if (this.mode !== 'play') return;
    if (this.draggedFurnitureId) return;
    const p = this.player;
    if (p.swingCd > 0 || p.dodgeTimer > 0 || p.stamina < 16) return;

    const isAxe = this.inv.weaponTier === 2;
    const baseStamina = isAxe ? 22 : 17;
    const totalStamina = heavy ? baseStamina + 14 : baseStamina;
    p.stamina = Math.max(0, p.stamina - totalStamina);
    p.swingDuration = heavy ? (isAxe ? 0.42 : 0.34) : isAxe ? 0.36 : 0.28;
    p.swingTimer = p.swingDuration;
    p.swingCd = heavy ? (isAxe ? 0.62 : 0.52) : isAxe ? 0.54 : 0.44;
    p.swingDir = -p.swingDir;
    p.searchingId = null;
    p.searchProgress = 0;

    const lunge = heavy ? 132 : 78;
    p.vx += Math.cos(p.angle) * lunge;
    p.vy += Math.sin(p.angle) * lunge;

    AudioFX.playChargeSwing(heavy || isAxe);

    const reach = (isAxe ? 68 : 56) + (heavy ? 10 : 0);
    const arcHalf = isAxe ? 1.05 : 0.92;
    const baseDmg = isAxe ? 48 : 28;
    const baseKb = isAxe ? 265 : 185;
    const dmg = heavy ? Math.round(baseDmg * 1.85) : baseDmg;
    const kb = heavy ? Math.round(baseKb * 1.75) : baseKb;

    let hitSomething = false;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const d = dist(p.x, p.y, e.x, e.y);
      if (d > reach + e.r) continue;
      const toEnemy = Math.atan2(e.y - p.y, e.x - p.x);
      if (Math.abs(angleDiff(p.angle, toEnemy)) > arcHalf) continue;
      if (!hasLineOfSight(this.world, p.x, p.y, e.x, e.y)) continue;

      hitSomething = true;
      e.hp -= dmg;
      e.hitFlash = heavy ? 0.3 : 0.22;
      e.vx += Math.cos(toEnemy) * kb;
      e.vy += Math.sin(toEnemy) * kb;
      this.spawnBurst(e.x, e.y, heavy ? 18 : 11, 'blood', '#7c1717');
      this.pushDecal({
        kind: 'splatter',
        x: e.x + Math.cos(toEnemy) * (heavy ? 18 : 14),
        y: e.y + Math.sin(toEnemy) * (heavy ? 18 : 14),
        angle: toEnemy,
        scale: heavy ? (isAxe ? 1.75 : 1.45) : isAxe ? 1.25 : 0.95,
        seed: this.rng() * 100,
      });

      if (e.hp <= 0) {
        this.spawnBurst(e.x, e.y, heavy ? 24 : 18, 'blood', '#560d0d');
        this.pushDecal({
          kind: 'blood',
          x: e.x,
          y: e.y,
          angle: toEnemy,
          scale: heavy ? 1.55 : 1.35,
          seed: this.rng() * 100,
        });
        this.pushDecal({
          kind: 'corpse',
          x: e.x,
          y: e.y,
          angle: e.angle,
          scale: 1.0,
          seed: this.rng() * 100,
          enemyKind: e.kind,
        });
        this.enemies.splice(i, 1);
        this.enemiesDefeated++;
      }
    }

    if (hitSomething) {
      this.hitStop = heavy ? 0.055 : 0.042;
      this.shake = Math.min(14, this.shake + (heavy ? 9.5 : isAxe ? 7.5 : 5));
      AudioFX.playImpact('flesh');
      this.emitRipple(p.x, p.y, heavy ? 165 : 130, 'rgba(214, 108, 92, 0.48)');
    }
  }

  throwFlare() {
    if (this.mode !== 'play') return;
    if (this.inv.flares <= 0) {
      this.pushToast('当前无照明弹', 'warn');
      return;
    }
    this.inv.flares--;
    const p = this.player;
    this.flares.push({
      id: this.nextEntityId++,
      x: p.x + Math.cos(p.angle) * 18,
      y: p.y + Math.sin(p.angle) * 18,
      vx: Math.cos(p.angle) * 290,
      vy: Math.sin(p.angle) * 290,
      life: 22,
      maxLife: 22,
    });
    AudioFX.playFlareHiss();
    this.pushToast('投掷了照明弹！', 'info');
    this.emitHud();
  }

  useBandage() {
    if (this.mode !== 'play') return;
    if (this.inv.bandages <= 0) {
      this.pushToast('当前无绷带', 'warn');
      return;
    }
    if (this.player.hp >= this.player.maxHp - 1) {
      this.pushToast('生命值已满', 'info');
      return;
    }
    this.inv.bandages--;
    this.player.hp = Math.min(this.player.maxHp, this.player.hp + 45);
    AudioFX.playLootChime();
    this.pushToast('绷带止住了伤口，恢复了生命。', 'loot');
    this.emitHud();
  }

  placeBearTrap() {
    if (this.mode !== 'play') return;
    if (this.inv.traps <= 0) {
      this.pushToast('当前无捕兽夹', 'warn');
      return;
    }
    this.inv.traps--;
    const p = this.player;
    const tx = p.x + Math.cos(p.angle) * 24;
    const ty = p.y + Math.sin(p.angle) * 24;
    this.traps.push({
      id: this.nextEntityId++,
      x: tx,
      y: ty,
      armed: true,
      snaredTimer: 0,
    });
    AudioFX.playImpact('metal');
    this.pushToast('放置了捕兽夹', 'info');
    this.emitHud();
  }

  useQuickSlot(slotIndex: number) {
    this.activeSlot = slotIndex;
    if (slotIndex === 1) this.throwFlare();
    else if (slotIndex === 2) this.useBandage();
    else if (slotIndex === 3) this.placeBearTrap();
    else if (slotIndex === 4) this.rechargeFlashlight();
    this.emitHud();
  }

  rechargeFlashlight() {
    if (this.mode !== 'play') return;
    if (this.inv.battery <= 0) {
      this.pushToast('资源不足', 'warn');
      return;
    }
    if (this.player.battery >= 98) return;
    this.inv.battery--;
    this.player.battery = Math.min(100, this.player.battery + 65);
    AudioFX.playClick(true);
    this.pushToast('手电电量已补充', 'loot');
    this.emitHud();
  }

  craft(recipeId: string): boolean {
    const recipe = CRAFT_RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return false;
    if (recipe.id === 'axe' && this.inv.weaponTier >= 2) {
      this.pushToast('已拥有最高级武器', 'info');
      return false;
    }

    for (const [k, needed] of Object.entries(recipe.cost) as [ResourceKey, number][]) {
      if (this.inv[k] < needed) {
        this.pushToast('资源不足', 'warn');
        return false;
      }
    }

    for (const [k, needed] of Object.entries(recipe.cost) as [ResourceKey, number][]) {
      this.inv[k] -= needed;
    }

    if (recipe.id === 'bandage') this.inv.bandages += 1;
    else if (recipe.id === 'flare') this.inv.flares += 2;
    else if (recipe.id === 'trap') this.inv.traps += 1;
    else if (recipe.id === 'cell') this.inv.battery += 1;
    else if (recipe.id === 'axe') {
      this.inv.weaponTier = 2;
      this.pushToast('武器已升级为锈蚀伐木斧！', 'loot');
      this.addJournal('锋利的防身之物', '在工作台锻造出了沉重的锈蚀伐木斧，足以劈开潜伏在暗处的畸形躯壳。');
    }

    AudioFX.playImpact('wood');
    if (recipe.id !== 'axe') {
      this.pushToast(`${I18n.t('制作完成')}: ${I18n.t(recipe.name)}`, 'loot');
    }
    this.emitHud();
    return true;
  }

  triggerInstantInteract() {
    if (this.mode !== 'play') return;
    const p = this.player;

    // 1. 若正在拖拽家具，按 E 立刻松开
    if (this.draggedFurnitureId) {
      this.draggedFurnitureId = null;
      AudioFX.playImpact('wood');
      this.emitHud();
      return;
    }

    // 2. 拾取远方地标的信号中继零件
    const relay = this.findNearestRelayNode(52);
    if (relay) {
      relay.collected = true;
      this.inv.relayParts++;
      AudioFX.playRelayChime(false);
      this.spawnBurst(relay.x, relay.y, 14, 'spark', '#7ad8c5');
      this.emitRipple(relay.x, relay.y, 130, 'rgba(122, 216, 197, 0.48)');
      this.pushToast(`拾取信号中继零件（${relay.zone}）！带回庇护所发电机安装。`, 'loot');
      this.addJournal(
        `中继零件：${relay.zone}`,
        `在${relay.zone}找到了完整的苏式无线电中继组件。将全部 3 件装入庇护所发电机，熬过黑夜即可发信破雾撤离。`
      );
      this.emitHud();
      return;
    }

    // 3. 庇护所发电机：若身上携带信号零件则优先安装，否则注入燃油
    if (dist(p.x, p.y, GENERATOR_POS.x, GENERATOR_POS.y) < 58) {
      if (this.inv.relayParts > 0 && this.relayInstalled < 3) {
        this.inv.relayParts--;
        this.relayInstalled++;
        AudioFX.playRelayChime(this.relayInstalled >= 3);
        this.spawnBurst(GENERATOR_POS.x, GENERATOR_POS.y, 12, 'spark', '#e8c474');
        if (this.relayInstalled >= 3) {
          this.pushToast('中继电台已组装完毕 (3/3)！守住庇护所熬过终夜，破晓即可撤离！', 'loot');
          this.addJournal(
            '中继电台就绪',
            '三件信号中继零件已全部接入发电机。只要守住庇护所撑到下一个黎明，就能借助信号破雾逃出黑林！'
          );
        } else {
          this.pushToast(`已安装信号中继零件 (${this.relayInstalled}/3)`, 'loot');
        }
        this.emitHud();
        return;
      }

      if (this.generatorFuel >= 96) {
        if (!this.generatorOn) {
          this.generatorOn = true;
          AudioFX.playClick(true);
          this.pushToast('发电机已重新启动。', 'info');
          this.emitHud();
          return;
        }
        this.pushToast('发电机燃料已满', 'info');
        return;
      }
      if (this.inv.fuel <= 0) {
        this.pushToast('没有燃油了！', 'warn');
        return;
      }
      this.inv.fuel--;
      this.generatorFuel = Math.min(100, this.generatorFuel + 42);
      this.generatorOn = true;
      AudioFX.playImpact('metal');
      this.pushToast('你点燃了发电机，暖光驱散了屋内的寒意。', 'loot');
      this.addJournal('暖光不灭', '向锈蚀的柴油发电机灌注了燃油。只要电灯还亮着，屋里的黑暗就不敢彻底吞没我。');
      this.emitHud();
      return;
    }

    if (dist(p.x, p.y, WORKBENCH_POS.x, WORKBENCH_POS.y) < 58) {
      this.onOpenWorkbench?.();
      return;
    }

    const bar = this.findNearestBarricade(64);
    if (bar && bar.hp < bar.maxHp) {
      if (this.inv.wood < 2) {
        this.pushToast('无木材加固！', 'warn');
        return;
      }
      this.inv.wood -= 2;
      bar.hp = bar.maxHp;
      AudioFX.playImpact('wood');
      this.spawnBurst(bar.x + bar.w * 0.5, bar.y + bar.h * 0.5, 8, 'wood', '#8d6844');
      this.emitRipple(bar.x + bar.w * 0.5, bar.y + bar.h * 0.5, 165, 'rgba(204, 173, 128, 0.45)');
      this.pushToast('门窗已用木板钉死。', 'loot');
      this.emitHud();
      return;
    }

    for (const node of this.world.essences) {
      if (node.harvested) continue;
      if (dist(p.x, p.y, node.x, node.y) < 46) {
        node.harvested = true;
        this.inv.essence++;
        this.essenceCollected++;
        AudioFX.playLootChime();
        this.spawnBurst(node.x, node.y, 12, 'spore', '#7ad8c5');
        this.pushToast(`${I18n.t('获得了')} ${I18n.t('幽光菇')} ×1`, 'loot');
        this.addJournal('森林的异变菌体', '采摘到散发微弱青绿荧光的奇异菌菇，可用于合成强效应急电池。');
        this.emitHud();
        return;
      }
    }

    // 6. 靠近完好家具按 E 抓取拖拽（抵住门窗延缓怪物突入）
    const furn = this.findNearestFurniture(54);
    if (furn) {
      this.draggedFurnitureId = furn.id;
      p.isCharging = false;
      p.chargeTimer = 0;
      p.searchingId = null;
      p.searchProgress = 0;
      AudioFX.playImpact('wood');
      this.emitHud();
      return;
    }

    if (bar && bar.hp >= bar.maxHp) {
      this.pushToast('木板完好无损', 'info');
    }
  }

  /**
   * 计算点到矩形边缘的最短距离
   */
  private distPointToRect(px: number, py: number, rx: number, ry: number, rw: number, rh: number): number {
    const cx = clamp(px, rx, rx + rw);
    const cy = clamp(py, ry, ry + rh);
    return Math.hypot(px - cx, py - cy);
  }

  private findNearestFurniture(maxDist: number): MovableFurniture | null {
    const p = this.player;
    let best: MovableFurniture | null = null;
    let bestD = maxDist;
    for (const m of this.world.movables) {
      if (m.hp <= 0) continue;
      const d = this.distPointToRect(p.x, p.y, m.x, m.y, m.w, m.h);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private findNearestRelayNode(maxDist: number): RelayNode | null {
    const p = this.player;
    let best: RelayNode | null = null;
    let bestD = maxDist;
    for (const rn of this.world.relayNodes) {
      if (rn.collected) continue;
      const d = dist(p.x, p.y, rn.x, rn.y);
      if (d < bestD) {
        bestD = d;
        best = rn;
      }
    }
    return best;
  }

  private findNearestBarricade(maxDist: number): BarricadeSlot | null {
    const p = this.player;
    let best: BarricadeSlot | null = null;
    let bestD = maxDist;
    for (const b of this.world.barricades) {
      const cx = b.x + b.w * 0.5;
      const cy = b.y + b.h * 0.5;
      const d = dist(p.x, p.y, cx, cy);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  private findNearestContainer(maxDist: number): LootContainer | null {
    const p = this.player;
    let best: LootContainer | null = null;
    let bestD = maxDist;
    for (const c of this.world.containers) {
      if (c.searched) continue;
      const d = dist(p.x, p.y, c.x, c.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // --- Main Fixed-Timestep Tick ---

  step(dt: number, canvasW: number, canvasH: number, externalPilot?: PilotInput) {
    // Title screen: live swaying misty rain forest behind title!
    if (this.mode === 'title') {
      this.simTime += dt;
      if (this.camLockX !== null && this.camLockY !== null) {
        this.camX = this.camLockX;
        this.camY = this.camLockY;
      } else {
        this.camX = Math.sin(this.simTime * 0.14) * 78;
        this.camY = 145 + Math.cos(this.simTime * 0.11) * 42;
      }
      this.player.angle = Math.PI * 0.5 + Math.sin(this.simTime * 0.32) * 0.36;
      this.hideoutRoofAlpha = expDecay(this.hideoutRoofAlpha, 0.98, 4.0, dt);
      this.updateWeather(dt, canvasW, canvasH);
      this.updateParticles(dt);
      this.spawnAmbientSpores(dt);
      this.updateCampfireEmbers(dt);
      return;
    }

    if (this.mode === 'hold' || this.mode === 'dead' || this.mode === 'victory') {
      return;
    }

    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - dt);
      return;
    }

    this.simTime += dt;

    // 30 秒开局钩子：第 1 天开局 6s 在庇护所南门外触发诡异挠门刮木声与立体声波涟漪
    if (this.day === 1 && !this.openerHookTriggered && this.simTime >= 6.0) {
      this.openerHookTriggered = true;
      this.emitRipple(0, 152, 170, 'rgba(218, 128, 92, 0.65)');
      this.emitRipple(-14, 166, 115, 'rgba(206, 189, 152, 0.48)');
      const hookSpatial = {
        worldX: 0,
        worldY: 152,
        listenerX: this.player.x,
        listenerY: this.player.y,
        muffled: isPointInHideout(this.player.x, this.player.y),
      };
      AudioFX.playWoodScrape(hookSpatial);
      AudioFX.playImpact('wood', hookSpatial);
      this.pushToast('南门外传来急促的挠门与脚步声……先搜刮门口背包，必要时拖家具堵门！', 'warn');
    }

    // 衰减家具受击闪烁
    for (let i = 0; i < this.world.movables.length; i++) {
      const m = this.world.movables[i];
      if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt);
    }

    // 1. Day / Dusk / Night cycle
    this.dayTime += dt / CYCLE_SECONDS;
    if (this.dayTime >= 1) {
      this.dayTime -= 1;
      this.day++;
      this.onNewDawn();
    }
    this.updatePhase(false);

    // 2. Dynamic Weather (Mist / Drizzle / Storm + Lightning -> Delayed Thunder)
    this.updateWeather(dt, canvasW, canvasH);

    // 3. Generator fuel burn
    if (this.generatorOn && this.generatorFuel > 0) {
      const burnRate = this.phase === 'night' ? 0.56 : 0.2;
      this.generatorFuel = Math.max(0, this.generatorFuel - burnRate * dt);
      if (this.generatorFuel <= 0) {
        this.generatorOn = false;
        this.pushToast('发电机熄火', 'danger');
        AudioFX.playClick(false);
      }
    }

    // 4. Player Movement, Skeletal Phase, Aim, Flashlight, Scavenging
    this.updatePlayer(dt, canvasW, canvasH, externalPilot);

    // 5. Roof Cutaway Smooth Fade (One Clock, single expDecay)
    const inHideout = isPointInHideout(this.player.x, this.player.y);
    const inSawmill =
      this.player.x >= SAWMILL_ROOF_RECT.x + 12 &&
      this.player.x <= SAWMILL_ROOF_RECT.x + SAWMILL_ROOF_RECT.w - 12 &&
      this.player.y >= SAWMILL_ROOF_RECT.y + 12 &&
      this.player.y <= SAWMILL_ROOF_RECT.y + SAWMILL_ROOF_RECT.h - 12;

    const roofEnabled = Variants.val.roof !== 'a';
    this.hideoutRoofAlpha = expDecay(
      this.hideoutRoofAlpha,
      roofEnabled && !inHideout ? 1 : 0,
      9.5,
      dt
    );
    this.sawmillRoofAlpha = expDecay(
      this.sawmillRoofAlpha,
      roofEnabled && !inSawmill ? 1 : 0,
      9.5,
      dt
    );

    // 6. Track POI zone discoveries in Parchment Journal
    const zone = getZoneNameAt(this.world, this.player.x, this.player.y);
    if (zone !== '迷雾深林' && !this.discoveredZones.has(zone)) {
      this.discoveredZones.add(zone);
      const notes: Record<string, string> = {
        坠毁货车: '西北方密林中发现一辆倾覆的补给卡车，车厢周边散落着燃油桶与生锈的物资箱。',
        废弃锯木厂: '东北方的旧锯木厂残垣中堆满木料与工具箱，空气里弥漫着潮湿木屑与铁锈味。',
        猎人营地: '西南营地只剩破旧帐篷和遇难猎人的背包，似乎有什么野兽曾在此徘徊。',
        枯林祭坛: '东南深林藏着诡异的石柱祭坛，四周生长着发光的幽光菇，令人毛骨悚然。',
      };
      if (notes[zone]) {
        this.addJournal(`发现区域：${zone}`, notes[zone]);
        this.pushToast(`已探明：${zone}`, 'info');
      }
    }

    // 7. Flares & Bear Traps
    this.updateFlares(dt);
    this.updateTraps(dt);

    // 8. Enemies & Night Siege
    this.updateEnemies(dt);

    // 9. Particles, Ripples, Footprints, Toasts
    this.updateParticles(dt);
    this.spawnAmbientSpores(dt);
    this.updateCampfireEmbers(dt);
    this.updateRipplesAndFootprints(dt);
    this.updateToasts(dt);

    // 10. Camera (One Clock — single exponential follow + trauma decay)
    if (this.camLockX !== null && this.camLockY !== null) {
      this.camX = this.camLockX;
      this.camY = this.camLockY;
      this.shake = 0;
      this.shakeOffsetX = 0;
      this.shakeOffsetY = 0;
    } else {
      const lookAhead = 34;
      const targetCamX = this.player.x + Math.cos(this.player.angle) * lookAhead;
      const targetCamY = this.player.y + Math.sin(this.player.angle) * lookAhead;
      this.camX = expDecay(this.camX, targetCamX, 6.5, dt);
      this.camY = expDecay(this.camY, targetCamY, 6.5, dt);

      const halfViewW = Math.min(WORLD_HALF - 40, canvasW * 0.42);
      const halfViewH = Math.min(WORLD_HALF - 40, canvasH * 0.42);
      this.camX = clamp(this.camX, -WORLD_HALF + halfViewW, WORLD_HALF - halfViewW);
      this.camY = clamp(this.camY, -WORLD_HALF + halfViewH, WORLD_HALF - halfViewH);

      if (this.shake > 0.05) {
        this.shake = Math.max(0, this.shake - dt * 26);
        this.shakeOffsetX = (this.rng() * 2 - 1) * this.shake;
        this.shakeOffsetY = (this.rng() * 2 - 1) * this.shake;
      } else {
        this.shake = 0;
        this.shakeOffsetX = 0;
        this.shakeOffsetY = 0;
      }
    }

    // 11. Continuous Physical Audio Modulation
    const nightFactor = this.phase === 'night' ? 1 : this.phase === 'dusk' ? 0.55 : 0.12;
    AudioFX.updateAmbience({
      dt,
      nightFactor,
      rainIntensity: this.weather.rainIntensity,
      inHideout,
      genDist: dist(this.player.x, this.player.y, GENERATOR_POS.x, GENERATOR_POS.y),
      genOn: this.generatorOn && this.generatorFuel > 0,
      genFuel: this.generatorFuel,
      danger: this.dangerLevel,
      time: this.simTime,
    });

    this.hudAccum += dt;
    if (this.hudAccum >= 0.066) {
      this.hudAccum = 0;
      this.emitHud();
    }
  }

  private updateWeather(dt: number, canvasW: number, canvasH: number) {
    const weatherEnabled = Variants.val.weather !== 'a';

    if (!weatherEnabled) {
      this.weather.kind = 'mist';
      this.weather.rainIntensity = expDecay(this.weather.rainIntensity, 0, 2.5, dt);
      this.weather.wetness = expDecay(this.weather.wetness, 0.15, 0.4, dt);
      this.weather.lightningFlash = Math.max(0, this.weather.lightningFlash - dt * 4.5);
      return;
    }

    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      const r = this.rng();
      if (this.phase === 'night') {
        this.weather.kind = r < 0.55 ? 'storm' : 'drizzle';
        if (this.weather.kind === 'storm' && this.mode === 'play') {
          this.pushToast('乌云压境，林间下起了冰冷的暴雨……', 'warn');
        }
      } else if (this.phase === 'dusk') {
        this.weather.kind = r < 0.65 ? 'drizzle' : 'storm';
      } else {
        this.weather.kind = r < 0.48 ? 'mist' : r < 0.85 ? 'drizzle' : 'storm';
      }
      this.weatherTimer = 38 + this.rng() * 34;
    }

    const targetRain =
      this.weather.kind === 'storm' ? 0.94 : this.weather.kind === 'drizzle' ? 0.42 : 0;
    this.weather.rainIntensity = expDecay(this.weather.rainIntensity, targetRain, 0.45, dt);

    // Wetness builds during rain and evaporates slowly in mist
    const targetWet =
      this.weather.rainIntensity > 0.1 ? clamp(0.35 + this.weather.rainIntensity * 0.65, 0, 1) : 0.18;
    this.weather.wetness = expDecay(
      this.weather.wetness,
      targetWet,
      this.weather.rainIntensity > 0.1 ? 0.12 : 0.03,
      dt
    );

    // Lightning bolts during storm
    if (this.weather.lightningFlash > 0) {
      this.weather.lightningFlash = Math.max(0, this.weather.lightningFlash - dt * 3.4);
    }
    if (this.weather.kind === 'storm') {
      this.lightningCd -= dt;
      if (this.lightningCd <= 0) {
        this.lightningCd = 11 + this.rng() * 14;
        this.triggerLightning();
      }
    }

    // Delayed thunder acoustic queue
    for (let i = this.thunderQueue.length - 1; i >= 0; i--) {
      this.thunderQueue[i].delay -= dt;
      if (this.thunderQueue[i].delay <= 0) {
        const th = this.thunderQueue.splice(i, 1)[0];
        AudioFX.playThunder(th.intensity);
        this.shake = Math.min(6, this.shake + th.intensity * 2.2);
      }
    }

    // 双景深雨幕 + 积水涟漪 + 地面/屋檐反弹水花微粒（全部复用零 GC 环形池）
    const rainScale = Quality.preset.rainScale;
    const rate = this.weather.rainIntensity * 165 * rainScale;
    this.rainSpawnAccum += rate * dt;
    const w = Math.max(640, canvasW);
    const h = Math.max(480, canvasH);
    while (this.rainSpawnAccum >= 1) {
      this.rainSpawnAccum -= 1;
      const drop = this.rainDrops.alloc();
      const isNear = this.rng() < 0.28;
      drop.active = true;
      drop.layer = isNear ? 1 : 0;
      drop.x = this.camX + (this.rng() - 0.5) * (w + 200);
      drop.y = this.camY - h * 0.55 - this.rng() * 120;
      drop.len = isNear ? 22 + this.rng() * 16 : 12 + this.rng() * 14;
      drop.speed = isNear ? 780 + this.rng() * 240 : 520 + this.rng() * 210;
      drop.alpha = (isNear ? 0.26 + this.rng() * 0.22 : 0.16 + this.rng() * 0.20) * this.weather.rainIntensity;

      // 积水双圈涟漪与短促反弹水花微粒
      if (this.rng() < 0.30) {
        const rx = this.camX + (this.rng() - 0.5) * w;
        const ry = this.camY + (this.rng() - 0.5) * h;
        if (!isPointInHideout(rx, ry)) {
          const rip = this.rainRipples.alloc();
          rip.active = true;
          rip.x = rx;
          rip.y = ry;
          rip.radius = 1.5;
          rip.maxRadius = 11 + this.rng() * 10;
          rip.alpha = 0.48 * this.weather.rainIntensity;

          // 短促反弹水花微粒（1~2 颗）
          if (this.rng() < 0.58 * Quality.preset.particleScale) {
            const count = this.rng() < 0.45 ? 2 : 1;
            for (let k = 0; k < count; k++) {
              const sp = this.particles.alloc();
              sp.active = true;
              sp.x = rx;
              sp.y = ry;
              sp.vx = (this.rng() - 0.5) * 46;
              sp.vy = -22 - this.rng() * 34;
              sp.size = 1.0 + this.rng() * 0.9;
              sp.life = 0.14 + this.rng() * 0.11;
              sp.maxLife = sp.life;
              sp.color = '#c8d6dc';
              sp.kind = 'splash';
            }
          }
        }
      }

      // 庇护所屋檐边缘雨滴溅射水花
      if (this.rng() < 0.08 * Quality.preset.particleScale) {
        const side = Math.floor(this.rng() * 4);
        let ex = HIDEOUT_RECT.x;
        let ey = HIDEOUT_RECT.y;
        if (side === 0) {
          ex = HIDEOUT_RECT.x + this.rng() * HIDEOUT_RECT.w;
          ey = HIDEOUT_RECT.y - 8;
        } else if (side === 1) {
          ex = HIDEOUT_RECT.x + this.rng() * HIDEOUT_RECT.w;
          ey = HIDEOUT_RECT.y + HIDEOUT_RECT.h + 8;
        } else if (side === 2) {
          ex = HIDEOUT_RECT.x - 8;
          ey = HIDEOUT_RECT.y + this.rng() * HIDEOUT_RECT.h;
        } else {
          ex = HIDEOUT_RECT.x + HIDEOUT_RECT.w + 8;
          ey = HIDEOUT_RECT.y + this.rng() * HIDEOUT_RECT.h;
        }
        if (Math.abs(ex - this.camX) < w * 0.65 && Math.abs(ey - this.camY) < h * 0.65) {
          const sp = this.particles.alloc();
          sp.active = true;
          sp.x = ex;
          sp.y = ey;
          sp.vx = (this.rng() - 0.5) * 34;
          sp.vy = -18 - this.rng() * 24;
          sp.size = 1.1 + this.rng() * 0.9;
          sp.life = 0.15 + this.rng() * 0.10;
          sp.maxLife = sp.life;
          sp.color = '#d2e0e6';
          sp.kind = 'splash';
        }
      }
    }

    const windDx = Math.cos(this.weather.windAngle);
    const windDy = Math.sin(this.weather.windAngle);
    const bottomLimit = this.camY + h * 0.62;
    for (let i = 0; i < this.rainDrops.count; i++) {
      const d = this.rainDrops.items[i];
      if (!d.active) continue;
      d.x += windDx * d.speed * dt;
      d.y += windDy * d.speed * dt;
      if (d.y > bottomLimit) d.active = false;
    }

    for (let i = 0; i < this.rainRipples.count; i++) {
      const r = this.rainRipples.items[i];
      if (!r.active) continue;
      r.radius += 22 * dt;
      r.alpha -= 0.72 * dt;
      if (r.alpha <= 0 || r.radius >= r.maxRadius) r.active = false;
    }
  }

  private updatePhase(silent: boolean) {
    const prev = this.phase;
    if (this.dayTime < DAY_END) this.phase = 'day';
    else if (this.dayTime < DUSK_END) this.phase = 'dusk';
    else this.phase = 'night';

    if (!silent && prev !== this.phase) {
      if (this.phase === 'dusk') {
        this.pushToast('黄昏将至，雾气变浓了。尽快返回庇护所！', 'warn');
        AudioFX.playPhaseHorn(true);
      } else if (this.phase === 'night') {
        this.pushToast('黑夜降临！有什么东西正在墙外徘徊……', 'danger');
        AudioFX.playPhaseHorn(true);
        this.addJournal(
          `第 ${this.day} 夜降临`,
          '林中的雾气彻底化为墨色，门窗外传来指甲刮擦木板的刺耳声响。守住灯光，撑到天亮。'
        );
        this.spawnTimer = 2.0;
      }
      this.emitHud();
    }
  }

  private onNewDawn() {
    // 若 3 件信号中继零件已全部安装且未进入无尽模式，破晓即触发「破雾撤离」通关！
    if (this.relayInstalled >= 3 && !this.endlessMode) {
      this.mode = 'victory';
      AudioFX.playPhaseHorn(false);
      AudioFX.playRelayChime(true);
      this.addJournal(
        '破雾撤离',
        '无线电中继器穿透了浓重的林间迷雾。随着灰白黎明降临，你循着回应的信号踏出了幽林。'
      );
      this.emitHud();
      return;
    }

    this.pushToast('天亮了。你熬过了又一个漫长的黑夜。', 'loot');
    AudioFX.playPhaseHorn(false);
    this.addJournal(
      `第 ${this.day} 天破晓`,
      '阴冷的灰白晨光透过树梢洒下，屋外的低吼渐渐退入密林深处。门前的血迹与碎木提醒着昨夜的凶险。'
    );
    let refilled = 0;
    for (const c of this.world.containers) {
      if (c.searched && dist(c.x, c.y, 0, 0) > 360 && this.rng() < 0.45 && refilled < 6) {
        c.searched = false;
        refilled++;
      }
    }
    for (const e of this.enemies) {
      e.state = 'flee_dawn';
    }
  }

  private updatePlayer(
    dt: number,
    canvasW: number,
    canvasH: number,
    externalPilot?: PilotInput
  ) {
    const p = this.player;
    p.hitFlash = Math.max(0, p.hitFlash - dt);
    p.swingCd = Math.max(0, p.swingCd - dt);
    p.swingTimer = Math.max(0, p.swingTimer - dt);
    p.dodgeTimer = Math.max(0, p.dodgeTimer - dt);
    p.dodgeInvuln = Math.max(0, p.dodgeInvuln - dt);
    p.dodgeCd = Math.max(0, p.dodgeCd - dt);
    p.breathePhase += dt * 2.4;

    // 校验当前拖拽家具是否仍存活
    let draggedFurn: MovableFurniture | null = null;
    if (this.draggedFurnitureId) {
      draggedFurn =
        this.world.movables.find((m) => m.id === this.draggedFurnitureId && m.hp > 0) ?? null;
      if (!draggedFurn) this.draggedFurnitureId = null;
    }

    let mx = 0;
    let my = 0;
    let wantSprint = false;
    let holdInteract = false;

    if (externalPilot) {
      mx = Number.isFinite(externalPilot.mx) ? externalPilot.mx : 0;
      my = Number.isFinite(externalPilot.my) ? externalPilot.my : 0;
      wantSprint = Boolean(externalPilot.sprint);
      holdInteract = Boolean(externalPilot.interact);
      if (Number.isFinite(externalPilot.aimAngle)) {
        p.angle = externalPilot.aimAngle;
      }
      if (externalPilot.dodge) this.triggerDodge(mx, my);
      if (externalPilot.attack) this.triggerAttack(false);
      if (externalPilot.toggleLight) this.toggleFlashlight();
    } else {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
      if (Math.hypot(this.touchMoveX, this.touchMoveY) > 0.08) {
        mx = this.touchMoveX;
        my = this.touchMoveY;
      }
      wantSprint =
        this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSprint;
      holdInteract = this.keys.has('KeyE') || this.touchInteract;

      if (this.touchAimActive) {
        if (Math.hypot(this.touchAimX, this.touchAimY) > 0.15) {
          p.angle = Math.atan2(this.touchAimY, this.touchAimX);
        }
      } else if (canvasW > 0 && canvasH > 0) {
        const worldMouseX = this.camX + (this.mouseScreenX - canvasW * 0.5);
        const worldMouseY = this.camY + (this.mouseScreenY - canvasH * 0.5);
        p.angle = Math.atan2(worldMouseY - p.y, worldMouseX - p.x);
      }

      // 蓄力计时推进（左键持续按住时累计，上限 0.65s）
      if (p.isCharging) {
        if (!this.mouseDownLeft || draggedFurn || p.dodgeTimer > 0) {
          this.releaseAttackCharge();
        } else {
          p.chargeTimer = Math.min(0.65, p.chargeTimer + dt);
        }
      }
    }

    const moveMag = Math.hypot(mx, my);
    if (moveMag > 1) {
      mx /= moveMag;
      my /= moveMag;
    }

    const isMoving = moveMag > 0.08;
    const isDragging = draggedFurn !== null;
    const isHeavyStance = p.isCharging && p.chargeTimer >= 0.22;
    const sprinting =
      wantSprint &&
      isMoving &&
      p.stamina > 6 &&
      !p.searchingId &&
      !isDragging &&
      !isHeavyStance &&
      p.dodgeTimer <= 0;

    if (sprinting) {
      p.stamina = Math.max(0, p.stamina - 28 * dt);
    } else if (p.dodgeTimer <= 0) {
      p.stamina = Math.min(p.maxStamina, p.stamina + (isMoving ? 15 : 24) * dt);
    }

    // Single Budget Ledger for player speed
    const baseSpeed = 128;
    const sprintMul = sprinting ? 1.52 : 1.0;
    const searchMul = p.searchingId ? 0.35 : 1.0;
    const woundMul = p.hp < 25 ? 0.86 : 1.0;
    const dragMul = isDragging ? 0.54 : 1.0;
    const chargeMul = isHeavyStance ? 0.72 : 1.0;
    const targetSpeed = baseSpeed * sprintMul * searchMul * woundMul * dragMul * chargeMul;

    if (p.dodgeTimer > 0) {
      // 闪避急退期间维持高爆发速度并洒出微粒
      p.vx = p.dodgeDirX * 340;
      p.vy = p.dodgeDirY * 340;
      if (this.rng() < 0.55 * Quality.preset.particleScale) {
        const pt = this.particles.alloc();
        pt.active = true;
        pt.x = p.x + (this.rng() - 0.5) * 10;
        pt.y = p.y + (this.rng() - 0.5) * 10;
        pt.vx = -p.dodgeDirX * (20 + this.rng() * 30);
        pt.vy = -p.dodgeDirY * (20 + this.rng() * 30);
        pt.size = 1.6 + this.rng() * 1.8;
        pt.life = 0.22 + this.rng() * 0.14;
        pt.maxLife = pt.life;
        pt.color = this.weather.wetness > 0.35 ? '#b6cbd4' : '#9c927e';
        pt.kind = this.weather.wetness > 0.35 ? 'splash' : 'dust';
      }
    } else {
      p.vx = expDecay(p.vx, mx * targetSpeed, 14, dt);
      p.vy = expDecay(p.vy, my * targetSpeed, 14, dt);
    }

    const prevX = p.x;
    const prevY = p.y;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Constraints Last（拖拽时先跳过正被抓取的家具，随后对家具解算并防夹死）
    const resolved = resolveWorldCollision(
      this.world,
      p.x,
      p.y,
      p.r,
      true,
      draggedFurn?.id
    );
    p.x = resolved.x;
    p.y = resolved.y;

    // 拖拽家具平滑跟随玩家身前并执行世界碰撞解算，防止穿墙或夹死玩家
    if (draggedFurn) {
      const halfExtent = Math.max(draggedFurn.w, draggedFurn.h) * 0.5;
      const offset = p.r + halfExtent + 8;
      const desiredCx = p.x + Math.cos(p.angle) * offset;
      const desiredCy = p.y + Math.sin(p.angle) * offset;
      const desiredX = desiredCx - draggedFurn.w * 0.5;
      const desiredY = desiredCy - draggedFurn.h * 0.5;

      const prevFurnX = draggedFurn.x;
      const prevFurnY = draggedFurn.y;
      draggedFurn.x = expDecay(draggedFurn.x, desiredX, 12, dt);
      draggedFurn.y = expDecay(draggedFurn.y, desiredY, 12, dt);

      const fRes = resolveFurnitureCollision(this.world, draggedFurn);
      draggedFurn.x = fRes.x;
      draggedFurn.y = fRes.y;

      // 家具实际滑动时触发带节流的旧木地板低沉摩擦声
      const furnMoved = dist(prevFurnX, prevFurnY, draggedFurn.x, draggedFurn.y);
      if (furnMoved > 0.35 && dt > 0) {
        AudioFX.playFurnitureDrag(clamp(furnMoved / (dt * 92), 0.18, 1));
      }

      // 若家具被墙顶住导致与玩家重叠，将玩家安全分离并重跑世界碰撞
      const sep = resolveCircleRect(
        p.x,
        p.y,
        p.r,
        draggedFurn.x,
        draggedFurn.y,
        draggedFurn.w,
        draggedFurn.h
      );
      if (sep) {
        const safeP = resolveWorldCollision(this.world, sep.x, sep.y, p.r, true, draggedFurn.id);
        p.x = safeP.x;
        p.y = safeP.y;
      }

      // 若因角落阻挡导致与家具拉开过远（>115px），自动脱手防卡死
      if (
        this.distPointToRect(p.x, p.y, draggedFurn.x, draggedFurn.y, draggedFurn.w, draggedFurn.h) >
        115
      ) {
        this.draggedFurnitureId = null;
      }
    }

    const moved = dist(prevX, prevY, p.x, p.y);

    // Drive articulated skeletal stride phase strictly from real displacement (Single Owner)
    p.walkPhase += moved * 0.14;
    p.stepDist += moved;
    const stride = sprinting ? 34 : 44;
    if (p.stepDist >= stride) {
      p.stepDist -= stride;
      p.leftFoot = !p.leftFoot;
      const surface = getSurfaceAt(this.world, p.x, p.y);
      AudioFX.playFootstep(surface, sprinting, this.weather.wetness);

      if (surface !== 'wood') {
        const moveAng = Math.atan2(p.vy, p.vx);
        const fp = this.footprints.alloc();
        fp.active = true;
        fp.x = p.x;
        fp.y = p.y;
        fp.angle = moveAng;
        fp.left = p.leftFoot;
        fp.life = 14;
        fp.maxLife = 14;

        // Bake muddy footprints permanently into persistent ground decal buffer when ground is wet!
        if (this.weather.wetness > 0.3) {
          this.pushDecal({
            kind: 'footprint',
            x: p.x,
            y: p.y,
            angle: moveAng,
            scale: 1,
            seed: this.rng() * 10,
            left: p.leftFoot,
          });
        }
      }

      if (sprinting) {
        this.emitRipple(p.x, p.y, 110, 'rgba(210, 200, 178, 0.28)');
      }
    }

    if (p.flashlightOn) {
      const drain = this.phase === 'night' ? 0.65 : 0.38;
      p.battery = Math.max(0, p.battery - drain * dt);
      if (p.battery <= 0) {
        p.flashlightOn = false;
        AudioFX.playClick(false);
        this.pushToast('手电电量耗尽！寻找电池或在工作台制作备用电池。', 'danger');
      } else if (p.battery < 18) {
        const wave = Math.sin(this.simTime * 29) * Math.sin(this.simTime * 11.3);
        p.flickerVal = wave > 0.45 ? 0.25 : 0.92;
      } else {
        p.flickerVal = 0.97 + Math.sin(this.simTime * 8.4) * 0.03;
      }
    } else {
      p.flickerVal = 0;
    }

    this.updateInteractions(dt, holdInteract);
  }

  private updateInteractions(dt: number, holdInteract: boolean) {
    const p = this.player;
    this.currentPrompt = null;

    // 拖拽家具时优先提示松开
    if (this.draggedFurnitureId) {
      const furn = this.world.movables.find((m) => m.id === this.draggedFurnitureId && m.hp > 0);
      if (furn) {
        this.currentPrompt = {
          label: '按 E 松开家具',
          worldX: furn.x + furn.w * 0.5,
          worldY: furn.y - 16,
          progress: 0,
          hold: false,
        };
        return;
      }
    }

    // 信号中继零件节点交互提示
    const relay = this.findNearestRelayNode(52);
    if (relay) {
      this.currentPrompt = {
        label: '按 E 拾取信号中继零件',
        worldX: relay.x,
        worldY: relay.y - 26,
        progress: 0,
        hold: false,
      };
      return;
    }

    const container = this.findNearestContainer(54);
    if (container) {
      if (holdInteract) {
        if (p.searchingId !== container.id) {
          p.searchingId = container.id;
          p.searchProgress = 0;
        }
        p.searchProgress += dt / container.searchDuration;
        if (
          Math.floor(p.searchProgress * 4) !==
          Math.floor((p.searchProgress - dt / container.searchDuration) * 4)
        ) {
          this.emitRipple(container.x, container.y, 82, 'rgba(206, 189, 152, 0.35)');
        }
        if (p.searchProgress >= 1) {
          this.completeContainerLoot(container);
          p.searchingId = null;
          p.searchProgress = 0;
        }
      } else {
        p.searchingId = null;
        p.searchProgress = 0;
      }

      if (!container.searched) {
        this.currentPrompt = {
          label: holdInteract ? '搜刮中...' : '长按 E 搜刮',
          worldX: container.x,
          worldY: container.y - 26,
          progress: p.searchingId === container.id ? clamp(p.searchProgress, 0, 1) : 0,
          hold: true,
        };
        return;
      }
    } else {
      p.searchingId = null;
      p.searchProgress = 0;
    }

    for (const node of this.world.essences) {
      if (node.harvested) continue;
      if (dist(p.x, p.y, node.x, node.y) < 46) {
        this.currentPrompt = {
          label: '按 E 采摘幽光菇',
          worldX: node.x,
          worldY: node.y - 24,
          progress: 0,
          hold: false,
        };
        return;
      }
    }

    if (dist(p.x, p.y, GENERATOR_POS.x, GENERATOR_POS.y) < 58) {
      const canInstall = this.inv.relayParts > 0 && this.relayInstalled < 3;
      this.currentPrompt = {
        label: canInstall
          ? `按 E 安装中继零件 (${this.relayInstalled}/3)`
          : '按 E 注入燃油 (燃油×1)',
        worldX: GENERATOR_POS.x,
        worldY: GENERATOR_POS.y - 28,
        progress: 0,
        hold: false,
      };
      return;
    }

    if (dist(p.x, p.y, WORKBENCH_POS.x, WORKBENCH_POS.y) < 58) {
      this.currentPrompt = {
        label: '按 E 打开工作台',
        worldX: WORKBENCH_POS.x,
        worldY: WORKBENCH_POS.y - 26,
        progress: 0,
        hold: false,
      };
      return;
    }

    const bar = this.findNearestBarricade(64);
    if (bar && bar.hp < bar.maxHp) {
      this.currentPrompt = {
        label: '按 E 加固门窗 (木材×2)',
        worldX: bar.x + bar.w * 0.5,
        worldY: bar.y + bar.h * 0.5 - 24,
        progress: 0,
        hold: false,
      };
      return;
    }

    const furn = this.findNearestFurniture(54);
    if (furn) {
      this.currentPrompt = {
        label: '按 E 拖拽家具',
        worldX: furn.x + furn.w * 0.5,
        worldY: furn.y - 16,
        progress: 0,
        hold: false,
      };
    }
  }

  private completeContainerLoot(c: LootContainer) {
    c.searched = true;
    this.containersLooted++;
    const parts: string[] = [];
    for (const [k, qty] of Object.entries(c.loot) as [ResourceKey, number][]) {
      if (!qty) continue;
      this.inv[k] += qty;
      if (k === 'essence') this.essenceCollected += qty;
      parts.push(`${I18n.t(RESOURCE_LABELS[k])} ×${qty}`);
    }
    AudioFX.playLootChime();
    this.spawnBurst(c.x, c.y, 10, 'ember', '#d8b46e');
    this.pushToast(`${I18n.t('获得了')} ${parts.join(' · ')}`, 'loot');
    this.emitHud();
  }

  private updateFlares(dt: number) {
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.life -= dt;
      if (f.life <= 0) {
        // Leave permanent charred ash scorch mark on forest floor!
        this.pushDecal({
          kind: 'scorch',
          x: f.x,
          y: f.y,
          angle: this.rng() * Math.PI * 2,
          scale: 1.0,
          seed: this.rng() * 100,
        });
        this.flares.splice(i, 1);
        continue;
      }
      f.vx *= Math.exp(-3.8 * dt);
      f.vy *= Math.exp(-3.8 * dt);
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      const res = resolveWorldCollision(this.world, f.x, f.y, 6, true);
      if (res.x !== f.x) f.vx *= -0.4;
      if (res.y !== f.y) f.vy *= -0.4;
      f.x = res.x;
      f.y = res.y;

      if (this.rng() < 0.48 * Quality.preset.particleScale) {
        const pt = this.particles.alloc();
        pt.active = true;
        pt.x = f.x + (this.rng() - 0.5) * 4;
        pt.y = f.y + (this.rng() - 0.5) * 4;
        pt.vx = (this.rng() - 0.5) * 28;
        pt.vy = (this.rng() - 0.5) * 28 - 12;
        pt.size = 2 + this.rng() * 2.5;
        pt.life = 0.45;
        pt.maxLife = 0.45;
        pt.color = this.rng() > 0.35 ? '#ff5a36' : '#ffd194';
        pt.kind = 'spark';
      }
    }
  }

  private updateTraps(dt: number) {
    for (let i = this.traps.length - 1; i >= 0; i--) {
      const t = this.traps[i];
      if (!t.armed) {
        t.snaredTimer -= dt;
        if (t.snaredTimer <= 0) this.traps.splice(i, 1);
      }
    }
  }

  private updateEnemies(dt: number) {
    const p = this.player;

    if (this.phase === 'night') {
      const maxNightEnemies = Math.min(8, 3 + this.day * 2);
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.enemies.length < maxNightEnemies) {
        this.spawnNightHorror();
        this.spawnTimer = Math.max(5.5, 11 - this.day * 1.1);
      }
    }

    let maxDanger = 0;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      e.attackCd = Math.max(0, e.attackCd - dt);
      e.clawPhase = Math.max(0, e.clawPhase - dt * 3.5);

      if (e.snareTimer <= 0) {
        for (const trap of this.traps) {
          if (!trap.armed) continue;
          if (dist(e.x, e.y, trap.x, trap.y) < e.r + 14) {
            trap.armed = false;
            trap.snaredTimer = 3.8;
            e.snareTimer = 3.8;
            e.state = 'snared';
            e.hp -= 44;
            e.hitFlash = 0.35;
            AudioFX.playImpact('metal', {
              worldX: e.x,
              worldY: e.y,
              listenerX: p.x,
              listenerY: p.y,
              muffled: isPointInHideout(e.x, e.y) !== isPointInHideout(p.x, p.y),
            });
            this.spawnBurst(e.x, e.y, 14, 'blood', '#7a1414');
            this.pushDecal({
              kind: 'blood',
              x: e.x,
              y: e.y,
              angle: e.angle,
              scale: 1.15,
              seed: this.rng() * 100,
            });
            this.emitRipple(e.x, e.y, 180, 'rgba(232, 92, 68, 0.55)');
            this.pushToast('捕兽夹触发！困住了入侵者！', 'loot');
            if (e.hp <= 0) {
              this.pushDecal({
                kind: 'corpse',
                x: e.x,
                y: e.y,
                angle: e.angle,
                scale: 1.0,
                seed: this.rng() * 100,
                enemyKind: e.kind,
              });
              this.enemies.splice(i, 1);
              this.enemiesDefeated++;
            }
            break;
          }
        }
        if (e.hp <= 0) continue;
      }

      if (e.snareTimer > 0) {
        e.snareTimer -= dt;
        e.vx *= Math.exp(-10 * dt);
        e.vy *= Math.exp(-10 * dt);
        e.walkPhase += dt * 16; // frantic struggling twitch
        if (e.snareTimer <= 0) e.state = 'chase';
        continue;
      }

      const dToPlayer = dist(e.x, e.y, p.x, p.y);
      const proximityDanger = clamp(1 - dToPlayer / 430, 0, 1);
      if (proximityDanger > maxDanger) maxDanger = proximityDanger;

      const sightRange = this.phase === 'night' ? 760 : p.flashlightOn ? 340 : 215;

      let targetX = e.patrolX;
      let targetY = e.patrolY;
      let desiredSpeed = e.speed * 0.48;

      if (e.state === 'flee_dawn') {
        const away = Math.atan2(e.y - p.y, e.x - p.x);
        targetX = e.x + Math.cos(away) * 300;
        targetY = e.y + Math.sin(away) * 300;
        desiredSpeed = e.speed * 1.15;
        if (dToPlayer > 720) {
          this.enemies.splice(i, 1);
          continue;
        }
      } else if (dToPlayer < sightRange || this.phase === 'night') {
        e.state = 'chase';
        desiredSpeed = e.speed * (this.phase === 'night' ? 1.06 : 0.94);

        const playerInside = isPointInHideout(p.x, p.y);
        const enemyInside = isPointInHideout(e.x, e.y);

        if (playerInside && !enemyInside) {
          let bestBar: BarricadeSlot | null = null;
          let bestScore = Infinity;
          for (const b of this.world.barricades) {
            const bx = b.x + b.w * 0.5;
            const by = b.y + b.h * 0.5;
            const score = dist(e.x, e.y, bx, by) + b.hp * 1.6;
            if (score < bestScore) {
              bestScore = score;
              bestBar = b;
            }
          }

          if (bestBar) {
            const bx = bestBar.x + bestBar.w * 0.5;
            const by = bestBar.y + bestBar.h * 0.5;
            const dBar = dist(e.x, e.y, bx, by);
            // 窥伺试探期：靠近门窗外 115px 时先短暂停顿窥伺 1.4-2.4s，发出刮木声波与低吼再破门
            if (e.stalkTimer > 0 && dBar < 115) {
              e.state = 'stalk';
              e.stalkTimer = Math.max(0, e.stalkTimer - dt);
              e.stalkRippleCd -= dt;
              const orbitAng = Math.atan2(e.y - by, e.x - bx) + Math.sin(this.simTime * 1.6 + e.id) * 0.45;
              targetX = bx + Math.cos(orbitAng) * 62;
              targetY = by + Math.sin(orbitAng) * 62;
              desiredSpeed = e.speed * 0.36;
              if (e.stalkRippleCd <= 0) {
                e.stalkRippleCd = 0.85;
                this.emitRipple(bx, by, 145, 'rgba(208, 124, 92, 0.52)');
                const stalkSpatial = {
                  worldX: bx,
                  worldY: by,
                  listenerX: p.x,
                  listenerY: p.y,
                  muffled: true,
                };
                AudioFX.playWoodScrape(stalkSpatial);
                AudioFX.playMonsterSnarl(clamp(1 - dToPlayer / 380, 0.15, 0.75), stalkSpatial);
              }
            } else if (bestBar.hp > 0 && dBar < 46) {
              e.state = 'attack_barricade';
              targetX = bx;
              targetY = by;
              desiredSpeed = 0;
              if (e.attackCd <= 0) {
                e.attackCd = e.kind === 'banshee' ? 1.0 : 1.35;
                e.clawPhase = 1.0;
                const bDmg = e.kind === 'banshee' ? 28 : 16;
                bestBar.hp = Math.max(0, bestBar.hp - bDmg);
                AudioFX.playImpact('wood', {
                  worldX: bx,
                  worldY: by,
                  listenerX: p.x,
                  listenerY: p.y,
                  muffled: true,
                });
                this.spawnBurst(bx, by, 7, 'wood', '#7d5b3b');
                this.pushDecal({
                  kind: 'wood',
                  x: bx + (this.rng() - 0.5) * 26,
                  y: by + (this.rng() - 0.5) * 26,
                  angle: this.rng() * Math.PI * 2,
                  scale: 1.0,
                  seed: this.rng() * 100,
                });
                this.emitRipple(bx, by, 175, 'rgba(218, 128, 92, 0.55)');
                this.shake = Math.min(8, this.shake + 2.8);
                if (bestBar.hp <= 0) {
                  this.pushToast('门窗木板被撕碎了！', 'danger');
                }
              }
            } else {
              targetX = dBar < 34 && bestBar.hp <= 0 ? p.x : bx;
              targetY = dBar < 34 && bestBar.hp <= 0 ? p.y : by;
            }
          }
        } else {
          targetX = p.x;
          targetY = p.y;
        }
      } else {
        if (dist(e.x, e.y, e.patrolX, e.patrolY) < 35) {
          const ang = this.rng() * Math.PI * 2;
          e.patrolX = clamp(e.x + Math.cos(ang) * 160, -WORLD_HALF + 120, WORLD_HALF - 120);
          e.patrolY = clamp(e.y + Math.sin(ang) * 160, -WORLD_HALF + 120, WORLD_HALF - 120);
        }
      }

      const dir = Math.atan2(targetY - e.y, targetX - e.x);
      e.angle = wrapAngle(e.angle + angleDiff(e.angle, dir) * clamp(dt * 8, 0, 1));
      e.vx = expDecay(e.vx, Math.cos(dir) * desiredSpeed, 6.5, dt);
      e.vy = expDecay(e.vy, Math.sin(dir) * desiredSpeed, 6.5, dt);

      const px = e.x;
      const py = e.y;
      e.x += e.vx * dt;
      e.y += e.vy * dt;

      const resolved = resolveWorldCollision(this.world, e.x, e.y, e.r, false);
      e.x = resolved.x;
      e.y = resolved.y;

      // 怪物路径若被可拖拽重型家具阻挡，则攻击家具（扣减 hp、轻微击退、木屑与声波，损毁后解除阻挡）
      if (e.state === 'chase' && e.attackCd <= 0) {
        for (let mIdx = 0; mIdx < this.world.movables.length; mIdx++) {
          const furn = this.world.movables[mIdx];
          if (furn.hp <= 0) continue;
          const dFurn = this.distPointToRect(e.x, e.y, furn.x, furn.y, furn.w, furn.h);
          if (dFurn < e.r + 10) {
            e.attackCd = e.kind === 'banshee' ? 1.0 : 1.3;
            e.clawPhase = 1.0;
            const fDmg = e.kind === 'banshee' ? 28 : 18;
            furn.hp = Math.max(0, furn.hp - fDmg);
            furn.hitFlash = 0.26;
            const fcx = furn.x + furn.w * 0.5;
            const fcy = furn.y + furn.h * 0.5;
            const pushAng = Math.atan2(fcy - e.y, fcx - e.x);
            furn.x += Math.cos(pushAng) * 9;
            furn.y += Math.sin(pushAng) * 9;
            const fRes = resolveFurnitureCollision(this.world, furn);
            furn.x = fRes.x;
            furn.y = fRes.y;

            AudioFX.playImpact('wood', {
              worldX: fcx,
              worldY: fcy,
              listenerX: p.x,
              listenerY: p.y,
              muffled: isPointInHideout(fcx, fcy) !== isPointInHideout(p.x, p.y),
            });
            this.spawnBurst(fcx, fcy, 8, 'wood', '#7d5b3b');
            this.emitRipple(fcx, fcy, 155, 'rgba(218, 128, 92, 0.50)');
            this.shake = Math.min(7, this.shake + 2.2);
            if (furn.hp <= 0) {
              if (this.draggedFurnitureId === furn.id) this.draggedFurnitureId = null;
              this.spawnBurst(fcx, fcy, 16, 'wood', '#6c4d31');
              this.pushDecal({
                kind: 'wood',
                x: fcx,
                y: fcy,
                angle: pushAng,
                scale: 1.35,
                seed: this.rng() * 100,
              });
              this.pushToast('挡路的家具被怪物撞碎了！', 'danger');
            }
            break;
          }
        }
      }

      e.walkPhase += dist(px, py, e.x, e.y) * 0.16;

      e.stepTimer -= dt;
      if (e.stepTimer <= 0 && dToPlayer < 460 && Math.hypot(e.vx, e.vy) > 28) {
        e.stepTimer = e.kind === 'hound' ? 0.65 : 1.05;
        this.emitRipple(e.x, e.y, 72, 'rgba(198, 98, 82, 0.42)');
        if (this.rng() < 0.25 && dToPlayer < 320) {
          AudioFX.playMonsterSnarl(clamp(1 - dToPlayer / 360, 0.1, 1), {
            worldX: e.x,
            worldY: e.y,
            listenerX: p.x,
            listenerY: p.y,
            muffled: isPointInHideout(e.x, e.y) !== isPointInHideout(p.x, p.y),
          });
        }
      }

      if (
        dToPlayer < e.r + p.r + 10 &&
        e.attackCd <= 0 &&
        e.state !== 'flee_dawn' &&
        e.state !== 'stalk' &&
        p.dodgeInvuln <= 0
      ) {
        e.attackCd = e.kind === 'hound' ? 0.95 : 1.25;
        e.clawPhase = 1.0;
        p.hp = Math.max(0, p.hp - e.damage);
        p.hitFlash = 0.35;
        this.shake = Math.min(14, this.shake + 8);
        AudioFX.playImpact('flesh');
        AudioFX.playMonsterSnarl(0.95);
        this.spawnBurst(p.x, p.y, 12, 'blood', '#8f1515');
        this.pushDecal({
          kind: 'splatter',
          x: p.x,
          y: p.y,
          angle: Math.atan2(p.y - e.y, p.x - e.x),
          scale: 0.9,
          seed: this.rng() * 100,
        });
        const pushAng = Math.atan2(p.y - e.y, p.x - e.x);
        p.vx += Math.cos(pushAng) * 190;
        p.vy += Math.sin(pushAng) * 190;

        if (p.hp <= 0) {
          this.mode = 'dead';
          this.emitHud();
          return;
        }
        this.emitHud();
      }
    }

    this.dangerLevel = expDecay(this.dangerLevel, maxDanger, 4, dt);
  }

  private spawnBurst(
    x: number,
    y: number,
    count: number,
    kind: Particle['kind'],
    color: string
  ) {
    const scaled = Math.max(2, Math.round(count * Quality.preset.particleScale));
    for (let i = 0; i < scaled; i++) {
      const pt = this.particles.alloc();
      const ang = this.rng() * Math.PI * 2;
      const spd = 35 + this.rng() * 115;
      pt.active = true;
      pt.x = x;
      pt.y = y;
      pt.vx = Math.cos(ang) * spd;
      pt.vy = Math.sin(ang) * spd;
      pt.size = 2 + this.rng() * 3;
      pt.life = 0.35 + this.rng() * 0.35;
      pt.maxLife = pt.life;
      pt.color = color;
      pt.kind = kind;
    }
  }

  private spawnAmbientSpores(dt: number) {
    this.sporeTimer -= dt;
    const interval = 0.085 / Math.max(0.35, Quality.preset.particleScale);
    if (this.sporeTimer > 0) return;
    this.sporeTimer = interval;

    // 1. Forest spore drift
    const pt = this.particles.alloc();
    pt.active = true;
    pt.x = this.camX + (this.rng() - 0.5) * 900;
    pt.y = this.camY + (this.rng() - 0.5) * 620;
    pt.vx = -12 - this.rng() * 16;
    pt.vy = -5 + (this.rng() - 0.5) * 14;
    pt.size = 1.4 + this.rng() * 1.9;
    pt.life = 3.2 + this.rng() * 2.4;
    pt.maxLife = pt.life;
    pt.color = this.phase === 'night' ? '#8ab3a5' : '#c7be9f';
    pt.kind = 'spore';

    // 2. Dust motes illuminated inside flashlight beam cone!
    if (this.player.flashlightOn && this.rng() < 0.72) {
      const dust = this.particles.alloc();
      const spread = (this.rng() - 0.5) * 0.95;
      const rad = 45 + this.rng() * 320;
      const a = this.player.angle + spread;
      dust.active = true;
      dust.x = this.player.x + Math.cos(a) * rad;
      dust.y = this.player.y + Math.sin(a) * rad;
      dust.vx = (this.rng() - 0.5) * 14;
      dust.vy = -4 + (this.rng() - 0.5) * 12;
      dust.size = 1.1 + this.rng() * 1.6;
      dust.life = 1.8 + this.rng() * 1.4;
      dust.maxLife = dust.life;
      dust.color = Variants.val.light === 'b' ? '#f6d89e' : '#cfe5f8';
      dust.kind = 'dust';
    }
  }

  /**
   * 活的篝火、庇护所铁桶火盆与室内铸铁炭炉：持续发射随风飘散的余烬火星与柔和热烟
   */
  private updateCampfireEmbers(dt: number) {
    this.emberTimer -= dt;
    const interval = 0.065 / Math.max(0.35, Quality.preset.particleScale);
    if (this.emberTimer > 0) return;
    this.emberTimer = interval;

    const windDx = Math.cos(this.weather.windAngle) * (14 + this.weather.rainIntensity * 22);
    const sources: Array<{ x: number; y: number; scale: number; indoor: boolean }> = [
      { x: HIDEOUT_BRAZIER_POS.x, y: HIDEOUT_BRAZIER_POS.y, scale: 1.0, indoor: false },
      { x: CAMPFIRE_POS.x, y: CAMPFIRE_POS.y, scale: 1.15, indoor: false },
      { x: HIDEOUT_STOVE_POS.x - 4, y: HIDEOUT_STOVE_POS.y, scale: 0.55, indoor: true },
    ];

    for (const src of sources) {
      if (Math.abs(src.x - this.camX) > 780 || Math.abs(src.y - this.camY) > 540) continue;

      // 余烬火星（炽白黄 / 橙红随风明灭飘散）
      if (this.rng() < 0.85) {
        const em = this.particles.alloc();
        em.active = true;
        em.x = src.x + (this.rng() - 0.5) * 9 * src.scale;
        em.y = src.y + (this.rng() - 0.5) * 9 * src.scale;
        em.vx = (src.indoor ? 0 : windDx) + (this.rng() - 0.5) * 26;
        em.vy = -24 - this.rng() * 34;
        em.size = (1.1 + this.rng() * 1.4) * src.scale;
        em.life = 0.65 + this.rng() * 0.85;
        em.maxLife = em.life;
        em.color = this.rng() < 0.35 ? '#fff0b8' : this.rng() < 0.72 ? '#ff9d3b' : '#e85224';
        em.kind = 'ember';
      }

      // 缓慢上升淡出的暗灰暖烟
      if (!src.indoor && this.rng() < 0.42) {
        const sm = this.particles.alloc();
        sm.active = true;
        sm.x = src.x + (this.rng() - 0.5) * 8;
        sm.y = src.y - 4 + (this.rng() - 0.5) * 6;
        sm.vx = windDx * 0.55 + (this.rng() - 0.5) * 10;
        sm.vy = -16 - this.rng() * 14;
        sm.size = (5.5 + this.rng() * 5.5) * src.scale;
        sm.life = 1.4 + this.rng() * 1.1;
        sm.maxLife = sm.life;
        sm.color = 'rgba(72, 68, 64, 0.34)';
        sm.kind = 'smoke';
      }
    }
  }

  private updateParticles(dt: number) {
    for (let i = 0; i < this.particles.count; i++) {
      const pt = this.particles.items[i];
      if (!pt.active) continue;
      pt.life -= dt;
      if (pt.life <= 0) {
        pt.active = false;
        continue;
      }
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      if (pt.kind === 'splash') {
        pt.vy += 260 * dt;
      } else if (pt.kind === 'ember') {
        pt.vx += Math.sin(this.simTime * 7 + i) * 18 * dt;
        pt.vx *= Math.exp(-1.1 * dt);
        pt.vy *= Math.exp(-0.9 * dt);
      } else if (pt.kind === 'smoke') {
        pt.size += 6.5 * dt;
        pt.vx *= Math.exp(-0.8 * dt);
        pt.vy *= Math.exp(-0.6 * dt);
      } else if (pt.kind !== 'spore' && pt.kind !== 'dust') {
        pt.vx *= Math.exp(-5.5 * dt);
        pt.vy *= Math.exp(-5.5 * dt);
      }
    }
  }

  private emitRipple(x: number, y: number, maxRadius: number, color: string) {
    const r = this.ripples.alloc();
    r.active = true;
    r.x = x;
    r.y = y;
    r.radius = 6;
    r.maxRadius = maxRadius;
    r.alpha = 0.85;
    r.color = color;
  }

  private updateRipplesAndFootprints(dt: number) {
    for (let i = 0; i < this.ripples.count; i++) {
      const r = this.ripples.items[i];
      if (!r.active) continue;
      r.radius += (r.maxRadius - r.radius) * clamp(dt * 4.5, 0, 1) + 45 * dt;
      r.alpha -= dt * 1.05;
      if (r.alpha <= 0 || r.radius >= r.maxRadius) r.active = false;
    }

    for (let i = 0; i < this.footprints.count; i++) {
      const fp = this.footprints.items[i];
      if (!fp.active) continue;
      fp.life -= dt;
      if (fp.life <= 0) fp.active = false;
    }
  }

  private updateToasts(dt: number) {
    let changed = false;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      this.toasts[i].timer -= dt;
      if (this.toasts[i].timer <= 0) {
        this.toasts.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.emitHud();
  }

  createPilot(): (t: number) => PilotInput {
    return (t: number) => {
      const p = this.player;
      let tx = 0;
      let ty = 15;
      let interact = false;
      let attack = false;

      let nearestEnemy: Enemy | null = null;
      let nearD = 120;
      for (const e of this.enemies) {
        const d = dist(p.x, p.y, e.x, e.y);
        if (d < nearD) {
          nearD = d;
          nearestEnemy = e;
        }
      }

      if (nearestEnemy) {
        tx = nearestEnemy.x;
        ty = nearestEnemy.y;
        if (nearD < 62) attack = true;
      } else if (this.phase === 'day') {
        const c = this.findNearestContainer(900);
        if (c) {
          if (isPointInHideout(p.x, p.y) && !isPointInHideout(c.x, c.y)) {
            tx = 0;
            ty = 175;
          } else {
            tx = c.x;
            ty = c.y;
            if (dist(p.x, p.y, c.x, c.y) < 46) interact = true;
          }
        }
      } else {
        if (!isPointInHideout(p.x, p.y) && (p.y < 145 || Math.abs(p.x) > 26)) {
          tx = 0;
          ty = 165;
        } else {
          tx = 0;
          ty = 18;
        }
      }

      const dx = tx - p.x;
      const dy = ty - p.y;
      const d = Math.hypot(dx, dy);
      const aimAngle = d > 1 ? Math.atan2(dy, dx) : Math.sin(t) * Math.PI;
      const mx = d > 24 && !interact ? dx / d : 0;
      const my = d > 24 && !interact ? dy / d : 0;

      return {
        mx,
        my,
        aimAngle,
        sprint: d > 220 && p.stamina > 45,
        attack,
        interact,
        toggleLight: false,
      };
    };
  }

  getPhaseProgress(): number {
    if (this.phase === 'day') return clamp(this.dayTime / DAY_END, 0, 1);
    if (this.phase === 'dusk') return clamp((this.dayTime - DAY_END) / (DUSK_END - DAY_END), 0, 1);
    return clamp((this.dayTime - DUSK_END) / (1 - DUSK_END), 0, 1);
  }

  /**
   * 生成左上角极简紧凑的当前主目标指引文字
   */
  getObjectiveText(): string {
    if (this.endlessMode) {
      return `无尽求生 · 第 ${this.day} 天`;
    }
    if (this.relayInstalled >= 3) {
      return '中继就绪 (3/3) · 守至破晓撤离';
    }
    if (this.inv.relayParts > 0) {
      return `带回零件安装至发电机 (${this.relayInstalled}/3)`;
    }
    return `收集信号零件 ${this.relayInstalled}/3 · 探索地标`;
  }

  getHudSnapshot(): HudSnapshot {
    const chargeRatio = this.player.isCharging
      ? clamp((this.player.chargeTimer - 0.12) / (0.65 - 0.12), 0, 1)
      : 0;
    return {
      mode: this.mode,
      day: this.day,
      phase: this.phase,
      phaseProgress: this.getPhaseProgress(),
      dayTime: this.dayTime,
      weather: this.weather.kind,
      rainIntensity: this.weather.rainIntensity,
      wetness: this.weather.wetness,
      hp: Math.round(this.player.hp),
      maxHp: this.player.maxHp,
      stamina: Math.round(this.player.stamina),
      maxStamina: this.player.maxStamina,
      battery: Math.round(this.player.battery),
      flashlightOn: this.player.flashlightOn,
      generatorFuel: Math.round(this.generatorFuel),
      generatorOn: this.generatorOn,
      inHideout: isPointInHideout(this.player.x, this.player.y),
      zoneName: getZoneNameAt(this.world, this.player.x, this.player.y),
      playerX: Math.round(this.player.x),
      playerY: Math.round(this.player.y),
      inv: { ...this.inv },
      activeSlot: this.activeSlot,
      prompt: this.currentPrompt ? { ...this.currentPrompt } : null,
      toasts: this.toasts.map((t) => ({ ...t })),
      containersLooted: this.containersLooted,
      totalContainers: this.world.containers.length,
      enemiesDefeated: this.enemiesDefeated,
      essenceCollected: this.essenceCollected,
      dangerLevel: this.dangerLevel,
      discoveredZones: Array.from(this.discoveredZones),
      journal: this.journal.map((j) => ({ ...j })),
      relayParts: this.inv.relayParts,
      relayInstalled: this.relayInstalled,
      relayCollectedZones: this.world.relayNodes.filter((rn) => rn.collected).map((rn) => rn.zone),
      draggingFurniture: this.draggedFurnitureId !== null,
      objectiveText: this.getObjectiveText(),
      endlessMode: this.endlessMode,
      chargeRatio,
      backend: this.backendName,
      fps: Math.round(this.fps),
      entities: this.enemies.length + this.flares.length + this.traps.length,
    };
  }

  getShelterLamps(): Vec2[] {
    return SHELTER_LAMPS;
  }

  getHideoutRect() {
    return HIDEOUT_RECT;
  }
}
