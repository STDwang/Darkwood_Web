// 建筑与房间系统（第三轮关卡执行）：静态布局单源真相
// - 每栋建筑：外框、房间列表、内墙（含门洞）、窗、可开关室内门、家具摆件、灯具、屋顶矩形、可搜刮容器
// - 静态几何（墙/窗/家具碰撞盒）在模块加载时由 createBuildingLayouts() 一次性生成，world.ts 只读引用；
//   动态状态（门开合、灯开关）由 createWorld() 每局克隆到 world.interiorDoors / world.lights，
//   且只由 engine 通过本文件的纯函数推进（渲染层只读）
// - 本文件不依赖 world.ts（避免循环引用），只依赖 types / util

import { LootContainer, MovableFurniture, RectObstacle } from './types';
import { Vec2, dist } from './util';

export type RoomKind =
  | 'living'
  | 'bedroom'
  | 'kitchen'
  | 'storage'
  | 'pantry'
  | 'clinic'
  | 'pharmacy'
  | 'cellar'
  | 'hall'
  | 'attic'
  | 'nave'
  | 'apse'
  | 'vestry'
  | 'foyer'
  | 'barn'
  | 'workshop'
  | 'office'
  | 'bunk'
  | 'tackle'
  | 'power';

/** 房间地面材质：木板 / 瓷砖 / 泥地 / 石板 / 干草 */
export type FloorKind = 'plank' | 'tile' | 'dirt' | 'stone' | 'hay';
export type LightKind = 'pendant' | 'oil' | 'desk' | 'candle';
export type WallStyle = 'timber' | 'masonry' | 'ruin';

