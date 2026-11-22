// 内心独白浮字 ThoughtSystem（R3 主美定调第 8 条：HUD 管系统信息，浮字管情绪叙事）
//
// - 文案即 key：每句的 key 就是 i18n.ts 中的中文原句（英文在 EN_DICT 中覆盖），渲染时 I18n.t(key)。
// - 节流：同一句冷却 ≥ 90s；全局两句开始时刻间隔 ≥ 6s；最多 2 条同时显示（预分配槽位，满时 FIFO 顶替最旧一条）。
// - 等待队列：间隔未到时新句进入容量 2 的 FIFO 等待队列，间隔一到即显示；等待超过 PENDING_MAX_WAIT 的过期句丢弃
//   （避免"慢半拍"的独白）。"一次性"句（ONCE_KEYS）只在真正显示后才记为已说，被节流丢弃时下次事件仍可重试。
// - 单源真相：淡入/停留/上浮/淡出的包络只在本文件 tick() 推进；render/thoughtsDraw.ts 只读 items。
// - 零每帧分配：槽位与等待队列全部预分配；冷却表 Map 的键集合受文案条数约束（≤ 约 20 条）。
// - 随机数自带种子（低血量偶发），不消耗 engine.rng，既有 sim-check 轨迹与断言不受影响。

import type { GameEngine } from './engine';
import { clamp, createRng } from './util';

// ---------------------------------------------------------------------------
// 参数表
// ---------------------------------------------------------------------------
/** 同时显示上限 */
export const THOUGHT_MAX = 2;
/** 同一句冷却（秒） */
export const THOUGHT_SAME_CD = 90;
/** 全局两句开始时刻最小间隔（秒） */
export const THOUGHT_GLOBAL_GAP = 6;
/** 淡入 / 淡出时长（秒） */
export const THOUGHT_FADE_IN = 0.4;
export const THOUGHT_FADE_OUT = 0.8;
/** 停留时长区间（秒；按文案长度线性取值，长句多停一会） */
export const THOUGHT_HOLD_MIN = 3.5;
export const THOUGHT_HOLD_MAX = 4.5;
/** 整个生命周期内缓慢上浮的总距离（px） */
export const THOUGHT_RISE = 12;
/** 等待队列容量与最长等待（秒） */
const PENDING_CAP = 2;
const PENDING_MAX_WAIT = 8;

// ---------------------------------------------------------------------------
// 文案（key = 中文原句；英文见 i18n.ts）
// ---------------------------------------------------------------------------
export const THOUGHT_TEXT = {
  whisper: '树在低语，听起来如此平静……',
  airWrong: '这里的空气不对劲。',
  truck: '车上的人……都去哪儿了？',
  mill: '锯子还在等着谁回来。',
  farm: '田地荒了很久，可脚印是新的。',
  village: '每扇窗都朝着林子，像在等谁。',
  church: '钟不再响了。可我还是听见了什么。',
  doctor: '医生……他也没能救自己。',
  marsh: '水面下有东西在看着我。',
  danceFirst: '有人在那里跳舞……不，不可能。',
  danceRain: '她又在雨里跳舞了。',
  table: '是谁在敲那张桌子？',
  chair: '那把椅子……刚才是朝着桌子的。',
  generator: '灯灭了。黑暗在靠近。',
  nightOutside: '天黑了。我不该还在外面。',
  nightInside: '天黑了。守住这点光。',
  legs: '我的腿快撑不住了。',
  bleed: '血止不住……我得找东西包扎。',
} as const;

/** 区域专属独白（区域名来自 world.poiCenters；未列出的新区域回落到"树在低语"） */
const ZONE_THOUGHTS: Record<string, string> = {
  坠毁货车: THOUGHT_TEXT.truck,
  废弃锯木厂: THOUGHT_TEXT.mill,
  猎人营地: THOUGHT_TEXT.whisper,
  枯林祭坛: THOUGHT_TEXT.airWrong,
  荒芜农庄: THOUGHT_TEXT.farm,
  林中村落: THOUGHT_TEXT.village,
  木教堂: THOUGHT_TEXT.church,
  医生之屋: THOUGHT_TEXT.doctor,
  沼泽渔屋: THOUGHT_TEXT.marsh,
  信号塔: THOUGHT_TEXT.airWrong,
  旧铁道口: THOUGHT_TEXT.whisper,
};

/** 一局只说一次的句子（"首次"类事件） */
const ONCE_KEYS: ReadonlySet<string> = new Set<string>([
  THOUGHT_TEXT.danceFirst,
  THOUGHT_TEXT.danceRain,
  THOUGHT_TEXT.table,
]);

