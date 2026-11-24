// Pure-procedural Eastern European oil-painting texture, canopy, architectural & tangent-space normal baker
// Runs once at startup (~40ms), zero external assets, seamlessly tileable, benchmarked against Darkwood.

import { clamp, createRng } from './util';

export interface ProceduralAtlas {
  groundAlbedo: HTMLCanvasElement;
  groundNormalWet: HTMLCanvasElement; // R=Nx, G=Ny, B=PuddleMask, A=255
  woodAlbedo: HTMLCanvasElement;
  woodNormalWet: HTMLCanvasElement;
  wallLogAlbedo: HTMLCanvasElement;
  wallRuinAlbedo: HTMLCanvasElement;
  roofAlbedo: HTMLCanvasElement;
  canopySprites: HTMLCanvasElement[];    // 4 种 320x320 电影级底层林冠（主干分枝骨架 + 深邃暗冠）
  canopyTopSprites: HTMLCanvasElement[]; // 4 种 320x320 电影级顶层细枝冠（用于双层高度视差与错相摇曳）
  trunkSprites: HTMLCanvasElement[];     // 2 种 128x128 粗犷爪状板根树干
  // ?v-cine=b 专属：低频大尺度地表变化（湿泥/积水暗斑/枯叶斑块），384x384 无缝平铺，渲染时放大 GROUND_MACRO_SCALE 倍
  groundMacroAlbedo: HTMLCanvasElement | null; // RGBA 叠加层（source-over）
  groundMacroWet: HTMLCanvasElement | null;    // 仅 B 通道 = 额外积水遮罩（lighter 叠加到法线缓冲 B 通道）
  // ?v-cine=b 专属：林冠地面投影的半透明“叶隙斑驳”图案（256x256 无缝平铺，A = 投影不透明度）
  canopyDapple?: HTMLCanvasElement | null;
  cine: boolean;
}

/** 低频地表叠加层在世界空间的放大倍数（384 * 6 = 2304 世界像素一个周期，接近整张 2600 地图，肉眼不可见重复） */
export const GROUND_MACRO_SCALE = 6;

// Fast tileable 2D value noise (period = N)
function makeTileNoise(period: number, seed: number) {
  const rng = createRng(seed);
  const grid = new Float32Array(period * period);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();

  return (x: number, y: number): number => {
    const gx = ((x % period) + period) % period;
    const gy = ((y % period) + period) % period;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const tx = gx - x0;
    const ty = gy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = grid[y0 * period + x0];
    const b = grid[y0 * period + x1];
    const c = grid[y1 * period + x0];
    const d = grid[y1 * period + x1];
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
}

function bakeGroundPair(coldDecay: boolean): { albedo: HTMLCanvasElement; normalWet: HTMLCanvasElement } {
  const S = 512;
  const albedo = document.createElement('canvas');
  albedo.width = S;
  albedo.height = S;
  const actx = albedo.getContext('2d')!;

  const normalWet = document.createElement('canvas');
  normalWet.width = S;
  normalWet.height = S;
  const nctx = normalWet.getContext('2d')!;

  const nLow = makeTileNoise(4, 3101);
  const nMid = makeTileNoise(10, 5209);
  const nHi = makeTileNoise(24, 7919);
  const nMicro = makeTileNoise(64, 11317);
  const nMoss = makeTileNoise(6, 15971);
  const nPuddle = makeTileNoise(3, 9137);

  const height = new Float32Array(S * S);
  const puddle = new Float32Array(S * S);

  const aImg = actx.createImageData(S, S);
  const aData = aImg.data;

  // Darkwood 摄影/油画高频地表：灰褐腐殖土 + 干裂浅土 + 自然黄绿/灰绿苔藓簇 + 湿暗浅洼
  for (let y = 0; y < S; y++) {
    const ny = y / S;
    for (let x = 0; x < S; x++) {
      const nx = x / S;
      const idx = y * S + x;

      const warpX = (nLow(nx * 4 + 1.3, ny * 4) - 0.5) * 0.24;
      const warpY = (nLow(nx * 4, ny * 4 + 2.7) - 0.5) * 0.24;

      const f1 = nLow((nx + warpX) * 4, (ny + warpY) * 4);
      const f2 = nMid((nx + warpX * 0.65) * 10, (ny + warpY * 0.65) * 10);
      const f3 = nHi((nx + warpX * 0.25) * 24, (ny + warpY * 0.25) * 24);
      const f4 = nMicro(nx * 64, ny * 64);
      // 逐像素确定性高频微粒（彻底消除 8px 网格块感，打造摄影级炭笔/沙土肌理）
      const pxHash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const microGrain = (pxHash - Math.floor(pxHash) - 0.5) * 16;
      const h = f1 * 0.40 + f2 * 0.34 + f3 * 0.18 + f4 * 0.08;
      height[idx] = h;

      // 自然洼地积水遮罩
      const pRaw = nPuddle(nx * 3, ny * 3) * 0.62 + f1 * 0.38;
      const pMask = clamp((0.36 - pRaw) * 6.5, 0, 1);
      puddle[idx] = pMask;

      // 病态苔藓与枯黄草斑（参考原版截图 1, 2, 6, 7：自然点缀在湿泥与灰石间）
      const mField = nMoss((nx - warpX * 0.5) * 6 + 2.1, (ny + warpY * 0.5) * 6 + 0.8) * 0.68 + f3 * 0.32;
      const mossPatch = smooth01(0.56, 0.74, mField) * (1 - pMask);
      const dryGrass = smooth01(0.54, 0.76, f1 * 0.6 + f2 * 0.4) * (1 - pMask) * (1 - mossPatch * 0.6);

      let r: number;
      let g: number;
      let b: number;

      if (coldDecay) {
        // 东欧森林地面基色：中性冷灰泥土 + 干枯草黄高光 + 低饱和灰橄榄苔斑
        r = 50 + h * 44 + dryGrass * 24 - mossPatch * 10 - pMask * 24;
        g = 49 + h * 42 + dryGrass * 20 + mossPatch * 14 - pMask * 21;
        b = 43 + h * 34 + dryGrass * 4 - mossPatch * 14 - pMask * 12;
        const grit = (f4 - 0.5) * 8 + microGrain;
        r = clamp(r + grit, 16, 138);
        g = clamp(g + grit * 0.96, 15, 134);
        b = clamp(b + grit * 0.88, 13, 118);
      } else {
        r = clamp(32 + h * 38 - mossPatch * 8 - pMask * 14, 14, 96);
        g = clamp(38 + h * 40 + mossPatch * 22 - pMask * 12, 16, 108);
        b = clamp(28 + h * 26 - mossPatch * 6 + pMask * 4, 12, 78);
      }

      const o = idx * 4;
      aData[o] = r;
      aData[o + 1] = g;
      aData[o + 2] = b;
      aData[o + 3] = 255;
    }
  }
  actx.putImageData(aImg, 0, 0);

  // 高频手绘细节层 1：细密枯草针叶丝 + 碎土颗粒（彻底告别大号“黑虫子”粗线条）
  const rng = createRng(4419);
  actx.lineCap = 'round';
  for (let i = 0; i < 2400; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const ang = rng() * Math.PI * 2;
    const len = 2.5 + rng() * 6.5;
    const w = 0.55 + rng() * 0.85;
    const tone = rng();
    actx.strokeStyle =
      tone < 0.28
        ? 'rgba(112, 104, 78, 0.34)' // 枯黄细草丝
        : tone < 0.52
        ? 'rgba(72, 78, 56, 0.30)' // 灰绿苔丝
        : tone < 0.78
        ? 'rgba(26, 24, 21, 0.32)' // 泥土微阴影缝
        : 'rgba(138, 130, 108, 0.24)'; // 干燥碎草反光
    actx.lineWidth = w;
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        const px = x + ox;
        const py = y + oy;
        if (px < -10 || px > S + 10 || py < -10 || py > S + 10) continue;
        actx.beginPath();
        actx.moveTo(px, py);
        actx.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
        actx.stroke();
      }
    }
  }

  // 高频手绘细节层 2：Darkwood 标志性地表密集盘绕枯根/灰白毛细藤蔓（严格对标用户特写截图左下角）
  for (let i = 0; i < 110; i++) {
    let rx = rng() * S;
    let ry = rng() * S;
    let ra = rng() * Math.PI * 2;
    const segs = 6 + Math.floor(rng() * 7);
    const brightRoot = rng() > 0.35;
    const pts: number[] = [rx, ry];
    const branches: number[][] = [];
    for (let s = 0; s < segs; s++) {
      ra += (rng() - 0.5) * 0.92;
      rx += Math.cos(ra) * (5 + rng() * 9);
      ry += Math.sin(ra) * (5 + rng() * 9);
      pts.push(rx, ry);
      if (s >= 1 && s < segs - 1 && rng() < 0.48) {
        const ba = ra + (rng() > 0.5 ? 1 : -1) * (0.45 + rng() * 0.55);
        const blen = 7 + rng() * 11;
        branches.push([rx, ry, rx + Math.cos(ba) * blen, ry + Math.sin(ba) * blen]);
      }
    }
    wrapDraw(S, (ox, oy) => {
      if (pts[0] + ox < -80 || pts[0] + ox > S + 80 || pts[1] + oy < -80 || pts[1] + oy > S + 80) return;
      // 底层暗投影，压出地表枯根的立体浮雕感
      actx.strokeStyle = 'rgba(14, 13, 11, 0.42)';
      actx.lineWidth = brightRoot ? 2.1 : 1.9;
      actx.beginPath();
      actx.moveTo(pts[0] + ox + 0.9, pts[1] + oy + 1.1);
      for (let k = 2; k < pts.length; k += 2) {
        actx.lineTo(pts[k] + ox + 0.9, pts[k + 1] + oy + 1.1);
      }
      actx.stroke();

      // 顶层灰白/褐灰枯根脊线
      actx.strokeStyle = brightRoot ? 'rgba(134, 128, 112, 0.36)' : 'rgba(66, 61, 52, 0.42)';
      actx.lineWidth = brightRoot ? 1.05 : 1.15;
      actx.beginPath();
      actx.moveTo(pts[0] + ox, pts[1] + oy);
      for (let k = 2; k < pts.length; k += 2) {
        actx.lineTo(pts[k] + ox, pts[k + 1] + oy);
      }
      for (let b = 0; b < branches.length; b++) {
        const br = branches[b];
        actx.moveTo(br[0] + ox, br[1] + oy);
        actx.lineTo(br[2] + ox, br[3] + oy);
      }
      actx.stroke();
    });
  }

  // 高频手绘细节层 3：极细碎砂砾、暗泥点与枯叶残屑
  for (let i = 0; i < 820; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const r = 0.65 + rng() * 1.55;
    const pick = rng();
    actx.fillStyle =
      pick < 0.36
        ? 'rgba(138, 133, 120, 0.38)'
        : pick < 0.72
        ? 'rgba(18, 16, 14, 0.42)'
        : 'rgba(92, 78, 54, 0.34)';
    actx.beginPath();
    actx.arc(x, y, r, 0, Math.PI * 2);
    actx.fill();
  }

  // 生成切线空间微法线贴图 + 蓝通道编码积水遮罩（强化凹凸立体感，灯光扫过时清晰浮现沙土颗粒）
  const nImg = nctx.createImageData(S, S);
  const nData = nImg.data;
  const strength = coldDecay ? 8.2 : 6.8;

  for (let y = 0; y < S; y++) {
    const ym = (y - 1 + S) % S;
    const yp = (y + 1) % S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S;
      const xp = (x + 1) % S;
      const idx = y * S + x;

      const flat = 1 - puddle[idx] * 0.94;
      const dx = (height[y * S + xp] - height[y * S + xm]) * strength * flat;
      const dy = (height[yp * S + x] - height[ym * S + x]) * strength * flat;
      const invLen = 1 / Math.hypot(dx, dy, 1);

      const o = idx * 4;
      nData[o] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
      nData[o + 1] = Math.round((-dy * invLen * 0.5 + 0.5) * 255);
      nData[o + 2] = Math.round(puddle[idx] * 255);
      nData[o + 3] = 255;
    }
  }
  nctx.putImageData(nImg, 0, 0);

  return { albedo, normalWet };
}

