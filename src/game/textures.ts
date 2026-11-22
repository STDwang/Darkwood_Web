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
}

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
  const S = 256;
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
  const nPuddle = makeTileNoise(3, 9137);

  const height = new Float32Array(S * S);
  const puddle = new Float32Array(S * S);

  const aImg = actx.createImageData(S, S);
  const aData = aImg.data;

  // 构建统一高度场与林地反照率（冷腐油画模式彻底压低绿通道主导）
  for (let y = 0; y < S; y++) {
    const ny = y / S;
    for (let x = 0; x < S; x++) {
      const nx = x / S;
      const idx = y * S + x;

      const warpX = (nLow(nx * 4 + 1.3, ny * 4) - 0.5) * 0.26;
      const warpY = (nLow(nx * 4, ny * 4 + 2.7) - 0.5) * 0.26;

      const f1 = nLow((nx + warpX) * 4, (ny + warpY) * 4);
      const f2 = nMid((nx + warpX * 0.6) * 10, (ny + warpY * 0.6) * 10);
      const f3 = nHi(nx * 24, ny * 24);
      const h = f1 * 0.48 + f2 * 0.34 + f3 * 0.18;
      height[idx] = h;

      // 自然洼地积水遮罩
      const pRaw = nPuddle(nx * 3, ny * 3) * 0.62 + f1 * 0.38;
      const pMask = clamp((0.39 - pRaw) * 6.8, 0, 1);
      puddle[idx] = pMask;

      let r: number;
      let g: number;
      let b: number;

      if (coldDecay) {
        // 东欧冷腐油画调色：潮湿深褐腐殖土 + 腐烂枯叶 + 冷灰苔藓斑块 + 暗黑浅水洼
        const lichen = clamp((f2 - 0.56) * 2.6, 0, 1) * (1 - pMask);
        const leafRot = clamp((f1 - 0.48) * 2.2, 0, 1) * (1 - pMask);
        r = clamp(32 + h * 34 + leafRot * 14 - lichen * 4 - pMask * 16, 12, 86);
        g = clamp(29 + h * 30 + leafRot * 7 + lichen * 2 - pMask * 14, 11, 78);
        b = clamp(25 + h * 24 - leafRot * 4 + lichen * 6 - pMask * 7, 10, 68);
      } else {
        // 初版偏绿对照组
        const moss = clamp((f2 - 0.52) * 2.7, 0, 1) * (1 - pMask);
        r = clamp(23 + h * 28 - moss * 9 - pMask * 10, 10, 70);
        g = clamp(27 + h * 29 + moss * 16 - pMask * 8, 12, 76);
        b = clamp(20 + h * 18 - moss * 5 + pMask * 4, 10, 56);
      }

      const o = idx * 4;
      aData[o] = r;
      aData[o + 1] = g;
      aData[o + 2] = b;
      aData[o + 3] = 255;
    }
  }
  actx.putImageData(aImg, 0, 0);

  // 叠加东欧油画厚涂笔触（腐烂松针、枯叶、冷灰苔簇、湿暗裂缝）
  const rng = createRng(4419);
  for (let i = 0; i < 520; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const ang = rng() * Math.PI * 2;
    const len = 5 + rng() * 16;
    const w = 1.0 + rng() * 2.6;
    const tone = rng();
    if (coldDecay) {
      actx.strokeStyle =
        tone < 0.30
          ? 'rgba(66, 48, 34, 0.48)' // 腐烂松针与枯叶
          : tone < 0.54
          ? 'rgba(46, 48, 45, 0.44)' // 冷灰苔藓斑块
          : tone < 0.80
          ? 'rgba(13, 12, 11, 0.54)' // 暗泥沟壑裂缝
          : 'rgba(84, 72, 56, 0.32)'; // 枯枝碎叶高光
    } else {
      actx.strokeStyle =
        tone < 0.28
          ? 'rgba(58, 46, 31, 0.45)'
          : tone < 0.55
          ? 'rgba(30, 44, 26, 0.42)'
          : tone < 0.80
          ? 'rgba(14, 15, 11, 0.50)'
          : 'rgba(72, 62, 44, 0.28)';
    }
    actx.lineWidth = w;
    actx.lineCap = 'round';
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        const px = x + ox;
        const py = y + oy;
        if (px < -22 || px > S + 22 || py < -22 || py > S + 22) continue;
        actx.beginPath();
        actx.moveTo(px, py);
        actx.quadraticCurveTo(
          px + Math.cos(ang + 0.35) * len * 0.5,
          py + Math.sin(ang + 0.35) * len * 0.5,
          px + Math.cos(ang) * len,
          py + Math.sin(ang) * len
        );
        actx.stroke();
      }
    }
  }

  // 散落冷灰碎石、腐叶残片与暗泥块
  for (let i = 0; i < 60; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const r = 1.2 + rng() * 2.4;
    actx.fillStyle = coldDecay
      ? rng() > 0.45
        ? 'rgba(72, 70, 65, 0.46)'
        : 'rgba(18, 15, 13, 0.58)'
      : rng() > 0.5
      ? 'rgba(66, 68, 60, 0.45)'
      : 'rgba(20, 17, 14, 0.55)';
    actx.beginPath();
    actx.arc(x, y, r, 0, Math.PI * 2);
    actx.fill();
  }

  // 生成切线空间微法线贴图 + 蓝通道编码积水遮罩
  const nImg = nctx.createImageData(S, S);
  const nData = nImg.data;
  const strength = coldDecay ? 7.0 : 5.8;

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

      // 软化机械网格感：更自然的腐蚀木缝与轻微起伏边缘
      const wobble = Math.sin(x * 0.08 + row * 2.1) * 0.55;
      const seamY =
        localY < 1.8 + wobble || localY >= plankH - 1.3
          ? 0.14
          : localY < 3.4 || localY >= plankH - 2.8
          ? 0.58
          : 1;
      const seamX = localX < 2 ? 0.22 : localX === 2 ? 0.68 : 1;
      const bevel = Math.min(seamY, seamX);

      const h = bevel * (0.60 + grain * 0.26 + streak * 0.14);
      height[idx] = h;

      const grime = (1 - bevel) * 24 + clamp((0.50 - stain) * 38, 0, 24);
      let r: number;
      let g: number;
      let b: number;
      if (coldDecay) {
        // 潮湿做旧冷灰褐木板，降低暖黄饱和度，增强水渍与霉斑层次
        r = clamp(56 + rowTint * 0.8 + grain * 24 + streak * 10 - grime, 12, 92);
        g = clamp(48 + rowTint * 0.68 + grain * 20 + streak * 8 - grime, 10, 82);
        b = clamp(39 + rowTint * 0.55 + grain * 15 + streak * 6 - grime, 9, 70);
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

// 烘焙 2 种粗犷盘根错节的 128x128 爪状板根树干（树皮纵裂沟壑 + 根部暗泥坑 + 零星冷灰青苔）
function bakeTrunkSprite(variant: number, coldDecay: boolean): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S * 0.5;
  const cy = S * 0.5;
  const rng = createRng(5501 + variant * 811);

  // 根部深暗泥坑与湿润淤泥晕
  const pit = ctx.createRadialGradient(cx, cy, 10, cx, cy, 60);
  pit.addColorStop(0, 'rgba(5, 5, 5, 0.84)');
  pit.addColorStop(0.58, 'rgba(12, 10, 9, 0.46)');
  pit.addColorStop(1, 'rgba(9, 8, 6, 0)');
  ctx.fillStyle = pit;
  ctx.beginPath();
  ctx.arc(cx, cy, 60, 0, Math.PI * 2);
  ctx.fill();

  // 8-10 条粗犷爪状板根 + 末端分叉须根抓入腐泥
  const roots = 8 + variant * 2;
  for (let i = 0; i < roots; i++) {
    const a = (i / roots) * Math.PI * 2 + (rng() - 0.5) * 0.42;
    const rLen = 30 + rng() * 27;
    const midA = a + (rng() - 0.5) * 0.46;
    const mx = cx + Math.cos(midA) * (rLen * 0.54);
    const my = cy + Math.sin(midA) * (rLen * 0.54);
    const ex = cx + Math.cos(a) * rLen;
    const ey = cy + Math.sin(a) * rLen;

    // 板根投影
    ctx.strokeStyle = 'rgba(6, 5, 4, 0.86)';
    ctx.lineWidth = 9.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + 2, cy + 2);
    ctx.quadraticCurveTo(mx + 2, my + 2, ex + 1.5, ey + 1.5);
    ctx.stroke();

    // 粗糙树皮板根本体
    ctx.strokeStyle = coldDecay ? (variant === 0 ? '#26201a' : '#211d19') : variant === 0 ? '#2f231a' : '#29211b';
    ctx.lineWidth = 6.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();

    // 末端细碎分叉须根
    ctx.strokeStyle = '#14110e';
    ctx.lineWidth = 2.2;
    for (const fork of [-0.45, 0.45]) {
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + Math.cos(a + fork) * 9, ey + Math.sin(a + fork) * 9);
      ctx.stroke();
    }

    // 板根脊背微光与沟壑
    ctx.strokeStyle = coldDecay ? 'rgba(96, 88, 78, 0.36)' : 'rgba(96, 78, 58, 0.38)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx - 1, cy - 1);
    ctx.quadraticCurveTo(mx - 1, my - 1, ex * 0.82 + cx * 0.18, ey * 0.82 + cy * 0.18);
    ctx.stroke();

    // 零星冷灰青苔斑块
    if (rng() > 0.45) {
      ctx.fillStyle = coldDecay ? 'rgba(64, 70, 64, 0.48)' : 'rgba(54, 74, 42, 0.55)';
      ctx.beginPath();
      ctx.ellipse(mx, my, 5.5, 3.0, a, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 不规则纵裂树干横截面
  const trunkR = 24;
  ctx.fillStyle = '#110e0c';
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const wobble = trunkR + Math.sin(a * 5 + variant) * 2.8 + (rng() - 0.5) * 2.4;
    const px = cx + Math.cos(a) * wobble;
    const py = cy + Math.sin(a) * wobble;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = coldDecay ? '#2f2720' : '#38291e';
  ctx.beginPath();
  ctx.arc(cx, cy, trunkR - 3, 0, Math.PI * 2);
  ctx.fill();

  // 深邃树皮纵裂沟壑
  ctx.strokeStyle = '#120e0b';
  ctx.lineWidth = 1.7;
  for (let i = 0; i < 15; i++) {
    const a = (i / 15) * Math.PI * 2 + rng() * 0.22;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5);
    ctx.lineTo(cx + Math.cos(a) * (trunkR - 0.5), cy + Math.sin(a) * (trunkR - 0.5));
    ctx.stroke();
  }

  // 西北侧冷灰受光面与冷灰青苔
  ctx.fillStyle = coldDecay ? 'rgba(110, 102, 92, 0.34)' : 'rgba(104, 86, 62, 0.36)';
  ctx.beginPath();
  ctx.arc(cx - 5, cy - 5, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = coldDecay ? 'rgba(72, 78, 72, 0.42)' : 'rgba(58, 79, 44, 0.45)';
  ctx.beginPath();
  ctx.arc(cx - 8, cy + 4, 6.2, 0, Math.PI * 2);
  ctx.fill();

  return c;
}

const cachedAtlasByMode: Partial<Record<'a' | 'b', ProceduralAtlas>> = {};

export function getProceduralAtlas(paletteMode: 'a' | 'b' = 'b'): ProceduralAtlas {
  const mode: 'a' | 'b' = paletteMode === 'a' ? 'a' : 'b';
  const existing = cachedAtlasByMode[mode];
  if (existing) return existing;

  const coldDecay = mode === 'b';
  const ground = bakeGroundPair(coldDecay);
  const wood = bakeWoodPair(coldDecay);
  const atlas: ProceduralAtlas = {
    groundAlbedo: ground.albedo,
    groundNormalWet: ground.normalWet,
    woodAlbedo: wood.albedo,
    woodNormalWet: wood.normalWet,
    wallLogAlbedo: bakeWallLogAlbedo(coldDecay),
    wallRuinAlbedo: bakeWallRuinAlbedo(coldDecay),
    roofAlbedo: bakeRoofShingles(coldDecay),
    canopySprites: [
      bakeCanopyVariant(0, coldDecay),
      bakeCanopyVariant(1, coldDecay),
      bakeCanopyVariant(2, coldDecay),
      bakeCanopyVariant(3, coldDecay),
    ],
    canopyTopSprites: [
      bakeCanopyTopVariant(0, coldDecay),
      bakeCanopyTopVariant(1, coldDecay),
      bakeCanopyTopVariant(2, coldDecay),
      bakeCanopyTopVariant(3, coldDecay),
    ],
    trunkSprites: [bakeTrunkSprite(0, coldDecay), bakeTrunkSprite(1, coldDecay)],
  };
  cachedAtlasByMode[mode] = atlas;
  return atlas;
}
