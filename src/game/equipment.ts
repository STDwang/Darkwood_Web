// ============================================================================
// 幽林余烬 · 装备系统（R3 装备执行独占文件）
// 左手：手电筒（锥光、电量逻辑仍由 engine 原样负责，本模块不改动）
// 右手：火把（暖色点光源 + 近战武器；轻击/蓄力重击/闪避判定沿用 engine.triggerAttack，手感与 sim-check 断言不变）
//   ⇄ 手枪（Q 切换）：侧身甩手把火把丢到身侧地面 → 世界实体 groundTorches（继续燃烧、雨中减弱、缓慢熄灭），
//      靠近按 E（或手枪模式下再按 Q）弯腰捡回，捡回即切回火把模式
// 手枪：左键射击（射线检测只读 world 遮挡数据）、R 换弹、弹匣 6 发 + 备弹 inv.ammo；空仓扣扳机空响；
//       枪口火光（一帧强光）+ 轻微震屏 + 噪声涟漪（吸引怪物 / 惊飞乌鸦）+ 弹壳落地
// 手势动作（engine.step 内推进，renderer 只读）：丢火把 / 捡火把 / 拔枪 / 射击后坐 / 换弹 / 重缠火把 / 投掷照明弹 / 放置陷阱
// 火焰物理：以"火把头"世界速度为输入的欠阻尼弹簧——火焰向运动反方向拖曳、急停时前冲、挥击时甩成弧线并拖出火星、
//           风雨压低火焰并嘶嘶冒汽；火焰同时调制火把点光源的强度与位置（renderer 读取 torchLight / flameX/Y）
// 铁律：FIXED_DT 推进；约束最后（抛出的火把统一 resolveWorldCollision）；火星走 engine 粒子环形池，
//       地上火把 / 弹壳 / 照明弹抛物线均为预分配池，每步零分配。
// ============================================================================

import { AudioFX } from './audio';
import type { SpatialAudioOpts } from './audio';
import type { GameEngine } from './engine';
import { I18n } from './i18n';
import { Quality } from './quality';
import type { InteractPrompt, LootContainer, Particle } from './types';
import { clamp, createRng, dist, expDecay, lerp, raySegmentIntersect } from './util';
import type { Segment } from './util';
import { collectOccluderSegments, getSurfaceAt, isPointInHideout, resolveWorldCollision } from './world';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type WeaponMode = 'torch' | 'pistol';

/** 装备手势（短时动作动画状态机；'none' 表示空闲） */
export type EquipGesture =
  | 'none'
  | 'dropTorch'
  | 'draw'
  | 'pickup'
  | 'throwFlare'
  | 'setTrap'
  | 'recoil'
  | 'reload'
  | 'retorch';

/** engine 提供给装备模块的私有能力（由 engine 构造时绑定，避免公开 engine 私有方法） */
export interface EquipHost {
  nextId(): number;
  emitRipple(x: number, y: number, maxRadius: number, color: string): void;
  crowAlarmAt(x: number, y: number, radius: number, loud: boolean): void;
  /** 击杀 engine.enemies[index]：倒地动画 + 移除 + 计数（与近战击杀同一路径） */
  killEnemy(index: number, fallDir: number): void;
}

/** 地上的火把（预分配池） */
export interface GroundTorch {
  active: boolean;
  id: number;
  x: number;
  y: number;
  /** 离地高度（抛物线） */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** 木柄朝向（世界角） */
  rot: number;
  spin: number;
  airborne: boolean;
  bounces: number;
  /** 燃料 0..1 */
  fuel: number;
  lit: boolean;
  /** 火焰摆动弹簧（世界 px） */
  swayX: number;
  swayY: number;
  swayVX: number;
  swayVY: number;
  /** 火焰高度 0..1（雨中变矮） */
  flameH: number;
  /** 落地火星闪光计时 */
  landFlash: number;
}

/** 弹壳（预分配池） */
export interface ShellCasing {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rot: number;
  spin: number;
  life: number;
  airborne: boolean;
  bounces: number;
}

/** 照明弹抛物线高度（与 engine.flares 的 id 对应；预分配池） */
export interface FlareArc {
  active: boolean;
  id: number;
  z: number;
  vz: number;
}

/** 右臂姿态（局部坐标：+x 前方，肩点 (3,-10.5)） */
export interface ArmPose {
  a: number;
  len: number;
  twist: number;
  w: number;
}

/** 左手目标点（局部坐标） */
export interface HandPose {
  x: number;
  y: number;
  w: number;
}

export interface EquipmentState {
  mode: WeaponMode;
  /** 火把是否在右手中（false = 丢在地上） */
  torchInHand: boolean;
  /** 手中火把燃料 0..1 */
  torchFuel: number;
  torchLit: boolean;
  /** 弹匣内子弹（备弹在 engine.inv.ammo） */
  mag: number;
  fireCd: number;
  shotsFired: number;
  dryFires: number;
  hits: number;
  // 手势
  gesture: EquipGesture;
  gT: number;
  gDur: number;
  gEventDone: boolean;
  gTargetX: number;
  gTargetY: number;
  gTargetId: number;
  /** 持枪姿态混合 0..1（拔枪时随手势推进，收枪/捡火把时平滑淡出） */
  pistolW: number;
  /** 后坐 1→0 */
  recoil: number;
  /** 枪口火光剩余秒（>0 时 renderer 推入一帧强光） */
  muzzleFlash: number;
  muzzleX: number;
  muzzleY: number;
  /** 弹道残影 */
  tracer: number;
  tracerX0: number;
  tracerY0: number;
  tracerX1: number;
  tracerY1: number;
  // 火把头运动学与火焰物理
  headX: number;
  headY: number;
  headVX: number;
  headVY: number;
  prevHeadX: number;
  prevHeadY: number;
  headInit: boolean;
  /** 火焰惯性偏移（世界 px，弹簧状态） */
  flameX: number;
  flameY: number;
  flameVX: number;
  flameVY: number;
  /** 火焰高度 0..1 */
  flameH: number;
  /** 火焰被拖长程度 0..1 */
  flameStretch: number;
  /** 火把点光源强度 0..1（renderer 再乘以呼吸频闪） */
  torchLight: number;
  /** 火把头所处的淋雨程度 0..1 */
  rainExposure: number;
  whooshCd: number;
  sparkAccum: number;
  emberAccum: number;
  steamAccum: number;
  toastCd: number;
  hintDropShown: boolean;
  groundTorches: GroundTorch[];
  shells: ShellCasing[];
  shellCursor: number;
  flareArcs: FlareArc[];
  flareCursor: number;
  /** 容器 id → 额外的手枪子弹掉落（确定性分配；world.ts 不改动） */
  ammoLoot: Map<string, number>;
  prompt: InteractPrompt;
  spatial: SpatialAudioOpts;
  segScratch: Segment[];
  armBase: ArmPose;
  armGesture: ArmPose;
  rng: () => number;
}

// ---------------------------------------------------------------------------
// 参数（单源；renderer 读取）
// ---------------------------------------------------------------------------

export const PISTOL_MAG_SIZE = 6;
export const START_RESERVE_AMMO = 3;
export const PISTOL_RANGE = 560;
export const PISTOL_DAMAGE = 62;
export const PISTOL_KNOCKBACK = 330;
export const PISTOL_FIRE_CD = 0.34;
const GROUND_TORCH_POOL = 3;
const SHELL_POOL = 10;
const FLARE_ARC_POOL = 6;
export const TORCH_PICKUP_RADIUS = 56;
/** 手持火把燃烧速率（燃料/秒，约 7 分钟烧完；淋雨加速 60%） */
export const TORCH_BURN_HELD = 1 / 420;
/** 地上火把燃烧速率（约 4.3 分钟；淋雨加速 90%） */
export const TORCH_BURN_GROUND = 1 / 260;
/** 重缠火把消耗 */
export const RETORCH_COST = { wood: 1, fuel: 1 };

/** 手势时长（秒） */
export const GESTURE_DUR: Record<EquipGesture, number> = {
  none: 0,
  dropTorch: 0.42,
  draw: 0.3,
  pickup: 0.5,
  throwFlare: 0.42,
  setTrap: 0.62,
  recoil: 0.2,
  reload: 1.15,
  retorch: 1.0,
};

