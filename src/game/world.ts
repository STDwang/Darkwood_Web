// Deterministic procedural Darkwood world generator (Single Source of Truth for physics & lighting)
// 第三轮：世界扩大到 4600，新增 7 处原作气质地点 + 建筑/房间系统（buildings.ts）+ 均匀网格空间索引

import {
  BarricadeSlot,
  CraftRecipe,
  EssenceNode,
  FloorZone,
  LootContainer,
  MovableFurniture,
  RectObstacle,
  RelayNode,
  RockObstacle,
  TreeObstacle,
} from './types';
import {
  Segment,
  Vec2,
  clamp,
  createRng,
  dist,
  resolveCircleCircle,
  resolveCircleRect,
} from './util';
import {
  Building,
  BuildingLight,
  BuildingProp,
  InteriorDoor,
  RectLike,
  buildingIndexAt,
  createBuildingLayouts,
} from './buildings';

export const WORLD_SIZE = 4600;
export const WORLD_HALF = WORLD_SIZE / 2;

/** 庇护所外框（第三轮扩大为 560 × 380，内分主屋/卧室/储藏间/工作间；南墙与南门位置不变） */
export const HIDEOUT_RECT = {
  x: -280,
  y: -240,
  w: 560,
  h: 380,
};

/** 锯木厂残垣屋顶矩形（engine.SAWMILL_ROOF_RECT 引用此处，单源） */
export const SAWMILL_RECT = { x: 620, y: -610, w: 220, h: 230 };

export const GENERATOR_POS: Vec2 = { x: -118, y: -88 };
/** 工作台移入东翼工作间 */
export const WORKBENCH_POS: Vec2 = { x: 207, y: -182 };
export const SHELTER_LAMPS: Vec2[] = [
  { x: -65, y: 15 },
  { x: 75, y: 20 },
];
// 活火源坐标（单源真相：渲染、动态点光与火星粒子共用，零碰撞死角）
// 室内铸铁炭炉按外框内角推导（与 renderer.drawHideoutInterior 的 innerR-26 / innerB-24 一致）
export const HIDEOUT_STOVE_POS: Vec2 = {
  x: HIDEOUT_RECT.x + HIDEOUT_RECT.w - 18 - 26,
  y: HIDEOUT_RECT.y + HIDEOUT_RECT.h - 18 - 24,
};
export const HIDEOUT_BRAZIER_POS: Vec2 = { x: 86, y: 196 };
export const CAMPFIRE_POS: Vec2 = { x: -636, y: 646 };

/** 静态建筑布局（模块加载时生成一次；墙体/家具碰撞盒为只读共享对象） */
const LAYOUT = createBuildingLayouts(HIDEOUT_RECT, SAWMILL_RECT);
export const BUILDINGS: Building[] = LAYOUT.buildings;
/** 室外叙事摆件（篱笆、井、墓碑、路标、铁道口道闸……） */
export const YARD_PROPS: BuildingProp[] = LAYOUT.yardProps;
/** 林间旧铁轨折线 */
export const RAIL_LINES: Vec2[][] = LAYOUT.rails;

export const CRAFT_RECIPES: CraftRecipe[] = [
  {
    id: 'bandage',
    name: '草药绷带',
    desc: '恢复 45 生命值',
    cost: { herbs: 2 },
    outputText: '+1',
  },
  {
    id: 'flare',
    name: '照明弹',
    desc: '照亮黑暗区域 22 秒，驱散阴影',
    cost: { wood: 1, fuel: 1 },
    outputText: '+2',
  },
  {
    id: 'trap',
    name: '捕兽夹',
    desc: '部署在门口，困住并重创入侵怪物',
    cost: { scrap: 2, wood: 1 },
    outputText: '+1',
  },
  {
    id: 'cell',
    name: '备用电池',
    desc: '补充手电 65% 电量',
    cost: { scrap: 1, essence: 1 },
    outputText: '+1',
  },
  {
    id: 'axe',
    name: '升级伐木斧',
    desc: '大幅提升近战伤害与击退距离',
    cost: { wood: 3, scrap: 4 },
    outputText: 'Tier 2',
    oneTime: true,
  },
];

export interface DirtPath {
  points: Vec2[];
  width: number;
  /** 包围盒（含半宽），供渲染视口剔除 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 世界空间黑色枯枝灌木（纯装饰：无碰撞、不阻光；渲染层用预烘焙枝形旋转缩放复用） */
export interface Bramble {
  x: number;
  y: number;
  rot: number;
  scale: number;
  /** 预烘焙枝形索引 0..BRAMBLE_VARIANTS-1 */
  variant: number;
}

export const BRAMBLE_VARIANTS = 10;

/** 静态几何均匀网格空间索引（CSR 桶：start[cell]..start[cell+1] 为该格物体索引） */
export interface StaticGrid {
  cell: number;
  cols: number;
  wallStart: Int32Array;
  wallItems: Int32Array;
  treeStart: Int32Array;
  treeItems: Int32Array;
  rockStart: Int32Array;
  rockItems: Int32Array;
  /** 墙体跨格去重戳 */
  wallStamp: Uint32Array;
  stamp: number;
}

export interface WorldData {
  seed: number;
  walls: RectObstacle[];
  barricades: BarricadeSlot[];
  movables: MovableFurniture[];
  relayNodes: RelayNode[];
  trees: TreeObstacle[];
  rocks: RockObstacle[];
  containers: LootContainer[];
  essences: EssenceNode[];
  zones: FloorZone[];
  paths: DirtPath[];
  poiCenters: { name: string; x: number; y: number; r: number }[];
  /** 建筑静态布局（与 BUILDINGS 同一数组，只读） */
  buildings: Building[];
  /** 可开关室内门（每局克隆，engine 推进） */
  interiorDoors: InteriorDoor[];
  /** 建筑灯具（每局克隆，engine 推进开关） */
  lights: BuildingLight[];
  yardProps: BuildingProp[];
  rails: Vec2[][];
  /** 黑色枯枝灌木（确定性种子；林缘/树根/建筑墙角/道路边） */
  brambles: Bramble[];
  grid: StaticGrid;
}

const GRID_CELL = 128;

function cellOf(g: StaticGrid, v: number): number {
  const c = Math.floor((v + WORLD_HALF) / g.cell);
  return c < 0 ? 0 : c >= g.cols ? g.cols - 1 : c;
}

/** CSR 分桶：ranges 每 4 个为一个物体的 [cx0, cy0, cx1, cy1] */
function bucketize(cols: number, count: number, ranges: Int32Array): Int32Array[] {
  const cells = cols * cols;
  const start = new Int32Array(cells + 1);
  for (let i = 0; i < count; i++) {
    for (let cy = ranges[i * 4 + 1]; cy <= ranges[i * 4 + 3]; cy++) {
      for (let cx = ranges[i * 4]; cx <= ranges[i * 4 + 2]; cx++) start[cy * cols + cx + 1]++;
    }
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[cells]);
  const fill = start.slice(0, cells);
  for (let i = 0; i < count; i++) {
    for (let cy = ranges[i * 4 + 1]; cy <= ranges[i * 4 + 3]; cy++) {
      for (let cx = ranges[i * 4]; cx <= ranges[i * 4 + 2]; cx++) {
        const ci = cy * cols + cx;
        items[fill[ci]++] = i;
      }
    }
  }
  return [start, items];
}

function buildStaticGrid(walls: RectObstacle[], trees: TreeObstacle[], rocks: RockObstacle[]): StaticGrid {
  const cols = Math.ceil(WORLD_SIZE / GRID_CELL);
  const g: StaticGrid = {
    cell: GRID_CELL,
    cols,
    wallStart: new Int32Array(1),
    wallItems: new Int32Array(0),
    treeStart: new Int32Array(1),
    treeItems: new Int32Array(0),
    rockStart: new Int32Array(1),
    rockItems: new Int32Array(0),
    wallStamp: new Uint32Array(walls.length),
    stamp: 0,
  };
  const wr = new Int32Array(walls.length * 4);
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    wr[i * 4] = cellOf(g, w.x);
    wr[i * 4 + 1] = cellOf(g, w.y);
    wr[i * 4 + 2] = cellOf(g, w.x + w.w);
    wr[i * 4 + 3] = cellOf(g, w.y + w.h);
  }
  const wb = bucketize(cols, walls.length, wr);
  g.wallStart = wb[0];
  g.wallItems = wb[1];
  const tr = new Int32Array(trees.length * 4);
  for (let i = 0; i < trees.length; i++) {
    const cx = cellOf(g, trees[i].x);
    const cy = cellOf(g, trees[i].y);
    tr[i * 4] = cx;
    tr[i * 4 + 1] = cy;
    tr[i * 4 + 2] = cx;
    tr[i * 4 + 3] = cy;
  }
  const tb = bucketize(cols, trees.length, tr);
  g.treeStart = tb[0];
  g.treeItems = tb[1];
  const rr = new Int32Array(rocks.length * 4);
  for (let i = 0; i < rocks.length; i++) {
    const cx = cellOf(g, rocks[i].x);
    const cy = cellOf(g, rocks[i].y);
    rr[i * 4] = cx;
    rr[i * 4 + 1] = cy;
    rr[i * 4 + 2] = cx;
    rr[i * 4 + 3] = cy;
  }
  const rb = bucketize(cols, rocks.length, rr);
  g.rockStart = rb[0];
  g.rockItems = rb[1];
  return g;
}