export interface BuildingRoom {
  id: string;
  name: string;
  kind: RoomKind;
  floor: FloorKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BuildingWindow {
  x: number;
  y: number;
  w: number;
  h: number;
  orientation: 'h' | 'v';
  /** 钉板数量 0..3（0 = 只剩碎玻璃） */
  boarded: number;
  seed: number;
}

/** 家具 / 叙事摆件（x,y 为左上角世界坐标，w,h 为尺寸；线状摆件 x,y 为起点、w,h 为位移向量） */
export interface BuildingProp {
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  seed: number;
  /** 0 = 纯装饰，1 = 低矮实体（挡移动不挡光），2 = 高大实体（挡移动也挡光） */
  solid: number;
}

/** 可开关室内门（关闭时阻挡怪物与光线；玩家推门即开，怪物持续撞门约 1.5s 破开） */
export interface InteriorDoor {
  id: string;
  building: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 'h' = 门位于水平墙上（沿 x 方向开口），'v' = 门位于竖直墙上 */
  orientation: 'h' | 'v';
  open: boolean;
  /** 开合动画 0..1（engine 推进，渲染只读） */
  openT: number;
  /** 合页端：1 = 起点端（左/上），-1 = 终点端（右/下） */
  hinge: number;
  /** 门扇外摆方向：1 = 朝 +y/+x，-1 = 朝 -y/-x */
  swing: number;
  /** 怪物撞门累计秒数 */
  bash: number;
  exterior: boolean;
}

/** 建筑灯具（吊灯 / 油灯 / 台灯 / 蜡烛） */
export interface BuildingLight {
  id: string;
  building: number;
  room: string;
  kind: LightKind;
  x: number;
  y: number;
  /** 交互点（墙上拉线开关；油灯/蜡烛即灯本身） */
  switchX: number;
  switchY: number;
  on: boolean;
  /** 灯泡已坏：开关只有咔哒声，不会亮 */
  broken: boolean;
  /** 接触不良：亮着但频繁闪烁 */
  faulty: boolean;
  /** 需要庇护所发电机供电（无电不亮） */
  powered: boolean;
  radius: number;
  intensity: number;
  r: number;
  g: number;
  b: number;
  seed: number;
  /** 最近一次开关的 simTime（渲染用于灯丝升温/余辉过渡；-99 表示开局状态） */
  toggledAt: number;
}

/** 建筑类别（供 haunts 等系统按类别匹配：'church' 教堂 / 'village' 村落民居 …） */
export type BuildingKind =
  | 'hideout'
  | 'mill'
  | 'farm'
  | 'village'
  | 'church'
  | 'doctor'
  | 'fishing'
  | 'radio'
  | 'rail';

export interface Building {
  id: string;
  /** 显示名（教堂含"教堂"、村落民居含"村落"字样） */
  name: string;
  /** 所属地标名（与 poiCenters / LootContainer.zone 一致） */
  zone: string;
  kind: BuildingKind;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  t: number;
  style: WallStyle;
  chimney: boolean;
  /** 屋顶由 renderer 既有逻辑绘制（庇护所 / 锯木厂），本系统不重复画顶 */
  externalRoof: boolean;
  hasEntry: boolean;
  entryOut: Vec2;
  entryIn: Vec2;
  rooms: BuildingRoom[];
  windows: BuildingWindow[];
  props: BuildingProp[];
  walls: RectObstacle[];
  doorSpecs: InteriorDoor[];
  lightSpecs: BuildingLight[];
  containerSpecs: LootContainer[];
  /** 建筑内可拖拽家具（每局克隆进 world.movables，例如医生之屋候诊室的长桌） */
  movableSpecs: MovableFurniture[];
  doorStart: number;
  doorCount: number;
  lightStart: number;
  lightCount: number;
  seq: number;
}

interface Opening {
  at: number;
  len: number;
  kind: 'door' | 'doorway' | 'window';
  open?: boolean;
  boarded?: number;
  hinge?: number;
  swing?: number;
}

export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 室外叙事摆件与铁轨等静态布局 */
export interface BuildingLayout {
  buildings: Building[];
  yardProps: BuildingProp[];
  yardWalls: RectObstacle[];
  rails: Vec2[][];
  /** 树木/巨石避让矩形（建筑院落、墓地、信号塔基座等） */
  clearRects: RectLike[];
}

// 实体摆件分类：1 = 低矮实体，2 = 高大实体（挡光）
const SOLID_KIND: Record<string, number> = {
  bed: 1,
  cot: 1,
  table: 1,
  desk: 1,
  stove: 1,
  counter: 1,
  exam_table: 1,
  pew: 1,
  altar: 1,
  hay: 1,
  cart: 1,
  workbench: 1,
  crates: 1,
  transformer: 1,
  bunk: 1,
  well: 1,
  tombstone: 1,
  handcar: 1,
  rowboat: 1,
  sawhorse: 1,
  fence: 1,
  tower_leg: 1,
  bathtub: 1,
  wardrobe: 2,
  shelf: 2,
  cabinet_med: 2,
  electric: 2,
};

function newBuilding(
  id: string,
  name: string,
  zone: string,
  kind: BuildingKind,
  x: number,
  y: number,
  w: number,
  h: number,
  style: WallStyle,
  chimney: boolean,
  t: number
): Building {
  return {
    id,
    name,
    zone,
    kind,
    index: -1,
    x,
    y,
    w,
    h,
    t,
    style,
    chimney,
    externalRoof: false,
    hasEntry: false,
    entryOut: { x: x + w * 0.5, y: y + h + 30 },
    entryIn: { x: x + w * 0.5, y: y + h - 40 },
    rooms: [],
    windows: [],
    props: [],
    walls: [],
    doorSpecs: [],
    lightSpecs: [],
    containerSpecs: [],
    movableSpecs: [],
    doorStart: 0,
    doorCount: 0,
    lightStart: 0,
    lightCount: 0,
    seq: 0,
  };
}

function wallKindOf(b: Building): 'wall' | 'ruin_wall' {
  return b.style === 'timber' ? 'wall' : 'ruin_wall';
}

function pushWall(b: Building, horiz: boolean, fixed: number, s: number, e: number, thick: number) {
  b.walls.push({
    id: b.id + '_w' + b.seq++,
    x: horiz ? s : fixed,
    y: horiz ? fixed : s,
    w: horiz ? e - s : thick,
    h: horiz ? thick : e - s,
    kind: wallKindOf(b),
    blocksLight: true,
  });
}

function addOpening(
  b: Building,
  horiz: boolean,
  fixed: number,
  s: number,
  e: number,
  thick: number,
  op: Opening,
  exterior: boolean
) {
  const rx = horiz ? s : fixed;
  const ry = horiz ? fixed : s;
  const rw = horiz ? e - s : thick;
  const rh = horiz ? thick : e - s;
  if (op.kind === 'window') {
    // 窗：挡移动、不挡光（月光/手电可从窗洞照入）
    b.walls.push({ id: b.id + '_win' + b.seq++, x: rx, y: ry, w: rw, h: rh, kind: 'table', blocksLight: false });
    b.windows.push({
      x: rx,
      y: ry,
      w: rw,
      h: rh,
      orientation: horiz ? 'h' : 'v',
      boarded: op.boarded === undefined ? 1 : op.boarded,
      seed: (b.seq * 37 + Math.floor(rx * 3 + ry * 7)) % 997,
    });
  } else if (op.kind === 'door') {
    const isOpen = op.open === true;
    b.doorSpecs.push({
      id: b.id + '_door' + b.seq++,
      building: -1,
      x: rx,
      y: ry,
      w: rw,
      h: rh,
      orientation: horiz ? 'h' : 'v',
      open: isOpen,
      openT: isOpen ? 1 : 0,
      hinge: op.hinge === undefined ? 1 : op.hinge,
      swing: op.swing === undefined ? 1 : op.swing,
      bash: 0,
      exterior,
    });
  }
  // 'doorway'：纯门洞，不生成实体
}

/** 生成一段墙（沿 horiz 方向从 from 到 to，fixed 为垂直方向坐标），在 openings 处切开 */
function run(
  b: Building,
  horiz: boolean,
  fixed: number,
  from: number,
  to: number,
  thick: number,
  ops: Opening[],
  exterior: boolean
) {
  const base = horiz ? b.x : b.y;
  const sorted = ops.slice().sort(function (a, c) {
    return a.at - c.at;
  });
  let cur = from;
  for (let i = 0; i < sorted.length; i++) {
    const op = sorted[i];
    const s = Math.max(from, base + op.at);
    const e = Math.min(to, base + op.at + op.len);
    if (e <= s) continue;
    if (s - cur > 0.5) pushWall(b, horiz, fixed, cur, s, thick);
    addOpening(b, horiz, fixed, s, e, thick, op, exterior);
    cur = Math.max(cur, e);
  }
  if (to - cur > 0.5) pushWall(b, horiz, fixed, cur, to, thick);
}

/** 外墙一侧：'n' | 's' | 'w' | 'e'；开口 at 为本地坐标（n/s 沿 x，w/e 沿 y） */
function ext(b: Building, side: string, ops: Opening[]) {
  const t = b.t;
  if (side === 'n') run(b, true, b.y, b.x, b.x + b.w, t, ops, true);
  else if (side === 's') run(b, true, b.y + b.h - t, b.x, b.x + b.w, t, ops, true);
  else if (side === 'w') run(b, false, b.x, b.y + t, b.y + b.h - t, t, ops, true);
  else run(b, false, b.x + b.w - t, b.y + t, b.y + b.h - t, t, ops, true);
}

/** 竖直内墙：本地 x = lx（左缘），从本地 ly0 到 ly1 */
function partV(b: Building, lx: number, ly0: number, ly1: number, ops: Opening[], thick = 10) {
  run(b, false, b.x + lx, b.y + ly0, b.y + ly1, thick, ops, false);
}

/** 水平内墙：本地 y = ly（上缘），从本地 lx0 到 lx1 */
function partH(b: Building, ly: number, lx0: number, lx1: number, ops: Opening[], thick = 10) {
  run(b, true, b.y + ly, b.x + lx0, b.x + lx1, thick, ops, false);
}

function room(
  b: Building,
  id: string,
  name: string,
  kind: RoomKind,
  floor: FloorKind,
  lx0: number,
  ly0: number,
  lx1: number,
  ly1: number
) {
  b.rooms.push({ id: b.id + '_' + id, name, kind, floor, x: b.x + lx0, y: b.y + ly0, w: lx1 - lx0, h: ly1 - ly0 });
}

function makeProp(kind: string, x: number, y: number, w: number, h: number, rot: number, seed: number): BuildingProp {
  const s = SOLID_KIND[kind];
  return { kind, x, y, w, h, rot, seed, solid: s === undefined ? 0 : s };
}

function prop(b: Building, kind: string, lx: number, ly: number, w: number, h: number, rot = 0) {
  const p = makeProp(kind, b.x + lx, b.y + ly, w, h, rot, (b.seq * 53 + b.props.length * 17 + 11) % 1009);
  b.seq++;
  b.props.push(p);
  if (p.solid > 0) {
    b.walls.push({
      id: b.id + '_p' + b.seq++,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      kind: 'table',
      blocksLight: p.solid === 2,
    });
  }
}

function lamp(
  b: Building,
  roomId: string,
  kind: LightKind,
  lx: number,
  ly: number,
  sx: number,
  sy: number,
  on: boolean,
  broken: boolean,
  powered: boolean,
  faulty = false,
  tint = 0
) {
  const radius = kind === 'pendant' ? 215 : kind === 'oil' ? 158 : kind === 'desk' ? 130 : 98;
  const intensity = kind === 'pendant' ? 1.95 : kind === 'oil' ? 1.6 : kind === 'desk' ? 1.45 : 1.15;
  // tint：0 = 暖黄钨丝/火焰，1 = 铁道信号红灯
  const r = 1.0;
  const g = tint === 1 ? 0.34 : kind === 'candle' || kind === 'oil' ? 0.66 : 0.78;
  const bl = tint === 1 ? 0.24 : kind === 'candle' || kind === 'oil' ? 0.34 : 0.5;
  b.lightSpecs.push({
    id: b.id + '_lamp' + b.seq++,
    building: -1,
    room: b.id + '_' + roomId,
    kind,
    x: b.x + lx,
    y: b.y + ly,
    switchX: b.x + sx,
    switchY: b.y + sy,
    on,
    broken,
    faulty,
    powered,
    radius,
    intensity,
    r,
    g,
    b: bl,
    seed: (b.seq * 7.31 + lx * 0.13 + ly * 0.07) % 97,
    toggledAt: -99,
  });
}

function loot(
  b: Building,
  kind: LootContainer['kind'],
  lx: number,
  ly: number,
  contents: Partial<Record<'wood' | 'scrap' | 'fuel' | 'herbs' | 'battery' | 'essence', number>>,
  angle = 0
) {
  b.containerSpecs.push({
    id: 'c_' + b.id + '_' + b.containerSpecs.length,
    x: b.x + lx,
    y: b.y + ly,
    r: 17,
    kind,
    zone: b.zone,
    searched: false,
    searchDuration: 1.4,
    loot: contents,
    angle,
  });
}

function entry(b: Building, oxl: number, oyl: number, ixl: number, iyl: number) {
  b.hasEntry = true;
  b.entryOut = { x: b.x + oxl, y: b.y + oyl };
  b.entryIn = { x: b.x + ixl, y: b.y + iyl };
}

function yard(list: BuildingProp[], walls: RectObstacle[], kind: string, x: number, y: number, w: number, h: number, rot = 0) {
  const p = makeProp(kind, x, y, w, h, rot, (list.length * 61 + 7) % 1013);
  list.push(p);
  if (p.solid > 0) {
    walls.push({ id: 'yard_' + list.length, x, y, w, h, kind: 'table', blocksLight: p.solid === 2 });
  }
}

// ---------------------------------------------------------------------------
// 各建筑布局（本地坐标：相对建筑外框左上角）
// ---------------------------------------------------------------------------

/** 庇护所：外墙/门窗木板/发电机/工作台由 world.ts 既有逻辑生成，此处只生成内墙、内门、房间、灯与摆件 */
function buildHideout(rect: RectLike): Building {
  const b = newBuilding('h_in', '庇护所', '庇护所', 'hideout', rect.x, rect.y, rect.w, rect.h, 'timber', true, 18);
  b.externalRoof = true;
  // 本地坐标：lx = 世界 x + 280，ly = 世界 y + 240（外框 560 × 380）
  // 西翼隔墙（主屋 | 卧室/储藏间），门洞在世界 y -50..0
  partV(b, 128, 18, 362, [{ at: 190, len: 50, kind: 'doorway' }], 12);
  // 西翼横墙（卧室 | 储藏间），可开关木门在世界 x -198..-156
  partH(b, 120, 18, 128, [{ at: 82, len: 42, kind: 'door', open: false, hinge: 1, swing: -1 }], 12);
  // 东翼隔墙（主屋 | 工作间），门洞在世界 y -10..40
  partV(b, 420, 18, 362, [{ at: 230, len: 50, kind: 'doorway' }], 12);

  room(b, 'main', '主屋', 'living', 'plank', 140, 18, 420, 362);
  room(b, 'bed', '卧室', 'bedroom', 'plank', 18, 132, 128, 362);
  room(b, 'store', '储藏间', 'storage', 'dirt', 18, 18, 128, 120);
  room(b, 'work', '工作间', 'workshop', 'stone', 432, 18, 542, 362);

  // 灯（与发电机联动）
  lamp(b, 'bed', 'pendant', 73, 245, 120, 176, true, false, true);
  lamp(b, 'store', 'pendant', 73, 69, 120, 90, true, true, true);
  lamp(b, 'work', 'pendant', 487, 200, 440, 218, true, false, true, true);

  // 卧室：衣柜、床头柜、蜡烛、旧照片、空酒瓶、散落信纸、小地毯
  prop(b, 'wardrobe', 22, 134, 36, 18);
  prop(b, 'desk', 92, 328, 18, 18);
  prop(b, 'candles', 96, 330, 10, 10);
  prop(b, 'photo', 70, 300, 12, 9, 0.3);
  prop(b, 'bottle', 100, 270, 6, 14, 1.2);
  prop(b, 'papers', 40, 270, 18, 14, -0.4);
  prop(b, 'rug', 34, 200, 66, 52, 0.05);
  prop(b, 'cross_wall', 60, 346, 12, 14);
  // 储藏间：高货架、成摞木箱、麻袋、地窖入口
  prop(b, 'shelf', 18, 22, 14, 92);
  prop(b, 'crates', 82, 22, 30, 26);
  prop(b, 'sack', 44, 30, 18, 14, 0.4);
  prop(b, 'sack', 50, 50, 16, 13, -0.5);
  prop(b, 'hatch', 52, 72, 30, 26);
  prop(b, 'jars', 20, 24, 12, 86);
  // 工作间：墙挂工具、锯木马、油污、零件
  prop(b, 'tools_rack', 450, 20, 70, 8);
  prop(b, 'sawhorse', 470, 300, 34, 14);
  prop(b, 'oil_stain', 500, 120, 30, 20);
  prop(b, 'wires', 438, 40, 90, 60);
  prop(b, 'chair_fallen', 455, 270, 16, 16, 1.1);
  return b;
}

/** 锯木厂残垣（只用于室内判定与音频混响；墙体与屋顶由既有逻辑负责） */
function buildSawmillShell(rect: RectLike): Building {
  const b = newBuilding('mill', '废弃锯木厂', '废弃锯木厂', 'mill', rect.x, rect.y, rect.w, rect.h, 'ruin', false, 16);
  b.externalRoof = true;
  room(b, 'hall', '锯木车间', 'workshop', 'plank', 16, 16, rect.w - 16, rect.h - 16);
  return b;
}

function buildFarmhouse(): Building {
  const b = newBuilding('farm_house', '农舍', '荒芜农庄', 'farm', -1640, -230, 260, 200, 'timber', true, 16);
  ext(b, 'n', [
    { at: 40, len: 40, kind: 'window', boarded: 2 },
    { at: 180, len: 40, kind: 'window', boarded: 0 },
  ]);
  ext(b, 's', [
    { at: 50, len: 44, kind: 'door', open: true, hinge: 1, swing: 1 },
    { at: 190, len: 36, kind: 'window', boarded: 1 },
  ]);
  ext(b, 'w', [{ at: 70, len: 40, kind: 'window', boarded: 3 }]);
  ext(b, 'e', [{ at: 130, len: 36, kind: 'window', boarded: 1 }]);
  partV(b, 140, 16, 184, [{ at: 36, len: 44, kind: 'door', open: false, hinge: 1, swing: 1 }]);
  partH(b, 100, 150, 244, [{ at: 175, len: 44, kind: 'door', open: true, hinge: -1, swing: 1 }]);
  room(b, 'kitchen', '厨房', 'kitchen', 'plank', 16, 16, 140, 184);
  room(b, 'bed', '卧室', 'bedroom', 'plank', 150, 16, 244, 100);
  room(b, 'pantry', '储藏间', 'pantry', 'dirt', 150, 110, 244, 184);
  entry(b, 72, 232, 72, 160);

  // 厨房：灶台、长桌（油灯）、碗柜台面、翻倒的椅子、血迹与散落纸张
  prop(b, 'stove', 20, 20, 30, 26);
  prop(b, 'table', 50, 62, 46, 28);
  prop(b, 'chair', 40, 94, 14, 14, 0.2);
  prop(b, 'chair_fallen', 100, 72, 14, 14, 1.9);
  prop(b, 'counter', 112, 124, 24, 48);
  prop(b, 'plates', 114, 132, 20, 12);
  prop(b, 'blood', 60, 122, 34, 22, 0.6);
  prop(b, 'papers', 22, 104, 16, 12, -0.5);
  prop(b, 'bottles', 86, 150, 14, 10, 0.9);
  lamp(b, 'kitchen', 'oil', 73, 76, 73, 76, false, false, false);
  loot(b, 'crate', 36, 150, { herbs: 1, fuel: 1 }, 0.2);
  // 卧室：铁床、衣柜、十字架、旧照片、空酒瓶
  prop(b, 'bed', 190, 22, 48, 30);
  prop(b, 'wardrobe', 226, 62, 16, 34);
  prop(b, 'cross_wall', 166, 18, 12, 14);
  prop(b, 'photo', 200, 66, 12, 9, -0.4);
  prop(b, 'bottle', 160, 84, 6, 14, 0.4);
  lamp(b, 'bed', 'pendant', 196, 60, 157, 28, false, true, false);
  loot(b, 'backpack', 172, 78, { battery: 1, herbs: 1 }, 0.5);
  // 储藏间：货架、地窖入口、木桶
  prop(b, 'shelf', 152, 150, 12, 32);
  prop(b, 'hatch', 170, 132, 30, 28);
  prop(b, 'sack', 205, 118, 18, 14, 0.3);
  lamp(b, 'pantry', 'candle', 232, 122, 232, 122, false, false, false);
  loot(b, 'barrel', 224, 166, { fuel: 2 }, 0.4);
  return b;
}

function buildBarn(): Building {
  const b = newBuilding('farm_barn', '谷仓', '荒芜农庄', 'farm', -1350, -250, 240, 180, 'timber', false, 16);
  ext(b, 's', [{ at: 50, len: 70, kind: 'doorway' }]);
  ext(b, 'e', [{ at: 60, len: 40, kind: 'window', boarded: 2 }]);
  ext(b, 'n', [
    { at: 40, len: 40, kind: 'window', boarded: 3 },
    { at: 160, len: 30, kind: 'doorway' },
  ]);
  partV(b, 150, 16, 164, [{ at: 100, len: 44, kind: 'doorway' }]);
  room(b, 'hall', '谷仓大厅', 'barn', 'hay', 16, 16, 150, 164);
  room(b, 'tools', '工具间', 'workshop', 'dirt', 160, 16, 224, 164);
  entry(b, 85, 212, 85, 140);
  prop(b, 'hay', 20, 20, 40, 26);
  prop(b, 'hay', 20, 50, 30, 26);
  prop(b, 'cart', 90, 30, 50, 34, 0);
  prop(b, 'pitchfork', 66, 60, 30, 6, 0.7);
  prop(b, 'chains', 110, 90, 16, 30);
  prop(b, 'blood_trail', 60, 128, 60, -34);
  prop(b, 'bones', 120, 92, 18, 12, 0.4);
  loot(b, 'logpile', 40, 124, { wood: 3, herbs: 1 }, 0.3);
  prop(b, 'workbench', 170, 20, 48, 22);
  prop(b, 'tools_rack', 166, 150, 52, 8);
  lamp(b, 'tools', 'oil', 194, 31, 194, 31, false, false, false);
  loot(b, 'toolbox', 198, 120, { scrap: 3 }, 0.6);
  return b;
}

function buildVillageHouse1(): Building {
  const b = newBuilding('vil_h1', '村落民居 · 东欧木屋', '林中村落', 'village', -260, 1380, 220, 170, 'timber', true, 16);
  ext(b, 'n', [
    { at: 40, len: 44, kind: 'door', open: false, hinge: 1, swing: 1 },
    { at: 150, len: 36, kind: 'window', boarded: 1 },
  ]);
  ext(b, 'w', [{ at: 70, len: 40, kind: 'window', boarded: 2 }]);
  ext(b, 's', [{ at: 150, len: 36, kind: 'window', boarded: 0 }]);
  ext(b, 'e', [{ at: 30, len: 40, kind: 'window', boarded: 1 }]);
  partV(b, 120, 16, 154, [{ at: 30, len: 44, kind: 'door', open: true, hinge: 1, swing: 1 }]);
  partH(b, 90, 130, 204, [{ at: 145, len: 44, kind: 'doorway' }]);
  room(b, 'living', '起居室', 'living', 'plank', 16, 16, 120, 154);
  room(b, 'bed', '卧室', 'bedroom', 'plank', 130, 16, 204, 90);
  room(b, 'kitchen', '厨房', 'kitchen', 'tile', 130, 100, 204, 154);
  entry(b, 62, -30, 62, 40);
  prop(b, 'rug', 26, 36, 70, 40, -0.06);
  prop(b, 'table', 40, 90, 46, 28);
  prop(b, 'chair', 30, 120, 14, 14, -0.3);
  prop(b, 'chair_fallen', 90, 84, 14, 14, 2.3);
  prop(b, 'shelf', 18, 120, 14, 30);
  prop(b, 'photo', 70, 30, 12, 9, 0.2);
  prop(b, 'toy', 96, 60, 12, 10, 0.8);
  prop(b, 'papers', 50, 128, 18, 12, 0.4);
  lamp(b, 'living', 'oil', 63, 104, 63, 104, true, false, false);
  loot(b, 'crate', 100, 136, { scrap: 2, wood: 1 }, 0.1);
  prop(b, 'bed', 150, 20, 48, 28);
  prop(b, 'blood', 156, 28, 30, 18, 0.2);
  prop(b, 'cross_wall', 136, 18, 12, 14);
  prop(b, 'desk', 182, 56, 18, 18);
  lamp(b, 'bed', 'candle', 191, 64, 191, 64, false, false, false);
  prop(b, 'stove', 180, 120, 22, 30);
  prop(b, 'plates', 140, 104, 20, 12, 0.3);
  prop(b, 'shards', 160, 128, 18, 14);
  loot(b, 'barrel', 150, 136, { fuel: 1, herbs: 1 }, 0.3);
  return b;
}

function buildVillageHouse2(): Building {
  const b = newBuilding('vil_h2', '村落民居 · 双坡屋', '林中村落', 'village', 60, 1360, 180, 200, 'timber', true, 16);
  ext(b, 'n', [
    { at: 100, len: 44, kind: 'door', open: false, hinge: -1, swing: 1 },
    { at: 30, len: 36, kind: 'window', boarded: 2 },
  ]);
  ext(b, 'w', [{ at: 110, len: 40, kind: 'window', boarded: 1 }]);
  ext(b, 'e', [{ at: 130, len: 36, kind: 'window', boarded: 3 }]);
  ext(b, 's', [{ at: 30, len: 36, kind: 'window', boarded: 0 }]);
  partH(b, 70, 16, 164, [{ at: 46, len: 44, kind: 'door', open: false, hinge: 1, swing: 1 }]);
  partV(b, 90, 80, 184, [{ at: 120, len: 44, kind: 'door', open: false, hinge: 1, swing: 1 }]);
  room(b, 'hall', '前厅', 'hall', 'plank', 16, 16, 164, 70);
  room(b, 'bed', '卧室', 'bedroom', 'plank', 16, 80, 90, 184);
  room(b, 'store', '储藏间', 'storage', 'dirt', 100, 80, 164, 184);
  entry(b, 122, -30, 122, 44);
  prop(b, 'coat_rack', 140, 20, 12, 12);
  prop(b, 'boots', 120, 50, 16, 10, 0.3);
  prop(b, 'chair_fallen', 40, 30, 14, 14, 0.9);
  prop(b, 'blood_trail', 70, 40, 60, 16);
  lamp(b, 'hall', 'oil', 26, 30, 26, 30, false, false, false);
  prop(b, 'bed', 18, 84, 30, 46);
  prop(b, 'mattress', 52, 150, 30, 26, 0.3);
  prop(b, 'photo', 60, 96, 12, 9, -0.2);
  prop(b, 'candles', 72, 86, 12, 10);
  lamp(b, 'bed', 'candle', 76, 92, 76, 92, false, false, false);
  loot(b, 'backpack', 66, 170, { herbs: 2, battery: 1 }, 0.4);
  prop(b, 'shelf', 150, 84, 12, 50);
  prop(b, 'sack', 106, 90, 18, 14, 0.2);
  prop(b, 'jars', 152, 140, 10, 36);
  loot(b, 'crate', 125, 166, { scrap: 2, fuel: 1 }, 0.2);
  return b;
}

function buildVillageHouse3(): Building {
  const b = newBuilding('vil_h3', '村落焚毁民居', '林中村落', 'village', -120, 1640, 200, 150, 'ruin', false, 16);
  ext(b, 'n', [{ at: 40, len: 44, kind: 'doorway' }]);
  ext(b, 'w', [{ at: 60, len: 30, kind: 'doorway' }]);
  ext(b, 'e', [{ at: 70, len: 36, kind: 'window', boarded: 0 }]);
  ext(b, 's', [{ at: 40, len: 36, kind: 'window', boarded: 0 }]);
  partV(b, 120, 16, 134, [{ at: 40, len: 44, kind: 'doorway' }]);
  room(b, 'main', '焦黑主室', 'living', 'dirt', 16, 16, 120, 134);
  room(b, 'attic', '阁楼梯口', 'attic', 'plank', 130, 16, 184, 134);
  entry(b, 62, -30, 62, 40);
  prop(b, 'scorch', 30, 40, 70, 60, 0.4);
  prop(b, 'beam_charred', 24, 30, 80, 8, 0.5);
  prop(b, 'beam_charred', 40, 90, 60, 7, -0.3);
  prop(b, 'ash', 70, 60, 36, 26);
  prop(b, 'bones', 90, 110, 18, 12, 1.4);
  loot(b, 'corpse', 60, 104, { fuel: 1, herbs: 2, scrap: 1 }, 1.2);
  prop(b, 'ladder', 150, 20, 24, 60);
  prop(b, 'papers', 140, 96, 16, 12, 0.6);
  lamp(b, 'attic', 'candle', 160, 112, 160, 112, true, false, false);
  return b;
}

function buildChapel(): Building {
  const b = newBuilding('chapel', '木教堂', '木教堂', 'church', -340, -1720, 180, 300, 'timber', false, 16);
  ext(b, 's', [{ at: 68, len: 44, kind: 'door', open: false, hinge: 1, swing: -1 }]);
  ext(b, 'w', [
    { at: 110, len: 30, kind: 'window', boarded: 0 },
    { at: 170, len: 30, kind: 'window', boarded: 1 },
    { at: 250, len: 24, kind: 'window', boarded: 2 },
  ]);
  ext(b, 'e', [
    { at: 60, len: 30, kind: 'window', boarded: 0 },
    { at: 110, len: 30, kind: 'window', boarded: 1 },
    { at: 170, len: 30, kind: 'window', boarded: 0 },
  ]);
  ext(b, 'n', [{ at: 114, len: 40, kind: 'window', boarded: 0 }]);
  // 门厅 | 正厅
  partH(b, 220, 16, 164, [{ at: 68, len: 44, kind: 'door', open: false, hinge: -1, swing: -1 }]);
  // 圣器室（西北角）
  partH(b, 66, 16, 84, [{ at: 30, len: 40, kind: 'door', open: false, hinge: 1, swing: 1 }]);
  partV(b, 84, 16, 76, []);
  room(b, 'foyer', '门厅 · 钟绳', 'foyer', 'plank', 16, 230, 164, 284);
  room(b, 'nave', '正厅', 'nave', 'plank', 16, 76, 164, 220);
  room(b, 'apse', '祭坛', 'apse', 'stone', 94, 16, 164, 76);
  room(b, 'vestry', '圣器室', 'vestry', 'plank', 16, 16, 84, 66);
  entry(b, 90, 332, 90, 262);
  // 长椅两列（中央过道 x 70..110 保持畅通）
  for (let i = 0; i < 4; i++) {
    const py = 118 + i * 26;
    if (i === 2) prop(b, 'chair_fallen', 28, py + 2, 40, 10, 0.25);
    else prop(b, 'pew', 22, py, 44, 12);
    prop(b, 'pew', 114, py, 44, 12);
  }
  prop(b, 'altar', 112, 26, 44, 20);
  prop(b, 'crucifix', 128, 17, 12, 16);
  prop(b, 'candles', 116, 30, 10, 10);
  prop(b, 'candles', 146, 30, 10, 10);
  lamp(b, 'apse', 'candle', 134, 36, 134, 58, true, false, false);
  prop(b, 'papers', 84, 120, 18, 14, 0.5);
  prop(b, 'papers', 60, 186, 16, 12, -0.7);
  prop(b, 'blood_trail', 90, 250, -10, -150);
  prop(b, 'blood', 86, 100, 26, 18, 0.2);
  loot(b, 'corpse', 90, 160, { fuel: 1, herbs: 2, scrap: 1 }, 2.4);
  prop(b, 'bell_rope', 26, 240, 10, 30);
  lamp(b, 'foyer', 'oil', 140, 257, 140, 257, false, true, false);
  loot(b, 'crate', 40, 262, { herbs: 2, battery: 1 }, 0.3);
  // 圣器室：中继零件节点由 world.ts 放在 (50,36)；油灯、圣器柜、散页
  prop(b, 'shelf', 18, 22, 12, 30);
  prop(b, 'books', 40, 50, 18, 10, 0.3);
  lamp(b, 'vestry', 'oil', 72, 22, 72, 22, false, false, false);
  return b;
}

function buildDoctor(): Building {
  const b = newBuilding('doctor', '医生之屋', '医生之屋', 'doctor', 1430, 50, 300, 240, 'masonry', true, 16);
  ext(b, 's', [
    { at: 110, len: 44, kind: 'door', open: false, hinge: 1, swing: -1 },
    { at: 30, len: 36, kind: 'window', boarded: 1 },
    { at: 196, len: 36, kind: 'window', boarded: 2 },
  ]);
  ext(b, 'n', [
    { at: 40, len: 40, kind: 'window', boarded: 0 },
    { at: 186, len: 40, kind: 'window', boarded: 2 },
  ]);
  ext(b, 'w', [{ at: 60, len: 40, kind: 'window', boarded: 1 }]);
  ext(b, 'e', [{ at: 64, len: 40, kind: 'window', boarded: 3 }]);
  partH(b, 150, 16, 284, [
    { at: 40, len: 44, kind: 'door', open: false, hinge: 1, swing: -1 },
    { at: 150, len: 44, kind: 'doorway' },
  ]);
  partV(b, 120, 16, 150, [{ at: 50, len: 44, kind: 'door', open: true, hinge: 1, swing: 1 }]);
  partV(b, 236, 160, 224, [{ at: 170, len: 44, kind: 'door', open: false, hinge: 1, swing: 1 }], 8);
  room(b, 'clinic', '诊室', 'clinic', 'tile', 16, 16, 120, 150);
  room(b, 'wait', '候诊室 · 药柜', 'pharmacy', 'tile', 130, 16, 284, 150);
  room(b, 'hall', '走廊', 'hall', 'plank', 16, 160, 236, 224);
  room(b, 'cellar', '地窖入口', 'cellar', 'stone', 244, 160, 284, 224);
  entry(b, 132, 272, 132, 196);
  // 诊室：检查台、药柜、书桌（台灯接触不良闪烁）、血迹、托盘、药片、注射器
  prop(b, 'exam_table', 40, 50, 50, 24);
  prop(b, 'blood', 46, 56, 34, 14, 0.1);
  prop(b, 'cabinet_med', 18, 104, 14, 36);
  prop(b, 'desk', 70, 20, 40, 18);
  prop(b, 'tray', 30, 84, 16, 10, 0.6);
  prop(b, 'pills', 60, 96, 20, 14);
  prop(b, 'syringe', 92, 100, 12, 4, 0.9);
  prop(b, 'bandage', 24, 40, 14, 10, 1.1);
  prop(b, 'papers', 86, 44, 18, 14, -0.3);
  lamp(b, 'clinic', 'desk', 100, 28, 100, 28, true, false, false, true);
  loot(b, 'toolbox', 100, 128, { herbs: 2, battery: 1 }, 0.2);
  // 候诊室：中央真实长桌（可拖拽家具，四周 ≥40px 通道，西侧留座位空间，供"砸桌女人"惊吓使用）
  b.movableSpecs.push({
    id: 'furn_doctor_table',
    kind: 'table',
    x: b.x + 184,
    y: b.y + 57,
    w: 46,
    h: 26,
    hp: 95,
    maxHp: 95,
    hitFlash: 0,
  });
  prop(b, 'chair', 160, 64, 14, 14, 0.15);
  prop(b, 'chair_fallen', 238, 92, 14, 14, 2.0);
  prop(b, 'shelf', 270, 20, 14, 30);
  prop(b, 'shelf', 270, 110, 14, 36);
  prop(b, 'jars', 272, 22, 10, 26);
  prop(b, 'shards', 150, 112, 22, 16);
  prop(b, 'papers', 200, 120, 16, 12, 0.8);
  lamp(b, 'wait', 'pendant', 207, 70, 138, 26, false, true, false);
  loot(b, 'crate', 150, 34, { herbs: 3 }, 0.1);
  loot(b, 'crate', 258, 132, { battery: 1, scrap: 1 }, -0.2);
  // 走廊：长椅、倒地者、带血拖痕；地窖入口：铁盖板 + 梯子
  prop(b, 'pew', 22, 206, 44, 12);
  prop(b, 'blood_trail', 70, 196, 120, -8);
  loot(b, 'corpse', 150, 192, { fuel: 1, herbs: 1, scrap: 1 }, 0.4);
  prop(b, 'hatch', 248, 170, 30, 30);
  prop(b, 'ladder', 254, 174, 18, 22);
  return b;
}

function buildFishHut(): Building {
  const b = newBuilding('fish_hut', '渔屋', '沼泽渔屋', 'fishing', 1560, 1400, 180, 140, 'timber', true, 16);
  ext(b, 'w', [{ at: 66, len: 44, kind: 'door', open: true, hinge: 1, swing: 1 }]);
  ext(b, 'n', [{ at: 110, len: 36, kind: 'window', boarded: 1 }]);
  ext(b, 's', [{ at: 30, len: 36, kind: 'window', boarded: 0 }]);
  ext(b, 'e', [{ at: 40, len: 40, kind: 'window', boarded: 2 }]);
  partV(b, 90, 16, 124, [{ at: 40, len: 44, kind: 'door', open: false, hinge: 1, swing: 1 }]);
  room(b, 'tackle', '渔具间', 'tackle', 'plank', 16, 16, 90, 124);
  room(b, 'bunk', '卧铺', 'bunk', 'plank', 100, 16, 164, 124);
  entry(b, -32, 88, 40, 88);
  prop(b, 'nets', 20, 20, 30, 40, 0.2);
  prop(b, 'bucket', 64, 96, 12, 12);
  prop(b, 'fishbones', 40, 100, 16, 8, 0.6);
  prop(b, 'tools_rack', 22, 116, 50, 6);
  lamp(b, 'tackle', 'oil', 60, 30, 60, 30, false, true, false);
  loot(b, 'barrel', 30, 70, { fuel: 2 }, 0.2);
  prop(b, 'bunk', 134, 20, 28, 46);
  prop(b, 'table', 104, 98, 26, 22);
  prop(b, 'bottles', 108, 102, 14, 10, 0.4);
  prop(b, 'photo', 140, 74, 12, 9, 0.6);
  lamp(b, 'bunk', 'oil', 117, 109, 117, 109, true, false, false);
  loot(b, 'backpack', 148, 100, { herbs: 2, battery: 1 }, 0.9);
  return b;
}

function buildTowerHut(): Building {
  const b = newBuilding('tower_hut', '配电小屋', '信号塔', 'radio', 1520, -1440, 200, 150, 'masonry', false, 16);
  ext(b, 's', [{ at: 132, len: 44, kind: 'door', open: false, hinge: -1, swing: -1 }]);
  ext(b, 'n', [{ at: 30, len: 40, kind: 'window', boarded: 1 }]);
  ext(b, 'e', [{ at: 40, len: 40, kind: 'window', boarded: 0 }]);
  ext(b, 'w', [{ at: 60, len: 40, kind: 'window', boarded: 2 }]);
  partV(b, 110, 16, 134, [{ at: 50, len: 44, kind: 'door', open: false, hinge: 1, swing: -1 }]);
  room(b, 'power', '配电室', 'power', 'stone', 16, 16, 110, 134);
  room(b, 'duty', '值班室', 'office', 'plank', 120, 16, 184, 134);
  entry(b, 154, 182, 154, 110);
  prop(b, 'electric', 18, 18, 16, 40);
  prop(b, 'electric', 18, 76, 16, 40);
  prop(b, 'transformer', 60, 18, 36, 26);
  prop(b, 'wires', 34, 40, 60, 70);
  prop(b, 'oil_stain', 50, 96, 30, 18);
  lamp(b, 'power', 'pendant', 64, 60, 100, 30, false, true, false);
  loot(b, 'crate', 90, 118, { battery: 1, scrap: 2 }, 0.3);
  prop(b, 'desk', 130, 20, 46, 20);
  prop(b, 'radio', 134, 22, 18, 12);
  prop(b, 'logbook', 152, 44, 16, 12, 0.2);
  prop(b, 'ashtray', 128, 48, 8, 8);
  prop(b, 'chair', 150, 46, 14, 14, 0.4);
  prop(b, 'bottle', 126, 80, 6, 14, 1.4);
  lamp(b, 'duty', 'desk', 166, 28, 166, 28, true, false, false, true);
  loot(b, 'toolbox', 170, 100, { scrap: 3 }, 0.2);
  return b;
}

function buildRailHut(): Building {
  const b = newBuilding('rail_hut', '道班房', '旧铁道口', 'rail', 110, 1030, 150, 120, 'timber', true, 16);
  ext(b, 'n', [{ at: 20, len: 44, kind: 'door', open: true, hinge: 1, swing: 1 }]);
  ext(b, 'e', [{ at: 30, len: 40, kind: 'window', boarded: 1 }]);
  ext(b, 's', [{ at: 30, len: 36, kind: 'window', boarded: 2 }]);
  ext(b, 'w', [{ at: 40, len: 30, kind: 'window', boarded: 0 }]);
  partV(b, 80, 16, 104, [{ at: 30, len: 44, kind: 'doorway' }]);
  room(b, 'office', '道班室', 'office', 'plank', 16, 16, 80, 104);
  room(b, 'tools', '工具间', 'storage', 'dirt', 90, 16, 134, 104);
  entry(b, 42, -32, 42, 46);
  prop(b, 'stove', 20, 70, 24, 24);
  prop(b, 'logbook', 50, 40, 16, 12, 0.3);
  prop(b, 'bottles', 24, 30, 14, 10, 0.2);
  lamp(b, 'office', 'oil', 44, 44, 44, 44, true, false, false, false, 1);
  loot(b, 'backpack', 60, 88, { herbs: 1, fuel: 1, battery: 1 }, 0.3);
  prop(b, 'tools_rack', 94, 20, 36, 6);
  prop(b, 'sack', 100, 40, 16, 12, 0.6);
  loot(b, 'toolbox', 112, 80, { scrap: 3 }, 0.1);
  return b;
}

/** 林间旧铁轨折线（东西向贯穿南部林带，与南向村路在旧铁道口交叉） */
const RAIL_LINE: Vec2[] = [
  { x: -2300, y: 1050 },
  { x: -1300, y: 980 },
  { x: -300, y: 1010 },
  { x: 700, y: 940 },
  { x: 2300, y: 1010 },
];

/**
 * 生成全部静态建筑布局（模块加载时由 world.ts 调用一次）
 * hideoutRect / sawmillRect 由 world.ts 传入，避免两份坐标
 */
export function createBuildingLayouts(hideoutRect: RectLike, sawmillRect: RectLike): BuildingLayout {
  const buildings: Building[] = [
    buildHideout(hideoutRect),
    buildSawmillShell(sawmillRect),
    buildFarmhouse(),
    buildBarn(),
    buildVillageHouse1(),
    buildVillageHouse2(),
    buildVillageHouse3(),
    buildChapel(),
    buildDoctor(),
    buildFishHut(),
    buildTowerHut(),
    buildRailHut(),
  ];
  let doorCursor = 0;
  let lightCursor = 0;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    b.index = i;
    b.doorStart = doorCursor;
    b.doorCount = b.doorSpecs.length;
    b.lightStart = lightCursor;
    b.lightCount = b.lightSpecs.length;
    doorCursor += b.doorCount;
    lightCursor += b.lightCount;
    for (let k = 0; k < b.doorSpecs.length; k++) b.doorSpecs[k].building = i;
    for (let k = 0; k < b.lightSpecs.length; k++) b.lightSpecs[k].building = i;
  }

