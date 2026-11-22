// 内心独白浮字绘制（R3 主美定调第 8 条）
// - 在 above-darkness overlay 阶段绘制：不受视野锥遮罩与暗化影响，Canvas2D 与 WebGL 两条路径共用（都画在主 ctx 上）。
// - 世界空间锚定：角色左上方约 75px（随角色移动），但扣除镜头震动偏移，浮字不随震屏抖动。
// - 白字 #e9e4da + 2px 近黑描边（strokeText，lineJoin round），16px，系统衬线字体栈（与 HUD --f-title 一致，零外链字体）。
// - 只读 engine.thoughts（包络 alpha / rise 由 thoughts.ts 推进）；渲染层不写任何游戏状态。
// - 零每帧分配：换行结果按"译文"缓存（键集合受文案条数约束），命中后每帧只做查表与绘制。

import type { GameEngine } from '../engine';
import { I18n } from '../i18n';
import type { ThoughtLine } from '../thoughts';
import { clamp } from '../util';

/** 字号 / 行高 / 单行最大宽度（px，CSS 像素；ctx 已按 dpr 缩放） */
const FONT_PX = 17;
const LINE_H = 22;
const MAX_W = 250;
/** 两条同时显示时的额外间隙 */
const STACK_GAP = 6;
/** 锚点：相对角色中心的左上偏移（≈ 75px） */
const ANCHOR_DX = -44;
const ANCHOR_DY = -60;
/** 屏幕安全边距 */
const SAFE = 10;
/** 主美定调：原作浮字为干净无衬线体；Windows 上宋体 16px 加描边过细，
 *  故西文优先 Georgia、中文优先微软雅黑（Windows 自带，描边后可读性好），只引用本机字体，不请求外部字体 */
const FONT =
  `500 ${FONT_PX}px Georgia, "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", ` +
  '"Noto Sans SC", "Source Han Sans SC", "Noto Serif SC", "SimSun", sans-serif';
const FILL = '#e9e4da';
const STROKE = 'rgba(7, 6, 5, 0.94)';
/** 中文行首禁则：这些符号不放在行首 */
const NO_LINE_START = '，。、？！；：…）」』”’,.?!;:)';

interface WrappedText {
  lines: string[];
  width: number;
}

const layoutCache = new Map<string, WrappedText>();

/** 换行（仅缓存未命中时执行，可分配）：按总宽均分行数，避免末行只剩一两个字 */
function layoutText(ctx: CanvasRenderingContext2D, text: string): WrappedText {
  const hit = layoutCache.get(text);
  if (hit) return hit;
  const lines: string[] = [];
  const total = ctx.measureText(text).width;
  if (total <= MAX_W) {
    lines.push(text);
  } else {
    const n = Math.ceil(total / MAX_W);
    const limit = Math.min(MAX_W, total / n + FONT_PX);
    if (text.indexOf(' ') >= 0) {
      // 英文：按词换行
      const words = text.split(' ');
      let cur = '';
      for (const w of words) {
        const next = cur ? cur + ' ' + w : w;
        if (cur && ctx.measureText(next).width > limit) {
          lines.push(cur);
          cur = w;
        } else {
          cur = next;
        }
      }
      if (cur) lines.push(cur);
    } else {
      // 中文：按字换行（行首禁则）
      let cur = '';
      for (const ch of text) {
        const next = cur + ch;
        if (cur && NO_LINE_START.indexOf(ch) < 0 && ctx.measureText(next).width > limit) {
          lines.push(cur);
          cur = ch;
        } else {
          cur = next;
        }
      }
      if (cur) lines.push(cur);
    }
  }
  let width = 0;
  for (const l of lines) width = Math.max(width, ctx.measureText(l).width);
  const out: WrappedText = { lines, width };
  layoutCache.set(text, out);
  return out;
}

/** 画一条独白（底行基线在 bottomY）；返回计入 drawCalls 的批次数 */
function drawOne(
  ctx: CanvasRenderingContext2D,
  it: ThoughtLine,
  anchorX: number,
  bottomY: number,
  W: number,
  H: number
): number {
  if (it.alpha <= 0.003) return 0;
  const wrapped = layoutText(ctx, I18n.t(it.key));
  const n = wrapped.lines.length;
  if (n === 0) return 0;
  const half = wrapped.width * 0.5;
  const x = Math.round(W > half * 2 + SAFE * 2 ? clamp(anchorX, SAFE + half, W - SAFE - half) : W * 0.5);
  let yBottom = bottomY - it.rise;
  const top = yBottom - (n - 1) * LINE_H - FONT_PX;
  if (top < SAFE) yBottom += SAFE - top;
  if (yBottom > H - SAFE) yBottom = H - SAFE;
  const y0 = Math.round(yBottom - (n - 1) * LINE_H);
  ctx.globalAlpha = clamp(it.alpha, 0, 1);
  // 先描边全部行，再填充全部行（避免下一行描边压住上一行字面）
  for (let i = 0; i < n; i++) ctx.strokeText(wrapped.lines[i], x, y0 + i * LINE_H);
  for (let i = 0; i < n; i++) ctx.fillText(wrapped.lines[i], x, y0 + i * LINE_H);
  return 1;
}

/** 文本块高度（用于两条同时显示时上下错开） */
function blockHeight(ctx: CanvasRenderingContext2D, it: ThoughtLine): number {
  return layoutText(ctx, I18n.t(it.key)).lines.length * LINE_H + STACK_GAP;
}

/**
 * renderer 在 above-darkness 阶段（haunts overlay 之后）一行调用。
 * viewL / viewT 为含镜头震动的视口左上角；这里扣除震动偏移，使浮字稳定锚定在世界中。
 */
export function drawThoughts(
  ctx: CanvasRenderingContext2D,
  engine: GameEngine,
  viewL: number,
  viewT: number,
  W: number,
  H: number
): number {
  if (engine.mode !== 'play' && engine.mode !== 'hold') return 0;
  const items = engine.thoughts.items;
  let newest: ThoughtLine | null = null;
  let older: ThoughtLine | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.active || it.alpha <= 0.003) continue;
    if (!newest || it.order > newest.order) {
      older = newest;
      newest = it;
    } else if (!older || it.order > older.order) {
      older = it;
    }
  }
  if (!newest) return 0;

  const p = engine.player;
  const ax = p.x + ANCHOR_DX - (viewL - engine.shakeOffsetX);
  const ay = p.y + ANCHOR_DY - (viewT - engine.shakeOffsetY);
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return 0;

  ctx.save();
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4; // 描边居中于字形轮廓：4px 线宽 = 字外 2px 近黑描边
  ctx.strokeStyle = STROKE;
  ctx.fillStyle = FILL;
  let draws = drawOne(ctx, newest, ax, ay, W, H);
  if (older) {
    // 较早的一条在上方；随新句淡入平滑让位（不跳变）
    const k = clamp(newest.alpha, 0, 1);
    const lift = blockHeight(ctx, newest) * k * k * (3 - 2 * k);
    draws += drawOne(ctx, older, ax, ay - lift, W, H);
  }
  ctx.restore();
  return draws;
}
