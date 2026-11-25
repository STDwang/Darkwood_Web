// 世界空间黑色枯枝灌木（主美 R3 第 4 条）：预烘焙 BRAMBLE_VARIANTS 种分形枝形，旋转缩放复用
// - 主干 1.5–2.5px，3–5 级分叉，末梢渐细至约 0.5px，略弯曲；颜色 #070707–#0d0c0b
// - 被手电光锥或亮着的建筑灯照到时，沿"背离光源"方向平移约 6–16px、以 20–30% 透明度再画一次作为细长投影
// - 纯装饰：无碰撞、不阻光；只读 engine.world.brambles / 玩家手电 / 建筑灯，不写任何游戏状态
// - 枝形离屏 canvas 只在首次绘制时烘焙一次；每帧零分配（无闭包、无临时数组），视口外直接跳过

import type { GameEngine } from '../engine';
import { isLightLit, lightFlicker } from '../buildings';
import { createRng } from '../util';
import { BRAMBLE_VARIANTS } from '../world';

/** 离屏枝形画布边长（像素） */
const SPRITE_PX = 160;
/** scale=1 时一丛枯枝在世界中的覆盖直径（世界 px，扩大以增强修长茂密的诡异枝条感） */
const WORLD_SPAN = 136;
const BRANCH_COLORS = ['#070707', '#0a0908', '#0d0c0b', '#090807'];

let sprites: HTMLCanvasElement[] | null = null;

// 亮灯缓存（每次调用刷新，定长类型数组，零分配）
const LAMP_MAX = 24;
const lampX = new Float64Array(LAMP_MAX);
const lampY = new Float64Array(LAMP_MAX);
const lampR2 = new Float64Array(LAMP_MAX);
let lampN = 0;

function branch(
  g: CanvasRenderingContext2D,
  rng: () => number,
  x: number,
  y: number,
  ang: number,
  len: number,
  width: number,
  depth: number,
  k: number
) {
  const bend = (rng() - 0.5) * 1.05;
  const mx = x + Math.cos(ang + bend * 0.55) * len * 0.52;
  const my = y + Math.sin(ang + bend * 0.55) * len * 0.52;
  const ex = x + Math.cos(ang + bend) * len;
  const ey = y + Math.sin(ang + bend) * len;
  g.lineWidth = Math.max(0.5 * k, width);
  g.beginPath();
  g.moveTo(x, y);
  g.quadraticCurveTo(mx, my, ex, ey);
  g.stroke();
  if (depth <= 0) return;
  const n = 2 + (rng() < 0.55 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    // 分叉点沿枝条 48%–100% 处，末端越分越细且诡异扭折
    const f = 0.48 + rng() * 0.52;
    const bx = x + (ex - x) * f + (mx - (x + ex) * 0.5) * (1 - Math.abs(f * 2 - 1)) * 0.85;
    const by = y + (ey - y) * f + (my - (y + ey) * 0.5) * (1 - Math.abs(f * 2 - 1)) * 0.85;
    const spread = (rng() - 0.5) * 1.6 + (i - (n - 1) * 0.5) * 0.55;
    branch(g, rng, bx, by, ang + bend + spread, len * (0.62 + rng() * 0.22), width * 0.64, depth - 1, k);
  }
}

function bakeSprites(): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  const k = SPRITE_PX / WORLD_SPAN; // 画布像素 / 世界像素
  for (let v = 0; v < BRAMBLE_VARIANTS; v++) {
    const c = document.createElement('canvas');
    c.width = SPRITE_PX;
    c.height = SPRITE_PX;
    const g = c.getContext('2d');
    out.push(c);
    if (!g) continue;
    const rng = createRng(9001 + v * 7919);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = BRANCH_COLORS[v % BRANCH_COLORS.length];
    g.translate(SPRITE_PX * 0.5, SPRITE_PX * 0.5);
    const stems = 4 + Math.floor(rng() * 3);
    const base = rng() * Math.PI * 2;
    for (let s = 0; s < stems; s++) {
      const ang = base + (s / stems) * Math.PI * 2 * (0.65 + rng() * 0.3) + (rng() - 0.5) * 0.55;
      const depth = 3 + Math.floor(rng() * 2); // 共 4–5 级茂密长枝
      branch(g, rng, 0, 0, ang, (14 + rng() * 8) * k, (1.8 + rng() * 1.1) * k, depth, k);
    }
    // 根部小结节
    g.fillStyle = BRANCH_COLORS[0];
    g.beginPath();
    g.arc(0, 0, 1.6 * k, 0, Math.PI * 2);
    g.fill();
  }
  return out;
}

