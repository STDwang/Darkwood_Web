// 建筑与室外叙事摆件渲染（第三轮关卡执行独占）
// - 只读 engine.world（建筑静态布局 / 室内门 / 灯）与 engine 的时间、发电机、屋顶 alpha，绝不写游戏状态
// - 分三层由 renderer 少量调用：地面层（地板、地面污渍、铁轨、栈道积水）→ 陈设层（家具、窗、门扇、灯座、院落实体）
//   → 顶灯层（吊灯，仅室内屋顶渐隐时）；GPU 灯光推入走 pushBuildingLights（对象池复用，每帧零分配）
// - 叙事物件（血迹、尸形、土坑、散落物）按主美 R3 第 9 条用低对比"污渍式"绘法融入地面，走近才发现

import type { GameEngine } from '../engine';
import type { Enemy } from '../types';
import type { GpuLight } from '../webglComposer';
import { Building, BuildingLight, BuildingProp, InteriorDoor, isLightLit, lightFlicker } from '../buildings';
import { Vec2 } from '../util';
import { computeVisibilityPolygon, hasLineOfSight } from '../visibility';
import { Variants } from '../variants';

// 视口（每次调用前设置，避免闭包分配）
let vL = 0;
let vT = 0;
let vR = 0;
let vB = 0;

function rectVisible(x: number, y: number, w: number, h: number, pad: number): boolean {
  const x0 = w < 0 ? x + w : x;
  const y0 = h < 0 ? y + h : y;
  const aw = w < 0 ? -w : w;
  const ah = h < 0 ? -h : h;
  return x0 + aw >= vL - pad && x0 <= vR + pad && y0 + ah >= vT - pad && y0 <= vB + pad;
}

function buildingVisible(b: Building, pad: number): boolean {
  return rectVisible(b.x, b.y, b.w, b.h, pad);
}

/** 确定性 0..1 哈希（纯函数） */
function h01(seed: number, k: number): number {
  const v = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function genPowered(engine: GameEngine): boolean {
  return engine.generatorOn && engine.generatorFuel > 0;
}

/** 某栋建筑是否有亮着的灯（供屋顶暖光外溢） */
export function buildingHasLitLight(engine: GameEngine, index: number): boolean {
  const b = engine.world.buildings[index];
  if (!b) return false;
  const gen = genPowered(engine);
  const lights = engine.world.lights;
  for (let i = b.lightStart; i < b.lightStart + b.lightCount; i++) {
    const l = lights[i];
    if (l && isLightLit(l, gen)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 地面层
// ---------------------------------------------------------------------------

function drawFloor(ctx: CanvasRenderingContext2D, b: Building, woodPat: CanvasPattern | null) {
  const isHideout = b.id === 'h_in';
  for (let i = 0; i < b.rooms.length; i++) {
    const r = b.rooms[i];
    if (!rectVisible(r.x, r.y, r.w, r.h, 20)) continue;
    const seed = Math.abs(Math.floor(r.x * 0.37 + r.y * 0.71));
    if (r.floor === 'plank') {
      if (isHideout) continue; // 庇护所木地板由既有地表负责
      ctx.fillStyle = woodPat ?? '#3a2c1f';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(16, 12, 9, 0.22)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      // 顺长边铺的地板缝
      ctx.strokeStyle = 'rgba(10, 7, 5, 0.42)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (r.w >= r.h) {
        for (let y = r.y + 9; y < r.y + r.h; y += 13) {
          ctx.moveTo(r.x, y);
          ctx.lineTo(r.x + r.w, y);
        }
      } else {
        for (let x = r.x + 9; x < r.x + r.w; x += 13) {
          ctx.moveTo(x, r.y);
          ctx.lineTo(x, r.y + r.h);
        }
      }
      ctx.stroke();
    } else if (r.floor === 'tile') {
      ctx.fillStyle = '#35362f';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      // 缺损/污黄的瓷砖
      const ts = 22;
      for (let ty = 0; ty * ts < r.h; ty++) {
        for (let tx = 0; tx * ts < r.w; tx++) {
          const q = h01(seed, tx * 31 + ty * 7);
          if (q < 0.16) {
            ctx.fillStyle = q < 0.05 ? 'rgba(10, 10, 9, 0.55)' : 'rgba(62, 58, 44, 0.45)';
            ctx.fillRect(r.x + tx * ts + 1, r.y + ty * ts + 1, Math.min(ts - 2, r.w - tx * ts - 2), Math.min(ts - 2, r.h - ty * ts - 2));
          }
        }
      }
      ctx.strokeStyle = 'rgba(14, 14, 12, 0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let x = r.x + ts; x < r.x + r.w; x += ts) {
        ctx.moveTo(x, r.y);
        ctx.lineTo(x, r.y + r.h);
      }
      for (let y = r.y + ts; y < r.y + r.h; y += ts) {
        ctx.moveTo(r.x, y);
        ctx.lineTo(r.x + r.w, y);
      }
      ctx.stroke();
      // 裂缝
      ctx.strokeStyle = 'rgba(8, 8, 7, 0.5)';
      ctx.beginPath();
      const cx = r.x + h01(seed, 3) * r.w;
      const cy = r.y + h01(seed, 4) * r.h;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + 18, cy + 7);
      ctx.lineTo(cx + 26, cy + 21);
      ctx.moveTo(cx + 18, cy + 7);
      ctx.lineTo(cx + 30, cy + 2);
      ctx.stroke();
    } else if (r.floor === 'dirt') {
      ctx.fillStyle = isHideout ? 'rgba(40, 33, 24, 0.82)' : '#2b241b';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = k % 2 === 0 ? 'rgba(16, 13, 9, 0.35)' : 'rgba(58, 48, 34, 0.25)';
        ctx.beginPath();
        ctx.ellipse(
          r.x + h01(seed, k) * r.w,
          r.y + h01(seed, k + 9) * r.h,
          8 + h01(seed, k + 3) * 18,
          5 + h01(seed, k + 5) * 10,
          h01(seed, k + 7) * 3,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    } else if (r.floor === 'stone') {
      ctx.fillStyle = isHideout ? 'rgba(52, 52, 48, 0.85)' : '#383834';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = 'rgba(14, 14, 12, 0.55)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      let row = 0;
      for (let y = r.y; y < r.y + r.h; y += 18) {
        ctx.moveTo(r.x, y);
        ctx.lineTo(r.x + r.w, y);
        const off = (row % 2) * 14 + h01(seed, row) * 6;
        for (let x = r.x + off; x < r.x + r.w; x += 28) {
          ctx.moveTo(x, y);
          ctx.lineTo(x + 1.5, Math.min(y + 18, r.y + r.h));
        }
        row++;
      }
      ctx.stroke();
    } else {
      // hay：干草散落
      ctx.fillStyle = '#383021';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = 'rgba(92, 78, 48, 0.32)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < 60; k++) {
        const x = r.x + h01(seed, k) * r.w;
        const y = r.y + h01(seed, k + 100) * r.h;
        const a = h01(seed, k + 200) * Math.PI;
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7);
      }
      ctx.stroke();
    }
    // 墙脚潮湿积垢阴影
    ctx.strokeStyle = 'rgba(6, 5, 4, 0.5)';
    ctx.lineWidth = 9;
    ctx.strokeRect(r.x + 4.5, r.y + 4.5, r.w - 9, r.h - 9);
  }
}