function makePath(width: number, points: Vec2[]): DirtPath {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const h = width * 0.5 + 4;
  return { points, width, minX: minX - h, minY: minY - h, maxX: maxX + h, maxY: maxY + h };
}

function addHideoutCabin(walls: RectObstacle[], barricades: BarricadeSlot[], zones: FloorZone[]) {
  const { x, y, w, h } = HIDEOUT_RECT;
  const t = 18; // wall thickness

  zones.push({
    name: '庇护所',
    x: x + t,
    y: y + t,
    w: w - t * 2,
    h: h - t * 2,
    surface: 'wood',
  });

  // Top wall with a 64px window opening at center
  const winW = 64;
  const topSegW = (w - winW) / 2;
  walls.push({ id: 'h_top_l', x, y, w: topSegW, h: t, kind: 'wall', blocksLight: true });
  walls.push({
    id: 'h_top_r',
    x: x + topSegW + winW,
    y,
    w: topSegW,
    h: t,
    kind: 'wall',
    blocksLight: true,
  });
  barricades.push({
    id: 'bar_north_win',
    x: x + topSegW,
    y: y + 2,
    w: winW,
    h: t - 4,
    orientation: 'h',
    hp: 60,
    maxHp: 100,
    kind: 'window',
  });

  // Bottom wall with a 68px front door opening
  const doorW = 68;
  const botSegW = (w - doorW) / 2;
  walls.push({ id: 'h_bot_l', x, y: y + h - t, w: botSegW, h: t, kind: 'wall', blocksLight: true });
  walls.push({
    id: 'h_bot_r',
    x: x + botSegW + doorW,
    y: y + h - t,
    w: botSegW,
    h: t,
    kind: 'wall',
    blocksLight: true,
  });
  barricades.push({
    id: 'bar_south_door',
    x: x + botSegW,
    y: y + h - t + 2,
    w: doorW,
    h: t - 4,
    orientation: 'h',
    hp: 0, // starts open so player can walk out immediately
    maxHp: 100,
    kind: 'door',
  });

  // Left wall with a 62px window
  const sideWin = 62;
  const sideSegH = (h - sideWin) / 2;
  walls.push({ id: 'h_left_t', x, y: y + t, w: t, h: sideSegH - t, kind: 'wall', blocksLight: true });
  walls.push({
    id: 'h_left_b',
    x,
    y: y + sideSegH + sideWin,
    w: t,
    h: sideSegH - t,
    kind: 'wall',
    blocksLight: true,
  });
  barricades.push({
    id: 'bar_west_win',
    x: x + 2,
    y: y + sideSegH,
    w: t - 4,
    h: sideWin,
    orientation: 'v',
    hp: 60,
    maxHp: 100,
    kind: 'window',
  });

  // Right wall with a 66px side door
  const sideDoor = 66;
  const rSegH = (h - sideDoor) / 2;
  walls.push({
    id: 'h_right_t',
    x: x + w - t,
    y: y + t,
    w: t,
    h: rSegH - t,
    kind: 'wall',
    blocksLight: true,
  });
  walls.push({
    id: 'h_right_b',
    x: x + w - t,
    y: y + rSegH + sideDoor,
    w: t,
    h: rSegH - t,
    kind: 'wall',
    blocksLight: true,
  });
  barricades.push({
    id: 'bar_east_door',
    x: x + w - t + 2,
    y: y + rSegH,
    w: t - 4,
    h: sideDoor,
    orientation: 'v',
    hp: 40,
    maxHp: 100,
    kind: 'door',
  });

  // Interior Workbench & Generator solid props (low height: block movement, don't block overhead light)
  walls.push({
    id: 'prop_gen',
    x: GENERATOR_POS.x - 22,
    y: GENERATOR_POS.y - 16,
    w: 44,
    h: 32,
    kind: 'table',
    blocksLight: false,
  });
  walls.push({
    id: 'prop_bench',
    x: WORKBENCH_POS.x - 28,
    y: WORKBENCH_POS.y - 15,
    w: 56,
    h: 30,
    kind: 'table',
    blocksLight: false,
  });
}

function surfaceOfFloor(f: string): 'wood' | 'mud' | 'gravel' {
  if (f === 'tile' || f === 'stone') return 'gravel';
  if (f === 'dirt') return 'mud';
  return 'wood';
}

function pointInRects(rects: RectLike[], x: number, y: number, pad: number): boolean {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad) return true;
  }
  return false;
}

function distToPolyline(pts: Vec2[], px: number, py: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    const t = clamp(((px - a.x) * vx + (py - a.y) * vy) / len2, 0, 1);
    const d = Math.hypot(px - (a.x + vx * t), py - (a.y + vy * t));
    if (d < best) best = d;
  }
  return best;
}

