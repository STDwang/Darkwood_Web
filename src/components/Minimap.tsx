// 实时小地图（第二轮 HUD）：被墨与污渍侵蚀的旧羊皮纸圆盘 + 铁环 + 北向标记
// - Darkwood 式探索迷雾：UI 层自维护 65×65 低分辨率探索网格（存于父组件传入的 ref，跨挂载保留，
//   检测到 engine.world 对象更换 = 新开局/重开/回标题后重置）；只绘制玩家走过的区域
// - 只读 runtimeRef.current.engine 的 world / player / mode / phase / dayTime / discoveredZones，
//   绝不写入 engine，绝不读取或绘制怪物（engine.enemies 完全不触碰）
// - rAF 节流约 12Hz；处理 devicePixelRatio；底纸、噪声、铁环与世界墨图均用离屏 canvas 只烘焙一次
// - canvas 为纯装饰：pointer-events:none + aria-hidden，且不含任何 DOM 文字，不参与布局审计的按钮/文字检查

import React, { useEffect, useRef } from 'react';
import { I18n } from '../game/i18n';
import { GameRuntime } from '../game/runtime';
import { HIDEOUT_RECT, WORLD_SIZE, WorldData } from '../game/world';

/** 探索网格单元边长（世界单位）：2600 / 40 ≈ 65 × 65 格 */
const CELL = 40;
const GRID = Math.ceil(WORLD_SIZE / CELL);
const HALF = WORLD_SIZE / 2;
/** 小地图圆盘半径对应的世界距离（以玩家为中心） */
const VIEW_HALF = 560;
/** 世界墨图烘焙精度：每像素 4 世界单位（650×650 离屏画布） */
const BAKE_SCALE = 4;
/** 约 9Hz 节流重绘（静止或弹窗态自动跳过，兼顾流畅度与手机省电） */
const DRAW_INTERVAL_MS = 110;
/** 昼夜分段（仅用于夜色压暗的装饰插值，与 engine.ts 90s 昼 / 25s 黄昏 / 75s 夜 对齐） */
const DAY_END = 90 / 190;
const DUSK_END = 115 / 190;

/** 地标符号与缩写（中文缩写 → 英文由 i18n 字典给出） */
const POI_GLYPH: Record<string, { kind: 'truck' | 'mill' | 'camp' | 'shrine'; short: string }> = {
  坠毁货车: { kind: 'truck', short: '货车' },
  废弃锯木厂: { kind: 'mill', short: '锯木厂' },
  猎人营地: { kind: 'camp', short: '营地' },
  枯林祭坛: { kind: 'shrine', short: '祭坛' },
};

export interface MinimapExploreState {
  /** 当前网格所属的世界对象（engine.reset 会重建 world，借此识别新开局） */
  world: WorldData | null;
  /** 0..255 探索强度，行优先 GRID × GRID */
  grid: Uint8Array;
  /** 网格自上次同步到迷雾纹理后是否有变化 */
  dirty: boolean;
}

export function createExploreState(): MinimapExploreState {
  return { world: null, grid: new Uint8Array(GRID * GRID), dirty: true };
}

interface MinimapProps {
  runtimeRef: { current: GameRuntime | null };
  exploreRef: { current: MinimapExploreState | null };
  className?: string;
}

/** 确定性伪随机（mulberry32），保证同一世界每次烘焙出相同的墨点 */
function makeRng(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** 按玩家位置点亮探索网格（软边：外缘 40% 渐隐） */
function revealAt(st: MinimapExploreState, x: number, y: number, r: number) {
  const g = st.grid;
  const gx0 = Math.max(0, Math.floor((x - r + HALF) / CELL));
  const gx1 = Math.min(GRID - 1, Math.floor((x + r + HALF) / CELL));
  const gy0 = Math.max(0, Math.floor((y - r + HALF) / CELL));
  const gy1 = Math.min(GRID - 1, Math.floor((y + r + HALF) / CELL));
  const soft = r * 0.4;
  for (let gy = gy0; gy <= gy1; gy++) {
    const cy = (gy + 0.5) * CELL - HALF;
    for (let gx = gx0; gx <= gx1; gx++) {
      const cx = (gx + 0.5) * CELL - HALF;
      const d = Math.hypot(cx - x, cy - y);
      if (d > r) continue;
      const v = Math.min(255, Math.round(((r - d) / soft) * 255));
      const i = gy * GRID + gx;
      if (v > g[i]) {
        g[i] = v;
        st.dirty = true;
      }
    }
  }
}

function exploredAt(st: MinimapExploreState, x: number, y: number): number {
  const gx = Math.floor((x + HALF) / CELL);
  const gy = Math.floor((y + HALF) / CELL);
  if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) return 0;
  return st.grid[gy * GRID + gx];
}

/** drawImage 源矩形越界时手动裁剪，并等比修正目标矩形（避免各浏览器对越界源矩形处理不一） */
function drawClipped(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const kx = dw / sw;
  const ky = dh / sh;
  const x0 = Math.max(0, sx);
  const y0 = Math.max(0, sy);
  const x1 = Math.min(img.width, sx + sw);
  const y1 = Math.min(img.height, sy + sh);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.drawImage(
    img,
    x0,
    y0,
    x1 - x0,
    y1 - y0,
    dx + (x0 - sx) * kx,
    dy + (y0 - sy) * ky,
    (x1 - x0) * kx,
    (y1 - y0) * ky
  );
}