function bakeWoodPair(coldDecay: boolean): { albedo: HTMLCanvasElement; normalWet: HTMLCanvasElement } {
  const S = 256;
  const albedo = document.createElement('canvas');
  albedo.width = S;
  albedo.height = S;
  const actx = albedo.getContext('2d')!;

  const normalWet = document.createElement('canvas');
  normalWet.width = S;
  normalWet.height = S;
  const nctx = normalWet.getContext('2d')!;

  const nGrain = makeTileNoise(16, 8821);
  const nStain = makeTileNoise(5, 4127);
  const plankH = 32;
  const height = new Float32Array(S * S);
  const aImg = actx.createImageData(S, S);
  const aData = aImg.data;

  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / plankH);
    const localY = y % plankH;
    const jointOffset = (row % 2) * 128 + ((row * 37) % 52);
    const rowTint = ((row * 73) % 19) - 9;

    for (let x = 0; x < S; x++) {
      const idx = y * S + x;
      const localX = (x + jointOffset) % 128;

      const grain = nGrain((x / S) * 4, (y / S) * 18 + row * 1.9);
      const stain = nStain((x / S) * 5, (y / S) * 5);
      const streak = Math.sin(y * 0.72 + grain * 6.0) * 0.5 + 0.5;

      // 柔和细腻的东欧老旧木地板缝（参考原版截图 3/4：告别斑马线高对比横纹）
      const wobble = Math.sin(x * 0.08 + row * 2.1) * 0.45;
      const seamY =
        localY < 1.3 + wobble || localY >= plankH - 1.0
          ? 0.48
          : localY < 2.6 || localY >= plankH - 2.0
          ? 0.78
          : 1;
      const seamX = localX < 1.5 ? 0.52 : localX === 2 ? 0.82 : 1;
      const bevel = Math.min(seamY, seamX);

      const h = bevel * (0.64 + grain * 0.24 + streak * 0.12);
      height[idx] = h;

      const grime = (1 - bevel) * 14 + clamp((0.50 - stain) * 28, 0, 18);
      let r: number;
      let g: number;
      let b: number;
      if (coldDecay) {
        // 柔和发白的东欧褪色旧松木地板，带有灰尘水渍与细腻纹理
        r = clamp(82 + rowTint * 0.55 + grain * 20 + streak * 7 - grime, 24, 128);
        g = clamp(76 + rowTint * 0.50 + grain * 18 + streak * 6 - grime, 22, 120);
        b = clamp(65 + rowTint * 0.42 + grain * 14 + streak * 5 - grime, 19, 106);
      } else {
        r = clamp(58 + rowTint + grain * 23 + streak * 11 - grime, 11, 96);
        g = clamp(44 + rowTint * 0.72 + grain * 18 + streak * 8 - grime, 8, 76);
        b = clamp(31 + rowTint * 0.5 + grain * 12 + streak * 5 - grime, 6, 58);
      }

      const o = idx * 4;
      aData[o] = r;
      aData[o + 1] = g;
      aData[o + 2] = b;
      aData[o + 3] = 255;
    }
  }
  actx.putImageData(aImg, 0, 0);

  // 手绘木结、腐朽裂纹、生锈钉头与不规则水渍/焦黑边角
  const rng = createRng(9123);
  for (let row = 0; row < S / plankH; row++) {
    const offset = (row % 2) * 128 + ((row * 37) % 52);
    const py = row * plankH;

    if (rng() > 0.35) {
      const kx = 24 + rng() * (S - 48);
      const ky = py + 8 + rng() * (plankH - 16);
      actx.fillStyle = 'rgba(20, 14, 10, 0.55)';
      actx.beginPath();
      actx.ellipse(kx, ky, 6 + rng() * 5, 2.5 + rng() * 2, (rng() - 0.5) * 0.2, 0, Math.PI * 2);
      actx.fill();
      actx.strokeStyle = 'rgba(34, 24, 16, 0.42)';
      actx.lineWidth = 1;
      actx.stroke();
    }

    actx.strokeStyle = 'rgba(12, 10, 8, 0.52)';
    actx.lineWidth = 1.1;
    for (let c = 0; c < 4; c++) {
      const cx = rng() * S;
      const cy = py + 4 + rng() * (plankH - 8);
      actx.beginPath();
      actx.moveTo(cx, cy);
      actx.lineTo(cx + 14 + rng() * 32, cy + (rng() - 0.5) * 3.0);
      actx.stroke();
    }

    for (const jx of [0, 128]) {
      const nx = (jx - offset + S * 2) % S;
      for (const ny of [py + 7, py + plankH - 9]) {
        actx.fillStyle = 'rgba(66, 30, 18, 0.38)';
        actx.beginPath();
        actx.arc((nx + 7) % S, ny + 1, 3.2, 0, Math.PI * 2);
        actx.fill();
        actx.fillStyle = 'rgba(18, 13, 10, 0.85)';
        actx.fillRect((nx + 6) % S, ny, 2.5, 2.5);
      }
    }
  }

  // 叠加不规则潮湿水渍、暗苔与焦黑边角打破地板网格感
  if (coldDecay) {
    for (let i = 0; i < 18; i++) {
      const sx = rng() * S;
      const sy = rng() * S;
      const rad = 16 + rng() * 36;
      const g = actx.createRadialGradient(sx, sy, 2, sx, sy, rad);
      const pick = rng();
      g.addColorStop(
        0,
        pick < 0.45
          ? 'rgba(12, 11, 10, 0.44)' // 焦黑污渍/炭灰
          : pick < 0.78
          ? 'rgba(28, 30, 29, 0.38)' // 潮湿水渍
          : 'rgba(42, 43, 38, 0.34)' // 冷灰暗苔
      );
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      actx.fillStyle = g;
      actx.beginPath();
      actx.arc(sx, sy, rad, 0, Math.PI * 2);
      actx.fill();
    }
  }

  const nImg = nctx.createImageData(S, S);
  const nData = nImg.data;
  const strength = 5.4;

  for (let y = 0; y < S; y++) {
    const ym = (y - 1 + S) % S;
    const yp = (y + 1) % S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S;
      const xp = (x + 1) % S;
      const idx = y * S + x;

      const dx = (height[y * S + xp] - height[y * S + xm]) * strength;
      const dy = (height[yp * S + x] - height[ym * S + x]) * strength;
      const invLen = 1 / Math.hypot(dx, dy, 1);

      const o = idx * 4;
      nData[o] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
      nData[o + 1] = Math.round((-dy * invLen * 0.5 + 0.5) * 255);
      nData[o + 2] = 18;
      nData[o + 3] = 255;
    }
  }
  nctx.putImageData(nImg, 0, 0);

  return { albedo, normalWet };
}

// 手绘风化原木木屋墙体纹理
function bakeWallLogAlbedo(coldDecay: boolean): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const rng = createRng(2197);

  ctx.fillStyle = coldDecay ? '#312922' : '#3f3023';
  ctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 190; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const len = 10 + rng() * 34;
    const bright = rng() > 0.5;
    ctx.strokeStyle = coldDecay
      ? bright
        ? 'rgba(78, 68, 56, 0.34)'
        : 'rgba(14, 12, 10, 0.52)'
      : bright
      ? 'rgba(92, 72, 50, 0.34)'
      : 'rgba(18, 13, 9, 0.48)';
    ctx.lineWidth = 1 + rng() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rng() - 0.5) * 2);
    ctx.stroke();
  }

  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = coldDecay ? 'rgba(42, 44, 40, 0.36)' : 'rgba(38, 52, 30, 0.34)';
    ctx.beginPath();
    ctx.ellipse(rng() * S, rng() * S, 6 + rng() * 10, 2.5 + rng() * 4, rng() * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  return c;
}