export function createWorld(seed = 19847): WorldData {
  const rng = createRng(seed);
  const walls: RectObstacle[] = [];
  const barricades: BarricadeSlot[] = [];
  const trees: TreeObstacle[] = [];
  const rocks: RockObstacle[] = [];
  const containers: LootContainer[] = [];
  const essences: EssenceNode[] = [];
  const zones: FloorZone[] = [];

  // 庇护所室内 3 件初始可拖拽重型家具（避开发电机、工作台、出生点 (0, 25)、内墙门洞与四面门窗通道）
  const movables: MovableFurniture[] = [
    {
      id: 'furn_sofa',
      kind: 'sofa',
      x: -134,
      y: 48,
      w: 54,
      h: 26,
      hp: 110,
      maxHp: 110,
      hitFlash: 0,
    },
    {
      id: 'furn_cabinet',
      kind: 'cabinet',
      x: 82,
      y: -56,
      w: 32,
      h: 24,
      hp: 130,
      maxHp: 130,
      hitFlash: 0,
    },
    {
      id: 'furn_table',
      kind: 'table',
      x: 68,
      y: 52,
      w: 46,
      h: 26,
      hp: 95,
      maxHp: 95,
      hitFlash: 0,
    },
  ];

  // 3 件信号中继零件：坠毁货车（近）/ 木教堂圣器室（北）/ 信号塔配电小屋（东北），均避开墙体与容器
  const relayNodes: RelayNode[] = [
    { id: 'relay_truck', zone: '坠毁货车', x: -705, y: -518, collected: false },
    { id: 'relay_chapel', zone: '木教堂', x: -290, y: -1684, collected: false },
    { id: 'relay_tower', zone: '信号塔', x: 1584, y: -1356, collected: false },
  ];

  addHideoutCabin(walls, barricades, zones);

  // 11 处探索地标（4 处原有 + 7 处新增）
  const poiCenters = [
    { name: '坠毁货车', x: -680, y: -560, r: 195 },
    { name: '废弃锯木厂', x: 740, y: -490, r: 225 },
    { name: '猎人营地', x: -640, y: 630, r: 190 },
    { name: '枯林祭坛', x: 690, y: 610, r: 205 },
    { name: '荒芜农庄', x: -1470, y: -80, r: 330 },
    { name: '林中村落', x: -10, y: 1530, r: 330 },
    { name: '木教堂', x: -180, y: -1580, r: 300 },
    { name: '医生之屋', x: 1570, y: 170, r: 300 },
    { name: '沼泽渔屋', x: 1520, y: 1470, r: 320 },
    { name: '信号塔', x: 1540, y: -1430, r: 300 },
    { name: '旧铁道口', x: 190, y: 1050, r: 210 },
  ];

  // 土路网络：庇护所南门 / 东门出发连接全部地标
  const paths: DirtPath[] = [
    makePath(56, [
      { x: 0, y: 155 },
      { x: -120, y: 290 },
      { x: -370, y: 460 },
      { x: -620, y: 610 },
    ]),
    makePath(54, [
      { x: 300, y: -50 },
      { x: 440, y: -160 },
      { x: 610, y: -340 },
      { x: 740, y: -490 },
    ]),
    makePath(50, [
      { x: -60, y: 175 },
      { x: -330, y: 180 },
      { x: -420, y: -60 },
      { x: -560, y: -330 },
      { x: -680, y: -560 },
    ]),
    makePath(48, [
      { x: 120, y: 160 },
      { x: 380, y: 310 },
      { x: 540, y: 470 },
      { x: 690, y: 610 },
    ]),
    makePath(46, [
      { x: -680, y: -560 },
      { x: -560, y: -860 },
      { x: -380, y: -1180 },
      { x: -250, y: -1380 },
    ]),
    makePath(44, [
      { x: -250, y: -1380 },
      { x: 150, y: -1380 },
      { x: 700, y: -1330 },
      { x: 1150, y: -1300 },
      { x: 1460, y: -1230 },
      { x: 1674, y: -1240 },
    ]),
    makePath(46, [
      { x: 740, y: -490 },
      { x: 950, y: -780 },
      { x: 1250, y: -1050 },
      { x: 1520, y: -1230 },
    ]),
    makePath(50, [
      { x: 300, y: -50 },
      { x: 700, y: 40 },
      { x: 1100, y: 200 },
      { x: 1400, y: 330 },
      { x: 1562, y: 345 },
    ]),
    makePath(44, [
      { x: 1562, y: 345 },
      { x: 1620, y: 700 },
      { x: 1560, y: 1100 },
      { x: 1420, y: 1380 },
      { x: 1300, y: 1470 },
    ]),
    makePath(42, [
      { x: 690, y: 610 },
      { x: 980, y: 900 },
      { x: 1200, y: 1250 },
      { x: 1300, y: 1470 },
    ]),
    makePath(52, [
      { x: 10, y: 150 },
      { x: 30, y: 560 },
      { x: 10, y: 980 },
      { x: 0, y: 1370 },
    ]),
    makePath(44, [
      { x: 240, y: 1570 },
      { x: 700, y: 1640 },
      { x: 1100, y: 1560 },
      { x: 1300, y: 1470 },
    ]),
    makePath(44, [
      { x: -30, y: 1360 },
      { x: -330, y: 1250 },
      { x: -560, y: 950 },
      { x: -640, y: 700 },
    ]),
    makePath(46, [
      { x: -640, y: 630 },
      { x: -950, y: 430 },
      { x: -1220, y: 180 },
      { x: -1400, y: 40 },
    ]),
    makePath(44, [
      { x: -1250, y: -40 },
      { x: -1050, y: -300 },
      { x: -850, y: -480 },
      { x: -700, y: -560 },
    ]),
  ];

  // POI 1: Crashed Supply Truck (NW)
  zones.push({ name: '坠毁货车', x: -820, y: -680, w: 280, h: 240, surface: 'gravel' });
  walls.push({ id: 'truck_body', x: -735, y: -595, w: 118, h: 48, kind: 'truck', blocksLight: true });
  walls.push({ id: 'truck_cab', x: -615, y: -590, w: 42, h: 40, kind: 'truck', blocksLight: true });
  containers.push(
    {
      id: 'c_truck_1',
      x: -760,
      y: -520,
      r: 18,
      kind: 'barrel',
      zone: '坠毁货车',
      searched: false,
      searchDuration: 1.5,
      loot: { fuel: 2, scrap: 1 },
      angle: 0.4,
    },
    {
      id: 'c_truck_2',
      x: -640,
      y: -510,
      r: 18,
      kind: 'crate',
      zone: '坠毁货车',
      searched: false,
      searchDuration: 1.6,
      loot: { battery: 1, scrap: 2, herbs: 1 },
      angle: -0.2,
    },
    {
      id: 'c_truck_3',
      x: -575,
      y: -620,
      r: 16,
      kind: 'backpack',
      zone: '坠毁货车',
      searched: false,
      searchDuration: 1.3,
      loot: { herbs: 2, fuel: 1 },
      angle: 0.8,
    }
  );

  // POI 2: Old Sawmill (NE) — ruined walls & rich wood/scrap
  zones.push({ name: '废弃锯木厂', x: 590, y: -640, w: 300, h: 280, surface: 'wood' });
  walls.push({ id: 'mill_w1', x: 620, y: -610, w: 220, h: 16, kind: 'ruin_wall', blocksLight: true });
  walls.push({ id: 'mill_w2', x: 620, y: -610, w: 16, h: 155, kind: 'ruin_wall', blocksLight: true });
  walls.push({ id: 'mill_w3', x: 824, y: -540, w: 16, h: 160, kind: 'ruin_wall', blocksLight: true });
  walls.push({ id: 'mill_w4', x: 685, y: -395, w: 155, h: 16, kind: 'ruin_wall', blocksLight: true });
  containers.push(
    {
      id: 'c_mill_1',
      x: 675,
      y: -560,
      r: 20,
      kind: 'logpile',
      zone: '废弃锯木厂',
      searched: false,
      searchDuration: 1.4,
      loot: { wood: 4 },
      angle: 0.1,
    },
    {
      id: 'c_mill_2',
      x: 780,
      y: -555,
      r: 17,
      kind: 'toolbox',
      zone: '废弃锯木厂',
      searched: false,
      searchDuration: 1.6,
      loot: { scrap: 3, battery: 1 },
      angle: 0.5,
    },
    {
      id: 'c_mill_3',
      x: 750,
      y: -440,
      r: 18,
      kind: 'barrel',
      zone: '废弃锯木厂',
      searched: false,
      searchDuration: 1.5,
      loot: { fuel: 2, wood: 2 },
      angle: -0.3,
    }
  );

  // POI 3: Hunter Camp (SW)
  zones.push({ name: '猎人营地', x: -780, y: 500, w: 260, h: 240, surface: 'mud' });
  walls.push({ id: 'camp_w1', x: -735, y: 550, w: 120, h: 15, kind: 'ruin_wall', blocksLight: true });
  walls.push({ id: 'camp_w2', x: -735, y: 550, w: 15, h: 110, kind: 'ruin_wall', blocksLight: true });
  containers.push(
    {
      id: 'c_camp_1',
      x: -665,
      y: 605,
      r: 17,
      kind: 'backpack',
      zone: '猎人营地',
      searched: false,
      searchDuration: 1.3,
      loot: { herbs: 3, scrap: 2 },
      angle: 0.3,
    },
    {
      id: 'c_camp_2',
      x: -590,
      y: 660,
      r: 19,
      kind: 'logpile',
      zone: '猎人营地',
      searched: false,
      searchDuration: 1.4,
      loot: { wood: 3, fuel: 1 },
      angle: -0.5,
    },
    {
      id: 'c_camp_3',
      x: -690,
      y: 685,
      r: 18,
      kind: 'corpse',
      zone: '猎人营地',
      searched: false,
      searchDuration: 1.8,
      loot: { battery: 1, scrap: 2, herbs: 1 },
      angle: 1.1,
    }
  );

  // POI 4: Withered Shrine (SE) — high odd essence + ruins
  zones.push({ name: '枯林祭坛', x: 560, y: 480, w: 260, h: 250, surface: 'gravel' });
  walls.push({ id: 'shr_p1', x: 615, y: 530, w: 24, h: 24, kind: 'ruin_wall', blocksLight: true });
  walls.push({ id: 'shr_p2', x: 745, y: 530, w: 24, h: 24, kind: 'ruin_wall', blocksLight: true });
  walls.push({ id: 'shr_p3', x: 615, y: 660, w: 24, h: 24, kind: 'ruin_wall', blocksLight: true });
  walls.push({ id: 'shr_p4', x: 745, y: 660, w: 24, h: 24, kind: 'ruin_wall', blocksLight: true });
  containers.push(
    {
      id: 'c_shr_1',
      x: 690,
      y: 605,
      r: 18,
      kind: 'crate',
      zone: '枯林祭坛',
      searched: false,
      searchDuration: 1.7,
      loot: { fuel: 2, battery: 1, essence: 2 },
      angle: 0,
    },
    {
      id: 'c_shr_2',
      x: 645,
      y: 710,
      r: 17,
      kind: 'corpse',
      zone: '枯林祭坛',
      searched: false,
      searchDuration: 1.6,
      loot: { herbs: 2, wood: 2, scrap: 2 },
      angle: 2.1,
    }
  );

  // 新增地点的地表（只用于脚步声的 '#' 隐形地表 + 农庄院落/墓地/铁道口可见地表）
  zones.push({ name: '旧铁道口', x: 90, y: 940, w: 200, h: 80, surface: 'gravel' });
  zones.push({ name: '#墓地', x: -150, y: -1730, w: 260, h: 300, surface: 'mud' });

  // 庇护所门外 30 秒开局钩子：低耗时（1.2s）遇难者背包 + 周边基础物资（庇护所扩建后院落木柴与油桶外移到东西墙外）
  containers.push(
    {
      id: 'c_starter_backpack',
      x: -36,
      y: 184,
      r: 16,
      kind: 'backpack',
      zone: '迷雾深林',
      searched: false,
      searchDuration: 1.2,
      loot: { wood: 2, fuel: 1, herbs: 1 },
      angle: 0.35,
    },
    {
      id: 'c_yard_wood',
      x: 330,
      y: 70,
      r: 19,
      kind: 'logpile',
      zone: '迷雾深林',
      searched: false,
      searchDuration: 1.1,
      loot: { wood: 3 },
      angle: 0.2,
    },
    {
      id: 'c_yard_crate',
      x: -92,
      y: 215,
      r: 17,
      kind: 'crate',
      zone: '迷雾深林',
      searched: false,
      searchDuration: 1.2,
      loot: { fuel: 1, herbs: 2, scrap: 1 },
      angle: -0.15,
    },
    {
      id: 'c_yard_barrel',
      x: -335,
      y: 30,
      r: 17,
      kind: 'barrel',
      zone: '迷雾深林',
      searched: false,
      searchDuration: 1.2,
      loot: { fuel: 1, wood: 2 },
      angle: 0.6,
    }
  );

  // 建筑：静态墙体/窗/家具碰撞盒（共享只读）、房间地表、室内门与灯（每局克隆）、房间容器（每局克隆）
  const interiorDoors: InteriorDoor[] = [];
  const lights: BuildingLight[] = [];
  for (let i = 0; i < BUILDINGS.length; i++) {
    const b = BUILDINGS[i];
    for (let k = 0; k < b.walls.length; k++) walls.push(b.walls[k]);
    for (let k = 0; k < b.doorSpecs.length; k++) interiorDoors.push({ ...b.doorSpecs[k] });
    for (let k = 0; k < b.lightSpecs.length; k++) lights.push({ ...b.lightSpecs[k] });
    for (let k = 0; k < b.movableSpecs.length; k++) movables.push({ ...b.movableSpecs[k] });
    for (let k = 0; k < b.containerSpecs.length; k++) {
      const c = b.containerSpecs[k];
      containers.push({ ...c, loot: { ...c.loot } });
    }
    if (b.externalRoof && b.id !== 'h_in') continue;
    for (let k = 0; k < b.rooms.length; k++) {
      const rm = b.rooms[k];
      // 庇护所木地板由既有 '庇护所' 地表负责，只补充非木地板房间
      if (b.id === 'h_in' && rm.floor === 'plank') continue;
      zones.push({ name: '#' + rm.name, x: rm.x, y: rm.y, w: rm.w, h: rm.h, surface: surfaceOfFloor(rm.floor) });
    }
  }
  for (let k = 0; k < LAYOUT.yardWalls.length; k++) walls.push(LAYOUT.yardWalls[k]);

  // Additional scattered deep-forest containers（地图扩大约 3 倍面积，野外容器 14 → 26）
  const lootTemplates: Array<{
    kind: LootContainer['kind'];
    loot: LootContainer['loot'];
  }> = [
    { kind: 'logpile', loot: { wood: 3, herbs: 1 } },
    { kind: 'crate', loot: { scrap: 2, wood: 1 } },
    { kind: 'backpack', loot: { herbs: 2, battery: 1 } },
    { kind: 'barrel', loot: { fuel: 2 } },
    { kind: 'toolbox', loot: { scrap: 3 } },
    { kind: 'corpse', loot: { fuel: 1, herbs: 2, scrap: 1 } },
  ];

  const clearRects = LAYOUT.clearRects;
  const rails = LAYOUT.rails;
  const nearRail = function (px: number, py: number, pad: number): boolean {
    for (let i = 0; i < rails.length; i++) {
      if (distToPolyline(rails[i], px, py) < 26 + pad) return true;
    }
    return false;
  };

  let extraContainers = 0;
  let attempts = 0;
  while (extraContainers < 26 && attempts < 900) {
    attempts++;
    const x = (rng() * 2 - 1) * (WORLD_HALF - 180);
    const y = (rng() * 2 - 1) * (WORLD_HALF - 180);
    if (dist(x, y, 0, 0) < 420) continue;
    if (poiCenters.some((p) => dist(x, y, p.x, p.y) < p.r - 30)) continue;
    if (containers.some((c) => dist(x, y, c.x, c.y) < 160)) continue;
    if (pointInRects(clearRects, x, y, 10)) continue;
    if (nearRail(x, y, 20)) continue;

    const tpl = lootTemplates[extraContainers % lootTemplates.length];
    containers.push({
      id: `c_wild_${extraContainers}`,
      x,
      y,
      r: 17,
      kind: tpl.kind,
      zone: '迷雾深林',
      searched: false,
      searchDuration: 1.4,
      loot: { ...tpl.loot },
      angle: rng() * Math.PI * 2,
    });
    extraContainers++;
  }

  // Glowing Odd Essence Mushrooms
  const fixedEssence: Vec2[] = [
    { x: 690, y: 560 },
    { x: 720, y: 655 },
    { x: -490, y: 310 },
    { x: 450, y: -270 },
    { x: -380, y: -510 },
    { x: 350, y: 540 },
    { x: -910, y: 120 },
    { x: 930, y: 80 },
    // 新地点：墓地边、沼泽、农庄菜地、村落南、四角深林
    { x: 20, y: -1450 },
    { x: 1380, y: 1600 },
    { x: 1460, y: 1290 },
    { x: -1560, y: 92 },
    { x: 330, y: 1720 },
    { x: -1900, y: -900 },
    { x: 1900, y: -700 },
    { x: -1000, y: 1450 },
    { x: 1000, y: -1150 },
    { x: -1850, y: 1700 },
  ];
  fixedEssence.forEach((p, idx) => {
    essences.push({
      id: `ess_${idx}`,
      x: p.x,
      y: p.y,
      harvested: false,
      pulsePhase: rng() * Math.PI * 2,
    });
  });

  // Helper: distance from point to dirt path segments
  const nearPath = (px: number, py: number, pad: number): boolean => {
    for (const path of paths) {
      if (px < path.minX - pad || px > path.maxX + pad || py < path.minY - pad || py > path.maxY + pad) continue;
      for (let i = 0; i < path.points.length - 1; i++) {
        const a = path.points[i];
        const b = path.points[i + 1];
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const len2 = vx * vx + vy * vy || 1;
        const t = clamp(((px - a.x) * vx + (py - a.y) * vy) / len2, 0, 1);
        const cx = a.x + vx * t;
        const cy = a.y + vy * t;
        if (dist(px, py, cx, cy) < path.width * 0.5 + pad) return true;
      }
    }
    return false;
  };

  const tooClose = (list: Array<{ x: number; y: number }>, x: number, y: number, d: number): boolean => {
    const d2 = d * d;
    for (let i = 0; i < list.length; i++) {
      const dx = list[i].x - x;
      if (dx > d || dx < -d) continue;
      const dy = list[i].y - y;
      if (dy > d || dy < -d) continue;
      if (dx * dx + dy * dy < d2) return true;
    }
    return false;
  };

  // Scatter dense Baltic pine trees with guaranteed clear pathways & POI arenas（面积约 3.1 倍，尝试次数等比放大）
  let treeId = 0;
  for (let i = 0; i < 1950; i++) {
    const x = (rng() * 2 - 1) * (WORLD_HALF - 70);
    const y = (rng() * 2 - 1) * (WORLD_HALF - 70);

    // Keep hideout yard clear
    if (
      x > HIDEOUT_RECT.x - 105 &&
      x < HIDEOUT_RECT.x + HIDEOUT_RECT.w + 105 &&
      y > HIDEOUT_RECT.y - 105 &&
      y < HIDEOUT_RECT.y + HIDEOUT_RECT.h + 105
    ) {
      continue;
    }

    // Keep POIs navigable
    if (poiCenters.some((p) => dist(x, y, p.x, p.y) < p.r * 0.82)) continue;
    // 建筑院落、墓地、信号塔基座等保持开阔
    if (pointInRects(clearRects, x, y, 10)) continue;
    // Keep dirt paths unobstructed (guarantees 100% reachability!)
    if (nearPath(x, y, 36)) continue;
    if (nearRail(x, y, 30)) continue;
    // Keep away from containers, essences & relay nodes
    if (tooClose(containers, x, y, 58)) continue;
    if (tooClose(essences, x, y, 55)) continue;
    if (tooClose(relayNodes, x, y, 58)) continue;
    // Minimum spacing between tree trunks so player (r=15) never gets wedged
    if (tooClose(trees, x, y, 76)) continue;

    trees.push({
      id: treeId++,
      x,
      y,
      trunkR: 13 + rng() * 8,
      canopyR: 48 + rng() * 26,
      hueShift: (rng() - 0.5) * 14,
      phase: rng() * Math.PI * 2,
    });
  }

  // Scatter mossy boulders
  let rockId = 0;
  for (let i = 0; i < 210; i++) {
    const x = (rng() * 2 - 1) * (WORLD_HALF - 100);
    const y = (rng() * 2 - 1) * (WORLD_HALF - 100);
    if (dist(x, y, 0, 0) < 380) continue;
    if (poiCenters.some((p) => dist(x, y, p.x, p.y) < p.r * 0.85)) continue;
    if (pointInRects(clearRects, x, y, 20)) continue;
    if (nearPath(x, y, 34)) continue;
    if (nearRail(x, y, 34)) continue;
    if (tooClose(containers, x, y, 56)) continue;
    if (tooClose(essences, x, y, 50)) continue;
    if (tooClose(relayNodes, x, y, 56)) continue;
    if (tooClose(trees, x, y, 56)) continue;
    if (tooClose(rocks, x, y, 88)) continue;

    rocks.push({
      id: rockId++,
      x,
      y,
      r: 18 + rng() * 14,
      seed: rng() * 100,
    });
  }

  const grid = buildStaticGrid(walls, trees, rocks);
  const brambles = scatterBrambles(seed, trees, paths, poiCenters);

  return {
    seed,
    walls,
    barricades,
    movables,
    relayNodes,
    trees,
    rocks,
    containers,
    essences,
    zones,
    paths,
    poiCenters,
    buildings: BUILDINGS,
    interiorDoors,
    lights,
    yardProps: YARD_PROPS,
    rails: RAIL_LINES,
    brambles,
    grid,
  };
}