/** 手势"生效"时刻（占时长比例）：火把出手 / 抓起火把 / 照明弹出手 / 陷阱咔哒 / 弹匣插入 / 重新点燃 */
export const GESTURE_EVENT: Record<EquipGesture, number> = {
  none: 1,
  dropTorch: 0.45,
  draw: 1,
  pickup: 0.55,
  throwFlare: 0.5,
  setTrap: 0.62,
  recoil: 1,
  reload: 0.85,
  retorch: 0.9,
};

/** 火焰弹簧物理参数：ω≈13.8rad/s，ζ≈0.32（欠阻尼 → 急停前冲、挥击甩弧） */
export const FLAME_PHYS = {
  stiffness: 190,
  damping: 8.8,
  /** 拖曳系数：目标偏移 = -火把头速度 × dragK */
  dragK: 0.02,
  maxOffset: 15,
  windIndoor: 0.25,
  windBase: 1.2,
  windRain: 2.6,
  /** 地上火把：更软的弹簧（受风轻摆） */
  groundStiffness: 120,
  groundDamping: 7,
  /** 挥动火星阈值（px/s） */
  sparkSpeed: 360,
  /** 挥动呼呼声阈值（px/s） */
  /** 疾跑/急停时火把头快速扫过肩部，420px/s 即可产生可辨的短促破风。 */
  whooshSpeed: 420,
};

/** 火把点光源参数（renderer 推入 GpuLight 时读取） */
export const TORCH_LIGHT = {
  radius: 150,
  intensity: 1.15,
  groundRadius: 132,
  groundIntensity: 0.95,
  muzzleRadius: 270,
  muzzleIntensity: 3.2,
  /** 被视为"照亮敌人"的半径 */
  revealRadius: 138,
};

// ---------------------------------------------------------------------------
// 音频调用契约（音频执行在 audio.ts 实现；此处以可选调用绑定，audio 未落地时编译与运行均安全）
// ---------------------------------------------------------------------------

interface EquipAudioContract {
  playGunshot?(spatial?: SpatialAudioOpts): void;
  playPistolReload?(): void;
  playDryFire?(): void;
  playShellDrop?(surface: 'wood' | 'mud' | 'gravel'): void;
  setTorchBurn?(level01: number, motion01: number): void;
  playTorchWhoosh?(intensity01: number): void;
  playTorchDrop?(spatial?: SpatialAudioOpts): void;
  playTorchPickup?(): void;
  playThrow?(kind: 'flare' | 'torch'): void;
  playTrapSet?(spatial?: SpatialAudioOpts): void;
  playWeaponSwap?(toPistol: boolean): void;
  setGroundTorchBurn?(level01: number, spatial?: SpatialAudioOpts): void;
}
const SFX = AudioFX as unknown as EquipAudioContract;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function easeInOut(x: number): number {
  const k = clamp(x, 0, 1);
  return k * k * (3 - 2 * k);
}