/** 首次进入区域时的独白 key（engine 在 discoveredZones 首次加入处调用） */
export function zoneThought(zone: string): string {
  if (zone === '庇护所' || zone === '迷雾深林') return '';
  return ZONE_THOUGHTS[zone] ?? THOUGHT_TEXT.whisper;
}

// ---------------------------------------------------------------------------
// 状态结构（渲染只读）
// ---------------------------------------------------------------------------
export interface ThoughtLine {
  active: boolean;
  /** i18n 中文原句 */
  key: string;
  /** 已显示秒数 */
  t: number;
  /** 本句停留秒数（3.5–4.5） */
  hold: number;
  /** 总寿命 = 淡入 + 停留 + 淡出 */
  dur: number;
  /** 当前不透明度 0..1 */
  alpha: number;
  /** 当前上浮量 0..THOUGHT_RISE（px） */
  rise: number;
  /** 显示序号（越大越新；渲染据此上下错开） */
  order: number;
}

export class ThoughtSystem {
  /** 预分配显示槽位（长度恒为 THOUGHT_MAX） */
  readonly items: ThoughtLine[] = [];
  /** 本系统时钟（秒，仅 play 模式推进） */
  time = 0;
  /** 统计：已显示句数 / 被节流拒绝次数 */
  shownCount = 0;
  rejectCount = 0;
  /** 最近一次开始显示的时刻（sim-check 校验全局间隔） */
  lastShowAt = -1e9;

  private serial = 0;
  private saidAt = new Map<string, number>();
  private pendKey: string[] = [];
  private pendAt: number[] = [];
  private pendHead = 0;
  private pendCount = 0;
  private rng: () => number = createRng(0x7e0a9);
  /** 体力见底：触发后需回升到 60 以上才再次武装 */
  private legsArmed = true;
  /** 低血量偶发独白倒计时 */
  private bleedCd = 4;

  constructor() {
    for (let i = 0; i < THOUGHT_MAX; i++) {
      this.items.push({ active: false, key: '', t: 0, hold: THOUGHT_HOLD_MIN, dur: 1, alpha: 0, rise: 0, order: 0 });
    }
    for (let i = 0; i < PENDING_CAP; i++) {
      this.pendKey.push('');
      this.pendAt.push(0);
    }
  }

  /** 新局重置（engine.reset 调用） */
  reset(seed = 19847) {
    this.time = 0;
    this.shownCount = 0;
    this.rejectCount = 0;
    this.lastShowAt = -1e9;
    this.serial = 0;
    this.saidAt.clear();
    this.pendHead = 0;
    this.pendCount = 0;
    this.rng = createRng((seed ^ 0x7e0a9) >>> 0);
    this.legsArmed = true;
    this.bleedCd = 4;
    for (const it of this.items) {
      it.active = false;
      it.key = '';
      it.t = 0;
      it.alpha = 0;
      it.rise = 0;
      it.order = 0;
    }
  }