/**
 * 黑色枯枝灌木散布（独立随机流，不扰动树/石/容器的既有种子序列）
 * 集中在：树根旁、土路两侧林缘、建筑外墙角、地标空地边缘；排除室内
 */
function scatterBrambles(
  seed: number,
  trees: TreeObstacle[],
  paths: DirtPath[],
  pois: { name: string; x: number; y: number; r: number }[]
): Bramble[] {
  const rng = createRng((seed ^ 0x5bd1e995) >>> 0);
  const out: Bramble[] = [];
  const lim = WORLD_HALF - 60;
  const add = function (x: number, y: number, scale: number) {
    if (out.length >= 1100) return;
    if (x < -lim || x > lim || y < -lim || y > lim) return;
    if (buildingIndexAt(BUILDINGS, x, y, -6) >= 0) return;
    out.push({
      x,
      y,
      rot: rng() * Math.PI * 2,
      scale,
      variant: Math.floor(rng() * BRAMBLE_VARIANTS) % BRAMBLE_VARIANTS,
    });
  };
  // 1. 树根：每两棵树一簇，贴着树干外缘
  for (let i = 0; i < trees.length; i += 2) {
    const t = trees[i];
    const a = rng() * Math.PI * 2;
    const d = t.trunkR + 6 + rng() * 14;
    add(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d, 0.55 + rng() * 0.45);
  }
  // 2. 土路两侧林缘：每 90px 一次，左右各约 55% 概率
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi];
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i];
      const b = path.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1) continue;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      for (let s = 30; s < len; s += 90) {
        const px = a.x + ((b.x - a.x) * s) / len;
        const py = a.y + ((b.y - a.y) * s) / len;
        for (let side = -1; side <= 1; side += 2) {
          if (rng() > 0.55) continue;
          const off = path.width * 0.5 + 8 + rng() * 22;
          add(px + nx * off * side, py + ny * off * side, 0.6 + rng() * 0.5);
        }
      }
    }
  }
  // 3. 建筑外墙角（含庇护所）
  for (let i = 0; i < BUILDINGS.length; i++) {
    const b = BUILDINGS[i];
    for (let c = 0; c < 4; c++) {
      if (rng() > 0.85) continue;
      const cx = c % 2 === 0 ? b.x - 10 - rng() * 10 : b.x + b.w + 10 + rng() * 10;
      const cy = c < 2 ? b.y - 10 - rng() * 10 : b.y + b.h + 10 + rng() * 10;
      add(cx, cy, 0.7 + rng() * 0.45);
    }
  }
  // 4. 地标空地边缘（光区边缘伸入的枯枝）
  for (let i = 0; i < pois.length; i++) {
    const p = pois[i];
    for (let k = 0; k < 7; k++) {
      const a = rng() * Math.PI * 2;
      const d = p.r * (0.82 + rng() * 0.16);
      add(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 0.8 + rng() * 0.5);
    }
  }
  return out;
}

