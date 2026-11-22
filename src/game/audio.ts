// 物理驱动的纯程序化 Web Audio 立体声恐怖音频引擎（零外部音频文件、零网络请求、零 AudioWorklet）
// 空间层：程序化脉冲响应双卷积混响（森林 ~2.8s 暗而扩散 / 木屋 ~0.6s 木质中频），依室内外状态 setTargetAtTime 平滑交叉淡化；
//         一次性空间音效按距离做空气吸收低通 + 干/湿发送（越远越湿、越闷），隔墙声源进入对侧空间混响并经墙体低通
// 氛围层：随机游走阵风（左右声道独立漂移）+ 偶发树木吱嘎/远处枝断；分层雨（远处嘶嘶底 + 分表面连续雨层 + 室内屋顶敲击 + 屋檐滴水）；
//         发电机低鸣与低油量咳喘、黑夜低频压迫、危险心跳；稀疏环境叙事声（白天鸦鸣/枝断，夜晚远处敲击/拖拽/低语）
// 末端：主增益 → 总线软压缩 → 快速限幅（两级 DynamicsCompressor）；所有运行期参数变化走 setTargetAtTime / linearRamp，杜绝爆音
// 回收：所有一次性音效经 OneShot 收集器登记，最后一个声源 onended 时统一 disconnect
// 第二轮：分表面连续雨层（树叶/泥地/积水/屋顶木瓦 + 铁皮叮当 + 树冠大水滴，随阵风起伏扫动）；乌鸦与昼/昏/夜生命层；
//         身体反馈（疾跑呼吸与步频耦合、见底喘息、统一心跳、低血耳鸣与整体低通、蓄力握柄吱嘎与憋气）；动作音效重做
// 第三轮：物理化雨滴粒子云（撞击瞬态 + Minnaert 气泡共振，近处稀疏可辨/远场融合去相关，叶片回弹二次嗒、屋檐细流），
//         全部雨层改为"随机重排"（两槽交叉淡化、随机段长/起点/速率，杜绝循环周期）；装备/关卡/惊吓音效与火把/闹鬼常驻链

import { clamp } from './util';

const MUTE_KEY = 'blackwood_mute_v1';

/** 第三轮雨层响度标定（按长时平均 RMS 与第二轮对齐，见交付频谱表）：0 近处稀疏树叶 / 1 中景密集树冠 / 2 泥土草地 / 3 积水 */
const RAIN_W = [0.71, 0.37, 0.54, 0.345];
/** 远场粒子云 / 地面低频轰鸣 / 屋檐细流的响度系数 */
const RAIN_FAR_K = 0.115;
const RAIN_ROAR_K = 0.08;
const RAIN_EAVE_K = 0.9;
/** 真实录音层响度系数（素材统一 -28 dBFS RMS；按长时平均 RMS 与第二轮程序化雨对齐 ±0.5dB）：室外淡雨 / 大雨 / 近处积水 / 雨后滴水 / 室内篷顶底料 / 滚雷 */
const REC_K = { light: 0.3, heavy: 0.55, puddle: 0.3, drip: 0.25, roof: 0.5, thunder: 1.6 };

/**
 * 2D 空间音效定位与隔墙衰减参数
 */
export interface SpatialAudioOpts {
  worldX: number;
  worldY: number;
  listenerX: number;
  listenerY: number;
  /** 发声源与听者分处庇护所内外时为 true，启用 ~650Hz 低通模拟厚木墙闷响 */
  muffled?: boolean;
  /** 最大可听衰减距离（像素），默认 680 */
  maxDist?: number;
}

/** 空间路由结果（内部使用） */
interface SpatialRoute {
  /** 音效最终应连接到的入口节点 */
  input: AudioNode;
  /** 距离 + 隔墙的综合音量系数 */
  gainScale: number;
  /** 0 = 贴身，1 = 最远可听距离 */
  dist01: number;
  /** 本次路由新建的临时节点，音效结束后需断开 */
  nodes: AudioNode[];
}

/** 程序化脉冲响应参数（内部使用） */
interface ImpulseOpts {
  /** 缓冲总长（秒） */
  seconds: number;
  /** 衰减 60dB 所需时间（秒） */
  t60: number;
  /** 预延迟（秒） */
  preDelay: number;
  /** 稀疏早期反射数量 */
  earlyCount: number;
  /** 早期反射分布时间跨度（秒） */
  earlySpan: number;
  /** 早期反射幅度 */
  earlyGain: number;
  /** 尾音起始低通截止（Hz），随时间指数滑向 lpEnd，实现"高频衰减更快" */
  lpStart: number;
  lpEnd: number;
  /** 高通截止（Hz），去除低频浑浊堆积 */
  hpHz: number;
  /** 扩散尾音的建立时间（秒） */
  rise: number;
  /** 反馈梳状滤波延迟（毫秒，0 = 关闭），给木屋加"箱体"木质共鸣 */
  combMs: number;
  combFb: number;
}

/** 脚步合成的公共上下文（内部使用） */
interface StepCtx {
  ctx: AudioContext;
  shot: OneShot;
  out: AudioNode;
  now: number;
  pitch: number;
  vel: number;
  white: AudioBuffer;
  pink: AudioBuffer;
}

/**
 * 一次性音效的临时节点收集器：登记全部临时节点，
 * 并在"最晚结束的声源" onended 时统一断开整条链，及时回收
 */
class OneShot {
  private readonly nodes: AudioNode[] = [];
  private lastSrc: AudioScheduledSourceNode | null = null;
  private lastEnd = -Infinity;

  /** 登记普通处理节点（滤波 / 增益 / 声像） */
  add<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  /** 批量登记（如空间路由返回的节点） */
  addAll(list: AudioNode[]) {
    for (let i = 0; i < list.length; i++) this.nodes.push(list[i]);
  }

  /** 登记声源节点及其预计结束时刻 */
  src<T extends AudioScheduledSourceNode>(node: T, endTime: number): T {
    this.nodes.push(node);
    if (endTime > this.lastEnd) {
      this.lastEnd = endTime;
      this.lastSrc = node;
    }
    return node;
  }

  /** 绑定回收：最后一个声源播放完毕后断开整条链 */
  seal() {
    const last = this.lastSrc;
    if (!last) return;
    const nodes = this.nodes;
    last.onended = () => {
      for (let i = 0; i < nodes.length; i++) {
        try {
          nodes[i].disconnect();
        } catch {
          // 已断开则忽略
        }
      }
      nodes.length = 0;
    };
  }
}