// 手绘开裂东欧石砌残垣纹理
function bakeWallRuinAlbedo(coldDecay: boolean): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const rng = createRng(7711);

  ctx.fillStyle = '#222322';
  ctx.fillRect(0, 0, S, S);

  const rows = 8;
  const rowH = S / rows;
  for (let r = 0; r < rows; r++) {
    let x = (r % 2) * -12;
    while (x < S) {
      const bw = 18 + Math.floor(rng() * 18);
      const shade = Math.floor(rng() * 18);
      const mossy = rng() < 0.22;
      if (coldDecay) {
        ctx.fillStyle = mossy
          ? `rgb(${44 + shade}, ${46 + shade}, ${43 + shade})`
          : `rgb(${54 + shade}, ${53 + shade}, ${50 + shade})`;
      } else {
        ctx.fillStyle = mossy
          ? `rgb(${42 + shade}, ${51 + shade}, ${38 + shade})`
          : `rgb(${55 + shade}, ${56 + shade}, ${50 + shade})`;
      }
      ctx.fillRect(x + 1, r * rowH + 1, bw - 2, rowH - 2);
      ctx.fillStyle = 'rgba(168, 170, 156, 0.11)';
      ctx.fillRect(x + 2, r * rowH + 1, bw - 4, 2);
      ctx.fillStyle = 'rgba(10, 11, 10, 0.68)';
      ctx.fillRect(x, (r + 1) * rowH - 2, bw, 2);
      x += bw;
    }
  }

  ctx.strokeStyle = 'rgba(10, 11, 10, 0.68)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 16; i++) {
    let px = rng() * S;
    let py = rng() * S;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let s = 0; s < 4; s++) {
      px += (rng() - 0.5) * 14;
      py += (rng() - 0.5) * 14;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  return c;
}