/**
 * 单源真相碰撞解算：解析圆形实体与世界边界、墙体、完好门窗木板、关闭的室内门、可拖拽家具、树干与巨石的碰撞
 * 约束最后：所有移动、闪避、拖拽、击退后均必须统一调用
 * 静态墙/树/石走均匀网格索引（只读），动态阻挡物（门窗木板、室内门、家具）数量少，全量遍历
 */
export function resolveWorldCollision(
  world: WorldData,
  x: number,
  y: number,
  radius: number,
  blockByWindows: boolean,
  skipMovableId?: string,
  // 玩家专用：自家庇护所的门无论是否钉板都可推开挤过（怪物仍被完好门板阻挡），杜绝夜里被关在门外的软锁；
  // 同理玩家可推开关闭的室内门（engine 检测接触后把门打开），怪物需撞门约 1.5s
  passDoors = false
): Vec2 {
  let px = clamp(x, -WORLD_HALF + radius + 30, WORLD_HALF - radius - 30);
  let py = clamp(y, -WORLD_HALF + radius + 30, WORLD_HALF - radius - 30);
  const g = world.grid;
  const walls = world.walls;
  const trees = world.trees;
  const rocks = world.rocks;
  const cols = g.cols;

  // 2 passes resolve corners cleanly without tunneling
  for (let pass = 0; pass < 2; pass++) {
    {
      const reach = radius + 4;
      const cx0 = cellOf(g, px - reach);
      const cx1 = cellOf(g, px + reach);
      const cy0 = cellOf(g, py - reach);
      const cy1 = cellOf(g, py + reach);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const ci = cy * cols + cx;
          const end = g.wallStart[ci + 1];
          for (let k = g.wallStart[ci]; k < end; k++) {
            const w = walls[g.wallItems[k]];
            const pushed = resolveCircleRect(px, py, radius, w.x, w.y, w.w, w.h);
            if (pushed) {
              px = pushed.x;
              py = pushed.y;
            }
          }
        }
      }
    }

    for (let i = 0; i < world.barricades.length; i++) {
      const b = world.barricades[i];
      // Intact barricades block everyone; unbarricaded windows still block player walking through
      if (passDoors && b.kind === 'door') continue;
      const solid = b.hp > 0 || (blockByWindows && b.kind === 'window');
      if (!solid) continue;
      const pushed = resolveCircleRect(px, py, radius, b.x, b.y, b.w, b.h);
      if (pushed) {
        px = pushed.x;
        py = pushed.y;
      }
    }

    if (!passDoors) {
      const doors = world.interiorDoors;
      for (let i = 0; i < doors.length; i++) {
        const d = doors[i];
        if (d.open) continue;
        if (px + radius < d.x || px - radius > d.x + d.w || py + radius < d.y || py - radius > d.y + d.h) continue;
        const pushed = resolveCircleRect(px, py, radius, d.x, d.y, d.w, d.h);
        if (pushed) {
          px = pushed.x;
          py = pushed.y;
        }
      }
    }

    for (let i = 0; i < world.movables.length; i++) {
      const m = world.movables[i];
      if (m.hp <= 0 || m.id === skipMovableId) continue;
      const pushed = resolveCircleRect(px, py, radius, m.x, m.y, m.w, m.h);
      if (pushed) {
        px = pushed.x;
        py = pushed.y;
      }
    }

    {
      const reach = radius + 24;
      const cx0 = cellOf(g, px - reach);
      const cx1 = cellOf(g, px + reach);
      const cy0 = cellOf(g, py - reach);
      const cy1 = cellOf(g, py + reach);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const ci = cy * cols + cx;
          const end = g.treeStart[ci + 1];
          for (let k = g.treeStart[ci]; k < end; k++) {
            const t = trees[g.treeItems[k]];
            if (Math.abs(px - t.x) > 48 || Math.abs(py - t.y) > 48) continue;
            const pushed = resolveCircleCircle(px, py, radius, t.x, t.y, t.trunkR);
            if (pushed) {
              px = pushed.x;
              py = pushed.y;
            }
          }
        }
      }
    }

    {
      const reach = radius + 34;
      const cx0 = cellOf(g, px - reach);
      const cx1 = cellOf(g, px + reach);
      const cy0 = cellOf(g, py - reach);
      const cy1 = cellOf(g, py + reach);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const ci = cy * cols + cx;
          const end = g.rockStart[ci + 1];
          for (let k = g.rockStart[ci]; k < end; k++) {
            const r = rocks[g.rockItems[k]];
            if (Math.abs(px - r.x) > 54 || Math.abs(py - r.y) > 54) continue;
            const pushed = resolveCircleCircle(px, py, radius, r.x, r.y, r.r);
            if (pushed) {
              px = pushed.x;
              py = pushed.y;
            }
          }
        }
      }
    }
  }

  return { x: px, y: py };
}