  // 室外叙事摆件：农庄篱笆菜地 / 井 / 稻草人，村落井与晾衣绳，墓地，信号塔，沼泽，铁道口，路标与倒伏栅栏
  const yardProps: BuildingProp[] = [];
  const yardWalls: RectObstacle[] = [];
  const Y = function (kind: string, x: number, y: number, w: number, h: number, rot = 0) {
    yard(yardProps, yardWalls, kind, x, y, w, h, rot);
  };
  // 农庄篱笆菜地（北侧留门、南侧倒伏一段、东侧缺口）
  Y('fence', -1660, 20, 100, 6);
  Y('fence', -1520, 20, 90, 6);
  Y('fence', -1660, 144, 180, 6);
  Y('fence_fallen', -1480, 140, 44, 12, 0.18);
  Y('fence', -1660, 26, 6, 118);
  Y('fence', -1436, 26, 6, 34);
  Y('fence', -1436, 100, 6, 44);
  for (let r = 0; r < 4; r++) {
    Y('cabbage', -1640, 44 + r * 24, 180, 12);
  }
  Y('scarecrow', -1556, 74, 22, 22);
  Y('well', -1330, 30, 26, 26);
  Y('blood_trail', -1318, 60, -70, 90);
  // 村落井与晾衣绳
  Y('well', -33, 1577, 26, 26);
  Y('clothesline', -96, 1618, 136, 8);
  Y('bucket', 0, 1606, 12, 12);
  // 墓地（木教堂东侧）：墓碑、坟丘、十字、被掘开的坟
  for (let gx = 0; gx < 4; gx++) {
    for (let gy = 0; gy < 3; gy++) {
      const x = -120 + gx * 46 + ((gx * 7 + gy * 13) % 9);
      const y = -1680 + gy * 70 + ((gx * 11 + gy * 5) % 11);
      if ((gx + gy) % 3 === 0) Y('cross_grave', x, y - 6, 14, 20, ((gx - gy) % 3) * 0.12);
      else Y('tombstone', x, y, 16, 8);
      Y('grave', x - 6, y + 10, 28, 40);
    }
  }
  Y('grave_open', 70, -1600, 30, 46);
  Y('pitchfork', 104, -1590, 30, 6, 1.1);
  Y('fence_fallen', -150, -1720, 120, 10, 0.05);
  // 信号塔：钢架基座四腿 + 拉索 + 电缆沟
  Y('tower', 1380, -1620, 120, 120);
  Y('tower_leg', 1380, -1620, 14, 14);
  Y('tower_leg', 1486, -1620, 14, 14);
  Y('tower_leg', 1380, -1514, 14, 14);
  Y('tower_leg', 1486, -1514, 14, 14);
  Y('guy_wire', 1440, -1560, -170, -150);
  Y('guy_wire', 1440, -1560, 190, -130);
  Y('guy_wire', 1440, -1560, -150, 160);
  Y('wires', 1500, -1500, 30, 70);
  // 沼泽：积水洼、木栈道、搁浅小船
  Y('water', 1330, 1520, 150, 90, 0.2);
  Y('water', 1420, 1330, 120, 60, -0.3);
  Y('water', 1610, 1570, 170, 80, 0.1);
  Y('water', 1350, 1400, 70, 46, 0.6);
  for (let k = 0; k < 4; k++) {
    Y('boardwalk', 1300 + k * 64, 1470 + k * 1, 66, 34, 0.02);
  }
  Y('rowboat', 1770, 1440, 26, 60);
  // 旧铁道口：倒伏道闸、停字牌、遗弃的轨道手摇车
  Y('barrier', -60, 1030, 70, 8, 0.35);
  Y('stop_sign', 62, 950, 14, 14);
  Y('handcar', -665, 985, 50, 30);
  // 路标（label 写在 kind 后缀，渲染层解析）与倒伏栅栏、路边十字架
  Y('sign:林中村落 ↓', 64, 246, 16, 16);
  Y('sign:医生之屋 →', 336, -104, 16, 16, 0.1);
  Y('sign:坠毁货车 ↖', -392, -130, 16, 16);
  Y('sign:木教堂 ↑', -610, -830, 16, 16, -0.2);
  Y('sign:信号塔 ↗', 990, -740, 16, 16);
  Y('sign:沼泽渔屋 ↘', 1180, 1290, 16, 16, 0.1);
  Y('sign:荒芜农庄 ←', -1190, 210, 16, 16, -0.1);
  Y('sign:旧铁道口 ↓', 64, 880, 16, 16);
  Y('fence_fallen', 60, 420, 60, 10, 0.4);
  Y('fence_fallen', -520, 560, 70, 10, -0.6);
  Y('fence_fallen', 760, -180, 70, 10, 0.9);
  Y('fence_fallen', -1050, 360, 64, 10, 0.3);
  Y('fence_fallen', 1230, 120, 60, 10, -0.2);
  Y('roadside_cross', -470, 985, 14, 20);
  Y('roadside_cross', 1290, -1120, 14, 20);
  Y('milestone', 640, 70, 12, 10);
  Y('milestone', -1000, -260, 12, 10);