function easeOut(x: number): number {
  const k = clamp(x, 0, 1);
  return 1 - (1 - k) * (1 - k);
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function spawnParticle(
  engine: GameEngine,
  x: number,
  y: number,
  vx: number,
  vy: number,
  size: number,
  life: number,
  color: string,
  kind: Particle['kind']
) {
  const pt = engine.particles.alloc();
  pt.active = true;
  pt.x = x;
  pt.y = y;
  pt.vx = vx;
  pt.vy = vy;
  pt.size = size;
  pt.life = life;
  pt.maxLife = life;
  pt.color = color;
  pt.kind = kind;
}

/** 火星四溅（装备模块自有 rng，不扰动 engine 的随机序列） */
function sparkBurst(engine: GameEngine, x: number, y: number, count: number, speed: number) {
  const eq = engine.equip;
  const n = Math.max(2, Math.round(count * Quality.preset.particleScale));
  for (let i = 0; i < n; i++) {
    const a = eq.rng() * Math.PI * 2;
    const s = speed * (0.35 + eq.rng() * 0.9);
    const hot = eq.rng();
    spawnParticle(
      engine,
      x,
      y,
      Math.cos(a) * s,
      Math.sin(a) * s - 18,
      1 + eq.rng() * 1.6,
      0.3 + eq.rng() * 0.45,
      hot < 0.3 ? '#fff0b8' : hot < 0.75 ? '#ff9d3b' : '#e85224',
      i % 3 === 0 ? 'spark' : 'ember'
    );
  }
}

function fillSpatial(engine: GameEngine, x: number, y: number, maxDist: number): SpatialAudioOpts {
  const s = engine.equip.spatial;
  const p = engine.player;
  s.worldX = x;
  s.worldY = y;
  s.listenerX = p.x;
  s.listenerY = p.y;
  s.muffled = isPointInHideout(x, y) !== isPointInHideout(p.x, p.y);
  s.maxDist = maxDist;
  return s;
}

function startGesture(eq: EquipmentState, g: EquipGesture, tx = 0, ty = 0, targetId = 0) {
  eq.gesture = g;
  eq.gT = 0;
  eq.gDur = GESTURE_DUR[g];
  eq.gEventDone = false;
  eq.gTargetX = tx;
  eq.gTargetY = ty;
  eq.gTargetId = targetId;
}

// ---------------------------------------------------------------------------
// 创建 / 重置
// ---------------------------------------------------------------------------

export function createEquipment(seed = 19847): EquipmentState {
  const eq: EquipmentState = {
    mode: 'torch',
    torchInHand: true,
    torchFuel: 1,
    torchLit: true,
    mag: PISTOL_MAG_SIZE,
    fireCd: 0,
    shotsFired: 0,
    dryFires: 0,
    hits: 0,
    gesture: 'none',
    gT: 0,
    gDur: 0,
    gEventDone: false,
    gTargetX: 0,
    gTargetY: 0,
    gTargetId: 0,
    pistolW: 0,
    recoil: 0,
    muzzleFlash: 0,
    muzzleX: 0,
    muzzleY: 0,
    tracer: 0,
    tracerX0: 0,
    tracerY0: 0,
    tracerX1: 0,
    tracerY1: 0,
    headX: 0,
    headY: 0,
    headVX: 0,
    headVY: 0,
    prevHeadX: 0,
    prevHeadY: 0,
    headInit: false,
    flameX: 0,
    flameY: 0,
    flameVX: 0,
    flameVY: 0,
    flameH: 1,
    flameStretch: 0,
    torchLight: 1,
    rainExposure: 0,
    whooshCd: 0,
    sparkAccum: 0,
    emberAccum: 0,
    steamAccum: 0,
    toastCd: 0,
    hintDropShown: false,
    groundTorches: [],
    shells: [],
    shellCursor: 0,
    flareArcs: [],
    flareCursor: 0,
    ammoLoot: new Map<string, number>(),
    prompt: { label: '', worldX: 0, worldY: 0, progress: 0, hold: false },
    spatial: { worldX: 0, worldY: 0, listenerX: 0, listenerY: 0, muffled: false, maxDist: 640 },
    segScratch: [],
    armBase: { a: 0.25, len: 13, twist: 0, w: 0 },
    armGesture: { a: 0.25, len: 13, twist: 0, w: 0 },
    rng: createRng((seed ^ 0x51f7) >>> 0),
  };
  for (let i = 0; i < GROUND_TORCH_POOL; i++) {
    eq.groundTorches.push({
      active: false,
      id: 0,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      rot: 0,
      spin: 0,
      airborne: false,
      bounces: 0,
      fuel: 1,
      lit: true,
      swayX: 0,
      swayY: 0,
      swayVX: 0,
      swayVY: 0,
      flameH: 1,
      landFlash: 0,
    });
  }
  for (let i = 0; i < SHELL_POOL; i++) {
    eq.shells.push({
      active: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      rot: 0,
      spin: 0,
      life: 0,
      airborne: false,
      bounces: 0,
    });
  }
  for (let i = 0; i < FLARE_ARC_POOL; i++) {
    eq.flareArcs.push({ active: false, id: 0, z: 0, vz: 0 });
  }
  return eq;
}

/** engine.reset 时调用：恢复默认装备（左手手电 + 右手火把，弹匣满） */
export function resetEquipment(eq: EquipmentState, seed: number) {
  eq.mode = 'torch';
  eq.torchInHand = true;
  eq.torchFuel = 1;
  eq.torchLit = true;
  eq.mag = PISTOL_MAG_SIZE;
  eq.fireCd = 0;
  eq.shotsFired = 0;
  eq.dryFires = 0;
  eq.hits = 0;
  eq.gesture = 'none';
  eq.gT = 0;
  eq.gDur = 0;
  eq.gEventDone = false;
  eq.pistolW = 0;
  eq.recoil = 0;
  eq.muzzleFlash = 0;
  eq.tracer = 0;
  eq.headInit = false;
  eq.headVX = 0;
  eq.headVY = 0;
  eq.flameX = 0;
  eq.flameY = 0;
  eq.flameVX = 0;
  eq.flameVY = 0;
  eq.flameH = 1;
  eq.flameStretch = 0;
  eq.torchLight = 1;
  eq.rainExposure = 0;
  eq.whooshCd = 0;
  eq.sparkAccum = 0;
  eq.emberAccum = 0;
  eq.steamAccum = 0;
  eq.toastCd = 0;
  eq.hintDropShown = false;
  for (let i = 0; i < eq.groundTorches.length; i++) eq.groundTorches[i].active = false;
  for (let i = 0; i < eq.shells.length; i++) eq.shells[i].active = false;
  for (let i = 0; i < eq.flareArcs.length; i++) eq.flareArcs[i].active = false;
  eq.shellCursor = 0;
  eq.flareCursor = 0;
  eq.rng = createRng((seed ^ 0x51f7) >>> 0);
}

/** 确定性分配手枪子弹掉落：尸体/工具箱/板条箱/背包中少量出现（保持稀缺） */
export function assignAmmoLoot(eq: EquipmentState, containers: LootContainer[]) {
  eq.ammoLoot.clear();
  for (let i = 0; i < containers.length; i++) {
    const c = containers[i];
    const chance =
      c.kind === 'corpse' ? 0.45 : c.kind === 'toolbox' ? 0.35 : c.kind === 'crate' ? 0.25 : c.kind === 'backpack' ? 0.2 : 0;
    if (chance <= 0) continue;
    const h = hashStr(c.id);
    if ((h % 1000) / 1000 >= chance) continue;
    const n = 1 + ((h >>> 10) % 3) + (c.kind === 'corpse' ? 1 : 0);
    eq.ammoLoot.set(c.id, n);
  }
}

/** 搜刮完成时追加子弹掉落；返回 toast 片段（无则 null）。再次刷新的容器掉落减半 */
export function equipLootBonus(engine: GameEngine, c: LootContainer): string | null {
  const eq = engine.equip;
  const n = eq.ammoLoot.get(c.id) ?? 0;
  if (n <= 0) return null;
  engine.inv.ammo += n;
  eq.ammoLoot.set(c.id, Math.floor(n / 2));
  return `${I18n.t('手枪子弹')} ×${n}`;
}

// ---------------------------------------------------------------------------
// 状态查询（engine / renderer / HUD 只读）
// ---------------------------------------------------------------------------

/** 手势进行中（后坐不算忙，可连续扣扳机） */
export function equipBusy(eq: EquipmentState): boolean {
  return eq.gesture !== 'none' && eq.gesture !== 'recoil';
}

/** 是否禁止近战挥击：手枪模式或手势进行中 */
export function equipBlocksMelee(eq: EquipmentState): boolean {
  return eq.mode === 'pistol' || !eq.torchInHand || equipBusy(eq);
}

/** 手势对移速的单一账本系数（engine updatePlayer 乘入） */
export function equipSpeedMul(eq: EquipmentState): number {
  switch (eq.gesture) {
    case 'pickup':
      return 0.45;
    case 'setTrap':
      return 0.35;
    case 'reload':
      return 0.82;
    case 'retorch':
      return 0.55;
    case 'dropTorch':
      return 0.9;
    default:
      return 1;
  }
}

export function gestureProgress(eq: EquipmentState): number {
  if (eq.gesture === 'none' || eq.gDur <= 0) return 0;
  return clamp(eq.gT / eq.gDur, 0, 1);
}

function envelope(pr: number, a: number, b: number): number {
  return clamp(Math.min(pr / a, (1 - pr) / b), 0, 1);
}

/** 右臂（火把/持枪手）手势覆盖。engine 计算火把头位置与 renderer 绘制共用同一曲线（单源） */
export function gestureRightArm(eq: EquipmentState, out: ArmPose): ArmPose {
  out.a = 0.25;
  out.len = 13;
  out.twist = 0;
  out.w = 0;
  const g = eq.gesture;
  if (g === 'none' || g === 'recoil') return out;
  const pr = gestureProgress(eq);
  if (g === 'dropTorch') {
    // 侧身甩手：先把火把收向身前（蓄势）→ 向右侧外甩出手 → 收回
    out.w = 1;
    if (pr < 0.25) {
      const k = easeInOut(pr / 0.25);
      out.a = lerp(0.25, 0.95, k);
      out.twist = lerp(0, 0.28, k);
    } else if (pr < 0.45) {
      const k = easeOut((pr - 0.25) / 0.2);
      out.a = lerp(0.95, -1.75, k);
      out.twist = lerp(0.28, -0.42, k);
      out.len = lerp(13, 15.5, k);
    } else {
      const k = easeInOut((pr - 0.45) / 0.55);
      out.a = lerp(-1.75, -0.6, k);
      out.twist = lerp(-0.42, 0, k);
      out.len = lerp(15.5, 11, k);
    }
  } else if (g === 'draw') {
    // 拔枪：手探向右胯枪套 → 抽枪前举（结束时与持枪姿态重合，权重归零无跳变）
    out.w = Math.sin(pr * Math.PI);
    if (pr < 0.5) {
      out.a = -1.95;
      out.len = 7;
    } else {
      const k = easeInOut((pr - 0.5) / 0.5);
      out.a = lerp(-1.95, 0.06, k);
      out.len = lerp(7, 16, k);
    }
  } else if (g === 'pickup') {
    // 弯腰探手抓起地上的火把
    const env = Math.sin(pr * Math.PI);
    out.w = clamp(env * 1.4, 0, 1);
    out.a = 0.05;
    out.len = lerp(13, 20, env);
  } else if (g === 'throwFlare') {
    // 右臂不动，躯干随左臂后摆—前抛扭转（火把头随之被甩动，火焰相应摆动）
    if (pr < 0.45) out.twist = lerp(0, 0.32, easeInOut(pr / 0.45));
    else if (pr < 0.62) out.twist = lerp(0.32, -0.36, easeOut((pr - 0.45) / 0.17));
    else out.twist = lerp(-0.36, 0, easeInOut((pr - 0.62) / 0.38));
  } else if (g === 'setTrap') {
    // 蹲下双手前伸按压
    const env = envelope(pr, 0.22, 0.2);
    const press = pr > 0.42 && pr < 0.72 ? Math.sin(((pr - 0.42) / 0.3) * Math.PI) : 0;
    out.w = env;
    out.a = 0.42;
    out.len = 16 - press * 3.5;
  } else if (g === 'reload') {
    // 换弹：持枪手收回身前
    out.w = envelope(pr, 0.16, 0.16);
    out.a = 0.7;
    out.len = 10;
  } else if (g === 'retorch') {
    out.w = envelope(pr, 0.18, 0.18);
    out.a = 0.55;
    out.len = 11;
  }
  return out;
}

/** 左手（手电手）手势目标点 */
export function gestureLeftHand(eq: EquipmentState, out: HandPose): HandPose {
  out.x = 13;
  out.y = 8.2;
  out.w = 0;
  const g = eq.gesture;
  if (g === 'none' || g === 'recoil' || g === 'draw' || g === 'dropTorch') return out;
  const pr = gestureProgress(eq);
  if (g === 'throwFlare') {
    // 后摆 → 前抛（0.5 出手）→ 收回
    out.w = 1;
    if (pr < 0.45) {
      const k = easeInOut(pr / 0.45);
      out.x = lerp(13, -6, k);
      out.y = lerp(8.2, 14, k);
    } else if (pr < 0.62) {
      const k = easeOut((pr - 0.45) / 0.17);
      out.x = lerp(-6, 22, k);
      out.y = lerp(14, 3.5, k);
    } else {
      const k = easeInOut((pr - 0.62) / 0.38);
      out.x = lerp(22, 13, k);
      out.y = lerp(3.5, 8.2, k);
    }
  } else if (g === 'setTrap') {
    out.w = envelope(pr, 0.22, 0.2);
    out.x = 18;
    out.y = 4.5;
  } else if (g === 'pickup') {
    out.w = Math.sin(pr * Math.PI) * 0.7;
    out.x = 9;
    out.y = 10;
  } else if (g === 'reload') {
    // 左手：腰间取弹匣 → 插入握把 → 回到交叉托手电位
    out.w = 1;
    if (pr < 0.35) {
      const k = easeInOut(pr / 0.35);
      out.x = lerp(15, -1, k);
      out.y = lerp(-1.5, 12.5, k);
    } else if (pr < 0.75) {
      const k = easeInOut((pr - 0.35) / 0.4);
      out.x = lerp(-1, 13, k);
      out.y = lerp(12.5, -3.5, k);
    } else {
      const k = easeInOut((pr - 0.75) / 0.25);
      out.x = lerp(13, 15, k);
      out.y = lerp(-3.5, -1.5, k);
    }
  } else if (g === 'retorch') {
    // 左手绕火把头缠布
    out.w = envelope(pr, 0.18, 0.18);
    out.x = 20 + Math.cos(pr * Math.PI * 6) * 3.2;
    out.y = -3 + Math.sin(pr * Math.PI * 6) * 3.2;
  }
  return out;
}

/** 手势蹲伏量 0..1 */
export function gestureCrouch(eq: EquipmentState): number {
  const pr = gestureProgress(eq);
  switch (eq.gesture) {
    case 'pickup':
      return Math.sin(pr * Math.PI);
    case 'setTrap':
      return envelope(pr, 0.22, 0.2) * 0.9;
    case 'reload':
      return envelope(pr, 0.16, 0.16) * 0.12;
    case 'retorch':
      return envelope(pr, 0.18, 0.18) * 0.3;
    default:
      return 0;
  }
}

/** 手势低头量 0..1（换弹低头看弹匣、缠布、按压陷阱、弯腰捡拾） */
export function gestureHeadDip(eq: EquipmentState): number {
  const pr = gestureProgress(eq);
  switch (eq.gesture) {
    case 'reload':
      return envelope(pr, 0.16, 0.16);
    case 'retorch':
      return envelope(pr, 0.18, 0.18) * 0.6;
    case 'setTrap':
      return envelope(pr, 0.22, 0.2) * 0.5;
    case 'pickup':
      return Math.sin(pr * Math.PI) * 0.7;
    default:
      return 0;
  }
}

/** 照明弹离地高度（抛物线；renderer 只读） */
export function getFlareZ(eq: EquipmentState, id: number): number {
  for (let i = 0; i < eq.flareArcs.length; i++) {
    const fa = eq.flareArcs[i];
    if (fa.active && fa.id === id) return fa.z;
  }
  return 0;
}

export function nearestGroundTorch(eq: EquipmentState, x: number, y: number, maxD: number): GroundTorch | null {
  let best: GroundTorch | null = null;
  let bestD = maxD;
  for (let i = 0; i < eq.groundTorches.length; i++) {
    const gt = eq.groundTorches[i];
    if (!gt.active) continue;
    const d = dist(x, y, gt.x, gt.y);
    if (d < bestD) {
      bestD = d;
      best = gt;
    }
  }
  return best;
}

/** 交互提示：靠近地上的火把（复用预分配对象） */
export function equipPrompt(engine: GameEngine): InteractPrompt | null {
  const eq = engine.equip;
  if (eq.torchInHand || equipBusy(eq)) return null;
  const p = engine.player;
  const gt = nearestGroundTorch(eq, p.x, p.y, TORCH_PICKUP_RADIUS);
  if (!gt || gt.airborne) return null;
  const pr = eq.prompt;
  pr.label = '按 E 捡起火把';
  pr.worldX = gt.x;
  pr.worldY = gt.y - 22;
  pr.progress = 0;
  pr.hold = false;
  return pr;
}

export function equipHudInfo(engine: GameEngine) {
  const eq = engine.equip;
  return {
    mode: eq.mode,
    mag: eq.mag,
    magSize: PISTOL_MAG_SIZE,
    reserve: engine.inv.ammo,
    torchInHand: eq.torchInHand,
    torchLit: eq.torchLit,
    torchFuel: Math.round(eq.torchFuel * 100),
    reloading: eq.gesture === 'reload',
  };
}

/** 模态切换/暂停时静音持续燃烧声 */
export function equipSilence() {
  SFX.setTorchBurn?.(0, 0);
  SFX.setGroundTorchBurn?.(0);
}

// ---------------------------------------------------------------------------
// 玩家指令（engine 公共方法转发）
// ---------------------------------------------------------------------------

function cancelCharge(engine: GameEngine) {
  const p = engine.player;
  // 蓄力音频由 engine.updatePlayer 在 !isCharging 时统一归零
  p.isCharging = false;
  p.chargeTimer = 0;
}

function beginPickup(engine: GameEngine, gt: GroundTorch): boolean {
  const eq = engine.equip;
  cancelCharge(engine);
  engine.cancelAction();
  if (eq.mode === 'pistol') SFX.playWeaponSwap?.(false);
  startGesture(eq, 'pickup', gt.x, gt.y, gt.id);
  engine.emitHud();
  return true;
}

/** Q：火把 ⇄ 手枪 */
export function equipToggleWeapon(engine: GameEngine): boolean {
  if (engine.mode !== 'play') return false;
  const eq = engine.equip;
  const p = engine.player;
  if (equipBusy(eq) || engine.draggedFurnitureId || p.dodgeTimer > 0) return false;
  if (eq.mode === 'torch') {
    cancelCharge(engine);
    engine.cancelAction();
    if (eq.torchInHand) {
      startGesture(eq, 'dropTorch');
    } else {
      eq.mode = 'pistol';
      startGesture(eq, 'draw');
      SFX.playWeaponSwap?.(true);
    }
    engine.emitHud();
    return true;
  }
  // 手枪 → 火把：只能捡回地上的火把
  const gt = nearestGroundTorch(eq, p.x, p.y, 72);
  if (gt && !gt.airborne) return beginPickup(engine, gt);
  if (eq.toastCd <= 0) {
    engine.pushToast('火把在地上——靠近按 E 捡回', 'info');
    eq.toastCd = 2.5;
  }
  return false;
}

/** E：捡回地上的火把（优先级在松开家具之后、其他交互之前） */
export function equipTryPickup(engine: GameEngine): boolean {
  const eq = engine.equip;
  if (eq.torchInHand || equipBusy(eq)) return false;
  const p = engine.player;
  const gt = nearestGroundTorch(eq, p.x, p.y, TORCH_PICKUP_RADIUS);
  if (!gt || gt.airborne) return false;
  return beginPickup(engine, gt);
}

/** R：手枪换弹 / 火把模式下用木材+燃油重缠点燃 */
export function equipReload(engine: GameEngine): boolean {
  if (engine.mode !== 'play') return false;
  const eq = engine.equip;
  const p = engine.player;
  if (equipBusy(eq) || p.dodgeTimer > 0) return false;
  if (eq.mode === 'pistol') {
    if (eq.mag >= PISTOL_MAG_SIZE) return false;
    if (engine.inv.ammo <= 0) {
      if (eq.toastCd <= 0) {
        engine.pushToast('没有备用子弹', 'warn');
        eq.toastCd = 2;
      }
      return false;
    }
    engine.cancelAction();
    startGesture(eq, 'reload');
    SFX.playPistolReload?.();
    engine.emitHud();
    return true;
  }
  if (!eq.torchInHand) return false;
  if (eq.torchLit && eq.torchFuel > 0.7) {
    if (eq.toastCd <= 0) {
      engine.pushToast('火把还很旺', 'info');
      eq.toastCd = 2;
    }
    return false;
  }
  if (engine.inv.wood < RETORCH_COST.wood || engine.inv.fuel < RETORCH_COST.fuel) {
    if (eq.toastCd <= 0) {
      engine.pushToast('重新点燃火把需要 木材×1 + 燃油×1', 'warn');
      eq.toastCd = 2;
    }
    return false;
  }
  cancelCharge(engine);
  engine.cancelAction();
  startGesture(eq, 'retorch');
  engine.emitHud();
  return true;
}

/** 照明弹：后摆—前抛手势（0.5 出手时才生成照明弹实体）；返回 false 表示正忙未开始 */
export function equipBeginThrowFlare(engine: GameEngine): boolean {
  const eq = engine.equip;
  if (equipBusy(eq)) return false;
  startGesture(eq, 'throwFlare');
  return true;
}

/** 捕兽夹：蹲下按压手势（0.62 时陷阱张开咔哒落地） */
export function equipBeginSetTrap(engine: GameEngine): boolean {
  const eq = engine.equip;
  if (equipBusy(eq)) return false;
  engine.cancelAction();
  startGesture(eq, 'setTrap');
  return true;
}

/** 左键（手枪模式）：射击 / 空仓空响 */
export function equipFire(engine: GameEngine, host: EquipHost): boolean {
  if (engine.mode !== 'play') return false;
  const eq = engine.equip;
  const p = engine.player;
  if (eq.mode !== 'pistol') return false;
  if (equipBusy(eq) || eq.pistolW < 0.85) return false;
  if (eq.fireCd > 0 || p.dodgeTimer > 0 || engine.draggedFurnitureId) return false;

  if (eq.mag <= 0) {
    SFX.playDryFire?.();
    eq.dryFires++;
    eq.fireCd = 0.25;
    if (eq.toastCd <= 0) {
      engine.pushToast(engine.inv.ammo > 0 ? '弹匣已空——按 R 换弹' : '没有子弹了', 'warn');
      eq.toastCd = 2.2;
    }
    return false;
  }

  engine.cancelAction();
  eq.mag--;
  eq.shotsFired++;
  eq.fireCd = PISTOL_FIRE_CD;
  eq.recoil = 1;
  eq.muzzleFlash = 0.05;
  startGesture(eq, 'recoil');

  const ca = Math.cos(p.angle);
  const sa = Math.sin(p.angle);
  // 枪口：右手前伸（局部 (27,-2.5)）
  eq.muzzleX = p.x + ca * 27 + sa * 2.5;
  eq.muzzleY = p.y + sa * 27 - ca * 2.5;

  // 散布：静止精准，移动/疾跑变差
  const spread = 0.018 + p.pose.move * 0.03 + p.pose.sprint * 0.05;
  const ang = p.angle + (eq.rng() * 2 - 1) * spread;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  // 射线从角色中心发出（贴墙时枪口不穿墙），只读现有遮挡数据
  const ox = p.x;
  const oy = p.y;
  const segs = collectOccluderSegments(engine.world, ox, oy, PISTOL_RANGE, eq.segScratch);
  let wallT = PISTOL_RANGE;
  for (let i = 4; i < segs.length; i++) {
    const s = segs[i];
    const t = raySegmentIntersect(ox, oy, dx, dy, s.ax, s.ay, s.bx, s.by);
    if (t < wallT) wallT = t;
  }

  let bestIdx = -1;
  let bestT = wallT;
  for (let i = 0; i < engine.enemies.length; i++) {
    const e = engine.enemies[i];
    const rx = e.x - ox;
    const ry = e.y - oy;
    const proj = rx * dx + ry * dy;
    if (proj < 0 || proj > bestT + e.r) continue;
    const perp = Math.abs(rx * dy - ry * dx);
    const rr = e.r + 3;
    if (perp > rr) continue;
    const t = Math.max(0, proj - Math.sqrt(Math.max(0, rr * rr - perp * perp)));
    if (t < bestT) {
      bestT = t;
      bestIdx = i;
    }
  }

  const endT = bestIdx >= 0 ? bestT : wallT;
  eq.tracer = 0.07;
  eq.tracerX0 = eq.muzzleX;
  eq.tracerY0 = eq.muzzleY;
  eq.tracerX1 = ox + dx * endT;
  eq.tracerY1 = oy + dy * endT;

  if (bestIdx >= 0) {
    const e = engine.enemies[bestIdx];
    eq.hits++;
    e.hp -= PISTOL_DAMAGE;
    e.hitFlash = 0.3;
    e.vx += dx * PISTOL_KNOCKBACK;
    e.vy += dy * PISTOL_KNOCKBACK;
    if (e.windup > 0) {
      e.windup = 0;
      e.attackCd = Math.max(e.attackCd, 0.5);
    }
    if (e.state !== 'flee_dawn' && e.state !== 'snared') e.state = 'chase';
    const nb = Math.max(3, Math.round(14 * Quality.preset.particleScale));
    for (let k = 0; k < nb; k++) {
      const a2 = ang + (eq.rng() - 0.5) * 1.1;
      const s2 = 60 + eq.rng() * 150;
      spawnParticle(engine, e.x, e.y, Math.cos(a2) * s2, Math.sin(a2) * s2, 2 + eq.rng() * 2.6, 0.35 + eq.rng() * 0.3, '#7c1717', 'blood');
    }
    engine.pushDecal({
      kind: 'splatter',
      x: e.x + dx * 20,
      y: e.y + dy * 20,
      angle: ang,
      scale: 1.35,
      seed: eq.rng() * 100,
    });
    engine.hitStop = Math.max(engine.hitStop, 0.03);
    if (e.hp <= 0) {
      engine.pushDecal({ kind: 'blood', x: e.x, y: e.y, angle: ang, scale: 1.4, seed: eq.rng() * 100 });
      host.killEnemy(bestIdx, ang);
    }
  } else if (wallT < PISTOL_RANGE) {
    // 打在墙/树/石上：火星 + 木屑尘
    const hx = ox + dx * (wallT - 1);
    const hy = oy + dy * (wallT - 1);
    for (let k = 0; k < 5; k++) {
      const a2 = ang + Math.PI + (eq.rng() - 0.5) * 1.6;
      const s2 = 50 + eq.rng() * 110;
      spawnParticle(engine, hx, hy, Math.cos(a2) * s2, Math.sin(a2) * s2, 1 + eq.rng(), 0.18 + eq.rng() * 0.2, '#ffd194', 'spark');
    }
    spawnParticle(engine, hx, hy, -dx * 18, -dy * 18 - 8, 3.5, 0.6, 'rgba(120, 112, 98, 0.5)', 'dust');
    engine.pushDecal({ kind: 'scorch', x: hx, y: hy, angle: ang, scale: 0.22, seed: eq.rng() * 100 });
  }

  // 枪口火光的火星与硝烟
  for (let k = 0; k < 3; k++) {
    const a2 = ang + (eq.rng() - 0.5) * 0.7;
    const s2 = 120 + eq.rng() * 160;
    spawnParticle(engine, eq.muzzleX, eq.muzzleY, Math.cos(a2) * s2, Math.sin(a2) * s2, 1 + eq.rng(), 0.12 + eq.rng() * 0.1, '#ffe2a0', 'spark');
  }
  spawnParticle(engine, eq.muzzleX + dx * 4, eq.muzzleY + dy * 4, dx * 26, dy * 26 - 10, 4.5, 0.9, 'rgba(150, 146, 136, 0.38)', 'smoke');

  // 弹壳：从右侧抛壳窗弹出
  const sh = eq.shells[eq.shellCursor];
  eq.shellCursor = (eq.shellCursor + 1) % eq.shells.length;
  sh.active = true;
  sh.x = p.x + ca * 16 + sa * 7;
  sh.y = p.y + sa * 16 - ca * 7;
  sh.z = 14;
  const side = 80 + eq.rng() * 40;
  sh.vx = sa * side - ca * 22 + p.vx * 0.4;
  sh.vy = -ca * side - sa * 22 + p.vy * 0.4;
  sh.vz = 105 + eq.rng() * 40;
  sh.rot = eq.rng() * Math.PI * 2;
  sh.spin = (eq.rng() < 0.5 ? -1 : 1) * (18 + eq.rng() * 10);
  sh.life = 7;
  sh.airborne = true;
  sh.bounces = 0;

  // 震屏 + 噪声涟漪 + 惊飞乌鸦 + 吸引怪物
  engine.shake = Math.min(14, engine.shake + 5.5);
  host.emitRipple(p.x, p.y, 430, 'rgba(236, 210, 160, 0.55)');
  host.crowAlarmAt(p.x, p.y, 720, true);
  for (let i = 0; i < engine.enemies.length; i++) {
    const e = engine.enemies[i];
    if (e.state === 'flee_dawn') continue;
    const d = dist(e.x, e.y, p.x, p.y);
    if (d < 900) {
      e.patrolX = p.x;
      e.patrolY = p.y;
      if (d < 650 && e.state === 'prowl') e.state = 'chase';
    }
  }
  SFX.playGunshot?.();
  engine.emitHud();
  return true;
}

// ---------------------------------------------------------------------------
// 每步推进（engine.step 内、updatePlayer 之后调用）
// ---------------------------------------------------------------------------

/** 近战挥击时的右臂基础角（与 renderer 挥砍曲线一致的简化版，仅用于火把头运动学） */
function baseTorchArm(engine: GameEngine, out: ArmPose) {
  const p = engine.player;
  const dir = p.swingDir;
  const ch = clamp(p.pose.charge, 0, 1);
  let a = lerp(0.25, 1.28 * dir, ch);
  let twist = lerp(0, 0.32 * dir, ch);
  if (p.swingTimer > 0 && !p.isCharging && p.swingDuration > 0) {
    const prog = 1 - p.swingTimer / p.swingDuration;
    const startA = -1.22 * dir;
    const endA = 1.12 * dir;
    if (prog < 0.22) a = startA;
    else if (prog < 0.72) {
      const k = (prog - 0.22) / 0.5;
      a = lerp(startA, endA, 1 - (1 - k) * (1 - k));
    } else a = lerp(endA, 0.25, easeInOut((prog - 0.72) / 0.28));
    twist = a * 0.3;
  } else {
    // 行走/疾跑摆臂（与 renderer 一致：左脚在前时右臂前摆）
    const g = Math.cos(Math.PI * p.pose.gait) * p.pose.move;
    a = lerp(a - g * 0.16, -1.15 + g * 0.95, p.pose.sprint * (1 - ch));
  }
  out.a = a;
  out.len = 13;
  out.twist = twist;
  out.w = 0;
}

function updateTorchHead(engine: GameEngine) {
  const eq = engine.equip;
  const p = engine.player;
  baseTorchArm(engine, eq.armBase);
  const g = gestureRightArm(eq, eq.armGesture);
  const a = lerp(eq.armBase.a, g.a, g.w);
  const len = lerp(eq.armBase.len, g.len, g.w);
  const twist = eq.armBase.twist + g.twist;
  const reach = len + 19;
  const lx = 3 + Math.cos(a) * reach;
  const ly = -10.5 + Math.sin(a) * reach;
  const ct = Math.cos(twist);
  const st = Math.sin(twist);
  const qx = ct * lx - st * ly;
  const qy = st * lx + ct * ly;
  const ca = Math.cos(p.angle);
  const sa = Math.sin(p.angle);
  eq.headX = p.x + ca * qx - sa * qy;
  eq.headY = p.y + sa * qx + ca * qy;
}

function fireGestureEvent(engine: GameEngine, host: EquipHost, g: EquipGesture) {
  const eq = engine.equip;
  const p = engine.player;
  const ca = Math.cos(p.angle);
  const sa = Math.sin(p.angle);
  if (g === 'dropTorch') {
    // 火把出手：向身体右侧（局部 -y）抛出，抛物线落地
    let gt: GroundTorch = eq.groundTorches[0];
    for (let i = 0; i < eq.groundTorches.length; i++) {
      if (!eq.groundTorches[i].active) {
        gt = eq.groundTorches[i];
        break;
      }
    }
    const sideX = sa;
    const sideY = -ca;
    gt.active = true;
    gt.id = host.nextId();
    gt.x = eq.headX;
    gt.y = eq.headY;
    gt.z = 16;
    gt.vx = sideX * 125 + ca * 35 + p.vx * 0.5;
    gt.vy = sideY * 125 + sa * 35 + p.vy * 0.5;
    gt.vz = 150;
    gt.rot = p.angle - 1.2;
    gt.spin = eq.rng() < 0.5 ? -10 : 10;
    gt.airborne = true;
    gt.bounces = 0;
    gt.fuel = eq.torchFuel;
    gt.lit = eq.torchLit;
    gt.swayX = eq.flameX;
    gt.swayY = eq.flameY;
    gt.swayVX = eq.flameVX;
    gt.swayVY = eq.flameVY;
    gt.flameH = eq.flameH;
    gt.landFlash = 0;
    eq.torchInHand = false;
    eq.flameH = 0;
    eq.torchLight = 0;
    if (gt.lit) sparkBurst(engine, eq.headX, eq.headY, 6, 90);
    SFX.playThrow?.('torch');
    if (!eq.hintDropShown) {
      eq.hintDropShown = true;
      engine.pushToast('火把丢在了身侧——靠近按 E 捡回', 'info');
    }
  } else if (g === 'pickup') {
    let gt: GroundTorch | null = null;
    for (let i = 0; i < eq.groundTorches.length; i++) {
      const c = eq.groundTorches[i];
      if (c.active && c.id === eq.gTargetId) gt = c;
    }
    if (gt && dist(gt.x, gt.y, p.x, p.y) < 84) {
      gt.active = false;
      eq.torchInHand = true;
      eq.torchFuel = gt.fuel;
      eq.torchLit = gt.lit;
      eq.flameH = gt.flameH;
      eq.flameX = 0;
      eq.flameY = 0;
      eq.flameVX = 0;
      eq.flameVY = 0;
      eq.headInit = false;
      eq.mode = 'torch';
      SFX.playTorchPickup?.();
      if (gt.lit) sparkBurst(engine, gt.x, gt.y, 5, 60);
      engine.emitHud();
    }
  } else if (g === 'throwFlare') {
    // 左手出手点（局部 (16, +6)），沿当前瞄准方向抛出
    const hx = p.x + ca * 16 - sa * 6;
    const hy = p.y + sa * 16 + ca * 6;
    const id = host.nextId();
    engine.flares.push({
      id,
      x: hx,
      y: hy,
      vx: ca * 290,
      vy: sa * 290,
      life: 22,
      maxLife: 22,
    });
    const fa = eq.flareArcs[eq.flareCursor];
    eq.flareCursor = (eq.flareCursor + 1) % eq.flareArcs.length;
    fa.active = true;
    fa.id = id;
    fa.z = 18;
    fa.vz = 170;
    SFX.playThrow?.('flare');
    AudioFX.playFlareHiss();
    engine.pushToast('投掷了照明弹！', 'info');
    engine.emitHud();
  } else if (g === 'setTrap') {
    const tx = p.x + ca * 24;
    const ty = p.y + sa * 24;
    engine.traps.push({
      id: host.nextId(),
      x: tx,
      y: ty,
      armed: true,
      snaredTimer: 0,
      openT: 0,
    });
    AudioFX.playImpact('metal');
    SFX.playTrapSet?.();
    host.emitRipple(tx, ty, 95, 'rgba(196, 202, 192, 0.32)');
    spawnParticle(engine, tx, ty, 0, -10, 4, 0.5, 'rgba(120, 112, 98, 0.45)', 'dust');
    engine.pushToast('放置了捕兽夹', 'info');
    engine.emitHud();
  } else if (g === 'reload') {
    const need = PISTOL_MAG_SIZE - eq.mag;
    const take = Math.min(need, engine.inv.ammo);
    if (take > 0) {
      eq.mag += take;
      engine.inv.ammo -= take;
    }
    engine.emitHud();
  } else if (g === 'retorch') {
    if (engine.inv.wood >= RETORCH_COST.wood && engine.inv.fuel >= RETORCH_COST.fuel) {
      engine.inv.wood -= RETORCH_COST.wood;
      engine.inv.fuel -= RETORCH_COST.fuel;
      eq.torchFuel = 1;
      eq.torchLit = true;
      sparkBurst(engine, eq.headX, eq.headY, 10, 80);
      engine.pushToast('火把重新燃起来了', 'loot');
      engine.emitHud();
    }
  }
}

function onGestureEnd(engine: GameEngine, g: EquipGesture) {
  const eq = engine.equip;
  if (g === 'dropTorch') {
    // 丢完火把顺势拔枪
    eq.mode = 'pistol';
    startGesture(eq, 'draw');
    SFX.playWeaponSwap?.(true);
    engine.emitHud();
  } else if (g === 'draw' || g === 'pickup' || g === 'reload' || g === 'retorch') {
    engine.emitHud();
  }
}

export function updateEquipment(engine: GameEngine, host: EquipHost, dt: number) {
  const eq = engine.equip;
  const p = engine.player;
  const w = engine.weather;
  const pScale = Quality.preset.particleScale;

  eq.fireCd = Math.max(0, eq.fireCd - dt);
  eq.recoil = Math.max(0, eq.recoil - dt * 5.5);
  eq.muzzleFlash = Math.max(0, eq.muzzleFlash - dt);
  eq.tracer = Math.max(0, eq.tracer - dt);
  eq.whooshCd = Math.max(0, eq.whooshCd - dt);
  eq.toastCd = Math.max(0, eq.toastCd - dt);

  // 1. 火把头位置（先于手势事件：丢出时用最新手位）
  updateTorchHead(engine);

  // 2. 手势状态机：none →(指令)→ gesture →(生效时刻)→ 事件 →(时长满)→ none（丢火把结束自动接拔枪）
  if (eq.gesture !== 'none') {
    const g = eq.gesture;
    if (p.dodgeTimer > 0 && !eq.gEventDone && (g === 'reload' || g === 'retorch' || g === 'pickup')) {
      // 闪避打断：未生效即零消耗
      eq.gesture = 'none';
      eq.gT = 0;
    } else {
      eq.gT += dt;
      const prog = eq.gDur > 0 ? eq.gT / eq.gDur : 1;
      if (!eq.gEventDone && prog >= GESTURE_EVENT[g]) {
        eq.gEventDone = true;
        fireGestureEvent(engine, host, g);
      }
      if (eq.gT >= eq.gDur) {
        eq.gesture = 'none';
        eq.gT = 0;
        onGestureEnd(engine, g);
      }
    }
  }

  // 3. 持枪姿态混合（拔枪随手势推进；捡火把/收枪平滑淡出）
  if (eq.gesture === 'draw') eq.pistolW = easeInOut(gestureProgress(eq));
  else eq.pistolW = expDecay(eq.pistolW, eq.mode === 'pistol' && eq.gesture !== 'pickup' ? 1 : 0, 12, dt);

  // 4. 火把头速度 → 火焰欠阻尼弹簧
  let hvx = 0;
  let hvy = 0;
  if (eq.headInit && dt > 0) {
    hvx = clamp((eq.headX - eq.prevHeadX) / dt, -1600, 1600);
    hvy = clamp((eq.headY - eq.prevHeadY) / dt, -1600, 1600);
  }
  eq.headInit = true;
  eq.prevHeadX = eq.headX;
  eq.prevHeadY = eq.headY;
  eq.headVX = hvx;
  eq.headVY = hvy;
  const speed = Math.hypot(hvx, hvy);
  const indoor = isPointInHideout(eq.headX, eq.headY);
  eq.rainExposure = indoor ? 0 : clamp(w.rainIntensity, 0, 1);
  const windMag = indoor ? FLAME_PHYS.windIndoor : FLAME_PHYS.windBase + eq.rainExposure * FLAME_PHYS.windRain;
  const wcx = Math.cos(w.windAngle);
  const wcy = Math.sin(w.windAngle);
  let tx = -hvx * FLAME_PHYS.dragK + wcx * windMag;
  let ty = -hvy * FLAME_PHYS.dragK + wcy * windMag;
  const tl = Math.hypot(tx, ty);
  if (tl > FLAME_PHYS.maxOffset) {
    tx *= FLAME_PHYS.maxOffset / tl;
    ty *= FLAME_PHYS.maxOffset / tl;
  }
  eq.flameVX += (FLAME_PHYS.stiffness * (tx - eq.flameX) - FLAME_PHYS.damping * eq.flameVX) * dt;
  eq.flameVY += (FLAME_PHYS.stiffness * (ty - eq.flameY) - FLAME_PHYS.damping * eq.flameVY) * dt;
  eq.flameX += eq.flameVX * dt;
  eq.flameY += eq.flameVY * dt;
  const fl = Math.hypot(eq.flameX, eq.flameY);
  const flMax = FLAME_PHYS.maxOffset * 1.15;
  if (fl > flMax) {
    eq.flameX *= flMax / fl;
    eq.flameY *= flMax / fl;
  }
  eq.flameStretch = clamp(Math.min(fl, flMax) / FLAME_PHYS.maxOffset, 0, 1);

  // 5. 手持火把燃料
  const lit = eq.torchInHand && eq.torchLit;
  if (lit) {
    eq.torchFuel = Math.max(0, eq.torchFuel - dt * TORCH_BURN_HELD * (1 + eq.rainExposure * 0.6));
    if (eq.torchFuel <= 0) {
      eq.torchLit = false;
      for (let k = 0; k < 4; k++) {
        spawnParticle(engine, eq.headX, eq.headY, (eq.rng() - 0.5) * 16, -18 - eq.rng() * 12, 4 + eq.rng() * 3, 1.2, 'rgba(84, 80, 76, 0.4)', 'smoke');
      }
      engine.pushToast('火把熄灭了——按 R 用木材+燃油重新点燃', 'warn');
      engine.emitHud();
    }
  }
  const fuelK = clamp(eq.torchFuel / 0.25, 0, 1);
  const litNow = eq.torchInHand && eq.torchLit;
  const hTarget = litNow
    ? (1 - 0.36 * eq.rainExposure) * (0.45 + 0.55 * fuelK) * (1 - 0.22 * eq.flameStretch)
    : 0;
  eq.flameH = expDecay(eq.flameH, hTarget, litNow ? 7 : 12, dt);
  eq.torchLight = eq.flameH * (1 - 0.18 * eq.flameStretch);

  // 6. 火星拖尾 / 余烬 / 雨汽 / 挥动呼呼声
  if (litNow) {
    if (speed > FLAME_PHYS.sparkSpeed) {
      eq.sparkAccum += dt * 70 * clamp((speed - FLAME_PHYS.sparkSpeed) / 420, 0, 1) * pScale;
      while (eq.sparkAccum >= 1) {
        eq.sparkAccum -= 1;
        const hot = eq.rng();
        spawnParticle(
          engine,
          eq.headX + (eq.rng() - 0.5) * 4,
          eq.headY + (eq.rng() - 0.5) * 4,
          -hvx * 0.12 + (eq.rng() - 0.5) * 40,
          -hvy * 0.12 + (eq.rng() - 0.5) * 40 - 10,
          1 + eq.rng() * 1.3,
          0.28 + eq.rng() * 0.25,
          hot < 0.35 ? '#fff0b8' : '#ff9d3b',
          'ember'
        );
      }
    } else {
      eq.sparkAccum = 0;
    }
    eq.emberAccum += dt * 5 * eq.flameH * pScale;
    while (eq.emberAccum >= 1) {
      eq.emberAccum -= 1;
      spawnParticle(
        engine,
        eq.headX + eq.flameX * 0.5,
        eq.headY + eq.flameY * 0.5 - 4,
        wcx * windMag * 6 + (eq.rng() - 0.5) * 14,
        wcy * windMag * 6 - 22 - eq.rng() * 18,
        0.9 + eq.rng() * 1.1,
        0.5 + eq.rng() * 0.6,
        eq.rng() < 0.4 ? '#ffd27a' : '#e8642a',
        'ember'
      );
    }
    if (eq.rainExposure > 0.2) {
      eq.steamAccum += dt * eq.rainExposure * 4.5 * pScale;
      while (eq.steamAccum >= 1) {
        eq.steamAccum -= 1;
        spawnParticle(engine, eq.headX, eq.headY - 3, (eq.rng() - 0.5) * 10, -20 - eq.rng() * 10, 2.4 + eq.rng() * 1.6, 0.6 + eq.rng() * 0.3, 'rgba(188, 194, 198, 0.34)', 'smoke');
      }
    }
  }
  if (eq.torchInHand && speed > FLAME_PHYS.whooshSpeed && eq.whooshCd <= 0) {
    SFX.playTorchWhoosh?.(clamp((speed - 420) / 800, 0.15, 1));
    eq.whooshCd = 0.24;
  }
  SFX.setTorchBurn?.(litNow ? eq.flameH : 0, litNow ? clamp(speed / 700, 0, 1) : 0);

  // 7. 地上的火把（抛物线 → 弹一下 → 竖直燃烧、受风轻摆、雨中减弱、慢慢熄灭）
  let nearest: GroundTorch | null = null;
  let nearD = 640;
  for (let i = 0; i < eq.groundTorches.length; i++) {
    const gt = eq.groundTorches[i];
    if (!gt.active) continue;
    let moving = false;
    if (gt.airborne) {
      moving = true;
      gt.vz -= 620 * dt;
      gt.z += gt.vz * dt;
      gt.x += gt.vx * dt;
      gt.y += gt.vy * dt;
      gt.rot += gt.spin * dt;
      if (gt.z <= 0) {
        gt.z = 0;
        if (gt.bounces === 0) {
          // 第一次触地：弹起一下 + 火星四溅
          gt.bounces = 1;
          gt.vz = -gt.vz * 0.32;
          gt.vx *= 0.55;
          gt.vy *= 0.55;
          gt.spin *= -0.45;
          gt.landFlash = 0.25;
          if (gt.lit) sparkBurst(engine, gt.x, gt.y, 12, 110);
          SFX.playTorchDrop?.(fillSpatial(engine, gt.x, gt.y, 520));
          host.emitRipple(gt.x, gt.y, 120, 'rgba(232, 168, 96, 0.40)');
          if (gt.vz < 30) {
            gt.airborne = false;
            gt.vz = 0;
          }
        } else {
          gt.airborne = false;
          gt.vz = 0;
          gt.bounces = 2;
          if (gt.lit) sparkBurst(engine, gt.x, gt.y, 4, 50);
        }
      }
    } else if (Math.abs(gt.vx) + Math.abs(gt.vy) > 0.5) {
      moving = true;
      const fr = Math.exp(-7 * dt);
      gt.vx *= fr;
      gt.vy *= fr;
      gt.x += gt.vx * dt;
      gt.y += gt.vy * dt;
      gt.spin *= Math.exp(-6 * dt);
      gt.rot += gt.spin * dt;
    } else {
      gt.vx = 0;
      gt.vy = 0;
    }
    if (moving) {
      // 约束最后：与照明弹同一碰撞解算（窗也挡住）
      const res = resolveWorldCollision(engine.world, gt.x, gt.y, 5, true);
      if (res.x !== gt.x) gt.vx *= -0.35;
      if (res.y !== gt.y) gt.vy *= -0.35;
      gt.x = res.x;
      gt.y = res.y;
    }
    gt.landFlash = Math.max(0, gt.landFlash - dt);

    const expo = isPointInHideout(gt.x, gt.y) ? 0 : clamp(w.rainIntensity, 0, 1);
    if (gt.lit) {
      gt.fuel -= dt * TORCH_BURN_GROUND * (1 + expo * 0.9);
      if (gt.fuel <= 0) {
        gt.fuel = 0;
        gt.lit = false;
        for (let k = 0; k < 3; k++) {
          spawnParticle(engine, gt.x, gt.y - 2, (eq.rng() - 0.5) * 12, -16 - eq.rng() * 10, 4 + eq.rng() * 3, 1.4, 'rgba(84, 80, 76, 0.4)', 'smoke');
        }
      }
    }
    const gk = clamp(gt.fuel / 0.25, 0, 1);
    gt.flameH = expDecay(gt.flameH, gt.lit ? (1 - 0.42 * expo) * (0.4 + 0.6 * gk) : 0, 5, dt);

    // 火焰：竖直燃烧 + 受风轻摆（空中时向运动反方向拖曳）
    const gw = isPointInHideout(gt.x, gt.y) ? FLAME_PHYS.windIndoor : FLAME_PHYS.windBase * 1.2 + expo * FLAME_PHYS.windRain * 1.1;
    let sx = wcx * gw + Math.sin(engine.simTime * 2.3 + gt.id) * 0.9;
    let sy = wcy * gw + Math.cos(engine.simTime * 1.7 + gt.id * 0.7) * 0.6;
    if (gt.airborne) {
      sx -= gt.vx * FLAME_PHYS.dragK;
      sy -= gt.vy * FLAME_PHYS.dragK;
    }
    gt.swayVX += (FLAME_PHYS.groundStiffness * (sx - gt.swayX) - FLAME_PHYS.groundDamping * gt.swayVX) * dt;
    gt.swayVY += (FLAME_PHYS.groundStiffness * (sy - gt.swayY) - FLAME_PHYS.groundDamping * gt.swayVY) * dt;
    gt.swayX = clamp(gt.swayX + gt.swayVX * dt, -14, 14);
    gt.swayY = clamp(gt.swayY + gt.swayVY * dt, -14, 14);

    if (gt.lit && gt.flameH > 0.05) {
      if (eq.rng() < dt * 4 * gt.flameH * pScale) {
        spawnParticle(engine, gt.x + gt.swayX * 0.5, gt.y - 6 - gt.z, wcx * gw * 6 + (eq.rng() - 0.5) * 12, -20 - eq.rng() * 16, 0.9 + eq.rng(), 0.5 + eq.rng() * 0.5, eq.rng() < 0.4 ? '#ffd27a' : '#e8642a', 'ember');
      }
      if (expo > 0.2 && eq.rng() < dt * expo * 3.5 * pScale) {
        spawnParticle(engine, gt.x, gt.y - 5, (eq.rng() - 0.5) * 8, -18 - eq.rng() * 8, 2.4 + eq.rng() * 1.4, 0.7, 'rgba(188, 194, 198, 0.32)', 'smoke');
      }
      const d = dist(gt.x, gt.y, p.x, p.y);
      if (d < nearD) {
        nearD = d;
        nearest = gt;
      }
    }
  }
  if (nearest) SFX.setGroundTorchBurn?.(nearest.flameH, fillSpatial(engine, nearest.x, nearest.y, 640));
  else SFX.setGroundTorchBurn?.(0);

  // 8. 弹壳
  for (let i = 0; i < eq.shells.length; i++) {
    const s = eq.shells[i];
    if (!s.active) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.active = false;
      continue;
    }
    if (s.airborne) {
      s.vz -= 700 * dt;
      s.z += s.vz * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.spin * dt;
      if (s.z <= 0) {
        s.z = 0;
        if (s.bounces === 0) SFX.playShellDrop?.(getSurfaceAt(engine.world, s.x, s.y));
        s.bounces++;
        if (s.bounces >= 3 || Math.abs(s.vz) < 50) {
          s.airborne = false;
          s.vz = 0;
        } else {
          s.vz = -s.vz * 0.38;
          s.vx *= 0.5;
          s.vy *= 0.5;
          s.spin *= 0.6;
        }
      }
    } else {
      const fr = Math.exp(-9 * dt);
      s.vx *= fr;
      s.vy *= fr;
      s.spin *= fr;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.spin * dt;
    }
  }

  // 9. 照明弹抛物线高度（与 engine.flares 同 id；照明弹被回收则同步回收）
  for (let i = 0; i < eq.flareArcs.length; i++) {
    const fa = eq.flareArcs[i];
    if (!fa.active) continue;
    let alive = false;
    for (let k = 0; k < engine.flares.length; k++) {
      if (engine.flares[k].id === fa.id) {
        alive = true;
        break;
      }
    }
    if (!alive) {
      fa.active = false;
      continue;
    }
    if (fa.z > 0 || fa.vz > 0) {
      fa.vz -= 560 * dt;
      fa.z += fa.vz * dt;
      if (fa.z <= 0) {
        fa.z = 0;
        fa.vz = fa.vz < -90 ? -fa.vz * 0.3 : 0;
      }
    }
  }

  // 10. 捕兽夹张开动画（咔哒）
  for (let i = 0; i < engine.traps.length; i++) {
    const t = engine.traps[i];
    if (t.openT !== undefined && t.openT < 1) t.openT = Math.min(1, t.openT + dt * 4.5);
  }
}