/**
 * 解析矩形与矩形的重叠分离（最小穿透轴推挤）
 */
function resolveRectRect(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number
): Vec2 | null {
  const ox = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const oy = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  if (ox <= 0 || oy <= 0) return null;
  const acx = ax + aw * 0.5;
  const acy = ay + ah * 0.5;
  const bcx = bx + bw * 0.5;
  const bcy = by + bh * 0.5;
  if (ox < oy) {
    return { x: acx < bcx ? ax - ox : ax + ox, y: ay };
  }
  return { x: ax, y: acy < bcy ? ay - oy : ay + oy };
}

/**
 * 可拖拽重型家具的世界碰撞解算（单源真相：防止穿入墙体、完整门窗、关闭的室内门、其他家具、树石或越界）
 */
export function resolveFurnitureCollision(world: WorldData, furn: MovableFurniture): Vec2 {
  let fx = clamp(furn.x, -WORLD_HALF + 32, WORLD_HALF - furn.w - 32);
  let fy = clamp(furn.y, -WORLD_HALF + 32, WORLD_HALF - furn.h - 32);
  const g = world.grid;
  const cols = g.cols;

  for (let pass = 0; pass < 3; pass++) {
    {
      const cx0 = cellOf(g, fx - 6);
      const cx1 = cellOf(g, fx + furn.w + 6);
      const cy0 = cellOf(g, fy - 6);
      const cy1 = cellOf(g, fy + furn.h + 6);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const ci = cy * cols + cx;
          const end = g.wallStart[ci + 1];
          for (let k = g.wallStart[ci]; k < end; k++) {
            const w = world.walls[g.wallItems[k]];
            const pushed = resolveRectRect(fx, fy, furn.w, furn.h, w.x, w.y, w.w, w.h);
            if (pushed) {
              fx = pushed.x;
              fy = pushed.y;
            }
          }
        }
      }
    }

    for (let i = 0; i < world.barricades.length; i++) {
      const b = world.barricades[i];
      // 家具不能穿过完好的木板或任何窗框（允许抵在门窗内侧但不可穿出）
      const solid = b.hp > 0 || b.kind === 'window';
      if (!solid) continue;
      const pushed = resolveRectRect(fx, fy, furn.w, furn.h, b.x, b.y, b.w, b.h);
      if (pushed) {
        fx = pushed.x;
        fy = pushed.y;
      }
    }

    for (let i = 0; i < world.interiorDoors.length; i++) {
      const d = world.interiorDoors[i];
      if (d.open) continue;
      const pushed = resolveRectRect(fx, fy, furn.w, furn.h, d.x, d.y, d.w, d.h);
      if (pushed) {
        fx = pushed.x;
        fy = pushed.y;
      }
    }

    for (let i = 0; i < world.movables.length; i++) {
      const other = world.movables[i];
      if (other.id === furn.id || other.hp <= 0) continue;
      const pushed = resolveRectRect(fx, fy, furn.w, furn.h, other.x, other.y, other.w, other.h);
      if (pushed) {
        fx = pushed.x;
        fy = pushed.y;
      }
    }

    {
      const cx0 = cellOf(g, fx - 30);
      const cx1 = cellOf(g, fx + furn.w + 30);
      const cy0 = cellOf(g, fy - 30);
      const cy1 = cellOf(g, fy + furn.h + 30);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const ci = cy * cols + cx;
          const tEnd = g.treeStart[ci + 1];
          for (let k = g.treeStart[ci]; k < tEnd; k++) {
            const t = world.trees[g.treeItems[k]];
            if (Math.abs(fx + furn.w * 0.5 - t.x) > 80 || Math.abs(fy + furn.h * 0.5 - t.y) > 80) continue;
            const pushed = resolveCircleRect(t.x, t.y, t.trunkR, fx, fy, furn.w, furn.h);
            if (pushed) {
              fx -= pushed.x - t.x;
              fy -= pushed.y - t.y;
            }
          }
          const rEnd = g.rockStart[ci + 1];
          for (let k = g.rockStart[ci]; k < rEnd; k++) {
            const r = world.rocks[g.rockItems[k]];
            if (Math.abs(fx + furn.w * 0.5 - r.x) > 85 || Math.abs(fy + furn.h * 0.5 - r.y) > 85) continue;
            const pushed = resolveCircleRect(r.x, r.y, r.r, fx, fy, furn.w, furn.h);
            if (pushed) {
              fx -= pushed.x - r.x;
              fy -= pushed.y - r.y;
            }
          }
        }
      }
    }
  }

  fx = clamp(fx, -WORLD_HALF + 32, WORLD_HALF - furn.w - 32);
  fy = clamp(fy, -WORLD_HALF + 32, WORLD_HALF - furn.h - 32);
  return { x: fx, y: fy };
}