function bakeRoofShingles(coldDecay: boolean): HTMLCanvasElement {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const rng = createRng(6217);

  ctx.fillStyle = '#141210';
  ctx.fillRect(0, 0, S, S);

  const rowH = 16;
  const colW = 20;
  for (let row = 0; row * rowH < S + rowH; row++) {
    const y = row * rowH;
    const shift = (row % 2) * (colW * 0.5) + (coldDecay ? (rng() - 0.5) * 4 : 0);
    for (let col = -1; col * colW < S + colW; col++) {
      const x = col * colW + shift;
      // 偶发缺失或腐烂木瓦，露出暗色椽木
      if (rng() < (coldDecay ? 0.095 : 0.065)) {
        ctx.fillStyle = '#0b0a09';
        ctx.fillRect(x + 1, y + 1, colW - 2, rowH - 2);
        ctx.fillStyle = '#241e18';
        ctx.fillRect(x + 3, y + 4, colW - 6, 3);
        continue;
      }

      const shade = Math.floor(rng() * 18);
      const mossy = rng() < 0.28;
      const rot = rng() < 0.18;
      if (coldDecay) {
        ctx.fillStyle = mossy
          ? `rgb(${34 + shade}, ${37 + shade}, ${34 + shade})`
          : rot
          ? `rgb(${23 + shade}, ${20 + shade}, ${18 + shade})`
          : `rgb(${40 + shade}, ${35 + shade}, ${31 + shade})`;
      } else {
        ctx.fillStyle = mossy
          ? `rgb(${29 + shade}, ${42 + shade}, ${25 + shade})`
          : rot
          ? `rgb(${28 + shade}, ${22 + shade}, ${18 + shade})`
          : `rgb(${44 + shade}, ${35 + shade}, ${28 + shade})`;
      }

      const tilt = (rng() - 0.5) * (coldDecay ? 2.2 : 1.4);
      const wVar = coldDecay ? (rng() - 0.5) * 3 : 0;
      ctx.save();
      ctx.translate(x + colW * 0.5, y + rowH * 0.5);
      ctx.rotate(tilt * 0.045);
      ctx.fillRect(-colW * 0.5 + 1, -rowH * 0.5 + 1, colW - 2 + wVar, rowH - 2);

      // 木瓦纹理与裂痕
      ctx.fillStyle = 'rgba(10, 8, 6, 0.28)';
      ctx.fillRect(-colW * 0.3, -rowH * 0.4, 1.5, rowH * 0.8);
      ctx.fillRect(colW * 0.15, -rowH * 0.4, 1.2, rowH * 0.75);

      // 重叠瓦唇暗影与微弱冷灰磨损边
      ctx.fillStyle = 'rgba(6, 6, 5, 0.82)';
      ctx.fillRect(-colW * 0.5, rowH * 0.5 - 2.6, colW, 2.6);
      ctx.fillStyle = 'rgba(176, 170, 158, 0.07)';
      ctx.fillRect(-colW * 0.5 + 2, -rowH * 0.5 + 1, colW - 4, 1.8);
      ctx.restore();
    }
  }

  // 大面积油画雨水污渍、冷灰暗苔与焦黑边角，打破机械瓦片网格感
  for (let i = 0; i < (coldDecay ? 34 : 24); i++) {
    const lx = rng() * S;
    const ly = rng() * S;
    const rad = 14 + rng() * 38;
    const g = ctx.createRadialGradient(lx, ly, 2, lx, ly, rad);
    const isMoss = rng() > 0.45;
    if (coldDecay) {
      g.addColorStop(0, isMoss ? 'rgba(46, 48, 44, 0.46)' : 'rgba(8, 8, 8, 0.48)');
    } else {
      g.addColorStop(0, isMoss ? 'rgba(42, 62, 32, 0.42)' : 'rgba(10, 9, 8, 0.36)');
    }
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(lx, ly, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  return c;
}

// Helper: draw one gnarled skeletal branch with forks
function drawCrookedBranch(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  ang: number,
  len: number,
  width: number,
  depth: number,
  rng: () => number,
  color: string
) {
  let x = x0;
  let y = y0;
  let a = ang;
  const segs = 4;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';

  for (let s = 0; s < segs; s++) {
    const t = s / segs;
    const segLen = (len / segs) * (0.85 + rng() * 0.3);
    a += (rng() - 0.5) * 0.38;
    const nx = x + Math.cos(a) * segLen;
    const ny = y + Math.sin(a) * segLen;

    ctx.lineWidth = Math.max(1.2, width * (1 - t * 0.68));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(nx, ny);
    ctx.stroke();

    if (depth > 0 && s >= 1 && rng() > 0.32) {
      const forkDir = rng() > 0.5 ? 1 : -1;
      drawCrookedBranch(
        ctx,
        nx,
        ny,
        a + forkDir * (0.42 + rng() * 0.38),
        len * (0.45 + rng() * 0.18),
        width * 0.56,
        depth - 1,
        rng,
        color
      );
    }

    x = nx;
    y = ny;
  }
}

// Helper: paint dense impasto needle / foliage brushstroke tuft along a bough
function paintNeedleFan(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  ang: number,
  len: number,
  spread: number,
  baseCol: string,
  tipCol: string,
  rng: () => number,
  strokeCount: number
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang);

  // Dark under-cluster body
  ctx.fillStyle = baseCol;
  ctx.beginPath();
  ctx.moveTo(len * 0.12, 0);
  ctx.quadraticCurveTo(len * 0.52, -spread * 0.62, len * 0.94, -spread * 0.14);
  ctx.lineTo(len, 0);
  ctx.lineTo(len * 0.94, spread * 0.14);
  ctx.quadraticCurveTo(len * 0.52, spread * 0.62, len * 0.12, 0);
  ctx.closePath();
  ctx.fill();

  // Dozens of hand-painted bristle needle strokes radiating asymmetrically
  ctx.lineCap = 'round';
  for (let i = 0; i < strokeCount; i++) {
    const t = 0.16 + rng() * 0.84;
    const bx = len * t;
    const side = i % 2 === 0 ? 1 : -1;
    const w = spread * (1.05 - t * 0.68) * (0.65 + rng() * 0.55);
    const tipDx = 6 + rng() * 10;
    const tipDy = side * w;

    ctx.strokeStyle = t > 0.58 && rng() > 0.35 ? tipCol : baseCol;
    ctx.lineWidth = 1.4 + rng() * 2.4;
    ctx.beginPath();
    ctx.moveTo(bx - 3, side * 1.5);
    ctx.quadraticCurveTo(bx + tipDx * 0.5, tipDy * 0.55, bx + tipDx, tipDy);
    ctx.stroke();
  }
  ctx.restore();
}

// 烘焙 4 种电影级 320x320 底层林冠（扭曲主干分枝骨架 + 多层错落冷墨/枯褐针叶簇 + 外缘细碎枯枝剪影）
function bakeCanopyVariant(variantIndex: number, coldDecay: boolean): HTMLCanvasElement {
  const S = 320;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S * 0.5;
  const cy = S * 0.5;
  const rng = createRng(3307 + variantIndex * 1429);

  // 底层深邃树冠核心投影
  const shadow = ctx.createRadialGradient(cx + 5, cy + 7, 18, cx + 5, cy + 7, 142);
  shadow.addColorStop(0, 'rgba(4, 5, 5, 0.88)');
  shadow.addColorStop(0.60, 'rgba(6, 7, 7, 0.50)');
  shadow.addColorStop(1, 'rgba(4, 5, 5, 0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.arc(cx + 5, cy + 7, 142, 0, Math.PI * 2);
  ctx.fill();

  if (variantIndex === 0) {
    // 变体 0：古老暗色针叶云杉（放射骨架 + 4 层错落针叶 + 外缘枯枝剪影）
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + (rng() - 0.5) * 0.42;
      drawCrookedBranch(ctx, cx, cy, a, 114 + rng() * 34, 4.6, 2, rng, '#100d0b');
    }

    const tiers = coldDecay
      ? [
          { n: 18, minR: 84, maxR: 138, spread: 25, base: '#0c0e0e', tip: '#181c1a', strokes: 18 },
          { n: 15, minR: 58, maxR: 102, spread: 21, base: '#141715', tip: '#252620', strokes: 16 },
          { n: 12, minR: 34, maxR: 70, spread: 17, base: '#1e201b', tip: '#353228', strokes: 14 },
        ]
      : [
          { n: 17, minR: 84, maxR: 138, spread: 26, base: '#0c130d', tip: '#152116', strokes: 18 },
          { n: 15, minR: 60, maxR: 104, spread: 22, base: '#121e13', tip: '#1f301e', strokes: 16 },
          { n: 12, minR: 36, maxR: 72, spread: 18, base: '#1a2b1a', tip: '#2e4429', strokes: 14 },
        ];
    for (const tier of tiers) {
      for (let i = 0; i < tier.n; i++) {
        const ang = (i / tier.n) * Math.PI * 2 + (rng() - 0.5) * 0.42;
        const len = tier.minR + rng() * (tier.maxR - tier.minR);
        paintNeedleFan(ctx, cx, cy, ang, len, tier.spread, tier.base, tier.tip, rng, tier.strokes);
      }
    }
  } else if (variantIndex === 1) {
    // 变体 1：枯萎扭曲死木松（标志性 Darkwood 爪状黑枝 + 稀疏枯褐针叶簇）
    for (let i = 0; i < 13; i++) {
      const a = (i / 13) * Math.PI * 2 + (rng() - 0.5) * 0.35;
      const len = 98 + rng() * 46;
      drawCrookedBranch(ctx, cx, cy, a, len, 5.6, 2, rng, '#13100e');
      if (Math.cos(a + 0.85) > 0) {
        drawCrookedBranch(ctx, cx - 1, cy - 1, a, len * 0.65, 2.0, 1, rng, 'rgba(92, 86, 76, 0.38)');
      }
    }
    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2;
      const distOut = 30 + rng() * 68;
      const fx = cx + Math.cos(a) * distOut;
      const fy = cy + Math.sin(a) * distOut;
      paintNeedleFan(
        ctx,
        fx,
        fy,
        a + (rng() - 0.5) * 0.8,
        24 + rng() * 22,
        14,
        coldDecay ? '#1a1713' : '#1b2013',
        coldDecay ? '#3a3326' : '#3b3e22',
        rng,
        11
      );
    }
    // 垂挂冷灰地衣丝缕
    ctx.strokeStyle = coldDecay ? 'rgba(116, 120, 118, 0.24)' : 'rgba(128, 138, 108, 0.28)';
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 18; i++) {
      const a = rng() * Math.PI * 2;
      const r = 38 + rng() * 72;
      const lx = cx + Math.cos(a) * r;
      const ly = cy + Math.sin(a) * r;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.quadraticCurveTo(lx + 4, ly + 8, lx + (rng() - 0.5) * 10, ly + 15);
      ctx.stroke();
    }
  } else if (variantIndex === 2) {
    // 变体 2：沼泽扭曲桤木/桦树（粗壮黑枝 + 厚涂暗褐枯叶团）
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + (rng() - 0.5) * 0.4;
      drawCrookedBranch(ctx, cx, cy, a, 94 + rng() * 40, 5.0, 2, rng, '#161310');
    }

    const leafLayers = coldDecay
      ? [
          { count: 95, minR: 34, maxR: 124, size: 17, col: 'rgba(14, 15, 14, 0.88)' },
          { count: 80, minR: 18, maxR: 96, size: 14, col: 'rgba(26, 26, 23, 0.84)' },
          { count: 55, minR: 8, maxR: 70, size: 11, col: 'rgba(42, 38, 30, 0.74)' },
          { count: 28, minR: 10, maxR: 64, size: 8, col: 'rgba(66, 56, 42, 0.46)' },
        ]
      : [
          { count: 95, minR: 35, maxR: 126, size: 17, col: 'rgba(13, 21, 14, 0.86)' },
          { count: 80, minR: 18, maxR: 98, size: 14, col: 'rgba(24, 37, 22, 0.82)' },
          { count: 55, minR: 8, maxR: 72, size: 11, col: 'rgba(38, 52, 31, 0.72)' },
          { count: 28, minR: 10, maxR: 64, size: 8, col: 'rgba(66, 74, 44, 0.45)' },
        ];
    for (const layer of leafLayers) {
      ctx.fillStyle = layer.col;
      for (let i = 0; i < layer.count; i++) {
        const a = rng() * Math.PI * 2;
        const r = layer.minR + Math.pow(rng(), 0.75) * (layer.maxR - layer.minR);
        const lx = cx + Math.cos(a) * r;
        const ly = cy + Math.sin(a) * r;
        const rx = layer.size * (0.65 + rng() * 0.7);
        const ry = layer.size * (0.45 + rng() * 0.55);
        ctx.beginPath();
        ctx.ellipse(lx, ly, rx, ry, rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else {
    // 变体 3：受风扭曲的密林冷杉（不对称锯齿轮廓 + 外突枯枝）
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + (rng() - 0.5) * 0.5;
      drawCrookedBranch(ctx, cx, cy, a, 108 + rng() * 34, 4.0, 1, rng, '#12100e');
    }
    const tiers = coldDecay
      ? [
          { n: 19, minR: 74, maxR: 134, spread: 23, base: '#0a0d0d', tip: '#161b1b', strokes: 16 },
          { n: 14, minR: 44, maxR: 94, spread: 19, base: '#151918', tip: '#252927', strokes: 15 },
          { n: 10, minR: 16, maxR: 54, spread: 14, base: '#212420', tip: '#34352e', strokes: 12 },
        ]
      : [
          { n: 19, minR: 76, maxR: 136, spread: 24, base: '#0a120d', tip: '#132018', strokes: 16 },
          { n: 14, minR: 46, maxR: 96, spread: 20, base: '#122118', tip: '#1f3526', strokes: 15 },
          { n: 10, minR: 16, maxR: 54, spread: 15, base: '#1d3124', tip: '#344c36', strokes: 12 },
        ];
    for (const tier of tiers) {
      for (let i = 0; i < tier.n; i++) {
        const ang = (i / tier.n) * Math.PI * 2 + Math.sin(i * 1.9) * 0.25;
        const asym = 0.8 + 0.35 * Math.cos(ang - 0.6);
        const len = (tier.minR + rng() * (tier.maxR - tier.minR)) * asym;
        paintNeedleFan(ctx, cx, cy, ang, len, tier.spread, tier.base, tier.tip, rng, tier.strokes);
      }
    }
  }

  // 外缘细碎枯枝剪影，强化 Darkwood 森林压迫感
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + (rng() - 0.5) * 0.4;
    const r0 = 76 + rng() * 26;
    drawCrookedBranch(
      ctx,
      cx + Math.cos(a) * r0,
      cy + Math.sin(a) * r0,
      a + (rng() - 0.5) * 0.5,
      26 + rng() * 24,
      2.1,
      1,
      rng,
      'rgba(14, 13, 12, 0.86)'
    );
  }

  // 深邃冠心暗井
  const core = ctx.createRadialGradient(cx, cy, 2, cx, cy, 28);
  core.addColorStop(0, 'rgba(6, 7, 7, 0.78)');
  core.addColorStop(1, 'rgba(6, 7, 7, 0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, 28, 0, Math.PI * 2);
  ctx.fill();

  return c;
}

// 烘焙 4 种电影级顶层细枝冠（用于与底层大暗冠分离，实现双层高度视差与受风波浪错相摇曳）
function bakeCanopyTopVariant(variantIndex: number, coldDecay: boolean): HTMLCanvasElement {
  const S = 320;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S * 0.5;
  const cy = S * 0.5;
  const rng = createRng(8101 + variantIndex * 1777);

  // 顶部主枝骨架
  const branchCount = variantIndex === 1 ? 9 : 7;
  for (let i = 0; i < branchCount; i++) {
    const a = (i / branchCount) * Math.PI * 2 + (rng() - 0.5) * 0.45;
    drawCrookedBranch(ctx, cx, cy, a, 58 + rng() * 34, 3.2, 2, rng, '#141210');
  }

  // 顶层错落针叶/枯叶簇
  const clusterCount = variantIndex === 1 ? 8 : 12;
  for (let i = 0; i < clusterCount; i++) {
    const ang = (i / clusterCount) * Math.PI * 2 + (rng() - 0.5) * 0.45;
    const len = 30 + rng() * 44;
    const base = coldDecay
      ? variantIndex === 1
        ? '#201c17'
        : '#1e211e'
      : variantIndex === 1
      ? '#212516'
      : '#1c2f1c';
    const tip = coldDecay
      ? variantIndex === 1
        ? '#453b2c'
        : '#373b36'
      : variantIndex === 1
      ? '#444827'
      : '#3b5434';
    paintNeedleFan(ctx, cx, cy, ang, len, 14 + rng() * 6, base, tip, rng, 12);
  }

  // 顶部极克制的冷雾高光边缘（西北向干刷笔触，避免过绿）
  for (let i = 0; i < 22; i++) {
    const a = -Math.PI * 0.85 + (rng() - 0.5) * 1.45;
    const r = 10 + rng() * 58;
    ctx.fillStyle = coldDecay
      ? variantIndex === 1
        ? 'rgba(124, 114, 96, 0.20)'
        : 'rgba(128, 136, 138, 0.21)'
      : variantIndex === 1
      ? 'rgba(112, 102, 74, 0.22)'
      : 'rgba(92, 118, 82, 0.24)';
    ctx.beginPath();
    ctx.ellipse(
      cx + Math.cos(a) * r,
      cy + Math.sin(a) * r,
      3.5 + rng() * 6.5,
      1.8 + rng() * 3.0,
      a + 0.5,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  return c;
}

// 烘焙 2 种 256x256 干净克制的贴地树根与深邃树干截面（对标原作：树根紧贴树干脚下、周围地面保持干净，与高空黑枝彻底区隔）
function bakeTrunkSprite(variant: number, coldDecay: boolean): HTMLCanvasElement {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S * 0.5;
  const cy = S * 0.5;
  const rng = createRng(5501 + variant * 811);

  // 1. 柔和紧致的贴地接触影（仅围绕树干根部，绝不扩散成黑坨）
  const baseShadow = ctx.createRadialGradient(cx + 2, cy + 3, 28, cx + 2, cy + 3, 74);
  baseShadow.addColorStop(0, 'rgba(6, 7, 6, 0.68)');
  baseShadow.addColorStop(0.58, 'rgba(10, 11, 10, 0.24)');
  baseShadow.addColorStop(1, 'rgba(10, 11, 10, 0)');
  ctx.fillStyle = baseShadow;
  ctx.beginPath();
  ctx.arc(cx + 2, cy + 3, 74, 0, Math.PI * 2);
  ctx.fill();

  // 2. 紧贴树干的短粗柔和板根（无蜘蛛网状长黑须，让地面树根区域干净可读）
  const trunkR = 42;
  const rootCount = 8 + variant;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < rootCount; i++) {
    const baseA = (i / rootCount) * Math.PI * 2 + (rng() - 0.5) * 0.34;
    const len = 20 + rng() * 20; // 短促紧致地扎入树干四周泥土
    const w0 = 7.5 + rng() * 3.8;
    const sx = cx + Math.cos(baseA) * (trunkR - 5);
    const sy = cy + Math.sin(baseA) * (trunkR - 5);
    const midA = baseA + (rng() - 0.5) * 0.22;
    const mx = sx + Math.cos(midA) * (len * 0.52);
    const my = sy + Math.sin(midA) * (len * 0.52);
    const ex = sx + Math.cos(baseA + (rng() - 0.5) * 0.26) * len;
    const ey = sy + Math.sin(baseA + (rng() - 0.5) * 0.26) * len;

    // 极柔和的根下贴地暗影
    ctx.strokeStyle = 'rgba(8, 9, 8, 0.42)';
    ctx.lineWidth = w0 + 2.4;
    ctx.beginPath();
    ctx.moveTo(sx + 1.4, sy + 1.8);
    ctx.quadraticCurveTo(mx + 1.4, my + 1.8, ex + 1.0, ey + 1.2);
    ctx.stroke();

    // 暖灰褐树根主体（与纯黑高空树枝形成明显明度反差）
    const rg = ctx.createLinearGradient(sx, sy, ex, ey);
    rg.addColorStop(0, coldDecay ? '#3a342a' : '#443728');
    rg.addColorStop(0.6, coldDecay ? '#2f2b23' : '#352b20');
    rg.addColorStop(1, 'rgba(38, 35, 29, 0)');
    ctx.strokeStyle = rg;
    ctx.lineWidth = w0;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();

    // 树根顶脊浅灰褐受光纹理（在光锥下呈现清晰立体感）
    ctx.strokeStyle = coldDecay ? 'rgba(136, 128, 110, 0.36)' : 'rgba(132, 114, 88, 0.38)';
    ctx.lineWidth = Math.max(1.0, w0 * 0.26);
    ctx.beginPath();
    ctx.moveTo(sx - 0.6, sy - 0.6);
    ctx.quadraticCurveTo(mx - 0.6, my - 0.6, ex * 0.72 + mx * 0.28, ey * 0.72 + my * 0.28);
    ctx.stroke();
  }

  // 3. 树干横截面：干净深暗树心 + 细腻树皮外圈（配合渲染层动态迎光亮弧边）
  ctx.fillStyle = '#0c0b09';
  ctx.beginPath();
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const wobble = trunkR + Math.sin(a * 7 + variant) * 2.4 + (rng() - 0.5) * 2.2;
    const px = cx + Math.cos(a) * wobble;
    const py = cy + Math.sin(a) * wobble;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  const coreGrad = ctx.createRadialGradient(cx, cy, 4, cx, cy, trunkR - 2);
  coreGrad.addColorStop(0, '#0e0d0b');
  coreGrad.addColorStop(0.68, '#171512');
  coreGrad.addColorStop(0.92, coldDecay ? '#2a2620' : '#31261c');
  coreGrad.addColorStop(1, '#12100d');
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, trunkR - 2.5, 0, Math.PI * 2);
  ctx.fill();

  // 细微树皮外圈纵裂纹理
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + rng() * 0.14;
    ctx.strokeStyle = 'rgba(8, 7, 6, 0.75)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (trunkR * 0.58), cy + Math.sin(a) * (trunkR * 0.58));
    ctx.lineTo(cx + Math.cos(a) * (trunkR - 1), cy + Math.sin(a) * (trunkR - 1));
    ctx.stroke();

    ctx.strokeStyle = 'rgba(138, 130, 112, 0.24)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a + 0.05) * (trunkR * 0.66), cy + Math.sin(a + 0.05) * (trunkR * 0.66));
    ctx.lineTo(cx + Math.cos(a + 0.05) * (trunkR - 2.5), cy + Math.sin(a + 0.05) * (trunkR - 2.5));
    ctx.stroke();
  }

  return c;
}