  const clearRects: RectLike[] = [
    { x: -1680, y: 0, w: 270, h: 170 },
    { x: -150, y: -1740, w: 270, h: 320 },
    { x: 1360, y: -1640, w: 160, h: 160 },
    { x: 1300, y: 1300, w: 520, h: 330 },
    { x: -110, y: 1560, w: 170, h: 80 },
    { x: -700, y: 960, w: 120, h: 80 },
  ];
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    clearRects.push({ x: b.x - 60, y: b.y - 60, w: b.w + 120, h: b.h + 120 });
  }

  return { buildings, yardProps, yardWalls, rails: [RAIL_LINE], clearRects };
}

// ---------------------------------------------------------------------------
// 运行时纯函数（engine 推进 / renderer 只读调用）
// ---------------------------------------------------------------------------

/** 点所在建筑索引（外框内缩 inset，与 isPointInHideout 同口径），不在任何建筑内返回 -1 */
export function buildingIndexAt(buildings: Building[], x: number, y: number, inset = 12): number {
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (x >= b.x + inset && x <= b.x + b.w - inset && y >= b.y + inset && y <= b.y + b.h - inset) return i;
  }
  return -1;
}

/** 灯是否真正发光（开着、灯泡完好、需供电时发电机在运转） */
export function isLightLit(l: BuildingLight, genPowered: boolean): boolean {
  return l.on && !l.broken && (!l.powered || genPowered);
}

