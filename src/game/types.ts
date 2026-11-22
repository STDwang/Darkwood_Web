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
