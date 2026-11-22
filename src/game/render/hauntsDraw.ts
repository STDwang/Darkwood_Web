// 超自然异象程序化绘制（只读 engine.haunts；渲染层不写任何游戏状态）
// - drawHauntsAlbedo：砸桌女人 / 座椅 / 桌面物件 / 兜底虚拟桌（世界坐标，参与真实光照，屋顶之前绘制以便被屋顶遮住）
// - drawHauntsOverlay：跳舞幽灵 / 一闪而逝 / 异象压迫边缘去饱和（暗部之上，按距离显形规则克制绘制）
// 零每帧分配：无数组/对象/闭包创建；渐变按画布尺寸缓存。

import type { GameEngine } from '../engine';
import type { ApparitionState, DanceGhostState, TableHauntState } from '../haunts';
import { clamp, lerp } from '../util';

/** 确定性伪随机（无分配）：同一输入同一输出，用于噪点溶解与微抖 */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// 1. 屋内：砸桌女人（albedo 阶段，renderer 在乌鸦之后、屋顶之前一行调用）
// ---------------------------------------------------------------------------
export function drawHauntsAlbedo(
  ctx: CanvasRenderingContext2D,
  engine: GameEngine,
  viewL: number,
  viewT: number,
  viewR: number,
  viewB: number
): number {
  const tb = engine.haunts.table;
  if (tb.source === 'none') return 0;
  const pad = 60;
  if (
    tb.tableX + tb.tableW < viewL - pad ||
    tb.tableX > viewR + pad ||
    tb.tableY + tb.tableH < viewT - pad ||
    tb.tableY > viewB + pad
  ) {
    return 0;
  }
  let draws = 0;
  ctx.save();
  if (tb.source === 'virtual') {
    drawVirtualTable(ctx, tb);
    draws++;
  }
  drawTableItems(ctx, tb);
  draws++;
  drawChairAndWoman(ctx, tb, engine.simTime);
  draws++;
  ctx.restore();
  return draws;
}

/** 兜底虚拟桌（关卡尚未提供真实桌子时；仅渲染、无碰撞）；位置叠加砸桌渲染偏移 */
function drawVirtualTable(ctx: CanvasRenderingContext2D, tb: TableHauntState) {
  const x = tb.tableX + tb.offX;
  const y = tb.tableY + tb.offY;
  const w = tb.tableW;
  const h = tb.tableH;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
  ctx.fillRect(x + 3, y + 4, w, h);
  ctx.fillStyle = '#3a2b1d';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(18, 12, 8, 0.65)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const yy = y + (h * i) / 4;
    ctx.moveTo(x + 1, yy);
    ctx.lineTo(x + w - 1, yy);
  }
  ctx.stroke();
  ctx.strokeStyle = '#120d08';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** 桌面物件：锡杯 / 残烛 / 瓷盘，随砸桌冲击跳起（俯视：向上偏移 + 影子分离） */