/** 庇护所专用室内判定（原语义保留：外框内缩 12px；发电机/围攻/HUD inHideout 等庇护所逻辑使用） */
export function isPointInHideout(x: number, y: number): boolean {
  return (
    x >= HIDEOUT_RECT.x + 12 &&
    x <= HIDEOUT_RECT.x + HIDEOUT_RECT.w - 12 &&
    y >= HIDEOUT_RECT.y + 12 &&
    y <= HIDEOUT_RECT.y + HIDEOUT_RECT.h - 12
  );
}

/** 任意建筑室内判定（单源：屋顶渐隐、室内混响/雨打屋顶、室内不落雨共用；与 isPointInHideout 同一内缩口径） */
export function isPointIndoors(x: number, y: number): boolean {
  return buildingIndexAt(BUILDINGS, x, y, 12) >= 0;
}

/** 点所在建筑索引（world.buildings / BUILDINGS 下标），不在室内返回 -1 */
export function buildingAt(x: number, y: number): number {
  return buildingIndexAt(BUILDINGS, x, y, 12);
}

export function getSurfaceAt(world: WorldData, x: number, y: number): 'wood' | 'mud' | 'gravel' {
  // 后压入的地表更具体（建筑房间 '#' 地表覆盖整栋屋地表），逆序命中
  for (let i = world.zones.length - 1; i >= 0; i--) {
    const z = world.zones[i];
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) {
      return z.surface;
    }
  }
  return 'mud';
}