/** 低对比污渍式叙事物件（地面层，压在家具之下） */
function drawGroundProp(ctx: CanvasRenderingContext2D, p: BuildingProp, t: number, wet: number) {
  const k = p.kind;
  const s = p.seed;
  if (k === 'blood_trail') {
    // 拖拽血痕：沿位移向量的断续深红褐污渍
    const n = 7;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const x = p.x + p.w * f + (h01(s, i) - 0.5) * 6;
      const y = p.y + p.h * f + (h01(s, i + 20) - 0.5) * 6;
      ctx.fillStyle = i % 3 === 0 ? 'rgba(48, 16, 13, 0.34)' : 'rgba(36, 14, 11, 0.26)';
      ctx.beginPath();
      ctx.ellipse(x, y, 5 + h01(s, i + 40) * 6, 2.5 + h01(s, i + 60) * 3, Math.atan2(p.h, p.w), 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (k === 'guy_wire' || k === 'clothesline') return; // 线状摆件在陈设层画
  const cx = p.x + p.w * 0.5;
  const cy = p.y + p.h * 0.5;
  ctx.save();
  ctx.translate(cx, cy);
  if (p.rot !== 0) ctx.rotate(p.rot);
  const hw = p.w * 0.5;
  const hh = p.h * 0.5;
  if (k === 'rug') {
    ctx.fillStyle = 'rgba(58, 30, 24, 0.55)';
    ctx.fillRect(-hw, -hh, p.w, p.h);
    ctx.strokeStyle = 'rgba(96, 74, 46, 0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-hw + 5, -hh + 5, p.w - 10, p.h - 10);
    ctx.fillStyle = 'rgba(14, 10, 8, 0.3)';
    ctx.beginPath();
    ctx.ellipse(hw * 0.3, hh * 0.2, hw * 0.4, hh * 0.3, 0.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 'blood') {
    ctx.fillStyle = 'rgba(44, 14, 12, 0.36)';
    ctx.beginPath();
    ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(30, 10, 9, 0.3)';
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc((h01(s, i) - 0.5) * p.w * 1.4, (h01(s, i + 5) - 0.5) * p.h * 1.4, 1.5 + h01(s, i + 9) * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (k === 'scorch' || k === 'ash') {
    ctx.fillStyle = k === 'scorch' ? 'rgba(8, 7, 6, 0.42)' : 'rgba(70, 66, 60, 0.22)';
    ctx.beginPath();
    ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 'oil_stain') {
    ctx.fillStyle = wet > 0.3 ? 'rgba(12, 14, 16, 0.5)' : 'rgba(12, 12, 12, 0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 0, hw, hh, 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 'papers' || k === 'logbook') {
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.translate((h01(s, i) - 0.5) * p.w, (h01(s, i + 3) - 0.5) * p.h);
      ctx.rotate(h01(s, i + 6) * 2.4);
      ctx.fillStyle = 'rgba(150, 140, 116, 0.34)';
      ctx.fillRect(-4.5, -6, 9, 12);
      ctx.fillStyle = 'rgba(30, 26, 20, 0.3)';
      ctx.fillRect(-3, -3, 6, 1);
      ctx.fillRect(-3, 0, 5, 1);
      ctx.restore();
    }
  } else if (k === 'shards') {
    ctx.fillStyle = 'rgba(150, 160, 156, 0.26)';
    for (let i = 0; i < 6; i++) {
      const x = (h01(s, i) - 0.5) * p.w;
      const y = (h01(s, i + 7) - 0.5) * p.h;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 3, y + 1);
      ctx.lineTo(x + 1, y + 3);
      ctx.closePath();
      ctx.fill();
    }
  } else if (k === 'bones' || k === 'fishbones') {
    ctx.strokeStyle = 'rgba(128, 120, 102, 0.3)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.lineTo(hw, 0);
    for (let i = -2; i <= 2; i++) {
      ctx.moveTo(i * hw * 0.35, -hh * 0.8);
      ctx.lineTo(i * hw * 0.35, hh * 0.8);
    }
    ctx.stroke();
  } else if (k === 'water') {
    // 沼泽积水：暗冷水面 + 雨湿时微弱反光
    ctx.fillStyle = 'rgba(14, 18, 18, 0.62)';
    ctx.beginPath();
    ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(70, 82, 80, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, hw * 0.82, hh * 0.78, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (wet > 0.3) {
      ctx.fillStyle = 'rgba(150, 165, 168, 0.05)';
      ctx.beginPath();
      ctx.ellipse(-hw * 0.2, -hh * 0.25, hw * 0.4, hh * 0.18, 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // 芦苇
    ctx.strokeStyle = 'rgba(20, 22, 16, 0.7)';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = h01(s, i) * Math.PI * 2;
      const x = Math.cos(a) * hw * 0.95;
      const y = Math.sin(a) * hh * 0.95;
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.sin(t * 0.8 + i) * 2, y - 9);
    }
    ctx.stroke();
  } else if (k === 'boardwalk') {
    ctx.fillStyle = '#2f251a';
    ctx.fillRect(-hw, -hh, p.w, p.h);
    ctx.strokeStyle = 'rgba(8, 6, 4, 0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let x = -hw + 8; x < hw; x += 9) {
      ctx.moveTo(x, -hh);
      ctx.lineTo(x + (h01(s, x) - 0.5) * 1.5, hh);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(8, 6, 4, 0.8)';
    ctx.fillRect(-hw, -hh - 3, 4, 4);
    ctx.fillRect(hw - 4, hh - 1, 4, 4);
  } else if (k === 'grave') {
    // 坟丘：低对比的隆起土痕
    ctx.fillStyle = 'rgba(34, 28, 20, 0.36)';
    ctx.beginPath();
    ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 12, 9, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (k === 'grave_open') {
    // 被掘开的坟：深色土坑 + 外翻土堆（污渍式，不画硬边）
    ctx.fillStyle = 'rgba(40, 32, 22, 0.34)';
    ctx.beginPath();
    ctx.ellipse(hw * 0.9, 0, hw * 0.7, hh * 0.8, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(6, 5, 4, 0.58)';
    ctx.beginPath();
    ctx.ellipse(0, 0, hw * 0.75, hh * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 'cabbage') {
    for (let x = 6; x < p.w; x += 16) {
      const q = h01(s, x);
      ctx.fillStyle = q < 0.3 ? 'rgba(30, 30, 22, 0.55)' : 'rgba(46, 48, 34, 0.5)';
      ctx.beginPath();
      ctx.arc(x - hw, (q - 0.5) * 4, 4 + q * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (k === 'hatch') {
    // 地窖入口：铁盖板 + 缝隙暗光
    ctx.fillStyle = '#1e1f1c';
    ctx.fillRect(-hw, -hh, p.w, p.h);
    ctx.strokeStyle = '#0a0a09';
    ctx.lineWidth = 2;
    ctx.strokeRect(-hw, -hh, p.w, p.h);
    ctx.strokeStyle = 'rgba(80, 82, 76, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-hw + 4, 0);
    ctx.lineTo(hw - 4, 0);
    ctx.stroke();
    ctx.fillStyle = '#3c3e38';
    ctx.fillRect(hw - 9, -3, 5, 6);
  } else if (k === 'mattress') {
    ctx.fillStyle = 'rgba(78, 70, 56, 0.6)';
    ctx.fillRect(-hw, -hh, p.w, p.h);
    ctx.fillStyle = 'rgba(40, 16, 12, 0.3)';
    ctx.beginPath();
    ctx.ellipse(2, 1, hw * 0.4, hh * 0.35, 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 'wires') {
    ctx.strokeStyle = 'rgba(8, 8, 8, 0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-hw, -hh);
    ctx.bezierCurveTo(-hw * 0.2, -hh * 0.2, hw * 0.1, hh * 0.6, hw, hh);
    ctx.moveTo(-hw, -hh + 6);
    ctx.bezierCurveTo(0, -hh * 0.4, -hw * 0.3, hh * 0.3, hw * 0.4, hh);
    ctx.stroke();
  }
  ctx.restore();
}

const GROUND_KINDS: Record<string, number> = {
  rug: 1,
  blood: 1,
  blood_trail: 1,
  scorch: 1,
  ash: 1,
  oil_stain: 1,
  papers: 1,
  logbook: 1,
  shards: 1,
  bones: 1,
  fishbones: 1,
  water: 1,
  boardwalk: 1,
  grave: 1,
  grave_open: 1,
  cabbage: 1,
  hatch: 1,
  mattress: 1,
  wires: 1,
};

function drawRails(ctx: CanvasRenderingContext2D, rails: Vec2[][]): number {
  let draws = 0;
  for (let r = 0; r < rails.length; r++) {
    const pts = rails[r];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      if (maxX < vL - 40 || minX > vR + 40 || maxY < vT - 40 || minY > vB + 40) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const nx = -uy;
      const ny = ux;
      // 碎石道床
      ctx.strokeStyle = 'rgba(46, 46, 42, 0.55)';
      ctx.lineWidth = 50;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // 朽烂枕木（只画视口内）
      ctx.fillStyle = '#2a2219';
      ctx.beginPath();
      for (let s = 0; s < len; s += 22) {
        const cx = a.x + ux * s;
        const cy = a.y + uy * s;
        if (cx < vL - 30 || cx > vR + 30 || cy < vT - 30 || cy > vB + 30) continue;
        const jit = h01(s, i) * 4 - 2;
        ctx.moveTo(cx + nx * 22 + ux * jit, cy + ny * 22 + uy * jit);
        ctx.lineTo(cx - nx * 22 + ux * jit, cy - ny * 22 + uy * jit);
        ctx.lineTo(cx - nx * 22 + ux * (jit + 7), cy - ny * 22 + uy * (jit + 7));
        ctx.lineTo(cx + nx * 22 + ux * (jit + 7), cy + ny * 22 + uy * (jit + 7));
        ctx.closePath();
      }
      ctx.fill();
      // 两条锈蚀钢轨
      ctx.strokeStyle = '#3e3a34';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(a.x + nx * 12, a.y + ny * 12);
      ctx.lineTo(b.x + nx * 12, b.y + ny * 12);
      ctx.moveTo(a.x - nx * 12, a.y - ny * 12);
      ctx.lineTo(b.x - nx * 12, b.y - ny * 12);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(150, 140, 126, 0.16)';
      ctx.lineWidth = 1;
      ctx.stroke();
      draws += 3;
    }
  }
  return draws;
}

/**
 * 地面层：房间地板、低对比叙事污渍、铁轨、沼泽积水与栈道（在贴花之下、实体之下）
 */
export function drawBuildingGround(
  ctx: CanvasRenderingContext2D,
  engine: GameEngine,
  viewL: number,
  viewT: number,
  viewR: number,
  viewB: number,
  woodPat: CanvasPattern | null
): number {
  vL = viewL;
  vT = viewT;
  vR = viewR;
  vB = viewB;
  const world = engine.world;
  const t = engine.simTime;
  const wet = engine.weather.wetness;
  let draws = drawRails(ctx, world.rails);
  const bl = world.buildings;
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i];
    if (b.id === 'mill' || !buildingVisible(b, 30)) continue;
    drawFloor(ctx, b, woodPat);
    // 按建筑身份分级装饰（富贵人家：暗红金边织花毯与青铜烛台；农家小屋：粗麻草席与腌菜陶坛）
    drawClassDecor(ctx, b);
    for (let k = 0; k < b.props.length; k++) {
      const p = b.props[k];
      if (GROUND_KINDS[p.kind] === undefined) continue;
      if (!rectVisible(p.x, p.y, p.w, p.h, 20)) continue;
      drawGroundProp(ctx, p, t, wet);
    }
    draws += 2;
  }
  let yardN = 0;
  const yp = world.yardProps;
  for (let k = 0; k < yp.length; k++) {
    const p = yp[k];
    if (GROUND_KINDS[p.kind] === undefined) continue;
    if (!rectVisible(p.x, p.y, p.w, p.h, 30)) continue;
    drawGroundProp(ctx, p, t, wet);
    yardN++;
  }
  draws += Math.ceil(yardN / 8);
  return draws;
}

// ---------------------------------------------------------------------------
// 陈设层
// ---------------------------------------------------------------------------

/** 按建筑阶层绘制差异化室内摆件（富贵人家 vs 农家小屋） */
function drawClassDecor(ctx: CanvasRenderingContext2D, b: Building) {
  const isWealthy = b.id === 'doctor' || b.id === 'church' || b.id === 'manor' || b.w * b.h > 42000;
  const cx = b.x + b.w * 0.5;
  const cy = b.y + b.h * 0.5;
  ctx.save();
  if (isWealthy) {
    // 富贵人家：暗红金边波斯长方毯 + 角落青铜高脚烛台
    const rw = Math.min(b.w * 0.42, 92);
    const rh = Math.min(b.h * 0.38, 62);
    ctx.fillStyle = 'rgba(84, 28, 24, 0.52)';
    ctx.fillRect(cx - rw * 0.5, cy - rh * 0.5, rw, rh);
    ctx.strokeStyle = 'rgba(176, 142, 78, 0.45)';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(cx - rw * 0.5 + 3, cy - rh * 0.5 + 3, rw - 6, rh - 6);
    ctx.strokeStyle = 'rgba(196, 166, 98, 0.28)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - rw * 0.3, cy - rh * 0.3, rw * 0.6, rh * 0.6);
    // 角落青铜烛台摆件
    ctx.fillStyle = '#786238';
    ctx.beginPath();
    ctx.arc(b.x + 24, b.y + 24, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d4c8a4';
    ctx.beginPath();
    ctx.arc(b.x + 24, b.y + 24, 1.6, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // 农家小屋：做旧粗麻编织草席 + 墙角腌菜陶坛
    const rw = Math.min(b.w * 0.36, 68);
    const rh = Math.min(b.h * 0.32, 46);
    ctx.fillStyle = 'rgba(98, 86, 60, 0.38)';
    ctx.fillRect(cx - rw * 0.5, cy - rh * 0.5, rw, rh);
    ctx.strokeStyle = 'rgba(54, 46, 32, 0.42)';
    ctx.lineWidth = 1;
    for (let y = cy - rh * 0.45; y < cy + rh * 0.45; y += 6) {
      ctx.beginPath();
      ctx.moveTo(cx - rw * 0.48, y);
      ctx.lineTo(cx + rw * 0.48, y);
      ctx.stroke();
    }
    // 墙角两只陶土腌菜坛
    for (const [ox, oy, rr] of [
      [22, 22, 5.2],
      [33, 25, 4.1],
    ]) {
      ctx.fillStyle = '#4e3929';
      ctx.strokeStyle = '#18120d';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(b.x + ox, b.y + oy, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#231912';
      ctx.beginPath();
      ctx.arc(b.x + ox, b.y + oy, rr * 0.48, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function woodBox(ctx: CanvasRenderingContext2D, hw: number, hh: number, fill: string) {
  ctx.fillStyle = 'rgba(4, 3, 2, 0.45)';
  ctx.fillRect(-hw + 3, -hh + 4, hw * 2, hh * 2);
  ctx.fillStyle = fill;
  ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
  ctx.strokeStyle = '#0b0806';
  ctx.lineWidth = 1.6;
  ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
}

function drawSolidProp(ctx: CanvasRenderingContext2D, p: BuildingProp, t: number) {
  const k = p.kind;
  const s = p.seed;
  if (k === 'guy_wire' || k === 'clothesline') {
    ctx.strokeStyle = k === 'guy_wire' ? 'rgba(20, 20, 20, 0.7)' : 'rgba(54, 50, 44, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + p.w, p.y + (k === 'clothesline' ? p.h : p.h));
    ctx.stroke();
    if (k === 'clothesline') {
      // 晾衣绳：随风轻摆的旧布
      for (let i = 0; i < 4; i++) {
        const f = 0.15 + i * 0.22;
        const x = p.x + p.w * f;
        const y = p.y + p.h * f;
        const sway = Math.sin(t * 1.6 + i * 1.3) * 2.5;
        ctx.fillStyle = i % 2 === 0 ? 'rgba(92, 86, 72, 0.7)' : 'rgba(64, 52, 46, 0.7)';
        ctx.fillRect(x - 6 + sway, y, 12, 14 + h01(s, i) * 6);
      }
    }
    return;
  }
  if (k.charCodeAt(0) === 115 && k.startsWith('sign:')) {
    // 路标：木桩 + 斜钉指示牌 + 褪色字
    ctx.save();
    ctx.translate(p.x + 8, p.y + 8);
    ctx.fillStyle = 'rgba(4, 3, 2, 0.5)';
    ctx.fillRect(2, 2, 5, 5);
    ctx.fillStyle = '#2b2016';
    ctx.fillRect(-2.5, -2.5, 5, 5);
    ctx.rotate(p.rot - 0.08);
    ctx.fillStyle = '#4a3a27';
    ctx.strokeStyle = '#0d0907';
    ctx.lineWidth = 1.2;
    ctx.fillRect(-4, -18, 58, 12);
    ctx.strokeRect(-4, -18, 58, 12);
    ctx.fillStyle = 'rgba(196, 184, 160, 0.62)';
    ctx.font = '8px serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(k.slice(5), -1, -12);
    ctx.restore();
    return;
  }
  const cx = p.x + p.w * 0.5;
  const cy = p.y + p.h * 0.5;
  const hw = p.w * 0.5;
  const hh = p.h * 0.5;
  ctx.save();
  ctx.translate(cx, cy);
  if (p.rot !== 0) ctx.rotate(p.rot);
  if (k === 'bed' || k === 'cot' || k === 'bunk') {
    woodBox(ctx, hw, hh, '#2c2f2b');
    ctx.fillStyle = '#5d5545';
    ctx.fillRect(-hw + 3, -hh + 3, p.w - 6, p.h - 6);
    ctx.fillStyle = '#353b2c';
    if (p.w >= p.h) ctx.fillRect(-hw * 0.2, -hh + 3, hw * 1.2 - 3, p.h - 6);
    else ctx.fillRect(-hw + 3, -hh * 0.2, p.w - 6, hh * 1.2 - 3);
    ctx.fillStyle = '#7c725e';
    if (p.w >= p.h) ctx.fillRect(-hw + 4, -hh + 5, 9, p.h - 10);
    else ctx.fillRect(-hw + 5, -hh + 4, p.w - 10, 9);
    if (k === 'bunk') {
      ctx.strokeStyle = 'rgba(10, 8, 6, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-hw, 0);
      ctx.lineTo(hw, 0);
      ctx.stroke();
    }
  } else if (k === 'table' || k === 'desk' || k === 'workbench' || k === 'counter') {
    woodBox(ctx, hw, hh, k === 'counter' ? '#34281d' : '#3d2e20');
    ctx.strokeStyle = 'rgba(12, 9, 6, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-hw + 2, -hh * 0.3);
    ctx.lineTo(hw - 2, -hh * 0.3);
    ctx.moveTo(-hw + 2, hh * 0.35);
    ctx.lineTo(hw - 2, hh * 0.35);
    ctx.stroke();
    if (k === 'workbench') {
      ctx.fillStyle = '#555a55';
      ctx.fillRect(-hw + 6, -hh + 4, 10, 4);
      ctx.fillRect(hw * 0.2, -2, 12, 3);
    }
  } else if (k === 'wardrobe' || k === 'shelf' || k === 'cabinet_med' || k === 'electric') {
    const fill = k === 'electric' ? '#2c302e' : k === 'cabinet_med' ? '#4a4a42' : '#33261b';
    woodBox(ctx, hw, hh, fill);
    // 顶部厚重近黑截断（高大家具的截断面）
    ctx.strokeStyle = '#070808';
    ctx.lineWidth = 2.6;
    ctx.strokeRect(-hw + 1, -hh + 1, p.w - 2, p.h - 2);
    ctx.fillStyle = 'rgba(160, 150, 130, 0.12)';
    if (p.w >= p.h) ctx.fillRect(-hw + 3, -1, p.w - 6, 2);
    else ctx.fillRect(-1, -hh + 3, 2, p.h - 6);
    if (k === 'electric') {
      ctx.fillStyle = 'rgba(180, 150, 60, 0.4)';
      ctx.fillRect(-3, -hh + 6, 6, 6);
      if (Math.sin(t * 13 + s) > 0.97) {
        ctx.fillStyle = 'rgba(210, 230, 255, 0.7)';
        ctx.fillRect(-1, hh * 0.3, 3, 3);
      }
    } else if (k === 'cabinet_med') {
      ctx.strokeStyle = 'rgba(110, 30, 26, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-3, 0);
      ctx.lineTo(3, 0);
      ctx.moveTo(0, -3);
      ctx.lineTo(0, 3);
      ctx.stroke();
    }
  } else if (k === 'stove') {
    woodBox(ctx, hw, hh, '#222321');
    ctx.fillStyle = '#121211';
    ctx.beginPath();
    ctx.arc(-hw * 0.4, 0, Math.min(hw, hh) * 0.35, 0, Math.PI * 2);
    ctx.arc(hw * 0.4, 0, Math.min(hw, hh) * 0.35, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 'exam_table') {
    woodBox(ctx, hw, hh, '#4c4f4a');
    ctx.fillStyle = '#6a6a5e';
    ctx.fillRect(-hw + 3, -hh + 3, p.w - 6, p.h - 6);
    ctx.strokeStyle = 'rgba(20, 20, 18, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-hw * 0.2, -hh);
    ctx.lineTo(-hw * 0.2, hh);
    ctx.stroke();
  } else if (k === 'pew' || k === 'bench') {
    woodBox(ctx, hw, hh, '#3a2b1e');
    ctx.fillStyle = '#271c13';
    ctx.fillRect(-hw, -hh, p.w, 3);
  } else if (k === 'altar') {
    woodBox(ctx, hw, hh, '#3c3a34');
    ctx.fillStyle = 'rgba(120, 30, 26, 0.45)';
    ctx.fillRect(-hw + 4, -hh + 2, p.w - 8, p.h - 4);
  } else if (k === 'hay') {
    ctx.fillStyle = 'rgba(4, 3, 2, 0.4)';
    ctx.fillRect(-hw + 3, -hh + 4, p.w, p.h);
    ctx.fillStyle = '#5a4b2c';
    ctx.fillRect(-hw, -hh, p.w, p.h);
    ctx.strokeStyle = 'rgba(30, 24, 12, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-hw * 0.3, -hh);
    ctx.lineTo(-hw * 0.3, hh);
    ctx.moveTo(hw * 0.4, -hh);
    ctx.lineTo(hw * 0.4, hh);
    ctx.stroke();
  } else if (k === 'cart' || k === 'handcar' || k === 'rowboat') {
    woodBox(ctx, hw, hh, k === 'handcar' ? '#3a3b38' : '#3b2c1f');
    ctx.fillStyle = '#141210';
    if (k === 'rowboat') {
      ctx.beginPath();
      ctx.ellipse(0, 0, hw * 0.6, hh * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(-hw - 3, -hh + 3, 4, 8);
      ctx.fillRect(hw - 1, -hh + 3, 4, 8);
      ctx.fillRect(-hw - 3, hh - 11, 4, 8);
      ctx.fillRect(hw - 1, hh - 11, 4, 8);
    }
  } else if (k === 'crates' || k === 'transformer' || k === 'sawhorse') {
    woodBox(ctx, hw, hh, k === 'transformer' ? '#2d312e' : '#3e2f1f');
    ctx.strokeStyle = 'rgba(10, 8, 6, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-hw, -hh);
    ctx.lineTo(hw, hh);
    ctx.moveTo(hw, -hh);
    ctx.lineTo(-hw, hh);
    ctx.stroke();
  } else if (k === 'well') {
    ctx.fillStyle = 'rgba(4, 4, 3, 0.5)';
    ctx.beginPath();
    ctx.arc(3, 4, hw + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3d3d38';
    ctx.beginPath();
    ctx.arc(0, 0, hw, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#050606';
    ctx.beginPath();
    ctx.arc(0, 0, hw * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2e2216';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-hw - 2, 0);
    ctx.lineTo(hw + 2, 0);
    ctx.stroke();
  } else if (k === 'tombstone') {
    woodBox(ctx, hw, hh, '#45453f');
    ctx.fillStyle = 'rgba(40, 46, 38, 0.35)';
    ctx.fillRect(-hw, hh - 3, p.w * 0.6, 3);
  } else if (k === 'cross_grave' || k === 'roadside_cross') {
    ctx.fillStyle = 'rgba(4, 3, 2, 0.45)';
    ctx.fillRect(-1, -hh + 3, 4, p.h);
    ctx.fillStyle = '#2e2318';
    ctx.fillRect(-2, -hh, 4, p.h);
    ctx.fillRect(-hw * 0.7, -hh * 0.45, hw * 1.4, 4);
  } else if (k === 'fence' || k === 'fence_fallen') {
    ctx.fillStyle = 'rgba(4, 3, 2, 0.4)';
    ctx.fillRect(-hw + 2, -hh + 3, p.w, p.h);
    ctx.fillStyle = k === 'fence' ? '#3a2c1f' : '#2c2219';
    ctx.fillRect(-hw, -hh, p.w, p.h);
    ctx.fillStyle = '#1a130d';
    if (p.w >= p.h) {
      for (let x = -hw; x < hw; x += 18) ctx.fillRect(x, -hh - 1, 4, p.h + 2);
    } else {
      for (let y = -hh; y < hh; y += 18) ctx.fillRect(-hw - 1, y, p.w + 2, 4);
    }
  } else if (k === 'tower') {
    // 无线电钢架塔：俯视交叉斜撑 + 中心桅杆 + 顶端红色航标灯缓慢明灭
    ctx.strokeStyle = 'rgba(26, 28, 28, 0.9)';
    ctx.lineWidth = 2.2;
    ctx.strokeRect(-hw + 7, -hh + 7, p.w - 14, p.h - 14);
    ctx.beginPath();
    ctx.moveTo(-hw + 7, -hh + 7);
    ctx.lineTo(hw - 7, hh - 7);
    ctx.moveTo(hw - 7, -hh + 7);
    ctx.lineTo(-hw + 7, hh - 7);
    ctx.moveTo(-hw * 0.5, -hh * 0.5);
    ctx.lineTo(hw * 0.5, -hh * 0.5);
    ctx.lineTo(hw * 0.5, hh * 0.5);
    ctx.lineTo(-hw * 0.5, hh * 0.5);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#1b1d1c';
    ctx.fillRect(-5, -5, 10, 10);
    const blink = Math.sin(t * 1.7) > 0.6 ? 1 : 0.25;
    ctx.fillStyle = blink > 0.5 ? 'rgba(220, 60, 42, 0.9)' : 'rgba(90, 30, 24, 0.7)';
    ctx.beginPath();
    ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 'tower_leg') {
    woodBox(ctx, hw, hh, '#3a3c3a');
  } else if (k === 'scarecrow') {
    ctx.strokeStyle = '#2a2016';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-hw, 0);
    ctx.lineTo(hw, 0);
    ctx.moveTo(0, -hh);
    ctx.lineTo(0, hh);
    ctx.stroke();
    ctx.fillStyle = '#4b3f2a';
    ctx.beginPath();
    ctx.arc(0, -2, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#100c08';
    ctx.fillRect(-6, -8, 12, 3);
  } else if (k === 'barrier') {
    ctx.fillStyle = 'rgba(4, 3, 2, 0.4)';
    ctx.fillRect(-hw + 2, -hh + 3, p.w, p.h);
    for (let x = -hw; x < hw; x += 10) {
      ctx.fillStyle = Math.floor((x + hw) / 10) % 2 === 0 ? '#5a2620' : '#6c665a';
      ctx.fillRect(x, -hh, 10, p.h);
    }
  } else if (k === 'stop_sign') {
    ctx.fillStyle = '#4a1e18';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      if (i === 0) ctx.moveTo(Math.cos(a) * hw, Math.sin(a) * hh);
      else ctx.lineTo(Math.cos(a) * hw, Math.sin(a) * hh);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(190, 180, 160, 0.5)';
    ctx.fillRect(-hw * 0.6, -1, hw * 1.2, 2);
  } else if (k === 'milestone') {
    woodBox(ctx, hw, hh, '#4a4a44');
  } else if (k === 'bathtub') {
    woodBox(ctx, hw, hh, '#5a5c56');
    ctx.fillStyle = '#1c1d1b';
    ctx.fillRect(-hw + 3, -hh + 3, p.w - 6, p.h - 6);
  } else if (k === 'chair' || k === 'chair_fallen') {
    // 椅子（翻倒的椅子：侧躺 + 椅背朝外）
    ctx.fillStyle = 'rgba(4, 3, 2, 0.4)';
    ctx.fillRect(-hw + 2, -hh + 3, p.w, p.h);
    ctx.fillStyle = '#3a2b1e';
    ctx.strokeStyle = '#0c0907';
    ctx.lineWidth = 1.2;
    if (k === 'chair') {
      ctx.fillRect(-hw, -hh, p.w, p.h);
      ctx.strokeRect(-hw, -hh, p.w, p.h);
      ctx.fillStyle = '#2a1f15';
      ctx.fillRect(-hw, -hh, p.w, 3);
    } else {
      ctx.fillRect(-hw, -hh * 0.4, p.w, p.h * 0.5);
      ctx.strokeRect(-hw, -hh * 0.4, p.w, p.h * 0.5);
      ctx.fillStyle = '#2a1f15';
      ctx.fillRect(-hw - 3, -hh, 3, p.h);
      ctx.fillRect(hw - 2, hh - 3, 3, 4);
    }
  } else if (k === 'cross_wall' || k === 'crucifix') {
    ctx.fillStyle = k === 'crucifix' ? '#3b2a1c' : '#2c2117';
    ctx.fillRect(-1.5, -hh, 3, p.h);
    ctx.fillRect(-hw * 0.7, -hh * 0.4, hw * 1.4, 3);
  } else if (k === 'photo') {
    // 旧照片：褪色相框里模糊的人影
    ctx.fillStyle = '#2a2017';
    ctx.fillRect(-hw, -hh, p.w, p.h);
    ctx.fillStyle = 'rgba(120, 112, 94, 0.55)';
    ctx.fillRect(-hw + 1.5, -hh + 1.5, p.w - 3, p.h - 3);
    ctx.fillStyle = 'rgba(30, 26, 22, 0.6)';
    ctx.beginPath();
    ctx.arc(-1, -0.5, 1.6, 0, Math.PI * 2);
    ctx.arc(2.5, 0, 1.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (k === 'bottle' || k === 'bottles') {
    const n = k === 'bottles' ? 3 : 1;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = 'rgba(40, 52, 40, 0.75)';
      ctx.fillRect(-hw + i * 5, -hh, 4, p.h);
      ctx.fillStyle = 'rgba(140, 160, 140, 0.25)';
      ctx.fillRect(-hw + i * 5 + 1, -hh + 1, 1, p.h * 0.6);
    }
  } else if (k === 'candles') {
    ctx.fillStyle = '#8a826c';
    ctx.fillRect(-hw, -hh * 0.4, 2.5, hh * 1.2);
    ctx.fillRect(hw - 3, -hh * 0.6, 2.5, hh * 1.4);
  } else if (k === 'plates' || k === 'tray' || k === 'pills' || k === 'syringe' || k === 'bandage') {
    if (k === 'plates') {
      ctx.fillStyle = 'rgba(120, 118, 106, 0.5)';
      ctx.beginPath();
      ctx.arc(-hw * 0.4, 0, hh * 0.8, 0, Math.PI * 2);
      ctx.arc(hw * 0.45, 1, hh * 0.7, 0, Math.PI * 2);
      ctx.fill();
    } else if (k === 'tray') {
      ctx.fillStyle = 'rgba(96, 100, 96, 0.55)';
      ctx.fillRect(-hw, -hh, p.w, p.h);
    } else if (k === 'pills') {
      ctx.fillStyle = 'rgba(150, 146, 130, 0.38)';
      for (let i = 0; i < 6; i++) ctx.fillRect((h01(s, i) - 0.5) * p.w, (h01(s, i + 4) - 0.5) * p.h, 2, 2);
    } else if (k === 'syringe') {
      ctx.fillStyle = 'rgba(150, 160, 158, 0.5)';
      ctx.fillRect(-hw, -1, p.w, 2);
    } else {
      ctx.fillStyle = 'rgba(120, 104, 90, 0.4)';
      ctx.fillRect(-hw, -hh, p.w, p.h);
      ctx.fillStyle = 'rgba(52, 16, 12, 0.35)';
      ctx.fillRect(-hw * 0.3, -hh * 0.4, hw * 0.8, hh * 0.8);
    }
  } else if (k === 'sack' || k === 'jars' || k === 'books' || k === 'radio' || k === 'ashtray' || k === 'toy') {
    const fill =
      k === 'sack'
        ? '#4a4030'
        : k === 'jars'
        ? 'rgba(96, 108, 96, 0.55)'
        : k === 'books'
        ? '#3a2420'
        : k === 'radio'
        ? '#2e2c26'
        : k === 'ashtray'
        ? '#3a3a36'
        : '#4c3a30';
    ctx.fillStyle = fill;
    if (k === 'sack' || k === 'ashtray') {
      ctx.beginPath();
      ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (k === 'jars') {
      const along = p.w >= p.h;
      const n = Math.floor((along ? p.w : p.h) / 8);
      for (let i = 0; i < n; i++) {
        if (along) ctx.fillRect(-hw + i * 8 + 1, -hh + 1, 5, p.h - 2);
        else ctx.fillRect(-hw + 1, -hh + i * 8 + 1, p.w - 2, 5);
      }
    } else {
      ctx.fillRect(-hw, -hh, p.w, p.h);
      if (k === 'radio') {
        ctx.fillStyle = 'rgba(170, 140, 70, 0.4)';
        ctx.fillRect(hw - 6, -hh + 3, 3, 3);
      }
    }
  } else if (k === 'coat_rack' || k === 'boots' || k === 'bucket' || k === 'nets' || k === 'chains' || k === 'pitchfork' || k === 'ladder' || k === 'tools_rack' || k === 'bell_rope' || k === 'beam_charred') {
    if (k === 'ladder') {
      ctx.strokeStyle = '#3a2a1c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-hw + 3, -hh);
      ctx.lineTo(-hw + 3, hh);
      ctx.moveTo(hw - 3, -hh);
      ctx.lineTo(hw - 3, hh);
      for (let y = -hh + 5; y < hh; y += 8) {
        ctx.moveTo(-hw + 3, y);
        ctx.lineTo(hw - 3, y);
      }
      ctx.stroke();
    } else if (k === 'tools_rack') {
      ctx.fillStyle = '#2e2216';
      ctx.fillRect(-hw, -hh, p.w, p.h);
      ctx.fillStyle = '#4c504c';
      for (let x = -hw + 6; x < hw - 4; x += 12) ctx.fillRect(x, -hh + 1, 3, p.h + 8);
    } else if (k === 'nets') {
      ctx.strokeStyle = 'rgba(70, 66, 54, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = -hw; x <= hw; x += 5) {
        ctx.moveTo(x, -hh);
        ctx.lineTo(x + 4, hh);
      }
      for (let y = -hh; y <= hh; y += 5) {
        ctx.moveTo(-hw, y);
        ctx.lineTo(hw, y + 3);
      }
      ctx.stroke();
    } else if (k === 'chains' || k === 'bell_rope') {
      ctx.strokeStyle = k === 'chains' ? '#4a4c48' : '#5a4c34';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const sway = Math.sin(t * 1.3 + s) * 2;
      ctx.moveTo(0, -hh);
      ctx.quadraticCurveTo(sway, 0, sway * 1.5, hh);
      ctx.stroke();
    } else if (k === 'pitchfork') {
      ctx.strokeStyle = '#3a2a1c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-hw, 0);
      ctx.lineTo(hw * 0.5, 0);
      ctx.stroke();
      ctx.strokeStyle = '#4c4e4a';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(hw * 0.5, -3);
      ctx.lineTo(hw, -3);
      ctx.moveTo(hw * 0.5, 0);
      ctx.lineTo(hw, 0);
      ctx.moveTo(hw * 0.5, 3);
      ctx.lineTo(hw, 3);
      ctx.stroke();
    } else if (k === 'beam_charred') {
      ctx.fillStyle = '#0e0c0a';
      ctx.fillRect(-hw, -hh, p.w, p.h);
      ctx.fillStyle = 'rgba(90, 40, 20, 0.25)';
      ctx.fillRect(-hw * 0.4, -hh, hw * 0.3, p.h);
    } else {
      ctx.fillStyle = k === 'bucket' ? '#3e403c' : '#2a2018';
      ctx.beginPath();
      ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * 建筑窗户绘制：严格对标《Darkwood》原版高精双轨金属/木窗框（浅灰双轨槽 + 突出窗台 + 冷灰碎玻璃 + 可选斜钉封板）
 * 与可进入大门形成鲜明材质与几何区分：窗户偏冷银灰双轨且略高出地面，门为暖褐厚木门廊与宽门槛
 */
function drawWindow(ctx: CanvasRenderingContext2D, w: { x: number; y: number; w: number; h: number; orientation: string; boarded: number; seed: number }) {
  const horiz = w.orientation === 'h';
  // 外扩旧灰水泥/木质窗台底座（让窗框从纯黑墙面中清晰浮出）
  ctx.fillStyle = '#5a5e5a';
  if (horiz) {
    ctx.fillRect(w.x - 1, w.y - 2.5, w.w + 2, w.h + 5);
    // 窗台顶部受光微高光与深黑槽腔
    ctx.fillStyle = '#787d78';
    ctx.fillRect(w.x, w.y - 2, w.w, 2.2);
    ctx.fillRect(w.x, w.y + w.h - 0.2, w.w, 2.2);
    ctx.fillStyle = '#101313';
    ctx.fillRect(w.x + 2, w.y + 1.5, w.w - 4, w.h - 3);
    // Darkwood 标志性清晰双轨推拉窗槽线（对标原版特写图）
    ctx.fillStyle = '#9aa09b';
    ctx.fillRect(w.x + 2, w.y + w.h * 0.28, w.w - 4, 1.8);
    ctx.fillRect(w.x + 2, w.y + w.h * 0.62, w.w - 4, 1.8);
    // 中央窗棂竖挺
    ctx.fillStyle = '#3c403e';
    ctx.fillRect(w.x + w.w * 0.5 - 1.5, w.y + 1, 3, w.h - 2);
    ctx.strokeStyle = '#070808';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(w.x - 1, w.y - 2.5, w.w + 2, w.h + 5);
  } else {
    ctx.fillRect(w.x - 2.5, w.y - 1, w.w + 5, w.h + 2);
    ctx.fillStyle = '#787d78';
    ctx.fillRect(w.x - 2, w.y, 2.2, w.h);
    ctx.fillRect(w.x + w.w - 0.2, w.y, 2.2, w.h);
    ctx.fillStyle = '#101313';
    ctx.fillRect(w.x + 1.5, w.y + 2, w.w - 3, w.h - 4);
    // 双轨窗槽线
    ctx.fillStyle = '#9aa09b';
    ctx.fillRect(w.x + w.w * 0.28, w.y + 2, 1.8, w.h - 4);
    ctx.fillRect(w.x + w.w * 0.62, w.y + 2, 1.8, w.h - 4);
    // 中央窗棂横挺
    ctx.fillStyle = '#3c403e';
    ctx.fillRect(w.x + 1, w.y + w.h * 0.5 - 1.5, w.w - 2, 3);
    ctx.strokeStyle = '#070808';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(w.x - 2.5, w.y - 1, w.w + 5, w.h + 2);
  }

  // 残留冷青灰碎玻璃锯齿
  ctx.fillStyle = 'rgba(168, 188, 190, 0.42)';
  for (let i = 0; i < 3; i++) {
    const f = h01(w.seed, i);
    if (horiz) {
      const x = w.x + 4 + f * (w.w - 8);
      ctx.beginPath();
      ctx.moveTo(x, w.y + w.h * 0.48);
      ctx.lineTo(x + 4, w.y + w.h * 0.48 - 2);
      ctx.lineTo(x + 1.5, w.y + w.h * 0.48 + 3);
      ctx.fill();
    } else {
      const y = w.y + 4 + f * (w.h - 8);
      ctx.beginPath();
      ctx.moveTo(w.x + w.w * 0.48, y);
      ctx.lineTo(w.x + w.w * 0.48 - 2, y + 4);
      ctx.lineTo(w.x + w.w * 0.48 + 3, y + 1.5);
      ctx.fill();
    }
  }

  // 钉死的木板（斜钉、粗厚旧木板 + 锈铁钉头）
  for (let i = 0; i < w.boarded; i++) {
    const f = (i + 0.5) / Math.max(1, w.boarded);
    const tilt = (h01(w.seed, i + 10) - 0.5) * 0.36;
    ctx.save();
    if (horiz) {
      ctx.translate(w.x + w.w * f, w.y + w.h * 0.5);
      ctx.rotate(Math.PI * 0.5 + tilt);
    } else {
      ctx.translate(w.x + w.w * 0.5, w.y + w.h * f);
      ctx.rotate(tilt);
    }
    ctx.fillStyle = '#533d28';
    ctx.strokeStyle = '#0d0907';
    ctx.lineWidth = 1.2;
    const len = (horiz ? w.h : w.w) + 12;
    ctx.fillRect(-len * 0.5, -3.4, len, 6.8);
    ctx.strokeRect(-len * 0.5, -3.4, len, 6.8);
    ctx.fillStyle = '#8b8f8a';
    ctx.fillRect(-len * 0.5 + 2.5, -1, 1.8, 1.8);
    ctx.fillRect(len * 0.5 - 4.3, -1, 1.8, 1.8);
    ctx.restore();
  }
}

/**
 * 建筑门扇绘制：外门配宽厚磨损木门槛 + 醒目重木门扇 + 金属合页/拉手，与冷灰双轨窗框截然不同
 */
function drawDoor(ctx: CanvasRenderingContext2D, d: InteriorDoor, t: number) {
  const horiz = d.orientation === 'h';
  // 宽厚磨损木门槛（横贯门洞，外门更宽更亮以便玩家一眼锁定可进入的入口）
  ctx.fillStyle = d.exterior ? '#594530' : '#3b2e21';
  if (horiz) {
    ctx.fillRect(d.x - 1, d.y - (d.exterior ? 2 : 0), d.w + 2, d.h + (d.exterior ? 4 : 0));
    // 门槛木板接缝与踩踏磨损高光
    ctx.fillStyle = d.exterior ? 'rgba(138, 114, 84, 0.45)' : 'rgba(98, 82, 62, 0.30)';
    ctx.fillRect(d.x + 2, d.y + d.h * 0.28, d.w - 4, d.h * 0.44);
    ctx.strokeStyle = '#120d09';
    ctx.lineWidth = 1.1;
    ctx.strokeRect(d.x - 1, d.y - (d.exterior ? 2 : 0), d.w + 2, d.h + (d.exterior ? 4 : 0));
  } else {
    ctx.fillRect(d.x - (d.exterior ? 2 : 0), d.y - 1, d.w + (d.exterior ? 4 : 0), d.h + 2);
    ctx.fillStyle = d.exterior ? 'rgba(138, 114, 84, 0.45)' : 'rgba(98, 82, 62, 0.30)';
    ctx.fillRect(d.x + d.w * 0.28, d.y + 2, d.w * 0.44, d.h - 4);
    ctx.strokeStyle = '#120d09';
    ctx.lineWidth = 1.1;
    ctx.strokeRect(d.x - (d.exterior ? 2 : 0), d.y - 1, d.w + (d.exterior ? 4 : 0), d.h + 2);
  }

  // 门扇绕合页旋转：开合动画 openT 0..1，撞门时抖动
  let hx = 0;
  let hy = 0;
  let base = 0;
  let sign = 1;
  const len = horiz ? d.w : d.h;
  if (horiz) {
    hx = d.hinge === 1 ? d.x : d.x + d.w;
    hy = d.y + d.h * 0.5;
    base = d.hinge === 1 ? 0 : Math.PI;
    sign = d.hinge === 1 ? 1 : -1;
  } else {
    hx = d.x + d.w * 0.5;
    hy = d.hinge === 1 ? d.y : d.y + d.h;
    base = d.hinge === 1 ? Math.PI * 0.5 : -Math.PI * 0.5;
    sign = d.hinge === 1 ? -1 : 1;
  }
  const shake = d.bash > 0 ? Math.sin(t * 46) * 0.06 * Math.min(1, d.bash) : 0;
  const ang = base + sign * d.swing * d.openT * Math.PI * 0.5 + shake;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(ang);
  // 门扇投影
  ctx.fillStyle = 'rgba(4, 3, 2, 0.52)';
  ctx.fillRect(2, -1, len - 2, 7.5);
  // 厚实做旧橡木门扇（外门略厚且带木筋高光，远距离清晰可辨）
  const leafThick = d.exterior ? 6.4 : 5.0;
  ctx.fillStyle = d.exterior ? '#6b4d32' : '#4f3a26';
  ctx.strokeStyle = '#0b0806';
  ctx.lineWidth = 1.5;
  ctx.fillRect(1, -leafThick * 0.5, len - 2, leafThick);
  ctx.strokeRect(1, -leafThick * 0.5, len - 2, leafThick);
  // 门扇顶面木纹高光条
  ctx.fillStyle = d.exterior ? 'rgba(176, 142, 98, 0.42)' : 'rgba(140, 112, 78, 0.28)';
  ctx.fillRect(3, -leafThick * 0.5 + 1.1, len - 6, 1.5);
  // 金属合页与醒目黄铜/旧铁门把手（双侧凸出，俯视可一眼认出是门）
  ctx.fillStyle = '#434642';
  ctx.fillRect(2, -leafThick * 0.5 - 1, 4, leafThick + 2);
  ctx.fillStyle = d.exterior ? '#c4a86e' : '#8b8572';
  ctx.fillRect(len - 10, -leafThick * 0.5 - 2.2, 4.5, leafThick + 4.4);
  ctx.strokeStyle = '#120f0b';
  ctx.lineWidth = 0.9;
  ctx.strokeRect(len - 10, -leafThick * 0.5 - 2.2, 4.5, leafThick + 4.4);
  ctx.restore();

  // 厚重门框木立柱（略亮于纯黑墙体，形成清晰门套轮廓）
  ctx.fillStyle = d.exterior ? '#3b2b1d' : '#1b1510';
  ctx.strokeStyle = '#070808';
  ctx.lineWidth = 1.2;
  if (horiz) {
    ctx.fillRect(d.x - 4, d.y - 2, 5, d.h + 4);
    ctx.strokeRect(d.x - 4, d.y - 2, 5, d.h + 4);
    ctx.fillRect(d.x + d.w - 1, d.y - 2, 5, d.h + 4);
    ctx.strokeRect(d.x + d.w - 1, d.y - 2, 5, d.h + 4);
  } else {
    ctx.fillRect(d.x - 2, d.y - 4, d.w + 4, 5);
    ctx.strokeRect(d.x - 2, d.y - 4, d.w + 4, 5);
    ctx.fillRect(d.x - 2, d.y + d.h - 1, d.w + 4, 5);
    ctx.strokeRect(d.x - 2, d.y + d.h - 1, d.w + 4, 5);
  }
}

function drawLampBase(ctx: CanvasRenderingContext2D, l: BuildingLight, lit: boolean, f: number) {
  // 墙上拉线开关（吊灯）
  if (l.kind === 'pendant') {
    ctx.fillStyle = '#1c1a17';
    ctx.fillRect(l.switchX - 3, l.switchY - 4, 6, 8);
    ctx.fillStyle = l.on ? '#8a8270' : '#4a463e';
    ctx.fillRect(l.switchX - 1, l.on ? l.switchY - 3 : l.switchY, 2, 3);
    return;
  }
  ctx.save();
  ctx.translate(l.x, l.y);
  const glowA = lit ? 0.55 * f : 0;
  if (l.kind === 'oil') {
    ctx.fillStyle = '#3d3424';
    ctx.beginPath();
    ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(160, 170, 160, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.stroke();
  } else if (l.kind === 'desk') {
    ctx.fillStyle = '#2a2c28';
    ctx.fillRect(-2, -2, 4, 4);
    ctx.fillStyle = '#3a3c36';
    ctx.beginPath();
    ctx.ellipse(-3, -1, 5.5, 3.5, -0.5, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = '#8a826c';
    ctx.fillRect(-1.2, -1.2, 2.4, 2.4);
    ctx.fillRect(3, 1, 2, 2);
  }
  if (glowA > 0.01) {
    const isRed = l.g < 0.4;
    ctx.globalAlpha = Math.min(1, glowA + 0.25);
    ctx.fillStyle = isRed ? '#ff7a5a' : '#ffe2a0';
    ctx.beginPath();
    ctx.arc(0, -0.5, l.kind === 'candle' ? 1.4 : 1.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/**
 * 陈设层：家具、窗、门扇、灯座/开关、院落实体（篱笆、井、墓碑、信号塔、路标……）
 * 在墙体与门窗木板之后、玩家与怪物之前绘制
 */
export function drawBuildingFixtures(
  ctx: CanvasRenderingContext2D,
  engine: GameEngine,
  viewL: number,
  viewT: number,
  viewR: number,
  viewB: number
): number {
  vL = viewL;
  vT = viewT;
  vR = viewR;
  vB = viewB;
  const world = engine.world;
  const t = engine.simTime;
  const gen = genPowered(engine);
  let draws = 0;
  const bl = world.buildings;
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i];
    if (b.id === 'mill' || !buildingVisible(b, 40)) continue;
    if (b.hasEntry) {
      // 写实建筑门廊台阶 + 踩踏泥路引导（向外清晰伸出屋檐之外，确保室外一眼辨识可进入的建筑大门）
      const dx = b.entryIn.x - b.entryOut.x;
      const dy = b.entryIn.y - b.entryOut.y;
      const midX = (b.entryIn.x + b.entryOut.x) * 0.5;
      const midY = (b.entryIn.y + b.entryOut.y) * 0.5;
      ctx.save();
      ctx.translate(midX, midY);
      ctx.rotate(Math.atan2(dy, dx));
      // 门外踩踏磨损浅土引道（-x 为门外方向，+x 为门内方向）
      ctx.fillStyle = 'rgba(92, 82, 66, 0.24)';
      ctx.beginPath();
      ctx.ellipse(-34, 0, 26, 26, 0, 0, Math.PI * 2);
      ctx.fill();
      // 4 块向外突出的破旧做旧木门廊台阶板（完整露出屋檐，极强建筑入口辨识度）
      ctx.fillStyle = 'rgba(4, 3, 2, 0.58)';
      ctx.fillRect(-38, -26, 30, 56);
      for (let p = 0; p < 4; p++) {
        const px = -38 + p * 7.4;
        ctx.fillStyle = p % 2 === 1 ? '#6e583f' : '#5e4a35';
        ctx.fillRect(px, -26, 6.5, 52);
        ctx.strokeStyle = '#120d09';
        ctx.lineWidth = 1.1;
        ctx.strokeRect(px, -26, 6.5, 52);
        // 磨损高亮木纹（让大门台阶在阴郁环境里自然醒目）
        ctx.fillStyle = 'rgba(176, 152, 118, 0.32)';
        ctx.fillRect(px + 1, -16, 4.0, 32);
      }
      // 门槛处的破旧麻布迎门踏垫
      ctx.fillStyle = '#534535';
      ctx.strokeStyle = '#18130e';
      ctx.lineWidth = 1.2;
      ctx.fillRect(-11, -17, 13, 34);
      ctx.strokeRect(-11, -17, 13, 34);
      ctx.restore();
    }
    for (let k = 0; k < b.props.length; k++) {
      const p = b.props[k];
      if (GROUND_KINDS[p.kind] !== undefined) continue;
      if (!rectVisible(p.x, p.y, p.w, p.h, 20)) continue;
      drawSolidProp(ctx, p, t);
    }
    for (let k = 0; k < b.windows.length; k++) {
      const w = b.windows[k];
      if (!rectVisible(w.x, w.y, w.w, w.h, 20)) continue;
      drawWindow(ctx, w);
    }
    for (let k = b.doorStart; k < b.doorStart + b.doorCount; k++) {
      const d = world.interiorDoors[k];
      if (!d || !rectVisible(d.x - 50, d.y - 50, d.w + 100, d.h + 100, 0)) continue;
      drawDoor(ctx, d, t);
    }
    for (let k = b.lightStart; k < b.lightStart + b.lightCount; k++) {
      const l = world.lights[k];
      if (!l || !rectVisible(l.x - 20, l.y - 20, 40, 40, 0)) continue;
      const lit = isLightLit(l, gen);
      drawLampBase(ctx, l, lit, lit ? lightFlicker(l, t) : 0);
    }
    draws += 2;
  }
  let yardN = 0;
  const yp = world.yardProps;
  for (let k = 0; k < yp.length; k++) {
    const p = yp[k];
    if (GROUND_KINDS[p.kind] !== undefined) continue;
    if (!rectVisible(p.x, p.y, p.w, p.h, 60)) continue;
    drawSolidProp(ctx, p, t);
    yardN++;
  }
  draws += Math.ceil(yardN / 8);
  return draws;
}

/**
 * 顶灯层：吊灯灯罩与灯泡（玩家所在建筑屋顶渐隐时才可见），在玩家之后、屋顶之前绘制
 */
export function drawBuildingOverhead(
  ctx: CanvasRenderingContext2D,
  engine: GameEngine,
  viewL: number,
  viewT: number,
  viewR: number,
  viewB: number
): number {
  vL = viewL;
  vT = viewT;
  vR = viewR;
  vB = viewB;
  const world = engine.world;
  const t = engine.simTime;
  const gen = genPowered(engine);
  const alphas = engine.buildingRoofAlpha;
  let draws = 0;
  const bl = world.buildings;
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i];
    const ra = b.id === 'h_in' ? engine.hideoutRoofAlpha : alphas[i] === undefined ? 1 : alphas[i];
    if (ra >= 0.85 || !buildingVisible(b, 20)) continue;
    let any = false;
    for (let k = b.lightStart; k < b.lightStart + b.lightCount; k++) {
      const l = world.lights[k];
      if (!l || l.kind !== 'pendant') continue;
      const lit = isLightLit(l, gen);
      const f = lit ? lightFlicker(l, t) : 0;
      const sway = Math.sin(t * 0.9 + l.seed) * 1.2;
      ctx.save();
      ctx.translate(l.x + sway, l.y);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
      ctx.beginPath();
      ctx.arc(2, 3, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = l.broken ? '#23211e' : '#252925';
      ctx.strokeStyle = '#0e100e';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = lit && f > 0.3 ? '#ffe6a8' : lit ? '#8a7a58' : '#3d3c36';
      ctx.beginPath();
      ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
      ctx.fill();
      if (l.broken) {
        // 碎灯泡：残缺的灯丝
        ctx.strokeStyle = 'rgba(150, 150, 140, 0.4)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(-2, -1);
        ctx.lineTo(1, 1.5);
        ctx.stroke();
      }
      ctx.restore();
      any = true;
    }
    if (any) draws++;
  }
  return draws;
}

// ---------------------------------------------------------------------------
// GPU 灯光（对象池复用：每帧零分配）
// ---------------------------------------------------------------------------

const gpuPool: GpuLight[] = [];

function poolLight(i: number): GpuLight {
  let g = gpuPool[i];
  if (!g) {
    g = { x: 0, y: 0, radius: 0, intensity: 0, r: 1, g: 1, b: 1, dirX: 0, dirY: 0, coneCos: -2.0, shadowChannel: 1 };
    gpuPool[i] = g;
  }
  return g;
}

/**
 * 把视口内亮着的建筑灯推入 GPU 灯光列表（距离裁剪、遵守 maxLights；阴影走灯光遮罩通道 G）
 * fill 为 renderer 的阴影遮罩多边形填充函数（同一份可见多边形单源）
 */
export function pushBuildingLights(
  engine: GameEngine,
  out: GpuLight[],
  maxLights: number,
  viewL: number,
  viewT: number,
  W: number,
  H: number,
  polyScratch: Vec2[],
  fill: (poly: Vec2[], color: string) => void
): void {
  const lights = engine.world.lights;
  const gen = genPowered(engine);
  const t = engine.simTime;
  const cx = viewL + W * 0.5;
  const cy = viewT + H * 0.5;
  let used = 0;
  for (let i = 0; i < lights.length; i++) {
    if (out.length >= maxLights) break;
    const l = lights[i];
    if (!isLightLit(l, gen)) continue;
    if (Math.abs(l.x - cx) > W * 0.5 + l.radius || Math.abs(l.y - cy) > H * 0.5 + l.radius) continue;
    const f = lightFlicker(l, t);
    if (f < 0.03) continue;
    computeVisibilityPolygon(engine.world, l.x, l.y, l.radius, polyScratch);
    fill(polyScratch, '#00ff00');
    const g = poolLight(used++);
    g.x = l.x - viewL;
    g.y = l.y - viewT;
    g.radius = l.radius;
    g.intensity = l.intensity * f;
    g.r = l.r;
    g.g = l.g;
    g.b = l.b;
    g.dirX = 0;
    g.dirY = 0;
    g.coneCos = -2.0;
    g.shadowChannel = 1;
    out.push(g);
  }
}

/** 怪物是否被建筑灯照亮（视野规则 ③ 的扩展：灯光范围内且有视线才显形） */
export function isEnemyLitByBuildingLights(engine: GameEngine, e: Enemy): boolean {
  const lights = engine.world.lights;
  const gen = genPowered(engine);
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    if (!isLightLit(l, gen)) continue;
    const dx = e.x - l.x;
    const dy = e.y - l.y;
    const r = l.radius * 0.85;
    if (dx * dx + dy * dy > r * r) continue;
    if (lightFlicker(l, engine.simTime) < 0.3) continue;
    if (hasLineOfSight(engine.world, l.x, l.y, e.x, e.y)) return true;
  }
  return false;
}