function drawTableItems(ctx: CanvasRenderingContext2D, tb: TableHauntState) {
  const bx = tb.tableX + tb.offX;
  const by = tb.tableY + tb.offY;
  const w = tb.tableW;
  const h = tb.tableH;
  const h0 = tb.itemHop[0];
  const h1 = tb.itemHop[1];
  const h2 = tb.itemHop[2];

  // 影子（一次 fill）
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.beginPath();
  ctx.arc(bx + w * 0.26 + 1, by + h * 0.36 + 1.2, 3.3, 0, Math.PI * 2);
  ctx.moveTo(bx + w * 0.72 + 3.4, by + h * 0.4 + 1);
  ctx.arc(bx + w * 0.72 + 1, by + h * 0.4 + 1, 2.4, 0, Math.PI * 2);
  ctx.moveTo(bx + w * 0.5 + 6.5, by + h * 0.68 + 1);
  ctx.ellipse(bx + w * 0.5 + 1, by + h * 0.68 + 1, 5.5, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // 瓷盘（略倾斜跳动）
  const px = bx + w * 0.5;
  const py = by + h * 0.68 - h2;
  ctx.fillStyle = '#77746a';
  ctx.beginPath();
  ctx.ellipse(px, py, 5.5, 4, h2 * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#57544c';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.ellipse(px, py, 3.4, 2.4, h2 * 0.06, 0, Math.PI * 2);
  ctx.stroke();

  // 锡杯
  const cx = bx + w * 0.26;
  const cy = by + h * 0.36 - h0;
  ctx.fillStyle = '#5a5f5c';
  ctx.beginPath();
  ctx.arc(cx, cy, 3.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1c1b';
  ctx.beginPath();
  ctx.arc(cx, cy, 1.9, 0, Math.PI * 2);
  ctx.fill();

  // 残烛
  const kx = bx + w * 0.72;
  const ky = by + h * 0.4 - h1;
  ctx.fillStyle = '#c9c0a7';
  ctx.beginPath();
  ctx.arc(kx, ky, 2.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1410';
  ctx.beginPath();
  ctx.arc(kx, ky, 0.7, 0, Math.PI * 2);
  ctx.fill();
}

/** 座椅（她消失后可能慢慢转向玩家）+ 伏桌/抬头的女人 */
function drawChairAndWoman(ctx: CanvasRenderingContext2D, tb: TableHauntState, time: number) {
  ctx.save();
  ctx.translate(tb.seatX, tb.seatY);

  // 旧木椅：局部 +x 指向椅子"正面"，靠背在 -x 侧
  ctx.save();
  ctx.rotate(tb.chairAngle);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fillRect(-5, -5, 14, 14);
  ctx.fillStyle = '#2b2119';
  ctx.fillRect(-7, -7, 13, 14);
  ctx.fillStyle = '#1a130d';
  ctx.fillRect(-9.5, -7.5, 3.2, 15);
  ctx.restore();

  if (tb.fade > 0.01) {
    ctx.rotate(tb.faceAngle);
    const a = clamp(tb.fade, 0, 1) * 0.9;
    const lift = clamp(tb.headLift, 0, 1);
    ctx.globalAlpha = a;

    // 佝偻的肩背（灰白旧裙）：伏桌时前倾，抬头时直起
    const sx = lerp(3.5, 0.5, lift);
    ctx.fillStyle = '#7d8782';
    ctx.beginPath();
    ctx.ellipse(sx, 0, 6.2, 7.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // 双臂平摊在桌面
    const handX = lerp(15, 10.5, lift);
    ctx.strokeStyle = '#a7aea8';
    ctx.lineWidth = 2.1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx + 2, -5.5);
    ctx.lineTo(handX, -7);
    ctx.moveTo(sx + 2, 5.5);
    ctx.lineTo(handX, 7);
    ctx.stroke();

    // 长黑发：伏桌时向前扇形散在桌面；抬头时披向身后
    const hx = lerp(13, 1.5, lift);
    ctx.strokeStyle = '#0f1111';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let s = 0; s < 7; s++) {
      const off = (s - 3) * 1.6;
      const wav = Math.sin(time * 1.3 + s) * 0.6;
      ctx.moveTo(hx, off * 0.8);
      if (lift < 0.5) {
        ctx.quadraticCurveTo(hx + 6, off * 1.6 + wav, hx + 11 + (s % 2) * 2, off * 2.4);
      } else {
        ctx.quadraticCurveTo(hx - 4, off * 1.3 + wav, hx - 9 - (s % 2) * 2, off * 1.8);
      }
    }
    ctx.stroke();

    // 头顶（发旋）
    ctx.fillStyle = '#141616';
    ctx.beginPath();
    ctx.arc(hx, 0, 4.4, 0, Math.PI * 2);
    ctx.fill();

    // 抬头后：苍白的脸慢慢转向你（克制：极小、无五官夸张）
    if (tb.phase === 'rising' && lift > 0.55) {
      const rel = tb.headTurn - tb.faceAngle;
      const k = clamp((lift - 0.55) / 0.45, 0, 1);
      const fx = hx + Math.cos(rel) * 2.4;
      const fy = Math.sin(rel) * 2.4;
      ctx.globalAlpha = a * k;
      ctx.fillStyle = '#b6bcb4';
      ctx.beginPath();
      ctx.ellipse(fx, fy, 2.6, 2.1, rel, 0, Math.PI * 2);
      ctx.fill();
      const ex = -Math.sin(rel) * 1.0;
      const ey = Math.cos(rel) * 1.0;
      ctx.fillStyle = '#0b0c0c';
      ctx.beginPath();
      ctx.arc(fx + Math.cos(rel) * 0.9 + ex, fy + Math.sin(rel) * 0.9 + ey, 0.55, 0, Math.PI * 2);
      ctx.moveTo(fx + Math.cos(rel) * 0.9 - ex + 0.55, fy + Math.sin(rel) * 0.9 - ey);
      ctx.arc(fx + Math.cos(rel) * 0.9 - ex, fy + Math.sin(rel) * 0.9 - ey, 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 2. 暗部之上：跳舞幽灵 / 一闪而逝 / 压迫边缘（renderer 在 renderAboveDarknessOverlays 之后一行调用）
// ---------------------------------------------------------------------------
let vigCtx: CanvasRenderingContext2D | null = null;
let vigW = 0;
let vigH = 0;
let vigGrey: CanvasGradient | null = null;
let vigCold: CanvasGradient | null = null;

function ensureVignette(ctx: CanvasRenderingContext2D, W: number, H: number) {
  if (vigCtx === ctx && vigW === W && vigH === H && vigGrey && vigCold) return;
  vigCtx = ctx;
  vigW = W;
  vigH = H;
  const r0 = Math.min(W, H) * 0.22;
  const r1 = Math.hypot(W, H) * 0.55;
  vigGrey = ctx.createRadialGradient(W * 0.5, H * 0.5, r0, W * 0.5, H * 0.5, r1);
  vigGrey.addColorStop(0, 'rgba(128, 128, 128, 0)');
  vigGrey.addColorStop(0.55, 'rgba(128, 128, 128, 0.35)');
  vigGrey.addColorStop(1, 'rgba(128, 128, 128, 1)');
  vigCold = ctx.createRadialGradient(W * 0.5, H * 0.5, r0, W * 0.5, H * 0.5, r1);
  vigCold.addColorStop(0, 'rgba(58, 70, 78, 0)');
  vigCold.addColorStop(1, 'rgba(58, 70, 78, 1)');
}

export function drawHauntsOverlay(
  ctx: CanvasRenderingContext2D,
  engine: GameEngine,
  viewL: number,
  viewT: number,
  W: number,
  H: number
): number {
  const hs = engine.haunts;
  const g = hs.dance;
  const ap = hs.apparition;
  let draws = 0;

  const danceOn =
    g.alpha > 0.004 &&
    g.x > viewL - 60 &&
    g.x < viewL + W + 60 &&
    g.y > viewT - 60 &&
    g.y < viewT + H + 60;
  const appOn = ap.active && ap.alpha > 0.01;

  if (danceOn || appOn) {
    ctx.save();
    ctx.translate(-viewL, -viewT);
    if (danceOn) {
      drawDanceGhost(ctx, g, engine.simTime);
      draws += 2;
    }
    if (appOn) {
      drawApparition(ctx, ap, engine.weather.lightningFlash, engine.simTime);
      draws++;
    }
    ctx.restore();
  }

  // 异象压迫：屏幕边缘去饱和 + 极轻冷灰（不改 webglComposer；强度随附近异象强度）
  if (hs.level > 0.02) {
    ensureVignette(ctx, W, H);
    if (vigGrey && vigCold) {
      ctx.save();
      ctx.globalCompositeOperation = 'saturation';
      ctx.globalAlpha = clamp(hs.level * 0.75, 0, 0.75);
      ctx.fillStyle = vigGrey;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = clamp(hs.level * 0.14, 0, 0.14) * (0.85 + 0.15 * Math.sin(engine.simTime * 2.3));
      ctx.fillStyle = vigCold;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      draws++;
    }
  }
  return draws;
}

/**
 * 跳舞女幽灵（俯视程序化剪影）：喇叭裙摆随旋转离心甩开、长发向旋转反方向甩出、一臂高举一臂外展；
 * 灰白偏青半透明，先画一层滞后相位的偏青重影（轻微色差/残影），再画本体；边缘噪点溶解。
 */
function drawDanceGhost(ctx: CanvasRenderingContext2D, g: DanceGhostState, time: number) {
  const dissolving = g.state === 'dispel';
  // 噪点溶解：整体透明度按 18Hz 噪声轻微闪烁
  const flick = 0.82 + 0.18 * hash1(Math.floor(time * 18) + g.seed);
  const base = clamp(g.alpha * flick, 0, 1);
  const swayX = Math.sin(g.sway) * 5;
  const swayY = Math.cos(g.sway * 0.7) * 3;
  const x = g.x + swayX;
  const y = g.y + swayY;

  // 偏青重影（滞后 0.45rad，右偏 1.6px）
  danceBody(ctx, x + 1.6, y + 0.4, g.spin - 0.45, g.sway, time, base * 0.3, true);
  // 本体
  danceBody(ctx, x, y, g.spin, g.sway, time, base, false);

  // 边缘噪点：14Hz 跳变的细碎颗粒；溶解时向外飘散
  const spread = dissolving ? 1 + (1 - g.fade) * 1.6 : 1;
  const frame = Math.floor(time * 14);
  ctx.globalAlpha = clamp(base * 0.55, 0, 1);
  ctx.fillStyle = 'rgb(206, 218, 220)';
  ctx.beginPath();
  for (let i = 0; i < 14; i++) {
    const ha = hash1(frame * 3.1 + i * 7.7 + g.seed) * Math.PI * 2;
    const hr = (10 + hash1(frame * 1.7 + i * 3.3 + g.seed) * 13) * spread;
    const px = x + Math.cos(ha) * hr;
    const py = y + Math.sin(ha) * hr;
    ctx.rect(px, py, 1.3, 1.3);
  }
  ctx.fill();
  ctx.globalAlpha = 1;
}

function danceBody(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  spin: number,
  sway: number,
  time: number,
  alpha: number,
  echo: boolean
) {
  if (alpha <= 0.002) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(spin);
  const flare = 0.55 + 0.45 * Math.sin(sway * 1.3);

  // 裙摆：14 点波浪轮廓，离心甩开
  ctx.globalAlpha = alpha * 0.36;
  ctx.fillStyle = echo ? 'rgb(132, 180, 194)' : 'rgb(166, 184, 188)';
  ctx.beginPath();
  for (let k = 0; k < 14; k++) {
    const ang = (k / 14) * Math.PI * 2;
    const r = 11.5 + flare * 5 + Math.sin(ang * 3 + time * 4.2) * 2.2 + Math.sin(ang * 5 - time * 2.6) * 1.1;
    const px = Math.cos(ang) * r;
    const py = Math.sin(ang) * r * 0.92;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  if (!echo) {
    // 衬裙内层
    ctx.globalAlpha = alpha * 0.46;
    ctx.fillStyle = 'rgb(194, 206, 208)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 8, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // 手臂：一臂高举、一臂外展（随摇摆起伏）
    const arm = Math.sin(sway) * 2;
    ctx.globalAlpha = alpha * 0.55;
    ctx.strokeStyle = 'rgb(200, 212, 214)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.quadraticCurveTo(6, -10 - arm, 13, -7 - arm);
    ctx.moveTo(0, 4);
    ctx.quadraticCurveTo(-5, 9 + arm, -11, 12 + arm);
    ctx.stroke();
  }

  // 长发：向旋转反方向甩出 6 缕
  ctx.globalAlpha = alpha * (echo ? 0.5 : 0.62);
  ctx.strokeStyle = echo ? 'rgb(96, 132, 142)' : 'rgb(74, 88, 94)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let s = 0; s < 6; s++) {
    const a = Math.PI * 0.82 + s * 0.13 + Math.sin(time * 3 + s) * 0.12;
    const len = 12 + (s % 3) * 3 + flare * 5;
    ctx.moveTo(1, 0);
    ctx.quadraticCurveTo(
      1 + Math.cos(a - 0.45) * len * 0.55,
      Math.sin(a - 0.45) * len * 0.55,
      1 + Math.cos(a) * len,
      Math.sin(a) * len
    );
  }
  ctx.stroke();

  // 头
  ctx.globalAlpha = alpha * (echo ? 0.5 : 0.78);
  ctx.fillStyle = echo ? 'rgb(150, 192, 204)' : 'rgb(208, 218, 220)';
  ctx.beginPath();
  ctx.arc(1, 0, 4.1, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** 一闪而逝：人形剪影（俯视：肩+头+拉长的残影）或面孔残像；闪电劈照时为暗色剪影 */
function drawApparition(ctx: CanvasRenderingContext2D, a: ApparitionState, flash: number, time: number) {
  const dark = a.byLightning || flash > 0.3;
  const al = clamp(a.alpha, 0, 1);
  ctx.save();
  ctx.translate(a.x, a.y);
  if (a.kind === 'face') {
    // 面孔残像（屏幕正立，色差双影）
    const jx = (hash1(Math.floor(time * 30) + a.seed) - 0.5) * 1.2;
    ctx.globalAlpha = al * 0.35;
    ctx.fillStyle = 'rgb(140, 186, 198)';
    ctx.beginPath();
    ctx.ellipse(1.4 + jx, 0, 5.2, 6.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = al * 0.72;
    ctx.fillStyle = dark ? 'rgb(30, 32, 34)' : 'rgb(198, 204, 200)';
    ctx.beginPath();
    ctx.ellipse(jx, 0, 5, 6.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = al * 0.9;
    ctx.fillStyle = dark ? 'rgb(190, 196, 194)' : 'rgb(10, 11, 12)';
    ctx.beginPath();
    ctx.ellipse(jx - 1.9, -1.3, 1.1, 1.5, 0, 0, Math.PI * 2);
    ctx.moveTo(jx + 3.0, -1.3);
    ctx.ellipse(jx + 1.9, -1.3, 1.1, 1.5, 0, 0, Math.PI * 2);
    ctx.moveTo(jx + 1.0, 3.2);
    ctx.ellipse(jx, 3.2, 1.0, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.rotate(a.angle);
    // 拉长的运动残影（向背离玩家方向拖尾）
    ctx.globalAlpha = al * 0.28;
    ctx.fillStyle = dark ? 'rgb(10, 12, 14)' : 'rgb(150, 176, 184)';
    ctx.beginPath();
    ctx.ellipse(-7, 0, 9, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    // 肩
    ctx.globalAlpha = al * (dark ? 0.9 : 0.6);
    ctx.fillStyle = dark ? 'rgb(12, 14, 16)' : 'rgb(178, 192, 196)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 4.6, 8.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // 头 + 垂发
    ctx.globalAlpha = al * (dark ? 0.95 : 0.7);
    ctx.fillStyle = dark ? 'rgb(8, 9, 10)' : 'rgb(204, 212, 214)';
    ctx.beginPath();
    ctx.arc(1.2, 0, 3.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}