export function getZoneNameAt(world: WorldData, x: number, y: number): string {
  if (isPointInHideout(x, y)) return '庇护所';
  for (let i = 0; i < world.poiCenters.length; i++) {
    const p = world.poiCenters[i];
    if (dist(x, y, p.x, p.y) <= p.r + 35) return p.name;
  }
  return '迷雾深林';
}

// 遮挡线段对象池（每帧零分配：调用方在下一次调用前消费完结果）
const segPool: Segment[] = [];
let segUsed = 0;

function pushSeg(out: Segment[], ax: number, ay: number, bx: number, by: number) {
  let s = segPool[segUsed];
  if (!s) {
    s = { ax: 0, ay: 0, bx: 0, by: 0 };
    segPool[segUsed] = s;
  }
  segUsed++;
  s.ax = ax;
  s.ay = ay;
  s.bx = bx;
  s.by = by;
  out.push(s);
}

/**
 * Collect light-occluding segments near a light origin (Single Source of Truth with world walls/trees/barricades).
 * 静态墙/树/石走网格索引；返回的线段来自对象池，仅在下一次调用前有效
 */
export function collectOccluderSegments(
  world: WorldData,
  ox: number,
  oy: number,
  maxDist: number,
  out: Segment[]
): Segment[] {
  out.length = 0;
  segUsed = 0;
  const pad = maxDist + 40;
  const g = world.grid;
  const cols = g.cols;

  // Bounding box around light range
  pushSeg(out, ox - maxDist, oy - maxDist, ox + maxDist, oy - maxDist);
  pushSeg(out, ox + maxDist, oy - maxDist, ox + maxDist, oy + maxDist);
  pushSeg(out, ox + maxDist, oy + maxDist, ox - maxDist, oy + maxDist);
  pushSeg(out, ox - maxDist, oy + maxDist, ox - maxDist, oy - maxDist);

  const cx0 = cellOf(g, ox - pad);
  const cx1 = cellOf(g, ox + pad);
  const cy0 = cellOf(g, oy - pad);
  const cy1 = cellOf(g, oy + pad);

  g.stamp = (g.stamp + 1) >>> 0;
  if (g.stamp === 0) {
    g.wallStamp.fill(0);
    g.stamp = 1;
  }
  const stamp = g.stamp;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const ci = cy * cols + cx;
      const end = g.wallStart[ci + 1];
      for (let k = g.wallStart[ci]; k < end; k++) {
        const wi = g.wallItems[k];
        if (g.wallStamp[wi] === stamp) continue;
        g.wallStamp[wi] = stamp;
        const w = world.walls[wi];
        if (!w.blocksLight) continue;
        if (w.x + w.w < ox - pad || w.x > ox + pad || w.y + w.h < oy - pad || w.y > oy + pad) continue;
        pushSeg(out, w.x, w.y, w.x + w.w, w.y);
        pushSeg(out, w.x + w.w, w.y, w.x + w.w, w.y + w.h);
        pushSeg(out, w.x + w.w, w.y + w.h, w.x, w.y + w.h);
        pushSeg(out, w.x, w.y + w.h, w.x, w.y);
      }
    }
  }

  // Intact barricades also block sight/light (Darkwood claustrophobia!)
  for (let i = 0; i < world.barricades.length; i++) {
    const b = world.barricades[i];
    if (b.hp <= 0) continue;
    if (b.x + b.w < ox - pad || b.x > ox + pad || b.y + b.h < oy - pad || b.y > oy + pad) continue;
    if (b.orientation === 'h') {
      const my = b.y + b.h * 0.5;
      pushSeg(out, b.x, my, b.x + b.w, my);
    } else {
      const mx = b.x + b.w * 0.5;
      pushSeg(out, mx, b.y, mx, b.y + b.h);
    }
  }

  // 关闭的室内门：门扇中线遮光（门缝不透光，开门后光线才泄入走廊）
  const doors = world.interiorDoors;
  for (let i = 0; i < doors.length; i++) {
    const d = doors[i];
    if (d.open) continue;
    if (d.x + d.w < ox - pad || d.x > ox + pad || d.y + d.h < oy - pad || d.y > oy + pad) continue;
    if (d.orientation === 'h') {
      const my = d.y + d.h * 0.5;
      pushSeg(out, d.x, my, d.x + d.w, my);
    } else {
      const mx = d.x + d.w * 0.5;
      pushSeg(out, mx, d.y, mx, d.y + d.h);
    }
  }

  // 可拖拽重型家具（单源真相：完好家具对低角度手电光/射线投射柔和缩进遮挡，橡木柜较高阻光更明显）
  for (let i = 0; i < world.movables.length; i++) {
    const m = world.movables[i];
    if (m.hp <= 0) continue;
    if (m.x + m.w < ox - pad || m.x > ox + pad || m.y + m.h < oy - pad || m.y > oy + pad) continue;
    // 光源恰好位于家具矩形内部时跳过，避免自遮挡黑块
    if (ox >= m.x - 2 && ox <= m.x + m.w + 2 && oy >= m.y - 2 && oy <= m.y + m.h + 2) continue;
    const inset = m.kind === 'cabinet' ? 2 : 5;
    const x1 = m.x + inset;
    const y1 = m.y + inset;
    const x2 = m.x + m.w - inset;
    const y2 = m.y + m.h - inset;
    if (x2 <= x1 || y2 <= y1) continue;
    pushSeg(out, x1, y1, x2, y1);
    pushSeg(out, x2, y1, x2, y2);
    pushSeg(out, x2, y2, x1, y2);
    pushSeg(out, x1, y2, x1, y1);
  }

  // Tree trunks cast crisp perpendicular shadow chords facing the light origin
  const pad2 = pad * pad;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const ci = cy * cols + cx;
      const tEnd = g.treeStart[ci + 1];
      for (let k = g.treeStart[ci]; k < tEnd; k++) {
        const t = world.trees[g.treeItems[k]];
        const dx = t.x - ox;
        const dy = t.y - oy;
        const d2 = dx * dx + dy * dy;
        if (d2 > pad2 || d2 < 25) continue;
        const d = Math.sqrt(d2);
        const nx = (-dy / d) * t.trunkR;
        const ny = (dx / d) * t.trunkR;
        pushSeg(out, t.x - nx, t.y - ny, t.x + nx, t.y + ny);
      }
      // Large boulders cast shadows too
      const rEnd = g.rockStart[ci + 1];
      for (let k = g.rockStart[ci]; k < rEnd; k++) {
        const r = world.rocks[g.rockItems[k]];
        const dx = r.x - ox;
        const dy = r.y - oy;
        const d2 = dx * dx + dy * dy;
        if (d2 > pad2 || d2 < 25) continue;
        const d = Math.sqrt(d2);
        const nx = (-dy / d) * (r.r * 0.85);
        const ny = (dx / d) * (r.r * 0.85);
        pushSeg(out, r.x - nx, r.y - ny, r.x + nx, r.y + ny);
      }
    }
  }

  return out;
}