/**
 * 灯光强度乘子 0..1（纯函数：只读 simTime 与灯的种子，不写状态）
 * - 开灯 0.18s 灯丝升温；偶发短暂闪烁；接触不良灯频繁明灭
 */
export function lightFlicker(l: BuildingLight, t: number): number {
  const since = t - l.toggledAt;
  let ramp = since < 0.18 ? Math.max(0, since / 0.18) : 1;
  if (since < 0.12) ramp *= since * 50 - Math.floor(since * 50) > 0.5 ? 1 : 0.35;
  let f = 0.95 + Math.sin(t * 7.1 + l.seed) * 0.03;
  if (l.kind === 'candle' || l.kind === 'oil') {
    f = 0.86 + Math.sin(t * 9.7 + l.seed) * 0.07 + Math.sin(t * 23.3 + l.seed * 2.3) * 0.05;
  }
  // 偶发闪烁：两段慢正弦乘积极值时短暂掉光
  const s = Math.sin(t * 0.73 + l.seed * 7.3) * Math.sin(t * 1.91 + l.seed * 3.1);
  if (s > 0.9) f *= Math.sin(t * 61 + l.seed) > 0 ? 0.25 : 0.8;
  if (l.faulty) {
    const q = Math.sin(t * 17.3 + l.seed) + Math.sin(t * 5.7 + l.seed * 1.7);
    f *= q > 0.6 ? 0.2 : q > -0.4 ? 0.95 : 0.6;
  }
  return f * ramp;
}

