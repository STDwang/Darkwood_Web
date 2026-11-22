// 超自然异象系统 HauntSystem（Darkwood 式心理压迫：只用光影、声音与似是而非的异象，杜绝廉价跳脸）
//
// 1. 跳舞幽灵（DanceGhost）：只有玩家在约 90–140px 内才逐渐显形；手电直照更清晰，但 0.5–1s 后消散并在别处重现。
//    - 晴天/白昼罕见：只在特定地点（教堂/村落类建筑；暂无时用枯林祭坛、猎人营地）附近，夜晚稍多；
//    - 下雨时为"跟随型"：在玩家前路屏幕外 200–400px 的林间出现，不可见时悄悄贴近玩家前路，
//      给人"走到哪里都遇到她"的感觉；同一视野内不连续出现两次，冷却 25–60s。
// 2. 一闪而逝（Apparition）：视野锥边缘 / 闪电瞬间，门口·窗外·树后 1–3 帧 ~ 0.3s 的人形剪影或面孔残像。
//    全局 40–120s 一次，危险度高时不触发，永不造成伤害。
// 3. 砸桌女人（TableHaunt）：某屋桌边周期性以头砸桌——桌子只做渲染偏移（不改碰撞数据）、桌面物件跳动、灰尘落下、
//    闷响沿空间传播（隔墙闷、越近越响）；玩家进屋/手电照到她时停止，缓慢抬头或直接消失，之后很久不再出现。
// 4. 附加低成本异象：她消失后的空椅子在你不看它时慢慢转向你；夜里远处的门自己吱呀一声（仅声音 + 微弱声波）。
//
// 单源真相：所有异象状态只在本文件 update() 推进；渲染层（render/hauntsDraw.ts）只读。
// 零每帧分配：状态对象全部预分配；随机数自带种子（不消耗 engine.rng，既有 sim-check 轨迹与断言不受影响）。
// 本系统从不修改玩家 hp/坐标、敌人、碰撞数据；唯一写入的玩家字段是手电 flickerVal（每步由 updatePlayer 重算，不累积）。

import { AudioFX } from './audio';
import type { SpatialAudioOpts } from './audio';
import type { GameEngine } from './engine';
import type { MovableFurniture } from './types';
import { angleDiff, clamp, createRng, dist, smoothstep } from './util';
import { Variants } from './variants';
import { hasLineOfSight } from './visibility';
import { HIDEOUT_RECT, WORLD_HALF, WorldData, isPointInHideout } from './world';

// ---------------------------------------------------------------------------
// 参数表（集中便于试玩调参）
// ---------------------------------------------------------------------------
/** 跳舞幽灵：完全显形距离 / 开始显形距离 / 手电直照时显形距离 */
export const DANCE_NEAR = 90;
export const DANCE_FAR = 140;
export const DANCE_FAR_LIT = 200;
/** 雨天判定阈值（drizzle≈0.42、storm≈0.94） */
const RAIN_THRESHOLD = 0.3;
/** 雨天冷却（秒） */
const DANCE_CD_RAIN_MIN = 25;
const DANCE_CD_RAIN_MAX = 60;
/** 晴天冷却（秒） */
const DANCE_CD_CLEAR_MIN = 60;
const DANCE_CD_CLEAR_MAX = 140;
/** 晴天在特定地点附近每秒出现概率（白昼 / 黄昏 / 黑夜） */
const DANCE_CLEAR_RATE_DAY = 0.004;
const DANCE_CLEAR_RATE_DUSK = 0.009;
const DANCE_CLEAR_RATE_NIGHT = 0.016;
/** 不可见时贴近玩家前路的漂移速度（px/s）；只在距离 > DANCE_PLANT_DIST 时移动，玩家永远看不到她"走动" */
const DANCE_DRIFT_SPEED = 70;
const DANCE_PLANT_DIST = 205;
/** 未被看见时的最长存活（秒），超时悄悄换位 */
const DANCE_UNSEEN_LIFE_MIN = 26;
const DANCE_UNSEEN_LIFE_MAX = 38;
/** 同一视野判定：新出现点与上次出现点的最小间距 */
const DANCE_SAME_VIEW_DIST = 480;
/** 危险度高于该值不生成新的跳舞幽灵 */
const DANCE_MAX_DANGER = 0.55;

/** 闪现：全局冷却 40–120s；危险度上限 */
const APP_CD_MIN = 40;
const APP_CD_MAX = 120;
const APP_MAX_DANGER = 0.25;
/** 冷却结束后每秒触发概率（白昼 / 黄昏 / 黑夜）；闪电上升沿单独判定 */
const APP_RATE_DAY = 0.03;
const APP_RATE_DUSK = 0.1;
const APP_RATE_NIGHT = 0.22;
const APP_LIGHTNING_CHANCE = 0.6;

/** 砸桌：桌子渲染抖动幅度（px，≈2–3px）、可听距离、打断距离 */
const TABLE_JITTER_X = 2.6;
const TABLE_JITTER_Y = 1.9;
const TABLE_AUDIBLE = 950;
const TABLE_INTERRUPT_NEAR = 125;
const TABLE_RESTART_DIST = 380;
const TABLE_GONE_CD_MIN = 120;
const TABLE_GONE_CD_MAX = 240;

/** 远门吱呀：冷却 80–160s */
const CREAK_CD_MIN = 80;
const CREAK_CD_MAX = 160;

// ---------------------------------------------------------------------------
// 状态结构（渲染只读）
// ---------------------------------------------------------------------------
export type DanceState = 'idle' | 'drift' | 'planted' | 'dispel';

export interface DanceGhostState {
  state: DanceState;
  /** 舞蹈中心世界坐标 */
  x: number;
  y: number;
  /** 最终显形度 0..1（距离显形 × 显现包络 × 视线），渲染直接使用 */
  alpha: number;
  /** 显现/消散包络 0..1 */
  fade: number;
  /** 视线平滑 0..1 */
  losK: number;
  /** 当前是否被手电直照 */
  isLit: boolean;
  /** 手电直照累计秒 / 本次消散阈值（0.5–1s） */
  lit: number;
  litDur: number;
  /** 旋转相位（弧度，持续递增）与摇摆相位 */
  spin: number;
  sway: number;
  /** 本次出现已过秒 / 未被看见时最长存活 */
  t: number;
  life: number;
  /** 本次是否已被看见 */
  seen: boolean;
  /** 冷却（idle 时递减） */
  cooldown: number;
  /** 上次出现点（同一视野不连续出现） */
  lastX: number;
  lastY: number;
  /** 前路横向偏移（每次出现固定） */
  offX: number;
  offY: number;
  /** 八音盒旋律重播倒计时 */
  songCd: number;
  /** 本次出现是否雨天跟随型 */
  rainMode: boolean;
  /** 玩家距离（缓存，渲染/断言用） */
  playerDist: number;
  /** 统计：生成次数 / 被看见次数 / 被手电驱散次数 */
  spawnCount: number;
  seenCount: number;
  dispelCount: number;
  seed: number;
}

export interface ApparitionState {
  active: boolean;
  kind: 'figure' | 'face';
  x: number;
  y: number;
  /** 朝向（面向玩家） */
  angle: number;
  t: number;
  dur: number;
  alpha: number;
  /** 闪电劈照时出现（渲染为暗色剪影） */
  byLightning: boolean;
  cooldown: number;
  count: number;
  seed: number;
}

export type TableHauntPhase = 'none' | 'dormant' | 'banging' | 'rising' | 'vanish' | 'gone';