  /** 当前正在显示的条数（≤ THOUGHT_MAX） */
  activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.items.length; i++) if (this.items[i].active) n++;
    return n;
  }

  /** 冷却 / 一次性判定：该句此刻是否允许说出 */
  private allowed(key: string): boolean {
    const last = this.saidAt.get(key);
    if (last === undefined) return true;
    if (ONCE_KEYS.has(key)) return false;
    return this.time - last >= THOUGHT_SAME_CD;
  }

  private isShowing(key: string): boolean {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.active && it.key === key) return true;
    }
    return false;
  }

  private isPending(key: string): boolean {
    for (let k = 0; k < this.pendCount; k++) {
      if (this.pendKey[(this.pendHead + k) % PENDING_CAP] === key) return true;
    }
    return false;
  }

  /**
   * 说一句内心独白。返回 true 表示已显示或已进入等待队列；false 表示被冷却/一次性/队列满拒绝。
   * 可在每帧条件成立时重复调用（同句已显示或已排队时直接返回 false，零分配）。
   */
  think(key: string): boolean {
    if (!key) return false;
    if (!this.allowed(key) || this.isShowing(key) || this.isPending(key)) {
      this.rejectCount++;
      return false;
    }
    if (this.time - this.lastShowAt >= THOUGHT_GLOBAL_GAP && this.pendCount === 0) {
      this.show(key);
      return true;
    }
    if (this.pendCount >= PENDING_CAP) {
      this.rejectCount++;
      return false;
    }
    const slot = (this.pendHead + this.pendCount) % PENDING_CAP;
    this.pendKey[slot] = key;
    this.pendAt[slot] = this.time;
    this.pendCount++;
    return true;
  }

  /** 立即显示（内部；满槽时 FIFO 顶替最旧一条） */
  private show(key: string) {
    let slot: ThoughtLine | null = null;
    for (let i = 0; i < this.items.length; i++) {
      if (!this.items[i].active) {
        slot = this.items[i];
        break;
      }
    }
    if (!slot) {
      slot = this.items[0];
      for (let i = 1; i < this.items.length; i++) {
        if (this.items[i].order < slot.order) slot = this.items[i];
      }
    }
    slot.active = true;
    slot.key = key;
    slot.t = 0;
    slot.hold = clamp(THOUGHT_HOLD_MIN + (key.length - 8) * 0.06, THOUGHT_HOLD_MIN, THOUGHT_HOLD_MAX);
    slot.dur = THOUGHT_FADE_IN + slot.hold + THOUGHT_FADE_OUT;
    slot.alpha = 0;
    slot.rise = 0;
    slot.order = ++this.serial;
    this.saidAt.set(key, this.time);
    this.lastShowAt = this.time;
    this.shownCount++;
  }

  /** 调试 / sim-check：跳过冷却与间隔直接显示（不在正常流程中调用） */
  debugForce(key: string) {
    if (key) this.show(key);
  }

  /** 纯时钟推进：等待队列出队 + 槽位包络（sim-check 可脱离 engine 单独驱动） */
  tick(dt: number) {
    this.time += dt;

    // 等待队列：丢弃过期句；间隔已到则出队显示（出队时再判一次冷却，期间可能已被说过）
    while (this.pendCount > 0) {
      const key = this.pendKey[this.pendHead];
      const stale = this.time - this.pendAt[this.pendHead] > PENDING_MAX_WAIT;
      const blocked = !this.allowed(key) || this.isShowing(key);
      if (!stale && !blocked) {
        if (this.time - this.lastShowAt < THOUGHT_GLOBAL_GAP) break;
        this.show(key);
      }
      this.pendKey[this.pendHead] = '';
      this.pendHead = (this.pendHead + 1) % PENDING_CAP;
      this.pendCount--;
      if (!stale && !blocked) break;
    }

    // 包络：0.4s 淡入 → 停留 3.5–4.5s → 0.8s 淡出；全程缓慢上浮 12px（缓出）
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.active) continue;
      it.t += dt;
      if (it.t >= it.dur || !Number.isFinite(it.t)) {
        it.active = false;
        it.alpha = 0;
        it.rise = 0;
        continue;
      }
      let a: number;
      if (it.t < THOUGHT_FADE_IN) {
        const k = it.t / THOUGHT_FADE_IN;
        a = k * k * (3 - 2 * k);
      } else if (it.t < THOUGHT_FADE_IN + it.hold) {
        a = 1;
      } else {
        const k = clamp((it.t - THOUGHT_FADE_IN - it.hold) / THOUGHT_FADE_OUT, 0, 1);
        a = 1 - k * k * (3 - 2 * k);
      }
      const u = clamp(it.t / it.dur, 0, 1);
      it.alpha = clamp(a, 0, 1);
      it.rise = THOUGHT_RISE * (1 - (1 - u) * (1 - u));
      if (!Number.isFinite(it.alpha) || !Number.isFinite(it.rise)) {
        it.alpha = 0;
        it.rise = 0;
      }
    }
  }

  /**
   * 主入口：由 engine.step 每个固定步调用一次（仅 play 模式）。
   * 只读 engine 状态做"状态型"触发（体力见底 / 低血量偶发），然后推进时钟。
   * 事件型触发（进入新区域、发电机熄灭、首夜、异象）由各自事件点调用 engine.think(key)。
   */
  update(engine: GameEngine, dt: number) {
    const p = engine.player;

    // 体力见底（冲刺耗尽 ≈6 以下）：一次触发，体力回升到 60 以上才重新武装
    if (p.stamina < 8) {
      if (this.legsArmed) {
        this.legsArmed = false;
        this.think(THOUGHT_TEXT.legs);
      }
    } else if (p.stamina > 60) {
      this.legsArmed = true;
    }

    // 低血量偶发：生命 < 30% 时每 18–38s 掷一次 50% 概率
    if (p.hp > 0 && p.hp < p.maxHp * 0.3) {
      this.bleedCd -= dt;
      if (this.bleedCd <= 0) {
        this.bleedCd = 18 + this.rng() * 20;
        if (this.rng() < 0.5) this.think(THOUGHT_TEXT.bleed);
      }
    } else {
      this.bleedCd = 4;
    }

    this.tick(dt);
  }
}
