// 原作《Darkwood》风格地表场景物件程序化渲染：
// 包含盘根老树墩、残破木板桥、荒废茶田垄、木栅栏小地窖、旧独轮手推车与散落原木堆。
// 全部采用确定性伪随机绘制，零运行时对象分配，仅计为 1 次批处理 drawCall。

import { WorldProp } from '../types';
import { createRng } from '../util';

/** 批量绘制视野内的原作地表景观物件，返回计入 drawCalls 的批次数（0 或 1） */
export function drawWorldProps(
  ctx: CanvasRenderingContext2D,
  props: WorldProp[],
  viewL: number,
  viewT: number,
  viewR: number,
  viewB: number,
  time = 0,
  playerX = 0,
  playerY = 0,
  seesawActivity?: Map<number, number>
): number {
  let drawn = 0;
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    const pad = Math.max(p.w, p.h) * 0.95 + 72;
    if (p.x < viewL - pad || p.x > viewR + pad || p.y < viewT - pad || p.y > viewB + pad) continue;
    drawn++;
    switch (p.kind) {
      case 'groundPatch':
        drawGroundPatch(ctx, p);
        break;
      case 'teaField':
        drawTeaField(ctx, p);
        break;
      case 'bridge':
        drawBrokenBridge(ctx, p);
        break;
      case 'groundCable':
        drawGroundCable(ctx, p);
        break;
      case 'cellar':
        drawCellarEntrance(ctx, p);
        break;
      case 'brokenFence':
        drawBrokenFence(ctx, p);
        break;
      case 'houseStakes':
        drawHouseStakes(ctx, p);
        break;
      case 'stump':
        drawRootedStump(ctx, p);
        break;
      case 'tent':
        drawAbandonedTent(ctx, p);
        break;
      case 'campfire':
        drawWildCampfire(ctx, p, time);
        break;
      case 'wheelbarrow':
        drawWheelbarrow(ctx, p);
        break;
      case 'fallenLog':
        drawFallenLogs(ctx, p);
        break;
      case 'writhingCorpse':
        drawWrithingCorpse(ctx, p, time);
        break;
      case 'chainedDog':
        drawChainedDog(ctx, p, time, playerX, playerY);
        break;
      case 'seesaw':
        drawSeesaw(ctx, p, time, seesawActivity?.get(p.id) ?? 1);
        break;
    }
  }
  return drawn > 0 ? 1 : 0;
}

/** 1. 盘根老树墩（对标原作图 3 右下、图 4 右上、图 5 左中/右下）：浅灰褐锯切截面 + 四周疯狂盘绕的黑色扭曲根须 */
function drawRootedStump(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const rng = createRng(Math.floor(p.seed * 9973) + 17);
  const r = p.w;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // 贴地柔和暗底晕
  const bg = ctx.createRadialGradient(2, 3, r * 0.4, 2, 3, r * 2.5);
  bg.addColorStop(0, 'rgba(6, 7, 6, 0.68)');
  bg.addColorStop(0.55, 'rgba(8, 9, 8, 0.28)');
  bg.addColorStop(1, 'rgba(8, 9, 8, 0)');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(2, 3, r * 2.5, 0, Math.PI * 2);
  ctx.fill();

  // 四周放射状盘绕的深黑扭曲根须（带二级细叉）
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const rootCount = Math.round(10 + r * 0.35);
  for (let i = 0; i < rootCount; i++) {
    const baseA = (i / rootCount) * Math.PI * 2 + (rng() - 0.5) * 0.34;
    const len = r * (1.2 + rng() * 1.45);
    const w0 = Math.max(1.8, r * (0.16 + rng() * 0.1));
    let x = Math.cos(baseA) * (r * 0.72);
    let y = Math.sin(baseA) * (r * 0.72);
    let a = baseA;
    for (let s = 0; s < 4; s++) {
      const t = s / 4;
      const seg = (len / 4) * (0.78 + rng() * 0.45);
      a += (rng() - 0.5) * 0.62;
      const mx = x + Math.cos(a + (rng() - 0.5) * 0.35) * seg * 0.52;
      const my = y + Math.sin(a + (rng() - 0.5) * 0.35) * seg * 0.52;
      const nx = x + Math.cos(a) * seg;
      const ny = y + Math.sin(a) * seg;
      const w = Math.max(0.7, w0 * (1 - t * 0.72));

      ctx.strokeStyle = 'rgba(7, 8, 7, 0.88)';
      ctx.lineWidth = w + 1.4;
      ctx.beginPath();
      ctx.moveTo(x + 1, y + 1.2);
      ctx.quadraticCurveTo(mx + 1, my + 1.2, nx + 0.8, ny + 1);
      ctx.stroke();

      ctx.strokeStyle = '#1b1814';
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(mx, my, nx, ny);
      ctx.stroke();

      // 次级细叉根须
      if (s >= 1 && rng() < 0.55) {
        const fa = a + (rng() > 0.5 ? 1 : -1) * (0.45 + rng() * 0.45);
        const fl = seg * (0.65 + rng() * 0.45);
        ctx.strokeStyle = 'rgba(12, 11, 10, 0.82)';
        ctx.lineWidth = Math.max(0.65, w * 0.58);
        ctx.beginPath();
        ctx.moveTo(nx, ny);
        ctx.lineTo(nx + Math.cos(fa) * fl, ny + Math.sin(fa) * fl);
        ctx.stroke();
      }
      x = nx;
      y = ny;
    }
  }

  // 深色厚树皮外圈
  ctx.fillStyle = '#14120e';
  ctx.beginPath();
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const rad = r + Math.sin(a * 5 + p.seed) * 1.4 + (rng() - 0.5) * 1.1;
    const px = Math.cos(a) * rad;
    const py = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  // 浅灰褐锯切木断面（带柔和径向层次，在手电光下清晰可读）
  const cutG = ctx.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.1, 0, 0, r * 0.88);
  cutG.addColorStop(0, '#786e5c');
  cutG.addColorStop(0.55, '#595143');
  cutG.addColorStop(0.88, '#3a342a');
  cutG.addColorStop(1, '#242019');
  ctx.fillStyle = cutG;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2);
  ctx.fill();

  // 细腻年轮与放射状干裂纹
  ctx.strokeStyle = 'rgba(32, 27, 21, 0.45)';
  ctx.lineWidth = 0.8;
  for (let k = 1; k <= 3; k++) {
    ctx.beginPath();
    ctx.arc(0, 0, r * (k * 0.23), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(18, 15, 12, 0.65)';
  ctx.lineWidth = 1.0;
  for (let k = 0; k < 3; k++) {
    const ca = rng() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(ca) * r * 0.82, Math.sin(ca) * r * 0.82);
    ctx.stroke();
  }
  ctx.restore();
}