export interface TableHauntState {
  phase: TableHauntPhase;
  /** 桌子来源：可拖拽家具 / 静态桌 / 建筑摆件 / 兜底虚拟桌（仅渲染，无碰撞） */
  source: 'none' | 'movable' | 'static' | 'building' | 'virtual';
  /** 来源为 movable 时的家具 id（renderer 用其做渲染偏移）；否则为空串 */
  furnId: string;
  /** 所在房间/地点名（调试与日志） */
  name: string;
  /** 桌子当前矩形（左上角 + 宽高；movable 每步从 world 同步） */
  tableX: number;
  tableY: number;
  tableW: number;
  tableH: number;
  /** 房间矩形（有则用于"进屋"判定与隔墙闷响） */
  hasRoom: boolean;
  roomX: number;
  roomY: number;
  roomW: number;
  roomH: number;
  /** 座位边：0 南 1 北 2 西 3 东 */
  seatSide: number;
  seatX: number;
  seatY: number;
  /** 女人面朝方向（指向桌子） */
  faceAngle: number;
  /** 头部抬起 0（伏在桌面）..1（直起/后仰） */
  headLift: number;
  /** 抬头后脸转向（世界角度） */
  headTurn: number;
  /** 显形包络 0..1 */
  fade: number;
  /** 当前一次砸桌动画计时（<0 表示无） */
  bangT: number;
  nextBang: number;
  /** 砸桌冲击 1→0（驱动桌子抖动与物件跳动） */
  impulse: number;
  /** 桌子渲染偏移（px，仅渲染；碰撞数据从不改变） */
  offX: number;
  offY: number;
  /** 桌面 3 件物件的跳起高度（px） */
  itemHop: number[];
  /** 抬头/消散计时 */
  timer: number;
  cooldown: number;
  /** 消失后桌子余震次数与间隔 */
  aftershocks: number;
  aftershockCd: number;
  /** 空椅子朝向（默认朝桌；她消失后在你不看时慢慢转向你） */
  chairAngle: number;
  chairTurning: boolean;
  chairCreaked: boolean;
  /** 统计：砸桌次数 / 被打断次数 */
  bangCount: number;
  interruptCount: number;
  /** 本轮砸桌剩余秒（周期性：砸 18–32s，伏桌静止 14–28s） */
  session: number;
  /** 伏桌静止剩余秒 */
  rest: number;
  /** 玩家到座位距离（缓存） */
  playerDist: number;
  /** 动画时钟 */
  tt: number;
}

/** 音频执行正在 audio.ts 实现的异象音频接口（可选调用：未落地时静默跳过，保证编译与运行不被阻塞） */
interface HauntAudioApi {
  playGhostDance?(spatial?: SpatialAudioOpts): void;
  playApparitionFlash?(spatial?: SpatialAudioOpts): void;
  playTableBang?(intensity01: number, spatial?: SpatialAudioOpts): void;
  setHauntLevel?(level01: number): void;
  playDoorCreak?(spatial?: SpatialAudioOpts): void;
}
const fx = AudioFX as unknown as HauntAudioApi;

/** 绑定期（每个 world 一次）使用的桌子候选 */
interface TableCandidate {
  x: number;
  y: number;
  w: number;
  h: number;
  furn: MovableFurniture | null;
  source: TableHauntState['source'];
  prio: number;
  name: string;
  hasRoom: boolean;
  rx: number;
  ry: number;
  rw: number;
  rh: number;
}

