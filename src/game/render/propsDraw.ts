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
  viewB: number
): number {
  let drawn = 0;
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    const pad = Math.max(p.w, p.h) * 0.8 + 48;
    if (p.x < viewL - pad || p.x > viewR + pad || p.y < viewT - pad || p.y > viewB + pad) continue;
    drawn++;
    switch (p.kind) {
      case 'teaField':
        drawTeaField(ctx, p);
        break;
      case 'bridge':
        drawBrokenBridge(ctx, p);
        break;
      case 'cellar':
        drawCellarEntrance(ctx, p);
        break;
      case 'stump':
        drawRootedStump(ctx, p);
        break;
      case 'wheelbarrow':
        drawWheelbarrow(ctx, p);
        break;
      case 'fallenLog':
        drawFallenLogs(ctx, p);
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