export const FIXTURE_NONE = 0;
export const FIXTURE_LIGHT = 1;
export const FIXTURE_DOOR = 2;

export interface FixtureHit {
  type: number;
  index: number;
  x: number;
  y: number;
  d: number;
}

const fixtureHit: FixtureHit = { type: 0, index: -1, x: 0, y: 0, d: 0 };

/** 查找最近的可交互灯开关 / 室内门（零分配：返回模块级复用对象） */
export function findNearestFixture(
  lights: BuildingLight[],
  doors: InteriorDoor[],
  px: number,
  py: number,
  maxDist: number
): FixtureHit {
  fixtureHit.type = FIXTURE_NONE;
  fixtureHit.index = -1;
  fixtureHit.d = maxDist;
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    const d = dist(px, py, l.switchX, l.switchY);
    if (d < fixtureHit.d) {
      fixtureHit.type = FIXTURE_LIGHT;
      fixtureHit.index = i;
      fixtureHit.d = d;
      fixtureHit.x = l.switchX;
      fixtureHit.y = l.switchY;
    }
  }
  for (let i = 0; i < doors.length; i++) {
    const dr = doors[i];
    const cx = dr.x + dr.w * 0.5;
    const cy = dr.y + dr.h * 0.5;
    const d = dist(px, py, cx, cy);
    if (d < fixtureHit.d) {
      fixtureHit.type = FIXTURE_DOOR;
      fixtureHit.index = i;
      fixtureHit.d = d;
      fixtureHit.x = cx;
      fixtureHit.y = cy;
    }
  }
  return fixtureHit;
}