interface NamedRect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readRect(o: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const x = numOr(r.x, NaN);
  const y = numOr(r.y, NaN);
  const w = numOr(r.w ?? r.width, NaN);
  const h = numOr(r.h ?? r.height, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/** 屋子优先级：医生的屋子 > 农舍 > 村落民居 > 其他 */
function housePriority(name: string): number {
  if (/doctor|clinic|医/i.test(name)) return 4;
  if (/farm|农/i.test(name)) return 3;
  if (/village|house|home|cottage|民居|村|屋|宅/i.test(name)) return 2;
  return 1;
}

function pointRectDist(px: number, py: number, rx: number, ry: number, rw: number, rh: number): number {
  const cx = clamp(px, rx, rx + rw);
  const cy = clamp(py, ry, ry + rh);
  return Math.hypot(px - cx, py - cy);
}

function easeInOut(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

export class HauntSystem {
  readonly dance: DanceGhostState;
  readonly apparition: ApparitionState;
  readonly table: TableHauntState;
  /** 附近异象强度 0..1（平滑；驱动 setHauntLevel 与画面边缘去饱和） */
  level = 0;
  /** 远门吱呀累计次数（统计） */
  creakCount = 0;
  /** 本系统内部时钟（秒） */
  time = 0;

  private worldRef: WorldData | null = null;
  private rng: () => number = createRng(0x6a05);
  private losTick = 0;
  private prevFlash = 0;
  private creakCd = 90;
  private tableFurn: MovableFurniture | null = null;
  /** 跳舞幽灵晴天锚点（特定地点） */
  private anchorX: number[] = [];
  private anchorY: number[] = [];
  private anchorR: number[] = [];
  /** 缓存视线（10Hz 更新） */
  private losDance = false;
  private losTable = false;

  constructor() {
    this.dance = {
      state: 'idle',
      x: 0,
      y: 0,
      alpha: 0,
      fade: 0,
      losK: 0,
      isLit: false,
      lit: 0,
      litDur: 0.75,
      spin: 0,
      sway: 0,
      t: 0,
      life: 30,
      seen: false,
      cooldown: 10,
      lastX: 1e6,
      lastY: 1e6,
      offX: 0,
      offY: 0,
      songCd: 0,
      rainMode: false,
      playerDist: 1e6,
      spawnCount: 0,
      seenCount: 0,
      dispelCount: 0,
      seed: 0,
    };
    this.apparition = {
      active: false,
      kind: 'figure',
      x: 0,
      y: 0,
      angle: 0,
      t: 0,
      dur: 0.1,
      alpha: 0,
      byLightning: false,
      cooldown: 60,
      count: 0,
      seed: 0,
    };
    this.table = {
      phase: 'none',
      source: 'none',
      furnId: '',
      name: '',
      tableX: 0,
      tableY: 0,
      tableW: 44,
      tableH: 24,
      hasRoom: false,
      roomX: 0,
      roomY: 0,
      roomW: 0,
      roomH: 0,
      seatSide: 0,
      seatX: 0,
      seatY: 0,
      faceAngle: -Math.PI * 0.5,
      headLift: 0,
      headTurn: 0,
      fade: 0,
      bangT: -1,
      nextBang: 1.5,
      impulse: 0,
      offX: 0,
      offY: 0,
      itemHop: [0, 0, 0],
      timer: 0,
      cooldown: 8,
      aftershocks: 0,
      aftershockCd: 0,
      chairAngle: -Math.PI * 0.5,
      chairTurning: false,
      chairCreaked: false,
      bangCount: 0,
      interruptCount: 0,
      session: 24,
      rest: 0,
      playerDist: 1e6,
      tt: 0,
    };
  }

  // -------------------------------------------------------------------------
  // 主入口：由 engine.step 每个固定步调用一次（仅 play 模式）
  // -------------------------------------------------------------------------
  update(engine: GameEngine, dt: number, viewW = 1280, viewH = 720) {
    // world 被 reset 替换时自动重新绑定（确定性重播种，无需改 engine.reset）
    if (this.worldRef !== engine.world) this.bind(engine);
    this.time += dt;

    const p = engine.player;
    const inHideout = isPointInHideout(p.x, p.y);
    const coneHalf = Variants.val.cone === 'a' ? (39 * Math.PI) / 180 : (31 * Math.PI) / 180;

    // 视线检测较贵：10Hz 子节拍
    this.losTick -= dt;
    const doLos = this.losTick <= 0;
    if (doLos) this.losTick = 0.1;

    this.updateDance(engine, dt, viewW, viewH, inHideout, coneHalf, doLos);
    this.updateApparition(engine, dt, coneHalf);
    this.updateTable(engine, dt, coneHalf, doLos);
    this.updateDoorCreak(engine, dt, inHideout, coneHalf);

    // 手电闪烁：离她太近时（只乘系数；flickerVal 每步由 updatePlayer 重算，不累积）
    if (p.flashlightOn && p.flickerVal > 0) {
      let k = 0;
      const g = this.dance;
      if ((g.state === 'planted' || g.state === 'dispel') && g.fade > 0.2) {
        k = Math.max(k, smoothstep(85, 35, g.playerDist));
      }
      const tb = this.table;
      if ((tb.phase === 'rising' || tb.phase === 'banging') && tb.fade > 0.3 && tb.playerDist < 170) {
        k = Math.max(k, (1 - tb.playerDist / 170) * 0.6);
      }
      if (this.apparition.active) k = Math.max(k, 0.45);
      if (k > 0) {
        const w = Math.sin(this.time * 37.3) * Math.sin(this.time * 13.1 + 1.7);
        if (w > 0.62 - k * 0.7) p.flickerVal *= 0.16 + (1 - k) * 0.3;
      }
    }

    // 附近异象强度（上升快、回落慢）
    const g = this.dance;
    let target = 0;
    if (g.state === 'planted' || g.state === 'dispel') {
      target = Math.max(g.alpha * 0.85 + (g.isLit ? 0.1 : 0), smoothstep(260, DANCE_NEAR, g.playerDist) * 0.35 * g.fade);
    }
    const tb = this.table;
    if (tb.phase === 'banging' && tb.playerDist < 340) target = Math.max(target, (1 - tb.playerDist / 340) * 0.5 * tb.fade);
    if ((tb.phase === 'rising' || tb.phase === 'vanish') && tb.playerDist < 320) target = Math.max(target, 0.75 * tb.fade);
    if (tb.chairTurning) target = Math.max(target, 0.3);
    if (this.apparition.active) target = Math.max(target, 0.6);
    const rate = target > this.level ? 2.6 : 0.7;
    this.level += (clamp(target, 0, 1) - this.level) * (1 - Math.exp(-rate * dt));
    if (!Number.isFinite(this.level)) this.level = 0;
    fx.setHauntLevel?.(this.level);

    this.prevFlash = engine.weather.lightningFlash;
  }

  // -------------------------------------------------------------------------
  // 绑定：每个 world 一次（解析桌子 / 锚点，重播种随机数）
  // -------------------------------------------------------------------------
  private bind(engine: GameEngine) {
    const world = engine.world;
    this.worldRef = world;
    this.rng = createRng((world.seed ^ 0x6a05e1) >>> 0);
    this.time = 0;
    this.level = 0;
    this.losTick = 0;
    this.prevFlash = 0;
    this.creakCd = 70 + this.rng() * 50;
    this.creakCount = 0;
    this.losDance = false;
    this.losTable = false;

    const g = this.dance;
    g.state = 'idle';
    g.alpha = 0;
    g.fade = 0;
    g.losK = 0;
    g.isLit = false;
    g.lit = 0;
    g.seen = false;
    g.cooldown = 8 + this.rng() * 8;
    g.lastX = 1e6;
    g.lastY = 1e6;
    g.playerDist = 1e6;
    g.spawnCount = 0;
    g.seenCount = 0;
    g.dispelCount = 0;

    const a = this.apparition;
    a.active = false;
    a.alpha = 0;
    a.cooldown = APP_CD_MIN + this.rng() * (APP_CD_MAX - APP_CD_MIN) * 0.5;
    a.count = 0;

    // --- 建筑数据（关卡执行新增的 buildings，只读、结构未知时宽松解析） ---
    const rects: NamedRect[] = [];
    const cands: TableCandidate[] = [];
    const usedIds = new Set<string>();
    const raw = (world as unknown as { buildings?: unknown }).buildings;
    const buildingItems: Array<{ name: string; item: Record<string, unknown> }> = [];
    if (Array.isArray(raw)) {
      for (const b of raw) {
        if (!b || typeof b !== 'object') continue;
        const bo = b as Record<string, unknown>;
        const name = String(bo.name ?? bo.label ?? bo.kind ?? bo.type ?? bo.id ?? '');
        const rc = readRect(bo) ?? readRect(bo.rect) ?? readRect(bo.bounds);
        if (rc) rects.push({ name, x: rc.x, y: rc.y, w: rc.w, h: rc.h });
        for (const key in bo) {
          const v = bo[key];
          if (!Array.isArray(v)) continue;
          for (const it of v) {
            if (!it || typeof it !== 'object') continue;
            const io = it as Record<string, unknown>;
            const kind = String(io.kind ?? io.type ?? '');
            if (!/table|desk|桌/i.test(kind)) continue;
            buildingItems.push({ name, item: io });
          }
        }
      }
    }

    // 锯木厂残垣（world 墙体单源推导，作为兜底房间）
    let millMinX = 1e9;
    let millMinY = 1e9;
    let millMaxX = -1e9;
    let millMaxY = -1e9;
    for (const w of world.walls) {
      if (w.id.indexOf('mill_') !== 0) continue;
      millMinX = Math.min(millMinX, w.x);
      millMinY = Math.min(millMinY, w.y);
      millMaxX = Math.max(millMaxX, w.x + w.w);
      millMaxY = Math.max(millMaxY, w.y + w.h);
    }
    const hasMill = millMaxX > millMinX && millMaxY > millMinY;

    const roomFor = (cx: number, cy: number, c: TableCandidate) => {
      for (const r of rects) {
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
          c.hasRoom = true;
          c.rx = r.x;
          c.ry = r.y;
          c.rw = r.w;
          c.rh = r.h;
          if (r.name) c.name = r.name;
          c.prio = Math.max(c.prio, housePriority(r.name));
          return;
        }
      }
      if (hasMill && cx >= millMinX && cx <= millMaxX && cy >= millMinY && cy <= millMaxY) {
        c.hasRoom = true;
        c.rx = millMinX;
        c.ry = millMinY;
        c.rw = millMaxX - millMinX;
        c.rh = millMaxY - millMinY;
        c.name = c.name || '废弃锯木厂';
      }
    };

    // ① 可拖拽桌子（庇护所外）
    for (const m of world.movables) {
      if (m.kind !== 'table' || m.hp <= 0) continue;
      const cx = m.x + m.w * 0.5;
      const cy = m.y + m.h * 0.5;
      if (isPointInHideout(cx, cy)) continue;
      const c: TableCandidate = {
        x: m.x, y: m.y, w: m.w, h: m.h, furn: m, source: 'movable', prio: 1, name: '',
        hasRoom: false, rx: 0, ry: 0, rw: 0, rh: 0,
      };
      roomFor(cx, cy, c);
      cands.push(c);
      usedIds.add(m.id);
    }
    // ② 建筑摆件中的桌子
    for (const bi of buildingItems) {
      const io = bi.item;
      const id = typeof io.id === 'string' ? io.id : '';
      if (id && usedIds.has(id)) continue;
      const x = numOr(io.x, NaN);
      const y = numOr(io.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const hasWH = Number.isFinite(numOr(io.w, NaN)) && Number.isFinite(numOr(io.h, NaN));
      const w = hasWH ? numOr(io.w, 44) : 44;
      const h = hasWH ? numOr(io.h, 24) : 24;
      const tx = hasWH ? x : x - w * 0.5;
      const ty = hasWH ? y : y - h * 0.5;
      if (isPointInHideout(tx + w * 0.5, ty + h * 0.5)) continue;
      const c: TableCandidate = {
        x: tx, y: ty, w, h, furn: null, source: 'building', prio: housePriority(bi.name), name: bi.name,
        hasRoom: false, rx: 0, ry: 0, rw: 0, rh: 0,
      };
      roomFor(tx + w * 0.5, ty + h * 0.5, c);
      cands.push(c);
      if (id) usedIds.add(id);
    }
    // ③ 静态桌类实体（庇护所内的发电机/工作台 prop_* 除外）
    for (const w of world.walls) {
      if (w.kind !== 'table' || w.id.indexOf('prop_') === 0) continue;
      if (usedIds.has(w.id)) continue;
      const cx = w.x + w.w * 0.5;
      const cy = w.y + w.h * 0.5;
      if (isPointInHideout(cx, cy)) continue;
      const c: TableCandidate = {
        x: w.x, y: w.y, w: w.w, h: w.h, furn: null, source: 'static', prio: 1, name: '',
        hasRoom: false, rx: 0, ry: 0, rw: 0, rh: 0,
      };
      roomFor(cx, cy, c);
      cands.push(c);
    }

    // 选择：优先级高者优先，同级取离庇护所最近
    let best: TableCandidate | null = null;
    let bestD = 1e9;
    for (const c of cands) {
      const d = dist(0, 0, c.x + c.w * 0.5, c.y + c.h * 0.5);
      if (!best || c.prio > best.prio || (c.prio === best.prio && d < bestD)) {
        best = c;
        bestD = d;
      }
    }

    // ④ 兜底：锯木厂残垣内的虚拟桌（仅渲染，无碰撞；待关卡执行落地真实桌子后自动切换）
    if (!best && hasMill) {
      const mcx = (millMinX + millMaxX) * 0.5;
      const mcy = (millMinY + millMaxY) * 0.5;
      let bx = mcx;
      let by = mcy;
      let bestClear = -1;
      for (let k = 0; k < 9; k++) {
        const ox = ((k % 3) - 1) * 28;
        const oy = (Math.floor(k / 3) - 1) * 24;
        const clear = this.clearanceAt(world, mcx + ox, mcy + oy);
        if (clear > bestClear) {
          bestClear = clear;
          bx = mcx + ox;
          by = mcy + oy;
        }
      }
      best = {
        x: bx - 22, y: by - 12, w: 44, h: 24, furn: null, source: 'virtual', prio: 0, name: '废弃锯木厂',
        hasRoom: true, rx: millMinX, ry: millMinY, rw: millMaxX - millMinX, rh: millMaxY - millMinY,
      };
    }
    // ⑤ 再兜底：庇护所外最近的 POI 中心（无房间）
    if (!best && world.poiCenters.length > 0) {
      const poi = world.poiCenters[0];
      best = {
        x: poi.x - 22, y: poi.y - 12, w: 44, h: 24, furn: null, source: 'virtual', prio: 0, name: poi.name,
        hasRoom: false, rx: 0, ry: 0, rw: 0, rh: 0,
      };
    }

    const tb = this.table;
    this.tableFurn = null;
    if (best) {
      tb.source = best.source;
      tb.furnId = best.furn ? best.furn.id : '';
      this.tableFurn = best.furn;
      tb.name = best.name;
      tb.tableX = best.x;
      tb.tableY = best.y;
      tb.tableW = best.w;
      tb.tableH = best.h;
      tb.hasRoom = best.hasRoom;
      tb.roomX = best.rx;
      tb.roomY = best.ry;
      tb.roomW = best.rw;
      tb.roomH = best.rh;
      // 座位边：选离墙/容器/零件最远的一侧
      let bestSide = 0;
      let bestClear = -1;
      for (let s = 0; s < 4; s++) {
        this.seatFor(s);
        const clear = this.clearanceAt(world, tb.seatX, tb.seatY);
        if (clear > bestClear + 0.5) {
          bestClear = clear;
          bestSide = s;
        }
      }
      tb.seatSide = bestSide;
      this.seatFor(bestSide);
      tb.phase = 'dormant';
      tb.cooldown = 6 + this.rng() * 8;
    } else {
      tb.source = 'none';
      tb.furnId = '';
      tb.phase = 'none';
    }
    tb.fade = 0;
    tb.headLift = 0;
    tb.headTurn = tb.faceAngle;
    tb.bangT = -1;
    tb.nextBang = 1.2;
    tb.impulse = 0;
    tb.offX = 0;
    tb.offY = 0;
    tb.itemHop[0] = 0;
    tb.itemHop[1] = 0;
    tb.itemHop[2] = 0;
    tb.timer = 0;
    tb.aftershocks = 0;
    tb.aftershockCd = 0;
    tb.chairAngle = tb.faceAngle;
    tb.chairTurning = false;
    tb.chairCreaked = false;
    tb.bangCount = 0;
    tb.interruptCount = 0;
    tb.session = 18 + this.rng() * 14;
    tb.rest = 0;
    tb.playerDist = 1e6;

    // --- 跳舞幽灵晴天锚点：教堂/村落类建筑优先，暂无时用枯林祭坛、猎人营地 ---
    this.anchorX.length = 0;
    this.anchorY.length = 0;
    this.anchorR.length = 0;
    for (const r of rects) {
      if (!/church|chapel|教堂|village|村|民居/i.test(r.name)) continue;
      this.anchorX.push(r.x + r.w * 0.5);
      this.anchorY.push(r.y + r.h * 0.5);
      this.anchorR.push(Math.max(120, Math.max(r.w, r.h) * 0.6));
    }
    if (this.anchorX.length === 0) {
      for (const poi of world.poiCenters) {
        if (poi.name !== '枯林祭坛' && poi.name !== '猎人营地') continue;
        this.anchorX.push(poi.x);
        this.anchorY.push(poi.y);
        this.anchorR.push(poi.r);
      }
    }
    if (this.anchorX.length === 0) {
      for (const poi of world.poiCenters) {
        this.anchorX.push(poi.x);
        this.anchorY.push(poi.y);
        this.anchorR.push(poi.r);
      }
    }
  }

  /** 按座位边与当前桌子矩形计算座位与朝向 */
  private seatFor(side: number) {
    const tb = this.table;
    const cx = tb.tableX + tb.tableW * 0.5;
    const cy = tb.tableY + tb.tableH * 0.5;
    if (side === 0) {
      tb.seatX = cx;
      tb.seatY = tb.tableY + tb.tableH + 10;
      tb.faceAngle = -Math.PI * 0.5;
    } else if (side === 1) {
      tb.seatX = cx;
      tb.seatY = tb.tableY - 10;
      tb.faceAngle = Math.PI * 0.5;
    } else if (side === 2) {
      tb.seatX = tb.tableX - 10;
      tb.seatY = cy;
      tb.faceAngle = 0;
    } else {
      tb.seatX = tb.tableX + tb.tableW + 10;
      tb.seatY = cy;
      tb.faceAngle = Math.PI;
    }
  }

  /** 点到墙体/容器/零件节点的最小净空（绑定期使用） */
  private clearanceAt(world: WorldData, x: number, y: number): number {
    let c = 200;
    for (const w of world.walls) {
      if (w.x > x + 200 || w.x + w.w < x - 200 || w.y > y + 200 || w.y + w.h < y - 200) continue;
      c = Math.min(c, pointRectDist(x, y, w.x, w.y, w.w, w.h));
    }
    for (const k of world.containers) c = Math.min(c, dist(x, y, k.x, k.y) - k.r);
    for (const r of world.relayNodes) c = Math.min(c, dist(x, y, r.x, r.y) - 12);
    return c;
  }

  /** 空间音频参数（事件级分配，非每帧） */
  private spatial(engine: GameEngine, x: number, y: number, maxDist: number, muffled?: boolean): SpatialAudioOpts {
    const p = engine.player;
    return {
      worldX: x,
      worldY: y,
      listenerX: p.x,
      listenerY: p.y,
      muffled: muffled ?? isPointInHideout(x, y) !== isPointInHideout(p.x, p.y),
      maxDist,
    };
  }

  /** 是否被手电锥直照（不含视线检测） */
  private inFlashCone(engine: GameEngine, x: number, y: number, maxD: number, coneHalf: number): boolean {
    const p = engine.player;
    if (!p.flashlightOn || p.flickerVal <= 0.1) return false;
    const d = dist(p.x, p.y, x, y);
    if (d > maxD) return false;
    return Math.abs(angleDiff(p.angle, Math.atan2(y - p.y, x - p.x))) <= coneHalf + 0.05;
  }

  /** 幽灵落点合法性：世界内、不在庇护所/墙体/树干/巨石内 */
  private validGhostSpot(world: WorldData, x: number, y: number): boolean {
    if (Math.abs(x) > WORLD_HALF - 70 || Math.abs(y) > WORLD_HALF - 70) return false;
    if (
      x > HIDEOUT_RECT.x - 24 &&
      x < HIDEOUT_RECT.x + HIDEOUT_RECT.w + 24 &&
      y > HIDEOUT_RECT.y - 24 &&
      y < HIDEOUT_RECT.y + HIDEOUT_RECT.h + 24
    ) {
      return false;
    }
    for (const w of world.walls) {
      if (x > w.x - 16 && x < w.x + w.w + 16 && y > w.y - 16 && y < w.y + w.h + 16) return false;
    }
    for (const t of world.trees) {
      const dx = t.x - x;
      const dy = t.y - y;
      const rr = t.trunkR + 14;
      if (dx * dx + dy * dy < rr * rr) return false;
    }
    for (const r of world.rocks) {
      const dx = r.x - x;
      const dy = r.y - y;
      const rr = r.r + 10;
      if (dx * dx + dy * dy < rr * rr) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 1. 跳舞幽灵
  // -------------------------------------------------------------------------
  private beginDance(x: number, y: number, rainMode: boolean) {
    const g = this.dance;
    g.state = 'drift';
    g.x = x;
    g.y = y;
    g.alpha = 0;
    g.fade = 0;
    g.losK = 0;
    g.isLit = false;
    g.lit = 0;
    g.litDur = 0.5 + this.rng() * 0.5;
    g.t = 0;
    g.life = DANCE_UNSEEN_LIFE_MIN + this.rng() * (DANCE_UNSEEN_LIFE_MAX - DANCE_UNSEEN_LIFE_MIN);
    g.seen = false;
    g.rainMode = rainMode;
    g.spin = this.rng() * Math.PI * 2;
    g.sway = this.rng() * Math.PI * 2;
    const lat = (this.rng() - 0.5) * 100;
    const la = this.rng() * Math.PI * 2;
    g.offX = Math.cos(la) * lat;
    g.offY = Math.sin(la) * lat;
    g.songCd = 0;
    g.seed = this.rng() * 1000;
    g.spawnCount++;
  }

  /** 雨天跟随型：在玩家前路、屏幕外 200–400px 的林间生成 */
  private spawnDanceAhead(engine: GameEngine, viewW: number, viewH: number): boolean {
    const p = engine.player;
    const g = this.dance;
    const sp = Math.hypot(p.vx, p.vy);
    const dir = sp > 20 ? Math.atan2(p.vy, p.vx) : p.angle;
    const hw = Math.max(320, viewW * 0.5);
    const hh = Math.max(240, viewH * 0.5);
    for (let k = 0; k < 7; k++) {
      const a = dir + (this.rng() - 0.5) * 0.9;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const tx = Math.abs(ca) > 1e-3 ? hw / Math.abs(ca) : 1e9;
      const ty = Math.abs(sa) > 1e-3 ? hh / Math.abs(sa) : 1e9;
      const d = Math.min(Math.min(tx, ty) + 200 + this.rng() * 200, 1100);
      const x = engine.camX + ca * d;
      const y = engine.camY + sa * d;
      if (!this.validGhostSpot(engine.world, x, y)) continue;
      if (dist(x, y, g.lastX, g.lastY) < DANCE_SAME_VIEW_DIST) continue;
      this.beginDance(x, y, true);
      return true;
    }
    return false;
  }

  /** 晴天：在特定地点附近生成（离玩家 ≥160px，且不在手电锥内） */
  private spawnDanceAtAnchor(engine: GameEngine, ai: number, coneHalf: number): boolean {
    const p = engine.player;
    const g = this.dance;
    for (let k = 0; k < 6; k++) {
      const a = this.rng() * Math.PI * 2;
      const r = this.rng() * this.anchorR[ai] * 0.6;
      const x = this.anchorX[ai] + Math.cos(a) * r;
      const y = this.anchorY[ai] + Math.sin(a) * r;
      if (dist(x, y, p.x, p.y) < 160) continue;
      if (this.inFlashCone(engine, x, y, 470, coneHalf)) continue;
      if (!this.validGhostSpot(engine.world, x, y)) continue;
      if (dist(x, y, g.lastX, g.lastY) < DANCE_SAME_VIEW_DIST * 0.5) continue;
      this.beginDance(x, y, false);
      // 锚点型不漂移：直接原地等待（仍只在近处显形）
      g.state = 'planted';
      return true;
    }
    return false;
  }

  private endDance(cooldownScale = 1) {
    const g = this.dance;
    g.state = 'idle';
    g.alpha = 0;
    g.fade = 0;
    g.isLit = false;
    g.lastX = g.x;
    g.lastY = g.y;
    const rain = g.rainMode;
    const lo = rain ? DANCE_CD_RAIN_MIN : DANCE_CD_CLEAR_MIN;
    const hi = rain ? DANCE_CD_RAIN_MAX : DANCE_CD_CLEAR_MAX;
    g.cooldown = (lo + this.rng() * (hi - lo)) * cooldownScale;
  }

  private updateDance(
    engine: GameEngine,
    dt: number,
    viewW: number,
    viewH: number,
    inHideout: boolean,
    coneHalf: number,
    doLos: boolean
  ) {
    const g = this.dance;
    const p = engine.player;
    const rain = engine.weather.rainIntensity > RAIN_THRESHOLD;

    if (g.state === 'idle') {
      g.alpha = 0;
      g.fade = 0;
      g.playerDist = 1e6;
      g.cooldown -= dt;
      if (g.cooldown > 0 || inHideout || engine.dangerLevel > DANCE_MAX_DANGER) return;
      if (rain) {
        if (!this.spawnDanceAhead(engine, viewW, viewH)) g.cooldown = 1.5;
      } else {
        // 晴天罕见：只在特定地点附近
        let ai = -1;
        for (let i = 0; i < this.anchorX.length; i++) {
          if (dist(p.x, p.y, this.anchorX[i], this.anchorY[i]) < this.anchorR[i] + 260) {
            ai = i;
            break;
          }
        }
        if (ai < 0) return;
        const rate =
          engine.phase === 'night'
            ? DANCE_CLEAR_RATE_NIGHT
            : engine.phase === 'dusk'
            ? DANCE_CLEAR_RATE_DUSK
            : DANCE_CLEAR_RATE_DAY;
        if (this.rng() < rate * dt) {
          if (!this.spawnDanceAtAnchor(engine, ai, coneHalf)) g.cooldown = 2;
        }
      }
      return;
    }

    // 舞蹈动画相位（旋转略带呼吸般的快慢变化）
    g.spin += dt * (1.55 + 0.55 * Math.sin(this.time * 0.63 + g.seed));
    g.sway += dt * 2.1;
    g.t += dt;

    let d = dist(p.x, p.y, g.x, g.y);
    g.playerDist = d;

    if (g.state === 'drift') {
      g.alpha = 0;
      if (inHideout) {
        // 玩家进屋：悄悄散去（未被看见，短冷却）
        g.state = 'idle';
        g.cooldown = 6;
        return;
      }
      if (d > DANCE_PLANT_DIST) {
        // 不可见区内向玩家前路漂移（"跟随型"）
        const tx = p.x + p.vx * 1.5 + g.offX;
        const ty = p.y + p.vy * 1.5 + g.offY;
        const dx = tx - g.x;
        const dy = ty - g.y;
        const dd = Math.hypot(dx, dy);
        if (dd > 1) {
          const step = Math.min(dd, DANCE_DRIFT_SPEED * dt);
          const nx = g.x + (dx / dd) * step;
          const ny = g.y + (dy / dd) * step;
          // 不进入庇护所、不出界
          if (!isPointInHideout(nx, ny) && Math.abs(nx) < WORLD_HALF - 70 && Math.abs(ny) < WORLD_HALF - 70) {
            g.x = nx;
            g.y = ny;
          }
        }
        d = dist(p.x, p.y, g.x, g.y);
        g.playerDist = d;
      }
      if (d <= DANCE_PLANT_DIST) {
        g.state = 'planted';
        g.songCd = 0;
      } else if (g.t > g.life || d > 1300) {
        // 未被看见：换个地方（仍属同一冷却周期，不计"看见"）
        g.state = 'idle';
        g.cooldown = 0.5;
        g.lastX = 1e6;
        g.lastY = 1e6;
      }
      return;
    }

    // planted / dispel：视线（10Hz）
    if (doLos) {
      this.losDance = d < DANCE_FAR_LIT + 20 ? hasLineOfSight(engine.world, p.x, p.y, g.x, g.y) : false;
    }
    g.losK += ((this.losDance ? 1 : 0) - g.losK) * (1 - Math.exp(-8 * dt));

    // 手电直照：更清晰，累计 0.5–1s 后消散
    g.isLit = this.losDance && this.inFlashCone(engine, g.x, g.y, 430, coneHalf);
    if (g.isLit) g.lit += dt;
    else g.lit = Math.max(0, g.lit - dt * 0.5);

    const far = g.isLit ? DANCE_FAR_LIT : DANCE_FAR;
    const v = smoothstep(far, DANCE_NEAR, d);

    if (g.state === 'planted') {
      g.fade = Math.min(1, g.fade + dt * 1.2);
      // 八音盒旋律（走调、远处闷；她未显形时就隐约可闻）
      g.songCd -= dt;
      if (g.songCd <= 0) {
        g.songCd = 9 + this.rng() * 5;
        fx.playGhostDance?.(this.spatial(engine, g.x, g.y, 520));
      }
      if (inHideout) {
        g.state = 'dispel';
      } else if (g.isLit && g.lit >= g.litDur && g.alpha > 0.05) {
        g.state = 'dispel';
        g.dispelCount++;
      } else if (d < 30) {
        // 贴身：她像雾一样从你身上穿过、散开
        g.state = 'dispel';
        fx.playApparitionFlash?.(this.spatial(engine, g.x, g.y, 300));
      } else if (g.seen && d > 260) {
        g.state = 'dispel';
      } else if (!g.seen && (g.t > g.life + 20 || d > 560)) {
        // 玩家走远仍未看见：换位
        g.state = 'idle';
        g.alpha = 0;
        g.fade = 0;
        g.cooldown = g.rainMode ? 0.5 : 20;
        g.lastX = 1e6;
        g.lastY = 1e6;
        return;
      }
    } else {
      // dispel：噪点溶解淡出
      g.fade = Math.max(0, g.fade - dt * 2.4);
      if (g.fade <= 0) {
        this.endDance();
        return;
      }
    }

    g.alpha = clamp(v * g.fade * g.losK * (g.isLit ? 1 : 0.82), 0, 1);
    if (!Number.isFinite(g.alpha)) g.alpha = 0;
    if (!g.seen && g.alpha > 0.2) {
      g.seen = true;
      g.seenCount++;
      engine.think(g.rainMode ? '她又在雨里跳舞了。' : '有人在那里跳舞……不，不可能。'); // 内心独白（首次看见 / 雨中首次遇到她；一次性句由 thoughts.ts 判定）
    }
  }

  // -------------------------------------------------------------------------
  // 2. 一闪而逝的幽灵
  // -------------------------------------------------------------------------
  private updateApparition(engine: GameEngine, dt: number, coneHalf: number) {
    const a = this.apparition;
    if (a.active) {
      a.t += dt;
      const k = a.t / a.dur;
      if (k >= 1) {
        a.active = false;
        a.alpha = 0;
      } else {
        a.alpha = a.dur < 0.06 ? 0.85 : 0.82 * (1 - k * k * k);
      }
      return;
    }
    a.alpha = 0;
    a.cooldown -= dt;
    if (a.cooldown > 0) return;
    if (engine.dangerLevel > APP_MAX_DANGER || this.dance.alpha > 0.05 || this.table.phase === 'rising') {
      a.cooldown = 3;
      return;
    }
    const flash = engine.weather.lightningFlash;
    const lightningEdge = flash > 0.7 && this.prevFlash <= 0.7;
    let fire = false;
    if (lightningEdge) {
      fire = this.rng() < APP_LIGHTNING_CHANCE;
    } else {
      const rate =
        engine.phase === 'night' ? APP_RATE_NIGHT : engine.phase === 'dusk' ? APP_RATE_DUSK : APP_RATE_DAY;
      fire = this.rng() < rate * dt;
    }
    if (!fire) return;
    if (this.placeApparition(engine, coneHalf, lightningEdge)) {
      a.active = true;
      a.t = 0;
      // 2–3 帧（保证至少被一次渲染采样）~ 0.3s
      a.dur = this.rng() < 0.4 ? (2 + Math.floor(this.rng() * 2)) / 60 : 0.08 + this.rng() * 0.22;
      a.alpha = 0.85;
      a.byLightning = lightningEdge;
      a.seed = this.rng() * 1000;
      a.count++;
      a.cooldown = APP_CD_MIN + this.rng() * (APP_CD_MAX - APP_CD_MIN);
      fx.playApparitionFlash?.(this.spatial(engine, a.x, a.y, 520));
    } else {
      a.cooldown = 2;
    }
  }

  /** 找落点：门口/窗外 > 树后 > 锥边缘空地；闪电时放宽到锥外较大范围。成功写入 apparition.x/y/kind/angle */
  private placeApparition(engine: GameEngine, coneHalf: number, lightning: boolean): boolean {
    const p = engine.player;
    const a = this.apparition;
    const world = engine.world;
    const side = this.rng() < 0.5 ? -1 : 1;
    const edge = p.angle + side * (coneHalf + 0.06 + this.rng() * 0.16);
    const tol = lightning ? 1.2 : 0.3;
    const centerA = lightning ? p.angle + side * (coneHalf + 0.6) : edge;
    const minD = lightning ? 180 : 130;
    const maxD = lightning ? 480 : 420;

    // ① 门口 / 窗外（门窗另一侧 24px）
    for (const b of world.barricades) {
      const bx = b.x + b.w * 0.5;
      const by = b.y + b.h * 0.5;
      const d = dist(p.x, p.y, bx, by);
      if (d < minD - 30 || d > maxD) continue;
      if (Math.abs(angleDiff(centerA, Math.atan2(by - p.y, bx - p.x))) > tol) continue;
      let x = bx;
      let y = by;
      if (b.orientation === 'h') y += (by >= p.y ? 1 : -1) * 24;
      else x += (bx >= p.x ? 1 : -1) * 24;
      // 窗外：视线需穿过破损的洞口才看得见；完好木板挡住时退到门口这一侧（"门口"）
      if (!hasLineOfSight(world, p.x, p.y, x, y)) {
        x = bx;
        y = by;
        if (b.orientation === 'h') y += (by >= p.y ? -1 : 1) * 18;
        else x += (bx >= p.x ? -1 : 1) * 18;
        if (!hasLineOfSight(world, p.x, p.y, x, y)) continue;
      }
      a.x = x;
      a.y = y;
      a.kind = d < 240 ? 'face' : 'figure';
      a.angle = Math.atan2(p.y - y, p.x - x);
      return true;
    }
    // ② 树后（树干侧旁半露）
    let tries = 0;
    for (const t of world.trees) {
      const d = dist(p.x, p.y, t.x, t.y);
      if (d < minD + 20 || d > maxD) continue;
      const ang = Math.atan2(t.y - p.y, t.x - p.x);
      if (Math.abs(angleDiff(centerA, ang)) > tol) continue;
      if (++tries > 6) break;
      const perp = ang + side * Math.PI * 0.5;
      const x = t.x + Math.cos(perp) * (t.trunkR + 7) + Math.cos(ang) * 4;
      const y = t.y + Math.sin(perp) * (t.trunkR + 7) + Math.sin(ang) * 4;
      if (!hasLineOfSight(world, p.x, p.y, x, y)) continue;
      a.x = x;
      a.y = y;
      a.kind = 'figure';
      a.angle = Math.atan2(p.y - y, p.x - x);
      return true;
    }
    // ③ 锥边缘空地
    for (let k = 0; k < 3; k++) {
      const ang = centerA + (this.rng() - 0.5) * (lightning ? 1.2 : 0.12);
      const d = 220 + this.rng() * 160;
      const x = p.x + Math.cos(ang) * d;
      const y = p.y + Math.sin(ang) * d;
      if (!this.validGhostSpot(world, x, y)) continue;
      if (!hasLineOfSight(world, p.x, p.y, x, y)) continue;
      a.x = x;
      a.y = y;
      a.kind = 'figure';
      a.angle = Math.atan2(p.y - y, p.x - x);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 3. 砸桌女人（+ 附加异象：空椅子转向你）
  // -------------------------------------------------------------------------
  private doBang(engine: GameEngine, intensity: number, withSound: boolean) {
    const tb = this.table;
    const p = engine.player;
    tb.impulse = Math.max(tb.impulse, intensity);
    if (!withSound) return;
    tb.bangCount++;
    if (tb.playerDist < TABLE_AUDIBLE) engine.think('是谁在敲那张桌子？'); // 内心独白（950px 内首次听见；一次性句）
    const cx = tb.tableX + tb.tableW * 0.5;
    const cy = tb.tableY + tb.tableH * 0.5;
    // 灰尘落下（复用 engine 粒子池）
    const n = 4 + Math.floor(this.rng() * 3);
    for (let k = 0; k < n; k++) {
      const pt = engine.particles.alloc();
      pt.active = true;
      pt.x = tb.tableX + this.rng() * tb.tableW;
      pt.y = tb.tableY - 6 + this.rng() * (tb.tableH + 6);
      pt.vx = (this.rng() - 0.5) * 8;
      pt.vy = 6 + this.rng() * 10;
      pt.size = 0.9 + this.rng() * 1.2;
      pt.life = 0.9 + this.rng() * 0.6;
      pt.maxLife = pt.life;
      pt.color = '#9a948a';
      pt.kind = 'dust';
    }
    // 闷响沿空间传播：声波涟漪（视觉）+ 空间音频（隔墙闷、越近越响）
    const r = engine.ripples.alloc();
    r.active = true;
    r.x = cx;
    r.y = cy;
    r.radius = 6;
    r.maxRadius = 110 + intensity * 70;
    r.alpha = 0.6;
    r.color = 'rgba(176, 168, 150, 0.42)';
    const inRoom = tb.hasRoom && this.playerInRoom(engine);
    const muffled = tb.hasRoom ? !inRoom : !this.losTable;
    fx.playTableBang?.(intensity, this.spatial(engine, cx, cy, 820, muffled || isPointInHideout(p.x, p.y)));
  }

  private playerInRoom(engine: GameEngine): boolean {
    const tb = this.table;
    if (!tb.hasRoom) return false;
    const p = engine.player;
    return p.x > tb.roomX + 4 && p.x < tb.roomX + tb.roomW - 4 && p.y > tb.roomY + 4 && p.y < tb.roomY + tb.roomH - 4;
  }

  private updateTable(engine: GameEngine, dt: number, coneHalf: number, doLos: boolean) {
    const tb = this.table;
    if (tb.phase === 'none') return;
    const p = engine.player;

    // 可拖拽桌子：每步同步位置（玩家可能拖走它）；被毁则异象终止
    const furn = this.tableFurn;
    if (furn) {
      if (furn.hp <= 0) {
        tb.phase = 'none';
        tb.fade = 0;
        tb.impulse = 0;
        tb.offX = 0;
        tb.offY = 0;
        return;
      }
      tb.tableX = furn.x;
      tb.tableY = furn.y;
      tb.tableW = furn.w;
      tb.tableH = furn.h;
      this.seatFor(tb.seatSide);
    }

    tb.tt += dt;
    // 冲击衰减 → 桌子渲染偏移（≈2–3px）与桌面物件跳动
    tb.impulse *= Math.exp(-5.5 * dt);
    if (tb.impulse < 0.003) tb.impulse = 0;
    const im = tb.impulse;
    tb.offX = im * TABLE_JITTER_X * Math.sin(tb.tt * 61);
    tb.offY = im * TABLE_JITTER_Y * Math.cos(tb.tt * 53);
    for (let i = 0; i < 3; i++) {
      tb.itemHop[i] = im * (2.4 + i * 1.1) * Math.abs(Math.sin(tb.tt * (29 + i * 7) + i));
    }

    const hx = tb.seatX + Math.cos(tb.faceAngle) * 6;
    const hy = tb.seatY + Math.sin(tb.faceAngle) * 6;
    const d = dist(p.x, p.y, hx, hy);
    tb.playerDist = d;
    if (doLos) {
      this.losTable = d < 520 ? hasLineOfSight(engine.world, p.x, p.y, tb.seatX, tb.seatY) : false;
    }

    switch (tb.phase) {
      case 'dormant': {
        tb.fade = 0;
        tb.headLift = 0;
        tb.cooldown -= dt;
        if (tb.cooldown <= 0 && d > TABLE_RESTART_DIST && !this.playerInRoom(engine)) {
          tb.phase = 'banging';
          tb.nextBang = 1.2 + this.rng() * 1.2;
          tb.bangT = -1;
          tb.headTurn = tb.faceAngle;
          if (d > 420) tb.chairAngle = tb.faceAngle;
          tb.chairTurning = false;
          tb.chairCreaked = false;
        }
        break;
      }
      case 'banging': {
        tb.fade = Math.min(1, tb.fade + dt * 1.5);
        // 周期性：一轮砸 18–32s，然后伏桌静止 14–28s（只在一次砸桌动作结束后切换，避免动作截断）
        if (tb.rest > 0) {
          tb.rest -= dt;
          if (tb.rest <= 0) {
            tb.session = 18 + this.rng() * 14;
            tb.nextBang = 0.6 + this.rng() * 0.8;
          }
        } else if (tb.bangT < 0) {
          tb.session -= dt;
          if (tb.session <= 0) tb.rest = 14 + this.rng() * 14;
        }
        if (tb.rest > 0) {
          tb.headLift = 0.02 + 0.015 * Math.sin(tb.tt * 1.7);
          tb.bangT = -1;
        } else if (d < TABLE_AUDIBLE) {
          if (tb.bangT < 0) {
            tb.nextBang -= dt;
            // 伏在桌面上的细微抽动
            tb.headLift = 0.03 + 0.03 * Math.sin(tb.tt * 5.3);
            if (tb.nextBang <= 0) tb.bangT = 0;
          } else {
            tb.bangT += dt;
            if (tb.bangT < 0.38) {
              tb.headLift = easeInOut(tb.bangT / 0.38);
            } else if (tb.bangT < 0.45) {
              tb.headLift = 1 - (tb.bangT - 0.38) / 0.07;
            } else {
              tb.headLift = 0;
              tb.bangT = -1;
              this.doBang(engine, 0.75 + this.rng() * 0.25, true);
              // 不规则节奏：偶尔紧接一下
              tb.nextBang = this.rng() < 0.25 ? 0.4 + this.rng() * 0.2 : 1.4 + this.rng() * 1.8;
            }
          }
        } else {
          tb.headLift = 0;
          tb.bangT = -1;
        }
        // 打断：进屋 / 近身有视线 / 手电照到她
        if (tb.fade > 0.3) {
          const lit = this.losTable && this.inFlashCone(engine, tb.seatX, tb.seatY, 430, coneHalf);
          const near = d < TABLE_INTERRUPT_NEAR && this.losTable;
          if (lit || near || this.playerInRoom(engine)) {
            tb.interruptCount++;
            tb.bangT = -1;
            tb.timer = 0;
            if (this.rng() < 0.55) {
              tb.phase = 'rising';
            } else {
              tb.phase = 'vanish';
              tb.aftershocks = 2 + Math.floor(this.rng() * 2);
              tb.aftershockCd = 0.25;
            }
          }
        }
        break;
      }
      case 'rising': {
        // 停下，缓慢抬头；脸慢慢转向你；然后淡去
        tb.timer += dt;
        tb.headLift = Math.max(tb.headLift, easeInOut(tb.timer / 2.4));
        const toP = Math.atan2(p.y - tb.seatY, p.x - tb.seatX);
        const diff = angleDiff(tb.headTurn, toP);
        tb.headTurn += clamp(diff, -0.5 * dt, 0.5 * dt);
        if (tb.timer > 3.0) tb.fade = Math.max(0, tb.fade - dt / 1.1);
        if (tb.timer > 3.0 && tb.fade <= 0) this.toGone();
        break;
      }
      case 'vanish': {
        // 直接消失，桌子还在晃几下
        tb.fade = Math.max(0, tb.fade - dt * 4);
        tb.aftershockCd -= dt;
        if (tb.aftershocks > 0 && tb.aftershockCd <= 0) {
          tb.aftershocks--;
          tb.aftershockCd = 0.3 + this.rng() * 0.2;
          this.doBang(engine, 0.3 + 0.12 * tb.aftershocks, false);
          if (tb.aftershocks === 0) {
            const cx = tb.tableX + tb.tableW * 0.5;
            const cy = tb.tableY + tb.tableH * 0.5;
            fx.playTableBang?.(0.15, this.spatial(engine, cx, cy, 500, tb.hasRoom ? !this.playerInRoom(engine) : undefined));
          }
        }
        if (tb.fade <= 0 && tb.aftershocks <= 0) this.toGone();
        break;
      }
      case 'gone': {
        tb.fade = 0;
        tb.cooldown -= dt;
        // 附加异象：空椅子在你不看它时慢慢转向你
        tb.chairTurning = false;
        if (d < 260 && this.losTable && !this.inFlashCone(engine, tb.seatX, tb.seatY, 470, coneHalf)) {
          const toP = Math.atan2(p.y - tb.seatY, p.x - tb.seatX);
          const diff = angleDiff(tb.chairAngle, toP);
          if (Math.abs(diff) > 0.05) {
            tb.chairAngle += clamp(diff, -0.45 * dt, 0.45 * dt);
            tb.chairTurning = true;
            if (!tb.chairCreaked) {
              tb.chairCreaked = true;
              fx.playDoorCreak?.(this.spatial(engine, tb.seatX, tb.seatY, 300));
            }
          }
        }
        if (tb.chairCreaked && !tb.chairTurning && d < 300 && this.losTable && Math.abs(angleDiff(tb.chairAngle, tb.faceAngle)) > 0.6 && this.inFlashCone(engine, tb.seatX, tb.seatY, 470, coneHalf)) engine.think('那把椅子……刚才是朝着桌子的。'); // 内心独白（手电照到已转向你的空椅）
        if (tb.cooldown <= 0 && d > 420) {
          tb.phase = 'dormant';
          tb.cooldown = 0;
        }
        break;
      }
      default:
        break;
    }
    if (!Number.isFinite(tb.offX) || !Number.isFinite(tb.offY)) {
      tb.offX = 0;
      tb.offY = 0;
      tb.impulse = 0;
    }
  }

  private toGone() {
    const tb = this.table;
    tb.phase = 'gone';
    tb.fade = 0;
    tb.timer = 0;
    tb.headLift = 0;
    tb.cooldown = TABLE_GONE_CD_MIN + this.rng() * (TABLE_GONE_CD_MAX - TABLE_GONE_CD_MIN);
  }

  // -------------------------------------------------------------------------
  // 4. 附加异象：夜里远处的门自己吱呀一声（仅声音 + 微弱声波；不改变门板状态）
  // -------------------------------------------------------------------------
  private updateDoorCreak(engine: GameEngine, dt: number, inHideout: boolean, coneHalf: number) {
    this.creakCd -= dt;
    if (this.creakCd > 0) return;
    this.creakCd = 3;
    if (engine.phase === 'day' || inHideout || engine.dangerLevel > 0.3) return;
    const p = engine.player;
    const bars = engine.world.barricades;
    const n = bars.length;
    if (n === 0) return;
    const start = Math.floor(this.rng() * n);
    for (let k = 0; k < n; k++) {
      const b = bars[(start + k) % n];
      if (b.kind !== 'door') continue;
      const bx = b.x + b.w * 0.5;
      const by = b.y + b.h * 0.5;
      const d = dist(p.x, p.y, bx, by);
      if (d < 220 || d > 700) continue;
      if (Math.abs(angleDiff(p.angle, Math.atan2(by - p.y, bx - p.x))) < coneHalf + 0.3) continue;
      fx.playDoorCreak?.(this.spatial(engine, bx, by, 760));
      const r = engine.ripples.alloc();
      r.active = true;
      r.x = bx;
      r.y = by;
      r.radius = 6;
      r.maxRadius = 70;
      r.alpha = 0.4;
      r.color = 'rgba(190, 182, 160, 0.3)';
      this.creakCount++;
      this.creakCd = CREAK_CD_MIN + this.rng() * (CREAK_CD_MAX - CREAK_CD_MIN);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // 调试 / 自动化门禁入口（只供 sim-check 与 ?dev 调试；不在正常流程中调用）
  // -------------------------------------------------------------------------
  /** 立即让砸桌女人进入砸桌状态（下一步开始抬头砸下） */
  debugPrimeTable(): boolean {
    const tb = this.table;
    if (tb.phase === 'none') return false;
    tb.phase = 'banging';
    tb.fade = 1;
    tb.nextBang = 0.05;
    tb.bangT = -1;
    tb.rest = 0;
    tb.session = 30;
    return true;
  }

  /** 在指定点立即放置一个跳舞幽灵（planted） */
  debugPlaceDance(x: number, y: number) {
    this.beginDance(x, y, true);
    this.dance.state = 'planted';
    this.dance.fade = 1;
  }
}