const worldInkCache = new WeakMap<WorldData, HTMLCanvasElement>();

/** 烘焙世界墨图（按 WorldData 弱引用缓存，右上角小地图与全屏探索大地图零开销共享同一张墨图） */
function bakeWorldInk(world: WorldData): HTMLCanvasElement {
  const cached = worldInkCache.get(world);
  if (cached) return cached;
  const n = WORLD_SIZE / BAKE_SCALE;
  const c = makeCanvas(n, n);
  worldInkCache.set(world, c);
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const rnd = makeRng((world.seed || 19847) * 7 + 3);
  const toB = (v: number) => (v + HALF) / BAKE_SCALE;

  // 1. 道路：宽而淡的褐色洇痕 + 中央细墨线
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const paths = world.paths ?? [];
  for (let pass = 0; pass < 2; pass++) {
    for (const path of paths) {
      const pts = path.points;
      if (!pts || pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(toB(pts[0].x), toB(pts[0].y));
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) * 0.5;
        const my = (pts[i].y + pts[i + 1].y) * 0.5;
        ctx.quadraticCurveTo(toB(pts[i].x), toB(pts[i].y), toB(mx), toB(my));
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(toB(last.x), toB(last.y));
      if (pass === 0) {
        ctx.strokeStyle = 'rgba(122, 86, 48, 0.42)';
        ctx.lineWidth = (path.width / BAKE_SCALE) * 0.62;
      } else {
        ctx.strokeStyle = 'rgba(80, 52, 28, 0.62)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3.2, 2.4]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 2. 巨石：灰褐小椭圆
  for (const rock of world.rocks ?? []) {
    const rr = Math.max(1.2, (rock.r / BAKE_SCALE) * 0.75);
    ctx.fillStyle = 'rgba(58, 52, 44, 0.45)';
    ctx.beginPath();
    ctx.ellipse(toB(rock.x), toB(rock.y), rr * 1.15, rr * 0.85, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3. 树木：外圈淡墨晕 + 3~4 粒不规则墨点
  for (const tree of world.trees ?? []) {
    const tx = toB(tree.x);
    const ty = toB(tree.y);
    const cr = Math.max(2, (tree.canopyR / BAKE_SCALE) * 0.36);
    ctx.fillStyle = 'rgba(34, 26, 18, 0.16)';
    ctx.beginPath();
    ctx.arc(tx, ty, cr * 1.65, 0, Math.PI * 2);
    ctx.fill();
    const dots = 3 + (rnd() < 0.5 ? 1 : 0);
    for (let k = 0; k < dots; k++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * cr * 0.85;
      const r = cr * (0.38 + rnd() * 0.4);
      ctx.fillStyle = `rgba(${22 + Math.floor(rnd() * 14)}, ${17 + Math.floor(rnd() * 10)}, 12, ${(
        0.5 +
        rnd() * 0.28
      ).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(tx + Math.cos(a) * d, ty + Math.sin(a) * d, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 4. 墙体 / 残垣 / 货车：细墨块（庇护所自身墙体 h_* 交给动态小屋图标）
  for (const wall of world.walls ?? []) {
    if (typeof wall.id === 'string' && wall.id.startsWith('h_')) continue;
    ctx.fillStyle = wall.kind === 'truck' ? 'rgba(52, 38, 26, 0.7)' : 'rgba(30, 22, 14, 0.72)';
    ctx.fillRect(
      toB(wall.x),
      toB(wall.y),
      Math.max(1, wall.w / BAKE_SCALE),
      Math.max(1, wall.h / BAKE_SCALE)
    );
  }
  return c;
}

interface PaperSet {
  size: number; // 设备像素边长
  dpr: number;
  light: HTMLCanvasElement; // 已探索区域：较亮羊皮纸
  dark: HTMLCanvasElement; // 未探索区域：墨洗暗纸 + 交叉排线
  frame: HTMLCanvasElement; // 铁环 + 铆钉 + 北向标记（中心透明）
  layer: HTMLCanvasElement; // 每帧合成用的工作层
}

/** 烘焙底纸、暗纸与铁环（尺寸或 dpr 改变时才重新烘焙） */
function bakePaper(cssSize: number, dpr: number): PaperSet {
  const D = Math.max(16, Math.round(cssSize * dpr));
  const c = D / 2;
  const rnd = makeRng(91 + D);
  const light = makeCanvas(D, D);
  const dark = makeCanvas(D, D);
  const frame = makeCanvas(D, D);
  const layer = makeCanvas(D, D);
  const mapR = c - 5 * dpr;

  const lctx = light.getContext('2d');
  if (lctx) {
    // 羊皮纸主体：中心偏暖、边缘焦褐
    const g = lctx.createRadialGradient(c * 0.86, c * 0.8, 0, c, c, c);
    g.addColorStop(0, '#8b7a5c');
    g.addColorStop(0.55, '#76654a');
    g.addColorStop(1, '#463a2a');
    lctx.fillStyle = g;
    lctx.fillRect(0, 0, D, D);

    // 逐像素纸纤维噪声（只烘焙一次）
    const img = lctx.getImageData(0, 0, D, D);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const nz = (rnd() - 0.5) * 26;
      px[i] = Math.max(0, Math.min(255, px[i] + nz));
      px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + nz * 0.92));
      px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + nz * 0.8));
    }
    lctx.putImageData(img, 0, 0);

    // 纸纤维短划
    lctx.lineWidth = Math.max(0.6, 0.55 * dpr);
    for (let i = 0; i < 46; i++) {
      const x = rnd() * D;
      const y = rnd() * D;
      const a = rnd() * Math.PI;
      const l = (4 + rnd() * 9) * dpr;
      lctx.strokeStyle = `rgba(52, 38, 24, ${(0.06 + rnd() * 0.08).toFixed(3)})`;
      lctx.beginPath();
      lctx.moveTo(x, y);
      lctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      lctx.stroke();
    }

    // 水渍 / 污斑
    for (let i = 0; i < 7; i++) {
      const x = rnd() * D;
      const y = rnd() * D;
      const r = (0.12 + rnd() * 0.3) * D;
      const sg = lctx.createRadialGradient(x, y, 0, x, y, r);
      sg.addColorStop(0, `rgba(58, 38, 20, ${(0.12 + rnd() * 0.16).toFixed(3)})`);
      sg.addColorStop(0.7, 'rgba(58, 38, 20, 0.05)');
      sg.addColorStop(1, 'rgba(58, 38, 20, 0)');
      lctx.fillStyle = sg;
      lctx.fillRect(0, 0, D, D);
    }
    // 咖啡环
    for (let i = 0; i < 2; i++) {
      lctx.strokeStyle = `rgba(74, 46, 22, ${(0.16 + rnd() * 0.1).toFixed(3)})`;
      lctx.lineWidth = (1 + rnd()) * dpr;
      lctx.beginPath();
      lctx.arc(c + (rnd() - 0.5) * c, c + (rnd() - 0.5) * c, (0.18 + rnd() * 0.12) * D, rnd() * 6, rnd() * 6 + 4.6);
      lctx.stroke();
    }
    // 边缘焦痕：墨与霉斑向内侵蚀
    const eg = lctx.createRadialGradient(c, c, mapR * 0.62, c, c, mapR);
    eg.addColorStop(0, 'rgba(20, 14, 8, 0)');
    eg.addColorStop(0.75, 'rgba(20, 14, 8, 0.32)');
    eg.addColorStop(1, 'rgba(14, 10, 6, 0.78)');
    lctx.fillStyle = eg;
    lctx.fillRect(0, 0, D, D);
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = mapR * (0.86 + rnd() * 0.14);
      lctx.fillStyle = `rgba(16, 11, 7, ${(0.25 + rnd() * 0.35).toFixed(3)})`;
      lctx.beginPath();
      lctx.arc(c + Math.cos(a) * rr, c + Math.sin(a) * rr, (0.8 + rnd() * 2.6) * dpr, 0, Math.PI * 2);
      lctx.fill();
    }
  }

  const dctx = dark.getContext('2d');
  if (dctx) {
    // 未探索：同一张纸被墨洗压暗 + 斜向交叉排线（"尚未踏足"）
    dctx.drawImage(light, 0, 0);
    dctx.fillStyle = 'rgba(16, 12, 8, 0.66)';
    dctx.fillRect(0, 0, D, D);
    dctx.strokeStyle = 'rgba(8, 6, 4, 0.32)';
    dctx.lineWidth = Math.max(0.6, 0.6 * dpr);
    const step = 5 * dpr;
    dctx.beginPath();
    for (let k = -D; k < D * 2; k += step) {
      dctx.moveTo(k, 0);
      dctx.lineTo(k - D, D);
    }
    dctx.stroke();
  }

  const fctx = frame.getContext('2d');
  if (fctx) {
    // 外侧投影
    fctx.strokeStyle = 'rgba(0, 0, 0, 0.62)';
    fctx.lineWidth = 4.2 * dpr;
    fctx.beginPath();
    fctx.arc(c, c, c - 2.2 * dpr, 0, Math.PI * 2);
    fctx.stroke();
    // 铁环：斜向金属渐变
    const ig = fctx.createLinearGradient(0, 0, D, D);
    ig.addColorStop(0, '#8e8a81');
    ig.addColorStop(0.35, '#4a4741');
    ig.addColorStop(0.62, '#2c2a26');
    ig.addColorStop(1, '#5d5951');
    fctx.strokeStyle = ig;
    fctx.lineWidth = 3.1 * dpr;
    fctx.beginPath();
    fctx.arc(c, c, c - 3.4 * dpr, 0, Math.PI * 2);
    fctx.stroke();
    // 内侧墨线
    fctx.strokeStyle = 'rgba(10, 8, 6, 0.88)';
    fctx.lineWidth = 1 * dpr;
    fctx.beginPath();
    fctx.arc(c, c, mapR, 0, Math.PI * 2);
    fctx.stroke();
    // 锈斑
    for (let i = 0; i < 22; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = c - 3.4 * dpr + (rnd() - 0.5) * 2.2 * dpr;
      fctx.fillStyle = `rgba(${110 + Math.floor(rnd() * 30)}, ${58 + Math.floor(rnd() * 20)}, 30, ${(
        0.3 +
        rnd() * 0.35
      ).toFixed(2)})`;
      fctx.beginPath();
      fctx.arc(c + Math.cos(a) * rr, c + Math.sin(a) * rr, (0.5 + rnd() * 0.9) * dpr, 0, Math.PI * 2);
      fctx.fill();
    }
    // 铆钉（避开正北）
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + Math.PI / 6 + (i * Math.PI * 2) / 6.6;
      const rx = c + Math.cos(a) * (c - 3.4 * dpr);
      const ry = c + Math.sin(a) * (c - 3.4 * dpr);
      fctx.fillStyle = '#1c1a17';
      fctx.beginPath();
      fctx.arc(rx, ry, 1.5 * dpr, 0, Math.PI * 2);
      fctx.fill();
      fctx.fillStyle = 'rgba(190, 180, 160, 0.55)';
      fctx.beginPath();
      fctx.arc(rx - 0.4 * dpr, ry - 0.4 * dpr, 0.6 * dpr, 0, Math.PI * 2);
      fctx.fill();
    }
    // 北向标记：铁环上一枚骨白小三角 + 环内衬线 N
    const ny = 1.2 * dpr;
    fctx.fillStyle = '#d9d1bf';
    fctx.strokeStyle = 'rgba(8, 6, 4, 0.9)';
    fctx.lineWidth = 1 * dpr;
    fctx.beginPath();
    fctx.moveTo(c, ny);
    fctx.lineTo(c + 3.6 * dpr, ny + 7 * dpr);
    fctx.lineTo(c - 3.6 * dpr, ny + 7 * dpr);
    fctx.closePath();
    fctx.stroke();
    fctx.fill();
    fctx.font = `600 ${Math.round(8.5 * dpr)}px Georgia, "Noto Serif SC", "Songti SC", serif`;
    fctx.textAlign = 'center';
    fctx.textBaseline = 'top';
    fctx.lineWidth = 2.4 * dpr;
    fctx.strokeStyle = 'rgba(14, 10, 6, 0.6)';
    fctx.strokeText('N', c, c - mapR + 4.5 * dpr);
    fctx.fillStyle = 'rgba(232, 224, 206, 0.86)';
    fctx.fillText('N', c, c - mapR + 4.5 * dpr);
  }

  return { size: D, dpr, light, dark, frame, layer };
}

// ---------------------------------------------------------------- 动态符号

function drawHouse(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, s * 0.18);
  ctx.strokeStyle = 'rgba(20, 13, 8, 0.92)';
  ctx.fillStyle = '#b87b3b';
  ctx.beginPath();
  ctx.moveTo(-s * 0.62, -s * 0.05);
  ctx.lineTo(0, -s * 0.7);
  ctx.lineTo(s * 0.62, -s * 0.05);
  ctx.lineTo(s * 0.48, -s * 0.05);
  ctx.lineTo(s * 0.48, s * 0.55);
  ctx.lineTo(-s * 0.48, s * 0.55);
  ctx.lineTo(-s * 0.48, -s * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // 门洞
  ctx.fillStyle = 'rgba(20, 13, 8, 0.9)';
  ctx.fillRect(-s * 0.12, s * 0.16, s * 0.24, s * 0.39);
  ctx.restore();
}

function drawPoiGlyph(
  ctx: CanvasRenderingContext2D,
  kind: 'truck' | 'mill' | 'camp' | 'shrine' | 'other',
  x: number,
  y: number,
  s: number
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, s * 0.16);
  ctx.strokeStyle = 'rgba(24, 16, 10, 0.92)';
  ctx.fillStyle = 'rgba(24, 16, 10, 0.88)';
  ctx.beginPath();
  if (kind === 'truck') {
    // 倾覆货车：斜置车厢 + 两只车轮
    ctx.rotate(-0.32);
    ctx.strokeRect(-s * 0.6, -s * 0.3, s * 0.82, s * 0.5);
    ctx.strokeRect(s * 0.22, -s * 0.12, s * 0.34, s * 0.32);
    ctx.moveTo(-s * 0.3 + s * 0.14, s * 0.32);
    ctx.arc(-s * 0.3, s * 0.32, s * 0.14, 0, Math.PI * 2);
    ctx.moveTo(s * 0.36 + s * 0.14, s * 0.32);
    ctx.arc(s * 0.36, s * 0.32, s * 0.14, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === 'mill') {
    // 锯木厂：圆锯片
    ctx.arc(0, 0, s * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.moveTo(Math.cos(a) * s * 0.42, Math.sin(a) * s * 0.42);
      ctx.lineTo(Math.cos(a + 0.28) * s * 0.6, Math.sin(a + 0.28) * s * 0.6);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.1, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'camp') {
    // 猎人营地：帐篷三角
    ctx.moveTo(-s * 0.6, s * 0.42);
    ctx.lineTo(0, -s * 0.5);
    ctx.lineTo(s * 0.6, s * 0.42);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.5);
    ctx.lineTo(0, s * 0.42);
    ctx.stroke();
  } else if (kind === 'shrine') {
    // 枯林祭坛：石柱 + 横梁
    ctx.moveTo(-s * 0.32, s * 0.5);
    ctx.lineTo(-s * 0.32, -s * 0.32);
    ctx.moveTo(s * 0.32, s * 0.5);
    ctx.lineTo(s * 0.32, -s * 0.32);
    ctx.moveTo(-s * 0.58, -s * 0.42);
    ctx.lineTo(s * 0.58, -s * 0.42);
    ctx.stroke();
  } else {
    ctx.arc(0, 0, s * 0.34, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number) {
  ctx.font = `600 ${Math.round(px)}px Georgia, "Noto Serif SC", "Songti SC", "SimSun", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = Math.max(1.5, px * 0.28);
  ctx.strokeStyle = 'rgba(150, 132, 100, 0.55)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = 'rgba(28, 19, 11, 0.92)';
  ctx.fillText(text, x, y);
}

function drawPlayerArrow(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s * 0.95, 0);
  ctx.lineTo(-s * 0.6, s * 0.62);
  ctx.lineTo(-s * 0.25, 0);
  ctx.lineTo(-s * 0.6, -s * 0.62);
  ctx.closePath();
  ctx.lineWidth = Math.max(1.4, s * 0.34);
  ctx.strokeStyle = 'rgba(8, 6, 4, 0.92)';
  ctx.stroke();
  ctx.fillStyle = '#e6dcc6';
  ctx.fill();
  ctx.restore();
  // 余烬心点
  ctx.fillStyle = '#b87b3b';
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, s * 0.16), 0, Math.PI * 2);
  ctx.fill();
}

export default function Minimap({ runtimeRef, exploreRef, className }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 迷雾纹理：1 像素 = 1 个探索格，alpha = 探索强度；放大绘制时双线性插值自然形成软边
    const fog = makeCanvas(GRID, GRID);
    const fogCtx = fog.getContext('2d');
    const fogImg = fogCtx ? fogCtx.createImageData(GRID, GRID) : null;
    let fogStale = true;

    let ink: HTMLCanvasElement | null = null;
    let inkWorld: WorldData | null = null;
    let paper: PaperSet | null = null;
    let cssSize = 0;
    let nightAmt = -1;
    let raf = 0;
    let last = 0;
    let lastPx = NaN;
    let lastPy = NaN;
    let lastAng = NaN;
    let lastNight = NaN;
    let lastDiscCount = -1;

    const syncFog = (st: MinimapExploreState) => {
      if (!fogCtx || !fogImg) return;
      const d = fogImg.data;
      const g = st.grid;
      for (let i = 0; i < g.length; i++) {
        const o = i * 4;
        d[o] = 255;
        d[o + 1] = 255;
        d[o + 2] = 255;
        d[o + 3] = g[i];
      }
      fogCtx.putImageData(fogImg, 0, 0);
      st.dirty = false;
      fogStale = false;
    };

    const tick = () => {
      const eng = runtimeRef.current?.engine;
      if (!eng) return;
      const world = eng.world;
      const p = eng.player;
      if (!world || !p) return;

      // 1. 探索网格：新开局（world 对象更换）即重置
      let st = exploreRef.current;
      if (!st) {
        st = createExploreState();
        exploreRef.current = st;
      }
      if (st.world !== world) {
        st.world = world;
        st.grid.fill(0);
        st.dirty = true;
      }
      if (inkWorld !== world) {
        ink = bakeWorldInk(world);
        inkWorld = world;
      }

      // 非游玩态（如弹窗 hold 暂停态）若已完成首次绘制则直接休眠跳过，释放手机主线程
      if (eng.mode !== 'play' && !Number.isNaN(lastPx)) {
        return;
      }

      const phase = eng.phase;
      if (eng.mode === 'play' || eng.mode === 'hold') {
        const revealR = phase === 'night' ? 170 : phase === 'dusk' ? 215 : 255;
        revealAt(st, p.x, p.y, revealR);
      }
      const hadDirtyFog = st.dirty || fogStale;
      if (hadDirtyFog) syncFog(st);

      // 2. 尺寸 / dpr 变化才重新烘焙底纸（手机端 DPR 控制在 <= 1.5）
      const size = canvas.clientWidth;
      if (size < 8) return;
      const dpr = Math.min(eng.isTouchUi ? 1.5 : 2, Math.max(1, window.devicePixelRatio || 1));
      let resized = false;
      if (!paper || size !== cssSize || paper.dpr !== dpr) {
        cssSize = size;
        paper = bakePaper(size, dpr);
        canvas.width = paper.size;
        canvas.height = paper.size;
        resized = true;
      }

      // 3. 夜色压暗目标值（黄昏渐暗、夜晚最暗，破晓前 10% 回亮），指数平滑
      const dt = typeof eng.dayTime === 'number' ? eng.dayTime : 0;
      let target = 0;
      if (phase === 'dusk') {
        target = 0.12 + 0.3 * Math.min(1, Math.max(0, (dt - DAY_END) / (DUSK_END - DAY_END)));
      } else if (phase === 'night') {
        const np = Math.min(1, Math.max(0, (dt - DUSK_END) / (1 - DUSK_END)));
        target = np > 0.9 ? 0.5 - (np - 0.9) * 3.2 : 0.5;
      }
      nightAmt = nightAmt < 0 ? target : nightAmt + (target - nightAmt) * 0.12;

      // 4. 静止零重绘判据：位移、朝向、迷雾、地标发现数与夜色均无明显变化时跳过 Canvas 合成
      const discCount = eng.discoveredZones ? eng.discoveredZones.size : 0;
      if (
        !resized &&
        !hadDirtyFog &&
        Math.hypot(p.x - lastPx, p.y - lastPy) < 1.2 &&
        Math.abs(p.angle - lastAng) < 0.025 &&
        Math.abs(nightAmt - lastNight) < 0.006 &&
        discCount === lastDiscCount
      ) {
        return;
      }
      lastPx = p.x;
      lastPy = p.y;
      lastAng = p.angle;
      lastNight = nightAmt;
      lastDiscCount = discCount;

      draw(st, eng.discoveredZones, p.x, p.y, p.angle);
    };

    const draw = (
      st: MinimapExploreState,
      discovered: Set<string> | undefined,
      px: number,
      py: number,
      angle: number
    ) => {
      if (!paper || !ink) return;
      const world = st.world;
      if (!world) return;
      const D = paper.size;
      const dpr = paper.dpr;
      const c = D / 2;
      const mapR = c - 5 * dpr;
      const scale = mapR / VIEW_HALF; // 设备像素 / 世界单位
      const k = Math.min(1.15, Math.max(0.72, cssSize / 176)) * dpr; // 符号尺寸系数
      const span = D / scale; // 整张画布覆盖的世界宽度
      const wx0 = px - span / 2;
      const wy0 = py - span / 2;
      const toX = (wx: number) => c + (wx - px) * scale;
      const toY = (wy: number) => c + (wy - py) * scale;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, D, D);
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, mapR, 0, Math.PI * 2);
      ctx.clip();

      // 未探索暗纸
      ctx.drawImage(paper.dark, 0, 0);

      // 已探索层：亮纸 + 世界墨图，再以迷雾纹理 destination-in 裁出走过的区域
      const lctx = paper.layer.getContext('2d');
      if (lctx) {
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.globalCompositeOperation = 'source-over';
        lctx.clearRect(0, 0, D, D);
        lctx.drawImage(paper.light, 0, 0);
        lctx.imageSmoothingEnabled = true;
        drawClipped(
          lctx,
          ink,
          (wx0 + HALF) / BAKE_SCALE,
          (wy0 + HALF) / BAKE_SCALE,
          span / BAKE_SCALE,
          span / BAKE_SCALE,
          0,
          0,
          D,
          D
        );
        lctx.globalCompositeOperation = 'destination-in';
        lctx.imageSmoothingQuality = 'high';
        drawClipped(lctx, fog, (wx0 + HALF) / CELL, (wy0 + HALF) / CELL, span / CELL, span / CELL, 0, 0, D, D);
        lctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(paper.layer, 0, 0);
      }

      // 庇护所：起点必然已知，始终绘制淡虚线平面 + 小屋图标
      const hx = HIDEOUT_RECT.x + HIDEOUT_RECT.w / 2;
      const hy = HIDEOUT_RECT.y + HIDEOUT_RECT.h / 2;
      ctx.save();
      ctx.setLineDash([2.5 * dpr, 2 * dpr]);
      ctx.strokeStyle = 'rgba(30, 20, 12, 0.6)';
      ctx.lineWidth = 1 * dpr;
      ctx.strokeRect(
        toX(HIDEOUT_RECT.x),
        toY(HIDEOUT_RECT.y),
        HIDEOUT_RECT.w * scale,
        HIDEOUT_RECT.h * scale
      );
      ctx.restore();
      drawHouse(ctx, toX(hx), toY(hy), 9 * k);

      // 已走近过的地标：符号 + 名称缩写；圆盘外的已知地标压在内缘作方位刻痕
      for (const poi of world.poiCenters ?? []) {
        if (!discovered || !discovered.has(poi.name)) continue;
        const meta = POI_GLYPH[poi.name];
        const mx = toX(poi.x);
        const my = toY(poi.y);
        const dx = mx - c;
        const dy = my - c;
        const dist = Math.hypot(dx, dy);
        const inner = mapR - 9 * k;
        if (dist > inner) {
          const ux = dx / (dist || 1);
          const uy = dy / (dist || 1);
          const ex = c + ux * (mapR - 4.5 * k);
          const ey = c + uy * (mapR - 4.5 * k);
          ctx.save();
          ctx.translate(ex, ey);
          ctx.rotate(Math.atan2(uy, ux));
          ctx.fillStyle = 'rgba(24, 16, 10, 0.9)';
          ctx.beginPath();
          ctx.moveTo(3.2 * k, 0);
          ctx.lineTo(0, 2.2 * k);
          ctx.lineTo(-3.2 * k, 0);
          ctx.lineTo(0, -2.2 * k);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          continue;
        }
        drawPoiGlyph(ctx, meta ? meta.kind : 'other', mx, my, 11 * k);
        const short = meta ? I18n.t(meta.short) : poi.name.slice(0, 2);
        drawLabel(ctx, short, mx, my + 7.5 * k, 8.5 * k);
      }

      // 中继零件：仅当所在地标已发现或该格已探索时显示（不剧透）；未拾取 = 青色墨圈，已拾取 = 墨勾
      const tSec = performance.now() / 1000;
      for (const rn of world.relayNodes ?? []) {
        const known = (discovered && discovered.has(rn.zone)) || exploredAt(st, rn.x, rn.y) > 140;
        if (!known) continue;
        const mx = toX(rn.x);
        const my = toY(rn.y);
        if (Math.hypot(mx - c, my - c) > mapR - 5 * k) continue;
        ctx.save();
        ctx.lineCap = 'round';
        if (!rn.collected) {
          const pulse = 0.55 + 0.45 * Math.sin(tSec * 2.4);
          ctx.strokeStyle = `rgba(92, 176, 160, ${(0.55 + pulse * 0.35).toFixed(3)})`;
          ctx.lineWidth = 1.3 * k;
          ctx.beginPath();
          ctx.arc(mx, my, (3.6 + pulse * 1.2) * k, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(70, 150, 136, 0.95)';
          ctx.beginPath();
          ctx.arc(mx, my, 1.4 * k, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(24, 16, 10, 0.85)';
          ctx.lineWidth = 1.3 * k;
          ctx.beginPath();
          ctx.moveTo(mx - 2.6 * k, my + 0.2 * k);
          ctx.lineTo(mx - 0.6 * k, my + 2.2 * k);
          ctx.lineTo(mx + 3 * k, my - 2.4 * k);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 夜晚整体压暗（玩家箭头在其上，保证可读）
      if (nightAmt > 0.005) {
        ctx.fillStyle = `rgba(6, 7, 12, ${nightAmt.toFixed(3)})`;
        ctx.fillRect(0, 0, D, D);
      }

      drawPlayerArrow(ctx, c, c, angle, 6.2 * k);
      ctx.restore();

      // 铁环与北向标记
      ctx.drawImage(paper.frame, 0, 0);
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < DRAW_INTERVAL_MS) return;
      last = now;
      try {
        tick();
      } catch {
        // 小地图仅为装饰：任何异常都不得打断游戏或产生控制台错误
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
      ink = null;
      paper = null;
    };
  }, [runtimeRef, exploreRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{ pointerEvents: 'none', display: 'block', width: '100%', height: '100%' }}
    />
  );
}

/**
 * 真实世界探索大地图（按 M 或手机端点击右上角小地图直接展开）
 * 复用同一套探索迷雾网格（exploreRef）与世界墨图，清晰呈现玩家走过的范围、庇护所、已发现地标与中继零件。
 */
export function WorldMapView({
  runtimeRef,
  exploreRef,
}: {
  runtimeRef: { current: GameRuntime | null };
  exploreRef: { current: MinimapExploreState | null };
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let last = 0;
    let bakedWorld: WorldData | null = null;
    let ink: HTMLCanvasElement | null = null;
    let fog: HTMLCanvasElement | null = null;
    let fogImg: ImageData | null = null;
    let fogUploaded = false;
    let layer: HTMLCanvasElement | null = null;

    const draw = (now: number) => {
      raf = window.requestAnimationFrame(draw);
      // 大地图打开期间世界处于暂停静止态，仅以 ~4Hz 极低频刷新中继脉冲，且复用迷雾缓冲零对象分配
      if (last > 0 && now - last < 250) return;
      last = now;

      const engine = runtimeRef.current?.engine;
      if (!engine || !engine.world) return;
      const world = engine.world;
      const dpr = Math.min(window.devicePixelRatio || 1, engine.isTouchUi ? 1.5 : 2);
      const cssW = Math.max(200, Math.round(canvas.clientWidth || 460));
      const cssH = Math.max(160, Math.round(canvas.clientHeight || 320));
      const W = Math.round(cssW * dpr);
      const H = Math.round(cssH * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        layer = makeCanvas(W, H);
      }

      if (!exploreRef.current) exploreRef.current = createExploreState();
      const st = exploreRef.current;
      if (st.world !== world) {
        st.world = world;
        st.grid.fill(0);
        revealAt(st, HIDEOUT_RECT.x + HIDEOUT_RECT.w * 0.5, HIDEOUT_RECT.y + HIDEOUT_RECT.h * 0.5, 420);
        st.dirty = true;
        fogUploaded = false;
      }
      const px = engine.player.x;
      const py = engine.player.y;
      revealAt(st, px, py, 320);

      if (bakedWorld !== world || !ink) {
        bakedWorld = world;
        ink = bakeWorldInk(world);
      }
      if (!fog) {
        fog = makeCanvas(GRID, GRID);
        fogUploaded = false;
      }
      if (!fogUploaded || st.dirty) {
        const fctx = fog.getContext('2d');
        if (fctx) {
          if (!fogImg) {
            fogImg = fctx.createImageData(GRID, GRID);
            const d = fogImg.data;
            for (let i = 0; i < GRID * GRID; i++) {
              const o = i * 4;
              d[o] = 255;
              d[o + 1] = 255;
              d[o + 2] = 255;
            }
          }
          const data = fogImg.data;
          const g = st.grid;
          for (let i = 0; i < g.length; i++) {
            data[i * 4 + 3] = g[i];
          }
          fctx.putImageData(fogImg, 0, 0);
          fogUploaded = true;
        }
      }

      const viewSpan = Math.min(WORLD_SIZE, 4400);
      const scale = Math.min(W, H) / viewSpan;
      const offX = W * 0.5;
      const offY = H * 0.5;
      const toX = (wx: number) => offX + wx * scale;
      const toY = (wy: number) => offY + wy * scale;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#18140f';
      ctx.fillRect(0, 0, W, H);

      ctx.strokeStyle = 'rgba(184, 158, 118, 0.08)';
      ctx.lineWidth = 1 * dpr;
      const step = 600 * scale;
      for (let gx = offX % step; gx < W; gx += step) {
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, H);
        ctx.stroke();
      }
      for (let gy = offY % step; gy < H; gy += step) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(W, gy);
        ctx.stroke();
      }

      if (layer && ink && fog) {
        const lctx = layer.getContext('2d');
        if (lctx) {
          lctx.setTransform(1, 0, 0, 1, 0, 0);
          lctx.globalCompositeOperation = 'source-over';
          lctx.clearRect(0, 0, W, H);
          lctx.fillStyle = '#9c8b6d';
          lctx.fillRect(0, 0, W, H);
          const dx = toX(-HALF);
          const dy = toY(-HALF);
          const dw = WORLD_SIZE * scale;
          const dh = WORLD_SIZE * scale;
          lctx.imageSmoothingEnabled = true;
          lctx.drawImage(ink, dx, dy, dw, dh);
          lctx.globalCompositeOperation = 'destination-in';
          lctx.imageSmoothingQuality = 'high';
          lctx.drawImage(fog, dx, dy, dw, dh);
          lctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(layer, 0, 0);
        }
      }

      const hx = HIDEOUT_RECT.x + HIDEOUT_RECT.w * 0.5;
      const hy = HIDEOUT_RECT.y + HIDEOUT_RECT.h * 0.5;
      ctx.strokeStyle = '#e5c176';
      ctx.lineWidth = 1.6 * dpr;
      ctx.strokeRect(toX(HIDEOUT_RECT.x), toY(HIDEOUT_RECT.y), HIDEOUT_RECT.w * scale, HIDEOUT_RECT.h * scale);
      drawHouse(ctx, toX(hx), toY(hy), 12 * dpr);

      const discovered = engine.discoveredZones;
      for (const poi of world.poiCenters ?? []) {
        if (!discovered || !discovered.has(poi.name)) continue;
        const meta = POI_GLYPH[poi.name];
        const mx = toX(poi.x);
        const my = toY(poi.y);
        drawPoiGlyph(ctx, meta ? meta.kind : 'other', mx, my, 12 * dpr);
        const short = meta ? I18n.t(meta.short) : poi.name.slice(0, 3);
        drawLabel(ctx, short, mx, my + 10 * dpr, 10 * dpr);
      }

      const tSec = performance.now() / 1000;
      for (const rn of world.relayNodes ?? []) {
        const known = (discovered && discovered.has(rn.zone)) || exploredAt(st, rn.x, rn.y) > 120;
        if (!known) continue;
        const mx = toX(rn.x);
        const my = toY(rn.y);
        ctx.save();
        if (!rn.collected) {
          const pulse = 0.55 + 0.45 * Math.sin(tSec * 2.8);
          ctx.strokeStyle = `rgba(116, 224, 202, ${(0.6 + pulse * 0.35).toFixed(3)})`;
          ctx.lineWidth = 1.8 * dpr;
          ctx.beginPath();
          ctx.arc(mx, my, (5.5 + pulse * 2) * dpr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#7ad8c5';
          ctx.beginPath();
          ctx.arc(mx, my, 2.4 * dpr, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = '#7ad8c5';
          ctx.lineWidth = 2 * dpr;
          ctx.beginPath();
          ctx.moveTo(mx - 4 * dpr, my);
          ctx.lineTo(mx - 1 * dpr, my + 3.5 * dpr);
          ctx.lineTo(mx + 4.5 * dpr, my - 3.5 * dpr);
          ctx.stroke();
        }
        ctx.restore();
      }

      drawPlayerArrow(ctx, toX(px), toY(py), engine.player.angle, 9 * dpr);

      ctx.fillStyle = 'rgba(235, 220, 188, 0.72)';
      ctx.font = `700 ${11 * dpr}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('N', W * 0.5, 16 * dpr);
    };

    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [runtimeRef, exploreRef]);

  return (
    <canvas
      ref={canvasRef}
      className="worldmap-canvas block w-full rounded border border-[#b8ae9c]/30 bg-[#14110d]"
    />
  );
}