/** 门扇摆向：远离推门者一侧 */
export function swingAwayFrom(dr: InteriorDoor, px: number, py: number): number {
  if (dr.orientation === 'h') return py < dr.y + dr.h * 0.5 ? 1 : -1;
  return px < dr.x + dr.w * 0.5 ? 1 : -1;
}

function circleTouchesRect(cx: number, cy: number, r: number, x: number, y: number, w: number, h: number): boolean {
  const qx = cx < x ? x : cx > x + w ? x + w : cx;
  const qy = cy < y ? y : cy > y + h ? y + h : cy;
  const dx = cx - qx;
  const dy = cy - qy;
  return dx * dx + dy * dy < r * r;
}

export interface DoorPusher {
  x: number;
  y: number;
  r: number;
}

/** 门事件：成对写入 [门索引, 原因]；原因 1 = 玩家推开，2 = 怪物撞开（模块级复用数组） */
const doorEvents: number[] = [];

/**
 * 推进室内门：开合动画、玩家推门即开、怪物持续撞门 1.5s 破开
 * 返回本步事件数组（engine 据此播放音效/声波），每帧零分配
 */
export function stepInteriorDoors(
  doors: InteriorDoor[],
  dt: number,
  px: number,
  py: number,
  pr: number,
  enemies: DoorPusher[]
): number[] {
  doorEvents.length = 0;
  const k = Math.min(1, dt * 9);
  for (let i = 0; i < doors.length; i++) {
    const dr = doors[i];
    const target = dr.open ? 1 : 0;
    dr.openT += (target - dr.openT) * k;
    if (Math.abs(target - dr.openT) < 0.002) dr.openT = target;
    if (dr.open) {
      dr.bash = 0;
      continue;
    }
    // 远距剔除
    const cx = dr.x + dr.w * 0.5;
    const cy = dr.y + dr.h * 0.5;
    if (circleTouchesRect(px, py, pr + 3, dr.x, dr.y, dr.w, dr.h)) {
      dr.open = true;
      dr.swing = swingAwayFrom(dr, px, py);
      dr.bash = 0;
      doorEvents.push(i, 1);
      continue;
    }
    let bashing = false;
    for (let j = 0; j < enemies.length; j++) {
      const e = enemies[j];
      if (Math.abs(e.x - cx) > 70 || Math.abs(e.y - cy) > 70) continue;
      if (circleTouchesRect(e.x, e.y, e.r + 5, dr.x, dr.y, dr.w, dr.h)) {
        bashing = true;
        if (dr.bash + dt >= 1.5) dr.swing = swingAwayFrom(dr, e.x, e.y);
        break;
      }
    }
    if (bashing) {
      dr.bash += dt;
      if (dr.bash >= 1.5) {
        dr.open = true;
        dr.bash = 0;
        doorEvents.push(i, 2);
      }
    } else if (dr.bash > 0) {
      dr.bash = Math.max(0, dr.bash - dt * 0.5);
    }
  }
  return doorEvents;
}