/** S 形平滑阶跃：把 x 限制到 [0,1] 后做 3t²-2t³ */
function smooth01(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** 区间随机数 [a, b) */
function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** 随机方位声像：刻意避开正中，便于戴耳机辨别左右 */
function randomPan(spread = 0.9): number {
  const side = Math.random() < 0.5 ? -1 : 1;
  return side * (0.22 + Math.random() * Math.max(0, spread - 0.22));
}

/** 高精度计时（无 performance 时回退 Date.now） */
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * 常驻"随机重排"层：两条常驻交叉淡化槽轮流承载一次性缓冲段——每段随机取池中缓冲、随机起点、随机时长与微小速率偏移，
 * 段间等功率交叉淡化（淡入淡出时长同样随机），彻底杜绝固定循环周期；out 为层增益（随雨势连续变化）
 */
interface ShuffleLayer {
  pool: AudioBuffer[];
  slots: GainNode[];
  out: GainNode;
  /** 下一段使用的槽（0/1 轮换） */
  slot: number;
  /** 下一段起始时刻（ctx 时间） */
  nextAt: number;
  /** 上一段选定的淡出时长 = 下一段淡入时长（保证等功率交叉） */
  xf: number;
  baseRate: number;
  drift: number;
  segMin: number;
  segMax: number;
  /** 最近一次推送的层权重（近零时不再排段 → 无雨零分配） */
  weight: number;
  /** 交叉淡化时长范围（秒）与段内速率随机幅度 */
  xfMin: number;
  xfMax: number;
  jit: number;
  /** true：段不跨越缓冲末尾（录音层：规避编解码尾部填充造成的回绕缝隙） */
  noWrap: boolean;
}

/** 雨滴粒子预渲染画布（立体声，写入越界按模回绕 → 任意起点循环无接缝） */
interface RainCanvas {
  L: Float32Array;
  R: Float32Array;
  len: number;
  sr: number;
  /** 共享白噪声表（2 的幂长度），代替逐样本 Math.random 以压低初始化耗时 */
  noise: Float32Array;
  mask: number;
}

/**
 * 雨滴撞击瞬态：n 样本指数衰减噪声 → 一阶低通（lpHz，模拟受击面/距离的亮度）→ 一阶差分（hp 0..1，越大越"脆"）。
 * itd > 0 右耳滞后、< 0 左耳滞后（样本数），近处单滴借此获得双耳时间差
 */
function rainImpact(
  c: RainCanvas,
  j0: number,
  n: number,
  amp: number,
  gl: number,
  gr: number,
  itd: number,
  lpHz: number,
  hp: number
): void {
  const len = c.len;
  const L = c.L;
  const R = c.R;
  const nz = c.noise;
  const mask = c.mask;
  const cnt = Math.max(2, Math.min(len - 1, Math.floor(n)));
  const a = lpHz >= c.sr * 0.45 ? 1 : 1 - Math.exp((-2 * Math.PI * lpHz) / c.sr);
  const dec = Math.exp(-5 / cnt);
  let k = Math.floor(Math.random() * mask);
  let env = amp;
  let lp = 0;
  let prev = 0;
  const sh = Math.round(itd);
  let jl = (j0 + (sh < 0 ? -sh : 0)) % len;
  let jr = (j0 + (sh > 0 ? sh : 0)) % len;
  for (let i = 0; i < cnt; i++) {
    lp += a * (nz[k] - lp);
    k = (k + 1) & mask;
    const s = (lp - hp * prev) * env;
    prev = lp;
    env *= dec;
    L[jl] += s * gl;
    R[jr] += s * gr;
    if (++jl >= len) jl = 0;
    if (++jr >= len) jr = 0;
  }
}

/**
 * 衰减正弦（二阶递推谐振，免逐样本 sin）：Minnaert 气泡共振 / 叶片与木板模态。
 * rise 为全程相对音高上滑量（气泡上浮收缩的"啾"），每 16 样本更新一次系数；初值使首样本即以正弦相位起振
 */
function rainRing(
  c: RainCanvas,
  j0: number,
  f0: number,
  tau: number,
  amp: number,
  gl: number,
  gr: number,
  itd: number,
  rise: number
): void {
  const len = c.len;
  const sr = c.sr;
  const L = c.L;
  const R = c.R;
  const n = Math.min(len - 1, Math.floor(tau * sr * 4));
  if (n <= 2 || !(f0 > 0)) return;
  const r = Math.exp(-1 / (tau * sr));
  const d2 = r * r;
  const tw = (2 * Math.PI) / sr;
  const wMax = Math.PI * 0.95;
  let w = Math.min(wMax, f0 * tw);
  let c2 = 2 * Math.cos(w) * r;
  let y1 = 0;
  let y2 = (-amp * Math.sin(w)) / r;
  const sh = Math.round(itd);
  let jl = (j0 + (sh < 0 ? -sh : 0)) % len;
  let jr = (j0 + (sh > 0 ? sh : 0)) % len;
  for (let i = 0; i < n; i++) {
    const y = c2 * y1 - d2 * y2;
    y2 = y1;
    y1 = y;
    L[jl] += y * gl;
    R[jr] += y * gr;
    if (++jl >= len) jl = 0;
    if (++jr >= len) jr = 0;
    if (rise !== 0 && (i & 15) === 15) {
      w = Math.min(wMax, f0 * (1 + (rise * i) / n) * tw);
      c2 = 2 * Math.cos(w) * r;
    }
  }
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;

  // —— 空间混响与分组总线 ——
  /** 森林混响输入（室外声源直送） */
  private forestIn: GainNode | null = null;
  private forestOut: GainNode | null = null;
  /** 听者在室内时，森林混响需穿墙：对其返回做低通 */
  private forestWallLP: BiquadFilterNode | null = null;
  /** 木屋混响输入（室内声源直送） */
  private hutIn: GainNode | null = null;
  private hutOut: GainNode | null = null;
  /** 听者在室外时，木屋混响需穿墙：对其返回做低通 */
  private hutWallLP: BiquadFilterNode | null = null;
  /** "听者所在空间"发送：按室内外交叉淡化分配到森林 / 木屋 */
  private roomSend: GainNode | null = null;
  private roomToForest: GainNode | null = null;
  private roomToHut: GainNode | null = null;
  /** 近身音效总线（玩家自身脚步/挥砍等），带少量所在空间混响 */
  private nearBus: GainNode | null = null;
  private nearSend: GainNode | null = null;
  /** 室外氛围总线（风/雨/雷/环境叙事），听者进屋时整体低通压暗 */
  private outdoorBus: GainNode | null = null;
  private outdoorLP: BiquadFilterNode | null = null;
  private outdoorTrim: GainNode | null = null;

  // —— 风 ——
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private gustGainA: GainNode | null = null;
  private gustBPA: BiquadFilterNode | null = null;
  private gustGainB: GainNode | null = null;
  private gustBPB: BiquadFilterNode | null = null;
  private whistleGain: GainNode | null = null;
  private whistleBP: BiquadFilterNode | null = null;

  // —— 雨（分表面连续层） ——
  /** 远处雨幕嘶嘶底噪 */
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  /** 重雨时地面低频轰鸣 */
  private rainRoarGain: GainNode | null = null;
  private rainRoarLP: BiquadFilterNode | null = null;
  /** 室外雨总线：随阵风整体起伏并左右扫动 */
  private rainBus: GainNode | null = null;
  private rainPan: StereoPannerNode | null = null;
  /** 树叶雨层亮度（高频沙沙）与泥地雨层闷度 */
  private leafLP: BiquadFilterNode | null = null;
  private mudLP: BiquadFilterNode | null = null;
  /** 表面雨层：0 近处稀疏树叶 / 1 中景密集树冠 / 2 泥土草地 / 3 积水（随机重排，增益与速率随雨势连续变化） */
  private rainLayers: ShuffleLayer[] = [];
  /** 远场雨幕粒子云（取代第二轮带通粉噪嘶声） */
  private farRain: ShuffleLayer | null = null;
  /** 屋檐细流（连续细流 + 断续滴落） */
  private eaveLayer: ShuffleLayer | null = null;
  /** 室内屋顶层：0 稀疏木瓦 / 1 密集木瓦（随机重排） */
  private roofLayers: ShuffleLayer[] = [];
  /** 木屋箱体低频共鸣（雨越大越"鼓"） */
  private roofBody: BiquadFilterNode | null = null;

  // —— 发电机与黑夜压迫 ——
  private genGain: GainNode | null = null;
  private genFilter: BiquadFilterNode | null = null;
  private genOsc: OscillatorNode | null = null;
  private genOsc2: OscillatorNode | null = null;
  private dreadGain: GainNode | null = null;
  private dreadOsc: OscillatorNode | null = null;

  // —— 预生成缓冲 ——
  private whiteBuf: AudioBuffer | null = null;
  private pinkBuf: AudioBuffer | null = null;
  private brownBuf: AudioBuffer | null = null;
  /** 雨粒子缓冲池：0 近处树叶 / 1 中景树冠 / 2 泥土草地 / 3 积水 / 4 远场 / 5 屋檐 */
  private rainPools: AudioBuffer[][] = [];
  /** 粒子预渲染共享白噪声表 */
  private noiseTable: Float32Array | null = null;
  /** 火焰噼啪颗粒（可无缝循环） */
  private crackleBuf: AudioBuffer | null = null;
  /** 屋顶缓冲：稀疏 / 密集 */
  private roofBufs: AudioBuffer[] = [];
  private creakBufs: AudioBuffer[] = [];
  /** 蓄力握柄吱嘎（可无缝循环） */
  private gripBuf: AudioBuffer | null = null;

  private muted = false;
  private pageHidden = false;
  private initialized = false;
  private heartbeatPhase = 0;
  private lastDragSoundAt = -10;
  private listeners = new Set<() => void>();

  // —— 氛围状态（每帧仅做标量运算，不分配节点） ——
  private listenerIndoor = false;
  private ambAccum = 1;
  private gustA = 0.35;
  private gustB = 0.3;
  private gustFA = 0;
  private gustFB = 0;
  private wetMemory = 0;
  private treeCreakTimer = 9;
  private branchTimer = 21;
  private dripTimer = 2;
  private narrativeTimer = 14;
  private stepSide = 1;
  private buildMs = 0;

  // —— 环境生命层（常驻音床 + 稀疏事件计时器） ——
  private canopyGainL: GainNode | null = null;
  private canopyGainR: GainNode | null = null;
  private canopyBP: BiquadFilterNode | null = null;
  private cricketGains: GainNode[] = [];
  private dayLifeTimer = 12;
  private duskLifeTimer = 6;
  private nightLifeTimer = 10;
  private canopyDropTimer = 3;
  private tinTimer = 2;
  private lastLifeAt = -100;
  private lastHowlAt = -100;
  private rainNow = 0;
  /** 离庇护所（发电机）距离与屋檐细流接近度 */
  private genDistNow = 1e4;
  private eaveProx = 0;

  // —— 第三轮：火把（手持 / 地面）与闹鬼常驻链（每步只做参数平滑，不分配节点） ——
  private torchBus: GainNode | null = null;
  private torchCrackG: GainNode | null = null;
  private torchCrackSrc: AudioBufferSourceNode | null = null;
  private torchRoarG: GainNode | null = null;
  private torchRoarLP: BiquadFilterNode | null = null;
  private torchWhooshG: GainNode | null = null;
  private torchWhooshBP: BiquadFilterNode | null = null;
  private torchWhistleG: GainNode | null = null;
  private torchWhistleBP: BiquadFilterNode | null = null;
  private torchSizzleG: GainNode | null = null;
  private torchSent = 0;
  private torchSentMs = 0;
  private torchLastMs = 0;
  private torchFlick = 0;
  private torchMotionSm = 0;
  private gtIn: GainNode | null = null;
  private gtLP: BiquadFilterNode | null = null;
  private gtPan: StereoPannerNode | null = null;
  private gtDry: GainNode | null = null;
  private gtSendF: GainNode | null = null;
  private gtSendH: GainNode | null = null;
  private gtCrackG: GainNode | null = null;
  private gtRoarG: GainNode | null = null;
  private gtSizzleG: GainNode | null = null;
  private gtSent = 0;
  private gtSentMs = 0;
  private gtFlick = 0;
  private hauntHumG: GainNode | null = null;
  private hauntOscA: OscillatorNode | null = null;
  private hauntOscB: OscillatorNode | null = null;
  private hauntSent = 0;
  private hauntSentMs = 0;
  private hauntLastMs = 0;
  private hauntWob = 0;
  /** 环境 dread 目标（黑夜/危险），与闹鬼取最大 */
  private dreadAmb = 0;
  private dreadHzAmb = 41.2;
  /** 耳鸣目标：低血量 / 闹鬼，取最大 */
  private tinnBody = 0;
  private tinnHaunt = 0;

  // —— 第三轮：真实雨声录音（CC0，异步解码，失败静默回退程序化） ——
  private recUrls: {
    outdoorLight: string;
    outdoorHeavy: string;
    puddleNear: string;
    dripAfter: string;
    indoorRoof: string;
    thunder?: string[];
  } | null = null;
  private recLoading = false;
  private recReady = false;
  private recReadyAt = 0;
  /** 0 淡雨 / 1 大雨 / 2 近处积水 / 3 雨后滴水 / 4 室内篷顶（缺失层为 null） */
  private recLayers: Array<ShuffleLayer | null> = [];
  private recThunder: AudioBuffer[] = [];
  /** 室内屋顶木质 EQ 链入口（程序化木瓦层与录音篷顶层共用） */
  private roofIn: BiquadFilterNode | null = null;

  // —— 身体反馈（常驻链，每帧只做参数平滑，不分配节点） ——
  /** 身体总线：呼吸/心跳/耳鸣/憋气，骨传导感——不经低血量低通；增益与主增益同步跟随静音/切后台 */
  private bodyBus: GainNode | null = null;
  /** 低血量整体轻微低通（插在主增益与总线压缩之间，常态近乎透明） */
  private hurtLP: BiquadFilterNode | null = null;
  private tinnitusGain: GainNode | null = null;
  private breathG: GainNode | null = null;
  private breathBP: BiquadFilterNode | null = null;
  private voiceG: GainNode | null = null;
  private voiceOsc: OscillatorNode | null = null;
  private gripG: GainNode | null = null;
  private gripSrc: AudioBufferSourceNode | null = null;
  private gripBP: BiquadFilterNode | null = null;
  private strainG: GainNode | null = null;
  private strainBP: BiquadFilterNode | null = null;
  private strainHumG: GainNode | null = null;
  private strainOsc: OscillatorNode | null = null;
  private tremDepth: GainNode | null = null;
  private chargeSent = 0;
  private chargeSentMs = 0;
  /** 最近一次 updateBody / updateAmbience 调用时刻（毫秒），用于心跳单一节拍器的归属判定 */
  private bodyLastMs = -1e9;
  private ambLastMs = -1e9;
  private dangerNow = 0;
  /** 平滑后的体力消耗度 / 伤势 / 身体心跳驱动（0..1） */
  private exertSm = 0;
  private hurtSm = 0;
  private heartBodySm = 0;
  private breathTimer = 0;
  private breathBusyUntil = 0;
  private sprintNow = false;
  private sprintSince = -10;
  private lastSprintStepAt = -10;
  private stepIntSm = 0.18;
  private stepsSinceBreath = 0;
  private bodyAccum = 1;
  private lastHeavySwingAt = -10;
  private swingSide = 1;

  constructor() {
    try {
      this.muted = window.localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.pageHidden = document.hidden;
        this.applyMasterGain();
      });
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** 初始化时预生成全部缓冲（含两条脉冲响应）的耗时（毫秒），供验收探针读取 */
  get bufferBuildMs(): number {
    return this.buildMs;
  }

  setMuted(next: boolean) {
    this.muted = next;
    try {
      window.localStorage.setItem(MUTE_KEY, next ? '1' : '0');
    } catch {
      // 忽略无痕模式或禁存环境异常
    }
    this.applyMasterGain();
    this.listeners.forEach((fn) => fn());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 首次用户交互时解锁 AudioContext，并初始化末端限幅、混响总线与连续氛围音床
   */
  unlock() {
    if (typeof window === 'undefined') return;
    if (!this.initialized) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      try {
        const ctx = new AudioCtx();
        this.ctx = ctx;
        const now = ctx.currentTime;

        // 末端第一级：总线软压缩，防止多声源叠加削波爆音
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.setValueAtTime(-14, now);
        comp.knee.setValueAtTime(18, now);
        comp.ratio.setValueAtTime(8, now);
        comp.attack.setValueAtTime(0.005, now);
        comp.release.setValueAtTime(0.12, now);

        // 末端第二级：快速限幅兜底（近雷 + 怪物 + 破门同时发生时也不过载）
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.setValueAtTime(-2, now);
        limiter.knee.setValueAtTime(0, now);
        limiter.ratio.setValueAtTime(20, now);
        limiter.attack.setValueAtTime(0.002, now);
        limiter.release.setValueAtTime(0.09, now);

        const master = ctx.createGain();
        master.gain.setValueAtTime(0, now);
        // 低血量整体轻微低通：常态截止 ~20kHz 近乎透明，由 updateBody 平滑下压
        const hurtLP = ctx.createBiquadFilter();
        hurtLP.type = 'lowpass';
        hurtLP.frequency.setValueAtTime(Math.min(20000, ctx.sampleRate * 0.45), now);
        hurtLP.Q.setValueAtTime(0, now);
        master.connect(hurtLP);
        hurtLP.connect(comp);
        // 身体总线：直入压缩器（绕过低血量低通），增益与主增益同目标同步，静音/切后台行为一致
        const bodyBus = ctx.createGain();
        bodyBus.gain.setValueAtTime(0, now);
        bodyBus.connect(comp);
        comp.connect(limiter);
        limiter.connect(ctx.destination);

        this.compressor = comp;
        this.limiter = limiter;
        this.masterGain = master;
        this.hurtLP = hurtLP;
        this.bodyBus = bodyBus;

        // 预生成全部缓冲（目标 < 250ms；单个缓冲 ≤ 4.5s）
        const t0 = nowMs();
        this.whiteBuf = this.buildWhiteNoiseBuffer(ctx, 2.5);
        this.pinkBuf = this.buildLoopNoise(ctx, 4.5, 'pink');
        this.brownBuf = this.buildLoopNoise(ctx, 3.0, 'brown');
        // 第三轮雨粒子池：长度互不成整数比；运行期按随机段重排播放，缓冲本身不再决定可感知周期
        this.rainPools = [
          [this.buildRainParticleBuffer(ctx, 2.7, 'leaf', 85), this.buildRainParticleBuffer(ctx, 3.6, 'leaf', 85)],
          [this.buildRainParticleBuffer(ctx, 3.6, 'canopy', 720)],
          [this.buildRainParticleBuffer(ctx, 3.4, 'ground', 460)],
          [this.buildRainParticleBuffer(ctx, 2.8, 'water', 55), this.buildRainParticleBuffer(ctx, 3.9, 'water', 55)],
          [this.buildRainParticleBuffer(ctx, 3.0, 'far', 3600)],
          [this.buildRainParticleBuffer(ctx, 3.2, 'eave', 150)],
        ];
        this.crackleBuf = this.buildCrackleBuffer(ctx, 2.9);
        this.roofBufs = [this.buildRoofBuffer(ctx, 3.1, 55), this.buildRoofBuffer(ctx, 3.7, 220)];
        this.gripBuf = this.buildGripBuffer(ctx, 2.3);
        this.creakBufs = [
          this.buildCreakBuffer(ctx, 1.4, 55, 640),
          this.buildCreakBuffer(ctx, 1.9, 38, 470),
        ];
        this.setupMixBuses(ctx, master);
        this.buildMs = nowMs() - t0;

        this.setupContinuousBeds(ctx, master);
        this.setupLifeBeds(ctx);
        this.setupBodyBeds(ctx);
        this.setupToolBeds(ctx);
        this.initialized = true;
        // 已登记的录音在上下文就绪后开始异步解码（不阻塞初始化）
        this.startRecordingLoad();
      } catch {
        // 初始化失败：释放半成品上下文，下次交互再重试
        const failed = this.ctx;
        if (failed) failed.close().catch(() => {});
        this.ctx = null;
        this.masterGain = null;
        this.compressor = null;
        this.limiter = null;
        this.hurtLP = null;
        this.bodyBus = null;
        return;
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.applyMasterGain();
  }

  /**
   * 静音与切后台统一走 setTargetAtTime 平滑过渡，杜绝咔哒爆音
   */
  private applyMasterGain() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const target = this.muted || this.pageHidden ? 0 : 0.72;
    this.masterGain.gain.setTargetAtTime(target, now, 0.06);
    if (this.bodyBus) this.bodyBus.gain.setTargetAtTime(target, now, 0.06);
  }

  // ═══════════════════════════ 空间路由 ═══════════════════════════

  /**
   * 统一 2D 空间音效路由：
   * 方位声像（按水平方位角）+ 距离衰减 + 空气吸收低通（越远越闷）+ 干/湿发送（越远越湿）+ 隔墙低通
   * 隔墙声源的混响进入"声源所在空间"（例如听者在屋内、怪物在屋外 → 森林混响，再经墙体低通）
   */
  private createSpatialRoute(spatial?: SpatialAudioOpts): SpatialRoute {
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master) {
      throw new Error('AudioContext not initialized');
    }
    if (!spatial) {
      return { input: this.nearBus ?? master, gainScale: 1, dist01: 0, nodes: [] };
    }

    const now = ctx.currentTime;
    const dx = spatial.worldX - spatial.listenerX;
    const dy = spatial.worldY - spatial.listenerY;
    const distance = Math.hypot(dx, dy);
    const maxDist = spatial.maxDist ?? 680;
    const dist01 = clamp(distance / Math.max(1, maxDist), 0, 1);
    const distLinear = clamp(1 - dist01, 0.08, 1);
    const muffleGain = spatial.muffled ? 0.78 : 1.0;
    const gainScale = distLinear * (0.35 + 0.65 * distLinear) * muffleGain;
    const nodes: AudioNode[] = [];

    let tail: AudioNode = master;

    // 1. 方位声像：按水平方位角（dx / 距离）计算，贴身 36px 内收窄避免左右跳变；clamp 0.9 保留头影自然感
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      const pan = clamp((dx / Math.max(distance, 36)) * 0.9, -0.9, 0.9);
      panner.pan.setValueAtTime(pan, now);
      panner.connect(tail);
      tail = panner;
      nodes.push(panner);
    }

    // 2. 隔墙低通（截止 ~650Hz，模拟厚木墙闷响）
    if (spatial.muffled) {
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.setValueAtTime(650, now);
      lpf.Q.setValueAtTime(0.85, now);
      lpf.connect(tail);
      tail = lpf;
      nodes.push(lpf);
    }

    // 3. 干声随距离略减（湿声比例随之上升）
    const dryTrim = ctx.createGain();
    dryTrim.gain.setValueAtTime(1 - 0.42 * dist01, now);
    dryTrim.connect(tail);
    nodes.push(dryTrim);

    // 4. 空气吸收低通：贴身 ~9.5kHz → 最远 ~1kHz
    const airLP = ctx.createBiquadFilter();
    airLP.type = 'lowpass';
    airLP.frequency.setValueAtTime(9500 * Math.pow(0.11, dist01), now);
    airLP.Q.setValueAtTime(0.5, now);
    airLP.connect(dryTrim);
    nodes.push(airLP);

    // 5. 湿发送：越远越湿；按声源所在空间选择森林或木屋混响
    const sourceIndoor = spatial.muffled ? !this.listenerIndoor : this.listenerIndoor;
    const reverbIn = sourceIndoor ? this.hutIn : this.forestIn;
    if (reverbIn) {
      const send = ctx.createGain();
      send.gain.setValueAtTime(0.1 + 0.55 * dist01, now);
      airLP.connect(send);
      send.connect(reverbIn);
      nodes.push(send);
    }

    return { input: airLP, gainScale, dist01, nodes };
  }

  /**
   * 远处环境声公共出口：空气吸收低通 → 声像 → 室外总线，并按 wet 送入森林混响
   * 返回入口节点与声像参数（供拖拽声做移动声像）
   */
  private distantOut(
    ctx: AudioContext,
    shot: OneShot,
    pan: number,
    lpHz: number,
    wet: number
  ): { input: AudioNode; pan: AudioParam | null } {
    const now = ctx.currentTime;
    const bus: AudioNode = this.outdoorBus ?? this.masterGain ?? ctx.destination;
    const lp = shot.add(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(clamp(lpHz, 200, 16000), now);
    lp.Q.setValueAtTime(0.6, now);

    let panParam: AudioParam | null = null;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(clamp(pan, -0.95, 0.95), now);
      lp.connect(p);
      p.connect(bus);
      panParam = p.pan;
    } else {
      lp.connect(bus);
    }

    if (this.forestIn && wet > 0) {
      const send = shot.add(ctx.createGain());
      send.gain.setValueAtTime(wet, now);
      lp.connect(send);
      send.connect(this.forestIn);
    }
    return { input: lp, pan: panParam };
  }

  /** 创建一次性噪声声源：随机起点读取预生成缓冲，超长时自动循环，并登记回收 */
  private noiseSource(
    ctx: AudioContext,
    shot: OneShot,
    buf: AudioBuffer,
    when: number,
    dur: number,
    rate = 1
  ): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.setValueAtTime(rate, when);
    const need = dur * rate;
    if (need >= buf.duration - 0.02) {
      src.loop = true;
      src.start(when, Math.random() * buf.duration * 0.9);
    } else {
      src.start(when, Math.random() * Math.max(0, buf.duration - need - 0.01));
    }
    src.stop(when + dur);
    shot.src(src, when + dur);
    return src;
  }

  /** 创建一次性振荡器并登记回收 */
  private oscSource(
    ctx: AudioContext,
    shot: OneShot,
    type: OscillatorType,
    freq: number,
    when: number,
    end: number
  ): OscillatorNode {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    osc.start(when);
    osc.stop(end);
    shot.src(osc, end);
    return osc;
  }

  /** 打击包络：从近零线性起音到峰值，再指数衰减至近零 */
  private perc(param: AudioParam, t: number, peak: number, attack: number, decay: number) {
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(Math.max(0.0002, peak), t + Math.max(0.001, attack));
    param.exponentialRampToValueAtTime(0.0001, t + Math.max(0.001, attack) + Math.max(0.005, decay));
  }

  /** 创建滤波器并登记回收 */
  private filt(
    ctx: AudioContext,
    shot: OneShot,
    type: BiquadFilterType,
    freq: number,
    q: number,
    when: number
  ): BiquadFilterNode {
    const f = shot.add(ctx.createBiquadFilter());
    f.type = type;
    f.frequency.setValueAtTime(clamp(freq, 20, 20000), when);
    f.Q.setValueAtTime(q, when);
    return f;
  }

  /** 创建增益节点并登记回收 */
  private amp(ctx: AudioContext, shot: OneShot, value: number, when: number): GainNode {
    const g = shot.add(ctx.createGain());
    g.gain.setValueAtTime(value, when);
    return g;
  }

  // ═══════════════════════════ 缓冲预生成 ═══════════════════════════

  private buildWhiteNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  /**
   * 生成可无缝循环的粉噪 / 棕噪缓冲：多生成 80ms 延续段，等功率交叉淡入头部，消除循环接缝咔哒
   * 粉噪沿用原 Paul Kellet 系数与 0.045 缩放（保持原有音量标定）；棕噪为泄漏积分白噪（雷声轰鸣/拖拽用）
   */
  private buildLoopNoise(ctx: AudioContext, seconds: number, color: 'pink' | 'brown'): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const fade = Math.floor(sr * 0.08);
    const tmp = new Float32Array(len + fade);
    if (color === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < tmp.length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        tmp[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
        b6 = white * 0.115926;
      }
    } else {
      let last = 0;
      for (let i = 0; i < tmp.length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        tmp[i] = last * 3.5;
      }
    }
    // 尾部延续段与头部等功率交叉：回绕点处样本连续
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      tmp[i] = tmp[i] * Math.sqrt(t) + tmp[len + i] * Math.sqrt(1 - t);
    }
    const buf = ctx.createBuffer(1, len, sr);
    buf.getChannelData(0).set(tmp.subarray(0, len));
    return buf;
  }

  /**
   * 程序化脉冲响应：稀疏早期反射 + 指数衰减扩散噪声尾 + 随时间下滑的低通（高频衰减更快 = 频率相关衰减）
   * 左右声道独立噪声与独立反射时刻，获得自然去相关的立体声空间感
   */
  private buildImpulseResponse(ctx: AudioContext, o: ImpulseOpts): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * o.seconds));
    const buf = ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * o.preDelay);
    const lpMul = Math.pow(o.lpEnd / o.lpStart, 1 / len);
    const hpA = 1 - Math.exp((-2 * Math.PI * o.hpHz) / sr);
    const decayMul = Math.exp(-6.9078 / (o.t60 * sr));
    const riseN = Math.max(1, Math.floor(sr * o.rise));
    const fadeN = Math.floor(len * 0.06);
    const combD = o.combMs > 0 ? Math.max(1, Math.floor(sr * o.combMs * 0.001)) : 0;
    const w = (2 * Math.PI) / sr;

    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);

      // 1) 稀疏早期反射：时间向前聚集、随机极性、逐次衰减
      for (let k = 0; k < o.earlyCount; k++) {
        const t = o.preDelay + Math.pow(Math.random(), 1.6) * o.earlySpan;
        const idx = Math.floor(t * sr);
        if (idx >= len) continue;
        const a =
          o.earlyGain *
          Math.exp((-3 * (t - o.preDelay)) / Math.max(0.001, o.earlySpan)) *
          (0.5 + Math.random() * 0.5);
        data[idx] += (Math.random() < 0.5 ? -1 : 1) * a;
      }

      // 2) 扩散尾音：指数衰减噪声，经时变一阶低通（逐渐变暗）与一阶高通
      let fc = o.lpStart;
      let lp = 0;
      let hs = 0;
      let env = 1;
      for (let i = 0; i < len; i++) {
        let x = data[i];
        if (i >= pre) {
          const n = i - pre;
          const rise = n < riseN ? n / riseN : 1;
          x += (Math.random() * 2 - 1) * env * rise;
          env *= decayMul;
        }
        const a = 1 - Math.exp(-w * fc);
        lp += a * (x - lp);
        hs += hpA * (lp - hs);
        data[i] = lp - hs;
        fc *= lpMul;
      }

      // 3) 可选反馈梳状：短延迟反馈带来木箱体的中频共鸣
      if (combD > 0 && o.combFb > 0) {
        for (let i = combD; i < len; i++) data[i] += o.combFb * data[i - combD];
      }

      // 4) 尾端淡出，避免截断
      for (let i = 0; i < fadeN; i++) data[len - 1 - i] *= i / fadeN;
    }
    return buf;
  }

  /** 共享白噪声表（65536 样本，按位回绕），供粒子预渲染读取，避免逐样本 Math.random */
  private getNoiseTable(): Float32Array {
    if (!this.noiseTable) {
      const t = new Float32Array(65536);
      for (let i = 0; i < t.length; i++) t[i] = Math.random() * 2 - 1;
      this.noiseTable = t;
    }
    return this.noiseTable;
  }

  /**
   * 第三轮：物理化雨滴粒子云预渲染（立体声，越界按模回绕 → 任意起点循环无接缝）。
   * 基本粒子 = 撞击宽带瞬态（rainImpact）+ 共振（rainRing：Minnaert 气泡 f ≈ 3.26/r kHz·mm，或受击面模态）：
   *   leaf   近处稀疏树叶：每滴独立声像 + 双耳时间差；脆亮撞击 + 叶片 0.7–2.6kHz 短模态；55% 叶片回弹抖落残水的二次小"嗒"；偶发溅散细珠
   *   canopy 中景密集树冠：同类粒子更密更轻、模态更短，声像铺满
   *   ground 泥土/草地：1–4ms 闷撞击（低通 1–2.6kHz）+ 120–380Hz 土面闷体，偶发细溅与泥水小气泡
   *   water  积水：撞击 + 62% 概率 Minnaert 气泡（r 0.8–3.3mm → 1–4kHz，τ 10–29ms，上浮上滑），偶发大滴低沉"咕咚"
   *   far    远场：每秒数千滴极轻粒子、左右独立随机（偏向两侧）→ 宽阔去相关、融合成细密沙声（非白噪嘶声）
   *   eave   屋檐：连续细流（低通噪声 × 周期性起伏 + 密集小气泡"咕噜"）+ 断续落入檐下水洼的较大"叮咚"
   * 幅度普遍取长尾分布：多数细微、偶有分明的一滴
   */
  private buildRainParticleBuffer(
    ctx: AudioContext,
    seconds: number,
    kind: 'leaf' | 'canopy' | 'ground' | 'water' | 'far' | 'eave',
    perSec: number
  ): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.max(256, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(2, len, sr);
    const noise = this.getNoiseTable();
    const c: RainCanvas = {
      L: buf.getChannelData(0),
      R: buf.getChannelData(1),
      len,
      sr,
      noise,
      mask: noise.length - 1,
    };
    const count = Math.floor(seconds * perSec);
    const itdMax = 0.00055 * sr;
    const ms = sr * 0.001;

    if (kind === 'eave') {
      // 1) 连续细流：二阶低通噪声 × 周期性起伏（整数个周期/缓冲 → 回绕连续），每 32 样本插值
      const k1 = 3 + Math.floor(Math.random() * 3);
      const k2 = 11 + Math.floor(Math.random() * 7);
      const k3 = 29 + Math.floor(Math.random() * 13);
      const p1 = Math.random() * 6.283;
      const p2 = Math.random() * 6.283;
      const p3 = Math.random() * 6.283;
      const a1 = 1 - Math.exp((-2 * Math.PI * 900) / sr);
      const tw = (2 * Math.PI) / len;
      let l1 = 0;
      let l2 = 0;
      let kk = 0;
      let am0 = 0.55;
      let am1 = 0.55;
      for (let i = 0; i < len; i++) {
        if ((i & 31) === 0) {
          am0 = am1;
          const x = i + 32;
          am1 = 0.55 + 0.22 * Math.sin(k1 * tw * x + p1) + 0.14 * Math.sin(k2 * tw * x + p2) + 0.08 * Math.sin(k3 * tw * x + p3);
        }
        const am = am0 + ((am1 - am0) * (i & 31)) / 32;
        l1 += a1 * (noise[kk] - l1);
        l2 += a1 * (l1 - l2);
        kk = (kk + 1) & c.mask;
        const s = l2 * am * 0.09;
        c.L[i] += s * 0.8;
        c.R[i] += s * 0.6;
      }
      // 2) 细流中的密集小气泡"咕噜"（音高偏低、上滑明显）
      for (let k = 0; k < count; k++) {
        const j = Math.floor(Math.random() * len);
        const p = (Math.random() * 2 - 1) * 0.3;
        const gl = Math.sqrt(0.5 * (1 - p));
        const gr = Math.sqrt(0.5 * (1 + p));
        const a = 0.012 + Math.pow(Math.random(), 2) * 0.05;
        rainRing(c, j, rnd(450, 1500), rnd(0.003, 0.01), a, gl, gr, 0, rnd(0.2, 0.6));
      }
      // 3) 断续落入檐下水洼的较大水滴：撞击 + 气泡"叮咚"
      const drips = Math.floor(seconds * rnd(3, 5.5));
      for (let k = 0; k < drips; k++) {
        const j = Math.floor(Math.random() * len);
        const p = (Math.random() * 2 - 1) * 0.5;
        const gl = Math.sqrt(0.5 * (1 - p));
        const gr = Math.sqrt(0.5 * (1 + p));
        const a = 0.06 + Math.pow(Math.random(), 1.5) * 0.14;
        rainImpact(c, j, rnd(0.5, 1.2) * ms, a * 0.6, gl, gr, 0, 5000, 0.5);
        const rad = 1.2 + Math.random() * 2.2;
        rainRing(c, (j + Math.floor(rnd(1, 4) * ms)) % len, 3260 / rad, 0.006 + 0.006 * rad, a * 0.7, gl, gr, 0, rnd(0.1, 0.3));
      }
      return buf;
    }

    for (let k = 0; k < count; k++) {
      const j = Math.floor(Math.random() * len);

      if (kind === 'far') {
        // 远场：偏向两侧的独立声像 → 去相关；无 ITD；极轻
        const side = Math.random() < 0.5 ? -1 : 1;
        const p = side * Math.sqrt(Math.random());
        const gl = Math.sqrt(0.5 * (1 - p));
        const gr = Math.sqrt(0.5 * (1 + p));
        const a = 0.02 + Math.pow(Math.random(), 3) * 0.12;
        rainImpact(c, j, rnd(0.3, 0.9) * ms, a, gl, gr, 0, rnd(4500, 9000), 0.75);
        if (Math.random() < 0.22) {
          rainRing(c, (j + Math.floor(rnd(1, 4) * ms)) % len, rnd(1500, 4500), rnd(0.002, 0.006), a * 0.5, gl, gr, 0, rnd(0.05, 0.25));
        }
        continue;
      }

      // 近/中景：独立声像 + 双耳时间差（等功率声像）
      const p = Math.random() * 2 - 1;
      const gl = Math.sqrt(0.5 * (1 - p));
      const gr = Math.sqrt(0.5 * (1 + p));

      if (kind === 'leaf' || kind === 'canopy') {
        const near = kind === 'leaf';
        const itd = p * itdMax * (near ? 1 : 0.4);
        const a = near ? 0.05 + Math.pow(Math.random(), 2.4) * 0.55 : 0.03 + Math.pow(Math.random(), 3) * 0.25;
        rainImpact(c, j, rnd(0.3, 1.0) * ms, a * 0.9, gl, gr, itd, near ? rnd(5000, 9000) : rnd(5000, 9000), 0.85);
        if (Math.random() < 0.8) {
          rainRing(c, j, rnd(900, 4200), near ? rnd(0.0015, 0.0045) : rnd(0.001, 0.0028), a * 0.32, gl, gr, itd, 0);
        }
        // 叶片受击下压后弹回：抖落残水的二次小"嗒"（更轻、更脆）
        if (Math.random() < (near ? 0.55 : 0.35)) {
          const jb = (j + Math.floor(rnd(12, 70) * ms)) % len;
          const ab = a * rnd(0.15, 0.4);
          rainImpact(c, jb, rnd(0.2, 0.5) * ms, ab, gl, gr, itd, 9000, 0.9);
          if (Math.random() < 0.5) rainRing(c, jb, rnd(1500, 3800), rnd(0.001, 0.0025), ab * 0.4, gl, gr, itd, 0);
        }
        // 溅散细珠：1–3 粒落在邻近叶面
        if (near && Math.random() < 0.25) {
          const m = 1 + Math.floor(Math.random() * 3);
          for (let q = 0; q < m; q++) {
            const pq = clamp(p + rnd(-0.3, 0.3), -1, 1);
            const jq = (j + Math.floor(rnd(4, 30) * ms)) % len;
            rainImpact(c, jq, rnd(0.15, 0.35) * ms, a * rnd(0.08, 0.18), Math.sqrt(0.5 * (1 - pq)), Math.sqrt(0.5 * (1 + pq)), pq * itdMax, 9000, 0.9);
          }
        }
      } else if (kind === 'ground') {
        const itd = p * itdMax * 0.6;
        const a = 0.05 + Math.pow(Math.random(), 2.2) * 0.4;
        rainImpact(c, j, rnd(1, 4) * ms, a * 1.3, gl, gr, itd, rnd(1000, 2600), 0.3);
        if (Math.random() < 0.5) rainRing(c, j, rnd(120, 380), rnd(0.002, 0.005), a * 0.25, gl, gr, itd, 0);
        if (Math.random() < 0.35) {
          rainImpact(c, (j + Math.floor(rnd(1, 6) * ms)) % len, rnd(0.2, 0.4) * ms, a * 0.15, gl, gr, itd, 8000, 0.8);
        }
        if (Math.random() < 0.08) {
          rainRing(c, (j + Math.floor(rnd(2, 6) * ms)) % len, rnd(1200, 2800), rnd(0.003, 0.007), a * 0.25, gl, gr, itd, rnd(0.1, 0.3));
        }
      } else {
        // water：撞击 + Minnaert 气泡（半径小者居多 → 偏高；半径越大衰减越慢）
        const itd = p * itdMax;
        const a = 0.05 + Math.pow(Math.random(), 2) * 0.45;
        rainImpact(c, j, rnd(0.4, 1.2) * ms, a * 0.7, gl, gr, itd, rnd(3500, 6500), 0.6);
        if (Math.random() < 0.62) {
          const rad = 0.8 + Math.pow(Math.random(), 1.6) * 2.5;
          const jb = (j + Math.floor(rnd(1, 6) * ms)) % len;
          rainRing(c, jb, 3260 / rad, 0.004 + 0.0075 * rad, a * rnd(0.4, 0.9), gl, gr, itd, rnd(0.08, 0.35));
        }
        if (Math.random() < 0.06) {
          rainRing(c, (j + Math.floor(rnd(2, 8) * ms)) % len, rnd(380, 650), rnd(0.012, 0.02), a * 0.35, gl, gr, itd, rnd(0.2, 0.4));
        }
        if (Math.random() < 0.15) {
          const jq = (j + Math.floor(rnd(15, 60) * ms)) % len;
          rainRing(c, jq, rnd(2500, 4200), rnd(0.003, 0.006), a * 0.15, gl, gr, itd, 0.2);
        }
      }
    }
    return buf;
  }

  /**
   * 预渲染火焰噼啪层（立体声窄声像，可无缝循环）：泊松分布的爆裂颗粒——树脂气泡破裂的尖锐"啪"（极短宽带脉冲 + 1.5–5kHz 短模态），
   * 30% 为较大的木纤维爆裂（随后 1–3 个连珠小爆）；另叠一层极细碎的"嘶啦"底纹
   */
  private buildCrackleBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.max(256, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(2, len, sr);
    const noise = this.getNoiseTable();
    const c: RainCanvas = {
      L: buf.getChannelData(0),
      R: buf.getChannelData(1),
      len,
      sr,
      noise,
      mask: noise.length - 1,
    };
    const ms = sr * 0.001;
    const fine = Math.floor(seconds * 220);
    for (let k = 0; k < fine; k++) {
      const p = (Math.random() * 2 - 1) * 0.5;
      rainImpact(c, Math.floor(Math.random() * len), rnd(0.15, 0.6) * ms, rnd(0.008, 0.035), Math.sqrt(0.5 * (1 - p)), Math.sqrt(0.5 * (1 + p)), 0, 9000, 0.9);
    }
    const pops = Math.floor(seconds * 26);
    for (let k = 0; k < pops; k++) {
      const j = Math.floor(Math.random() * len);
      const p = (Math.random() * 2 - 1) * 0.45;
      const gl = Math.sqrt(0.5 * (1 - p));
      const gr = Math.sqrt(0.5 * (1 + p));
      const a = 0.08 + Math.pow(Math.random(), 2.5) * 0.7;
      rainImpact(c, j, rnd(0.2, 0.8) * ms, a, gl, gr, 0, 12000, 0.8);
      rainRing(c, j, rnd(1500, 5000), rnd(0.0006, 0.002), a * 0.4, gl, gr, 0, 0);
      if (Math.random() < 0.3) {
        const m = 1 + Math.floor(Math.random() * 3);
        let jj = j;
        for (let q = 0; q < m; q++) {
          jj = (jj + Math.floor(rnd(3, 25) * ms)) % len;
          rainImpact(c, jj, rnd(0.15, 0.4) * ms, a * rnd(0.25, 0.6), gl, gr, 0, 12000, 0.85);
        }
      }
    }
    return buf;
  }

  /**
   * 预渲染屋顶木瓦敲击层（立体声）：每次击打激励两阶木板模态（f 与 2.3f，递推衰减正弦）+ 3ms 低通噪声击点，
   * 幅度长尾分布让个别雨点"嗒"得更分明；越界按模回绕保证循环无缝
   */
  private buildRoofBuffer(ctx: AudioContext, seconds: number, hitsPerSec: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, len, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const count = Math.floor(seconds * hitsPerSec);
    const tw = (2 * Math.PI) / sr;
    const clickN = Math.floor(sr * 0.003);

    for (let k = 0; k < count; k++) {
      const start = Math.floor(Math.random() * len);
      const pan = (Math.random() * 2 - 1) * 0.75;
      const gl = Math.sqrt((1 - pan) * 0.5);
      const gr = Math.sqrt((1 + pan) * 0.5);
      const a = 0.05 + Math.pow(Math.random(), 2) * 0.42;
      const f = 150 + Math.random() * 340;
      const tau = 0.008 + Math.random() * 0.02;
      const n = Math.floor(sr * tau * 4.5);
      const dec = Math.exp(-1 / (tau * sr));
      const dec2 = Math.exp(-1.6 / (tau * sr));
      // 递推衰减正弦：y[n] = 2r·cos(ω)·y[n-1] − r²·y[n-2]
      const c1 = 2 * Math.cos(f * tw) * dec;
      const d1 = dec * dec;
      const f2 = f * 2.3;
      const c2 = 2 * Math.cos(f2 * tw) * dec2;
      const d2 = dec2 * dec2;
      let y1 = 0;
      let y2 = (-a * Math.sin(f * tw)) / dec;
      let z1 = 0;
      let z2 = (-a * 0.4 * Math.sin(f2 * tw)) / dec2;
      let lp = 0;
      let j = start;
      for (let i = 0; i < n; i++) {
        const y = c1 * y1 - d1 * y2;
        y2 = y1;
        y1 = y;
        const z = c2 * z1 - d2 * z2;
        z2 = z1;
        z1 = z;
        let s = y + z;
        if (i < clickN) {
          lp += 0.35 * (Math.random() * 2 - 1 - lp);
          s += lp * a * 1.1 * (1 - i / clickN);
        }
        L[j] += s * gl;
        R[j] += s * gr;
        j++;
        if (j >= len) j = 0;
      }
    }
    return buf;
  }

  /**
   * 预渲染蓄力握柄吱嘎（单声道，可无缝循环）：皮革/木柄受力的粘滑摩擦——脉冲速率与力度各自随机游走，
   * 每个脉冲激励 ~0.9–1.4kHz 与其 2.41 倍两阶短衰减模态；写入按模回绕
   */
  private buildGripBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const tw = (2 * Math.PI) / sr;
    let t = 0;
    let rate = 60;
    let swell = 0.5;
    while (t < len) {
      rate *= 1 + (Math.random() - 0.5) * 0.3;
      rate = Math.min(140, Math.max(22, rate));
      swell += (Math.random() - 0.5) * 0.25;
      swell = Math.min(1, Math.max(0.08, swell));
      const a = swell * (0.4 + Math.random() * 0.6) * 0.5;
      const m1 = 900 + Math.random() * 500;
      const m2 = m1 * 2.41;
      const tau = 0.0015 + Math.random() * 0.002;
      const n = Math.floor(tau * sr * 4.5);
      const dec = Math.exp(-1 / (tau * sr));
      const ca = 2 * Math.cos(m1 * tw) * dec;
      const cb = 2 * Math.cos(m2 * tw) * dec;
      const dd = dec * dec;
      let a1 = 0;
      let a2 = (-a * Math.sin(m1 * tw)) / dec;
      let b1 = 0;
      let b2 = (-a * 0.5 * Math.sin(m2 * tw)) / dec;
      let j = t;
      for (let i = 0; i < n; i++) {
        const ya = ca * a1 - dd * a2;
        a2 = a1;
        a1 = ya;
        const yb = cb * b1 - dd * b2;
        b2 = b1;
        b1 = yb;
        d[j] += ya + yb;
        j++;
        if (j >= len) j = 0;
      }
      t += Math.max(1, Math.floor(sr / rate));
    }
    return buf;
  }

  /**
   * 预渲染木头吱嘎声（单声道）：粘滑摩擦（stick-slip）不规则脉冲串激励两阶木体共振模态
   * 运行时以不同 playbackRate 复用：快放 = 地板吱嘎，慢放 = 树干呻吟
   */
  private buildCreakBuffer(ctx: AudioContext, seconds: number, baseRate: number, modeHz: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const tw = (2 * Math.PI) / sr;
    let t = Math.floor(sr * 0.02);
    let rate = baseRate;
    const swell = 0.35 + Math.random() * 0.4;

    while (t < len) {
      // 摩擦脉冲速率随机游走（吱嘎的不规则"咯—吱"感）
      rate *= 1 + (Math.random() - 0.5) * 0.22;
      rate = Math.min(baseRate * 2.2, Math.max(baseRate * 0.45, rate));
      const pos = t / len;
      const env =
        Math.pow(Math.sin(Math.PI * pos), 0.8) * (0.75 + 0.25 * Math.sin((pos * Math.PI * 2) / swell));
      const a = env * (0.5 + Math.random() * 0.5);
      const m1 = modeHz * (0.97 + Math.random() * 0.06);
      const m2 = m1 * 2.37;
      const tau = 0.003 + Math.random() * 0.004;
      const n = Math.floor(tau * sr * 4.5);
      const dec = Math.exp(-1 / (tau * sr));
      const ca = 2 * Math.cos(m1 * tw) * dec;
      const cb = 2 * Math.cos(m2 * tw) * dec;
      const dd = dec * dec;
      let a1 = 0;
      let a2 = (-a * Math.sin(m1 * tw)) / dec;
      let b1 = 0;
      let b2 = (-a * 0.45 * Math.sin(m2 * tw)) / dec;
      for (let i = 0; i < n && t + i < len; i++) {
        const ya = ca * a1 - dd * a2;
        a2 = a1;
        a1 = ya;
        const yb = cb * b1 - dd * b2;
        b2 = b1;
        b1 = yb;
        d[t + i] += ya + yb;
      }
      t += Math.max(1, Math.floor(sr / rate));
    }
    return buf;
  }

  // ═══════════════════════════ 总线与连续音床 ═══════════════════════════

  /**
   * 建立混响与分组总线：
   *   forestIn → 森林卷积 → 穿墙低通 → forestOut → master
   *   hutIn    → 木屋卷积 → 穿墙低通 → hutOut    → master
   *   roomSend → (roomToForest | roomToHut) 按室内外交叉淡化
   *   nearBus  → master，并经 nearSend 送入 roomSend
   *   outdoorBus → 室内压暗低通 → outdoorTrim → master，并少量送入森林混响
   */
  private setupMixBuses(ctx: AudioContext, master: GainNode) {
    const now = ctx.currentTime;

    // 森林：~2.8s，暗、扩散，早期反射稀疏（树干零散反射）
    const forestIn = ctx.createGain();
    forestIn.gain.setValueAtTime(1, now);
    const forestConv = ctx.createConvolver();
    forestConv.buffer = this.buildImpulseResponse(ctx, {
      seconds: 3.0,
      t60: 2.8,
      preDelay: 0.022,
      earlyCount: 9,
      earlySpan: 0.09,
      earlyGain: 0.35,
      lpStart: 5200,
      lpEnd: 520,
      hpHz: 90,
      rise: 0.06,
      combMs: 0,
      combFb: 0,
    });
    const forestWallLP = ctx.createBiquadFilter();
    forestWallLP.type = 'lowpass';
    forestWallLP.frequency.setValueAtTime(9000, now);
    forestWallLP.Q.setValueAtTime(0.5, now);
    const forestOut = ctx.createGain();
    forestOut.gain.setValueAtTime(0.62, now);
    forestIn.connect(forestConv);
    forestConv.connect(forestWallLP);
    forestWallLP.connect(forestOut);
    forestOut.connect(master);

    // 木屋：~0.6s，密集早期反射 + 4.3ms 梳状箱体共鸣，高通去低频、低通去齿音 → 木质中频
    const hutIn = ctx.createGain();
    hutIn.gain.setValueAtTime(1, now);
    const hutConv = ctx.createConvolver();
    hutConv.buffer = this.buildImpulseResponse(ctx, {
      seconds: 0.75,
      t60: 0.62,
      preDelay: 0.003,
      earlyCount: 26,
      earlySpan: 0.035,
      earlyGain: 0.9,
      lpStart: 4200,
      lpEnd: 1100,
      hpHz: 160,
      rise: 0.004,
      combMs: 4.3,
      combFb: 0.28,
    });
    const hutWallLP = ctx.createBiquadFilter();
    hutWallLP.type = 'lowpass';
    hutWallLP.frequency.setValueAtTime(900, now);
    hutWallLP.Q.setValueAtTime(0.5, now);
    const hutOut = ctx.createGain();
    hutOut.gain.setValueAtTime(0.5, now);
    hutIn.connect(hutConv);
    hutConv.connect(hutWallLP);
    hutWallLP.connect(hutOut);
    hutOut.connect(master);

    // 所在空间发送（初始按室外）
    const roomSend = ctx.createGain();
    roomSend.gain.setValueAtTime(1, now);
    const roomToForest = ctx.createGain();
    roomToForest.gain.setValueAtTime(1, now);
    const roomToHut = ctx.createGain();
    roomToHut.gain.setValueAtTime(0, now);
    roomSend.connect(roomToForest);
    roomToForest.connect(forestIn);
    roomSend.connect(roomToHut);
    roomToHut.connect(hutIn);

    // 近身总线
    const nearBus = ctx.createGain();
    nearBus.gain.setValueAtTime(1, now);
    const nearSend = ctx.createGain();
    nearSend.gain.setValueAtTime(0.08, now);
    nearBus.connect(master);
    nearBus.connect(nearSend);
    nearSend.connect(roomSend);

    // 室外氛围总线
    const outdoorBus = ctx.createGain();
    outdoorBus.gain.setValueAtTime(1, now);
    const outdoorLP = ctx.createBiquadFilter();
    outdoorLP.type = 'lowpass';
    outdoorLP.frequency.setValueAtTime(12000, now);
    outdoorLP.Q.setValueAtTime(0.5, now);
    const outdoorTrim = ctx.createGain();
    outdoorTrim.gain.setValueAtTime(1, now);
    const outdoorSend = ctx.createGain();
    outdoorSend.gain.setValueAtTime(0.1, now);
    outdoorBus.connect(outdoorLP);
    outdoorLP.connect(outdoorTrim);
    outdoorTrim.connect(master);
    outdoorBus.connect(outdoorSend);
    outdoorSend.connect(forestIn);

    this.forestIn = forestIn;
    this.forestOut = forestOut;
    this.forestWallLP = forestWallLP;
    this.hutIn = hutIn;
    this.hutOut = hutOut;
    this.hutWallLP = hutWallLP;
    this.roomSend = roomSend;
    this.roomToForest = roomToForest;
    this.roomToHut = roomToHut;
    this.nearBus = nearBus;
    this.nearSend = nearSend;
    this.outdoorBus = outdoorBus;
    this.outdoorLP = outdoorLP;
    this.outdoorTrim = outdoorTrim;
  }

  /** 创建一条常驻循环缓冲声源（初始化时调用一次） */
  private startLoop(ctx: AudioContext, buf: AudioBuffer, rate: number): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.setValueAtTime(rate, ctx.currentTime);
    src.start(ctx.currentTime, Math.random() * buf.duration * 0.95);
    return src;
  }

  /** 创建常驻立体声像节点（不支持时返回直通增益） */
  private staticPanner(ctx: AudioContext, pan: number): AudioNode {
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(pan, ctx.currentTime);
      return p;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, ctx.currentTime);
    return g;
  }

  private setupContinuousBeds(ctx: AudioContext, master: GainNode) {
    const now = ctx.currentTime;
    const outBus: AudioNode = this.outdoorBus ?? master;

    // 0. 室外雨总线：全部室外雨层汇入，增益随阵风起伏、声像随左右阵风差扫动
    const rainBus = ctx.createGain();
    rainBus.gain.setValueAtTime(1, now);
    // 雨总线音色：二阶低通 → 长时平均谱 10kHz 以上迅速衰减（与室外总线 12kHz 低通串联约 -24dB/oct）
    const rainTone = ctx.createBiquadFilter();
    rainTone.type = 'lowpass';
    rainTone.frequency.setValueAtTime(9500, now);
    rainTone.Q.setValueAtTime(0, now);
    rainBus.connect(rainTone);
    if (typeof ctx.createStereoPanner === 'function') {
      const rp = ctx.createStereoPanner();
      rp.pan.setValueAtTime(0, now);
      rainTone.connect(rp);
      rp.connect(outBus);
      this.rainPan = rp;
    } else {
      rainTone.connect(outBus);
    }
    this.rainBus = rainBus;

    if (this.pinkBuf) {
      // 1. 森林寒风低频底噪
      const windSrc = this.startLoop(ctx, this.pinkBuf, 1);
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.setValueAtTime(320, now);
      windFilter.Q.setValueAtTime(1.0, now);
      const windGain = ctx.createGain();
      windGain.gain.setValueAtTime(0.06, now);
      windSrc.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(outBus);
      this.windFilter = windFilter;
      this.windGain = windGain;

      // 2. 左右两路阵风：带通中心与增益由随机游走独立驱动，阵风在左右间游移
      const mkGust = (pan: number, rate: number): { g: GainNode; bp: BiquadFilterNode } | null => {
        if (!this.pinkBuf) return null;
        const src = this.startLoop(ctx, this.pinkBuf, rate);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(420, now);
        bp.Q.setValueAtTime(0.9, now);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, now);
        const p = this.staticPanner(ctx, pan);
        src.connect(bp);
        bp.connect(g);
        g.connect(p);
        p.connect(outBus);
        return { g, bp };
      };
      const ga = mkGust(-0.6, 0.93);
      const gb = mkGust(0.6, 1.07);
      if (ga) {
        this.gustGainA = ga.g;
        this.gustBPA = ga.bp;
      }
      if (gb) {
        this.gustGainB = gb.g;
        this.gustBPB = gb.bp;
      }

      // 3. 远场雨幕：高密度粒子云（左右独立粒子 → 宽阔去相关），经距离空气吸收低通；取代第二轮的带通粉噪嘶声
      const rainFilter = ctx.createBiquadFilter();
      rainFilter.type = 'lowpass';
      rainFilter.frequency.setValueAtTime(6000, now);
      rainFilter.Q.setValueAtTime(0, now);
      rainFilter.connect(rainBus);
      const far = this.makeShuffleLayer(ctx, this.rainPools[4], rainFilter, 1, 1.4, 3.2);
      if (far) {
        this.farRain = far;
        this.rainGain = far.out;
      }
      this.rainFilter = rainFilter;

      // 3b. 重雨地面低频轰鸣（雨势约 2.2 次方增长，连续无开关）
      const roarSrc = this.startLoop(ctx, this.pinkBuf, 0.83);
      const roarLP = ctx.createBiquadFilter();
      roarLP.type = 'lowpass';
      roarLP.frequency.setValueAtTime(520, now);
      roarLP.Q.setValueAtTime(0.5, now);
      const roarGain = ctx.createGain();
      roarGain.gain.setValueAtTime(0, now);
      roarSrc.connect(roarLP);
      roarLP.connect(roarGain);
      roarGain.connect(rainBus);
      this.rainRoarLP = roarLP;
      this.rainRoarGain = roarGain;
    }

    // 4. 强阵风穿过针叶的细哨声
    if (this.whiteBuf) {
      const wSrc = this.startLoop(ctx, this.whiteBuf, 1);
      const whistleBP = ctx.createBiquadFilter();
      whistleBP.type = 'bandpass';
      whistleBP.frequency.setValueAtTime(2300, now);
      whistleBP.Q.setValueAtTime(7, now);
      const whistleGain = ctx.createGain();
      whistleGain.gain.setValueAtTime(0, now);
      const p = this.staticPanner(ctx, 0.25);
      wSrc.connect(whistleBP);
      whistleBP.connect(whistleGain);
      whistleGain.connect(p);
      p.connect(outBus);
      this.whistleBP = whistleBP;
      this.whistleGain = whistleGain;
    }

    // 5. 表面雨层（第三轮：物理粒子缓冲 + 随机重排）：近处稀疏树叶 / 中景密集树冠 → 树叶低通；泥土草地 → 地面低通；积水 → 积水低通
    //    每层两条常驻交叉淡化槽，段长/起点/速率随机；增益与速率随雨势连续变化（无逐层开关）
    if (this.rainPools.length >= 4) {
      const leafLP = ctx.createBiquadFilter();
      leafLP.type = 'lowpass';
      leafLP.frequency.setValueAtTime(8000, now);
      leafLP.Q.setValueAtTime(0, now);
      leafLP.connect(rainBus);
      const mudLP = ctx.createBiquadFilter();
      mudLP.type = 'lowpass';
      mudLP.frequency.setValueAtTime(2400, now);
      mudLP.Q.setValueAtTime(0, now);
      mudLP.connect(rainBus);
      const puddleLP = ctx.createBiquadFilter();
      puddleLP.type = 'lowpass';
      puddleLP.frequency.setValueAtTime(7000, now);
      puddleLP.Q.setValueAtTime(0, now);
      puddleLP.connect(rainBus);
      const dests: AudioNode[] = [leafLP, leafLP, mudLP, puddleLP];
      const rates = [0.973, 1.029, 0.991, 1.013];
      const segs: Array<[number, number]> = [
        [1.1, 2.4],
        [1.4, 3.0],
        [1.3, 2.8],
        [1.0, 2.2],
      ];
      this.rainLayers = [];
      for (let i = 0; i < 4; i++) {
        const ly = this.makeShuffleLayer(ctx, this.rainPools[i], dests[i], rates[i], segs[i][0], segs[i][1]);
        if (ly) this.rainLayers.push(ly);
      }
      this.leafLP = leafLP;
      this.mudLP = mudLP;
    }

    // 5b. 屋檐水流（连续细流 + 断续滴落檐下水洼）：固定在庇护所一侧，随湿润记忆与离屋距离渐变；进屋经室外总线隔墙闷化
    if (this.rainPools.length >= 6) {
      const eaveLP = ctx.createBiquadFilter();
      eaveLP.type = 'lowpass';
      eaveLP.frequency.setValueAtTime(4200, now);
      eaveLP.Q.setValueAtTime(0, now);
      const ep = this.staticPanner(ctx, Math.random() < 0.5 ? -0.5 : 0.5);
      eaveLP.connect(ep);
      ep.connect(outBus);
      this.eaveLayer = this.makeShuffleLayer(ctx, this.rainPools[5], eaveLP, 1, 1.5, 3.0);
    }

    // 6. 室内屋顶：稀疏/密集两层木瓦敲击（随机重排）→ 低通 → 木板共鸣峰 → 箱体低频共鸣 → 直出并送木屋混响（不经室外总线）
    if (this.roofBufs.length >= 2) {
      const roofLP = ctx.createBiquadFilter();
      roofLP.type = 'lowpass';
      roofLP.frequency.setValueAtTime(2600, now);
      roofLP.Q.setValueAtTime(0.6, now);
      const roofPeak = ctx.createBiquadFilter();
      roofPeak.type = 'peaking';
      roofPeak.frequency.setValueAtTime(260, now);
      roofPeak.Q.setValueAtTime(1.1, now);
      roofPeak.gain.setValueAtTime(5, now);
      const roofBody = ctx.createBiquadFilter();
      roofBody.type = 'peaking';
      roofBody.frequency.setValueAtTime(118, now);
      roofBody.Q.setValueAtTime(1.4, now);
      roofBody.gain.setValueAtTime(3, now);
      const roofOut = ctx.createGain();
      roofOut.gain.setValueAtTime(1, now);
      roofLP.connect(roofPeak);
      roofPeak.connect(roofBody);
      roofBody.connect(roofOut);
      roofOut.connect(master);
      if (this.hutIn) {
        const roofSend = ctx.createGain();
        roofSend.gain.setValueAtTime(0.38, now);
        roofOut.connect(roofSend);
        roofSend.connect(this.hutIn);
      }
      const rRates = [0.982, 1.021];
      this.roofLayers = [];
      for (let i = 0; i < 2; i++) {
        const ly = this.makeShuffleLayer(ctx, [this.roofBufs[i]], roofLP, rRates[i], 1.2, 2.6);
        if (ly) this.roofLayers.push(ly);
      }
      this.roofBody = roofBody;
      this.roofIn = roofLP;
    }

    // 7. 庇护所苏式柴油发电机低鸣（含可调低通滤波，供低油量咳喘调制）
    const genOsc = ctx.createOscillator();
    genOsc.type = 'sawtooth';
    genOsc.frequency.setValueAtTime(54, now);

    const genOsc2 = ctx.createOscillator();
    genOsc2.type = 'triangle';
    genOsc2.frequency.setValueAtTime(108, now);

    const genFilter = ctx.createBiquadFilter();
    genFilter.type = 'lowpass';
    genFilter.frequency.setValueAtTime(165, now);
    genFilter.Q.setValueAtTime(1.1, now);

    const genGain = ctx.createGain();
    genGain.gain.setValueAtTime(0, now);

    genOsc.connect(genFilter);
    genOsc2.connect(genFilter);
    genFilter.connect(genGain);
    genGain.connect(master);
    genOsc.start();
    genOsc2.start();

    this.genOsc = genOsc;
    this.genOsc2 = genOsc2;
    this.genFilter = genFilter;
    this.genGain = genGain;

    // 8. 黑夜低频恐惧次声底噪
    const dreadOsc = ctx.createOscillator();
    dreadOsc.type = 'sine';
    dreadOsc.frequency.setValueAtTime(41.2, now);

    const dreadGain = ctx.createGain();
    dreadGain.gain.setValueAtTime(0, now);

    dreadOsc.connect(dreadGain);
    dreadGain.connect(master);
    dreadOsc.start();

    this.dreadOsc = dreadOsc;
    this.dreadGain = dreadGain;
  }

  /**
   * 环境生命层常驻音床：
   *   风过树梢沙沙：两路白噪（不同速率去相关）→ 左右声像 → 高通 + 带通 ~4kHz，增益分别跟随左右阵风并加随机抖动（叶片颤动）
   *   蟋蟀：两只，正弦载波 ×（~25–31Hz 发音脉冲）×（~2–3Hz 鸣叫门），黄昏起以长时间常数渐入
   */
  private setupLifeBeds(ctx: AudioContext) {
    const now = ctx.currentTime;
    const outBus: AudioNode = this.outdoorBus ?? this.masterGain ?? ctx.destination;

    if (this.whiteBuf) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(1800, now);
      hp.Q.setValueAtTime(0.5, now);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(4200, now);
      bp.Q.setValueAtTime(0.7, now);
      hp.connect(bp);
      bp.connect(outBus);
      const mk = (pan: number, rate: number): GainNode | null => {
        if (!this.whiteBuf) return null;
        const src = this.startLoop(ctx, this.whiteBuf, rate);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, now);
        const p = this.staticPanner(ctx, pan);
        src.connect(g);
        g.connect(p);
        p.connect(hp);
        return g;
      };
      this.canopyGainL = mk(-0.7, 0.937);
      this.canopyGainR = mk(0.7, 1.061);
      this.canopyBP = bp;
    }

    const mkCricket = (pan: number, carrier: number, pulseHz: number, chirpHz: number): GainNode => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(carrier, now);
      const pulse = ctx.createGain();
      pulse.gain.setValueAtTime(0.5, now);
      const pl = ctx.createOscillator();
      pl.type = 'triangle';
      pl.frequency.setValueAtTime(pulseHz, now);
      const plD = ctx.createGain();
      plD.gain.setValueAtTime(0.5, now);
      pl.connect(plD);
      plD.connect(pulse.gain);
      const gate = ctx.createGain();
      gate.gain.setValueAtTime(0.5, now);
      const gl = ctx.createOscillator();
      gl.type = 'sine';
      gl.frequency.setValueAtTime(chirpHz, now);
      const glD = ctx.createGain();
      glD.gain.setValueAtTime(0.5, now);
      gl.connect(glD);
      glD.connect(gate.gain);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      const p = this.staticPanner(ctx, pan);
      osc.connect(pulse);
      pulse.connect(gate);
      gate.connect(g);
      g.connect(p);
      p.connect(outBus);
      osc.start(now);
      pl.start(now);
      gl.start(now);
      return g;
    };
    this.cricketGains = [
      mkCricket(-0.55, rnd(4300, 4700), rnd(25, 29), rnd(2.1, 2.6)),
      mkCricket(0.62, rnd(4600, 5000), rnd(27, 31), rnd(2.7, 3.2)),
    ];
  }

  /**
   * 身体反馈常驻链（全部初始为 0 增益，只做参数自动化）：
   *   耳鸣：两条略失谐的高频正弦（缓慢拍频）→ 身体总线
   *   呼吸：白噪 → 高通 → 主共振带通（吸气高/呼气低）+ 口腔固定带通 → breathG → 身体总线
   *   嗓音：极度疲惫时呼气带出的"呃"（锯齿 → 低通 → 共振带通）
   *   憋气鼻息：窄带通噪声（鼻腔嘶）+ 喉部低哼 → strainG，另有 ~7.5Hz 震颤叠加到增益
   *   握柄吱嘎：粘滑摩擦循环 → 带通 → 近身总线（带所在空间少量混响）
   */
  private setupBodyBeds(ctx: AudioContext) {
    const now = ctx.currentTime;
    const body: AudioNode = this.bodyBus ?? this.masterGain ?? ctx.destination;
    const near: AudioNode = this.nearBus ?? this.masterGain ?? ctx.destination;

    const tin = ctx.createGain();
    tin.gain.setValueAtTime(0, now);
    const t1 = ctx.createOscillator();
    t1.type = 'sine';
    t1.frequency.setValueAtTime(6150, now);
    const t2 = ctx.createOscillator();
    t2.type = 'sine';
    t2.frequency.setValueAtTime(6187, now);
    const t2g = ctx.createGain();
    t2g.gain.setValueAtTime(0.6, now);
    t1.connect(tin);
    t2.connect(t2g);
    t2g.connect(tin);
    tin.connect(body);
    t1.start(now);
    t2.start(now);
    this.tinnitusGain = tin;

    if (this.whiteBuf) {
      const src = this.startLoop(ctx, this.whiteBuf, 0.96);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(260, now);
      hp.Q.setValueAtTime(0.5, now);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1200, now);
      bp.Q.setValueAtTime(1.1, now);
      const mouth = ctx.createBiquadFilter();
      mouth.type = 'bandpass';
      mouth.frequency.setValueAtTime(2900, now);
      mouth.Q.setValueAtTime(2, now);
      const mouthG = ctx.createGain();
      mouthG.gain.setValueAtTime(0.45, now);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      src.connect(hp);
      hp.connect(bp);
      bp.connect(g);
      hp.connect(mouth);
      mouth.connect(mouthG);
      mouthG.connect(g);
      g.connect(body);
      this.breathG = g;
      this.breathBP = bp;

      const vo = ctx.createOscillator();
      vo.type = 'sawtooth';
      vo.frequency.setValueAtTime(128, now);
      const voLP = ctx.createBiquadFilter();
      voLP.type = 'lowpass';
      voLP.frequency.setValueAtTime(900, now);
      voLP.Q.setValueAtTime(0.7, now);
      const voBP = ctx.createBiquadFilter();
      voBP.type = 'bandpass';
      voBP.frequency.setValueAtTime(650, now);
      voBP.Q.setValueAtTime(1.2, now);
      const vg = ctx.createGain();
      vg.gain.setValueAtTime(0, now);
      vo.connect(voLP);
      voLP.connect(voBP);
      voBP.connect(vg);
      vg.connect(body);
      vo.start(now);
      this.voiceOsc = vo;
      this.voiceG = vg;

      const s2 = this.startLoop(ctx, this.whiteBuf, 1.07);
      const sbp = ctx.createBiquadFilter();
      sbp.type = 'bandpass';
      sbp.frequency.setValueAtTime(2100, now);
      sbp.Q.setValueAtTime(3.5, now);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0, now);
      s2.connect(sbp);
      sbp.connect(sg);
      sg.connect(body);
      const hum = ctx.createOscillator();
      hum.type = 'sawtooth';
      hum.frequency.setValueAtTime(100, now);
      const humLP = ctx.createBiquadFilter();
      humLP.type = 'lowpass';
      humLP.frequency.setValueAtTime(420, now);
      humLP.Q.setValueAtTime(0.8, now);
      const humG = ctx.createGain();
      humG.gain.setValueAtTime(0, now);
      hum.connect(humLP);
      humLP.connect(humG);
      humG.connect(sg);
      hum.start(now);
      const trem = ctx.createOscillator();
      trem.type = 'sine';
      trem.frequency.setValueAtTime(7.5, now);
      const td = ctx.createGain();
      td.gain.setValueAtTime(0, now);
      trem.connect(td);
      td.connect(sg.gain);
      trem.start(now);
      this.strainG = sg;
      this.strainBP = sbp;
      this.strainHumG = humG;
      this.strainOsc = hum;
      this.tremDepth = td;
    }

    if (this.gripBuf) {
      const src = this.startLoop(ctx, this.gripBuf, 0.75);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1100, now);
      bp.Q.setValueAtTime(1.8, now);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      src.connect(bp);
      bp.connect(g);
      g.connect(near);
      this.gripSrc = src;
      this.gripBP = bp;
      this.gripG = g;
    }
  }

  /**
   * 第三轮常驻链（全部初始 0 增益，每步只做参数自动化）：
   *   手持火把：噼啪颗粒循环 → 高通 / 棕噪低通"呼呼"火焰气流 / 粉噪带通挥动呼啸 + 窄带哨音 / 高通白噪雨中水汽嘶嘶 → torchBus → 近身总线
   *   地面火把：独立噼啪与气流 + 嘶嘶 → 电平 → 空气吸收/隔墙低通 → 声像 → 干声 → 主增益，另经两路常驻发送进森林/木屋混响
   *   闹鬼：两条相差约半音的三角波低频嗡声（拍频不安）→ 低通 → 主增益；走调与耳鸣并入现有 dread / 耳鸣链
   */
  private setupToolBeds(ctx: AudioContext) {
    const now = ctx.currentTime;
    const master: AudioNode = this.masterGain ?? ctx.destination;
    const near: AudioNode = this.nearBus ?? master;
    const mkGain = (v: number): GainNode => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(v, now);
      return g;
    };
    const mkFilt = (type: BiquadFilterType, f: number, q: number): BiquadFilterNode => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.setValueAtTime(f, now);
      b.Q.setValueAtTime(q, now);
      return b;
    };

    // —— 手持火把 ——
    const tb = mkGain(1);
    tb.connect(near);
    this.torchBus = tb;
    if (this.crackleBuf) {
      const src = this.startLoop(ctx, this.crackleBuf, 1);
      const hp = mkFilt('highpass', 600, 0);
      const g = mkGain(0);
      src.connect(hp);
      hp.connect(g);
      g.connect(tb);
      this.torchCrackSrc = src;
      this.torchCrackG = g;
    }
    if (this.brownBuf) {
      const src = this.startLoop(ctx, this.brownBuf, 1.04);
      const lp = mkFilt('lowpass', 300, 0.7);
      const g = mkGain(0);
      src.connect(lp);
      lp.connect(g);
      g.connect(tb);
      this.torchRoarLP = lp;
      this.torchRoarG = g;
    }
    if (this.pinkBuf) {
      const src = this.startLoop(ctx, this.pinkBuf, 1.13);
      const bp = mkFilt('bandpass', 500, 1.1);
      const g = mkGain(0);
      src.connect(bp);
      bp.connect(g);
      g.connect(tb);
      const wbp = mkFilt('bandpass', 1200, 6);
      const wg = mkGain(0);
      src.connect(wbp);
      wbp.connect(wg);
      wg.connect(tb);
      this.torchWhooshBP = bp;
      this.torchWhooshG = g;
      this.torchWhistleBP = wbp;
      this.torchWhistleG = wg;
    }
    if (this.whiteBuf) {
      const src = this.startLoop(ctx, this.whiteBuf, 0.89);
      const hp = mkFilt('highpass', 3800, 0);
      const g = mkGain(0);
      src.connect(hp);
      hp.connect(g);
      g.connect(tb);
      this.torchSizzleG = g;
    }

    // —— 地面火把（空间化常驻链） ——
    const gIn = mkGain(0);
    const gLP = mkFilt('lowpass', 9000, 0);
    gIn.connect(gLP);
    const gDry = mkGain(1);
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(0, now);
      gLP.connect(p);
      p.connect(gDry);
      this.gtPan = p;
    } else {
      gLP.connect(gDry);
    }
    gDry.connect(master);
    if (this.forestIn) {
      const s = mkGain(0);
      gLP.connect(s);
      s.connect(this.forestIn);
      this.gtSendF = s;
    }
    if (this.hutIn) {
      const s = mkGain(0);
      gLP.connect(s);
      s.connect(this.hutIn);
      this.gtSendH = s;
    }
    this.gtIn = gIn;
    this.gtLP = gLP;
    this.gtDry = gDry;
    if (this.crackleBuf) {
      const src = this.startLoop(ctx, this.crackleBuf, 0.93);
      const hp = mkFilt('highpass', 500, 0);
      const g = mkGain(0);
      src.connect(hp);
      hp.connect(g);
      g.connect(gIn);
      this.gtCrackG = g;
    }
    if (this.brownBuf) {
      const src = this.startLoop(ctx, this.brownBuf, 0.9);
      const lp = mkFilt('lowpass', 260, 0.7);
      const g = mkGain(0);
      src.connect(lp);
      lp.connect(g);
      g.connect(gIn);
      this.gtRoarG = g;
    }
    if (this.whiteBuf) {
      const src = this.startLoop(ctx, this.whiteBuf, 1.07);
      const hp = mkFilt('highpass', 3500, 0);
      const g = mkGain(0);
      src.connect(hp);
      hp.connect(g);
      g.connect(gIn);
      this.gtSizzleG = g;
    }

    // —— 闹鬼低频不安嗡声 ——
    const hLP = mkFilt('lowpass', 360, 0.7);
    const hG = mkGain(0);
    hLP.connect(hG);
    hG.connect(master);
    const o1 = ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.setValueAtTime(61.7, now);
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.setValueAtTime(65.4, now);
    const o2g = mkGain(0.8);
    o1.connect(hLP);
    o2.connect(o2g);
    o2g.connect(hLP);
    o1.start(now);
    o2.start(now);
    this.hauntHumG = hG;
    this.hauntOscA = o1;
    this.hauntOscB = o2;
  }

  /**
   * 纯标量空间参数（不建节点，供每步调用的常驻空间链使用）：与 createSpatialRoute 同一套方位/距离/空气吸收/隔墙公式
   */
  private spatialParams(spatial?: SpatialAudioOpts): {
    pan: number;
    gainScale: number;
    dist01: number;
    lpHz: number;
    sourceIndoor: boolean;
  } {
    if (!spatial) return { pan: 0, gainScale: 1, dist01: 0, lpHz: 9500, sourceIndoor: this.listenerIndoor };
    const fx = (v: number): number => (Number.isFinite(v) ? v : 0);
    const dx = fx(spatial.worldX) - fx(spatial.listenerX);
    const dy = fx(spatial.worldY) - fx(spatial.listenerY);
    const distance = Math.hypot(dx, dy);
    const maxDist = Number.isFinite(spatial.maxDist) ? Math.max(1, spatial.maxDist ?? 680) : 680;
    const dist01 = clamp(distance / maxDist, 0, 1);
    const distLinear = clamp(1 - dist01, 0.08, 1);
    const muffled = Boolean(spatial.muffled);
    const gainScale = distLinear * (0.35 + 0.65 * distLinear) * (muffled ? 0.78 : 1);
    const pan = clamp((dx / Math.max(distance, 36)) * 0.9, -0.9, 0.9);
    let lpHz = 9500 * Math.pow(0.11, dist01);
    if (muffled) lpHz = Math.min(lpHz, 650);
    const sourceIndoor = muffled ? !this.listenerIndoor : this.listenerIndoor;
    return { pan, gainScale, dist01, lpHz, sourceIndoor };
  }

  /**
   * 手持火把持续燃烧（每步调用、不分配节点；内置 ~20Hz 节流，level 归零时立即推送淡出）：
   * 噼啪颗粒 + 低频呼呼气流随随机闪烁起伏；motion01 越大气流越响越亮、并带呼啸哨音；
   * 室外下雨时附加嘶嘶水汽（读 updateAmbience 记录的雨势），level = 0 以 ~0.25s 时间常数平滑淡出
   */
  setTorchBurn(level01: number, motion01: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.initialized || this.muted || this.pageHidden) return;
    const lv = Number.isFinite(level01) ? clamp(level01, 0, 1) : 0;
    const mo = Number.isFinite(motion01) ? clamp(motion01, 0, 1) : 0;
    const tms = nowMs();
    const dt = clamp((tms - this.torchLastMs) / 1000, 0, 0.1);
    this.torchLastMs = tms;
    // 运动量快升慢降（挥动停下后呼啸渐收）
    this.torchMotionSm += (mo - this.torchMotionSm) * (1 - Math.exp(-dt / (mo > this.torchMotionSm ? 0.05 : 0.22)));
    if (lv === 0 && this.torchSent === 0) return;
    const fadeOut = lv === 0 && this.torchSent > 0;
    if (!fadeOut && tms - this.torchSentMs < 50) return;
    this.torchSent = lv;
    this.torchSentMs = tms;
    const now = ctx.currentTime;
    this.torchFlick = clamp(this.ouStep(this.torchFlick, 0, 2.5, 1.1, 0.05), -1, 1);
    const fl = 0.5 + 0.5 * this.torchFlick;
    const m = clamp(this.torchMotionSm, 0, 1);
    const rainK = this.listenerIndoor ? 0 : clamp(this.rainNow, 0, 1);
    const tau = lv === 0 ? 0.25 : 0.08;
    if (this.torchCrackG) this.torchCrackG.gain.setTargetAtTime(lv * 0.28 * (0.7 + 0.3 * fl) * (1 - 0.3 * rainK), now, tau);
    if (this.torchCrackSrc) this.torchCrackSrc.playbackRate.setTargetAtTime(0.88 + 0.22 * fl + m * 0.18, now, 0.2);
    if (this.torchRoarG) this.torchRoarG.gain.setTargetAtTime(lv * (0.05 + m * 0.11) * (0.82 + 0.18 * fl), now, tau);
    if (this.torchRoarLP) this.torchRoarLP.frequency.setTargetAtTime(230 + m * 450 + fl * 60, now, 0.1);
    if (this.torchWhooshG) this.torchWhooshG.gain.setTargetAtTime(lv * Math.pow(m, 1.4) * 0.16, now, tau);
    if (this.torchWhooshBP) this.torchWhooshBP.frequency.setTargetAtTime(380 + m * 900, now, 0.1);
    if (this.torchWhistleG) this.torchWhistleG.gain.setTargetAtTime(lv * smooth01((m - 0.45) / 0.55) * 0.035, now, tau);
    if (this.torchWhistleBP) this.torchWhistleBP.frequency.setTargetAtTime(900 + m * 1100 + fl * 120, now, 0.12);
    if (this.torchSizzleG) {
      this.torchSizzleG.gain.setTargetAtTime(lv * rainK * 0.03 * rnd(0.35, 1.15), now, lv === 0 ? 0.25 : 0.05);
    }
  }

  /**
   * 地上火把持续燃烧（每步调用、不分配节点；~20Hz 节流）：按空间位置调制声像、距离音量、空气吸收/隔墙低通与森林/木屋混响发送；
   * 场上只有一条常驻链，多支火把时由调用方传入最近一支。spatial 省略视为贴身
   */
  setGroundTorchBurn(level01: number, spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    if (!ctx || !this.initialized || this.muted || this.pageHidden) return;
    const lv = Number.isFinite(level01) ? clamp(level01, 0, 1) : 0;
    if (lv === 0 && this.gtSent === 0) return;
    const tms = nowMs();
    const fadeOut = lv === 0 && this.gtSent > 0;
    if (!fadeOut && tms - this.gtSentMs < 50) return;
    this.gtSent = lv;
    this.gtSentMs = tms;
    const now = ctx.currentTime;
    const sp = this.spatialParams(spatial);
    this.gtFlick = clamp(this.ouStep(this.gtFlick, 0, 2.2, 1.0, 0.05), -1, 1);
    const fl = 0.5 + 0.5 * this.gtFlick;
    const tau = lv === 0 ? 0.3 : 0.1;
    const rainK = sp.sourceIndoor ? 0 : clamp(this.rainNow, 0, 1);
    if (this.gtIn) this.gtIn.gain.setTargetAtTime(lv * clamp(sp.gainScale, 0, 1), now, tau);
    if (this.gtLP) this.gtLP.frequency.setTargetAtTime(clamp(sp.lpHz, 300, 12000), now, 0.12);
    if (this.gtPan) this.gtPan.pan.setTargetAtTime(sp.pan, now, 0.08);
    if (this.gtDry) this.gtDry.gain.setTargetAtTime(1 - 0.42 * sp.dist01, now, 0.12);
    const wet = 0.1 + 0.5 * sp.dist01;
    if (this.gtSendF) this.gtSendF.gain.setTargetAtTime(sp.sourceIndoor ? 0 : wet, now, 0.2);
    if (this.gtSendH) this.gtSendH.gain.setTargetAtTime(sp.sourceIndoor ? wet : 0, now, 0.2);
    if (this.gtCrackG) this.gtCrackG.gain.setTargetAtTime(0.25 * (0.7 + 0.3 * fl) * (1 - 0.3 * rainK), now, 0.08);
    if (this.gtRoarG) this.gtRoarG.gain.setTargetAtTime(0.06 * (0.8 + 0.2 * fl), now, 0.08);
    if (this.gtSizzleG) this.gtSizzleG.gain.setTargetAtTime(rainK * 0.03 * rnd(0.35, 1.15), now, 0.05);
  }

  /**
   * 闹鬼程度（每步调用、不分配节点；~20Hz 节流）：持续低频不安嗡声（两条相差约半音的三角波拍频）、轻微走调（随机游走失谐）、
   * 较高程度时轻微耳鸣；低频 dread 与环境 dread 合并取最大（同一振荡器，不叠两层），耳鸣与低血耳鸣同链取最大；0 时淡出
   */
  setHauntLevel(level01: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.initialized || this.muted || this.pageHidden) return;
    const lv = Number.isFinite(level01) ? clamp(level01, 0, 1) : 0;
    const tms = nowMs();
    const dt = clamp((tms - this.hauntLastMs) / 1000, 0, 0.1);
    this.hauntLastMs = tms;
    if (lv === 0 && this.hauntSent === 0) return;
    this.hauntWob = clamp(this.ouStep(this.hauntWob, 0, 0.6, 0.85, dt), -1, 1);
    const fadeOut = lv === 0 && this.hauntSent > 0;
    if (!fadeOut && tms - this.hauntSentMs < 50) return;
    this.hauntSent = lv;
    this.hauntSentMs = tms;
    const now = ctx.currentTime;
    this.applyDread(now);
    const tau = lv === 0 ? 0.8 : 0.4;
    if (this.hauntHumG) this.hauntHumG.gain.setTargetAtTime(Math.pow(lv, 1.3) * 0.045, now, tau);
    if (this.hauntOscA) this.hauntOscA.frequency.setTargetAtTime(61.7 * (1 - 0.006 * this.hauntWob * lv), now, 0.5);
    if (this.hauntOscB) this.hauntOscB.frequency.setTargetAtTime(65.4 * (1 + 0.014 * this.hauntWob * lv), now, 0.5);
    this.tinnHaunt = smooth01((lv - 0.35) / 0.65) * 0.0028;
    this.applyTinnitus(now, lv === 0 ? 0.8 : 0.6);
  }

  /** dread 低频合并：max(环境黑夜/危险, 闹鬼)；音高叠加闹鬼走调 */
  private applyDread(now: number) {
    if (!this.dreadGain || !this.dreadOsc) return;
    const h = this.hauntSent;
    const level = Math.max(this.dreadAmb, h * 0.9);
    this.dreadGain.gain.setTargetAtTime(level * 0.13, now, 0.3);
    this.dreadOsc.frequency.setTargetAtTime(this.dreadHzAmb * (1 + 0.025 * this.hauntWob * h), now, 0.3);
  }

  /** 耳鸣合并：max(低血量, 闹鬼) */
  private applyTinnitus(now: number, tau: number) {
    if (!this.tinnitusGain) return;
    this.tinnitusGain.gain.setTargetAtTime(Math.max(this.tinnBody, this.tinnHaunt), now, tau);
  }

  // ═══════════════════════════ 每帧氛围调制 ═══════════════════════════

  /** Ornstein-Uhlenbeck 随机游走一步：向均值 mu 回归 + 随机扰动（纯标量运算） */
  private ouStep(x: number, mu: number, theta: number, sigma: number, dt: number): number {
    return x + theta * (mu - x) * dt + sigma * Math.sqrt(dt) * (Math.random() * 2 - 1) * 1.73;
  }

  /**
   * 每帧物理氛围参数平滑调制（风、雨、空间混响交叉淡化、发电机低油量咳喘、黑夜压迫、危险心跳、稀疏环境事件）
   * 每帧不新建任何音频节点；音床参数以 ~20Hz 节流推送 setTargetAtTime，避免自动化事件队列膨胀
   */
  updateAmbience(params: {
    dt: number;
    nightFactor: number;
    rainIntensity: number;
    inHideout: boolean;
    genDist: number;
    genOn: boolean;
    genFuel: number;
    danger: number;
    time: number;
  }) {
    if (!this.ctx || !this.initialized || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const dt = clamp(params.dt, 0, 0.1);
    const rain = clamp(params.rainIntensity, 0, 1);
    const night = clamp(params.nightFactor, 0, 1);
    const indoor = params.inHideout;
    const indoorChanged = indoor !== this.listenerIndoor;
    this.listenerIndoor = indoor;
    this.rainNow = rain;
    this.dangerNow = Number.isFinite(params.danger) ? params.danger : 0;
    this.ambLastMs = nowMs();
    this.genDistNow = Number.isFinite(params.genDist) ? params.genDist : 1e4;

    // 阵风随机游走：均值随夜晚与雨势抬升；中心频率在对数域漂移
    const windMu = 0.28 + night * 0.22 + rain * 0.35;
    this.gustA = clamp(this.ouStep(this.gustA, windMu, 0.32, 0.42, dt), 0, 1.25);
    this.gustB = clamp(this.ouStep(this.gustB, windMu, 0.27, 0.38, dt), 0, 1.25);
    this.gustFA = clamp(this.ouStep(this.gustFA, 0, 0.22, 0.55, dt), -1.2, 1.2);
    this.gustFB = clamp(this.ouStep(this.gustFB, 0, 0.2, 0.5, dt), -1.2, 1.2);

    // 湿润记忆：下雨时快速积累，雨停后约 45s 缓慢消退（雨停后屋檐仍在滴水）
    if (rain > this.wetMemory) this.wetMemory += (rain - this.wetMemory) * Math.min(1, dt * 0.8);
    else this.wetMemory += (rain - this.wetMemory) * Math.min(1, dt / 45);

    this.ambAccum += dt;
    if (this.ambAccum >= 0.05 || indoorChanged) {
      this.ambAccum = 0;
      this.applySpaceMix(now, indoor);
      this.applyWind(now, night, rain, indoor);
      this.applyRain(now, rain, indoor);
      this.applyLife(now, night, rain, indoor, this.dangerNow);
    }

    // 发电机低鸣与低油量（< 22）间歇性熄火咳喘调制（保持原逐帧逻辑）
    if (this.genGain && this.genOsc && this.genOsc2 && this.genFilter) {
      if (params.genOn) {
        const proximity = clamp(1 - params.genDist / 520, 0, 1);
        let gainMod = 1.0;
        let baseFreq = 54;
        let filterFreq = 165;

        if (params.genFuel < 22) {
          // 越接近耗尽，咳喘幅度与频次越剧烈
          const severity = clamp((22 - params.genFuel) / 22, 0.2, 1);
          const slowCough = Math.sin(params.time * 2.4) * 0.5 + 0.5;
          const misfirePulse = Math.sin(params.time * 15.8 + Math.sin(params.time * 3.1) * 1.4);
          const isStalling = slowCough > 0.52 && misfirePulse > 0.28;
          gainMod = isStalling ? 0.22 + (1 - severity) * 0.3 : 0.85 + Math.sin(params.time * 9.2) * 0.15;
          baseFreq = isStalling
            ? 38 + (1 - severity) * 6 + Math.sin(params.time * 19) * 2.5
            : 51 + Math.sin(params.time * 11.5) * 3.5;
          filterFreq = isStalling ? 105 : 155 + severity * 38;
        }

        const wallAtten = params.inHideout ? 1.0 : 0.65;
        this.genGain.gain.setTargetAtTime(
          proximity * proximity * 0.145 * gainMod * wallAtten,
          now,
          0.055
        );
        this.genOsc.frequency.setTargetAtTime(baseFreq, now, 0.055);
        this.genOsc2.frequency.setTargetAtTime(baseFreq * 2, now, 0.055);
        this.genFilter.frequency.setTargetAtTime(
          params.inHideout ? filterFreq : filterFreq * 0.72,
          now,
          0.08
        );
      } else {
        this.genGain.gain.setTargetAtTime(0, now, 0.12);
      }
    }

    // 黑夜/危险 dread：与闹鬼程度合并取最大（同一振荡器，不叠两层）
    if (this.dreadGain && this.dreadOsc) {
      const dg = this.dangerNow;
      this.dreadAmb = clamp(night * 0.35 + dg * 0.65, 0, 1);
      this.dreadHzAmb = 38 + dg * 9;
      this.applyDread(now);
    }

    // 心跳：危险度与身体状态合并取最大，全局只有一个节拍器；
    // updateBody 活跃时由它推进（避免同一帧推进两次），未接入时保持原危险心跳行为
    if (nowMs() - this.bodyLastMs > 400) this.tickHeart(dt);

    this.updateAmbientEvents(dt, night, indoor, params.danger);
  }

  /**
   * 空间交叉淡化：室内 → 木屋混响为主、森林混响与室外氛围经墙体低通压暗；室外反之
   */
  private applySpaceMix(now: number, indoor: boolean) {
    const tau = 0.35;
    const k = indoor ? 1 : 0;
    if (this.roomToForest) this.roomToForest.gain.setTargetAtTime(1 - k, now, tau);
    if (this.roomToHut) this.roomToHut.gain.setTargetAtTime(k, now, tau);
    if (this.forestWallLP) this.forestWallLP.frequency.setTargetAtTime(indoor ? 1000 : 9000, now, tau);
    if (this.hutWallLP) this.hutWallLP.frequency.setTargetAtTime(indoor ? 9000 : 900, now, tau);
    if (this.forestOut) this.forestOut.gain.setTargetAtTime(indoor ? 0.5 : 0.62, now, tau);
    if (this.hutOut) this.hutOut.gain.setTargetAtTime(indoor ? 0.55 : 0.35, now, tau);
    if (this.outdoorLP) this.outdoorLP.frequency.setTargetAtTime(indoor ? 1300 : 12000, now, tau);
    if (this.outdoorTrim) this.outdoorTrim.gain.setTargetAtTime(indoor ? 0.6 : 1, now, tau);
    if (this.nearSend) this.nearSend.gain.setTargetAtTime(indoor ? 0.22 : 0.08, now, tau);
  }

  /** 风：低频底噪 + 左右两路随机游走阵风 + 强阵风细哨 */
  private applyWind(now: number, night: number, rain: number, indoor: boolean) {
    const indoorScale = indoor ? 0.6 : 1;
    const gA = this.gustA;
    const gB = this.gustB;
    const tau = 0.3;

    if (this.windGain && this.windFilter) {
      const base = (0.06 + night * 0.05 + rain * 0.04 + (gA + gB) * 0.022) * indoorScale;
      const freq = 180 + night * 90 + rain * 80 + (gA + gB) * 70;
      this.windGain.gain.setTargetAtTime(clamp(base, 0.015, 0.26), now, tau);
      this.windFilter.frequency.setTargetAtTime(clamp(freq, 110, 700), now, tau);
    }
    if (this.gustGainA && this.gustBPA) {
      const center = clamp(380 * Math.pow(2, this.gustFA) * (0.75 + gA * 0.6), 140, 1800);
      this.gustBPA.frequency.setTargetAtTime(center, now, tau);
      this.gustBPA.Q.setTargetAtTime(0.6 + (1 - Math.min(gA, 1)) * 0.9, now, tau);
      this.gustGainA.gain.setTargetAtTime((0.025 + gA * gA * 0.11) * indoorScale, now, tau);
    }
    if (this.gustGainB && this.gustBPB) {
      const center = clamp(360 * Math.pow(2, this.gustFB) * (0.75 + gB * 0.6), 140, 1800);
      this.gustBPB.frequency.setTargetAtTime(center, now, tau);
      this.gustBPB.Q.setTargetAtTime(0.6 + (1 - Math.min(gB, 1)) * 0.9, now, tau);
      this.gustGainB.gain.setTargetAtTime((0.025 + gB * gB * 0.11) * indoorScale, now, tau);
    }
    if (this.whistleGain && this.whistleBP) {
      const over = Math.max(0, (gA + gB) * 0.5 - 0.55);
      this.whistleGain.gain.setTargetAtTime(Math.min(0.09, over * over * 0.18) * indoorScale, now, 0.4);
      this.whistleBP.frequency.setTargetAtTime(2100 * Math.pow(2, this.gustFB * 0.4), now, 0.4);
    }
  }

  /**
   * 雨（全部连续映射，无逐层开关；第三轮改为物理粒子层 + 随机重排）：
   *   远场粒子云随雨势渐强渐亮；重雨地面低频轰鸣按 ~2.2 次方渐入（低频只由它构成）；
   *   表面层用幂函数交叉——近处稀疏树叶在小雨时为主角、大雨时让位给密集树冠与泥地，积水随湿润记忆形成；
   *   每段播放速率 = 基础 × 雨势密度（±6%）× 独立随机游走（±5%）× 段内随机（±3%）；
   *   阵风：雨总线整体起伏 + 随左右阵风差扫动声像，树叶层随风变亮；屋檐细流随湿润记忆与离屋距离；室内屋顶两层同理
   */
  private applyRain(now: number, rain: number, indoor: boolean) {
    const tau = 0.25;
    const gA = this.gustA;
    const gB = this.gustB;
    const gust = clamp((gA + gB) * 0.5, 0, 1.25);
    const wet = clamp(this.wetMemory, 0, 1);
    const density = 0.94 + 0.12 * rain;
    // 录音层就绪后：程序化"嘶嘶"类层（远场/树冠/地面）降到约 20–35%，近处单滴/叶面回弹/积水点缀基本保留，避免两层雨叠成白噪
    const rk = this.recMixK(now);

    if (this.farRain) {
      const ly = this.farRain;
      ly.drift = clamp(ly.drift * 0.97 + (Math.random() * 2 - 1) * 0.006, -0.05, 0.05);
      this.setShuffleWeight(ly, clamp(Math.pow(rain, 0.85) * RAIN_FAR_K, 0, RAIN_FAR_K) * (1 - 0.8 * rk), now, tau);
      this.pumpShuffle(ly, now, ly.baseRate * density * (1 + ly.drift));
    }
    if (this.rainFilter) {
      this.rainFilter.frequency.setTargetAtTime(clamp(6500 + rain * 3600 + gust * 500, 4000, 11000), now, tau);
    }
    if (this.rainRoarGain && this.rainRoarLP) {
      this.rainRoarGain.gain.setTargetAtTime(Math.pow(rain, 2.2) * RAIN_ROAR_K * (1 - 0.5 * rk), now, tau);
      this.rainRoarLP.frequency.setTargetAtTime(380 + rain * 380, now, tau);
    }
    if (this.rainBus) {
      this.rainBus.gain.setTargetAtTime(0.72 + 0.5 * Math.pow(gust, 1.3), now, 0.2);
    }
    if (this.rainPan) {
      this.rainPan.pan.setTargetAtTime(clamp((gA - gB) * 0.6 + this.gustFA * 0.1, -0.6, 0.6), now, 0.3);
    }

    // 响度按长时平均 RMS 标定（见交付频谱表）：小雨（0.45）与大雨（1.0）总体响度与第二轮持平（±1dB）
    const w0 = RAIN_W[0] * Math.pow(rain, 0.5) * (1 - 0.55 * rain);
    const w1 = RAIN_W[1] * Math.pow(rain, 1.5);
    const w2 = RAIN_W[2] * Math.pow(rain, 1.1);
    const w3 = RAIN_W[3] * Math.pow(wet, 1.3) * (0.25 + 0.75 * rain);
    const procK = [1 - 0.2 * rk, 1 - 0.65 * rk, 1 - 0.65 * rk, 1 - 0.5 * rk];
    const weights = [w0 * procK[0], w1 * procK[1], w2 * procK[2], w3 * procK[3]];
    for (let i = 0; i < this.rainLayers.length; i++) {
      const ly = this.rainLayers[i];
      ly.drift = clamp(ly.drift * 0.97 + (Math.random() * 2 - 1) * 0.006, -0.05, 0.05);
      this.setShuffleWeight(ly, i < weights.length ? weights[i] : 0, now, tau);
      this.pumpShuffle(ly, now, ly.baseRate * density * (1 + ly.drift));
    }
    if (this.leafLP) {
      this.leafLP.frequency.setTargetAtTime(clamp(8000 + rain * 2200 + gust * 900, 5000, 11000), now, tau);
    }
    if (this.mudLP) this.mudLP.frequency.setTargetAtTime(1500 + rain * 1500, now, tau);

    // 屋檐细流：湿润记忆驱动（雨停后仍淌一阵）；室外按离庇护所距离渐隐，室内隔墙
    const gd = Number.isFinite(this.genDistNow) ? this.genDistNow : 1e4;
    this.eaveProx = indoor ? 0.8 : Math.pow(1 - clamp((gd - 150) / 350, 0, 1), 1.4);
    if (this.eaveLayer) {
      const ly = this.eaveLayer;
      this.setShuffleWeight(ly, RAIN_EAVE_K * smooth01((wet - 0.08) / 0.5) * this.eaveProx, now, 0.6);
      this.pumpShuffle(ly, now, ly.baseRate * (0.96 + 0.08 * wet) * rnd(0.99, 1.01));
    }

    // 屋顶：密集层缓冲本身更响，系数按 RMS 标定，大雨总体比第一轮略高约 2dB（敲击更分明）
    const r0 = 0.26 * Math.pow(rain, 0.55) * (1 - 0.45 * rain);
    const r1 = 0.14 * Math.pow(rain, 1.5);
    const roofW = [r0, r1];
    for (let i = 0; i < this.roofLayers.length; i++) {
      const ly = this.roofLayers[i];
      ly.drift = clamp(ly.drift * 0.97 + (Math.random() * 2 - 1) * 0.006, -0.05, 0.05);
      this.setShuffleWeight(ly, indoor && i < roofW.length ? roofW[i] * (1 - 0.3 * rk) : 0, now, 0.3);
      this.pumpShuffle(ly, now, ly.baseRate * density * (1 + ly.drift));
    }
    if (this.roofBody) this.roofBody.gain.setTargetAtTime(2 + rain * 4, now, 0.5);

    // 真实录音层：室外淡雨/大雨随雨势等功率交叉；近处积水随湿润度；雨后滴水在湿润而雨小时出现；室内启用篷顶底料（室外层经 outdoorLP 闷化）
    if (rk > 0 && this.recLayers.length > 0) {
      const x = smooth01((rain - 0.3) / 0.5);
      const lv = Math.pow(rain, 0.7) * rk;
      const rw = [
        REC_K.light * lv * Math.cos(x * Math.PI * 0.5),
        REC_K.heavy * lv * Math.sin(x * Math.PI * 0.5),
        REC_K.puddle * Math.pow(wet, 1.3) * (0.3 + 0.7 * rain) * rk,
        REC_K.drip * smooth01((wet - 0.15) / 0.4) * (1 - smooth01(rain / 0.35)) * rk,
        indoor ? REC_K.roof * Math.pow(rain, 0.6) * rk : 0,
      ];
      for (let i = 0; i < this.recLayers.length; i++) {
        const ly = this.recLayers[i];
        if (!ly) continue;
        ly.drift = clamp(ly.drift * 0.98 + (Math.random() * 2 - 1) * 0.003, -0.02, 0.02);
        this.setShuffleWeight(ly, i < rw.length ? rw[i] : 0, now, i === 4 ? 0.3 : tau);
        this.pumpShuffle(ly, now, ly.baseRate * (1 + ly.drift));
      }
    }
  }

  /** 创建一条随机重排层：out 层增益（初始 0）→ dest，两条交叉淡化槽 → out（初始化时调用一次） */
  private makeShuffleLayer(
    ctx: AudioContext,
    pool: AudioBuffer[] | undefined,
    dest: AudioNode,
    baseRate: number,
    segMin: number,
    segMax: number,
    xfMin = 0.18,
    xfMax = 0.42,
    jit = 0.03,
    noWrap = false
  ): ShuffleLayer | null {
    if (!pool || pool.length === 0) return null;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, now);
    out.connect(dest);
    const slots: GainNode[] = [];
    for (let i = 0; i < 2; i++) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.connect(out);
      slots.push(g);
    }
    return {
      pool,
      slots,
      out,
      slot: 0,
      nextAt: 0,
      xf: (xfMin + xfMax) * 0.5,
      baseRate,
      drift: 0,
      segMin,
      segMax,
      weight: 0,
      xfMin,
      xfMax,
      jit,
      noWrap,
    };
  }

  /** 推送层权重（setTargetAtTime 平滑），并记下供排段判定 */
  private setShuffleWeight(ly: ShuffleLayer, w: number, now: number, tau: number) {
    const v = Number.isFinite(w) ? Math.max(0, w) : 0;
    ly.weight = v;
    ly.out.gain.setTargetAtTime(v, now, tau);
  }

  /**
   * 随机重排调度（applyRain 内 ~20Hz 调用）：提前 0.35s 排下一段；层权重近零时不再排段（当前段自然淡出 → 无雨零分配）。
   * 每段只新建 1 个 AudioBufferSourceNode（loop + 随机起点 + stop），onended 自行断开；槽增益按等功率近似（0 → 0.707 → 1）交叉
   */
  private pumpShuffle(ly: ShuffleLayer, now: number, rate: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (now < ly.nextAt - 0.35) return;
    if (ly.weight < 0.0005) return;
    const buf = ly.pool[Math.floor(Math.random() * ly.pool.length)];
    if (!buf) return;
    const t0 = Math.max(ly.nextAt, now + 0.03);
    const fadeIn = clamp(ly.xf, ly.xfMin * 0.5, ly.xfMax);
    const fadeOut = rnd(ly.xfMin, ly.xfMax);
    const seg = Math.max(fadeIn + fadeOut + 0.2, rnd(ly.segMin, ly.segMax));
    const tEnd = t0 + seg + fadeOut;
    const r = clamp(rate * rnd(1 - ly.jit, 1 + ly.jit), 0.5, 2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // 录音层：起点限制在"整段播完不越过末尾"的范围内；放不下才退回循环
    const need = (seg + fadeOut + 0.05) * r;
    const fits = ly.noWrap && need < buf.duration - 0.05;
    src.loop = !fits;
    src.playbackRate.setValueAtTime(r, t0);
    const g = ly.slots[ly.slot];
    src.connect(g);
    src.start(t0, fits ? Math.random() * (buf.duration - need - 0.05) : Math.random() * buf.duration * 0.98);
    src.stop(tEnd + 0.02);
    src.onended = () => {
      try {
        src.disconnect();
      } catch {
        // 已断开则忽略
      }
    };
    const p = g.gain;
    p.cancelScheduledValues(t0);
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(0.707, t0 + fadeIn * 0.5);
    p.linearRampToValueAtTime(1, t0 + fadeIn);
    p.setValueAtTime(1, t0 + seg);
    p.linearRampToValueAtTime(0.707, t0 + seg + fadeOut * 0.5);
    p.linearRampToValueAtTime(0, tEnd);
    ly.slot = ly.slot === 0 ? 1 : 0;
    ly.nextAt = t0 + seg;
    ly.xf = fadeOut;
  }

  /**
   * 生命层常驻音床调制（20Hz 节流）：树梢沙沙跟随阵风 + 随机抖动；蟋蟀黄昏渐起、夜间稍收；
   * 大雨掩蔽、危险度高时整体收敛
   */
  private applyLife(now: number, night: number, rain: number, indoor: boolean, danger: number) {
    const calm = clamp(1 - danger * 0.8, 0.15, 1);
    const indoorScale = indoor ? 0.55 : 1;
    if (this.canopyGainL && this.canopyGainR) {
      const k = (1 - rain * 0.35) * indoorScale * (0.6 + 0.4 * calm);
      const gl = 0.0015 + 0.012 * Math.pow(clamp(this.gustA, 0, 1.2), 1.5);
      const gr = 0.0015 + 0.012 * Math.pow(clamp(this.gustB, 0, 1.2), 1.5);
      this.canopyGainL.gain.setTargetAtTime(gl * k * rnd(0.75, 1.25), now, 0.09);
      this.canopyGainR.gain.setTargetAtTime(gr * k * rnd(0.75, 1.25), now, 0.09);
    }
    if (this.canopyBP) {
      this.canopyBP.frequency.setTargetAtTime(3600 + (this.gustA + this.gustB) * 900, now, 0.4);
    }
    const dusk = smooth01((night - 0.3) / 0.3);
    const crick = dusk * (1 - smooth01((rain - 0.35) / 0.45)) * calm * (night >= 0.8 ? 0.7 : 1);
    for (let i = 0; i < this.cricketGains.length; i++) {
      this.cricketGains[i].gain.setTargetAtTime(crick * (i === 0 ? 0.007 : 0.005), now, 4);
    }
  }

  /**
   * 稀疏环境事件调度（仅计时器标量运算；事件触发时才创建一次性节点）：
   * 树木吱嘎 / 远处枝断 / 屋檐滴水 / 昼夜环境叙事声
   */
  private updateAmbientEvents(dt: number, night: number, indoor: boolean, danger: number) {
    const gust = (this.gustA + this.gustB) * 0.5;

    // 1. 树木吱嘎：阵风越强越频繁
    this.treeCreakTimer -= dt;
    if (this.treeCreakTimer <= 0) {
      this.treeCreakTimer = Math.max(5, 8 + Math.random() * 18 - gust * 5);
      if (gust > 0.25) this.playTreeCreak(randomPan(0.92), clamp(gust, 0.3, 1));
    }

    // 2. 远处枝断（风致）
    this.branchTimer -= dt * (0.6 + gust);
    if (this.branchTimer <= 0) {
      this.branchTimer = 16 + Math.random() * 26;
      this.playBranchSnap(randomPan(0.92), rnd(0.6, 1), 0.45 + gust * 0.35);
    }

    // 3. 屋檐 / 叶面滴水：雨中与雨停后的湿润期
    if (this.wetMemory > 0.1) {
      this.dripTimer -= dt;
      if (this.dripTimer <= 0) {
        const spread = indoor ? 2.6 : 4.0;
        // 靠近屋檐时滴落更密
        this.dripTimer = ((indoor ? 0.5 : 0.9) + (Math.random() * spread) / (0.4 + this.wetMemory)) / (1 + this.eaveProx * 0.8);
        this.playEaveDrip(indoor);
      }
    }

    // 4. 环境叙事声：白天 20–45s 一次鸦鸣/枝断；夜晚 15–35s 一次敲击/拖拽/低语
    //    危险度高时不播放（避免假信号干扰玩家凭声音判断真实威胁方位）
    this.narrativeTimer -= dt;
    if (this.narrativeTimer <= 0) {
      const isNight = night >= 0.8;
      this.narrativeTimer = isNight ? 15 + Math.random() * 20 : 20 + Math.random() * 25;
      if (danger < 0.5) {
        const pan = randomPan(0.95);
        const r = Math.random();
        if (isNight) {
          if (r < 0.38) this.playDistantKnock(pan);
          else if (r < 0.72) this.playDistantDrag(pan);
          else this.playWhisper(pan);
        } else if (r < 0.65) {
          this.playCrowCall(pan);
        } else {
          this.playBranchSnap(pan, rnd(0.7, 1), 0.7);
        }
      }
    }

    const rain = this.rainNow;
    const ctxNow = this.ctx ? this.ctx.currentTime : 0;

    // 5. 近处树冠大水滴"啪嗒"：室外下雨或雨后湿润期；强阵风时一次抖落 2–4 滴
    if (!indoor && this.wetMemory > 0.15) {
      this.canopyDropTimer -= dt;
      if (this.canopyDropTimer <= 0) {
        this.canopyDropTimer = rnd(1.0, 3.5) / (0.4 + this.wetMemory * 0.6 + rain * 0.8);
        this.playCanopyDrop(gust > 0.85 ? 2 + Math.floor(Math.random() * 3) : 1);
      }
    }

    // 6. 室内屋顶铁皮补丁偶发金属叮当
    if (indoor && rain > 0.12) {
      this.tinTimer -= dt;
      if (this.tinTimer <= 0) {
        this.tinTimer = rnd(0.6, 3.6) / (0.3 + rain);
        this.playRoofTin(rain);
      }
    }

    // 7. 生命层事件：白天远处鸦群/啄木鸟/飞虫；黄昏蛙鸣（雨中更多）；夜晚猫头鹰/远处长嚎/林中不明动物移动
    //    危险度 ≥ 0.55 完全收敛；其余按 calm 拉长间隔、压低音量；任意两次生命事件至少间隔 4s，避免嘈杂
    const calm = clamp(1 - danger * 1.2, 0.25, 1);
    const canLife = danger < 0.55 && ctxNow - this.lastLifeAt > 4;
    if (night < 0.35) {
      this.dayLifeTimer -= dt;
      if (this.dayLifeTimer <= 0) {
        this.dayLifeTimer = rnd(10, 22) / calm;
        if (canLife) {
          const r = Math.random();
          if (r < 0.42 && rain < 0.75) this.playCrowFlock(calm);
          else if (r < 0.7 && rain < 0.45) this.playWoodpecker(randomPan(0.9), calm);
          else if (rain < 0.25) this.playInsectPass(calm);
          else this.playCrowFlock(calm * 0.8);
          this.lastLifeAt = ctxNow;
        }
      }
    } else if (night < 0.8) {
      this.duskLifeTimer -= dt;
      if (this.duskLifeTimer <= 0) {
        this.duskLifeTimer = rnd(5, 12) / ((0.7 + rain * 0.8) * calm);
        if (canLife) {
          const r = Math.random();
          if (r < 0.7) {
            this.playFrogs(randomPan(0.9), calm);
            if (Math.random() < 0.35) this.playFrogs(randomPan(0.9), calm * 0.7);
          } else if (r < 0.85) {
            this.playCrowFlock(calm * 0.7);
          } else {
            this.playOwl(randomPan(0.9), calm * 0.8);
          }
          this.lastLifeAt = ctxNow;
        }
      }
    } else {
      this.nightLifeTimer -= dt;
      if (this.nightLifeTimer <= 0) {
        this.nightLifeTimer = rnd(12, 26) / calm;
        if (canLife) {
          const r = Math.random();
          if (r < 0.38 && rain < 0.7) {
            this.playOwl(randomPan(0.9), calm);
          } else if (r < 0.56 && ctxNow - this.lastHowlAt > 70) {
            this.playHowl(randomPan(0.95), calm);
            this.lastHowlAt = ctxNow;
          } else {
            this.playCreatureRustle(randomPan(0.95), calm);
          }
          if (rain > 0.3 && Math.random() < 0.3) this.playFrogs(randomPan(0.9), calm * 0.6);
          this.lastLifeAt = ctxNow;
        }
      }
    }
  }

  // ═══════════════════════════ 天气一次性音效 ═══════════════════════════

  /**
   * 雷声：先尖锐裂响（宽频短瞬态串，越近越强）→ 再 4–8s 滚动轰鸣（低通棕噪 + 随机振幅起伏，左右两层去相关）
   * 全程经室外总线（进屋自动闷化）并大量送入森林混响
   */
  playThunder(intensity = 0.8) {
    const ctx = this.ctx;
    const master = this.masterGain;
    const white = this.whiteBuf;
    const brown = this.brownBuf;
    if (!ctx || !master || !white || !brown || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const k = clamp(intensity, 0.1, 1.2);
    const vol = clamp(k * 0.42, 0.12, 0.45);
    const shot = new OneShot();
    const bus: AudioNode = this.outdoorBus ?? master;

    // 公共出口：随机方位 → 室外总线；并送入森林混响
    const out = this.amp(ctx, shot, 1, now);
    if (typeof ctx.createStereoPanner === 'function') {
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(rnd(-0.55, 0.55), now);
      out.connect(p);
      p.connect(bus);
    } else {
      out.connect(bus);
    }
    if (this.forestIn) {
      const send = this.amp(ctx, shot, 0.55, now);
      out.connect(send);
      send.connect(this.forestIn);
    }

    // 1. 尖锐裂响：3–6 个毫秒级宽频爆裂（主击 + 余裂）
    const crackAmt = clamp((k - 0.55) / 0.45, 0.18, 1);
    const crackDur = 0.42;
    const crackSrc = this.noiseSource(ctx, shot, white, now, crackDur);
    const crackHP = this.filt(ctx, shot, 'highpass', 600, 0.5, now);
    const crackLP = this.filt(ctx, shot, 'lowpass', 7500, 0.5, now);
    crackLP.frequency.exponentialRampToValueAtTime(2500, now + crackDur);
    const crackG = this.amp(ctx, shot, 0.0001, now);
    let t = now + 0.005;
    const bursts = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < bursts && t < now + crackDur - 0.05; i++) {
      const peak = vol * crackAmt * (i === 0 ? 1.15 : rnd(0.35, 0.85));
      const d = rnd(0.012, 0.035);
      this.perc(crackG.gain, t, peak, 0.0015, d);
      t += 0.0015 + d + rnd(0.004, 0.05);
    }
    crackSrc.connect(crackHP);
    crackHP.connect(crackLP);
    crackLP.connect(crackG);
    crackG.connect(out);

    // 2'. 真实滚雷录音（已解码时 75% 概率选用；裂响仍为程序化叠加），否则程序化滚动轰鸣
    const recTh =
      this.recThunder.length > 0 && Math.random() < 0.75
        ? this.recThunder[Math.floor(Math.random() * this.recThunder.length)]
        : null;
    if (recTh) {
      const t0 = now + rnd(0.03, 0.09);
      const rate = rnd(0.9, 1.04) * (1.05 - k * 0.1);
      const rdur = recTh.duration / rate;
      const rsrc = ctx.createBufferSource();
      rsrc.buffer = recTh;
      rsrc.playbackRate.setValueAtTime(rate, t0);
      rsrc.start(t0);
      rsrc.stop(t0 + rdur);
      shot.src(rsrc, t0 + rdur);
      const rlp = this.filt(ctx, shot, 'lowpass', 900 + k * 1500, 0, t0);
      const rg = this.amp(ctx, shot, vol * REC_K.thunder, t0);
      rsrc.connect(rlp);
      rlp.connect(rg);
      rg.connect(out);
    } else {
      // 2. 滚动轰鸣：两层低通棕噪，独立随机振幅包络，整体指数衰减
      const dur = clamp(4 + k * 2.6 + Math.random() * 1.6, 4, 8);
      const rStart = now + rnd(0.03, 0.09);
      for (let layer = 0; layer < 2; layer++) {
        const rate = layer === 0 ? rnd(0.85, 0.95) : rnd(1.0, 1.12);
        const src = this.noiseSource(ctx, shot, brown, rStart, dur + 0.1, rate);
        const lp = this.filt(ctx, shot, 'lowpass', 260 + k * 120, 0.8, rStart);
        lp.frequency.exponentialRampToValueAtTime(70, rStart + dur);
        const g = this.amp(ctx, shot, 0.0001, rStart);
        g.gain.linearRampToValueAtTime(vol * rnd(0.7, 1.0), rStart + rnd(0.18, 0.4));
        let tt = rStart + 0.45;
        while (tt < rStart + dur - 0.6) {
          const prog = (tt - rStart) / dur;
          const level = vol * Math.exp(-2.4 * prog) * rnd(0.25, 1.0);
          tt += rnd(0.16, 0.55);
          g.gain.linearRampToValueAtTime(Math.max(0.0003, level), tt);
        }
        g.gain.exponentialRampToValueAtTime(0.0001, rStart + dur);
        const lpan = this.amp(ctx, shot, 1, rStart);
        src.connect(lp);
        lp.connect(g);
        if (typeof ctx.createStereoPanner === 'function') {
          const p = shot.add(ctx.createStereoPanner());
          p.pan.setValueAtTime(layer === 0 ? -0.35 : 0.35, rStart);
          g.connect(p);
          p.connect(lpan);
        } else {
          g.connect(lpan);
        }
        lpan.connect(out);
      }
    }
    shot.seal();
  }

  /**
   * 心跳一拍（"咚—咚"双搏）：低血量时更沉（基频下移、第二搏稍迟）并叠加低通棕噪胸腔闷击；走身体总线
   */
  private playHeartbeat(intensity: number) {
    const ctx = this.ctx;
    const out: AudioNode | null = this.bodyBus ?? this.masterGain;
    if (!ctx || !out) return;
    const now = ctx.currentTime;
    const hurt = clamp(this.hurtSm, 0, 1);
    const vol = clamp(intensity * 0.26, 0.04, 0.26) * (1 + hurt * 0.15);
    const deep = 1 - hurt * 0.22;
    const shot = new OneShot();
    const brown = this.brownBuf;

    const pulse = (offset: number, freq: number, gainPeak: number) => {
      const t0 = now + offset;
      const osc = this.oscSource(ctx, shot, 'sine', freq * deep, t0, t0 + 0.2);
      osc.frequency.exponentialRampToValueAtTime(28 * deep, t0 + 0.15);
      const g = this.amp(ctx, shot, 0.0001, t0);
      g.gain.linearRampToValueAtTime(gainPeak, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16 + hurt * 0.03);
      osc.connect(g);
      g.connect(out);
      if (brown && hurt > 0.15) {
        const th = this.noiseSource(ctx, shot, brown, t0, 0.16);
        const lp = this.filt(ctx, shot, 'lowpass', 120, 0.9, t0);
        const tg = this.amp(ctx, shot, 0.0001, t0);
        this.perc(tg.gain, t0, gainPeak * hurt * 1.3, 0.004, 0.12);
        th.connect(lp);
        lp.connect(tg);
        tg.connect(out);
      }
    };

    pulse(0, 68, vol);
    pulse(0.17 + hurt * 0.03, 56, vol * 0.7);
    shot.seal();
  }

  /**
   * 统一心跳节拍器：驱动 = max(危险度, 身体驱动)，速率同取较快者；全局只有这一个相位累加器，杜绝两套心跳叠加
   */
  private tickHeart(dt: number) {
    const ambFresh = nowMs() - this.ambLastMs < 400;
    const dD = ambFresh && this.dangerNow > 0.25 ? clamp(this.dangerNow, 0, 1) : 0;
    const bD = this.heartBodySm > 0.18 ? clamp(this.heartBodySm, 0, 1) : 0;
    const drive = Math.max(dD, bD);
    if (drive <= 0) {
      this.heartbeatPhase = 0;
      return;
    }
    const rateD = dD > 0 ? 1.15 + dD * 1.45 : 0;
    const rateB = bD > 0 ? 1.3 + bD * 1.15 - this.hurtSm * 0.15 : 0;
    const rate = Math.max(rateD, rateB);
    this.heartbeatPhase += clamp(dt, 0, 0.1) * rate;
    if (this.heartbeatPhase >= 1) {
      this.heartbeatPhase -= 1;
      if (this.heartbeatPhase >= 1) this.heartbeatPhase = 0;
      this.playHeartbeat(drive);
    }
  }

  /**
   * 身体反馈（runtime 每次 engine.step 后调用）：疾跑呼吸与步频耦合；体力 < 25% 呼吸粗重急促；
   * 见底/耗尽锁定时明显喘息 + 心跳，随恢复以 ~3s 时间常数渐平；低血量心跳更沉、轻微耳鸣与整体轻微低通；
   * 同时驱动蓄力张力。只做标量平滑与常驻链参数自动化，每帧不分配节点
   */
  updateBody(p: {
    dt: number;
    stamina01: number;
    sprinting: boolean;
    exhausted: boolean;
    hp01: number;
    charging01: number;
  }): void {
    const ctx = this.ctx;
    if (!ctx || !this.initialized || !p || this.muted || this.pageHidden) return;
    this.bodyLastMs = nowMs();
    const now = ctx.currentTime;
    const dt = clamp(Number.isFinite(p.dt) ? p.dt : 0, 0, 0.1);
    const st = Number.isFinite(p.stamina01) ? clamp(p.stamina01, 0, 1) : 1;
    const hp = Number.isFinite(p.hp01) ? clamp(p.hp01, 0, 1) : 1;
    const sprinting = Boolean(p.sprinting);
    const exhausted = Boolean(p.exhausted);
    if (sprinting && !this.sprintNow) this.sprintSince = now;
    this.sprintNow = sprinting;

    // 1) 体力消耗度：疾跑 ~0.5；体力 < 25% 线性加重到 ~0.9；耗尽直接满档。上升快、恢复慢 → 喘息随恢复渐平
    let target = 0;
    if (sprinting) target = 0.5 + (1 - st) * 0.25;
    if (st < 0.25) target = Math.max(target, 0.55 + ((0.25 - st) / 0.25) * 0.35);
    if (exhausted) target = 1;
    const tauE = target > this.exertSm ? 0.5 : 3.2;
    this.exertSm += (target - this.exertSm) * (1 - Math.exp(-dt / tauE));

    // 2) 伤势（血量 < ~42% 起渐入）
    const hurtT = smooth01((0.42 - hp) / 0.34);
    this.hurtSm += (hurtT - this.hurtSm) * (1 - Math.exp(-dt / 1.2));

    // 3) 身体心跳驱动：见底 ~0.78、低血 ~0.72 取大，恢复同样缓慢
    const heartT = Math.max(smooth01((this.exertSm - 0.6) / 0.35) * 0.78, this.hurtSm * 0.72);
    const tauH = heartT > this.heartBodySm ? 0.8 : 3.5;
    this.heartBodySm += (heartT - this.heartBodySm) * (1 - Math.exp(-dt / tauH));

    // 4) 呼吸：疾跑中（刚起跑或脚步仍在）→ 由脚步驱动（noteSprintStep）；否则按自身节律（1.4s → 0.55s）
    const lvl = this.exertSm;
    const coupled = sprinting && (now - this.lastSprintStepAt < 0.45 || now - this.sprintSince < 0.6);
    if (coupled) {
      // 耦合期间清零自身节律计时：一旦停跑/体力锁定，喘息在当前这口气结束后立即接上
      this.breathTimer = 0;
    } else {
      if (lvl > 0.1) {
        this.breathTimer -= dt;
        if (this.breathTimer <= 0 && now >= this.breathBusyUntil - 0.02) {
          const cycle = 1.5 - 0.95 * lvl;
          this.scheduleBreath(now + 0.01, cycle, lvl);
          this.breathTimer = cycle * rnd(0.94, 1.1);
        }
      } else {
        this.breathTimer = 0;
      }
    }

    // 5) 统一心跳
    this.tickHeart(dt);

    // 6) 耳鸣与整体轻微低通（~20Hz 节流）
    this.bodyAccum += dt;
    if (this.bodyAccum >= 0.05) {
      this.bodyAccum = 0;
      const h = this.hurtSm;
      this.tinnBody = h * h * 0.0035;
      this.applyTinnitus(now, 0.6);
      if (this.hurtLP) {
        const maxHz = Math.min(20000, ctx.sampleRate * 0.45);
        this.hurtLP.frequency.setTargetAtTime(maxHz * Math.pow(4800 / maxHz, h), now, 0.5);
      }
    }

    // 7) 蓄力张力
    this.setChargeLevel(p.charging01);
  }

  /**
   * 安排一次完整呼吸（吸 + 呼）：只对常驻呼吸链做增益/滤波自动化，不分配节点。
   * lvl 越高越粗重；> 0.7 起进入"喘息"：吸气更急更响、呼气带出轻微嗓音
   */
  private scheduleBreath(t0: number, cycle: number, lvl: number) {
    const g = this.breathG;
    const bp = this.breathBP;
    if (!g || !bp) return;
    const c = clamp(cycle, 0.4, 2.2);
    const L = clamp(lvl, 0, 1);
    const gasp = smooth01((L - 0.7) / 0.3);
    const inDur = c * (0.36 - gasp * 0.08);
    const exT = t0 + inDur + c * 0.04;
    const exDur = c * 0.52;
    const inPeak = (0.012 + 0.045 * L) * (1 + gasp * 0.6) * rnd(0.85, 1.1);
    const exPeak = (0.016 + 0.07 * L) * rnd(0.85, 1.1);

    g.gain.cancelScheduledValues(t0);
    g.gain.setTargetAtTime(inPeak, t0, Math.max(0.012, inDur * (0.3 - gasp * 0.15)));
    g.gain.setTargetAtTime(0.0001, t0 + inDur * 0.8, 0.03);
    g.gain.setTargetAtTime(exPeak, exT, 0.035);
    g.gain.setTargetAtTime(0.0001, exT + exDur * 0.35, Math.max(0.02, exDur * 0.28));
    bp.frequency.cancelScheduledValues(t0);
    bp.frequency.setTargetAtTime(rnd(1700, 2300) * (1 + gasp * 0.2), t0, 0.04);
    bp.frequency.setTargetAtTime(rnd(850, 1200), exT, 0.05);

    const vg = this.voiceG;
    const vo = this.voiceOsc;
    if (vg && vo) {
      vg.gain.cancelScheduledValues(t0);
      vo.frequency.cancelScheduledValues(t0);
      if (gasp > 0.05) {
        const f = rnd(115, 150);
        vo.frequency.setTargetAtTime(f, exT, 0.02);
        vo.frequency.setTargetAtTime(f * 0.85, exT + exDur * 0.2, 0.1);
        vg.gain.setTargetAtTime(0.016 * gasp * rnd(0.6, 1), exT, 0.03);
        vg.gain.setTargetAtTime(0, exT + exDur * 0.3, 0.06);
      } else {
        vg.gain.setTargetAtTime(0, t0, 0.05);
      }
    }
    this.breathBusyUntil = exT + exDur;
  }

  /** 疾跑脚步回调：估计步频，并每 4 步（2 吸 2 呼）/ 喘息时每 3 步触发一次与脚步对齐的呼吸 */
  private noteSprintStep(now: number) {
    const iv = now - this.lastSprintStepAt;
    if (iv > 0.12 && iv < 0.5) this.stepIntSm = this.stepIntSm * 0.7 + iv * 0.3;
    this.lastSprintStepAt = now;
    this.stepsSinceBreath++;
    // 仅在 updateBody 报告疾跑时耦合（闪避调用的冲刺脚步等不触发）
    if (!this.sprintNow || nowMs() - this.bodyLastMs > 400) return;
    const lvl = this.exertSm;
    if (lvl < 0.1) return;
    const per = lvl > 0.75 ? 3 : 4;
    // 正常在上一口气结束后对齐脚步；若已等待超过两个呼吸周期（如起跑前的慢呼吸未完），直接接管
    if (this.stepsSinceBreath >= per && (now >= this.breathBusyUntil - 0.06 || this.stepsSinceBreath >= per * 2)) {
      this.stepsSinceBreath = 0;
      this.scheduleBreath(now + 0.005, this.stepIntSm * per, lvl);
    }
  }

  /**
   * 蓄力张力（每帧可调用、不分配节点）：握柄吱嘎（速率与亮度随张力上升）+ 憋气鼻息与喉部低哼 + 震颤；
   * level01 = 0 时以 ~70ms 时间常数平滑淡出。内置节流：变化很小且距上次推送 < 50ms 时跳过
   */
  setChargeLevel(level01: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.initialized) return;
    const lv = Number.isFinite(level01) ? clamp(level01, 0, 1) : 0;
    const prev = this.chargeSent;
    if (lv === prev) return;
    const tms = nowMs();
    if (lv > 0 && Math.abs(lv - prev) < 0.03 && tms - this.chargeSentMs < 50) return;
    this.chargeSent = lv;
    this.chargeSentMs = tms;
    const now = ctx.currentTime;
    const tau = lv > prev ? 0.09 : lv === 0 ? 0.07 : 0.12;
    const e = Math.pow(lv, 1.4);
    if (this.gripG) this.gripG.gain.setTargetAtTime(e * 0.12, now, tau);
    if (this.gripSrc) this.gripSrc.playbackRate.setTargetAtTime(0.75 + lv * 0.7, now, 0.15);
    if (this.gripBP) this.gripBP.frequency.setTargetAtTime(1000 + lv * 900, now, 0.15);
    // 震颤深度取憋气基准的 40%，保证增益始终为正
    const sBase = smooth01((lv - 0.15) / 0.85) * 0.045;
    if (this.strainG) this.strainG.gain.setTargetAtTime(sBase, now, tau);
    if (this.strainBP) this.strainBP.frequency.setTargetAtTime(1900 + lv * 1000, now, 0.2);
    if (this.strainHumG) this.strainHumG.gain.setTargetAtTime(lv * lv * 0.13, now, tau);
    if (this.strainOsc) this.strainOsc.frequency.setTargetAtTime(98 + lv * 45, now, 0.2);
    if (this.tremDepth) this.tremDepth.gain.setTargetAtTime(sBase * 0.4, now, tau);
  }

  // ═══════════════════════════ 玩家脚步 ═══════════════════════════

  /**
   * 玩家脚步：木地板（闷击 + 脚掌轻触 + 偶发吱嘎）/ 泥地（湿润咕叽 + 拔脚吸吮）/ 碎石（颗粒碰撞串）
   * 每步随机音高、力度、滤波与子事件时序，左右脚微小声像交替，绝不两步完全相同
   */
  playFootstep(surface: 'wood' | 'mud' | 'gravel', sprint: boolean, wetness = 0) {
    const ctx = this.ctx;
    const master = this.masterGain;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !master || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const bus: AudioNode = this.nearBus ?? master;
    this.stepSide = -this.stepSide;
    const wet = clamp(wetness, 0, 1);
    if (sprint) this.noteSprintStep(now);

    const out = this.amp(ctx, shot, 1, now);
    if (typeof ctx.createStereoPanner === 'function') {
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(this.stepSide * rnd(0.03, 0.09), now);
      out.connect(p);
      p.connect(bus);
    } else {
      out.connect(bus);
    }

    const s: StepCtx = {
      ctx,
      shot,
      out,
      now,
      pitch: rnd(0.86, 1.14),
      vel: (sprint ? 1.45 : 1) * rnd(0.8, 1.18),
      white,
      pink,
    };

    if (surface === 'wood') this.stepWood(s, sprint);
    else if (surface === 'mud') this.stepMud(s, wet);
    else this.stepGravel(s);

    // 潮湿地表额外的细碎水花
    if (surface !== 'wood' && wet > 0.35) {
      const t0 = now + rnd(0.0, 0.015);
      const sp = this.noiseSource(ctx, shot, white, t0, 0.08);
      const hp = this.filt(ctx, shot, 'highpass', rnd(2200, 3200), 0.7, t0);
      const g = this.amp(ctx, shot, 0.0001, t0);
      this.perc(g.gain, t0, 0.035 * wet * s.vel, 0.003, rnd(0.035, 0.06));
      sp.connect(hp);
      hp.connect(g);
      g.connect(out);
    }
    shot.seal();
  }

  /** 木地板脚步：脚跟低中频闷击 + 木板体共鸣 + 稍后的脚掌轻触 + 偶发吱嘎 */
  private stepWood(s: StepCtx, sprint: boolean) {
    const { ctx, shot, out, now, pitch, vel } = s;

    // 1) 脚跟闷击
    const heelDur = rnd(0.07, 0.11);
    const heel = this.noiseSource(ctx, shot, s.pink, now, heelDur + 0.03);
    const heelBP = this.filt(ctx, shot, 'bandpass', 185 * pitch * rnd(0.9, 1.1), rnd(1.0, 1.6), now);
    const heelG = this.amp(ctx, shot, 0.0001, now);
    this.perc(heelG.gain, now, 0.6 * vel, 0.004, heelDur);
    heel.connect(heelBP);
    heelBP.connect(heelG);
    heelG.connect(out);

    // 2) 木板体共鸣：短促下滑正弦
    const body = this.oscSource(ctx, shot, 'sine', 105 * pitch, now, now + 0.14);
    body.frequency.exponentialRampToValueAtTime(58 * pitch, now + 0.1);
    const bodyG = this.amp(ctx, shot, 0.0001, now);
    this.perc(bodyG.gain, now, 0.065 * vel, 0.003, 0.1);
    body.connect(bodyG);
    bodyG.connect(out);

    // 3) 脚掌轻触（冲刺时更紧凑）
    const toeT = now + rnd(0.03, 0.06) * (sprint ? 0.7 : 1);
    const toe = this.noiseSource(ctx, shot, s.white, toeT, 0.06);
    const toeBP = this.filt(ctx, shot, 'bandpass', 950 * pitch * rnd(0.85, 1.15), 1.2, toeT);
    const toeG = this.amp(ctx, shot, 0.0001, toeT);
    this.perc(toeG.gain, toeT, 0.12 * vel * rnd(0.6, 1), 0.002, 0.04);
    toe.connect(toeBP);
    toeBP.connect(toeG);
    toeG.connect(out);

    // 4) 偶发木板吱嘎：截取吱嘎缓冲的一小段快放
    if (this.creakBufs.length > 0 && Math.random() < (sprint ? 0.24 : 0.16)) {
      const buf = this.creakBufs[Math.floor(Math.random() * this.creakBufs.length)];
      const rate = rnd(1.4, 2.3);
      const cDur = rnd(0.14, 0.28);
      const ct = now + rnd(0.02, 0.07);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.setValueAtTime(rate, ct);
      src.start(ct, Math.random() * Math.max(0, buf.duration - cDur * rate - 0.02));
      src.stop(ct + cDur);
      shot.src(src, ct + cDur);
      const bp = this.filt(ctx, shot, 'bandpass', 820 * rnd(0.85, 1.25), 4, ct);
      const g = this.amp(ctx, shot, 0.0001, ct);
      const peak = 0.08 * vel * rnd(0.5, 1);
      g.gain.linearRampToValueAtTime(peak, ct + 0.03);
      g.gain.linearRampToValueAtTime(peak * 0.6, ct + cDur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, ct + cDur);
      src.connect(bp);
      bp.connect(g);
      g.connect(out);
    }
  }

  /** 泥地脚步：共振低通下扫的"咕叽" + 稍后拔脚的上扫吸吮 + 低频闷踏，湿度越高共振越强 */
  private stepMud(s: StepCtx, wet: number) {
    const { ctx, shot, out, now, pitch, vel } = s;

    // 1) 咕叽：共振低通由 ~700Hz 下扫
    const sqDur = rnd(0.1, 0.15);
    const sq = this.noiseSource(ctx, shot, s.pink, now, sqDur + 0.03);
    const sqLP = this.filt(ctx, shot, 'lowpass', 700 * pitch * rnd(0.9, 1.1), 4 + wet * 6, now);
    sqLP.frequency.exponentialRampToValueAtTime(240 * pitch, now + sqDur * 0.8);
    const sqG = this.amp(ctx, shot, 0.0001, now);
    this.perc(sqG.gain, now, 0.32 * vel, 0.006, sqDur);
    sq.connect(sqLP);
    sqLP.connect(sqG);
    sqG.connect(out);

    // 2) 拔脚吸吮：带通由低向高上扫
    const suT = now + rnd(0.07, 0.11);
    const su = this.noiseSource(ctx, shot, s.white, suT, 0.1);
    const suBP = this.filt(ctx, shot, 'bandpass', 350 * pitch, 3 + wet * 4, suT);
    suBP.frequency.exponentialRampToValueAtTime(1200 * pitch * rnd(0.85, 1.15), suT + 0.08);
    const suG = this.amp(ctx, shot, 0.0001, suT);
    this.perc(suG.gain, suT, 0.09 * vel * (0.35 + wet), 0.01, 0.07);
    su.connect(suBP);
    suBP.connect(suG);
    suG.connect(out);

    // 3) 低频闷踏
    const th = this.oscSource(ctx, shot, 'sine', 75 * pitch, now, now + 0.11);
    th.frequency.exponentialRampToValueAtTime(42, now + 0.09);
    const thG = this.amp(ctx, shot, 0.0001, now);
    this.perc(thG.gain, now, 0.05 * vel, 0.004, 0.08);
    th.connect(thG);
    thG.connect(out);
  }

  /** 碎石脚步：一条噪声声源 + 增益上的 6–11 个毫秒级颗粒尖峰（顺序排布不重叠）+ 低频碾压体 */
  private stepGravel(s: StepCtx) {
    const { ctx, shot, out, now, pitch, vel } = s;

    // 1) 颗粒碰撞串
    const gDur = 0.16;
    const gr = this.noiseSource(ctx, shot, s.white, now, gDur);
    const bp = this.filt(ctx, shot, 'bandpass', 2600 * pitch * rnd(0.85, 1.15), 0.9, now);
    const hp = this.filt(ctx, shot, 'highpass', 900, 0.6, now);
    const g = this.amp(ctx, shot, 0.0001, now);
    let t = now + rnd(0, 0.006);
    const grains = 6 + Math.floor(Math.random() * 6);
    for (let i = 0; i < grains && t < now + gDur - 0.015; i++) {
      const d = rnd(0.004, 0.009);
      this.perc(g.gain, t, vel * rnd(0.1, 0.25) * (i < 3 ? 1 : 0.7), 0.0012, d);
      t += 0.0012 + Math.max(0.005, d) + rnd(0.0, 0.008);
    }
    gr.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(out);

    // 2) 碾压体
    const cr = this.noiseSource(ctx, shot, s.pink, now, 0.1);
    const lp = this.filt(ctx, shot, 'lowpass', 520 * pitch * rnd(0.85, 1.15), 0.9, now);
    const cg = this.amp(ctx, shot, 0.0001, now);
    this.perc(cg.gain, now, 0.25 * vel, 0.005, 0.07);
    cr.connect(lp);
    lp.connect(cg);
    cg.connect(out);
  }

  // ═══════════════════════════ 战斗与交互 ═══════════════════════════

  /**
   * 挥击破空：粉噪带通的中心频率"先升后降"（武器掠近耳边时最快最亮 → 远离变暗，多普勒感），
   * 振幅在最快处达峰；叠加窄带"咻"哨音沿同一曲线、起手衣袖摩擦、声像从一侧掠到另一侧（左右交替）。
   * 重击：更长更低更厚 + 推开空气的低频"轰" + 发力胸腔闷压
   */
  playChargeSwing(heavy: boolean) {
    const ctx = this.ctx;
    const master = this.masterGain;
    const pink = this.pinkBuf;
    const white = this.whiteBuf;
    if (!ctx || !master || !pink || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const bus: AudioNode = this.nearBus ?? master;
    const jit = rnd(0.92, 1.08);
    if (heavy) this.lastHeavySwingAt = now;
    this.swingSide = -this.swingSide;
    const dur = heavy ? rnd(0.36, 0.42) : rnd(0.2, 0.25);
    const peakT = now + dur * (heavy ? 0.45 : 0.4);
    const end = now + dur;

    const out = this.amp(ctx, shot, 1, now);
    if (typeof ctx.createStereoPanner === 'function') {
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(-0.45 * this.swingSide, now);
      p.pan.linearRampToValueAtTime(0.5 * this.swingSide, end);
      out.connect(p);
      p.connect(bus);
    } else {
      out.connect(bus);
    }

    // 1. 破空主体
    const f0 = (heavy ? 300 : 520) * jit;
    const fPk = (heavy ? 900 : 1500) * jit;
    const fEnd = (heavy ? 160 : 300) * jit;
    const src = this.noiseSource(ctx, shot, pink, now, dur + 0.05);
    const bp = this.filt(ctx, shot, 'bandpass', f0, heavy ? 1.1 : 1.5, now);
    bp.frequency.exponentialRampToValueAtTime(fPk, peakT);
    bp.frequency.exponentialRampToValueAtTime(fEnd, end);
    const g = this.amp(ctx, shot, 0.0001, now);
    const pk = heavy ? 0.36 : 0.24;
    g.gain.exponentialRampToValueAtTime(pk * 0.22, now + (peakT - now) * 0.55);
    g.gain.exponentialRampToValueAtTime(pk, peakT);
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.02);
    src.connect(bp);
    bp.connect(g);
    g.connect(out);

    // 2. "咻"哨音：窄带通沿同一多普勒曲线
    const ws = this.noiseSource(ctx, shot, white, now, dur + 0.05);
    const wbp = this.filt(ctx, shot, 'bandpass', f0 * 2.4, 8, now);
    wbp.frequency.exponentialRampToValueAtTime(fPk * 2.2, peakT);
    wbp.frequency.exponentialRampToValueAtTime(fEnd * 2.6, end);
    const wg = this.amp(ctx, shot, 0.0001, now);
    wg.gain.exponentialRampToValueAtTime(heavy ? 0.12 : 0.1, peakT);
    wg.gain.exponentialRampToValueAtTime(0.0001, end);
    ws.connect(wbp);
    wbp.connect(wg);
    wg.connect(out);

    // 3. 起手衣袖/手臂摩擦
    const cl = this.noiseSource(ctx, shot, white, now, 0.12);
    const cbp = this.filt(ctx, shot, 'bandpass', rnd(2200, 3200), 0.9, now);
    const cg = this.amp(ctx, shot, 0.0001, now);
    this.perc(cg.gain, now, heavy ? 0.05 : 0.035, 0.012, 0.08);
    cl.connect(cbp);
    cbp.connect(cg);
    cg.connect(bus);

    if (heavy) {
      // 4. 推开空气的低频"轰"
      const sub = this.oscSource(ctx, shot, 'sine', 120 * jit, now, end + 0.05);
      sub.frequency.exponentialRampToValueAtTime(42, end);
      const sg = this.amp(ctx, shot, 0.0001, now);
      sg.gain.exponentialRampToValueAtTime(0.22, peakT);
      sg.gain.exponentialRampToValueAtTime(0.0001, end + 0.03);
      sub.connect(sg);
      sg.connect(out);
      // 5. 发力胸腔闷压
      const lt = Math.max(now, peakT - 0.06);
      const low = this.noiseSource(ctx, shot, pink, lt, 0.26);
      const llp = this.filt(ctx, shot, 'lowpass', 260, 0.9, lt);
      const lg = this.amp(ctx, shot, 0.0001, lt);
      this.perc(lg.gain, lt, 0.2, 0.04, 0.18);
      low.connect(llp);
      llp.connect(lg);
      lg.connect(bus);
    }
    shot.seal();
  }

  /**
   * 兼容旧接口：转发至 playChargeSwing
   */
  playSwing(heavy: boolean) {
    this.playChargeSwing(heavy);
  }

  /**
   * 闪避急退：身体位移带起的空气（带通先升后降的多普勒破风）+ 衣料翻飞（3–4 次快速抖动）+ 蹬地短闷声
   */
  playDodgeWhoosh() {
    const ctx = this.ctx;
    const master = this.masterGain;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !master || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const bus: AudioNode = this.nearBus ?? master;
    const dur = rnd(0.24, 0.29);
    const peakT = now + dur * 0.35;
    const end = now + dur;

    const src = this.noiseSource(ctx, shot, pink, now, dur + 0.04);
    const bp = this.filt(ctx, shot, 'bandpass', 700 * rnd(0.9, 1.1), 1.3, now);
    bp.frequency.exponentialRampToValueAtTime(1500 * rnd(0.9, 1.1), peakT);
    bp.frequency.exponentialRampToValueAtTime(320, end);
    const g = this.amp(ctx, shot, 0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.2, peakT);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(bp);
    bp.connect(g);
    g.connect(bus);

    const cl = this.noiseSource(ctx, shot, white, now, dur);
    const cbp = this.filt(ctx, shot, 'bandpass', rnd(2000, 3000), 0.9, now);
    const cg = this.amp(ctx, shot, 0.0001, now);
    let t = now + 0.005;
    const flaps = 3 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < flaps && t < end - 0.04; i++) {
      const d = rnd(0.025, 0.04);
      this.perc(cg.gain, t, 0.06 * (1 - i * 0.18) * rnd(0.7, 1), 0.006, d);
      t += 0.006 + d + rnd(0.006, 0.02);
    }
    cl.connect(cbp);
    cbp.connect(cg);
    cg.connect(bus);

    const kick = this.noiseSource(ctx, shot, pink, now, 0.1);
    const klp = this.filt(ctx, shot, 'lowpass', 420, 1, now);
    const kg = this.amp(ctx, shot, 0.0001, now);
    this.perc(kg.gain, now, 0.18, 0.003, 0.06);
    kick.connect(klp);
    klp.connect(kg);
    kg.connect(bus);
    shot.seal();
  }

  /**
   * 重型家具在旧木地板上拖拽时的低沉摩擦木响（内置 0.18s 节流避免高频堆叠）
   */
  playFurnitureDrag(speed01: number) {
    const ctx = this.ctx;
    const master = this.masterGain;
    const pink = this.pinkBuf;
    if (!ctx || !master || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    if (now - this.lastDragSoundAt < 0.18) return;
    this.lastDragSoundAt = now;

    const intensity = clamp(speed01, 0.15, 1);
    const pitch = 0.86 + Math.random() * 0.28;
    const shot = new OneShot();
    const bus: AudioNode = this.nearBus ?? master;

    // 1. 粗糙木地板摩擦噪声
    const src = this.noiseSource(ctx, shot, pink, now, 0.24);
    const bp = this.filt(ctx, shot, 'bandpass', (240 + intensity * 140) * pitch, 1.9, now);
    bp.frequency.linearRampToValueAtTime((180 + intensity * 90) * pitch, now + 0.21);
    const ng = this.amp(ctx, shot, 0.001, now);
    ng.gain.linearRampToValueAtTime(0.16 * intensity, now + 0.035);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(bus);

    // 2. 厚重木腿低频共鸣咯吱声
    const osc = this.oscSource(ctx, shot, 'triangle', 92 * pitch, now, now + 0.22);
    osc.frequency.exponentialRampToValueAtTime(58 * pitch, now + 0.19);
    const og = this.amp(ctx, shot, 0.001, now);
    og.gain.linearRampToValueAtTime(0.11 * intensity, now + 0.03);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    osc.connect(og);
    og.connect(bus);
    shot.seal();
  }

  /**
   * 门窗木板诡异刮擦声（供怪物 stalk 窥伺期与开局 6 秒钩子使用，支持立体声方位、距离混响与隔墙闷响）
   */
  playWoodScrape(spatial?: SpatialAudioOpts) {
    const ctx = this.ctx;
    const pink = this.pinkBuf;
    if (!ctx || !this.masterGain || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const scale = clamp(route.gainScale, 0.08, 1);
    const jitter = 0.9 + Math.random() * 0.22;

    // 1. 利爪/指甲划过潮湿旧木板的刺耳带通噪声
    const src = this.noiseSource(ctx, shot, pink, now, 0.62);
    const filter = this.filt(ctx, shot, 'bandpass', 980 * jitter, 4.2, now);
    filter.frequency.linearRampToValueAtTime(460 * jitter, now + 0.22);
    filter.frequency.linearRampToValueAtTime(820 * jitter, now + 0.42);
    filter.frequency.exponentialRampToValueAtTime(320 * jitter, now + 0.56);
    const ng = this.amp(ctx, shot, 0.001, now);
    ng.gain.linearRampToValueAtTime(0.24 * scale, now + 0.06);
    ng.gain.linearRampToValueAtTime(0.14 * scale, now + 0.28);
    ng.gain.linearRampToValueAtTime(0.2 * scale, now + 0.42);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.58);
    src.connect(filter);
    filter.connect(ng);
    ng.connect(route.input);

    // 2. 木板箱体低沉共鸣颤振
    const osc = this.oscSource(ctx, shot, 'sawtooth', 172 * jitter, now, now + 0.58);
    osc.frequency.exponentialRampToValueAtTime(118 * jitter, now + 0.54);
    const lfo = this.oscSource(ctx, shot, 'sine', 22 + Math.random() * 8, now, now + 0.58);
    const lfoG = this.amp(ctx, shot, 14, now);
    lfo.connect(lfoG);
    lfoG.connect(osc.frequency);
    const bodyFilter = this.filt(ctx, shot, 'bandpass', 310, 2.6, now);
    const og = this.amp(ctx, shot, 0.001, now);
    og.gain.linearRampToValueAtTime(0.12 * scale, now + 0.08);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.56);
    osc.connect(bodyFilter);
    bodyFilter.connect(og);
    og.connect(route.input);
    shot.seal();
  }

  /**
   * 撞击/破门/捕兽夹/近战命中音效（支持 2D 立体声方位、距离混响与隔墙低通衰减）
   */
  playImpact(kind: 'flesh' | 'wood' | 'metal', spatial?: SpatialAudioOpts) {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    if (!ctx || !this.masterGain || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const scale = clamp(route.gainScale, 0.08, 1);
    const jitter = 0.9 + Math.random() * 0.2;

    if (kind === 'flesh') {
      this.impactFlesh(ctx, shot, route.input, scale, now);
      shot.seal();
      return;
    }

    const startFreq = kind === 'metal' ? 620 : kind === 'wood' ? 210 : 140;
    const osc = this.oscSource(
      ctx,
      shot,
      kind === 'metal' ? 'square' : 'triangle',
      startFreq * jitter,
      now,
      now + 0.18
    );
    osc.frequency.exponentialRampToValueAtTime(kind === 'metal' ? 180 : 38, now + 0.14);
    const g = this.amp(ctx, shot, 0.001, now);
    g.gain.linearRampToValueAtTime((kind === 'metal' ? 0.18 : 0.28) * scale, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(g);
    g.connect(route.input);

    const src = this.noiseSource(ctx, shot, white, now, 0.13);
    const f = this.filt(
      ctx,
      shot,
      'bandpass',
      (kind === 'wood' ? 950 : kind === 'metal' ? 2200 : 520) * jitter,
      1,
      now
    );
    const ng = this.amp(ctx, shot, 0.001, now);
    ng.gain.linearRampToValueAtTime(0.22 * scale, now + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    src.connect(f);
    f.connect(ng);
    ng.connect(route.input);
    shot.seal();
  }

  /**
   * 肉体命中：低频下坠闷击 + 低通粉噪"噗" + 共振低通快速下扫的湿"啪叽" + 稍后的黏连声 + 皮肤拍击中频；
   * 克制的骨裂（重击必有、轻击 35%）：2–3 个极短高频裂纹 + 短促骨质"咔"，音量压低。
   * 0.6s 内刚播放过重击挥砍则整体更厚更重
   */
  private impactFlesh(ctx: AudioContext, shot: OneShot, out: AudioNode, scale: number, now: number) {
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!white || !pink) return;
    const heavy = now - this.lastHeavySwingAt < 0.6;
    const k = heavy ? 1.35 : 1;
    const pitch = rnd(0.9, 1.1);

    // 1. 闷击
    const th = this.oscSource(ctx, shot, 'sine', (heavy ? 95 : 120) * pitch, now, now + 0.22);
    th.frequency.exponentialRampToValueAtTime(40, now + 0.16);
    const thG = this.amp(ctx, shot, 0.0001, now);
    this.perc(thG.gain, now, 0.3 * k * scale, 0.003, heavy ? 0.17 : 0.12);
    th.connect(thG);
    thG.connect(out);
    const body = this.noiseSource(ctx, shot, pink, now, 0.16);
    const blp = this.filt(ctx, shot, 'lowpass', (heavy ? 420 : 600) * pitch, 1.2, now);
    const bg = this.amp(ctx, shot, 0.0001, now);
    this.perc(bg.gain, now, 0.4 * k * scale, 0.002, 0.09);
    body.connect(blp);
    blp.connect(bg);
    bg.connect(out);

    // 2. 湿"啪叽"与黏连
    const wt = now + 0.004;
    const wet = this.noiseSource(ctx, shot, white, wt, 0.12);
    const wlp = this.filt(ctx, shot, 'lowpass', rnd(1800, 2400), 7, wt);
    wlp.frequency.exponentialRampToValueAtTime(350, wt + 0.08);
    const wg = this.amp(ctx, shot, 0.0001, wt);
    this.perc(wg.gain, wt, 0.07 * k * scale, 0.002, 0.08);
    wet.connect(wlp);
    wlp.connect(wg);
    wg.connect(out);
    const st = now + rnd(0.04, 0.07);
    const sq = this.noiseSource(ctx, shot, pink, st, 0.09);
    const sbp = this.filt(ctx, shot, 'bandpass', 900, 4, st);
    sbp.frequency.exponentialRampToValueAtTime(500, st + 0.07);
    const sg = this.amp(ctx, shot, 0.0001, st);
    this.perc(sg.gain, st, 0.05 * scale * k, 0.01, 0.06);
    sq.connect(sbp);
    sbp.connect(sg);
    sg.connect(out);

    // 3. 皮肤拍击
    const sl = this.noiseSource(ctx, shot, white, now, 0.04);
    const slbp = this.filt(ctx, shot, 'bandpass', rnd(1100, 1600), 1, now);
    const slg = this.amp(ctx, shot, 0.0001, now);
    this.perc(slg.gain, now, 0.12 * scale * k, 0.001, 0.025);
    sl.connect(slbp);
    slbp.connect(slg);
    slg.connect(out);

    // 4. 克制的骨裂
    if (heavy || Math.random() < 0.35) {
      const ct = now + rnd(0.006, 0.02);
      const cr = this.noiseSource(ctx, shot, white, ct, 0.08);
      const cbp = this.filt(ctx, shot, 'bandpass', rnd(2600, 3600), 2.5, ct);
      const chp = this.filt(ctx, shot, 'highpass', 1500, 0.6, ct);
      const crg = this.amp(ctx, shot, 0.0001, ct);
      let t = ct;
      const n = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const d = rnd(0.003, 0.007);
        this.perc(crg.gain, t, (heavy ? 0.07 : 0.045) * scale * rnd(0.6, 1), 0.0006, d);
        t += 0.0006 + Math.max(0.005, d) + rnd(0.004, 0.014);
      }
      cr.connect(cbp);
      cbp.connect(chp);
      chp.connect(crg);
      crg.connect(out);
      const bone = this.oscSource(ctx, shot, 'triangle', rnd(380, 520), ct, ct + 0.06);
      bone.frequency.exponentialRampToValueAtTime(260, ct + 0.05);
      const bnG = this.amp(ctx, shot, 0.0001, ct);
      this.perc(bnG.gain, ct, 0.03 * scale * (heavy ? 1.4 : 1), 0.001, 0.035);
      bone.connect(bnG);
      bnG.connect(out);
    }
  }

  /**
   * 翻找一次（0.3–0.5s）：
   *   wood  抽屉/木箱内物件碰撞——3–5 次木质"笃"（带通噪声 + 三角波木体）+ 一段木面刮擦
   *   metal 罐头/工具互碰——2–4 次非谐和金属"叮"（三分音衰减正弦）+ 碎屑沙沙
   *   cloth 布料翻动——6–10 个不规则"簌簌"起伏 + 低频布团闷擦
   * 走空间路由（方位 + 距离混响 + 隔墙）
   */
  playSearchRummage(kind: 'wood' | 'metal' | 'cloth', spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !this.masterGain || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const scale = clamp(route.gainScale, 0.08, 1);
    const out = route.input;
    const dur = rnd(0.3, 0.5);
    const end = now + dur;

    if (kind === 'cloth') {
      const src = this.noiseSource(ctx, shot, white, now, dur + 0.03);
      const bp = this.filt(ctx, shot, 'bandpass', rnd(1800, 2800), 0.8, now);
      bp.frequency.linearRampToValueAtTime(rnd(1200, 2200), end);
      const hp = this.filt(ctx, shot, 'highpass', 600, 0.6, now);
      const g = this.amp(ctx, shot, 0.0001, now);
      let t = now + 0.005;
      const n = 6 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n && t < end - 0.04; i++) {
        const at = rnd(0.008, 0.02);
        const d = rnd(0.025, 0.06);
        this.perc(g.gain, t, 0.09 * scale * rnd(0.4, 1), at, d);
        t += at + d + rnd(0.0, 0.025);
      }
      src.connect(bp);
      bp.connect(hp);
      hp.connect(g);
      g.connect(out);
      const low = this.noiseSource(ctx, shot, pink, now, dur + 0.03);
      const llp = this.filt(ctx, shot, 'lowpass', 700, 0.7, now);
      const lg = this.amp(ctx, shot, 0.0001, now);
      lg.gain.linearRampToValueAtTime(0.07 * scale, now + dur * 0.4);
      lg.gain.exponentialRampToValueAtTime(0.0001, end);
      low.connect(llp);
      llp.connect(lg);
      lg.connect(out);
    } else if (kind === 'wood') {
      const sc = this.noiseSource(ctx, shot, pink, now, dur + 0.03);
      const sbp = this.filt(ctx, shot, 'bandpass', rnd(500, 800), 2.5, now);
      sbp.frequency.linearRampToValueAtTime(rnd(380, 700), end);
      const sg = this.amp(ctx, shot, 0.0001, now);
      sg.gain.linearRampToValueAtTime(0.09 * scale, now + dur * 0.35);
      sg.gain.linearRampToValueAtTime(0.04 * scale, now + dur * 0.7);
      sg.gain.exponentialRampToValueAtTime(0.0001, end);
      sc.connect(sbp);
      sbp.connect(sg);
      sg.connect(out);

      const kn = this.noiseSource(ctx, shot, white, now, dur + 0.03);
      const kbp = this.filt(ctx, shot, 'bandpass', rnd(700, 1200), 3, now);
      const kg = this.amp(ctx, shot, 0.0001, now);
      const bodyOsc = this.oscSource(ctx, shot, 'triangle', 240, now, end + 0.05);
      const bodyG = this.amp(ctx, shot, 0.0001, now);
      let t = now + rnd(0.01, 0.05);
      const n = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n && t < end - 0.05; i++) {
        const a = scale * rnd(0.5, 1);
        this.perc(kg.gain, t, 0.16 * a, 0.001, rnd(0.02, 0.04));
        bodyOsc.frequency.setValueAtTime(rnd(180, 320), t);
        this.perc(bodyG.gain, t, 0.08 * a, 0.001, 0.05);
        t += rnd(0.06, 0.12);
      }
      kn.connect(kbp);
      kbp.connect(kg);
      kg.connect(out);
      bodyOsc.connect(bodyG);
      bodyG.connect(out);
    } else {
      const ra = this.noiseSource(ctx, shot, white, now, dur + 0.03);
      const rhp = this.filt(ctx, shot, 'highpass', 3000, 0.6, now);
      const rbp = this.filt(ctx, shot, 'bandpass', 5000, 1, now);
      const rg = this.amp(ctx, shot, 0.0001, now);
      rg.gain.linearRampToValueAtTime(0.03 * scale, now + dur * 0.3);
      rg.gain.exponentialRampToValueAtTime(0.0001, end);
      ra.connect(rhp);
      rhp.connect(rbp);
      rbp.connect(rg);
      rg.connect(out);

      const ratios = [1, 2.76, 5.4];
      const amps = [1, 0.5, 0.25];
      let t = now + rnd(0.01, 0.05);
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n && t < end - 0.05; i++) {
        const f = rnd(1400, 3200);
        const dec = rnd(0.05, 0.12);
        const a = 0.05 * scale * rnd(0.5, 1);
        for (let pI = 0; pI < ratios.length; pI++) {
          const pd = dec * (1 - pI * 0.25);
          const o = this.oscSource(ctx, shot, 'sine', Math.min(16000, f * ratios[pI]), t, t + pd + 0.02);
          const og = this.amp(ctx, shot, 0.0001, t);
          this.perc(og.gain, t, a * amps[pI], 0.0008, pd);
          o.connect(og);
          og.connect(out);
        }
        t += rnd(0.07, 0.14);
      }
    }
    shot.seal();
  }

  /**
   * 锤钉入木：2–3 锤（钉子越钉越深——钉帽"叮"变短变低、木板"咚"变实），每锤 = 锤面撞击瞬态 + 钉帽非谐和金属分音
   * + 木板带通共鸣与模态；16% 概率最后一锤打偏把钉子敲弯：钉身金属"嘣"的下滑音 + 刮擦
   */
  playHammerNail(spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !this.masterGain || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const scale = clamp(route.gainScale, 0.08, 1);
    const out = route.input;
    const strikes = 2 + (Math.random() < 0.55 ? 1 : 0);
    const bent = Math.random() < 0.16;
    const nailF = rnd(2600, 3400);
    const boardF = rnd(220, 320);
    let t = now + 0.005;

    for (let i = 0; i < strikes; i++) {
      const sink = i / Math.max(1, strikes - 1);
      const v = scale * rnd(0.85, 1.1);
      // 1) 锤面撞击瞬态
      const tr = this.noiseSource(ctx, shot, white, t, 0.02);
      const thp = this.filt(ctx, shot, 'highpass', 1800, 0.7, t);
      const tg = this.amp(ctx, shot, 0.0001, t);
      this.perc(tg.gain, t, 0.22 * v, 0.0005, 0.006);
      tr.connect(thp);
      thp.connect(tg);
      tg.connect(out);
      // 2) 钉帽金属"叮"
      const fN = nailF * (1 - sink * 0.12);
      const ratios = [1, 1.62, 2.9];
      const amps = [1, 0.45, 0.2];
      const baseDec = 0.09 - sink * 0.05;
      for (let pI = 0; pI < ratios.length; pI++) {
        const pd = Math.max(0.015, baseDec * (1 - pI * 0.3));
        const o = this.oscSource(ctx, shot, 'sine', Math.min(16000, fN * ratios[pI]), t, t + pd + 0.02);
        const og = this.amp(ctx, shot, 0.0001, t);
        this.perc(og.gain, t, 0.06 * v * amps[pI], 0.0008, pd);
        o.connect(og);
        og.connect(out);
      }
      // 3) 木板共鸣
      const wb = this.noiseSource(ctx, shot, pink, t, 0.26);
      const wbp = this.filt(ctx, shot, 'bandpass', boardF * rnd(0.95, 1.05), 3, t);
      const wbg = this.amp(ctx, shot, 0.0001, t);
      this.perc(wbg.gain, t, (0.25 + sink * 0.12) * v, 0.002, 0.16 + sink * 0.06);
      wb.connect(wbp);
      wbp.connect(wbg);
      wbg.connect(out);
      const wm = this.oscSource(ctx, shot, 'triangle', rnd(140, 190), t, t + 0.24);
      wm.frequency.exponentialRampToValueAtTime(120, t + 0.2);
      const wmg = this.amp(ctx, shot, 0.0001, t);
      this.perc(wmg.gain, t, 0.1 * v, 0.002, 0.2);
      wm.connect(wmg);
      wmg.connect(out);
      t += rnd(0.3, 0.42);
    }

    if (bent) {
      const tb = t + rnd(0.0, 0.05);
      const tr = this.noiseSource(ctx, shot, white, tb, 0.02);
      const thp = this.filt(ctx, shot, 'highpass', 1800, 0.7, tb);
      const tg = this.amp(ctx, shot, 0.0001, tb);
      this.perc(tg.gain, tb, 0.2 * scale, 0.0005, 0.006);
      tr.connect(thp);
      thp.connect(tg);
      tg.connect(out);
      const bf = rnd(1500, 1900);
      const bo = this.oscSource(ctx, shot, 'triangle', bf, tb, tb + 0.3);
      bo.frequency.exponentialRampToValueAtTime(bf * 0.7, tb + 0.25);
      const bbp = this.filt(ctx, shot, 'bandpass', 1800, 4, tb);
      const bg = this.amp(ctx, shot, 0.0001, tb);
      this.perc(bg.gain, tb, 0.05 * scale, 0.003, 0.25);
      bo.connect(bbp);
      bbp.connect(bg);
      bg.connect(out);
      const b2 = this.oscSource(ctx, shot, 'sine', bf * 2.3, tb, tb + 0.16);
      b2.frequency.exponentialRampToValueAtTime(bf * 1.7, tb + 0.14);
      const b2g = this.amp(ctx, shot, 0.0001, tb);
      this.perc(b2g.gain, tb, 0.025 * scale, 0.002, 0.12);
      b2.connect(b2g);
      b2g.connect(out);
      const sc = this.noiseSource(ctx, shot, white, tb + 0.01, 0.14);
      const sbp = this.filt(ctx, shot, 'bandpass', 3500, 3, tb + 0.01);
      const sg = this.amp(ctx, shot, 0.0001, tb + 0.01);
      this.perc(sg.gain, tb + 0.01, 0.03 * scale, 0.01, 0.12);
      sc.connect(sbp);
      sbp.connect(sg);
      sg.connect(out);
    }
    shot.seal();
  }

  /**
   * 翻滚/扑跃落地：身体着地闷击（低频下坠正弦 + 低通粉噪）+ 翻滚衣料两段摩擦（肩→背）+ 表面材质：
   *   wood 木板"嘭"与偶发吱嘎 + 肘膝磕碰；mud 共振下扫"啪叽"+ 拔离吸吮 + 水花；gravel 碎石滑散颗粒串 + 碾压体
   */
  playDodgeLand(surface: 'wood' | 'mud' | 'gravel'): void {
    const ctx = this.ctx;
    const master = this.masterGain;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !master || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const bus: AudioNode = this.nearBus ?? master;
    const v = rnd(0.9, 1.1);
    const out = this.amp(ctx, shot, 1, now);
    if (typeof ctx.createStereoPanner === 'function') {
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(rnd(-0.12, 0.12), now);
      out.connect(p);
      p.connect(bus);
    } else {
      out.connect(bus);
    }

    // 1) 身体着地
    const th = this.oscSource(ctx, shot, 'sine', 85 * v, now, now + 0.18);
    th.frequency.exponentialRampToValueAtTime(38, now + 0.14);
    const thG = this.amp(ctx, shot, 0.0001, now);
    this.perc(thG.gain, now, 0.26 * v, 0.004, 0.15);
    th.connect(thG);
    thG.connect(out);
    const bd = this.noiseSource(ctx, shot, pink, now, 0.14);
    const blp = this.filt(ctx, shot, 'lowpass', 380, 1, now);
    const bg = this.amp(ctx, shot, 0.0001, now);
    this.perc(bg.gain, now, 0.42 * v, 0.003, 0.11);
    bd.connect(blp);
    blp.connect(bg);
    bg.connect(out);

    // 2) 翻滚衣料
    const cl = this.noiseSource(ctx, shot, white, now, 0.32);
    const cbp = this.filt(ctx, shot, 'bandpass', rnd(1600, 2200), 0.8, now);
    const cg = this.amp(ctx, shot, 0.0001, now);
    this.perc(cg.gain, now + 0.01, 0.06, 0.02, 0.09);
    this.perc(cg.gain, now + 0.14, 0.04, 0.03, 0.12);
    cl.connect(cbp);
    cbp.connect(cg);
    cg.connect(out);

    // 3) 表面材质
    if (surface === 'wood') {
      const wb = this.noiseSource(ctx, shot, pink, now, 0.24);
      const wbp = this.filt(ctx, shot, 'bandpass', rnd(150, 190), 2.5, now);
      const wg = this.amp(ctx, shot, 0.0001, now);
      this.perc(wg.gain, now, 0.35 * v, 0.003, 0.18);
      wb.connect(wbp);
      wbp.connect(wg);
      wg.connect(out);
      const kt = now + rnd(0.07, 0.11);
      const kn = this.noiseSource(ctx, shot, white, kt, 0.05);
      const kbp = this.filt(ctx, shot, 'bandpass', rnd(800, 1100), 2, kt);
      const kg = this.amp(ctx, shot, 0.0001, kt);
      this.perc(kg.gain, kt, 0.12 * v, 0.001, 0.03);
      kn.connect(kbp);
      kbp.connect(kg);
      kg.connect(out);
      if (this.creakBufs.length > 0 && Math.random() < 0.5) {
        const buf = this.creakBufs[Math.floor(Math.random() * this.creakBufs.length)];
        const rate = rnd(1.2, 1.9);
        const cDur = rnd(0.18, 0.3);
        const ct = now + rnd(0.04, 0.09);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.setValueAtTime(rate, ct);
        src.start(ct, Math.random() * Math.max(0, buf.duration - cDur * rate - 0.02));
        src.stop(ct + cDur);
        shot.src(src, ct + cDur);
        const crbp = this.filt(ctx, shot, 'bandpass', 760 * rnd(0.85, 1.2), 4, ct);
        const crg = this.amp(ctx, shot, 0.0001, ct);
        crg.gain.linearRampToValueAtTime(0.09, ct + 0.03);
        crg.gain.exponentialRampToValueAtTime(0.0001, ct + cDur);
        src.connect(crbp);
        crbp.connect(crg);
        crg.connect(out);
      }
    } else if (surface === 'mud') {
      const sq = this.noiseSource(ctx, shot, pink, now, 0.24);
      const slp = this.filt(ctx, shot, 'lowpass', 800, 8, now);
      slp.frequency.exponentialRampToValueAtTime(220, now + 0.18);
      const sg = this.amp(ctx, shot, 0.0001, now);
      this.perc(sg.gain, now, 0.35 * v, 0.006, 0.18);
      sq.connect(slp);
      slp.connect(sg);
      sg.connect(out);
      const su = now + rnd(0.14, 0.2);
      const sk = this.noiseSource(ctx, shot, white, su, 0.14);
      const sbp = this.filt(ctx, shot, 'bandpass', 400, 5, su);
      sbp.frequency.exponentialRampToValueAtTime(1300, su + 0.1);
      const skg = this.amp(ctx, shot, 0.0001, su);
      this.perc(skg.gain, su, 0.1 * v, 0.012, 0.09);
      sk.connect(sbp);
      sbp.connect(skg);
      skg.connect(out);
      const sp = this.noiseSource(ctx, shot, white, now + 0.005, 0.1);
      const shp = this.filt(ctx, shot, 'highpass', 2500, 0.7, now);
      const spg = this.amp(ctx, shot, 0.0001, now + 0.005);
      this.perc(spg.gain, now + 0.005, 0.06 * (0.4 + this.wetMemory * 0.6), 0.003, 0.07);
      sp.connect(shp);
      shp.connect(spg);
      spg.connect(out);
    } else {
      const gDur = 0.32;
      const gr = this.noiseSource(ctx, shot, white, now, gDur);
      const gbp = this.filt(ctx, shot, 'bandpass', rnd(2200, 2800), 0.9, now);
      const ghp = this.filt(ctx, shot, 'highpass', 900, 0.6, now);
      const gg = this.amp(ctx, shot, 0.0001, now);
      let t = now + rnd(0, 0.006);
      const grains = 12 + Math.floor(Math.random() * 9);
      for (let i = 0; i < grains && t < now + gDur - 0.015; i++) {
        const d = rnd(0.004, 0.01);
        const fade = 1 - (t - now) / gDur;
        this.perc(gg.gain, t, v * rnd(0.08, 0.22) * (0.35 + 0.65 * fade), 0.0012, d);
        t += 0.0012 + Math.max(0.005, d) + rnd(0.0, 0.012);
      }
      gr.connect(gbp);
      gbp.connect(ghp);
      ghp.connect(gg);
      gg.connect(out);
      const cr = this.noiseSource(ctx, shot, pink, now, 0.14);
      const clp = this.filt(ctx, shot, 'lowpass', 600, 0.9, now);
      const crg = this.amp(ctx, shot, 0.0001, now);
      this.perc(crg.gain, now, 0.3 * v, 0.005, 0.1);
      cr.connect(clp);
      clp.connect(crg);
      crg.connect(out);
    }
    shot.seal();
  }

  playClick(on: boolean) {
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const osc = this.oscSource(ctx, shot, 'square', on ? 1450 : 980, now, now + 0.04);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.03);
    const g = this.amp(ctx, shot, 0.001, now);
    g.gain.linearRampToValueAtTime(0.11, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    osc.connect(g);
    g.connect(this.nearBus ?? master);
    shot.seal();
  }

  playFlareHiss() {
    const ctx = this.ctx;
    const master = this.masterGain;
    const white = this.whiteBuf;
    if (!ctx || !master || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const src = this.noiseSource(ctx, shot, white, now, 0.6);
    const f = this.filt(ctx, shot, 'highpass', 1800, 0.7, now);
    const g = this.amp(ctx, shot, 0.001, now);
    g.gain.linearRampToValueAtTime(0.2, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    src.connect(f);
    f.connect(g);
    g.connect(this.nearBus ?? master);
    shot.seal();
  }

  /**
   * 怪物低吼：声门激励（锯齿基频 + 慢颤/粗糙抖动 + f0/2 次谐波 + 气声）
   * → 振幅撕裂抖动 → 三个并联共振峰带通（F1/F2/F3 随"张嘴"滑动）+ 胸腔低通
   * 远距离由空间路由自动加低通与更多混响；保留 StereoPanner 方位与隔墙闷化
   */
  playMonsterSnarl(proximity: number, spatial?: SpatialAudioOpts) {
    const ctx = this.ctx;
    if (!ctx || !this.masterGain || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const effectiveProx = spatial ? Math.max(proximity * 0.5, route.gainScale) : proximity;
    const vol = clamp(effectiveProx * 0.25, 0.04, 0.25);
    const dur = clamp(0.48 + Math.random() * 0.34 + proximity * 0.12, 0.45, 0.95);
    const end = now + dur;
    const stopAt = end + 0.05;
    const f0 = rnd(68, 102);

    // —— 声门激励 ——
    const glottis = this.oscSource(ctx, shot, 'sawtooth', f0 * rnd(1.05, 1.18), now, stopAt);
    glottis.frequency.linearRampToValueAtTime(f0, now + dur * 0.3);
    glottis.frequency.exponentialRampToValueAtTime(f0 * rnd(0.55, 0.7), end);

    // 喉部慢颤（5.5–9Hz）与粗糙抖动（24–38Hz）调制基频
    const vib = this.oscSource(ctx, shot, 'sine', rnd(5.5, 9), now, stopAt);
    const vibDepth = this.amp(ctx, shot, f0 * 0.05, now);
    vib.connect(vibDepth);
    vibDepth.connect(glottis.frequency);
    const rough = this.oscSource(ctx, shot, 'triangle', rnd(24, 38), now, stopAt);
    const roughDepth = this.amp(ctx, shot, f0 * 0.16, now);
    rough.connect(roughDepth);
    roughDepth.connect(glottis.frequency);

    // 次谐波 f0/2：胸腔"咕噜"感
    const sub = this.oscSource(ctx, shot, 'square', f0 * 0.5, now, stopAt);
    sub.frequency.exponentialRampToValueAtTime(f0 * 0.5 * 0.62, end);
    roughDepth.connect(sub.frequency);
    const subG = this.amp(ctx, shot, 0.32, now);
    sub.connect(subG);

    // 混合 + 振幅撕裂抖动（28–46Hz，模拟声带嘶裂）
    const mix = this.amp(ctx, shot, 0.65, now);
    const fry = this.oscSource(ctx, shot, 'sine', rnd(28, 46), now, stopAt);
    const fryDepth = this.amp(ctx, shot, 0.35, now);
    fry.connect(fryDepth);
    fryDepth.connect(mix.gain);
    glottis.connect(mix);
    subG.connect(mix);

    // 气声：粉噪带通 → 嘶哑喘息
    if (this.pinkBuf) {
      const breath = this.noiseSource(ctx, shot, this.pinkBuf, now, dur + 0.05);
      const breathBP = this.filt(ctx, shot, 'bandpass', rnd(1400, 2000), 0.9, now);
      const breathG = this.amp(ctx, shot, 0.9, now);
      breath.connect(breathBP);
      breathBP.connect(breathG);
      breathG.connect(mix);
    }

    // —— 声道共振峰（并联带通）+ 胸腔低通 ——
    const env = this.amp(ctx, shot, 0.0001, now);
    const formants: Array<{ f: number; q: number; g: number }> = [
      { f: rnd(380, 520), q: 6, g: 2.0 },
      { f: rnd(900, 1250), q: 8, g: 1.3 },
      { f: rnd(2250, 2700), q: 10, g: 0.6 },
    ];
    for (let i = 0; i < formants.length; i++) {
      const fm = formants[i];
      const bp = this.filt(ctx, shot, 'bandpass', fm.f * 0.85, fm.q, now);
      bp.frequency.linearRampToValueAtTime(fm.f * 1.08, now + dur * 0.35);
      bp.frequency.linearRampToValueAtTime(fm.f * 0.9, end);
      const fg = this.amp(ctx, shot, fm.g, now);
      mix.connect(bp);
      bp.connect(fg);
      fg.connect(env);
    }
    const chest = this.filt(ctx, shot, 'lowpass', 240, 0.7, now);
    const chestG = this.amp(ctx, shot, 0.22, now);
    mix.connect(chest);
    chest.connect(chestG);
    chestG.connect(env);

    env.gain.linearRampToValueAtTime(vol, now + 0.05);
    env.gain.linearRampToValueAtTime(vol * 0.8, now + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.connect(route.input);
    shot.seal();
  }

  /**
   * 【新增】怪物脚步：重型（低频闷踏 + 体重下沉）/ 猎犬（轻快踏地 + 爪尖碎响），走空间路由（方位 + 距离混响 + 隔墙）
   * 引擎目前未调用，可在怪物 stepTimer 触发处（与声波涟漪同处）接入
   */
  playCreatureStep(heavy: boolean, spatial?: SpatialAudioOpts) {
    const ctx = this.ctx;
    const pink = this.pinkBuf;
    const white = this.whiteBuf;
    if (!ctx || !this.masterGain || !pink || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const scale = clamp(route.gainScale, 0.06, 1);
    const pitch = rnd(0.88, 1.12);

    const th = this.noiseSource(ctx, shot, pink, now, 0.16);
    const lp = this.filt(ctx, shot, 'lowpass', (heavy ? 300 : 850) * pitch, 1.2, now);
    const tg = this.amp(ctx, shot, 0.0001, now);
    this.perc(tg.gain, now, (heavy ? 0.5 : 0.3) * scale, 0.005, heavy ? 0.13 : 0.07);
    th.connect(lp);
    lp.connect(tg);
    tg.connect(route.input);

    if (heavy) {
      const body = this.oscSource(ctx, shot, 'sine', 62 * pitch, now, now + 0.16);
      body.frequency.exponentialRampToValueAtTime(36, now + 0.14);
      const bg = this.amp(ctx, shot, 0.0001, now);
      this.perc(bg.gain, now, 0.14 * scale, 0.006, 0.12);
      body.connect(bg);
      bg.connect(route.input);
    } else {
      const ct = now + rnd(0.01, 0.03);
      const cl = this.noiseSource(ctx, shot, white, ct, 0.04);
      const bp = this.filt(ctx, shot, 'bandpass', 3000 * pitch, 2, ct);
      const cg = this.amp(ctx, shot, 0.0001, ct);
      this.perc(cg.gain, ct, 0.06 * scale, 0.001, 0.015);
      cl.connect(bp);
      bp.connect(cg);
      cg.connect(route.input);
    }
    shot.seal();
  }

  // ═══════════════════════════ 环境事件与叙事声（私有） ═══════════════════════════

  /** 树木吱嘎：吱嘎缓冲慢放（0.32–0.55x）成低沉树干呻吟，带通 + 远处出口 + 森林混响 */
  private playTreeCreak(pan: number, strength: number) {
    const ctx = this.ctx;
    if (!ctx || this.creakBufs.length === 0 || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const buf = this.creakBufs[Math.floor(Math.random() * this.creakBufs.length)];
    const rate = rnd(0.32, 0.55);
    const dur = Math.min(buf.duration / rate, 3.5);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.setValueAtTime(rate, now);
    src.start(now);
    src.stop(now + dur);
    shot.src(src, now + dur);

    const bp = this.filt(ctx, shot, 'bandpass', rnd(300, 520), 3, now);
    const g = this.amp(ctx, shot, 0.0001, now);
    const peak = 0.07 * clamp(strength, 0.2, 1);
    g.gain.linearRampToValueAtTime(peak, now + Math.min(0.3, dur * 0.25));
    g.gain.linearRampToValueAtTime(peak * 0.7, now + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    const o = this.distantOut(ctx, shot, pan, 1600, 0.5);
    src.connect(bp);
    bp.connect(g);
    g.connect(o.input);
    shot.seal();
  }

  /**
   * 远处枝断：一次尖锐主裂 + 3–7 次木纤维撕裂余响（单声源 + 增益尖峰串）+ 低频木体
   * far 越大越闷越湿
   */
  private playBranchSnap(pan: number, far: number, level: number) {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const f = clamp(far, 0, 1);
    const o = this.distantOut(ctx, shot, pan, 5200 - f * 3400, 0.4 + f * 0.3);
    const vol = 0.07 * clamp(level, 0.1, 1) * (1 - f * 0.45);

    const dur = 0.36;
    const src = this.noiseSource(ctx, shot, white, now, dur);
    const bp = this.filt(ctx, shot, 'bandpass', rnd(1800, 3200), 1.2, now);
    const g = this.amp(ctx, shot, 0.0001, now);
    let t = now + 0.004;
    this.perc(g.gain, t, vol, 0.001, 0.012);
    t += 0.013 + rnd(0.01, 0.03);
    const splinters = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < splinters && t < now + dur - 0.02; i++) {
      const d = rnd(0.003, 0.01);
      this.perc(g.gain, t, vol * rnd(0.15, 0.5), 0.001, d);
      t += 0.001 + d + rnd(0.008, 0.045);
    }
    src.connect(bp);
    bp.connect(g);
    g.connect(o.input);

    const body = this.noiseSource(ctx, shot, pink, now, 0.08);
    const lp = this.filt(ctx, shot, 'lowpass', 420, 1.4, now);
    const bg = this.amp(ctx, shot, 0.0001, now);
    this.perc(bg.gain, now + 0.004, vol * 2.2, 0.002, 0.04);
    body.connect(lp);
    lp.connect(bg);
    bg.connect(o.input);
    shot.seal();
  }

  /**
   * 屋檐/叶面滴水：音高上滑的水泡"叮"或落在窗台木头上的短促"嗒"
   * 室内走近身总线（木屋混响），室外走远处出口
   */
  private playEaveDrip(indoor: boolean) {
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const pan = randomPan(0.85);

    let input: AudioNode;
    if (indoor) {
      const g = this.amp(ctx, shot, 1, now);
      if (typeof ctx.createStereoPanner === 'function') {
        const p = shot.add(ctx.createStereoPanner());
        p.pan.setValueAtTime(pan, now);
        g.connect(p);
        p.connect(this.nearBus ?? master);
      } else {
        g.connect(this.nearBus ?? master);
      }
      input = g;
    } else {
      input = this.distantOut(ctx, shot, pan, 6000, 0.25).input;
    }

    const onWood = Math.random() < 0.4;
    const fq = onWood ? rnd(400, 700) : rnd(900, 2200);
    const dur = onWood ? 0.035 : 0.07;
    const osc = this.oscSource(ctx, shot, 'sine', fq, now, now + dur + 0.02);
    if (!onWood) osc.frequency.exponentialRampToValueAtTime(fq * rnd(1.4, 1.8), now + 0.03);
    const g = this.amp(ctx, shot, 0.0001, now);
    this.perc(g.gain, now, (indoor ? 0.045 : 0.03) * rnd(0.6, 1.1), 0.002, dur);
    osc.connect(g);
    g.connect(input);
    shot.seal();
  }

  /**
   * 乌鸦"嘎"声核心：锯齿声门 + 方波粗糙调幅（60–120Hz）+ 带通噪声嘶哑 → 三共振峰（F1/F2/F3）；
   * 每声独立的音高拱形（先升后坠）、时长与力度，末声常略低；受惊（urgent）时更高、更短、更急、更糙。返回结束时刻
   */
  private crowCawCore(
    ctx: AudioContext,
    shot: OneShot,
    out: AudioNode,
    t0: number,
    vol: number,
    urgent: boolean,
    caws: number
  ): number {
    const base = urgent ? rnd(640, 820) : rnd(470, 640);
    const n = Math.max(1, Math.floor(caws));
    const plan: Array<{ t: number; d: number; f: number; a: number }> = [];
    let t = t0;
    for (let i = 0; i < n; i++) {
      const d = urgent ? rnd(0.09, 0.16) : rnd(0.17, 0.3);
      const last = i === n - 1 && n > 1 && !urgent;
      plan.push({ t, d, f: base * rnd(0.92, 1.08) * (last ? rnd(0.86, 0.96) : 1), a: i === 0 ? 1 : rnd(0.7, 1) });
      t += d + (urgent ? rnd(0.05, 0.12) : rnd(0.16, 0.34));
    }
    const end = t + 0.05;

    const osc = this.oscSource(ctx, shot, 'sawtooth', base, t0, end);
    const am = this.oscSource(ctx, shot, 'square', urgent ? rnd(85, 120) : rnd(60, 92), t0, end);
    const amDepth = this.amp(ctx, shot, urgent ? 0.55 : 0.42, t0);
    const amG = this.amp(ctx, shot, 0.55, t0);
    am.connect(amDepth);
    amDepth.connect(amG.gain);
    osc.connect(amG);
    const exc = this.amp(ctx, shot, 1, t0);
    amG.connect(exc);
    if (this.whiteBuf) {
      const nz = this.noiseSource(ctx, shot, this.whiteBuf, t0, end - t0);
      const nbp = this.filt(ctx, shot, 'bandpass', rnd(1500, 2200), 1.2, t0);
      const ng = this.amp(ctx, shot, urgent ? 0.5 : 0.35, t0);
      nz.connect(nbp);
      nbp.connect(ng);
      ng.connect(exc);
    }

    const env = this.amp(ctx, shot, 0.0001, t0);
    for (let i = 0; i < plan.length; i++) {
      const c = plan[i];
      osc.frequency.setValueAtTime(c.f * 0.9, c.t);
      osc.frequency.linearRampToValueAtTime(c.f * 1.1, c.t + c.d * 0.3);
      osc.frequency.exponentialRampToValueAtTime(c.f * 0.78, c.t + c.d);
      env.gain.setValueAtTime(0.0001, c.t);
      env.gain.linearRampToValueAtTime(Math.max(0.0002, vol * c.a), c.t + 0.018);
      env.gain.linearRampToValueAtTime(Math.max(0.0002, vol * c.a * 0.75), c.t + c.d * 0.7);
      env.gain.exponentialRampToValueAtTime(0.0001, c.t + c.d);
    }
    const formants: Array<{ f: number; q: number; g: number }> = [
      { f: rnd(1050, 1350), q: 3, g: 1 },
      { f: rnd(1900, 2400), q: 4, g: 0.7 },
      { f: rnd(3000, 3500), q: 5, g: 0.35 },
    ];
    for (let i = 0; i < formants.length; i++) {
      const fm = formants[i];
      const bp = this.filt(ctx, shot, 'bandpass', fm.f, fm.q, t0);
      const fg = this.amp(ctx, shot, fm.g, t0);
      exc.connect(bp);
      bp.connect(fg);
      fg.connect(env);
    }
    env.connect(out);
    return end;
  }

  /** 白天远处鸦鸣（环境叙事用）：同一嘎声核心，经远处出口（重度空气吸收 + 森林混响） */
  private playCrowCall(pan: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const o = this.distantOut(ctx, shot, pan, rnd(2200, 3500), 0.55);
    this.crowCawCore(ctx, shot, o.input, now + 0.05, rnd(0.035, 0.055), false, 2 + Math.floor(Math.random() * 3));
    shot.seal();
  }

  /**
   * 单只乌鸦 2–4 声嘶哑"嘎"（每次随机）；urgent = true 为受惊急叫。
   * 传入 spatial 走空间路由；省略时随机方位、中远距离
   */
  playCrowCaw(spatial?: SpatialAudioOpts, urgent = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.masterGain || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    let out: AudioNode;
    let vol: number;
    if (spatial) {
      const route = this.createSpatialRoute(spatial);
      shot.addAll(route.nodes);
      out = route.input;
      vol = 0.075 * clamp(route.gainScale, 0.06, 1) * (urgent ? 1.2 : 1);
    } else {
      out = this.distantOut(ctx, shot, randomPan(0.9), rnd(2600, 4200), 0.45).input;
      vol = (urgent ? 0.06 : 0.048) * rnd(0.8, 1.1);
    }
    this.crowCawCore(ctx, shot, out, now + 0.02, vol, urgent, 2 + Math.floor(Math.random() * 3));
    shot.seal();
  }

  /**
   * 一群乌鸦起飞（count 取 1–8）：每只翅膀拍打为低通粉噪脉冲串（拍频 6–9Hz 随机，头几下最用力），
   * 低通截止与幅度随时间下滑（逐渐远去变弱变闷），各自声像向一侧散开；起飞瞬间羽毛摩擦；若干受惊急叫
   */
  playCrowTakeoff(count: number, spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const pink = this.pinkBuf;
    const white = this.whiteBuf;
    if (!ctx || !this.masterGain || !pink || !white || this.muted || this.pageHidden) return;
    const n = clamp(Math.round(Number.isFinite(count) ? count : 1), 1, 8);
    const now = ctx.currentTime;
    const shot = new OneShot();
    let out: AudioNode;
    let scale: number;
    if (spatial) {
      const route = this.createSpatialRoute(spatial);
      shot.addAll(route.nodes);
      out = route.input;
      scale = clamp(route.gainScale, 0.06, 1);
    } else {
      out = this.distantOut(ctx, shot, randomPan(0.8), 7000, 0.3).input;
      scale = 0.55;
    }
    const hasPan = typeof ctx.createStereoPanner === 'function';
    const norm = 1 / Math.sqrt(n * 0.6 + 0.4);

    for (let b = 0; b < n; b++) {
      const t0 = now + (b === 0 ? 0.005 : rnd(0.02, 0.45));
      const dur = rnd(1.3, 2.3);
      const end = t0 + dur;
      const rate = rnd(6, 9);
      let tail: AudioNode = out;
      if (hasPan) {
        const p = shot.add(ctx.createStereoPanner());
        const dir = Math.random() < 0.5 ? -1 : 1;
        p.pan.setValueAtTime(rnd(-0.25, 0.25), t0);
        p.pan.linearRampToValueAtTime(dir * rnd(0.4, 0.85), end);
        p.connect(out);
        tail = p;
      }
      const src = this.noiseSource(ctx, shot, pink, t0, dur + 0.05, rnd(0.9, 1.1));
      const hp = this.filt(ctx, shot, 'highpass', 90, 0.6, t0);
      const lp = this.filt(ctx, shot, 'lowpass', rnd(1300, 1900), 0.9, t0);
      lp.frequency.exponentialRampToValueAtTime(rnd(320, 480), end);
      const g = this.amp(ctx, shot, 0.0001, t0);
      const peak0 = 0.2 * scale * rnd(0.75, 1.1) * norm;
      let t = t0;
      let k = 0;
      while (t < end - 0.12) {
        const prog = (t - t0) / dur;
        const a = peak0 * Math.exp(-2.6 * prog) * (k < 3 ? 1.25 : rnd(0.75, 1));
        const period = 1 / (rate * (k < 3 ? 0.85 : 1) * rnd(0.95, 1.05));
        this.perc(g.gain, t, Math.max(0.0003, a), 0.012, period * 0.45);
        t += period;
        k++;
      }
      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(tail);

      const fr = this.noiseSource(ctx, shot, white, t0, 0.7);
      const fbp = this.filt(ctx, shot, 'bandpass', rnd(2800, 4200), 1.4, t0);
      const fg = this.amp(ctx, shot, 0.0001, t0);
      fg.gain.linearRampToValueAtTime(Math.max(0.0002, peak0 * 0.18), t0 + 0.06);
      fg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.65);
      fr.connect(fbp);
      fbp.connect(fg);
      fg.connect(tail);
    }

    const callers = Math.min(n, 1 + Math.floor(Math.random() * Math.ceil(n * 0.6)));
    for (let i = 0; i < callers; i++) {
      let co: AudioNode = out;
      if (hasPan) {
        const p = shot.add(ctx.createStereoPanner());
        p.pan.setValueAtTime(rnd(-0.5, 0.5), now);
        p.connect(out);
        co = p;
      }
      this.crowCawCore(ctx, shot, co, now + rnd(0.05, 0.9), 0.065 * scale * rnd(0.7, 1), true, 1 + Math.floor(Math.random() * 3));
    }
    shot.seal();
  }

  /** 白天远处鸦群：2–4 只在相近方位此起彼伏，各 1–3 声，极远、重混响 */
  private playCrowFlock(level: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const birds = 2 + Math.floor(Math.random() * 3);
    const center = randomPan(0.85);
    let t = now + 0.05;
    for (let b = 0; b < birds; b++) {
      const o = this.distantOut(ctx, shot, clamp(center + rnd(-0.3, 0.3), -0.95, 0.95), rnd(1600, 2600), 0.7);
      this.crowCawCore(ctx, shot, o.input, t, rnd(0.02, 0.034) * clamp(level, 0.2, 1), false, 1 + Math.floor(Math.random() * 3));
      t += rnd(0.3, 1.1);
    }
    shot.seal();
  }

  /** 远处啄木鸟：1–2 串 10–21 下 14–19Hz 的木质连击（带通噪声 + 三角波木体），每串渐弱渐慢 */
  private playWoodpecker(pan: number, level: number) {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    if (!ctx || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const o = this.distantOut(ctx, shot, pan, rnd(2400, 3800), 0.65);
    const vol = rnd(0.08, 0.12) * clamp(level, 0.2, 1);
    const plan: Array<{ t: number; a: number }> = [];
    let t = now + 0.05;
    const rolls = Math.random() < 0.45 ? 2 : 1;
    for (let r = 0; r < rolls; r++) {
      const n = 10 + Math.floor(Math.random() * 12);
      const rate = rnd(14, 19);
      let tt = t;
      for (let i = 0; i < n; i++) {
        plan.push({ t: tt, a: vol * (1 - (0.5 * i) / n) * rnd(0.8, 1) });
        tt += (1 / rate) * (1 + i * 0.012);
      }
      t = tt + rnd(0.9, 1.6);
    }
    const end = plan[plan.length - 1].t + 0.1;
    const src = this.noiseSource(ctx, shot, white, now, end - now);
    const bp = this.filt(ctx, shot, 'bandpass', rnd(900, 1400), 5, now);
    const g = this.amp(ctx, shot, 0.0001, now);
    const body = this.oscSource(ctx, shot, 'triangle', rnd(480, 700), now, end);
    const bg = this.amp(ctx, shot, 0.0001, now);
    for (let i = 0; i < plan.length; i++) {
      this.perc(g.gain, plan[i].t, plan[i].a, 0.001, 0.022);
      this.perc(bg.gain, plan[i].t, plan[i].a * 0.25, 0.001, 0.03);
    }
    src.connect(bp);
    bp.connect(g);
    g.connect(o.input);
    body.connect(bg);
    bg.connect(o.input);
    shot.seal();
  }

  /** 偶发飞虫掠过：锯齿嗡鸣 + 快速颤音，声像从一侧扫到另一侧，音高"先高后低"（多普勒） */
  private playInsectPass(level: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const dur = rnd(1.4, 2.6);
    const t0 = now + 0.02;
    const end = t0 + dur;
    const from = randomPan(0.9);
    const o = this.distantOut(ctx, shot, from, 5000, 0.15);
    if (o.pan) o.pan.linearRampToValueAtTime(clamp(-from * rnd(0.6, 1), -0.95, 0.95), end);
    const f = rnd(165, 235);
    const osc = this.oscSource(ctx, shot, 'sawtooth', f * 1.05, t0, end + 0.02);
    osc.frequency.linearRampToValueAtTime(f * 1.03, t0 + dur * 0.45);
    osc.frequency.linearRampToValueAtTime(f * 0.94, t0 + dur * 0.6);
    osc.frequency.linearRampToValueAtTime(f * 0.93, end);
    const vib = this.oscSource(ctx, shot, 'sine', rnd(9, 15), t0, end + 0.02);
    const vd = this.amp(ctx, shot, f * 0.03, t0);
    vib.connect(vd);
    vd.connect(osc.frequency);
    const hp = this.filt(ctx, shot, 'highpass', 300, 0.6, t0);
    const bp = this.filt(ctx, shot, 'bandpass', rnd(700, 1100), 1.3, t0);
    const env = this.amp(ctx, shot, 0.0001, t0);
    const vol = rnd(0.012, 0.02) * clamp(level, 0.2, 1);
    env.gain.linearRampToValueAtTime(vol * 0.3, t0 + dur * 0.25);
    env.gain.linearRampToValueAtTime(vol, t0 + dur * 0.5);
    env.gain.linearRampToValueAtTime(vol * 0.3, t0 + dur * 0.78);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(hp);
    hp.connect(bp);
    bp.connect(env);
    env.connect(o.input);
    shot.seal();
  }

  /** 黄昏/雨夜蛙鸣：一只 3–8 声"咯咯"，每声为 3–5 个 26–40Hz 脉冲（锯齿 → 两个共振带通） */
  private playFrogs(pan: number, level: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const o = this.distantOut(ctx, shot, pan, rnd(1400, 2400), 0.5);
    const f0 = rnd(105, 180);
    const pr = rnd(26, 40);
    const croaks = 3 + Math.floor(Math.random() * 6);
    const pulses: Array<{ t: number; a: number }> = [];
    let t = now + rnd(0.05, 0.6);
    for (let c = 0; c < croaks; c++) {
      const k = 3 + Math.floor(Math.random() * 3);
      const a = rnd(0.7, 1);
      for (let j = 0; j < k; j++) pulses.push({ t: t + j / pr, a: a * (j === 0 ? 0.8 : 1) });
      t += k / pr + rnd(0.3, 0.75);
    }
    const end = t;
    const osc = this.oscSource(ctx, shot, 'sawtooth', f0, now, end);
    const bp1 = this.filt(ctx, shot, 'bandpass', rnd(450, 750), 4, now);
    const bp2 = this.filt(ctx, shot, 'bandpass', rnd(1200, 1700), 5, now);
    const g2 = this.amp(ctx, shot, 0.45, now);
    const env = this.amp(ctx, shot, 0.0001, now);
    const vol = rnd(0.05, 0.08) * clamp(level, 0.2, 1);
    for (let i = 0; i < pulses.length; i++) {
      this.perc(env.gain, pulses[i].t, vol * pulses[i].a, 0.003, (1 / pr) * 0.55);
    }
    osc.connect(bp1);
    osc.connect(bp2);
    bp1.connect(env);
    bp2.connect(g2);
    g2.connect(env);
    env.connect(o.input);
    shot.seal();
  }

  /** 夜晚猫头鹰："呼——  呼呼 呼——"/"呼……呼-呼呼——"两种节奏，低沉正弦 + 少量 2 次谐波 + 气声，轻柔起音、强混响 */
  private playOwl(pan: number, level: number) {
    const ctx = this.ctx;
    const pink = this.pinkBuf;
    if (!ctx || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const o = this.distantOut(ctx, shot, pan, rnd(1100, 1600), 0.75);
    const f = rnd(320, 400);
    const patA: Array<[number, number]> = [[0, 0.42], [0.62, 0.16], [0.86, 0.16], [1.12, 0.55]];
    const patB: Array<[number, number]> = [[0, 0.5], [1.1, 0.14], [1.3, 0.14], [1.5, 0.8]];
    const pat = Math.random() < 0.5 ? patA : patB;
    const t0 = now + 0.05;
    const last = pat[pat.length - 1];
    const end = t0 + last[0] + last[1] + 0.05;
    const osc = this.oscSource(ctx, shot, 'sine', f, t0, end);
    const h2 = this.oscSource(ctx, shot, 'sine', f * 2, t0, end);
    const h2g = this.amp(ctx, shot, 0.12, t0);
    const br = this.noiseSource(ctx, shot, pink, t0, end - t0);
    const brbp = this.filt(ctx, shot, 'bandpass', f * 2.2, 2, t0);
    const brg = this.amp(ctx, shot, 1.2, t0);
    const env = this.amp(ctx, shot, 0.0001, t0);
    const vol = rnd(0.03, 0.045) * clamp(level, 0.2, 1);
    for (let i = 0; i < pat.length; i++) {
      const t = t0 + pat[i][0];
      const d = pat[i][1];
      osc.frequency.setValueAtTime(f * 1.03, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.93, t + d);
      h2.frequency.setValueAtTime(f * 2.06, t);
      h2.frequency.exponentialRampToValueAtTime(f * 1.86, t + d);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(vol, t + d * 0.35);
      env.gain.linearRampToValueAtTime(vol * 0.75, t + d * 0.75);
      env.gain.exponentialRampToValueAtTime(0.0001, t + d);
    }
    osc.connect(env);
    h2.connect(h2g);
    h2g.connect(env);
    br.connect(brbp);
    brbp.connect(brg);
    brg.connect(env);
    env.connect(o.input);
    shot.seal();
  }

  /** 远处狼嚎般长音：锯齿 + 三角双源、慢颤音，音高缓升—持平—下坠，共振峰随"张嘴"滑动；极远、强混响 */
  private playHowl(pan: number, level: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const dur = rnd(2.6, 4.0);
    const t0 = now + 0.05;
    const end = t0 + dur;
    const o = this.distantOut(ctx, shot, pan, rnd(900, 1400), 0.9);
    const f0 = rnd(250, 330);
    const a = this.oscSource(ctx, shot, 'sawtooth', f0 * 0.7, t0, end + 0.05);
    const b = this.oscSource(ctx, shot, 'triangle', f0 * 0.7 * 1.006, t0, end + 0.05);
    const oscs = [a, b];
    const muls = [1, 1.006];
    for (let i = 0; i < oscs.length; i++) {
      const fr = oscs[i].frequency;
      const m = muls[i];
      fr.exponentialRampToValueAtTime(f0 * m, t0 + dur * 0.28);
      fr.linearRampToValueAtTime(f0 * 1.03 * m, t0 + dur * 0.7);
      fr.exponentialRampToValueAtTime(f0 * 0.62 * m, end);
    }
    const vib = this.oscSource(ctx, shot, 'sine', rnd(4.5, 5.6), t0, end + 0.05);
    const vd = this.amp(ctx, shot, f0 * 0.014, t0);
    vib.connect(vd);
    vd.connect(a.frequency);
    vd.connect(b.frequency);
    const mix = this.amp(ctx, shot, 0.5, t0);
    a.connect(mix);
    b.connect(mix);
    const f1 = this.filt(ctx, shot, 'bandpass', 620, 5, t0);
    f1.frequency.linearRampToValueAtTime(820, t0 + dur * 0.4);
    f1.frequency.linearRampToValueAtTime(640, end);
    const f2 = this.filt(ctx, shot, 'bandpass', 1150, 6, t0);
    const f2g = this.amp(ctx, shot, 0.5, t0);
    const env = this.amp(ctx, shot, 0.0001, t0);
    const vol = rnd(0.022, 0.032) * clamp(level, 0.2, 1);
    env.gain.linearRampToValueAtTime(vol, t0 + dur * 0.3);
    env.gain.linearRampToValueAtTime(vol * 0.85, t0 + dur * 0.72);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    mix.connect(f1);
    mix.connect(f2);
    f1.connect(env);
    f2.connect(f2g);
    f2g.connect(env);
    env.connect(o.input);
    shot.seal();
  }

  /** 林中不明动物移动：4–10 次不规则踩踏落叶（每步 2–4 个碎响颗粒 + 低频体重感），偶有细枝脆响，声像缓慢移动 */
  private playCreatureRustle(pan: number, level: number) {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const steps: number[] = [];
    let t = now + 0.05;
    const n = 4 + Math.floor(Math.random() * 7);
    for (let i = 0; i < n; i++) {
      steps.push(t);
      t += Math.random() < 0.2 ? rnd(0.6, 1.1) : rnd(0.18, 0.45);
    }
    const end = t + 0.1;
    const far = rnd(0.3, 1);
    const o = this.distantOut(ctx, shot, pan, 3600 - far * 1800, 0.35 + far * 0.35);
    if (o.pan) o.pan.linearRampToValueAtTime(clamp(pan + rnd(-0.4, 0.4), -0.95, 0.95), end);
    const lv = this.noiseSource(ctx, shot, white, now, end - now);
    const lbp = this.filt(ctx, shot, 'bandpass', rnd(1300, 2200), 0.9, now);
    const lg = this.amp(ctx, shot, 0.0001, now);
    const wt = this.noiseSource(ctx, shot, pink, now, end - now);
    const wlp = this.filt(ctx, shot, 'lowpass', 360, 0.8, now);
    const wg = this.amp(ctx, shot, 0.0001, now);
    const vol = rnd(0.03, 0.05) * clamp(level, 0.2, 1) * (1 - far * 0.4);
    const snapAt = Math.random() < 0.35 ? Math.floor(Math.random() * n) : -1;
    for (let i = 0; i < steps.length; i++) {
      let tg = steps[i];
      const grains = 2 + Math.floor(Math.random() * 3);
      for (let k = 0; k < grains; k++) {
        const d = rnd(0.008, 0.025);
        const boost = i === snapAt && k === 0 ? 2.4 : 1;
        this.perc(lg.gain, tg, vol * rnd(0.4, 1) * boost, 0.002, d);
        tg += 0.002 + d + rnd(0.002, 0.012);
      }
      this.perc(wg.gain, steps[i], vol * 1.6 * rnd(0.6, 1), 0.006, 0.07);
    }
    lv.connect(lbp);
    lbp.connect(lg);
    lg.connect(o.input);
    wt.connect(wlp);
    wlp.connect(wg);
    wg.connect(o.input);
    shot.seal();
  }

  /**
   * 近处树冠大水滴"啪嗒"：落在宽叶/外套上的重滴——尖锐噪声冲击 + 叶片低中频"嗒"体 + 细碎溅射；
   * count > 1 时为阵风抖落的一串
   */
  private playCanopyDrop(count: number) {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const n = clamp(Math.floor(count), 1, 5);
    let t = now;
    for (let c = 0; c < n; c++) {
      const o = this.distantOut(ctx, shot, randomPan(0.8), 9000, 0.12);
      const vol = rnd(0.05, 0.09) * (c === 0 ? 1 : rnd(0.5, 0.9));
      const tr = this.noiseSource(ctx, shot, white, t, 0.03);
      const tbp = this.filt(ctx, shot, 'bandpass', rnd(1800, 3000), 0.8, t);
      const tg = this.amp(ctx, shot, 0.0001, t);
      this.perc(tg.gain, t, vol, 0.0008, 0.012);
      tr.connect(tbp);
      tbp.connect(tg);
      tg.connect(o.input);
      const bd = this.noiseSource(ctx, shot, pink, t, 0.06);
      const bbp = this.filt(ctx, shot, 'bandpass', rnd(500, 900), 2.5, t);
      const bg = this.amp(ctx, shot, 0.0001, t);
      this.perc(bg.gain, t, vol * 1.6, 0.002, 0.04);
      bd.connect(bbp);
      bbp.connect(bg);
      bg.connect(o.input);
      const st = t + 0.008;
      const sp = this.noiseSource(ctx, shot, white, st, 0.08);
      const shp = this.filt(ctx, shot, 'highpass', 3500, 0.7, st);
      const sg = this.amp(ctx, shot, 0.0001, st);
      this.perc(sg.gain, st, vol * 0.35, 0.004, 0.05);
      sp.connect(shp);
      shp.connect(sg);
      sg.connect(o.input);
      t += rnd(0.06, 0.45);
    }
    shot.seal();
  }

  /** 室内：屋顶铁皮补丁被雨点击中——非谐和板振动分音（1 : 1.47 : 2.09 : 2.56）短促"叮"，经木屋混响 */
  private playRoofTin(rain: number) {
    const ctx = this.ctx;
    const master = this.masterGain;
    const white = this.whiteBuf;
    if (!ctx || !master || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const out = this.amp(ctx, shot, 1, now);
    const lp = this.filt(ctx, shot, 'lowpass', 7000, 0.5, now);
    out.connect(lp);
    if (typeof ctx.createStereoPanner === 'function') {
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(rnd(-0.6, 0.6), now);
      lp.connect(p);
      p.connect(master);
    } else {
      lp.connect(master);
    }
    if (this.hutIn) {
      const send = this.amp(ctx, shot, 0.4, now);
      lp.connect(send);
      send.connect(this.hutIn);
    }
    const ratios = [1, 1.47, 2.09, 2.56];
    const amps = [1, 0.6, 0.4, 0.25];
    const hits = Math.random() < 0.25 ? 2 : 1;
    const f = rnd(1700, 2600);
    let t = now + 0.005;
    for (let h = 0; h < hits; h++) {
      const vol = 0.018 * rnd(0.6, 1.2) * (0.6 + 0.4 * clamp(rain, 0, 1)) * (h === 0 ? 1 : 0.6);
      const dec = rnd(0.08, 0.2);
      for (let i = 0; i < ratios.length; i++) {
        const d = dec * (1 - i * 0.18);
        const o = this.oscSource(ctx, shot, 'sine', Math.min(16000, f * ratios[i] * rnd(0.995, 1.005)), t, t + d + 0.02);
        const g = this.amp(ctx, shot, 0.0001, t);
        this.perc(g.gain, t, vol * amps[i], 0.0008, d);
        o.connect(g);
        g.connect(out);
      }
      const ck = this.noiseSource(ctx, shot, white, t, 0.012);
      const chp = this.filt(ctx, shot, 'highpass', 4000, 0.7, t);
      const cg = this.amp(ctx, shot, 0.0001, t);
      this.perc(cg.gain, t, vol * 0.8, 0.0005, 0.006);
      ck.connect(chp);
      chp.connect(cg);
      cg.connect(out);
      t += rnd(0.12, 0.3);
    }
    shot.seal();
  }

  /** 夜晚远处敲击：2–5 下不规则的闷木敲击（共振带通噪声 + 低频木体），重度低通与森林混响 */
  private playDistantKnock(pan: number) {
    const ctx = this.ctx;
    const pink = this.pinkBuf;
    if (!ctx || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const o = this.distantOut(ctx, shot, pan, rnd(600, 900), 0.75);
    const knocks = 2 + Math.floor(Math.random() * 4);
    const times: number[] = [];
    let t = now + 0.05;
    for (let i = 0; i < knocks; i++) {
      times.push(t);
      t += rnd(0.25, 0.7);
    }
    const end = t + 0.15;

    const src = this.noiseSource(ctx, shot, pink, now, end - now);
    const bp = this.filt(ctx, shot, 'bandpass', rnd(140, 190), 4, now);
    const g = this.amp(ctx, shot, 0.0001, now);
    const body = this.oscSource(ctx, shot, 'sine', rnd(95, 135), now, end);
    const bg = this.amp(ctx, shot, 0.0001, now);
    const vol = rnd(0.05, 0.08);
    for (let i = 0; i < times.length; i++) {
      const v = vol * rnd(0.6, 1);
      this.perc(g.gain, times[i], v * 3, 0.002, 0.06);
      this.perc(bg.gain, times[i], v * 0.6, 0.002, 0.08);
    }
    src.connect(bp);
    bp.connect(g);
    g.connect(o.input);
    body.connect(bg);
    bg.connect(o.input);
    shot.seal();
  }

  /** 夜晚远处拖拽：棕噪 + 少量白噪经带通，若干次不规则"拉—停"包络，声像缓慢移动 */
  private playDistantDrag(pan: number) {
    const ctx = this.ctx;
    const brown = this.brownBuf;
    const white = this.whiteBuf;
    if (!ctx || !brown || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const dur = rnd(1.8, 3.2);
    const end = now + dur;
    const o = this.distantOut(ctx, shot, pan, 900, 0.6);
    if (o.pan) {
      const target = clamp(pan + rnd(-0.35, 0.35), -0.95, 0.95);
      o.pan.linearRampToValueAtTime(target, end);
    }

    const env = this.amp(ctx, shot, 0.0001, now);
    const vol = rnd(0.04, 0.06);
    let t = now + 0.05;
    for (;;) {
      const pull = rnd(0.15, 0.4);
      // 保证所有自动化事件严格早于结尾的指数淡出
      if (t + pull > end - 0.12) break;
      env.gain.linearRampToValueAtTime(vol * rnd(0.6, 1), t + pull * 0.35);
      env.gain.linearRampToValueAtTime(vol * rnd(0.1, 0.3), t + pull);
      t += pull + rnd(0.05, 0.25);
    }
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    const a = this.noiseSource(ctx, shot, brown, now, dur + 0.05, rnd(0.9, 1.1));
    const abp = this.filt(ctx, shot, 'bandpass', rnd(260, 480), 1.6, now);
    const ahp = this.filt(ctx, shot, 'highpass', 90, 0.7, now);
    a.connect(abp);
    abp.connect(ahp);
    ahp.connect(env);

    const b = this.noiseSource(ctx, shot, white, now, dur + 0.05);
    const bbp = this.filt(ctx, shot, 'bandpass', rnd(1000, 1400), 2, now);
    const bg = this.amp(ctx, shot, 0.12, now);
    b.connect(bbp);
    bbp.connect(bg);
    bg.connect(env);
    env.connect(o.input);
    shot.seal();
  }

  /** 夜晚低语般的滤波噪声：白噪经两路窄带"共振峰"，按音节随机滑动 + 音节包络，极克制音量 */
  private playWhisper(pan: number) {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    if (!ctx || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const dur = rnd(1.6, 2.6);
    const end = now + dur;
    const o = this.distantOut(ctx, shot, pan, 4200, 0.5);

    const src = this.noiseSource(ctx, shot, white, now, dur + 0.05);
    const hp = this.filt(ctx, shot, 'highpass', 500, 0.7, now);
    const f1 = this.filt(ctx, shot, 'bandpass', rnd(600, 1400), 5, now);
    const f2 = this.filt(ctx, shot, 'bandpass', rnd(1700, 3200), 5, now);
    const g2 = this.amp(ctx, shot, 0.7, now);
    const env = this.amp(ctx, shot, 0.0001, now);
    const vol = rnd(0.45, 0.6);

    let t = now + 0.08;
    for (;;) {
      const syl = rnd(0.12, 0.3);
      // 保证所有自动化事件严格早于结尾的指数淡出
      if (t + syl > end - 0.1) break;
      f1.frequency.setTargetAtTime(rnd(600, 1400), t, 0.04);
      f2.frequency.setTargetAtTime(rnd(1700, 3200), t, 0.04);
      env.gain.linearRampToValueAtTime(vol * rnd(0.3, 1), t + syl * 0.4);
      env.gain.linearRampToValueAtTime(vol * rnd(0.02, 0.15), t + syl);
      t += syl + rnd(0.0, 0.12);
    }
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    src.connect(hp);
    hp.connect(f1);
    hp.connect(f2);
    f1.connect(env);
    f2.connect(g2);
    g2.connect(env);
    env.connect(o.input);
    shot.seal();
  }

  // ═══════════════════════════ 第三轮：真实雨声录音（CC0，可回退） ═══════════════════════════

  /**
   * 登记真实录音（由 audioAssets.ts 在入口处调用；本文件不静态 import 任何音频，Node 门禁安全）。
   * 可在 unlock 之前或之后调用：上下文就绪后异步解码；任何一段失败都静默保持程序化雨（Safari 对 Opus 支持不全时即回退）
   */
  registerRecordings(urls: {
    outdoorLight: string;
    outdoorHeavy: string;
    puddleNear: string;
    dripAfter: string;
    indoorRoof: string;
    thunder?: string[];
  }): void {
    if (!urls || typeof urls !== 'object') return;
    this.recUrls = urls;
    this.startRecordingLoad();
  }

  /** 录音层混入进度（0 = 纯程序化，1 = 录音全量）：解码完成后 2s 平滑交叉 */
  private recMixK(now: number): number {
    if (!this.recReady) return 0;
    return smooth01((now - this.recReadyAt) / 2);
  }

  /** URL → ArrayBuffer：data: URL 手动 atob（file:// 单文件稳妥），其余（本地构建资源）用 fetch；失败返回 null */
  private urlToArrayBuffer(url: string): Promise<ArrayBuffer | null> {
    if (typeof url !== 'string' || url.length === 0) return Promise.resolve(null);
    if (url.slice(0, 5).toLowerCase() === 'data:') {
      try {
        const comma = url.indexOf(',');
        if (comma < 0) return Promise.resolve(null);
        const meta = url.slice(5, comma);
        const body = url.slice(comma + 1);
        const bin = /;base64/i.test(meta) ? atob(body) : decodeURIComponent(body);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i) & 255;
        return Promise.resolve(u8.buffer);
      } catch {
        return Promise.resolve(null);
      }
    }
    if (typeof fetch !== 'function') return Promise.resolve(null);
    return fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null);
  }

  /** decodeAudioData 的兼容封装（同时支持 Promise 与回调两种形态），失败返回 null，绝不抛出 */
  private decodeBuffer(ctx: AudioContext, ab: ArrayBuffer | null): Promise<AudioBuffer | null> {
    if (!ab || ab.byteLength < 64) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const ok = (b: AudioBuffer) => {
        if (!done) {
          done = true;
          resolve(b && b.length > 0 ? b : null);
        }
      };
      const fail = () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      };
      try {
        const p = ctx.decodeAudioData(ab, ok, fail);
        if (p && typeof p.then === 'function') p.then(ok, fail);
      } catch {
        fail();
      }
    });
  }

  /**
   * 异步加载并解码全部录音（只执行一次）；室外淡雨/大雨任一成功即启用录音模式，其余各层缺失时该层保持程序化。
   * 成功后一次性建立录音随机重排层（加载完成时分配，非每帧）
   */
  private startRecordingLoad() {
    const ctx = this.ctx;
    const urls = this.recUrls;
    if (!ctx || !this.initialized || !urls || this.recLoading || this.recReady) return;
    this.recLoading = true;
    const load = (u: string | undefined): Promise<AudioBuffer | null> =>
      this.urlToArrayBuffer(typeof u === 'string' ? u : '')
        .then((ab) => this.decodeBuffer(ctx, ab))
        .catch(() => null);
    const thunderUrls = Array.isArray(urls.thunder) ? urls.thunder.slice(0, 4) : [];
    Promise.all([
      load(urls.outdoorLight),
      load(urls.outdoorHeavy),
      load(urls.puddleNear),
      load(urls.dripAfter),
      load(urls.indoorRoof),
      Promise.all(thunderUrls.map((u) => load(u))),
    ])
      .then((res) => {
        if (this.recReady) return;
        const bufs: Array<AudioBuffer | null> = [res[0], res[1], res[2], res[3], res[4]];
        const th = res[5];
        if (Array.isArray(th)) {
          for (let i = 0; i < th.length; i++) {
            const b = th[i];
            if (b) this.recThunder.push(b);
          }
        }
        if (!this.ctx || (!bufs[0] && !bufs[1])) return;
        this.setupRecordingLayers(this.ctx, bufs);
      })
      .catch(() => {
        // 静默回退：保持程序化雨
      });
  }

  /** 建立录音层：0 淡雨 / 1 大雨 → 雨总线；2 近处积水 → 雨总线；3 雨后林间滴水 → 室外总线；4 布篷屋顶底料 → 室内屋顶木质 EQ 链 */
  private setupRecordingLayers(ctx: AudioContext, bufs: Array<AudioBuffer | null>) {
    try {
      // 大雨缺失时用淡雨顶替（反之亦然），保证交叉两端都有声
      const light = bufs[0] ?? bufs[1];
      const heavy = bufs[1] ?? bufs[0];
      const outBus: AudioNode = this.outdoorBus ?? this.masterGain ?? ctx.destination;
      // 录音 EQ：7.5kHz 宽峰 -5dB，把近距离话筒的高频"嘶"压下去，长时平均谱峰落回 1–4kHz
      const recEQ = ctx.createBiquadFilter();
      recEQ.type = 'peaking';
      recEQ.frequency.setValueAtTime(7500, ctx.currentTime);
      recEQ.Q.setValueAtTime(0.7, ctx.currentTime);
      recEQ.gain.setValueAtTime(-5, ctx.currentTime);
      recEQ.connect(this.rainBus ?? outBus);
      const rainIn: AudioNode = recEQ;
      const roofIn: AudioNode = this.roofIn ?? this.masterGain ?? ctx.destination;
      const dests: AudioNode[] = [rainIn, rainIn, rainIn, outBus, roofIn];
      const list: Array<AudioBuffer | null> = [light, heavy, bufs[2], bufs[3], bufs[4]];
      const rates = [1, 1, 1, 1, 1];
      const layers: Array<ShuffleLayer | null> = [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        layers.push(b ? this.makeShuffleLayer(ctx, [b], dests[i], rates[i], 5, 9, 1.2, 2.0, 0.02, true) : null);
      }
      this.recLayers = layers;
      this.recReady = true;
      this.recReadyAt = ctx.currentTime;
    } catch {
      this.recLayers = [];
      this.recReady = false;
    }
  }

  // ═══════════════════════════ 第三轮：装备 / 关卡 / 惊吓音效 ═══════════════════════════

  /** 近身出口：增益 → 声像 → 近身总线（玩家自身动作用） */
  private nearOut(ctx: AudioContext, shot: OneShot, pan: number): GainNode {
    const now = ctx.currentTime;
    const bus: AudioNode = this.nearBus ?? this.masterGain ?? ctx.destination;
    const g = this.amp(ctx, shot, 1, now);
    if (typeof ctx.createStereoPanner === 'function') {
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(clamp(pan, -0.95, 0.95), now);
      g.connect(p);
      p.connect(bus);
    } else {
      g.connect(bus);
    }
    return g;
  }

  /** 滤波噪声猝发：独占增益的打击包络（免与其他事件争用同一参数时间线），返回滤波器供追加扫频 */
  private nburst(
    ctx: AudioContext,
    shot: OneShot,
    out: AudioNode,
    buf: AudioBuffer,
    t: number,
    attack: number,
    decay: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    peak: number
  ): BiquadFilterNode {
    const src = this.noiseSource(ctx, shot, buf, t, attack + decay + 0.03);
    const f = this.filt(ctx, shot, type, freq, q, t);
    const g = this.amp(ctx, shot, 0.0001, t);
    this.perc(g.gain, t, peak, attack, decay);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    return f;
  }

  /** 单音打击：振荡器 f0 → f1 指数滑音 + 打击包络 */
  private tone(
    ctx: AudioContext,
    shot: OneShot,
    out: AudioNode,
    type: OscillatorType,
    t: number,
    f0: number,
    f1: number,
    attack: number,
    decay: number,
    peak: number
  ): OscillatorNode {
    const a = Math.max(0.001, attack);
    const d = Math.max(0.005, decay);
    const o = this.oscSource(ctx, shot, type, clamp(f0, 20, 18000), t, t + a + d + 0.03);
    if (f1 > 0 && Math.abs(f1 - f0) > 0.01) o.frequency.exponentialRampToValueAtTime(clamp(f1, 20, 18000), t + a + d);
    const g = this.amp(ctx, shot, 0.0001, t);
    this.perc(g.gain, t, peak, a, d);
    o.connect(g);
    g.connect(out);
    return o;
  }

  /**
   * 机械"咔"：极短宽带击发瞬态（高通白噪）+ 三个非谐和小钢件分音（1 : 2.31 : 3.89）短衰减；返回事件结束时刻
   */
  private mechClick(ctx: AudioContext, shot: OneShot, out: AudioNode, t: number, vol: number, baseHz: number, decay: number): number {
    const white = this.whiteBuf;
    if (!white || vol <= 0) return t;
    this.nburst(ctx, shot, out, white, t, 0.0004, 0.004, 'highpass', 2200, 0.7, vol);
    const ratios = [1, 2.31, 3.89];
    const amps = [1, 0.55, 0.3];
    for (let i = 0; i < ratios.length; i++) {
      const f = Math.min(16000, baseHz * ratios[i] * rnd(0.98, 1.02));
      this.tone(ctx, shot, out, 'sine', t, f, f, 0.0005, Math.max(0.005, decay * (1 - i * 0.25)), vol * 0.35 * amps[i]);
    }
    return t + decay + 0.02;
  }

  /** 木质"笃"：粉噪带通（板面）+ 三角波下滑（木体） */
  private woodKnock(ctx: AudioContext, shot: OneShot, out: AudioNode, t: number, vol: number, bodyHz: number, decay: number) {
    const pink = this.pinkBuf;
    if (!pink || vol <= 0) return;
    this.nburst(ctx, shot, out, pink, t, 0.0015, decay, 'bandpass', bodyHz * rnd(2.0, 2.6), 2.5, vol);
    this.tone(ctx, shot, out, 'triangle', t, bodyHz, bodyHz * 0.72, 0.0015, decay * 1.2, vol * 0.35);
  }

  /**
   * 手枪枪声：极短爆裂瞬态（2–4ms 高通白噪 N 波前沿）+ 中频爆燃体（粉噪低通下扫）+ 低频冲击（正弦 140→42Hz + 棕噪闷压）
   * + 极近可辨的击锤/套筒"咔—嚓"；所在空间处理：森林 = 树墙离散回声（0.12–0.9s 左右交替、渐闷渐弱）+ 远处滚动隆隆 + 长混响，
   * 木屋 = 8–30ms 墙面短促拍击回声 + 木屋混响；玩家自己开枪（spatial 省略）或贴近时附带数秒耳鸣尾音
   */
  playGunshot(spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    const brown = this.brownBuf;
    if (!ctx || !this.masterGain || !white || !pink || !brown || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const own = !spatial;
    const route = this.createSpatialRoute(spatial);
    shot.addAll(route.nodes);
    const d01 = route.dist01;
    const scale = clamp(route.gainScale, 0.1, 1);
    const out: AudioNode = own ? this.nearOut(ctx, shot, 0.05) : route.input;
    const srcIndoor = spatial && spatial.muffled ? !this.listenerIndoor : this.listenerIndoor;
    const v = scale * rnd(0.92, 1.05);
    const mix = this.amp(ctx, shot, 1, now);
    mix.connect(out);

    // 1) 爆裂瞬态 + 中频爆燃体
    this.nburst(ctx, shot, mix, white, now, 0.0003, 0.0035, 'highpass', 1200, 0.5, 0.7 * v);
    const bf = this.nburst(ctx, shot, mix, pink, now, 0.0008, 0.075, 'lowpass', 3200, 0.7, 0.55 * v);
    bf.frequency.exponentialRampToValueAtTime(700, now + 0.08);
    // 2) 低频冲击
    this.tone(ctx, shot, mix, 'sine', now, 140, 42, 0.002, 0.12, 0.5 * v);
    this.nburst(ctx, shot, mix, brown, now, 0.002, 0.14, 'lowpass', 180, 0.8, 0.6 * v);
    // 3) 击锤/套筒后坐复进（距离越远越被淹没）
    if (d01 < 0.6) {
      const mk = (1 - d01) * v;
      this.mechClick(ctx, shot, mix, now + 0.004, 0.12 * mk, 2900, 0.018);
      this.mechClick(ctx, shot, mix, now + rnd(0.028, 0.04), 0.09 * mk, 2300, 0.03);
    }
    // 4) 送入声源所在空间混响（大量）
    const reverbIn = srcIndoor ? this.hutIn : this.forestIn;
    if (reverbIn) {
      const send = this.amp(ctx, shot, (srcIndoor ? 0.5 : 0.55) * v, now);
      mix.connect(send);
      send.connect(reverbIn);
    }
    // 5) 空间回声
    if (srcIndoor) {
      let t = now + rnd(0.007, 0.011);
      for (let i = 0; i < 4; i++) {
        const a = 0.26 * v * Math.pow(0.68, i);
        this.nburst(ctx, shot, out, pink, t, 0.0006, 0.022 + i * 0.006, 'bandpass', 1500 - i * 260, 0.8, a);
        t += rnd(0.005, 0.009);
      }
    } else {
      // 森林：回声经室外总线（听者进屋自动隔墙）并带少量森林混响
      let t = now + rnd(0.12, 0.2);
      const n = 3 + Math.floor(Math.random() * 3);
      let side = Math.random() < 0.5 ? -1 : 1;
      for (let i = 0; i < n; i++) {
        const o = this.distantOut(ctx, shot, side * rnd(0.35, 0.8), 2400 * Math.pow(0.72, i), 0.35);
        const a = 0.16 * v * Math.pow(0.62, i) * rnd(0.75, 1.1);
        this.nburst(ctx, shot, o.input, pink, t, 0.002, 0.07 + i * 0.03, 'lowpass', 2200 * Math.pow(0.75, i), 0.7, a);
        this.nburst(ctx, shot, o.input, brown, t, 0.004, 0.12 + i * 0.04, 'lowpass', 260, 0.7, a * 0.8);
        t += rnd(0.09, 0.24);
        side = -side;
      }
      // 远处滚动隆隆：棕噪低通 320 → 90Hz，缓起、约 2s 衰减
      const ro = this.distantOut(ctx, shot, rnd(-0.3, 0.3), 900, 0.5);
      const rdur = rnd(1.6, 2.4);
      const rs = this.noiseSource(ctx, shot, brown, now + 0.05, rdur + 0.1, rnd(0.85, 1.0));
      const rlp = this.filt(ctx, shot, 'lowpass', 320, 0.7, now + 0.05);
      rlp.frequency.exponentialRampToValueAtTime(90, now + 0.05 + rdur);
      const rg = this.amp(ctx, shot, 0.0001, now + 0.05);
      rg.gain.linearRampToValueAtTime(0.2 * v, now + 0.18);
      rg.gain.exponentialRampToValueAtTime(0.0001, now + 0.05 + rdur);
      rs.connect(rlp);
      rlp.connect(rg);
      rg.connect(ro.input);
    }
    // 6) 近处耳鸣尾音（骨传导感：走身体总线）
    if (own || d01 < 0.18) {
      const body: AudioNode = this.bodyBus ?? this.masterGain;
      const k = own ? 1 : 0.5;
      const f = rnd(3600, 4400);
      const rdur = rnd(1.6, 2.4);
      const t0 = now + 0.03;
      const o1 = this.oscSource(ctx, shot, 'sine', f, t0, t0 + rdur + 0.05);
      const o2 = this.oscSource(ctx, shot, 'sine', f + rnd(17, 29), t0, t0 + rdur + 0.05);
      o1.frequency.linearRampToValueAtTime(f * 0.985, t0 + rdur);
      const rgn = this.amp(ctx, shot, 0.0001, t0);
      rgn.gain.linearRampToValueAtTime(0.006 * k, t0 + 0.08);
      rgn.gain.exponentialRampToValueAtTime(0.0001, t0 + rdur);
      const o2g = this.amp(ctx, shot, 0.6, t0);
      o1.connect(rgn);
      o2.connect(o2g);
      o2g.connect(rgn);
      rgn.connect(body);
    }
    shot.seal();
  }

  /**
   * 手枪换弹（约 1.1s）：① 按释放钮"嗒" + 弹匣滑出金属摩擦 + 落入掌心闷拍；② 新弹匣滑入 + 卡入"咔嚓"与枪身闷体；
   * ③ 拉套筒：后拉弹簧压缩刮擦 + 后止点"咔"，放开复进闭锁重"咔—嚓"
   */
  playPistolReload(): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !this.masterGain || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const out = this.nearOut(ctx, shot, 0.12);
    const t0 = now + 0.005;
    // ① 退弹匣
    this.mechClick(ctx, shot, out, t0, 0.07, 3400, 0.012);
    const f1 = this.nburst(ctx, shot, out, white, t0 + 0.02, 0.01, 0.11, 'bandpass', 2600, 2.2, 0.06);
    f1.frequency.exponentialRampToValueAtTime(1500, t0 + 0.14);
    this.nburst(ctx, shot, out, pink, t0 + rnd(0.15, 0.19), 0.003, 0.05, 'lowpass', 600, 0.8, 0.12);
    // ② 插入
    const t1 = t0 + rnd(0.42, 0.52);
    const f2 = this.nburst(ctx, shot, out, white, t1, 0.02, 0.07, 'bandpass', 1400, 2.4, 0.05);
    f2.frequency.exponentialRampToValueAtTime(2400, t1 + 0.09);
    this.mechClick(ctx, shot, out, t1 + 0.1, 0.16, 1700, 0.035);
    this.tone(ctx, shot, out, 'triangle', t1 + 0.1, 260, 180, 0.001, 0.05, 0.1);
    // ③ 拉套筒
    const t2 = t1 + rnd(0.32, 0.4);
    const f3 = this.nburst(ctx, shot, out, white, t2, 0.03, 0.08, 'bandpass', 1800, 3, 0.045);
    f3.frequency.exponentialRampToValueAtTime(3200, t2 + 0.11);
    this.mechClick(ctx, shot, out, t2 + 0.12, 0.13, 2500, 0.02);
    const t3 = t2 + 0.12 + rnd(0.07, 0.11);
    this.mechClick(ctx, shot, out, t3, 0.2, 1900, 0.045);
    this.tone(ctx, shot, out, 'sine', t3, 180, 120, 0.001, 0.06, 0.12);
    this.nburst(ctx, shot, out, pink, t3, 0.001, 0.04, 'bandpass', 900, 1.5, 0.1);
    shot.seal();
  }

  /** 空仓击发：扳机行程轻"嗒" + 击锤空击清脆"咔"（干声、无回响） */
  playDryFire(): void {
    const ctx = this.ctx;
    if (!ctx || !this.masterGain || !this.whiteBuf || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const out = this.nearOut(ctx, shot, 0.06);
    this.mechClick(ctx, shot, out, now + 0.003, 0.035, 4200, 0.006);
    const t = now + rnd(0.05, 0.08);
    this.mechClick(ctx, shot, out, t, 0.16, 3100 * rnd(0.95, 1.05), 0.022);
    this.tone(ctx, shot, out, 'triangle', t, 520, 380, 0.001, 0.03, 0.05);
    shot.seal();
  }

  /**
   * 弹壳落地（调用时刻即首次触地）：黄铜薄管非谐和分音"叮"（1 : 2.71 : 5.15）——
   *   wood  木板：3–5 次清脆弹跳（间隔与力度几何递减）+ 每跳木面轻"嗒"，最后在板缝滚动的细碎嗒嗒
   *   mud   泥地：一声闷"噗"，铜音几乎被吞掉
   *   gravel 碎石：2–4 次不规则弹跳叮当 + 石粒碰撞颗粒
   */
  playShellDrop(surface: 'wood' | 'mud' | 'gravel'): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !this.masterGain || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const out = this.nearOut(ctx, shot, rnd(0.15, 0.45));
    const f = rnd(5200, 6800);
    const ting = (t: number, vol: number, dec: number) => {
      const ratios = [1, 2.71, 5.15];
      const amps = [1, 0.5, 0.22];
      this.nburst(ctx, shot, out, white, t, 0.0003, 0.002, 'highpass', 4000, 0.7, vol * 0.6);
      for (let i = 0; i < ratios.length; i++) {
        const fr = Math.min(17000, f * ratios[i] * rnd(0.99, 1.01));
        this.tone(ctx, shot, out, 'sine', t, fr, fr, 0.0004, Math.max(0.006, dec * (1 - i * 0.3)), vol * 0.4 * amps[i]);
      }
    };
    let t = now + 0.02;
    if (surface === 'mud') {
      this.nburst(ctx, shot, out, pink, t, 0.002, 0.05, 'lowpass', 700, 0.7, 0.08);
      const sq = this.nburst(ctx, shot, out, white, t + 0.004, 0.004, 0.05, 'bandpass', 500, 3, 0.03);
      sq.frequency.exponentialRampToValueAtTime(300, t + 0.06);
      ting(t, 0.025, 0.012);
    } else if (surface === 'wood') {
      const n = 3 + Math.floor(Math.random() * 3);
      let gap = rnd(0.09, 0.13);
      let vol = rnd(0.09, 0.12);
      for (let i = 0; i < n; i++) {
        ting(t, vol, rnd(0.09, 0.16));
        this.nburst(ctx, shot, out, pink, t, 0.001, 0.02, 'bandpass', rnd(900, 1400), 2, vol * 0.4);
        t += gap;
        gap *= rnd(0.55, 0.7);
        vol *= rnd(0.45, 0.6);
      }
      // 板缝滚动
      const r = 5 + Math.floor(Math.random() * 5);
      for (let i = 0; i < r; i++) {
        this.nburst(ctx, shot, out, white, t, 0.0005, 0.006, 'bandpass', rnd(3000, 5000), 2, 0.012 * (1 - i / r));
        t += rnd(0.03, 0.06);
      }
    } else {
      const n = 2 + Math.floor(Math.random() * 3);
      let vol = rnd(0.08, 0.11);
      for (let i = 0; i < n; i++) {
        ting(t, vol, rnd(0.04, 0.07));
        const g = 2 + Math.floor(Math.random() * 2);
        let tg = t + 0.003;
        for (let k = 0; k < g; k++) {
          this.nburst(ctx, shot, out, white, tg, 0.0008, 0.006, 'bandpass', rnd(2500, 4000), 1.2, vol * rnd(0.3, 0.6));
          tg += rnd(0.008, 0.02);
        }
        t += rnd(0.05, 0.12);
        vol *= rnd(0.4, 0.65);
      }
    }
    shot.seal();
  }

  /**
   * 挥动火把：火焰被甩动的"呼——"（粉噪带通先升后降，声像掠过）+ 火舌扑动的低频轰（棕噪低通 × 18–28Hz 颤动）+ 2–4 颗火星爆裂
   */
  playTorchWhoosh(intensity01: number): void {
    const ctx = this.ctx;
    const pink = this.pinkBuf;
    const brown = this.brownBuf;
    const white = this.whiteBuf;
    if (!ctx || !this.masterGain || !pink || !brown || !white || this.muted || this.pageHidden) return;
    const k = Number.isFinite(intensity01) ? clamp(intensity01, 0, 1) : 0.5;
    const now = ctx.currentTime;
    const shot = new OneShot();
    this.swingSide = -this.swingSide;
    const dur = 0.28 + 0.22 * k;
    const peakT = now + dur * 0.4;
    const end = now + dur;
    const out = this.amp(ctx, shot, 1, now);
    const bus: AudioNode = this.nearBus ?? this.masterGain;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(-0.35 * this.swingSide, now);
      p.pan.linearRampToValueAtTime(0.4 * this.swingSide, end);
      out.connect(p);
      p.connect(bus);
    } else {
      out.connect(bus);
    }
    const src = this.noiseSource(ctx, shot, pink, now, dur + 0.05);
    const bp = this.filt(ctx, shot, 'bandpass', 300, 1.2, now);
    bp.frequency.exponentialRampToValueAtTime(700 + 500 * k, peakT);
    bp.frequency.exponentialRampToValueAtTime(260, end);
    const g = this.amp(ctx, shot, 0.0001, now);
    g.gain.exponentialRampToValueAtTime((0.1 + 0.14 * k) * 0.25, now + (peakT - now) * 0.5);
    g.gain.exponentialRampToValueAtTime(0.1 + 0.14 * k, peakT);
    g.gain.exponentialRampToValueAtTime(0.0001, end + 0.02);
    src.connect(bp);
    bp.connect(g);
    g.connect(out);
    // 火舌扑动
    const rs = this.noiseSource(ctx, shot, brown, now, dur + 0.08);
    const rlp = this.filt(ctx, shot, 'lowpass', 420 + 200 * k, 0.8, now);
    const rg = this.amp(ctx, shot, 0.0001, now);
    rg.gain.linearRampToValueAtTime((0.12 + 0.12 * k) * 0.6, peakT);
    rg.gain.exponentialRampToValueAtTime(0.0001, end + 0.05);
    const fl = this.oscSource(ctx, shot, 'sine', rnd(18, 28), now, end + 0.08);
    const fd = this.amp(ctx, shot, (0.05 + 0.05 * k) * 0.6, now);
    fl.connect(fd);
    fd.connect(rg.gain);
    rs.connect(rlp);
    rlp.connect(rg);
    rg.connect(out);
    // 火星
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      this.nburst(ctx, shot, out, white, now + rnd(0.02, dur), 0.0003, 0.003, 'highpass', 2500, 0.7, rnd(0.02, 0.05));
    }
    shot.seal();
  }

  /**
   * 火把掉落：木柄落地"笃" + 一次小弹跳；火焰扑腾"噗呼"（棕噪低通先扑亮再压暗）；6–12 颗火星细碎"嗞/啪"随机散落
   */
  playTorchDrop(spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    const brown = this.brownBuf;
    if (!ctx || !this.masterGain || !white || !pink || !brown || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const sc = clamp(route.gainScale, 0.08, 1);
    const out = route.input;
    this.woodKnock(ctx, shot, out, now + 0.003, 0.3 * sc, rnd(170, 230), 0.07);
    this.woodKnock(ctx, shot, out, now + rnd(0.1, 0.15), 0.12 * sc, rnd(200, 260), 0.05);
    const fs = this.noiseSource(ctx, shot, brown, now, 0.45);
    const flp = this.filt(ctx, shot, 'lowpass', 220, 0.9, now);
    flp.frequency.exponentialRampToValueAtTime(650, now + 0.06);
    flp.frequency.exponentialRampToValueAtTime(240, now + 0.4);
    const fg = this.amp(ctx, shot, 0.0001, now);
    fg.gain.linearRampToValueAtTime(0.22 * sc, now + 0.05);
    fg.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    fs.connect(flp);
    flp.connect(fg);
    fg.connect(out);
    const n = 6 + Math.floor(Math.random() * 7);
    for (let i = 0; i < n; i++) {
      const t = now + 0.02 + Math.pow(Math.random(), 1.6) * 0.6;
      this.nburst(ctx, shot, out, white, t, 0.0003, rnd(0.002, 0.006), 'bandpass', rnd(4500, 8000), 1.2, rnd(0.015, 0.05) * sc);
    }
    shot.seal();
  }

  /** 拾起火把：手掌握住木柄的布料/皮肤摩擦 + 木柄轻磕 + 火焰被带起的"呼"（带通上扫）与气流增强 */
  playTorchPickup(): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    const brown = this.brownBuf;
    if (!ctx || !this.masterGain || !white || !pink || !brown || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const out = this.nearOut(ctx, shot, 0.1);
    this.nburst(ctx, shot, out, white, now, 0.01, 0.06, 'bandpass', 2200, 0.9, 0.05);
    this.woodKnock(ctx, shot, out, now + rnd(0.03, 0.05), 0.08, rnd(220, 280), 0.04);
    const t = now + 0.06;
    const src = this.noiseSource(ctx, shot, pink, t, 0.45);
    const bp = this.filt(ctx, shot, 'bandpass', 250, 1.2, t);
    bp.frequency.exponentialRampToValueAtTime(650, t + 0.25);
    const g = this.amp(ctx, shot, 0.0001, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    src.connect(bp);
    bp.connect(g);
    g.connect(out);
    this.nburst(ctx, shot, out, brown, t, 0.08, 0.3, 'lowpass', 320, 0.7, 0.12);
    shot.seal();
  }

  /**
   * 投掷：手臂挥出的破风 + 飞行物远去——
   *   torch 火焰拖尾的呼呼扑动（棕噪/粉噪 × 14–20Hz 颤动），音高与亮度下滑（多普勒）、渐弱、声像偏向一侧
   *   flare 信号棒燃烧的嘶嘶拖尾（高通白噪带通下扫），同样渐远
   */
  playThrow(kind: 'flare' | 'torch'): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    const brown = this.brownBuf;
    if (!ctx || !this.masterGain || !white || !pink || !brown || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const bus: AudioNode = this.nearBus ?? this.masterGain;
    // 1) 手臂破风
    const arm = this.nearOut(ctx, shot, 0.15);
    const aDur = 0.24;
    const as = this.noiseSource(ctx, shot, pink, now, aDur + 0.04);
    const abp = this.filt(ctx, shot, 'bandpass', 600, 1.4, now);
    abp.frequency.exponentialRampToValueAtTime(1300, now + aDur * 0.4);
    abp.frequency.exponentialRampToValueAtTime(400, now + aDur);
    const ag = this.amp(ctx, shot, 0.0001, now);
    ag.gain.exponentialRampToValueAtTime(0.14, now + aDur * 0.4);
    ag.gain.exponentialRampToValueAtTime(0.0001, now + aDur);
    as.connect(abp);
    abp.connect(ag);
    ag.connect(arm);
    this.nburst(ctx, shot, arm, white, now, 0.01, 0.07, 'bandpass', rnd(2200, 3000), 0.9, 0.03);
    // 2) 飞行物远去
    const t0 = now + 0.08;
    const dur = rnd(0.5, 0.7);
    const end = t0 + dur;
    const fly = this.amp(ctx, shot, 1, t0);
    if (typeof ctx.createStereoPanner === 'function') {
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(0.05, t0);
      p.pan.linearRampToValueAtTime(rnd(-0.5, 0.5), end);
      fly.connect(p);
      p.connect(bus);
    } else {
      fly.connect(bus);
    }
    if (this.roomSend) {
      const s = this.amp(ctx, shot, 0.25, t0);
      fly.connect(s);
      s.connect(this.roomSend);
    }
    const env = this.amp(ctx, shot, 0.0001, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.connect(fly);
    if (kind === 'torch') {
      const rs = this.noiseSource(ctx, shot, brown, t0, dur + 0.05);
      const rlp = this.filt(ctx, shot, 'lowpass', 600, 0.8, t0);
      rlp.frequency.exponentialRampToValueAtTime(260, end);
      const rg = this.amp(ctx, shot, 0.14, t0);
      const fl = this.oscSource(ctx, shot, 'sine', rnd(14, 20), t0, end + 0.05);
      fl.frequency.linearRampToValueAtTime(rnd(10, 13), end);
      const fd = this.amp(ctx, shot, 0.07, t0);
      fl.connect(fd);
      fd.connect(rg.gain);
      rs.connect(rlp);
      rlp.connect(rg);
      rg.connect(env);
      const ws = this.noiseSource(ctx, shot, pink, t0, dur + 0.05);
      const wbp = this.filt(ctx, shot, 'bandpass', 700, 1.2, t0);
      wbp.frequency.exponentialRampToValueAtTime(380, end);
      const wg = this.amp(ctx, shot, 0.07, t0);
      ws.connect(wbp);
      wbp.connect(wg);
      wg.connect(env);
    } else {
      const hs = this.noiseSource(ctx, shot, white, t0, dur + 0.05);
      const hhp = this.filt(ctx, shot, 'highpass', 2600, 0.7, t0);
      const hbp = this.filt(ctx, shot, 'bandpass', 4800, 0.9, t0);
      hbp.frequency.exponentialRampToValueAtTime(3000, end);
      const hg = this.amp(ctx, shot, 0.09, t0);
      hs.connect(hhp);
      hhp.connect(hbp);
      hbp.connect(hg);
      hg.connect(env);
    }
    shot.seal();
  }

  /**
   * 布置捕兽夹：弹簧压紧的金属摩擦吱嘎（带通上扫）+ 弹簧"嗡"微颤 → 钳口张开刮擦 → "咔哒"锁定（主咔 + 回弹小咔）
   * + 弹簧余振（正弦带颤音）+ 链条细碎叮当
   */
  playTrapSet(spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    if (!ctx || !this.masterGain || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const sc = clamp(route.gainScale, 0.08, 1);
    const out = route.input;
    // 1) 压簧
    const cd = rnd(0.3, 0.4);
    const cs = this.noiseSource(ctx, shot, white, now, cd + 0.03);
    const cbp = this.filt(ctx, shot, 'bandpass', 900, 4, now);
    cbp.frequency.exponentialRampToValueAtTime(2200, now + cd);
    const cg = this.amp(ctx, shot, 0.0001, now);
    cg.gain.linearRampToValueAtTime(0.05 * sc, now + cd * 0.5);
    cg.gain.linearRampToValueAtTime(0.035 * sc, now + cd * 0.85);
    cg.gain.exponentialRampToValueAtTime(0.0001, now + cd);
    cs.connect(cbp);
    cbp.connect(cg);
    cg.connect(out);
    const hum = this.oscSource(ctx, shot, 'triangle', 380, now, now + cd + 0.03);
    hum.frequency.linearRampToValueAtTime(460, now + cd);
    const hv = this.oscSource(ctx, shot, 'sine', 7, now, now + cd + 0.03);
    const hvd = this.amp(ctx, shot, 9, now);
    hv.connect(hvd);
    hvd.connect(hum.frequency);
    const hg = this.amp(ctx, shot, 0.0001, now);
    hg.gain.linearRampToValueAtTime(0.025 * sc, now + cd * 0.6);
    hg.gain.exponentialRampToValueAtTime(0.0001, now + cd);
    hum.connect(hg);
    hg.connect(out);
    // 2) 钳口张开刮擦
    const ot = now + cd * 0.55;
    this.nburst(ctx, shot, out, white, ot, 0.02, 0.12, 'bandpass', 3000, 3, 0.04 * sc);
    // 3) 锁定"咔哒"
    const lt = now + cd + 0.02;
    this.mechClick(ctx, shot, out, lt, 0.2 * sc, 2600, 0.03);
    this.mechClick(ctx, shot, out, lt + rnd(0.035, 0.05), 0.08 * sc, 3100, 0.018);
    // 4) 弹簧余振
    const tw = this.oscSource(ctx, shot, 'sine', 520, lt, lt + 0.32);
    tw.frequency.exponentialRampToValueAtTime(500, lt + 0.3);
    const tv = this.oscSource(ctx, shot, 'sine', rnd(9, 13), lt, lt + 0.32);
    const tvd = this.amp(ctx, shot, 6, lt);
    tv.connect(tvd);
    tvd.connect(tw.frequency);
    const twg = this.amp(ctx, shot, 0.0001, lt);
    this.perc(twg.gain, lt, 0.03 * sc, 0.002, 0.28);
    tw.connect(twg);
    twg.connect(out);
    // 5) 链条叮当
    let t = lt + 0.03;
    const links = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < links; i++) {
      const f = rnd(2400, 4200);
      this.tone(ctx, shot, out, 'sine', t, f, f, 0.0005, rnd(0.015, 0.03), rnd(0.008, 0.018) * sc);
      t += rnd(0.03, 0.07);
    }
    shot.seal();
  }

  /**
   * 切换武器：toPistol = 衣料 + 皮套拔枪摩擦 + 掌心握把"啪" + 保险/击锤"咔"；
   * 否则 = 手枪入套摩擦 + 近战木柄握持"笃" + 金属头轻微低鸣
   */
  playWeaponSwap(toPistol: boolean): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !this.masterGain || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const out = this.nearOut(ctx, shot, toPistol ? 0.14 : -0.08);
    this.nburst(ctx, shot, out, white, now, 0.02, 0.12, 'bandpass', rnd(1600, 2200), 0.9, 0.04);
    const lt = now + rnd(0.04, 0.07);
    const lf = this.nburst(ctx, shot, out, pink, lt, 0.03, 0.15, 'bandpass', toPistol ? 900 : 1400, 2, 0.07);
    lf.frequency.exponentialRampToValueAtTime(toPistol ? 1400 : 900, lt + 0.17);
    const t2 = lt + rnd(0.2, 0.25);
    if (toPistol) {
      this.nburst(ctx, shot, out, pink, t2, 0.002, 0.04, 'lowpass', 800, 0.8, 0.12);
      this.mechClick(ctx, shot, out, t2 + rnd(0.12, 0.18), 0.11, 2800, 0.02);
    } else {
      this.woodKnock(ctx, shot, out, t2, 0.14, rnd(190, 240), 0.06);
      const f = rnd(820, 980);
      this.tone(ctx, shot, out, 'sine', t2 + 0.003, f, f * 0.99, 0.002, 0.18, 0.018);
      this.tone(ctx, shot, out, 'sine', t2 + 0.003, f * 2.63, f * 2.6, 0.002, 0.1, 0.008);
    }
    shot.seal();
  }

  /**
   * 老式拨动开关：拨杆压簧的轻预咔 + 翻转"咔哒"（胶木壳体短衰减）+ 壳体闷响；
   * 开灯 = 灯丝点亮的极细"叮" + 微弱 100Hz 嗡声缓起后渐弱；关灯 = 嗡声收束 + 灯丝冷却的细小"嗒"
   */
  playLightSwitch(on: boolean, spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    if (!ctx || !this.masterGain || !this.whiteBuf || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const sc = clamp(route.gainScale, 0.08, 1);
    const out = route.input;
    this.mechClick(ctx, shot, out, now + 0.002, 0.04 * sc, on ? 2600 : 2300, 0.006);
    const t1 = now + rnd(0.012, 0.022);
    this.mechClick(ctx, shot, out, t1, 0.16 * sc, (on ? 1900 : 1650) * rnd(0.96, 1.04), 0.014);
    this.tone(ctx, shot, out, 'triangle', t1, 420, 300, 0.001, 0.025, 0.05 * sc);
    const mkHum = (t: number, rise: number, peak: number, hold: number, fall: number) => {
      const end = t + rise + hold + fall;
      const h1 = this.oscSource(ctx, shot, 'sine', 100, t, end + 0.02);
      const h2 = this.oscSource(ctx, shot, 'triangle', 200, t, end + 0.02);
      const h2g = this.amp(ctx, shot, 0.35, t);
      const lp = this.filt(ctx, shot, 'lowpass', 700, 0.7, t);
      const g = this.amp(ctx, shot, 0.0001, t);
      g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + rise);
      g.gain.linearRampToValueAtTime(Math.max(0.0002, peak * 0.45), t + rise + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      h1.connect(lp);
      h2.connect(h2g);
      h2g.connect(lp);
      lp.connect(g);
      g.connect(out);
    };
    if (on) {
      const t2 = t1 + rnd(0.03, 0.07);
      const f = rnd(6000, 7200);
      this.tone(ctx, shot, out, 'sine', t2, f, f, 0.001, 0.03, 0.01 * sc);
      mkHum(t2, 0.15, 0.012 * sc, 0.7, 0.7);
    } else {
      mkHum(t1, 0.005, 0.01 * sc, 0.02, 0.3);
      this.mechClick(ctx, shot, out, t1 + rnd(0.25, 0.5), 0.015 * sc, 5000, 0.004);
    }
    shot.seal();
  }

  /**
   * 室内木门慢开/慢关的吱呀：吱嘎缓冲按随机音高曲线（3–4 个随机控制点）变速播放 → 移动共振带通；
   * 叠加高 2.6 倍的铰链尖细"吱"与门扇推动空气的低频涌动；每次曲线与时长均不同
   */
  playDoorCreak(spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const pink = this.pinkBuf;
    if (!ctx || !this.masterGain || !pink || this.creakBufs.length === 0 || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const sc = clamp(route.gainScale, 0.08, 1);
    const out = route.input;
    const buf = this.creakBufs[this.creakBufs.length > 1 && Math.random() < 0.7 ? 1 : 0];
    const pts: number[] = [];
    const np = 3 + Math.floor(Math.random() * 2);
    let rMax = 0;
    for (let i = 0; i < np; i++) {
      const r = rnd(0.45, 0.95);
      pts.push(r);
      rMax = Math.max(rMax, r);
    }
    const dur = Math.max(0.6, Math.min(rnd(1.3, 2.4), (buf.duration - 0.05) / rMax));
    const t0 = now + 0.01;
    const end = t0 + dur;
    const mkSrc = (mul: number): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.playbackRate.setValueAtTime(pts[0] * mul, t0);
      for (let i = 1; i < pts.length; i++) {
        s.playbackRate.linearRampToValueAtTime(pts[i] * mul, t0 + (dur * i) / (pts.length - 1));
      }
      s.start(t0, 0);
      s.stop(end + 0.02);
      shot.src(s, end + 0.02);
      return s;
    };
    // 主吱呀
    const s1 = mkSrc(1);
    const bp = this.filt(ctx, shot, 'bandpass', rnd(380, 520), 3.5, t0);
    bp.frequency.linearRampToValueAtTime(rnd(520, 760), t0 + dur * 0.5);
    bp.frequency.linearRampToValueAtTime(rnd(360, 560), end);
    const g = this.amp(ctx, shot, 0.0001, t0);
    const pk = 0.16 * sc;
    g.gain.linearRampToValueAtTime(pk, t0 + 0.15);
    g.gain.linearRampToValueAtTime(pk * rnd(0.55, 1), t0 + dur * 0.5);
    g.gain.linearRampToValueAtTime(pk * rnd(0.5, 0.9), end - 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    s1.connect(bp);
    bp.connect(g);
    g.connect(out);
    // 铰链尖细"吱"
    const s2 = mkSrc(2.6);
    const hbp = this.filt(ctx, shot, 'bandpass', rnd(1400, 2200), 6, t0);
    const hg = this.amp(ctx, shot, 0.0001, t0);
    hg.gain.linearRampToValueAtTime(pk * 0.3, t0 + dur * 0.3);
    hg.gain.linearRampToValueAtTime(pk * rnd(0.05, 0.3), end - 0.2);
    hg.gain.exponentialRampToValueAtTime(0.0001, end);
    s2.connect(hbp);
    hbp.connect(hg);
    hg.connect(out);
    // 门扇推动空气
    const air = this.noiseSource(ctx, shot, pink, t0, dur + 0.05);
    const alp = this.filt(ctx, shot, 'lowpass', 260, 0.7, t0);
    const ag = this.amp(ctx, shot, 0.0001, t0);
    ag.gain.linearRampToValueAtTime(0.05 * sc, t0 + dur * 0.5);
    ag.gain.exponentialRampToValueAtTime(0.0001, end);
    air.connect(alp);
    alp.connect(ag);
    ag.connect(out);
    shot.seal();
  }

  /**
   * 鬼舞：走调八音盒（60%）或女声哼唱（40%）的程序化短旋律（3–6s）——小调音阶随机游走，逐音随机失谐 ±15 音分
   * + 全局慢速摇摆（0.3–0.6Hz，±18 音分），偶发卡顿（停顿/重复一音），尾段发条松弛般渐慢并下沉；远处闷（低通）且湿（大量混响）
   */
  playGhostDance(spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const pink = this.pinkBuf;
    const white = this.whiteBuf;
    if (!ctx || !this.masterGain || !pink || !white || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    let out: AudioNode;
    let sc = 1;
    const lp = this.filt(ctx, shot, 'lowpass', rnd(1300, 1900), 0.7, now);
    if (spatial) {
      const route = this.createSpatialRoute(spatial);
      shot.addAll(route.nodes);
      sc = clamp(route.gainScale, 0.1, 1);
      lp.connect(route.input);
      const srcIndoor = spatial.muffled ? !this.listenerIndoor : this.listenerIndoor;
      const rv = srcIndoor ? this.hutIn : this.forestIn;
      if (rv) {
        const s = this.amp(ctx, shot, 0.55, now);
        lp.connect(s);
        s.connect(rv);
      }
    } else {
      const master: AudioNode = this.masterGain;
      if (typeof ctx.createStereoPanner === 'function') {
        const p = shot.add(ctx.createStereoPanner());
        p.pan.setValueAtTime(randomPan(0.8), now);
        lp.connect(p);
        p.connect(master);
      } else {
        lp.connect(master);
      }
      if (this.roomSend) {
        const s = this.amp(ctx, shot, 0.85, now);
        lp.connect(s);
        s.connect(this.roomSend);
      }
    }
    out = lp;
    const box = Math.random() < 0.6;
    const scale = [0, 2, 3, 5, 7, 8, 10, 12, 14, 15];
    const root = box ? rnd(560, 720) : rnd(250, 320);
    const total = rnd(3.2, 5.6);
    const wobHz = rnd(0.3, 0.6);
    const wobPh = Math.random() * 6.283;
    const cents = (t: number, k: number) => 18 * Math.sin(6.283 * wobHz * t + wobPh) - k * 30;
    const notes: Array<{ t: number; d: number; f: number }> = [];
    let deg = 2 + Math.floor(Math.random() * 3);
    let beat = box ? rnd(0.3, 0.42) : rnd(0.42, 0.6);
    let t = 0.05;
    while (t < total - 0.4 && notes.length < 16) {
      const prog = t / total;
      const tail = smooth01((prog - 0.65) / 0.35);
      const step = Math.random() < 0.7 ? (Math.random() < 0.5 ? -1 : 1) : Math.random() < 0.5 ? -2 : 2;
      deg = clamp(deg + step, 0, scale.length - 1);
      const c = cents(t, tail) + rnd(-15, 15);
      const f = root * Math.pow(2, (scale[deg] * 100 + c) / 1200);
      const d = beat * (Math.random() < 0.2 ? 2 : 1);
      notes.push({ t, d, f });
      t += d;
      if (Math.random() < 0.16) {
        // 卡顿：停顿或重复上一音
        if (Math.random() < 0.5) t += rnd(0.25, 0.6);
        else notes.push({ t, d: beat * 0.6, f: f * Math.pow(2, rnd(-20, 5) / 1200) });
        t += beat * 0.6;
      }
      beat *= 1 + tail * 0.08 + 0.01;
    }
    if (notes.length === 0) notes.push({ t: 0.05, d: 0.5, f: root });
    const vol = (box ? 0.05 : 0.06) * sc;
    if (box) {
      const ratios = [1, 3.01, 5.43];
      const amps = [1, 0.22, 0.07];
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        const tt = now + n.t;
        const dec = rnd(0.7, 1.1);
        const a = vol * rnd(0.7, 1);
        for (let pI = 0; pI < ratios.length; pI++) {
          const fr = Math.min(16000, n.f * ratios[pI]);
          this.tone(ctx, shot, out, 'sine', tt, fr, fr * 0.997, 0.002, dec * (1 - pI * 0.3), a * amps[pI]);
        }
        this.nburst(ctx, shot, out, white, tt, 0.0005, 0.004, 'highpass', 3000, 0.7, a * 0.15);
      }
    } else {
      const last = notes[notes.length - 1];
      const t0 = now + notes[0].t;
      const end = now + last.t + last.d + 0.3;
      const o = this.oscSource(ctx, shot, 'triangle', notes[0].f, t0, end + 0.05);
      const vib = this.oscSource(ctx, shot, 'sine', rnd(4.5, 5.5), t0, end + 0.05);
      const vd = this.amp(ctx, shot, notes[0].f * 0.006, t0);
      vib.connect(vd);
      vd.connect(o.frequency);
      const env = this.amp(ctx, shot, 0.0001, t0);
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        const tt = now + n.t;
        if (i > 0) {
          o.frequency.setValueAtTime(notes[i - 1].f, tt);
          o.frequency.linearRampToValueAtTime(n.f, tt + 0.06);
        }
        env.gain.linearRampToValueAtTime(vol * rnd(0.75, 1), tt + Math.min(0.1, n.d * 0.3));
        env.gain.linearRampToValueAtTime(vol * 0.55, tt + n.d * 0.9);
      }
      env.gain.exponentialRampToValueAtTime(0.0001, end);
      const f1 = this.filt(ctx, shot, 'bandpass', rnd(450, 600), 3, t0);
      const f2 = this.filt(ctx, shot, 'bandpass', rnd(950, 1200), 4, t0);
      const f2g = this.amp(ctx, shot, 0.6, t0);
      o.connect(f1);
      o.connect(f2);
      f1.connect(env);
      f2.connect(f2g);
      f2g.connect(env);
      const br = this.noiseSource(ctx, shot, pink, t0, end - t0 + 0.05);
      const bbp = this.filt(ctx, shot, 'bandpass', 2400, 1.2, t0);
      const bg = this.amp(ctx, shot, 0.25, t0);
      br.connect(bbp);
      bbp.connect(bg);
      bg.connect(env);
      env.connect(out);
    }
    shot.seal();
  }

  /**
   * 幻影闪现：短促吸气/耳语急掠（白噪经两路上扫窄带"共振峰"，急速渐强后骤停，声像左右急掠）
   * + 反向混响感的尾（滤波噪声指数渐强后 15ms 骤断，大量送混响）+ 极弱低频"吸入"压力
   */
  playApparitionFlash(spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !this.masterGain || !white || !pink || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const sc = clamp(route.gainScale, 0.15, 1);
    const base = this.amp(ctx, shot, 1, now);
    base.connect(route.input);
    let out: AudioNode = base;
    if (!spatial && typeof ctx.createStereoPanner === 'function') {
      const side = Math.random() < 0.5 ? -1 : 1;
      const p = shot.add(ctx.createStereoPanner());
      p.pan.setValueAtTime(-0.7 * side, now);
      p.pan.linearRampToValueAtTime(0.7 * side, now + 0.4);
      p.connect(base);
      out = p;
    }
    if (this.roomSend) {
      const s = this.amp(ctx, shot, 0.6, now);
      base.connect(s);
      s.connect(this.roomSend);
    }
    // 1) 吸气急掠
    const rd = rnd(0.3, 0.45);
    const src = this.noiseSource(ctx, shot, white, now, rd + 0.05);
    const hp = this.filt(ctx, shot, 'highpass', 700, 0.7, now);
    const f1 = this.filt(ctx, shot, 'bandpass', rnd(700, 900), 5, now);
    f1.frequency.exponentialRampToValueAtTime(rnd(1400, 1800), now + rd);
    const f2 = this.filt(ctx, shot, 'bandpass', rnd(2000, 2400), 5, now);
    f2.frequency.exponentialRampToValueAtTime(rnd(3200, 3800), now + rd);
    const g2 = this.amp(ctx, shot, 0.7, now);
    const env = this.amp(ctx, shot, 0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.5 * sc, now + rd);
    env.gain.linearRampToValueAtTime(0.0001, now + rd + 0.02);
    src.connect(hp);
    hp.connect(f1);
    hp.connect(f2);
    f1.connect(env);
    f2.connect(g2);
    g2.connect(env);
    env.connect(out);
    // 2) 反向混响尾
    const t1 = now + rd - 0.05;
    const td = rnd(0.55, 0.8);
    const rs = this.noiseSource(ctx, shot, pink, t1, td + 0.05);
    const rbp = this.filt(ctx, shot, 'bandpass', rnd(1200, 1800), 0.8, t1);
    rbp.frequency.exponentialRampToValueAtTime(rnd(2400, 3000), t1 + td);
    const rg = this.amp(ctx, shot, 0.0001, t1);
    rg.gain.exponentialRampToValueAtTime(0.09 * sc, t1 + td);
    rg.gain.linearRampToValueAtTime(0.0001, t1 + td + 0.015);
    rs.connect(rbp);
    rbp.connect(rg);
    rg.connect(base);
    if (this.roomSend) {
      const s = this.amp(ctx, shot, 0.9, t1);
      rg.connect(s);
      s.connect(this.roomSend);
    }
    // 3) 低频吸入
    const lo = this.oscSource(ctx, shot, 'sine', 70, now, now + rd + 0.05);
    lo.frequency.exponentialRampToValueAtTime(110, now + rd);
    const lg = this.amp(ctx, shot, 0.0001, now);
    lg.gain.linearRampToValueAtTime(0.06 * sc, now + rd * 0.8);
    lg.gain.linearRampToValueAtTime(0.0001, now + rd + 0.03);
    lo.connect(lg);
    lg.connect(base);
    shot.seal();
  }

  /**
   * 头撞木桌：克制的闷"咚"（低频正弦 + 桌面板共鸣 + 中频木质敲击，无血肉成分）→ 桌腿在地板上摇晃的 2–4 次"咯噔"（渐快渐弱）
   * → 桌面器物跳动的 2–5 声叮当（玻璃/铁罐非谐和短分音）；隔墙传播走空间路由的 muffled 逻辑
   */
  playTableBang(intensity01: number, spatial?: SpatialAudioOpts): void {
    const ctx = this.ctx;
    const white = this.whiteBuf;
    const pink = this.pinkBuf;
    if (!ctx || !this.masterGain || !white || !pink || this.muted || this.pageHidden) return;
    const k = Number.isFinite(intensity01) ? clamp(intensity01, 0.1, 1) : 0.6;
    const now = ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const shot = new OneShot();
    shot.addAll(route.nodes);
    const sc = clamp(route.gainScale, 0.08, 1) * (0.45 + 0.55 * k);
    const out = route.input;
    // 1) 闷咚
    this.tone(ctx, shot, out, 'sine', now, 110 * rnd(0.92, 1.08), 55, 0.003, 0.14, 0.32 * sc);
    this.nburst(ctx, shot, out, pink, now, 0.002, 0.15, 'bandpass', rnd(190, 240), 2.5, 0.45 * sc);
    this.nburst(ctx, shot, out, white, now, 0.001, 0.03, 'bandpass', rnd(600, 800), 1.5, 0.12 * sc);
    // 2) 桌腿咯噔
    let t = now + rnd(0.07, 0.1);
    let gap = rnd(0.09, 0.13);
    let a = 0.16 * sc;
    const legs = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < legs; i++) {
      this.woodKnock(ctx, shot, out, t, a, rnd(260, 380), 0.05);
      t += gap;
      gap *= rnd(0.6, 0.8);
      a *= rnd(0.5, 0.7);
    }
    // 3) 器物叮当
    const items = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < items; i++) {
      const ti = now + rnd(0.02, 0.3);
      const f = rnd(1800, 4200);
      const vol = rnd(0.012, 0.03) * sc * (0.6 + 0.4 * k);
      this.tone(ctx, shot, out, 'sine', ti, f, f, 0.0006, rnd(0.04, 0.12), vol);
      this.tone(ctx, shot, out, 'sine', ti, f * 2.32, f * 2.32, 0.0006, rnd(0.02, 0.06), vol * 0.4);
      this.nburst(ctx, shot, out, white, ti, 0.0004, 0.003, 'highpass', 3000, 0.7, vol * 0.8);
    }
    shot.seal();
  }

  // ═══════════════════════════ 提示音（UI 类，保持干声） ═══════════════════════════

  /**
   * 拾取/安装信号中继零件与破晓撤离时的苏式短波无线电嗡鸣与清脆提示音
   */
  playRelayChime(complete: boolean) {
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();

    // 1. 短波无线电静电脉冲底噪
    if (this.whiteBuf) {
      const sDur = complete ? 0.55 : 0.24;
      const staticSrc = this.noiseSource(ctx, shot, this.whiteBuf, now, sDur + 0.04);
      const bp = this.filt(ctx, shot, 'bandpass', 2150, 2.8, now);
      const sg = this.amp(ctx, shot, 0.001, now);
      sg.gain.linearRampToValueAtTime(0.055, now + 0.03);
      sg.gain.exponentialRampToValueAtTime(0.0001, now + sDur);
      staticSrc.connect(bp);
      bp.connect(sg);
      sg.connect(master);
    }

    // 2. 苏式短波载波嗡鸣
    const hum = this.oscSource(ctx, shot, 'sine', complete ? 220 : 196, now, now + (complete ? 0.75 : 0.32));
    hum.frequency.exponentialRampToValueAtTime(complete ? 261.6 : 220, now + (complete ? 0.65 : 0.28));
    const humG = this.amp(ctx, shot, 0.001, now);
    humG.gain.linearRampToValueAtTime(0.065, now + 0.04);
    humG.gain.exponentialRampToValueAtTime(0.0001, now + (complete ? 0.72 : 0.3));
    hum.connect(humG);
    humG.connect(master);

    // 3. 清脆无线电应答电码音列
    const notes = complete ? [523.25, 659.25, 783.99, 1046.5] : [622.25, 880.0];
    const step = complete ? 0.11 : 0.09;
    notes.forEach((freq, idx) => {
      const t0 = now + 0.04 + idx * step;
      const osc = this.oscSource(ctx, shot, 'triangle', freq, t0, t0 + (complete ? 0.45 : 0.26));
      const g = this.amp(ctx, shot, 0.001, t0);
      g.gain.linearRampToValueAtTime(complete ? 0.12 : 0.095, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (complete ? 0.42 : 0.24));
      osc.connect(g);
      g.connect(master);
    });
    shot.seal();
  }

  playLootChime() {
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const notes = [330, 440];
    notes.forEach((freq, idx) => {
      const t0 = now + idx * 0.07;
      const osc = this.oscSource(ctx, shot, 'triangle', freq, t0, t0 + 0.24);
      const g = this.amp(ctx, shot, 0.001, t0);
      g.gain.linearRampToValueAtTime(0.09, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(g);
      g.connect(master);
    });
    shot.seal();
  }

  /**
   * 昼夜交替的远处号角：保留原音色，改走室外总线（进屋自然闷化）并送入森林混响，营造林间远距感
   */
  playPhaseHorn(night: boolean) {
    const ctx = this.ctx;
    const master = this.masterGain;
    if (!ctx || !master || this.muted || this.pageHidden) return;
    const now = ctx.currentTime;
    const shot = new OneShot();
    const osc = this.oscSource(ctx, shot, 'sawtooth', night ? 65.4 : 110, now, now + 1.65);
    osc.frequency.exponentialRampToValueAtTime(night ? 58.2 : 146.8, now + 1.4);
    const f = this.filt(ctx, shot, 'lowpass', night ? 220 : 380, 1, now);
    const g = this.amp(ctx, shot, 0.001, now);
    g.gain.linearRampToValueAtTime(0.16, now + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
    osc.connect(f);
    f.connect(g);
    g.connect(this.outdoorBus ?? master);
    if (this.forestIn) {
      const send = this.amp(ctx, shot, 0.45, now);
      g.connect(send);
      send.connect(this.forestIn);
    }
    shot.seal();
  }
}

export const AudioFX = new SoundEngine();
