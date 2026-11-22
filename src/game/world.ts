// Deterministic procedural Darkwood world generator (Single Source of Truth for physics & lighting)

import {
  BarricadeSlot,
  CraftRecipe,
  EssenceNode,
  FloorZone,
  LootContainer,
  RectObstacle,
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

export const WORLD_SIZE = 2600;
export const WORLD_HALF = WORLD_SIZE / 2;

export const HIDEOUT_RECT = {
  x: -170,
  y: -140,
  w: 340,
  h: 280,
};

export const GENERATOR_POS: Vec2 = { x: -118, y: -88 };
export const WORKBENCH_POS: Vec2 = { x: 112, y: -92 };
export const SHELTER_LAMPS: Vec2[] = [
  { x: -65, y: 15 },
  { x: 75, y: 20 },
];

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
}

export interface WorldData {
  seed: number;
  walls: RectObstacle[];
  barricades: BarricadeSlot[];
  trees: TreeObstacle[];
  rocks: RockObstacle[];
  containers: LootContainer[];
  essences: EssenceNode[];
  zones: FloorZone[];
  paths: DirtPath[];
  poiCenters: { name: string; x: number; y: number; r: number }[];
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

export function createWorld(seed = 19847): WorldData {
  const rng = createRng(seed);
  const walls: RectObstacle[] = [];
  const barricades: BarricadeSlot[] = [];
  const trees: TreeObstacle[] = [];
  const rocks: RockObstacle[] = [];
  const containers: LootContainer[] = [];
  const essences: EssenceNode[] = [];
  const zones: FloorZone[] = [];

  addHideoutCabin(walls, barricades, zones);

  // Four atmospheric exploration POIs around the central Hideout
  const poiCenters = [
    { name: '坠毁货车', x: -680, y: -560, r: 195 },
    { name: '废弃锯木厂', x: 740, y: -490, r: 225 },
    { name: '猎人营地', x: -640, y: 630, r: 190 },
    { name: '枯林祭坛', x: 690, y: 610, r: 205 },
  ];

  // Dirt paths connecting Hideout to the 4 landmarks (clear of dense trees)
  const paths: DirtPath[] = [
    {
      width: 56,
      points: [
        { x: 0, y: 155 },
        { x: -120, y: 290 },
        { x: -370, y: 460 },
        { x: -620, y: 610 },
      ],
    },
    {
      width: 54,
      points: [
        { x: 185, y: 0 },
        { x: 420, y: -140 },
        { x: 610, y: -340 },
        { x: 740, y: -490 },
      ],
    },
    {
      width: 50,
      points: [
        { x: -140, y: 210 },
        { x: -360, y: -40 },
        { x: -530, y: -320 },
        { x: -680, y: -560 },
      ],
    },
    {
      width: 48,
      points: [
        { x: 160, y: 150 },
        { x: 380, y: 310 },
        { x: 540, y: 470 },
        { x: 690, y: 610 },
      ],
    },
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

  // Nearby starter supplies just outside Hideout so player discovers scavenging within 8 seconds
  containers.push(
    {
      id: 'c_yard_wood',
      x: 225,
      y: 75,
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
      x: -78,
      y: 205,
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
      x: -235,
      y: -40,
      r: 17,
      kind: 'barrel',
      zone: '迷雾深林',
      searched: false,
      searchDuration: 1.2,
      loot: { fuel: 1, wood: 2 },
      angle: 0.6,
    }
  );

  // Additional scattered deep-forest containers
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

  let extraContainers = 0;
  let attempts = 0;
  while (extraContainers < 14 && attempts < 400) {
    attempts++;
    const x = (rng() * 2 - 1) * (WORLD_HALF - 180);
    const y = (rng() * 2 - 1) * (WORLD_HALF - 180);
    if (dist(x, y, 0, 0) < 340) continue;
    if (poiCenters.some((p) => dist(x, y, p.x, p.y) < p.r - 30)) continue;
    if (containers.some((c) => dist(x, y, c.x, c.y) < 160)) continue;

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

  // Scatter dense Baltic pine trees with guaranteed clear pathways & POI arenas
  let treeId = 0;
  for (let i = 0; i < 620; i++) {
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
    // Keep dirt paths unobstructed (guarantees 100% reachability!)
    if (nearPath(x, y, 36)) continue;
    // Keep away from containers & essences
    if (containers.some((c) => dist(x, y, c.x, c.y) < 58)) continue;
    if (essences.some((e) => dist(x, y, e.x, e.y) < 55)) continue;
    // Minimum spacing between tree trunks so player (r=15) never gets wedged
    if (trees.some((t) => dist(x, y, t.x, t.y) < 76)) continue;

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
  for (let i = 0; i < 68; i++) {
    const x = (rng() * 2 - 1) * (WORLD_HALF - 100);
    const y = (rng() * 2 - 1) * (WORLD_HALF - 100);
    if (dist(x, y, 0, 0) < 310) continue;
    if (poiCenters.some((p) => dist(x, y, p.x, p.y) < p.r * 0.85)) continue;
    if (nearPath(x, y, 34)) continue;
    if (containers.some((c) => dist(x, y, c.x, c.y) < 56)) continue;
    if (trees.some((t) => dist(x, y, t.x, t.y) < 56)) continue;
    if (rocks.some((r) => dist(x, y, r.x, r.y) < 88)) continue;

    rocks.push({
      id: rockId++,
      x,
      y,
      r: 18 + rng() * 14,
      seed: rng() * 100,
    });
  }

  return {
    seed,
    walls,
    barricades,
    trees,
    rocks,
    containers,
    essences,
    zones,
    paths,
    poiCenters,
  };
}

/**
 * Single Source of Truth: resolve entity circle against world bounds, walls, intact barricades, trees, rocks.
 * Constraints Last: always call after all movement & knockback displacements.
 */
export function resolveWorldCollision(
  world: WorldData,
  x: number,
  y: number,
  radius: number,
  blockByWindows: boolean
): Vec2 {
  let px = clamp(x, -WORLD_HALF + radius + 30, WORLD_HALF - radius - 30);
  let py = clamp(y, -WORLD_HALF + radius + 30, WORLD_HALF - radius - 30);

  // 2 passes resolve corners cleanly without tunneling
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < world.walls.length; i++) {
      const w = world.walls[i];
      const pushed = resolveCircleRect(px, py, radius, w.x, w.y, w.w, w.h);
      if (pushed) {
        px = pushed.x;
        py = pushed.y;
      }
    }

    for (let i = 0; i < world.barricades.length; i++) {
      const b = world.barricades[i];
      // Intact barricades block everyone; unbarricaded windows still block player walking through
      const solid = b.hp > 0 || (blockByWindows && b.kind === 'window');
      if (!solid) continue;
      const pushed = resolveCircleRect(px, py, radius, b.x, b.y, b.w, b.h);
      if (pushed) {
        px = pushed.x;
        py = pushed.y;
      }
    }

    for (let i = 0; i < world.trees.length; i++) {
      const t = world.trees[i];
      if (Math.abs(px - t.x) > 48 || Math.abs(py - t.y) > 48) continue;
      const pushed = resolveCircleCircle(px, py, radius, t.x, t.y, t.trunkR);
      if (pushed) {
        px = pushed.x;
        py = pushed.y;
      }
    }

    for (let i = 0; i < world.rocks.length; i++) {
      const r = world.rocks[i];
      if (Math.abs(px - r.x) > 54 || Math.abs(py - r.y) > 54) continue;
      const pushed = resolveCircleCircle(px, py, radius, r.x, r.y, r.r);
      if (pushed) {
        px = pushed.x;
        py = pushed.y;
      }
    }
  }

  return { x: px, y: py };
}

export function isPointInHideout(x: number, y: number): boolean {
  return (
    x >= HIDEOUT_RECT.x + 12 &&
    x <= HIDEOUT_RECT.x + HIDEOUT_RECT.w - 12 &&
    y >= HIDEOUT_RECT.y + 12 &&
    y <= HIDEOUT_RECT.y + HIDEOUT_RECT.h - 12
  );
}

export function getSurfaceAt(world: WorldData, x: number, y: number): 'wood' | 'mud' | 'gravel' {
  for (let i = 0; i < world.zones.length; i++) {
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

/**
 * Collect light-occluding segments near a light origin (Single Source of Truth with world walls/trees/barricades).
 */
export function collectOccluderSegments(
  world: WorldData,
  ox: number,
  oy: number,
  maxDist: number,
  out: Segment[]
): Segment[] {
  out.length = 0;
  const pad = maxDist + 40;

  // Bounding box around light range
  out.push(
    { ax: ox - maxDist, ay: oy - maxDist, bx: ox + maxDist, by: oy - maxDist },
    { ax: ox + maxDist, ay: oy - maxDist, bx: ox + maxDist, by: oy + maxDist },
    { ax: ox + maxDist, ay: oy + maxDist, bx: ox - maxDist, by: oy + maxDist },
    { ax: ox - maxDist, ay: oy + maxDist, bx: ox - maxDist, by: oy - maxDist }
  );

  for (let i = 0; i < world.walls.length; i++) {
    const w = world.walls[i];
    if (!w.blocksLight) continue;
    if (w.x + w.w < ox - pad || w.x > ox + pad || w.y + w.h < oy - pad || w.y > oy + pad) continue;
    out.push(
      { ax: w.x, ay: w.y, bx: w.x + w.w, by: w.y },
      { ax: w.x + w.w, ay: w.y, bx: w.x + w.w, by: w.y + w.h },
      { ax: w.x + w.w, ay: w.y + w.h, bx: w.x, by: w.y + w.h },
      { ax: w.x, ay: w.y + w.h, bx: w.x, by: w.y }
    );
  }

  // Intact barricades also block sight/light (Darkwood claustrophobia!)
  for (let i = 0; i < world.barricades.length; i++) {
    const b = world.barricades[i];
    if (b.hp <= 0) continue;
    if (b.x + b.w < ox - pad || b.x > ox + pad || b.y + b.h < oy - pad || b.y > oy + pad) continue;
    if (b.orientation === 'h') {
      const my = b.y + b.h * 0.5;
      out.push({ ax: b.x, ay: my, bx: b.x + b.w, by: my });
    } else {
      const mx = b.x + b.w * 0.5;
      out.push({ ax: mx, ay: b.y, bx: mx, by: b.y + b.h });
    }
  }

  // Tree trunks cast crisp perpendicular shadow chords facing the light origin
  for (let i = 0; i < world.trees.length; i++) {
    const t = world.trees[i];
    const dx = t.x - ox;
    const dy = t.y - oy;
    const d2 = dx * dx + dy * dy;
    if (d2 > pad * pad || d2 < 25) continue;
    const d = Math.sqrt(d2);
    const nx = (-dy / d) * t.trunkR;
    const ny = (dx / d) * t.trunkR;
    out.push({ ax: t.x - nx, ay: t.y - ny, bx: t.x + nx, by: t.y + ny });
  }

  // Large boulders cast shadows too
  for (let i = 0; i < world.rocks.length; i++) {
    const r = world.rocks[i];
    const dx = r.x - ox;
    const dy = r.y - oy;
    const d2 = dx * dx + dy * dy;
    if (d2 > pad * pad || d2 < 25) continue;
    const d = Math.sqrt(d2);
    const nx = (-dy / d) * (r.r * 0.85);
    const ny = (dx / d) * (r.r * 0.85);
    out.push({ ax: r.x - nx, ay: r.y - ny, bx: r.x + nx, by: r.y + ny });
  }

  return out;
}