/** 2. 残破木板桥 / 沼泽栈道（对标原作图 2 右上、图 4 底部）：参差断裂的灰褐旧木板 + 两侧圆木桩 */
function drawBrokenBridge(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const rng = createRng(Math.floor(p.seed * 7919) + 31);
  const len = p.w;
  const width = p.h;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // 桥下浅沟/泥洼湿暗影
  const ditchG = ctx.createLinearGradient(0, -width * 0.72, 0, width * 0.72);
  ditchG.addColorStop(0, 'rgba(6, 8, 7, 0)');
  ditchG.addColorStop(0.25, 'rgba(6, 8, 7, 0.42)');
  ditchG.addColorStop(0.75, 'rgba(6, 8, 7, 0.42)');
  ditchG.addColorStop(1, 'rgba(6, 8, 7, 0)');
  ctx.fillStyle = ditchG;
  ctx.fillRect(-len * 0.54, -width * 0.72, len * 1.08, width * 1.44);

  // 底部两根纵向承重腐木梁
  ctx.fillStyle = '#25211b';
  ctx.fillRect(-len * 0.48, -width * 0.34, len * 0.96, 5);
  ctx.fillRect(-len * 0.48, width * 0.34 - 5, len * 0.96, 5);

  // 横向参差铺设的残破木板（有歪斜、长短不齐、偶有缺口断板）
  const plankCount = Math.max(7, Math.floor(len / 11.5));
  const step = len / plankCount;
  for (let i = 0; i < plankCount; i++) {
    // 偶有一块完全烂掉的缺口
    if (i > 1 && i < plankCount - 2 && rng() < 0.08) continue;
    const px = -len * 0.5 + i * step + (rng() - 0.5) * 1.6;
    const pw = step * (0.72 + rng() * 0.18);
    const broken = rng() < 0.18;
    const ph = width * (broken ? 0.62 + rng() * 0.25 : 0.92 + rng() * 0.16);
    const pyOff = broken ? (rng() > 0.5 ? -width * 0.12 : width * 0.12) : (rng() - 0.5) * 4;
    const rot = (rng() - 0.5) * 0.09;

    ctx.save();
    ctx.translate(px + pw * 0.5, pyOff);
    ctx.rotate(rot);
    // 木板接触投影
    ctx.fillStyle = 'rgba(4, 5, 4, 0.58)';
    ctx.fillRect(-pw * 0.5 + 1.5, -ph * 0.5 + 2, pw, ph);
    // 做旧灰褐/冷灰木板本体（色差错落）
    const shade = Math.floor(rng() * 3);
    ctx.fillStyle = shade === 0 ? '#5c5548' : shade === 1 ? '#4d473c' : '#686051';
    ctx.strokeStyle = '#191713';
    ctx.lineWidth = 1.0;
    ctx.fillRect(-pw * 0.5, -ph * 0.5, pw, ph);
    ctx.strokeRect(-pw * 0.5, -ph * 0.5, pw, ph);
    // 木纹裂隙与铁钉点
    ctx.strokeStyle = 'rgba(24, 21, 17, 0.45)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(0, -ph * 0.44);
    ctx.lineTo((rng() - 0.5) * 1.5, ph * 0.44);
    ctx.stroke();
    ctx.fillStyle = '#1b1916';
    ctx.fillRect(-0.8, -ph * 0.34, 1.6, 1.6);
    ctx.fillRect(-0.8, ph * 0.34 - 1.6, 1.6, 1.6);
    ctx.restore();
  }

  // 桥侧粗糙圆木桩
  const postCount = Math.max(3, Math.floor(len / 46) + 1);
  for (let i = 0; i < postCount; i++) {
    const px = -len * 0.46 + (i / Math.max(1, postCount - 1)) * (len * 0.92);
    for (const side of [-1, 1]) {
      if (rng() < 0.15) continue;
      const py = side * (width * 0.5 + 3);
      ctx.fillStyle = 'rgba(5, 6, 5, 0.55)';
      ctx.beginPath();
      ctx.arc(px + 1.5, py + 2, 4.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3c352b';
      ctx.strokeStyle = '#12100d';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(px, py, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#746a58';
      ctx.beginPath();
      ctx.arc(px - 0.4, py - 0.4, 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** 3. 荒废茶田 / 枯萎低矮灌木农田垄（对标原作图 5 左侧）：平行整齐又腐朽毛糙的深暗灌木排与泥土沟 */
function drawTeaField(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const rng = createRng(Math.floor(p.seed * 6151) + 53);
  const w = p.w;
  const h = p.h;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // 农田翻耕浅暗泥地底色
  ctx.fillStyle = 'rgba(26, 24, 19, 0.34)';
  ctx.fillRect(-w * 0.5, -h * 0.5, w, h);

  const rowSpacing = 28;
  const rows = Math.max(3, Math.floor(w / rowSpacing));
  const startX = -((rows - 1) * rowSpacing) * 0.5;

  for (let r = 0; r < rows; r++) {
    const rx = startX + r * rowSpacing;
    // 垄底深泥影沟
    ctx.strokeStyle = 'rgba(10, 11, 9, 0.48)';
    ctx.lineWidth = 13;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(rx + 2, -h * 0.46);
    ctx.lineTo(rx + 2, h * 0.46);
    ctx.stroke();

    // 每排由一团团紧挨的腐朽低矮茶树/灌木丛组成（偶尔中间枯死一截露出泥沟）
    const bushStep = 14;
    const count = Math.floor((h * 0.92) / bushStep);
    for (let j = 0; j < count; j++) {
      if (rng() < 0.14) continue;
      const by = -h * 0.45 + j * bushStep + (rng() - 0.5) * 4;
      const bx = rx + (rng() - 0.5) * 3.5;
      const br = 7.5 + rng() * 5.2;

      // 贴地投影
      ctx.fillStyle = 'rgba(6, 7, 6, 0.52)';
      ctx.beginPath();
      ctx.ellipse(bx + 2, by + 2.2, br * 1.05, br * 0.85, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();

      // 深墨暗褐/枯绿毛糙叶团（4~6 个重叠小叶簇模拟锯齿毛边）
      const lobes = 5;
      for (let l = 0; l < lobes; l++) {
        const la = (l / lobes) * Math.PI * 2 + rng() * 0.9;
        const ld = br * (0.25 + rng() * 0.42);
        const lx = bx + Math.cos(la) * ld;
        const ly = by + Math.sin(la) * ld;
        const lr = br * (0.42 + rng() * 0.34);
        ctx.fillStyle = l % 2 === 0 ? 'rgba(26, 29, 22, 0.88)' : 'rgba(38, 39, 29, 0.78)';
        ctx.beginPath();
        ctx.ellipse(lx, ly, lr, lr * 0.72, la, 0, Math.PI * 2);
        ctx.fill();
      }
      // 顶层细微枯灰叶尖高光
      ctx.fillStyle = 'rgba(84, 82, 66, 0.32)';
      ctx.beginPath();
      ctx.arc(bx - 1.2, by - 1.2, br * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** 4. 木栅栏围起的小地窖入口（对标原作图 5 右上） */
function drawCellarEntrance(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const rng = createRng(Math.floor(p.seed * 4517) + 89);
  const s = p.w; // 围栏边长约 78px
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // 围栏内下凹土坡影
  const pitG = ctx.createRadialGradient(0, 0, s * 0.1, 0, 0, s * 0.65);
  pitG.addColorStop(0, 'rgba(10, 10, 9, 0.55)');
  pitG.addColorStop(1, 'rgba(10, 10, 9, 0.14)');
  ctx.fillStyle = pitG;
  ctx.fillRect(-s * 0.5, -s * 0.5, s, s);

  // 四周粗糙原木短围栏
  ctx.strokeStyle = '#181512';
  ctx.lineWidth = 4.2;
  ctx.strokeRect(-s * 0.5, -s * 0.5, s, s);
  ctx.strokeStyle = '#554d40';
  ctx.lineWidth = 2.0;
  ctx.strokeRect(-s * 0.5, -s * 0.5, s, s);
  // 围栏角桩与边桩
  for (let i = 0; i <= 4; i++) {
    const o = -s * 0.5 + (i / 4) * s;
    for (const [px, py] of [
      [o, -s * 0.5],
      [o, s * 0.5],
      [-s * 0.5, o],
      [s * 0.5, o],
    ]) {
      ctx.fillStyle = '#332d24';
      ctx.beginPath();
      ctx.arc(px + (rng() - 0.5) * 1.2, py + (rng() - 0.5) * 1.2, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 居中地窖木屋顶棚与向下石阶
  const rw = s * 0.36;
  const rh = s * 0.44;
  ctx.fillStyle = 'rgba(5, 6, 5, 0.68)';
  ctx.fillRect(-rw * 0.5 + 3, -rh * 0.5 + 4, rw, rh);
  // 坡顶木板棚
  ctx.fillStyle = '#5f594c';
  ctx.strokeStyle = '#14120f';
  ctx.lineWidth = 1.4;
  ctx.fillRect(-rw * 0.5, -rh * 0.5, rw, rh * 0.68);
  ctx.strokeRect(-rw * 0.5, -rh * 0.5, rw, rh * 0.68);
  // 屋脊中线与木板缝
  ctx.strokeStyle = 'rgba(20, 18, 14, 0.62)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, -rh * 0.5);
  ctx.lineTo(0, -rh * 0.5 + rh * 0.68);
  ctx.stroke();
  // 下行入口台阶（三阶渐暗）
  for (let st = 0; st < 3; st++) {
    const sy = rh * 0.18 + st * 4.2;
    ctx.fillStyle = st === 0 ? '#4b463d' : st === 1 ? '#36322b' : '#211e1a';
    ctx.fillRect(-rw * 0.42, sy, rw * 0.84, 3.6);
  }
  ctx.restore();
}

/** 5. 生锈旧铁皮独轮手推车（对标原作图 4 右下） */
function drawWheelbarrow(ctx: CanvasRenderingContext2D, p: WorldProp) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // 贴地投影
  ctx.fillStyle = 'rgba(5, 6, 5, 0.54)';
  ctx.beginPath();
  ctx.ellipse(2, 3, 18, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  // 前轮
  ctx.fillStyle = '#1e1d1a';
  ctx.fillRect(14, -2.5, 7, 5);
  // 两根木推柄
  ctx.strokeStyle = '#5e4c38';
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-20, -6.5);
  ctx.lineTo(14, -3);
  ctx.moveTo(-20, 6.5);
  ctx.lineTo(14, 3);
  ctx.stroke();

  // 倾斜梯形旧铁皮车斗
  ctx.fillStyle = '#4e504b';
  ctx.strokeStyle = '#181816';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-10, -10.5);
  ctx.lineTo(13, -8);
  ctx.lineTo(13, 8);
  ctx.lineTo(-10, 10.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 车斗内部暗影与锈斑
  ctx.fillStyle = 'rgba(22, 22, 20, 0.52)';
  ctx.beginPath();
  ctx.moveTo(-7, -7.8);
  ctx.lineTo(10, -5.8);
  ctx.lineTo(10, 5.8);
  ctx.lineTo(-7, 7.8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(110, 62, 36, 0.35)';
  ctx.beginPath();
  ctx.ellipse(1, 2, 5, 3.2, 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 6. 散落断木与伐木原木堆（对标原作图 4 左下、图 5 右下） */
function drawFallenLogs(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const rng = createRng(Math.floor(p.seed * 8291) + 41);
  const count = Math.max(2, Math.round(p.h));
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  for (let i = 0; i < count; i++) {
    const lx = (rng() - 0.5) * p.w;
    const ly = (rng() - 0.5) * p.w * 0.7;
    const la = (rng() - 0.5) * Math.PI;
    const logLen = 18 + rng() * 24;
    const logR = 3.2 + rng() * 3.0;

    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(la);
    // 接触影
    ctx.fillStyle = 'rgba(5, 6, 5, 0.52)';
    ctx.fillRect(-logLen * 0.5 + 1.5, -logR + 2, logLen, logR * 2);
    // 树皮木身
    const lg = ctx.createLinearGradient(0, -logR, 0, logR);
    lg.addColorStop(0, '#625849');
    lg.addColorStop(0.55, '#3e372d');
    lg.addColorStop(1, '#1e1b16');
    ctx.fillStyle = lg;
    ctx.strokeStyle = '#12100d';
    ctx.lineWidth = 1.0;
    ctx.fillRect(-logLen * 0.5, -logR, logLen, logR * 2);
    ctx.strokeRect(-logLen * 0.5, -logR, logLen, logR * 2);
    // 浅色木锯口端面
    ctx.fillStyle = '#7e735f';
    ctx.beginPath();
    ctx.ellipse(logLen * 0.5, 0, logR * 0.42, logR * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** 7. 坑坑洼洼、颜色不一的多生态地表斑块（0:湿黑泥洼坑 1:枯黄荒草地 2:干裂黄土地 3:腐叶暗泥坑） */
function drawGroundPatch(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const rng = createRng(Math.floor(p.seed * 7331) + 19);
  const r = p.w * 0.5;
  const kind = Math.round(p.h) % 4;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // 2~3 个重叠的不规则有机斑块，打破平坦单调地面
  const lobes = 3;
  for (let i = 0; i < lobes; i++) {
    const ox = (rng() - 0.5) * r * 0.7;
    const oy = (rng() - 0.5) * r * 0.55;
    const rx = r * (0.55 + rng() * 0.45);
    const ry = r * (0.38 + rng() * 0.36);
    const g = ctx.createRadialGradient(ox, oy, rx * 0.12, ox, oy, rx);
    if (kind === 0) {
      // 湿黑泥洼积水坑（内凹暗湿反光）
      g.addColorStop(0, 'rgba(18, 22, 20, 0.54)');
      g.addColorStop(0.6, 'rgba(28, 30, 26, 0.28)');
      g.addColorStop(1, 'rgba(28, 30, 26, 0)');
    } else if (kind === 1) {
      // 枯黄荒草地斑块
      g.addColorStop(0, 'rgba(84, 86, 52, 0.36)');
      g.addColorStop(0.65, 'rgba(66, 70, 44, 0.18)');
      g.addColorStop(1, 'rgba(66, 70, 44, 0)');
    } else if (kind === 2) {
      // 干裂赤褐黄土地
      g.addColorStop(0, 'rgba(92, 74, 52, 0.34)');
      g.addColorStop(0.62, 'rgba(68, 56, 40, 0.16)');
      g.addColorStop(1, 'rgba(68, 56, 40, 0)');
    } else {
      // 腐叶湿暗泥坑
      g.addColorStop(0, 'rgba(26, 22, 16, 0.46)');
      g.addColorStop(0.6, 'rgba(42, 36, 26, 0.22)');
      g.addColorStop(1, 'rgba(42, 36, 26, 0)');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(ox, oy, rx, ry, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // 泥洼坑内加 1~2 个小水坑凹槽与草簇笔触
  if (kind === 0 || kind === 3) {
    ctx.strokeStyle = 'rgba(10, 12, 11, 0.36)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.46, r * 0.28, 0.2, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === 1) {
    ctx.strokeStyle = 'rgba(110, 108, 68, 0.32)';
    ctx.lineWidth = 1.0;
    for (let k = 0; k < 6; k++) {
      const gx = (rng() - 0.5) * r;
      const gy = (rng() - 0.5) * r * 0.7;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + (rng() - 0.5) * 6, gy - 4 - rng() * 5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** 8. 破败木围栏（歪斜断裂木桩列 + 残缺横木条与通行缺口） */
function drawBrokenFence(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const rng = createRng(Math.floor(p.seed * 6827) + 11);
  const len = p.w;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  const posts = Math.max(4, Math.floor(len / 22));
  const step = len / posts;
  const xs: number[] = [];
  for (let i = 0; i <= posts; i++) {
    // 偶有一处断裂缺口
    if (i > 1 && i < posts - 1 && rng() < 0.2) continue;
    xs.push(-len * 0.5 + i * step + (rng() - 0.5) * 3);
  }
  // 残缺横木条（贴地投影 + 做旧木条）
  for (let i = 0; i < xs.length - 1; i++) {
    if (xs[i + 1] - xs[i] > step * 1.55) continue;
    const tilt = (rng() - 0.5) * 3.5;
    ctx.strokeStyle = 'rgba(5, 6, 5, 0.55)';
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.moveTo(xs[i] + 2, 2.5);
    ctx.lineTo(xs[i + 1] + 2, 2.5 + tilt);
    ctx.stroke();

    ctx.strokeStyle = '#4e4538';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(xs[i], 0);
    ctx.lineTo(xs[i + 1], tilt);
    ctx.stroke();
  }
  // 歪斜圆木桩
  for (let i = 0; i < xs.length; i++) {
    const px = xs[i];
    const py = (rng() - 0.5) * 2.5;
    ctx.fillStyle = 'rgba(5, 6, 5, 0.58)';
    ctx.beginPath();
    ctx.arc(px + 2, py + 2.5, 3.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#332c23';
    ctx.strokeStyle = '#110f0c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#736855';
    ctx.beginPath();
    ctx.arc(px - 0.4, py - 0.4, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 9. 房子周围散落的矮木桩与残破木板堆 */
function drawHouseStakes(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const rng = createRng(Math.floor(p.seed * 5297) + 23);
  const cnt = Math.max(3, Math.round(p.h));
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  for (let i = 0; i < cnt; i++) {
    const sx = (i / Math.max(1, cnt - 1) - 0.5) * p.w + (rng() - 0.5) * 6;
    const sy = (rng() - 0.5) * 12;
    if (rng() < 0.45) {
      // 散落短木板
      const bl = 12 + rng() * 14;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate((rng() - 0.5) * 0.8);
      ctx.fillStyle = 'rgba(5, 6, 5, 0.46)';
      ctx.fillRect(-bl * 0.5 + 1.5, -1.5, bl, 4.2);
      ctx.fillStyle = '#534a3c';
      ctx.fillRect(-bl * 0.5, -2, bl, 3.6);
      ctx.restore();
    } else {
      // 矮木桩
      const r = 2.6 + rng() * 2.0;
      ctx.fillStyle = 'rgba(5, 6, 5, 0.55)';
      ctx.beginPath();
      ctx.arc(sx + 1.5, sy + 2, r + 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3a3227';
      ctx.strokeStyle = '#12100d';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#756a58';
      ctx.beginPath();
      ctx.arc(sx - 0.3, sy - 0.3, r * 0.48, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** 10. 废弃破旧帆布露营帐篷（军绿/灰褐破损篷布 + 缆绳地钉 + 篷口杂物） */
function drawAbandonedTent(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const w = p.w;
  const h = p.h;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // 帐篷投影
  ctx.fillStyle = 'rgba(4, 5, 4, 0.62)';
  ctx.beginPath();
  ctx.roundRect(-w * 0.5 + 4, -h * 0.5 + 5, w, h, 4);
  ctx.fill();

  // 四角绷紧的旧缆绳与地钉
  ctx.strokeStyle = 'rgba(130, 122, 102, 0.45)';
  ctx.lineWidth = 1.0;
  for (const [cx, cy, ox, oy] of [
    [-w * 0.48, -h * 0.48, -w * 0.64, -h * 0.64],
    [w * 0.48, -h * 0.48, w * 0.64, -h * 0.64],
    [-w * 0.48, h * 0.48, -w * 0.64, h * 0.64],
    [w * 0.48, h * 0.48, w * 0.64, h * 0.64],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ox, oy);
    ctx.stroke();
    ctx.fillStyle = '#25221c';
    ctx.beginPath();
    ctx.arc(ox, oy, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // 褪色军绿/灰褐帆布双坡顶
  const gTop = ctx.createLinearGradient(0, -h * 0.5, 0, 0);
  gTop.addColorStop(0, '#363c30');
  gTop.addColorStop(1, '#585f4b');
  ctx.fillStyle = gTop;
  ctx.fillRect(-w * 0.5, -h * 0.5, w, h * 0.5);

  const gBot = ctx.createLinearGradient(0, 0, 0, h * 0.5);
  gBot.addColorStop(0, '#4c5241');
  gBot.addColorStop(1, '#262b22');
  ctx.fillStyle = gBot;
  ctx.fillRect(-w * 0.5, 0, w, h * 0.5);

  ctx.strokeStyle = '#131510';
  ctx.lineWidth = 1.6;
  ctx.strokeRect(-w * 0.5, -h * 0.5, w, h);

  // 帐篷顶脊与翻开的漆黑门帘缺口
  ctx.strokeStyle = '#7e816b';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(-w * 0.5, 0);
  ctx.lineTo(w * 0.48, 0);
  ctx.stroke();

  // 右侧掀开的帐篷口暗影 + 破补丁
  ctx.fillStyle = 'rgba(8, 9, 8, 0.82)';
  ctx.beginPath();
  ctx.moveTo(w * 0.5, -h * 0.28);
  ctx.lineTo(w * 0.32, 0);
  ctx.lineTo(w * 0.5, h * 0.28);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(98, 72, 46, 0.42)';
  ctx.fillRect(-w * 0.24, -h * 0.34, 12, 8);
  ctx.restore();
}

/** 11. 荒野石圈火堆（h=1 仍在微弱燃烧跳动火星；h=0 已熄灭焦灰堆） */
function drawWildCampfire(ctx: CanvasRenderingContext2D, p: WorldProp, time: number) {
  const rng = createRng(Math.floor(p.seed * 3793) + 7);
  const r = p.w * 0.5;
  const lit = p.h > 0.5;
  ctx.save();
  ctx.translate(p.x, p.y);

  // 焦黑灰烬底圈
  const ashG = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.45);
  ashG.addColorStop(0, 'rgba(12, 11, 10, 0.85)');
  ashG.addColorStop(0.65, 'rgba(26, 23, 20, 0.42)');
  ashG.addColorStop(1, 'rgba(26, 23, 20, 0)');
  ctx.fillStyle = ashG;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.45, 0, Math.PI * 2);
  ctx.fill();

  // 一圈焦黑围石
  const stones = 9;
  for (let i = 0; i < stones; i++) {
    const a = (i / stones) * Math.PI * 2 + (rng() - 0.5) * 0.24;
    const sx = Math.cos(a) * r;
    const sy = Math.sin(a) * r;
    ctx.fillStyle = i % 2 === 0 ? '#3f3d37' : '#2c2b27';
    ctx.strokeStyle = '#11100e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(sx, sy, 3.6 + rng() * 1.8, 2.8 + rng() * 1.4, a, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // 交叉焦炭木柴
  ctx.strokeStyle = '#211914';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = p.angle + (i / 4) * Math.PI + (rng() - 0.5) * 0.3;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * -r * 0.72, Math.sin(a) * -r * 0.72);
    ctx.lineTo(Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72);
    ctx.stroke();
  }

  if (lit) {
    const fl = 0.82 + Math.sin(time * 14 + p.seed) * 0.16 + Math.cos(time * 27 + p.seed) * 0.08;
    const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, r * 2.2 * fl);
    glow.addColorStop(0, 'rgba(255, 168, 56, 0.55)');
    glow.addColorStop(0.5, 'rgba(220, 74, 22, 0.22)');
    glow.addColorStop(1, 'rgba(180, 40, 10, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.2 * fl, 0, Math.PI * 2);
    ctx.fill();

    // 跃动余烬火舌
    ctx.fillStyle = 'rgba(235, 84, 24, 0.88)';
    ctx.beginPath();
    ctx.arc(Math.sin(time * 16 + p.seed) * 1.5, Math.cos(time * 19 + p.seed) * 1.5, 4.8 * fl, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 226, 148, 0.94)';
    ctx.beginPath();
    ctx.arc(0, 0, 2.4 * fl, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 12. 地面盘绕散布的黑色旧电线（带微弱橡胶反光） */
function drawGroundCable(ctx: CanvasRenderingContext2D, p: WorldProp) {
  const rng = createRng(Math.floor(p.seed * 9137) + 3);
  const len = p.w;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const segs = 5;
  const pts: Array<[number, number]> = [[0, 0]];
  let cx = 0;
  let cy = 0;
  for (let i = 1; i <= segs; i++) {
    cx += (len / segs) * (0.85 + rng() * 0.3);
    cy += (rng() - 0.5) * 34;
    pts.push([cx, cy]);
  }
  const trace = (ox: number, oy: number) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy);
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i - 1][0] + pts[i][0]) * 0.5 + ox;
      const my = (pts[i - 1][1] + pts[i][1]) * 0.5 + oy + (i % 2 === 0 ? 7 : -7);
      ctx.quadraticCurveTo(mx, my, pts[i][0] + ox, pts[i][1] + oy);
    }
    ctx.stroke();
  };
  ctx.strokeStyle = 'rgba(4, 5, 4, 0.55)';
  ctx.lineWidth = 3.2;
  trace(1.2, 1.6);
  ctx.strokeStyle = '#17191a';
  ctx.lineWidth = 2.0;
  trace(0, 0);
  ctx.strokeStyle = 'rgba(92, 98, 102, 0.28)';
  ctx.lineWidth = 0.7;
  trace(-0.4, -0.4);
  ctx.restore();
}

/** 13. 被苍蝇环绕、会缓慢蠕动抽搐的异化尸体（野外或屋内房间） */
function drawWrithingCorpse(ctx: CanvasRenderingContext2D, p: WorldProp, time: number) {
  const r = p.w * 0.5;
  // 诡异缓慢蠕动 + 偶发高频神经抽搐
  const pulse = Math.sin(time * 2.6 + p.seed) * 0.11;
  const twitch = Math.sin(time * 17.3 + p.seed * 2) > 0.88 ? Math.sin(time * 52) * 0.08 : 0;
  const sx = 1 + pulse + twitch;
  const sy = 1 - pulse * 0.85 + twitch * 0.5;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // 暗红发黑血污与渗液
  const stain = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.9);
  stain.addColorStop(0, 'rgba(48, 14, 12, 0.72)');
  stain.addColorStop(0.55, 'rgba(30, 11, 10, 0.36)');
  stain.addColorStop(1, 'rgba(20, 8, 8, 0)');
  ctx.fillStyle = stain;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.9, 0, Math.PI * 2);
  ctx.fill();

  // 畸形蠕动肉块与纠缠菌丝触须
  ctx.save();
  ctx.scale(sx, sy);
  ctx.strokeStyle = '#151210';
  ctx.lineWidth = 1.6;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + p.seed;
    const wiggle = Math.sin(time * 3.8 + i * 1.7 + p.seed) * 3.2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4);
    ctx.quadraticCurveTo(
      Math.cos(a) * r * 0.95 + wiggle,
      Math.sin(a) * r * 0.95 - wiggle,
      Math.cos(a) * r * 1.35,
      Math.sin(a) * r * 1.35
    );
    ctx.stroke();
  }
  // 惨白发青腐肉躯干 + 暗红肉瘤
  ctx.fillStyle = '#4e4841';
  ctx.strokeStyle = '#161210';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.ellipse(-2, 0, r * 0.92, r * 0.62, 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#6b2c25';
  ctx.beginPath();
  ctx.ellipse(3.5, -1.5, r * 0.46, r * 0.34, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#7e7466';
  ctx.beginPath();
  ctx.arc(-r * 0.55, 1.5, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 8 只黑色苍蝇沿不规则 8 字轨迹嗡嗡盘旋
  ctx.fillStyle = '#080909';
  for (let f = 0; f < 8; f++) {
    const ph = time * (4.2 + (f % 3) * 1.3) + f * 2.1 + p.seed;
    const fx = Math.cos(ph) * (r * 0.65 + (f % 4) * 4.5);
    const fy = Math.sin(ph * 1.65) * (r * 0.55 + ((f + 1) % 3) * 4.2);
    ctx.fillRect(fx - 0.9, fy - 0.9, 1.8, 1.8);
  }
  ctx.restore();
}

/** 14. 被铁链拴着的恶犬（平时绕桩焦躁踱步，玩家靠近猛然绷直铁链朝玩家扑扯狂吠！） */
function drawChainedDog(ctx: CanvasRenderingContext2D, p: WorldProp, time: number, playerX: number, playerY: number) {
  const chainMax = p.w; // 约 62px
  const dxP = playerX - p.x;
  const dyP = playerY - p.y;
  const dP = Math.hypot(dxP, dyP);
  const aggro = dP < 235;

  let dogX = p.x;
  let dogY = p.y;
  let dogAng = p.angle;
  let taut = 0;

  if (aggro && dP > 1) {
    // 玩家靠近：恶犬猛然绷直铁链朝玩家方向扑扯震颤！
    const toAng = Math.atan2(dyP, dxP);
    const lunge = 0.86 + 0.14 * Math.abs(Math.sin(time * 15 + p.seed));
    const reach = Math.min(chainMax, Math.max(24, dP - 38)) * lunge;
    const jitter = Math.sin(time * 36 + p.seed) * 1.8;
    dogX = p.x + Math.cos(toAng) * reach - Math.sin(toAng) * jitter;
    dogY = p.y + Math.sin(toAng) * reach + Math.cos(toAng) * jitter;
    dogAng = toAng;
    taut = 1;
  } else {
    // 平时：在铁链范围内焦躁绕桩踱步
    const patrolAng = time * 0.65 + p.seed;
    const r = chainMax * (0.48 + 0.18 * Math.sin(time * 1.3 + p.seed));
    dogX = p.x + Math.cos(patrolAng) * r;
    dogY = p.y + Math.sin(patrolAng) * r;
    dogAng = patrolAng + Math.PI * 0.5;
  }

  ctx.save();
  // 1) 拴狗粗木桩
  ctx.fillStyle = 'rgba(5, 6, 5, 0.62)';
  ctx.beginPath();
  ctx.arc(p.x + 2, p.y + 2.5, 6.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3c3328';
  ctx.strokeStyle = '#12100d';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 5.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 2) 物理铁链（平时略微弯曲垂地，扑扯时绷得笔直！）
  const midX = (p.x + dogX) * 0.5 + (1 - taut) * Math.sin(time * 2 + p.seed) * 9;
  const midY = (p.y + dogY) * 0.5 + (1 - taut) * 10;
  ctx.strokeStyle = 'rgba(5, 6, 5, 0.55)';
  ctx.lineWidth = 3.0;
  ctx.beginPath();
  ctx.moveTo(p.x + 1, p.y + 1.5);
  ctx.quadraticCurveTo(midX + 1, midY + 1.5, dogX + 1, dogY + 1.5);
  ctx.stroke();

  ctx.strokeStyle = taut > 0.5 ? '#7c8284' : '#585d5e';
  ctx.lineWidth = 1.8;
  ctx.setLineDash([4, 2.5]);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.quadraticCurveTo(midX, midY, dogX, dogY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 3) 俯视瘦骨嶙峋的黑色恶犬
  ctx.translate(dogX, dogY);
  ctx.rotate(dogAng);
  const pant = 1 + Math.sin(time * (aggro ? 24 : 7) + p.seed) * 0.08;
  // 投影
  ctx.fillStyle = 'rgba(4, 5, 4, 0.52)';
  ctx.beginPath();
  ctx.ellipse(1, 2.5, 11.5, 5.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // 竖起/甩动的细尾
  ctx.strokeStyle = '#141413';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(-9, 0);
  ctx.lineTo(-16, Math.sin(time * (aggro ? 28 : 6)) * 4.5);
  ctx.stroke();
  // 躯干与四肢
  ctx.fillStyle = '#1a1917';
  ctx.strokeStyle = '#090908';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.ellipse(0, 0, 10.2 * pant, 4.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // 尖耳长吻头颅（扑扯时张开血口！）
  ctx.fillStyle = '#151412';
  ctx.beginPath();
  ctx.ellipse(10.5, 0, 5.2, 3.6, 0, 0, Math.PI * 2);
  ctx.fill();
  // 竖耳
  ctx.beginPath();
  ctx.moveTo(8, -2.5);
  ctx.lineTo(6.5, -6.2);
  ctx.lineTo(11, -3);
  ctx.moveTo(8, 2.5);
  ctx.lineTo(6.5, 6.2);
  ctx.lineTo(11, 3);
  ctx.fill();
  if (aggro) {
    // 狂吠张开的红口与暗黄凶眼
    ctx.fillStyle = '#8b241d';
    ctx.beginPath();
    ctx.arc(15.2, 0, 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8b454';
    ctx.fillRect(11.2, -2.2, 1.4, 1.2);
    ctx.fillRect(11.2, 1.0, 1.4, 1.2);
  }
  ctx.restore();
}

/** 15. 诡异自摆跷跷板（activity=1 时无风自动上下摆动，光源照到 2s 后 activity→0 诡异停下） */
function drawSeesaw(ctx: CanvasRenderingContext2D, p: WorldProp, time: number, activity: number) {
  const len = p.w;
  const bw = p.h;
  // 俯视下跷跷板上下摆动表现为：木板一端透视放大、影子拉远，另一端缩小贴地，且木板整体轻微轴向滑动
  const tilt = Math.sin(time * 2.15 + p.seed) * activity;
  const shift = tilt * 4.5;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // 地面投影（随倾斜端拉长分离，一眼能看出哪头翘起来了！）
  ctx.fillStyle = 'rgba(4, 5, 4, 0.56)';
  ctx.beginPath();
  ctx.moveTo(-len * 0.5 + shift * 0.4, -bw * 0.5 + 3 + Math.max(0, -tilt) * 8);
  ctx.lineTo(len * 0.5 + shift * 0.4, -bw * 0.5 + 3 + Math.max(0, tilt) * 8);
  ctx.lineTo(len * 0.5 + shift * 0.4, bw * 0.5 + 4 + Math.max(0, tilt) * 8);
  ctx.lineTo(-len * 0.5 + shift * 0.4, bw * 0.5 + 4 + Math.max(0, -tilt) * 8);
  ctx.closePath();
  ctx.fill();

  // 中央生锈铁支架轴
  ctx.fillStyle = '#2c2e2d';
  ctx.strokeStyle = '#111211';
  ctx.lineWidth = 1.2;
  ctx.fillRect(-4, -bw * 0.72, 8, bw * 1.44);
  ctx.strokeRect(-4, -bw * 0.72, 8, bw * 1.44);

  // 腐朽灰褐长木板（翘起端透视略宽略亮，下压端略窄略暗）
  const leftW = bw * (0.5 + Math.max(0, -tilt) * 0.14);
  const rightW = bw * (0.5 + Math.max(0, tilt) * 0.14);
  const bg = ctx.createLinearGradient(-len * 0.5, 0, len * 0.5, 0);
  bg.addColorStop(0, tilt < 0 ? '#6e6452' : '#433d33');
  bg.addColorStop(0.5, '#544c3f');
  bg.addColorStop(1, tilt > 0 ? '#6e6452' : '#433d33');
  ctx.fillStyle = bg;
  ctx.strokeStyle = '#14120f';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(-len * 0.5 + shift, -leftW);
  ctx.lineTo(len * 0.5 + shift, -rightW);
  ctx.lineTo(len * 0.5 + shift, rightW);
  ctx.lineTo(-len * 0.5 + shift, leftW);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 两端生锈铁扶手
  ctx.strokeStyle = '#3b3f3f';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(-len * 0.36 + shift, -leftW * 0.75);
  ctx.lineTo(-len * 0.36 + shift, leftW * 0.75);
  ctx.moveTo(len * 0.36 + shift, -rightW * 0.75);
  ctx.lineTo(len * 0.36 + shift, rightW * 0.75);
  ctx.stroke();
  ctx.restore();
}
