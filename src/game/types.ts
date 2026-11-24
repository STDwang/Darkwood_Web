// Shared types for Blackwood Ember (Steam-grade Eastern European Painterly Horror)

export type GameMode = 'title' | 'play' | 'hold' | 'dead' | 'victory';
export type TimePhase = 'day' | 'dusk' | 'night';
export type WeatherKind = 'mist' | 'drizzle' | 'storm';

export type ResourceKey = 'wood' | 'scrap' | 'fuel' | 'herbs' | 'battery' | 'essence';

export interface Inventory {
  wood: number;
  scrap: number;
  fuel: number;
  herbs: number;
  battery: number;
  essence: number;
  flares: number;
  bandages: number;
  traps: number;
  weaponTier: 1 | 2; // 1 = Spiked Board, 2 = Rusted Axe
  relayParts: number; // 已拾取但尚未安装的信号中继零件数
  /** 手枪备弹（弹匣内子弹在 engine.equip.mag；稀缺资源，部分容器少量掉落） */
  ammo: number;
}

/** 可拖拽重型家具防线实体（单源真相：同时参与碰撞与遮挡） */
export interface MovableFurniture {
  id: string;
  kind: 'sofa' | 'cabinet' | 'table';
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  hitFlash: number;
}

/** 远方地标可搜集的信号中继零件节点 */
export interface RelayNode {
  id: string;
  zone: string;
  x: number;
  y: number;
  collected: boolean;
}

export interface WeatherState {
  kind: WeatherKind;
  rainIntensity: number; // 0..1
  wetness: number; // 0..1 ground puddle & specular moisture
  lightningFlash: number; // 0..1 instantaneous sky flash
  lightningAngle: number;
  windAngle: number;
}

export interface DecalEvent {
  kind: 'blood' | 'splatter' | 'corpse' | 'wood' | 'scorch' | 'footprint';
  x: number;
  y: number;
  angle: number;
  scale: number;
  seed: number;
  left?: boolean;
  enemyKind?: EnemyKind;
}

export interface JournalEntry {
  id: number;
  day: number;
  phase: TimePhase;
  title: string;
  body: string;
}

export interface RainDrop {
  active: boolean;
  x: number;
  y: number;
  len: number;
  speed: number;
  alpha: number;
  layer: 0 | 1; // 0 = 中景细密雨丝，1 = 近景粗快受光雨线
}

export interface RainRipple {
  active: boolean;
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
}

export interface RectObstacle {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'wall' | 'ruin_wall' | 'truck' | 'table';
  blocksLight: boolean;
}

export interface TreeObstacle {
  id: number;
  x: number;
  y: number;
  trunkR: number;
  canopyR: number;
  hueShift: number;
  phase: number;
}

export interface RockObstacle {
  id: number;
  x: number;
  y: number;
  r: number;
  seed: number;
}

/** 原作风格地表场景物件（盘根树墩、残破木板桥、荒废茶田、围栏小地窖、独轮手推车、散落原木） */
export type WorldPropKind = 'stump' | 'bridge' | 'teaField' | 'cellar' | 'wheelbarrow' | 'fallenLog';

export interface WorldProp {
  id: number;
  kind: WorldPropKind;
  x: number;
  y: number;
  angle: number;
  /** 主尺寸（树墩半径 / 桥长度 / 茶田宽度等） */
  w: number;
  /** 次尺寸（桥宽度 / 茶田高度 / 原木数量等） */
  h: number;
  seed: number;
}

export interface BarricadeSlot {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  orientation: 'h' | 'v';
  hp: number;
  maxHp: number;
  kind: 'door' | 'window';
}

export interface LootContainer {
  id: string;
  x: number;
  y: number;
  r: number;
  kind: 'crate' | 'backpack' | 'barrel' | 'logpile' | 'toolbox' | 'corpse';
  zone: string;
  searched: boolean;
  searchDuration: number;
  loot: Partial<Record<ResourceKey, number>>;
  angle: number;
}

export interface EssenceNode {
  id: string;
  x: number;
  y: number;
  harvested: boolean;
  pulsePhase: number;
}

export interface FloorZone {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  surface: 'wood' | 'mud' | 'gravel';
}