const pilotWp: Vec2 = { x: 0, y: 0 };

/**
 * 自动驾驶寻路辅助：目标在另一栋建筑内（或玩家在建筑内而目标在外）时，先经由该建筑入口内外两点
 * 只处理带入口的建筑（庇护所由 engine 既有规则处理），零分配
 */
export function pilotWaypoint(buildings: Building[], px: number, py: number, tx: number, ty: number): Vec2 {
  const bp = buildingIndexAt(buildings, px, py);
  const bt = buildingIndexAt(buildings, tx, ty);
  pilotWp.x = tx;
  pilotWp.y = ty;
  if (bp === bt) return pilotWp;
  if (bp >= 0 && buildings[bp].hasEntry) {
    const b = buildings[bp];
    const span = dist(b.entryIn.x, b.entryIn.y, b.entryOut.x, b.entryOut.y) + 8;
    const near = dist(px, py, b.entryOut.x, b.entryOut.y) < span;
    pilotWp.x = near ? b.entryOut.x : b.entryIn.x;
    pilotWp.y = near ? b.entryOut.y : b.entryIn.y;
    return pilotWp;
  }
  if (bt >= 0 && buildings[bt].hasEntry) {
    const b = buildings[bt];
    const span = dist(b.entryIn.x, b.entryIn.y, b.entryOut.x, b.entryOut.y) + 8;
    const near = dist(px, py, b.entryIn.x, b.entryIn.y) < span;
    pilotWp.x = near ? b.entryIn.x : b.entryOut.x;
    pilotWp.y = near ? b.entryIn.y : b.entryOut.y;
  }
  return pilotWp;
}