// ============================================================================
// ?v-cine=b 电影级重制烘焙（仅在启动或切换 Variant 时执行一次，零每帧开销）
// ============================================================================

function smooth01(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 低频大尺度地表变化：大块湿泥、积水暗斑、枯叶斑块与干燥淤泥（无缝平铺，渲染时放大 GROUND_MACRO_SCALE 倍）。
 * 明暗双向平衡：湿泥/积水压暗、枯叶/干泥轻微提亮，整体平均亮度基本不变，保持低饱和。
 */
function bakeGroundMacro(coldDecay: boolean): { albedo: HTMLCanvasElement; wet: HTMLCanvasElement } {
  const S = 384;
  const albedo = document.createElement('canvas');
  albedo.width = S;
  albedo.height = S;
  const actx = albedo.getContext('2d')!;
  const wet = document.createElement('canvas');
  wet.width = S;
  wet.height = S;
  const wctx = wet.getContext('2d')!;

  // 所有噪声周期均为整数，坐标按 nx * period 采样，保证 384 像素无缝平铺
  const nWarp = makeTileNoise(4, 1601);
  const nLow = makeTileNoise(3, 1201);
  const nMid = makeTileNoise(7, 3307);
  const nHi = makeTileNoise(19, 4409);
  const nLeaf = makeTileNoise(5, 2203);
  const nLeafHi = makeTileNoise(23, 6607);

  const aImg = actx.createImageData(S, S);
  const aData = aImg.data;
  const wImg = wctx.createImageData(S, S);
  const wData = wImg.data;

  for (let y = 0; y < S; y++) {
    const ny = y / S;
    for (let x = 0; x < S; x++) {
      const nx = x / S;
      const warpX = (nWarp(nx * 4, ny * 4) - 0.5) * 0.16;
      const warpY = (nWarp(nx * 4 + 1.7, ny * 4 + 2.9) - 0.5) * 0.16;
      const hi = nHi(nx * 19, ny * 19);
      // 湿度场：低频主导 + 中高频破碎边缘
      const m = nLow((nx + warpX) * 3, (ny + warpY) * 3) * 0.6 + nMid((nx + warpX) * 7, (ny + warpY) * 7) * 0.28 + hi * 0.12;
      const leafField = nLeaf((nx - warpX) * 5 + 2.3, (ny - warpY) * 5 + 0.7) * 0.75 + nLeafHi(nx * 23, ny * 23) * 0.25;

      const mud = smooth01(0.56, 0.70, m);
      const puddle = smooth01(0.68, 0.76, m);
      const leaf = smooth01(0.58, 0.72, leafField) * (1 - mud);
      const dry = smooth01(0.60, 0.74, 1 - m) * (1 - leaf) * (1 - mud);

      // 手动 premultiplied “over” 合成：干泥 -> 枯叶 -> 湿泥 -> 积水（内联展开，避免逐像素创建闭包）
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let ca = 0;
      if (dry > 0.001) {
        const a = 0.15 * dry;
        cr = (coldDecay ? 80 : 76) * a;
        cg = (coldDecay ? 77 : 78) * a;
        cb = (coldDecay ? 70 : 64) * a;
        ca = a;
      }
      if (leaf > 0.001) {
        const a = 0.22 * leaf;
        const lr = coldDecay ? 66 + hi * 14 : 64 + hi * 14;
        const lg = coldDecay ? 53 + hi * 9 : 56 + hi * 10;
        const lb = coldDecay ? 39 + hi * 6 : 34 + hi * 6;
        cr = lr * a + cr * (1 - a);
        cg = lg * a + cg * (1 - a);
        cb = lb * a + cb * (1 - a);
        ca = a + ca * (1 - a);
      }
      if (mud > 0.001) {
        const a = 0.32 * mud;
        cr = 17 * a + cr * (1 - a);
        cg = 14 * a + cg * (1 - a);
        cb = 12 * a + cb * (1 - a);
        ca = a + ca * (1 - a);
      }
      if (puddle > 0.001) {
        const a = 0.30 * puddle;
        cr = 9 * a + cr * (1 - a);
        cg = 11 * a + cg * (1 - a);
        cb = 13 * a + cb * (1 - a);
        ca = a + ca * (1 - a);
      }

      const o = (y * S + x) * 4;
      if (ca > 0.0001) {
        aData[o] = clamp(Math.round(cr / ca), 0, 255);
        aData[o + 1] = clamp(Math.round(cg / ca), 0, 255);
        aData[o + 2] = clamp(Math.round(cb / ca), 0, 255);
        aData[o + 3] = clamp(Math.round(ca * 255), 0, 255);
      } else {
        aData[o] = 0;
        aData[o + 1] = 0;
        aData[o + 2] = 0;
        aData[o + 3] = 0;
      }

      // 积水遮罩（B 通道），以 lighter 叠加进法线缓冲，驱动 WebGL 湿润高光与雨滴波纹
      wData[o] = 0;
      wData[o + 1] = 0;
      wData[o + 2] = clamp(Math.round(puddle * 130 + mud * 22), 0, 255);
      wData[o + 3] = 255;
    }
  }
  actx.putImageData(aImg, 0, 0);
  wctx.putImageData(wImg, 0, 0);
  return { albedo, wet };
}

/** 在 9 个平铺偏移处重复绘制，保证跨越纹理边界的元素无缝衔接 */
function wrapDraw(S: number, fn: (ox: number, oy: number) => void) {
  for (const ox of [-S, 0, S]) {
    for (const oy of [-S, 0, S]) fn(ox, oy);
  }
}

/** 把随机长度序列缩放到总和恰为 total（保证平铺周期闭合、长短不一且错缝） */
function randomPartition(total: number, minLen: number, maxLen: number, rng: () => number): number[] {
  const parts: number[] = [];
  let sum = 0;
  while (sum < total) {
    const v = minLen + rng() * (maxLen - minLen);
    parts.push(v);
    sum += v;
  }
  const k = total / sum;
  for (let i = 0; i < parts.length; i++) parts[i] *= k;
  return parts;
}

/**
 * 破旧屋顶：焦油毡长条 + 腐朽木瓦（长短不一、错缝）+ 锈铁皮补丁，撕裂破口、苔藓与雨水污渍，整体低对比。
 * 384 无缝平铺（大于庇护所屋顶尺寸，单个屋顶内不出现重复）。
 */
function bakeRoofCine(coldDecay: boolean): HTMLCanvasElement {
  const S = 384;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const rng = createRng(7349);

  ctx.fillStyle = '#15130f';
  ctx.fillRect(0, 0, S, S);

  const rows = randomPartition(S, 16, 44, rng);
  let y = 0;
  for (let r = 0; r < rows.length; r++) {
    const rowH = rows[r];
    const segs = randomPartition(S, 46, 150, rng);
    // 每一行起点随机错位，避免竖向接缝对齐
    let x = rng() * S;
    for (let s = 0; s < segs.length; s++) {
      const segW = segs[s];
      const pick = rng();
      const kind = pick < 0.62 ? 'tar' : pick < 0.88 ? 'shingle' : 'tin';
      const shade = Math.floor(rng() * 10) - 5;
      const segX = x;
      const segY = y;
      const tilt = (rng() - 0.5) * 1.6;
      const shingleW = randomPartition(segW, 9, 26, rng);
      const shingleShade = shingleW.map(() => Math.floor(rng() * 9) - 5);
      const shingleDrop = shingleW.map(() => rng() * 3.2);

      wrapDraw(S, (ox, oy) => {
        const sx0 = segX + ox;
        const sy0 = segY + oy;
        if (sx0 > S + 4 || sx0 + segW < -4 || sy0 > S + 4 || sy0 + rowH < -4) return;
        if (kind === 'tar') {
          // 焦油毡：近黑灰褐、轻微起皱
          ctx.fillStyle = coldDecay
            ? `rgb(${36 + shade}, ${33 + shade}, ${30 + shade})`
            : `rgb(${38 + shade}, ${33 + shade}, ${27 + shade})`;
          ctx.beginPath();
          ctx.moveTo(sx0, sy0 + tilt);
          ctx.lineTo(sx0 + segW, sy0 - tilt);
          ctx.lineTo(sx0 + segW, sy0 + rowH - tilt);
          ctx.lineTo(sx0, sy0 + rowH + tilt);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(12, 11, 9, 0.30)';
          ctx.lineWidth = 1;
          for (let k = 0; k < 3; k++) {
            const wy = sy0 + rowH * (0.25 + k * 0.22);
            ctx.beginPath();
            ctx.moveTo(sx0 + 3, wy);
            ctx.quadraticCurveTo(sx0 + segW * 0.5, wy + (k - 1) * 1.6, sx0 + segW - 3, wy + 0.8);
            ctx.stroke();
          }
        } else if (kind === 'shingle') {
          // 腐朽木瓦：宽度随机、下缘参差、个别缺失
          let px = sx0;
          for (let k = 0; k < shingleW.length; k++) {
            const w = shingleW[k];
            const sh = shingleShade[k];
            // 约 1/9 的木瓦缺失，露出深色底层
            if (sh <= -5) {
              ctx.fillStyle = '#0b0a08';
              ctx.fillRect(px + 0.5, sy0 + 1, w - 1, rowH - 2);
            } else {
              ctx.fillStyle = coldDecay
                ? `rgb(${42 + sh}, ${37 + sh}, ${32 + sh})`
                : `rgb(${46 + sh}, ${37 + sh}, ${28 + sh})`;
              ctx.fillRect(px + 0.35, sy0 + 0.5, w - 0.7, rowH - 1 + shingleDrop[k]);
              ctx.fillStyle = 'rgba(10, 9, 7, 0.2)';
              ctx.fillRect(px + w * 0.42, sy0 + 2, 1, rowH * 0.7);
            }
            px += w;
          }
        } else {
          // 锈铁皮补丁：细密瓦楞 + 锈斑
          ctx.fillStyle = coldDecay
            ? `rgb(${50 + shade}, ${40 + shade}, ${33 + shade})`
            : `rgb(${56 + shade}, ${40 + shade}, ${28 + shade})`;
          ctx.fillRect(sx0, sy0, segW, rowH + 1.5);
          for (let k = 0; k < segW; k += 4) {
            ctx.fillStyle = k % 8 === 0 ? 'rgba(0, 0, 0, 0.20)' : 'rgba(150, 132, 112, 0.06)';
            ctx.fillRect(sx0 + k, sy0, 1.6, rowH + 1.5);
          }
          ctx.fillStyle = '#1c1916';
          ctx.fillRect(sx0 + 3, sy0 + 3, 1.6, 1.6);
          ctx.fillRect(sx0 + segW - 5, sy0 + rowH - 4, 1.6, 1.6);
        }
        // 上一行压住下一行的瓦唇阴影（参差的波浪下缘）
        ctx.fillStyle = 'rgba(5, 5, 4, 0.48)';
        ctx.beginPath();
        ctx.moveTo(sx0, sy0 + rowH - 1.6);
        const steps = Math.max(2, Math.floor(segW / 9));
        for (let k = 1; k <= steps; k++) {
          const px = sx0 + (segW * k) / steps;
          ctx.lineTo(px, sy0 + rowH - 1.6 + Math.sin(px * 0.37 + sy0) * 0.9);
        }
        ctx.lineTo(sx0 + segW, sy0 + rowH + 1.4);
        ctx.lineTo(sx0, sy0 + rowH + 1.4);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(160, 152, 138, 0.045)';
        ctx.fillRect(sx0 + 1, sy0 + 0.5, segW - 2, 1.2);
      });
      x += segW;
    }
    y += rowH;
  }

  // 撕裂破口：不规则暗洞 + 翻起的浅色毡边
  for (let i = 0; i < 6; i++) {
    const hx = rng() * S;
    const hy = rng() * S;
    const hr = 2.2 + rng() * 4.2;
    const pts: number[] = [];
    const n = 9;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = hr * (0.55 + rng() * 0.6);
      pts.push(Math.cos(a) * rr * 1.5, Math.sin(a) * rr);
    }
    wrapDraw(S, (ox, oy) => {
      const cx = hx + ox;
      const cy = hy + oy;
      if (cx < -30 || cx > S + 30 || cy < -30 || cy > S + 30) return;
      ctx.fillStyle = 'rgba(70, 64, 54, 0.14)';
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const px = cx + pts[k * 2] * 1.25;
        const py = cy + pts[k * 2 + 1] * 1.25 - 0.8;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(10, 9, 8, 0.82)';
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const px = cx + pts[k * 2];
        const py = cy + pts[k * 2 + 1];
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    });
  }

  // 大面积苔藓、雨水污渍与锈水流痕（低对比，打破任何残余格子感）
  for (let i = 0; i < 80; i++) {
    const lx = rng() * S;
    const ly = rng() * S;
    const rad = 12 + rng() * 42;
    const pick = rng();
    const col = pick < 0.40
      ? coldDecay ? 'rgba(46, 50, 44, 0.42)' : 'rgba(44, 58, 34, 0.40)' // 冷灰苔藓
      : pick < 0.78
      ? 'rgba(7, 7, 6, 0.40)' // 焦黑水渍
      : coldDecay ? 'rgba(78, 52, 34, 0.22)' : 'rgba(86, 54, 30, 0.24)'; // 锈水
    const sxScale = 0.6 + rng() * 0.9;
    wrapDraw(S, (ox, oy) => {
      const cx = lx + ox;
      const cy = ly + oy;
      if (cx < -rad * 1.6 || cx > S + rad * 1.6 || cy < -rad * 1.6 || cy > S + rad * 1.6) return;
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, rad);
      g.addColorStop(0, col);
      g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(sxScale, 1);
      ctx.translate(-cx, -cy);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // 细碎苔点
  for (let i = 0; i < 300; i++) {
    const px = rng() * S;
    const py = rng() * S;
    ctx.fillStyle = rng() > 0.5 ? 'rgba(58, 62, 54, 0.35)' : 'rgba(8, 8, 7, 0.38)';
    ctx.fillRect(px, py, 1 + rng() * 2.4, 1 + rng() * 1.6);
  }

  return c;
}

/**
 * ?v-cine=b 电影级 Darkwood 诡异森林树冠烘焙（512x512）：
 * 对标原作 8 张实机截图：粗细张力极强的扭曲蛇形枝干 + 真实锯齿/针叶树叶簇 + 多层明暗景深。
 * - top=false（中低层树冠）：较靠近地面散射光，呈深冷灰绿/枯褐炭墨色（非死黑），含粗主枝与密集透空叶簇；
 * - top=true（最高空树梢与失焦暗冠）：离地面光源最远、最贴近镜头，含柔和非对称暗冠失焦晕 + 最深邃漆黑长伸枯枝与顶叶簇。
 */
function bakeCanopyCine(variantIndex: number, coldDecay: boolean, top: boolean): HTMLCanvasElement {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S * 0.5;
  const cy = S * 0.5;
  const rng = createRng((top ? 9203 : 4421) + variantIndex * 1597);

  // 强非对称有机包络（进一步拉长单棵树主枝伸展半径，还原原作横跨半屏的巨型长枝）
  const phA = rng() * Math.PI * 2;
  const phB = rng() * Math.PI * 2;
  const phC = rng() * Math.PI * 2;
  const maxReachAt = (angle: number) =>
    S *
    clamp(
      0.38 + 0.095 * Math.sin(angle * 2 + phA) + 0.06 * Math.cos(angle * 3 + phB) + 0.025 * Math.sin(angle * 5 + phC),
      0.24,
      0.495
    );

  // 绘制真实锯齿/簇状树叶剪影团（阔叶丛 / 腐朽枝叶簇，对标原作图 5 左下角与图 6 下方）
  const paintFoliageCluster = (
    lx: number,
    ly: number,
    dir: number,
    radius: number,
    leafCount: number,
    colMain: string,
    colEdge: string,
    isNeedle: boolean
  ) => {
    ctx.save();
    for (let i = 0; i < leafCount; i++) {
      const a = dir + (rng() - 0.5) * (isNeedle ? 1.55 : Math.PI * 2);
      const distR = radius * Math.pow(rng(), 0.65);
      const px = lx + Math.cos(a) * distR;
      const py = ly + Math.sin(a) * distR;
      const leafL = isNeedle ? 7 + rng() * 11 : 4.5 + rng() * 7.5;
      const leafW = isNeedle ? 1.3 + rng() * 1.4 : 2.6 + rng() * 3.8;
      const rot = isNeedle ? a + (rng() - 0.5) * 0.35 : a + (rng() - 0.5) * 1.2;
      ctx.fillStyle = i % 3 === 0 ? colEdge : colMain;
      ctx.beginPath();
      ctx.ellipse(px, py, leafL, leafW, rot, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  // 绘制粗细张力极强的诡异扭曲枝干（蛇形弯曲、血管状分叉、沿途挂载树叶簇）
  const drawGnarledLimb = (
    x0: number,
    y0: number,
    ang: number,
    len: number,
    w0: number,
    depth: number,
    col: string,
    ridgeCol: string | null,
    leafSpec: { prob: number; colMain: string; colEdge: string; isNeedle: boolean; scale: number } | null
  ) => {
    let x = x0;
    let y = y0;
    let a = ang;
    const steps = depth >= 3 ? 6 : 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const seg = (len / steps) * (0.76 + rng() * 0.48);
      // 诡异蛇形扭曲弯折
      a += (rng() - 0.5) * (0.54 + (4 - depth) * 0.18);
      const midA = a + (rng() - 0.5) * 0.42;
      const mx = x + Math.cos(midA) * seg * 0.52;
      const my = y + Math.sin(midA) * seg * 0.52;
      const nx = x + Math.cos(a) * seg;
      const ny = y + Math.sin(a) * seg;

      const outR = Math.hypot(nx - cx, ny - cy);
      const outA = Math.atan2(ny - cy, nx - cx);
      if (outR > maxReachAt(outA)) break;

      const w = Math.max(0.65, w0 * Math.pow(1 - t * 0.68, 1.2));
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(mx, my, nx, ny);
      ctx.stroke();

      // 粗枝侧面极克制的环境微亮脊（体现枝干圆柱体积而非纸片）
      if (ridgeCol && w > 2.2) {
        ctx.strokeStyle = ridgeCol;
        ctx.lineWidth = Math.max(0.8, w * 0.24);
        ctx.beginPath();
        ctx.moveTo(x - 0.9, y - 0.9);
        ctx.quadraticCurveTo(mx - 0.9, my - 0.9, nx - 0.8, ny - 0.8);
        ctx.stroke();
      }

      // 在次级与末梢枝条挂载真实树叶剪影簇
      if (leafSpec && depth <= 2 && s >= 1 && rng() < leafSpec.prob) {
        const lRad = (10 + rng() * 14) * leafSpec.scale;
        const lCnt = Math.round((7 + rng() * 9) * leafSpec.scale);
        paintFoliageCluster(nx, ny, a, lRad, lCnt, leafSpec.colMain, leafSpec.colEdge, leafSpec.isNeedle);
      }

      // 不对称血管状分叉
      if (depth > 0 && s >= 1) {
        const forks = depth >= 3 ? (rng() < 0.78 ? 2 : 1) : rng() < 0.58 ? 1 : 0;
        for (let f = 0; f < forks; f++) {
          const side = f === 0 ? (rng() > 0.5 ? 1 : -1) : -1;
          const spread = side * (0.36 + rng() * 0.62);
          drawGnarledLimb(
            nx,
            ny,
            a + spread,
            len * (0.48 + rng() * 0.28),
            Math.max(0.7, w * 0.62),
            depth - 1,
            col,
            ridgeCol,
            leafSpec
          );
        }
      }

      x = nx;
      y = ny;
    }
  };

  // 4 种树种的差异化树叶配置：不是每棵树都有叶子，也不是每根树枝都有叶子
  // 0: 光秃诡异枯枝老树（无叶） 1: 蛇形扭曲死木黑藤（无叶） 2: 局部枝条挂稀疏锯齿阔叶 3: 局部枝条挂稀疏暗松针
  const isNeedle = variantIndex === 3;
  const hasAnyLeaves = variantIndex === 2 || variantIndex === 3;
  const leafDensity = variantIndex === 2 ? 0.52 : variantIndex === 3 ? 0.46 : 0;

  if (!top) {
    // ===== 中低层树冠：靠近地面漫反射光，呈深冷灰绿/枯褐炭墨层次，部分枝条局部挂叶 =====
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rng() * 0.9;
      const d = i === 0 ? 6 : 26 + rng() * 34;
      const ox = cx + Math.cos(a) * d;
      const oy = cy + Math.sin(a) * d;
      const rad = i === 0 ? 60 + rng() * 14 : 44 + rng() * 20;
      const g = ctx.createRadialGradient(ox, oy, rad * 0.1, ox, oy, rad);
      g.addColorStop(0, coldDecay ? 'rgba(10, 13, 12, 0.50)' : 'rgba(9, 15, 10, 0.50)');
      g.addColorStop(0.55, coldDecay ? 'rgba(16, 20, 18, 0.22)' : 'rgba(14, 22, 15, 0.22)');
      g.addColorStop(1, 'rgba(10, 12, 11, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ox, oy, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. 低层半透冷灰墨/暗绿枝干网（最浅一层暗，提供纵深过渡；仅少数枝条带叶）
    const subCol = coldDecay ? 'rgba(26, 31, 28, 0.54)' : 'rgba(22, 32, 22, 0.54)';
    const subLeafMain = coldDecay ? 'rgba(22, 28, 24, 0.52)' : 'rgba(19, 31, 20, 0.54)';
    const subLeafEdge = coldDecay ? 'rgba(44, 50, 42, 0.36)' : 'rgba(38, 52, 34, 0.38)';
    const subBoughs = 5 + (variantIndex % 2);
    for (let i = 0; i < subBoughs; i++) {
      const a = (i / subBoughs) * Math.PI * 2 + (rng() - 0.5) * 0.58;
      const len = 168 + rng() * 84;
      // 仅约 40% 的主枝带叶，其余枝条保持光秃
      const branchLeaf = hasAnyLeaves && rng() < 0.42
        ? { prob: leafDensity * 0.85, colMain: subLeafMain, colEdge: subLeafEdge, isNeedle, scale: 0.92 }
        : null;
      drawGnarledLimb(cx, cy, a, len, 6.4 + rng() * 2.4, 3, subCol, null, branchLeaf);
    }

    // 3. 中层粗壮扭曲主枝与局部深暗树叶团（带微弱暗褐灰受光背脊）
    const mainCol = 'rgba(11, 13, 12, 0.84)';
    const ridgeCol = coldDecay ? 'rgba(58, 60, 52, 0.28)' : 'rgba(54, 62, 46, 0.28)';
    const mainLeafMain = coldDecay ? 'rgba(13, 17, 15, 0.76)' : 'rgba(12, 21, 14, 0.76)';
    const mainLeafEdge = coldDecay ? 'rgba(32, 38, 33, 0.46)' : 'rgba(28, 42, 28, 0.46)';
    const mainBoughs = 6 + (variantIndex % 2);
    for (let i = 0; i < mainBoughs; i++) {
      const a = (i / mainBoughs) * Math.PI * 2 + (rng() - 0.5) * 0.5;
      const len = 185 + rng() * 88;
      const branchLeaf = hasAnyLeaves && rng() < 0.48
        ? { prob: leafDensity, colMain: mainLeafMain, colEdge: mainLeafEdge, isNeedle, scale: 0.88 }
        : null;
      drawGnarledLimb(cx, cy, a, len, 9.5 + rng() * 3.8, 3, mainCol, ridgeCol, branchLeaf);
    }
  } else {
    // ===== 最高空树梢与失焦暗冠层：离地面光源最远、最靠近镜头，深邃漆黑、诡异且压迫感极强 =====
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rng() * 1.1;
      const d = i === 0 ? 8 : 26 + rng() * 44;
      const ox = cx + Math.cos(a) * d;
      const oy = cy + Math.sin(a) * d;
      const rad = i === 0 ? 82 + rng() * 18 : 54 + rng() * 24;
      const hg = ctx.createRadialGradient(ox, oy, rad * 0.08, ox, oy, rad);
      hg.addColorStop(0, 'rgba(3, 4, 4, 0.72)');
      hg.addColorStop(0.45, 'rgba(5, 6, 6, 0.36)');
      hg.addColorStop(0.78, 'rgba(6, 7, 7, 0.10)');
      hg.addColorStop(1, 'rgba(6, 7, 7, 0)');
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.arc(ox, oy, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. 顶层高空粗细极具张力的漆黑扭曲长枝 + 极克制的局部顶层叶簇
    const topLeafMain = 'rgba(4, 5, 5, 0.88)';
    const topLeafEdge = coldDecay ? 'rgba(14, 17, 16, 0.62)' : 'rgba(12, 18, 13, 0.62)';
    const topBoughs = 5 + (variantIndex % 2);
    for (let i = 0; i < topBoughs; i++) {
      const a = (i / topBoughs) * Math.PI * 2 + (rng() - 0.5) * 0.55;
      const len = 182 + rng() * 92;
      const branchLeaf = hasAnyLeaves && rng() < 0.36
        ? { prob: leafDensity * 0.75, colMain: topLeafMain, colEdge: topLeafEdge, isNeedle, scale: 0.82 }
        : null;
      drawGnarledLimb(cx, cy, a, len, 8.0 + rng() * 3.4, 3, 'rgba(4, 5, 5, 0.94)', null, branchLeaf);
    }

    // 3. 3~5 根不对称探出的极长诡异主枯枝（对标原作图 2、图 3 横跨视野的巨型蛇形长枝）
    const reachCount = variantIndex <= 1 ? 5 : 3;
    for (let i = 0; i < reachCount; i++) {
      const a = phA + (i / reachCount) * Math.PI * 2 + (rng() - 0.5) * 0.55;
      drawGnarledLimb(cx, cy, a, 220 + rng() * 48, 7.2 + rng() * 2.6, 2, 'rgba(3, 4, 4, 0.95)', null, null);
    }
  }

  return c;
}

/** 与调色无关、可在 cine a/b 之间共享的基础烘焙件（避免切换 Variant 时重复烘焙地面与墙体） */
/**
 * ?v-cine=b：林冠斑驳地面投影的半透明“叶隙透光”图案（256x256 无缝平铺，世界锚定，零外部资源）。
 * RGB = 偏冷的深蓝绿灰阴影色（不是纯黑），A = 投影不透明度：浓密叶团处约 0.48，叶隙光斑处降到约 0.12。
 * 用于替换旧版均一 rgba(4,5,5,0.44) 的实心冠影；平均不透明度（约 0.38）略低于旧版，不额外推高暗部占比。
 */
function bakeCanopyDapple(coldDecay: boolean): HTMLCanvasElement {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const d = img.data;

  const nLeaf = makeTileNoise(6, 4241);
  const nGap = makeTileNoise(14, 6007);
  const nFine = makeTileNoise(32, 8123);
  const cr = coldDecay ? 6 : 5;
  const cg = coldDecay ? 9 : 7;
  const cb = coldDecay ? 12 : 7;

  for (let y = 0; y < S; y++) {
    const ny = y / S;
    for (let x = 0; x < S; x++) {
      const nx = x / S;
      const leaf = nLeaf(nx * 6, ny * 6) * 0.55 + nGap(nx * 14, ny * 14) * 0.45;
      const gap = smooth01(0.54, 0.68, leaf); // 叶隙透光光斑
      const clump = smooth01(0.42, 0.28, leaf); // 浓密叶团（更深）
      const fine = nFine(nx * 32, ny * 32) - 0.5;
      const a = clamp(0.42 - gap * 0.30 + clump * 0.07 + fine * 0.06, 0.08, 0.52);
      const o = (y * S + x) * 4;
      d[o] = cr;
      d[o + 1] = cg;
      d[o + 2] = cb;
      d[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * R3 ?v-cine=b：地面高频颗粒肌理（参考 ART_DIRECTION_R3 第 3 条"炭笔在粗纸上的皴擦"）。
 * 在基础林地反照率（256 无缝平铺）之上烘焙一份带颗粒的副本：逐像素 ±9% 亮度抖动 + 2px 级细噪 +
 * 1–3px 明暗碎点（碎石/苔点）+ 小片落叶。明暗碎点数量与透明度大致对称，平均亮度基本不变、对比克制；
 * 与渲染层按 GROUND_MACRO_SCALE 放大的低频湿泥斑叠加，形成"大块明暗 + 细碎肌理"。只在启动/切换 Variant 时执行一次。
 */
function bakeGroundGrain(base: HTMLCanvasElement, coldDecay: boolean): HTMLCanvasElement {
  const S = base.width;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(base, 0, 0);

  // 1) 逐像素颗粒：独立哈希抖动（天然无缝）+ 周期 128 的 2px 级细噪（S = 256 时可整除，保证无缝）
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  const rng = createRng(6791);
  const nGrain = makeTileNoise(128, 3571);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      const k = 1 + (rng() - 0.5) * 0.18 + (nGrain((x / S) * 128, (y / S) * 128) - 0.5) * 0.16;
      d[o] = clamp(Math.round(d[o] * k), 0, 255);
      d[o + 1] = clamp(Math.round(d[o + 1] * k), 0, 255);
      d[o + 2] = clamp(Math.round(d[o + 2] * k), 0, 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  // 2) 1–3px 明暗碎点（碎石、苔点、泥粒），越界处 9 宫格重复绘制保证无缝
  const light = coldDecay ? 'rgba(112, 106, 96, 0.30)' : 'rgba(104, 102, 86, 0.30)';
  const dark = coldDecay ? 'rgba(10, 9, 8, 0.36)' : 'rgba(10, 10, 8, 0.36)';
  for (let i = 0; i < 900; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const r = 0.5 + rng() * rng() * 1.2;
    ctx.fillStyle = rng() < 0.5 ? light : dark;
    wrapDraw(S, (ox, oy) => {
      const px = x + ox;
      const py = y + oy;
      if (px < -3 || px > S + 3 || py < -3 || py > S + 3) return;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // 3) 小片落叶（2–4px 细长椭圆，灰褐/骨白，低对比）
  for (let i = 0; i < 240; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const rx = 1.2 + rng() * 1.6;
    const ry = 0.5 + rng() * 0.6;
    const rot = rng() * Math.PI;
    const t = rng();
    ctx.fillStyle =
      t < 0.45 ? 'rgba(74, 60, 46, 0.34)' : t < 0.75 ? 'rgba(96, 90, 80, 0.24)' : 'rgba(20, 17, 14, 0.34)';
    wrapDraw(S, (ox, oy) => {
      const px = x + ox;
      const py = y + oy;
      if (px < -5 || px > S + 5 || py < -5 || py > S + 5) return;
      ctx.beginPath();
      ctx.ellipse(px, py, rx, ry, rot, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  return c;
}

interface BaseAtlasParts {
  groundAlbedo: HTMLCanvasElement;
  groundNormalWet: HTMLCanvasElement;
  woodAlbedo: HTMLCanvasElement;
  woodNormalWet: HTMLCanvasElement;
  wallLogAlbedo: HTMLCanvasElement;
  wallRuinAlbedo: HTMLCanvasElement;
  trunkSprites: HTMLCanvasElement[];
}

const cachedBaseByPalette: Partial<Record<'a' | 'b', BaseAtlasParts>> = {};
const cachedAtlasByMode: Record<string, ProceduralAtlas> = {};

function getBaseParts(mode: 'a' | 'b'): BaseAtlasParts {
  const existing = cachedBaseByPalette[mode];
  if (existing) return existing;
  const coldDecay = mode === 'b';
  const ground = bakeGroundPair(coldDecay);
  const wood = bakeWoodPair(coldDecay);
  const parts: BaseAtlasParts = {
    groundAlbedo: ground.albedo,
    groundNormalWet: ground.normalWet,
    woodAlbedo: wood.albedo,
    woodNormalWet: wood.normalWet,
    wallLogAlbedo: bakeWallLogAlbedo(coldDecay),
    wallRuinAlbedo: bakeWallRuinAlbedo(coldDecay),
    trunkSprites: [bakeTrunkSprite(0, coldDecay), bakeTrunkSprite(1, coldDecay)],
  };
  cachedBaseByPalette[mode] = parts;
  return parts;
}

/**
 * 获取程序化图集：按 palette（a/b）× cine（a/b）缓存。
 * cine='a' 时与 release_v1 完全一致；cine='b' 替换屋顶、树冠并新增低频地表叠加层。
 */
export function getProceduralAtlas(paletteMode: 'a' | 'b' = 'b', cineMode: 'a' | 'b' = 'a'): ProceduralAtlas {
  const mode: 'a' | 'b' = paletteMode === 'a' ? 'a' : 'b';
  const cine = cineMode === 'b';
  const key = `${mode}_${cine ? 'b' : 'a'}`;
  const existing = cachedAtlasByMode[key];
  if (existing) return existing;

  const coldDecay = mode === 'b';
  const base = getBaseParts(mode);
  const macro = cine ? bakeGroundMacro(coldDecay) : null;
  const atlas: ProceduralAtlas = {
    // R3：cine=b 使用叠加高频颗粒肌理的地面副本；cine=a 与 release_v1 完全一致
    groundAlbedo: cine ? bakeGroundGrain(base.groundAlbedo, coldDecay) : base.groundAlbedo,
    groundNormalWet: base.groundNormalWet,
    woodAlbedo: base.woodAlbedo,
    woodNormalWet: base.woodNormalWet,
    wallLogAlbedo: base.wallLogAlbedo,
    wallRuinAlbedo: base.wallRuinAlbedo,
    roofAlbedo: cine ? bakeRoofCine(coldDecay) : bakeRoofShingles(coldDecay),
    canopySprites: cine
      ? [0, 1, 2, 3].map((i) => bakeCanopyCine(i, coldDecay, false))
      : [
          bakeCanopyVariant(0, coldDecay),
          bakeCanopyVariant(1, coldDecay),
          bakeCanopyVariant(2, coldDecay),
          bakeCanopyVariant(3, coldDecay),
        ],
    canopyTopSprites: cine
      ? [0, 1, 2, 3].map((i) => bakeCanopyCine(i, coldDecay, true))
      : [
          bakeCanopyTopVariant(0, coldDecay),
          bakeCanopyTopVariant(1, coldDecay),
          bakeCanopyTopVariant(2, coldDecay),
          bakeCanopyTopVariant(3, coldDecay),
        ],
    trunkSprites: base.trunkSprites,
    groundMacroAlbedo: macro ? macro.albedo : null,
    groundMacroWet: macro ? macro.wet : null,
    canopyDapple: cine ? bakeCanopyDapple(coldDecay) : null,
    cine,
  };
  cachedAtlasByMode[key] = atlas;
  return atlas;
}