/**
 * 绘制视口内的枯枝灌木（地面层之上、树干与树冠之下）
 * 返回 drawCalls 记账（每 16 丛计 1 次批次）
 */
export function drawBrambles(
  ctx: CanvasRenderingContext2D,
  engine: GameEngine,
  viewL: number,
  viewT: number,
  viewR: number,
  viewB: number,
  coneHalfRad: number
): number {
  if (typeof document === 'undefined') return 0;
  const list = engine.world.brambles;
  if (!list || list.length === 0) return 0;
  if (!sprites) sprites = bakeSprites();
  const spr = sprites;

  const p = engine.player;
  const beamOn = engine.mode !== 'title' && p.flashlightOn && p.flickerVal > 0.05;
  const dirX = Math.cos(p.angle);
  const dirY = Math.sin(p.angle);
  const cosHalf = Math.cos(coneHalfRad + 0.05);
  const beamLen = 470;

  // 刷新视口附近亮着的建筑灯
  lampN = 0;
  const lights = engine.world.lights;
  const gen = engine.generatorOn && engine.generatorFuel > 0;
  for (let i = 0; i < lights.length && lampN < LAMP_MAX; i++) {
    const l = lights[i];
    if (!isLightLit(l, gen)) continue;
    if (l.x < viewL - l.radius || l.x > viewR + l.radius || l.y < viewT - l.radius || l.y > viewB + l.radius) continue;
    if (lightFlicker(l, engine.simTime) < 0.3) continue;
    lampX[lampN] = l.x;
    lampY[lampN] = l.y;
    lampR2[lampN] = l.radius * l.radius * 0.7;
    lampN++;
  }

  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const size = WORLD_SPAN * b.scale;
    const half = size * 0.5;
    if (b.x + half < viewL || b.x - half > viewR || b.y + half < viewT || b.y - half > viewB) continue;
    const img = spr[b.variant % spr.length];

    // 投影：手电光锥优先，否则最近的亮灯
    let sx = 0;
    let sy = 0;
    let sa = 0;
    if (beamOn) {
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < beamLen * beamLen && d2 > 100) {
        const d = Math.sqrt(d2);
        if ((dx * dirX + dy * dirY) / d > cosHalf) {
          const off = 6 + 8 * b.scale + d * 0.012;
          sx = (dx / d) * off;
          sy = (dy / d) * off;
          sa = 0.3 - (d / beamLen) * 0.1;
        }
      }
    }
    if (sa === 0 && lampN > 0) {
      for (let k = 0; k < lampN; k++) {
        const dx = b.x - lampX[k];
        const dy = b.y - lampY[k];
        const d2 = dx * dx + dy * dy;
        if (d2 > lampR2[k] || d2 < 64) continue;
        const d = Math.sqrt(d2);
        const off = 5 + 7 * b.scale;
        sx = (dx / d) * off;
        sy = (dy / d) * off;
        sa = 0.22;
        break;
      }
    }

    if (sa > 0) {
      ctx.globalAlpha = sa;
      ctx.save();
      ctx.translate(b.x + sx, b.y + sy);
      ctx.rotate(b.rot);
      ctx.drawImage(img, -half * 1.08, -half * 1.08, size * 1.08, size * 1.08);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.drawImage(img, -half, -half, size, size);
    ctx.restore();
    n++;
  }
  return Math.ceil(n / 16);
}