export interface BearTrap {
  id: number;
  x: number;
  y: number;
  armed: boolean;
  snaredTimer: number;
  /** 放置时钢齿张开动画进度 0..1（equipment 推进，renderer 只读；旧数据缺省视为已张开） */
  openT?: number;
}

export interface ActiveFlare {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

export type EnemyKind = 'stalker' | 'hound' | 'banshee';

export interface Enemy {
  id: number;
  kind: EnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  r: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  state: 'prowl' | 'stalk' | 'chase' | 'attack_barricade' | 'snared' | 'flee_dawn';
  attackCd: number;
  hitFlash: number;
  snareTimer: number;
  stalkTimer: number; // 门窗外窥伺试探计时器（秒）
  stalkRippleCd: number; // 窥伺期刮擦门板声波间隔
  stepTimer: number;
  walkPhase: number;
  clawPhase: number;
  targetBarricadeId: string | null;
  patrolX: number;
  patrolY: number;
  /** 攻击前摇剩余秒数（>0 表示正在蓄势后仰，结束瞬间扑击结算；与 attackCd 串行） */
  windup: number;
  /** 本次前摇总时长（秒），供渲染计算前摇进度 */
  windupDur: number;
  /** 扑击前冲可视计时（秒，递减） */
  lunge: number;
  /** 窥伺伏低混合 0..1（engine 平滑推进，渲染只读） */
  crouch: number;
  /** 抓挠/扑击交替出手侧（1 / -1） */
  clawSide: number;
}

/** 怪物死亡倒地动画实体（预分配池；结束淡出时才烘焙尸体贴花） */
export interface DyingEnemy {
  active: boolean;
  kind: EnemyKind;
  x: number;
  y: number;
  angle: number;
  r: number;
  /** 倒地方向（世界角度，通常为致命一击方向） */
  fallDir: number;
  /** 已过秒数 */
  timer: number;
  walkPhase: number;
  seed: number;
  decalPushed: boolean;
}

/** 乌鸦个体（预分配池，零 GC） */
export interface Crow {
  active: boolean;
  /** 所属鸦群索引 */
  flock: number;
  state: 'ground' | 'perched' | 'takeoff' | 'fly' | 'landing';
  x: number;
  y: number;
  /** 离地高度 0..1（渲染视差与俯视大小缩放用） */
  z: number;
  vx: number;
  vy: number;
  angle: number;
  /** ground/perched：下次动作倒计时；takeoff：错峰起飞延迟 */
  timer: number;
  /** 啄食动作 1→0 */
  peck: number;
  /** 跳步动作 1→0 */
  hop: number;
  /** 张喙鸣叫 1→0 */
  caw: number;
  /** 树枝抖羽/微扇翅膀 1→0 */
  preen: number;
  wingPhase: number;
  flyTime: number;
  seed: number;
  /** 栖息树索引（对应 world.trees 下标，-1 表示在地面） */
  treeId: number;
  /** 相对树心的枝头停靠偏移（世界 px） */
  perchOffX: number;
  perchOffY: number;
  /** 受手电直射或靠近时的警觉度 0..1 */
  alert: number;
  /** landing 飞回降落的目标坐标、目标高度与落位状态 */
  targetX: number;
  targetY: number;
  targetZ: number;
  targetState: 'ground' | 'perched';
}

/** 鸦群（预分配池） */
export interface CrowFlock {
  active: boolean;
  x: number;
  y: number;
  alarmed: boolean;
  cawCd: number;
}

/** 玩家限时交互动作种类（Darkwood 式：按下开始，自动进行至完成或被打断） */
export type PlayerActionKind = 'none' | 'search' | 'barricade' | 'harvest' | 'refuel';

/** 玩家当前限时交互动作（engine.updatePlayer 唯一推进） */
export interface PlayerAction {
  kind: PlayerActionKind;
  /** 已进行秒数 */
  timer: number;
  /** 总时长（秒） */
  duration: number;
  /** 目标 id：容器 / 门窗 / 幽光菇 id；加油为 'generator' */
  targetId: string;
  targetX: number;
  targetY: number;
  /** 钉板已完成锤击次数 0..3 */
  hitsDone: number;
  /** 搜刮翻找音效倒计时 */
  sfxCd: number;
  /** 搜刮材质（决定翻找音色） */
  material: 'wood' | 'metal' | 'cloth';
  /** 动作期间锁定朝向（平滑转向目标） */
  faceAngle: number;
}

/** 玩家姿态混合层（engine 推进的时间平滑权重，renderer 只读，不写回） */
export interface PlayerPose {
  /** 行走混合 0..1 */
  move: number;
  /** 疾跑混合 0..1 */
  sprint: number;
  /** 限时交互姿态混合 0..1 */
  action: number;
  /** 当前/最近一次交互姿态（淡出期间保留，保证收势不跳变） */
  actionKind: PlayerActionKind;
  /** 最近一次交互动作进度 0..1（淡出期间冻结） */
  actionProgress: number;
  /** 蓄力后拉混合 0..1 */
  charge: number;
  /** 体力耗尽扶膝喘息混合 0..1 */
  exhaust: number;
  /** 体力耗尽滞回标记（<10 进入，>38 退出） */
  exhausted: boolean;
  /** 受击后仰计时（秒，递减） */
  hurt: number;
  /** 受击来向（世界角度） */
  hurtAngle: number;
  /** 闪避落地屈膝计时（秒，递减） */
  land: number;
  /** 锤击砸下瞬间计时（秒，递减） */
  hammerImpact: number;
  /** 满蓄微闪计时（秒，递减） */
  chargeFull: number;
  /** 闪避残影（3 帧环形缓冲：x/y/朝向/剩余寿命） */
  ghostX: number[];
  ghostY: number[];
  ghostA: number[];
  ghostLife: number[];
  ghostCursor: number;
  ghostCd: number;
  /** 腿部步态相位（单位：步，0..2 循环；整数时刻 = 脚落地帧，与 playFootstep 同步；cos(π·gait)>0 左脚在前） */
  gait: number;
}

export interface SoundRipple {
  active: boolean;
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
  color: string;
}

export interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  color: string;
  kind: 'ember' | 'blood' | 'wood' | 'spark' | 'smoke' | 'spore' | 'dust' | 'splash';
}

export interface Footprint {
  active: boolean;
  x: number;
  y: number;
  angle: number;
  left: boolean;
  life: number;
  maxLife: number;
}

export interface CraftRecipe {
  id: string;
  name: string;
  desc: string;
  cost: Partial<Record<ResourceKey, number>>;
  outputText: string;
  oneTime?: boolean;
}

export interface InteractPrompt {
  label: string;
  worldX: number;
  worldY: number;
  progress: number; // 0..1 while searching
  hold: boolean;
}

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'info' | 'warn' | 'danger' | 'loot';
  timer: number;
}

export interface HudSnapshot {
  mode: GameMode;
  day: number;
  phase: TimePhase;
  phaseProgress: number; // 0..1 within current phase
  dayTime: number; // 0..1 full cycle
  weather: WeatherKind;
  rainIntensity: number;
  wetness: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  battery: number;
  flashlightOn: boolean;
  generatorFuel: number; // 0..100
  generatorOn: boolean;
  inHideout: boolean;
  zoneName: string;
  playerX: number;
  playerY: number;
  inv: Inventory;
  activeSlot: number;
  prompt: InteractPrompt | null;
  toasts: ToastMessage[];
  containersLooted: number;
  totalContainers: number;
  enemiesDefeated: number;
  essenceCollected: number;
  dangerLevel: number;
  discoveredZones: string[];
  journal: JournalEntry[];
  relayParts: number;
  relayInstalled: number;
  relayCollectedZones: string[];
  draggingFurniture: boolean;
  objectiveText: string;
  endlessMode: boolean;
  chargeRatio: number;
  backend: 'webgl2' | 'canvas2d';
  fps: number;
  entities: number;
  /** R3 装备：当前武器与弹药（可选字段，旧快照缺省兼容） */
  equip?: EquipHudInfo;
}

/** HUD 用装备摘要（engine/equipment.ts 生成，UI 只读） */
export interface EquipHudInfo {
  mode: 'torch' | 'pistol';
  mag: number;
  magSize: number;
  reserve: number;
  torchInHand: boolean;
  torchLit: boolean;
  /** 手中火把燃料 0..100 */
  torchFuel: number;
  reloading: boolean;
}

export interface PilotInput {
  mx: number;
  my: number;
  aimAngle: number;
  sprint: boolean;
  attack: boolean;
  interact: boolean;
  toggleLight: boolean;
  dodge?: boolean;
}
