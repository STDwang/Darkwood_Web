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
  canopySprites: HTMLCanvasElement[]; // 4 distinct 320x320 hand-painted Baltic tree canopies
  trunkSprites: HTMLCanvasElement[];  // 2 distinct 128x128 gnarled trunk & root-flare sprites
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

function bakeGroundPair(): { albedo: HTMLCanvasElement; normalWet: HTMLCanvasElement } {
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

  // Build unified height + Eastern European dark humus / peat / damp moss albedo
  for (let y = 0; y < S; y++) {
    const ny = y / S;
    for (let x = 0; x < S; x++) {
      const nx = x / S;
      const idx = y * S + x;

      const warpX = (nLow(nx * 4 + 1.3, ny * 4) - 0.5) * 0.24;
      const warpY = (nLow(nx * 4, ny * 4 + 2.7) - 0.5) * 0.24;

      const f1 = nLow((nx + warpX) * 4, (ny + warpY) * 4);
      const f2 = nMid((nx + warpX * 0.6) * 10, (ny + warpY * 0.6) * 10);
      const f3 = nHi(nx * 24, ny * 24);
      const h = f1 * 0.50 + f2 * 0.33 + f3 * 0.17;
      height[idx] = h;

      // Natural depressions hold rain puddles
      const pRaw = nPuddle(nx * 3, ny * 3) * 0.65 + f1 * 0.35;
      const pMask = clamp((0.36 - pRaw) * 6.5, 0, 1);
      puddle[idx] = pMask;

      // Rotting spruce needle bed + dark peat + muted Baltic moss
      const moss = clamp((f2 - 0.52) * 2.7, 0, 1) * (1 - pMask);
      const r = clamp(23 + h * 28 - moss * 9 - pMask * 10, 10, 70);
      const g = clamp(27 + h * 29 + moss * 16 - pMask * 8, 12, 76);
      const b = clamp(20 + h * 18 - moss * 5 + pMask * 4, 10, 56);

      const o = idx * 4;
      aData[o] = r;
      aData[o + 1] = g;
      aData[o + 2] = b;
      aData[o + 3] = 255;
    }
  }
  actx.putImageData(aImg, 0, 0);

  // Layer impasto Eastern European oil brushstrokes (fallen needles, dead fern fronds, creeping rootlets, pebbles)
  const rng = createRng(4419);
  for (let i = 0; i < 460; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const ang = rng() * Math.PI * 2;
    const len = 5 + rng() * 15;
    const w = 1.0 + rng() * 2.5;
    const tone = rng();
    actx.strokeStyle =
      tone < 0.28
        ? 'rgba(58, 46, 31, 0.45)' // dead pine needles
        : tone < 0.55
        ? 'rgba(30, 44, 26, 0.42)' // damp moss tuft
        : tone < 0.80
        ? 'rgba(14, 15, 11, 0.50)' // shadow crevice
        : 'rgba(72, 62, 44, 0.28)'; // dry leaf / twig highlight
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

  // Scattered tiny mud pebbles & dead twigs
  for (let i = 0; i < 45; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const r = 1.1 + rng() * 2.1;
    actx.fillStyle = rng() > 0.5 ? 'rgba(66, 68, 60, 0.45)' : 'rgba(20, 17, 14, 0.55)';
    actx.beginPath();
    actx.arc(x, y, r, 0, Math.PI * 2);
    actx.fill();
  }

  // Compute tangent-space normal map + encode puddle mask in Blue channel
  const nImg = nctx.createImageData(S, S);
  const nData = nImg.data;
  const strength = 5.8;

  for (let y = 0; y < S; y++) {
    const ym = (y - 1 + S) % S;
    const yp = (y + 1) % S;
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S;
      const xp = (x + 1) % S;
      const idx = y * S + x;

      const flat = 1 - puddle[idx] * 0.92;
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

function bakeWoodPair(): { albedo: HTMLCanvasElement; normalWet: HTMLCanvasElement } {
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

      // Deep beveled plank grooves + slight uneven aged edges
      const wobble = Math.sin(x * 0.08 + row * 2.1) * 0.4;
      const seamY =
        localY < 2 + wobble || localY >= plankH - 1.5
          ? 0
          : localY < 3.5 || localY >= plankH - 3
          ? 0.52
          : 1;
      const seamX = localX < 2 ? 0.1 : localX === 2 ? 0.62 : 1;
      const bevel = Math.min(seamY, seamX);

      const h = bevel * (0.62 + grain * 0.24 + streak * 0.14);
      height[idx] = h;

      const grime = (1 - bevel) * 28 + clamp((0.46 - stain) * 32, 0, 18);
      const r = clamp(58 + rowTint + grain * 23 + streak * 11 - grime, 11, 96);
      const g = clamp(44 + rowTint * 0.72 + grain * 18 + streak * 8 - grime, 8, 76);
      const b = clamp(31 + rowTint * 0.5 + grain * 12 + streak * 5 - grime, 6, 58);

      const o = idx * 4;
      aData[o] = r;
      aData[o + 1] = g;
      aData[o + 2] = b;
      aData[o + 3] = 255;
    }
  }
  actx.putImageData(aImg, 0, 0);

  // Hand-painted knots, splinter cracks & rusted nail heads along plank joints
  const rng = createRng(9123);
  for (let row = 0; row < S / plankH; row++) {
    const offset = (row % 2) * 128 + ((row * 37) % 52);
    const py = row * plankH;

    // Dark wood knot on selected boards
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

    // Fine age cracks along planks
    actx.strokeStyle = 'rgba(14, 10, 7, 0.46)';
    actx.lineWidth = 1;
    for (let c = 0; c < 3; c++) {
      const cx = rng() * S;
      const cy = py + 5 + rng() * (plankH - 10);
      actx.beginPath();
      actx.moveTo(cx, cy);
      actx.lineTo(cx + 12 + rng() * 26, cy + (rng() - 0.5) * 2.5);
      actx.stroke();
    }

    // Rusted nail heads + faint rust halo
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

  const nImg = nctx.createImageData(S, S);
  const nData = nImg.data;
  const strength = 5.0;

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

// Hand-painted weathered hewn cabin timber log texture
function bakeWallLogAlbedo(): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const rng = createRng(2197);

  ctx.fillStyle = '#3f3023';
  ctx.fillRect(0, 0, S, S);

  // Hewn timber grain fibers & chisel marks
  for (let i = 0; i < 190; i++) {
    const x = rng() * S;
    const y = rng() * S;
    const len = 10 + rng() * 34;
    const bright = rng() > 0.5;
    ctx.strokeStyle = bright ? 'rgba(92, 72, 50, 0.34)' : 'rgba(18, 13, 9, 0.48)';
    ctx.lineWidth = 1 + rng() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rng() - 0.5) * 2);
    ctx.stroke();
  }

  // Mossy damp patches in timber cracks
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = 'rgba(38, 52, 30, 0.34)';
    ctx.beginPath();
    ctx.ellipse(rng() * S, rng() * S, 6 + rng() * 10, 2.5 + rng() * 4, rng() * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  return c;
}

// Hand-painted cracked Eastern European stone & crumbling plaster masonry for ruins
function bakeWallRuinAlbedo(): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const rng = createRng(7711);

  ctx.fillStyle = '#252724';
  ctx.fillRect(0, 0, S, S);

  const rows = 8;
  const rowH = S / rows;
  for (let r = 0; r < rows; r++) {
    let x = (r % 2) * -12;
    while (x < S) {
      const bw = 18 + Math.floor(rng() * 18);
      const shade = Math.floor(rng() * 18);
      const mossy = rng() < 0.22;
      ctx.fillStyle = mossy
        ? `rgb(${42 + shade}, ${51 + shade}, ${38 + shade})`
        : `rgb(${55 + shade}, ${56 + shade}, ${50 + shade})`;
      ctx.fillRect(x + 1, r * rowH + 1, bw - 2, rowH - 2);
      // Cracked mortar highlight on top edge
      ctx.fillStyle = 'rgba(168, 170, 156, 0.11)';
      ctx.fillRect(x + 2, r * rowH + 1, bw - 4, 2);
      // Deep shadow under stone
      ctx.fillStyle = 'rgba(10, 11, 10, 0.65)';
      ctx.fillRect(x, (r + 1) * rowH - 2, bw, 2);
      x += bw;
    }
  }

  // Painterly masonry cracks & grime stains
  ctx.strokeStyle = 'rgba(10, 11, 10, 0.65)';
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

function bakeRoofShingles(): HTMLCanvasElement {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const rng = createRng(6217);

  ctx.fillStyle = '#181411';
  ctx.fillRect(0, 0, S, S);

  const rowH = 16;
  const colW = 20;
  for (let row = 0; row * rowH < S + rowH; row++) {
    const y = row * rowH;
    const shift = (row % 2) * (colW * 0.5);
    for (let col = -1; col * colW < S + colW; col++) {
      const x = col * colW + shift;
      // Occasional broken/missing rotten shingle revealing dark rafter underneath
      if (rng() < 0.065) {
        ctx.fillStyle = '#0d0b09';
        ctx.fillRect(x + 1, y + 1, colW - 2, rowH - 2);
        ctx.fillStyle = '#292018';
        ctx.fillRect(x + 3, y + 4, colW - 6, 3);
        continue;
      }

      const shade = Math.floor(rng() * 20);
      const mossy = rng() < 0.28;
      const rot = rng() < 0.14;
      ctx.fillStyle = mossy
        ? `rgb(${29 + shade}, ${42 + shade}, ${25 + shade})`
        : rot
        ? `rgb(${28 + shade}, ${22 + shade}, ${18 + shade})`
        : `rgb(${44 + shade}, ${35 + shade}, ${28 + shade})`;

      const tilt = (rng() - 0.5) * 1.4;
      ctx.save();
      ctx.translate(x + colW * 0.5, y + rowH * 0.5);
      ctx.rotate(tilt * 0.04);
      ctx.fillRect(-colW * 0.5 + 1, -rowH * 0.5 + 1, colW - 2, rowH - 2);

      // Grain streaks on each shingle
      ctx.fillStyle = 'rgba(10, 8, 6, 0.25)';
      ctx.fillRect(-colW * 0.3, -rowH * 0.4, 1.5, rowH * 0.8);
      ctx.fillRect(colW * 0.15, -rowH * 0.4, 1.2, rowH * 0.75);

      // Deep bottom overlap lip shadow & worn upper edge
      ctx.fillStyle = 'rgba(7, 6, 5, 0.78)';
      ctx.fillRect(-colW * 0.5, rowH * 0.5 - 2.5, colW, 2.5);
      ctx.fillStyle = 'rgba(186, 172, 146, 0.08)';
      ctx.fillRect(-colW * 0.5 + 2, -rowH * 0.5 + 1, colW - 4, 1.8);
      ctx.restore();
    }
  }

  // Broad painterly damp rain-stain & creeping lichen washes across the shingles
  for (let i = 0; i < 24; i++) {
    const lx = rng() * S;
    const ly = rng() * S;
    const rad = 14 + rng() * 34;
    const g = ctx.createRadialGradient(lx, ly, 2, lx, ly, rad);
    const isMoss = rng() > 0.45;
    g.addColorStop(0, isMoss ? 'rgba(42, 62, 32, 0.42)' : 'rgba(10, 9, 8, 0.36)');
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

// Bake 4 distinct Darkwood-benchmark 320x320 hand-painted Baltic canopies
function bakeCanopyVariant(variantIndex: number): HTMLCanvasElement {
  const S = 320;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S * 0.5;
  const cy = S * 0.5;
  const rng = createRng(3307 + variantIndex * 1429);

  // Deep organic cast shadow aura beneath the canopy
  const shadow = ctx.createRadialGradient(cx + 6, cy + 8, 22, cx + 6, cy + 8, 146);
  shadow.addColorStop(0, 'rgba(4, 6, 4, 0.84)');
  shadow.addColorStop(0.62, 'rgba(6, 9, 6, 0.52)');
  shadow.addColorStop(1, 'rgba(4, 6, 4, 0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.arc(cx + 6, cy + 8, 146, 0, Math.PI * 2);
  ctx.fill();

  if (variantIndex === 0) {
    // Variant 0: Ancient Dark Baltic Spruce (4 deep tiered needle skirts + exposed lower dead twigs)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + (rng() - 0.5) * 0.45;
      drawCrookedBranch(ctx, cx, cy, a, 108 + rng() * 34, 4.2, 1, rng, '#181410');
    }

    const tiers = [
      { n: 17, minR: 84, maxR: 138, spread: 26, base: '#0c130d', tip: '#152116', strokes: 18 },
      { n: 15, minR: 60, maxR: 104, spread: 22, base: '#121e13', tip: '#1f301e', strokes: 16 },
      { n: 12, minR: 36, maxR: 72, spread: 18, base: '#1a2b1a', tip: '#2e4429', strokes: 14 },
      { n: 9, minR: 14, maxR: 42, spread: 13, base: '#243822', tip: '#445939', strokes: 12 },
    ];
    for (const tier of tiers) {
      for (let i = 0; i < tier.n; i++) {
        const ang = (i / tier.n) * Math.PI * 2 + (rng() - 0.5) * 0.42;
        const len = tier.minR + rng() * (tier.maxR - tier.minR);
        paintNeedleFan(ctx, cx, cy, ang, len, tier.spread, tier.base, tier.tip, rng, tier.strokes);
      }
    }
  } else if (variantIndex === 1) {
    // Variant 1: Blighted / Twisted Deadwood Pine (iconic Darkwood clawing black limbs + sickly ochre tufts)
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + (rng() - 0.5) * 0.35;
      const len = 96 + rng() * 44;
      drawCrookedBranch(ctx, cx, cy, a, len, 5.4, 2, rng, '#1d1814');
      // Pale bark highlight rim on upper-west facing limbs
      if (Math.cos(a + 0.85) > 0) {
        drawCrookedBranch(ctx, cx - 1, cy - 1, a, len * 0.68, 2.2, 1, rng, 'rgba(92, 82, 66, 0.45)');
      }
    }
    // Sparse ragged clumps of dying olive/ochre needles clinging to crooked tips
    for (let i = 0; i < 13; i++) {
      const a = rng() * Math.PI * 2;
      const distOut = 32 + rng() * 68;
      const fx = cx + Math.cos(a) * distOut;
      const fy = cy + Math.sin(a) * distOut;
      paintNeedleFan(ctx, fx, fy, a + (rng() - 0.5) * 0.8, 26 + rng() * 24, 15, '#1b2013', '#3b3e22', rng, 11);
    }
    // Hanging pale swamp-lichen wisps
    ctx.strokeStyle = 'rgba(128, 138, 108, 0.28)';
    ctx.lineWidth = 1.4;
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
    // Variant 2: Gnarled Swamp Alder / Birch (irregular impasto oil-dab leaf clusters + split forked trunk)
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + (rng() - 0.5) * 0.4;
      drawCrookedBranch(ctx, cx, cy, a, 88 + rng() * 38, 4.8, 2, rng, '#221c16');
    }

    const leafLayers = [
      { count: 95, minR: 35, maxR: 126, size: 17, col: 'rgba(13, 21, 14, 0.86)' },
      { count: 80, minR: 18, maxR: 98, size: 14, col: 'rgba(24, 37, 22, 0.82)' },
      { count: 55, minR: 8, maxR: 72, size: 11, col: 'rgba(38, 52, 31, 0.72)' },
      { count: 28, minR: 10, maxR: 64, size: 8, col: 'rgba(66, 74, 44, 0.45)' }, // decaying autumn-ochre leaf dabs
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
    // Variant 3: Heavy Asymmetric Thicket Fir (wind-twisted dark boughs + jagged outline)
    const tiers = [
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

  // Painterly dry-brush moonlight/dusk catchlight dabs on the northwest crown ridge
  for (let i = 0; i < 24; i++) {
    const a = -Math.PI * 0.85 + (rng() - 0.5) * 1.3;
    const r = 12 + rng() * 68;
    ctx.fillStyle = variantIndex === 1 ? 'rgba(112, 102, 74, 0.22)' : 'rgba(92, 118, 82, 0.24)';
    ctx.beginPath();
    ctx.ellipse(
      cx + Math.cos(a) * r,
      cy + Math.sin(a) * r,
      4 + rng() * 7,
      2 + rng() * 3.5,
      a + 0.5,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  // Deep central crown shadow pit
  const core = ctx.createRadialGradient(cx, cy, 2, cx, cy, 26);
  core.addColorStop(0, 'rgba(7, 10, 7, 0.72)');
  core.addColorStop(1, 'rgba(7, 10, 7, 0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fill();

  return c;
}

// Bake 2 distinct 128x128 gnarled top-down tree trunks with clawing buttress roots & bark fissures
function bakeTrunkSprite(variant: number): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const cx = S * 0.5;
  const cy = S * 0.5;
  const rng = createRng(5501 + variant * 811);

  // Soft root-pit shadow on forest mud
  const pit = ctx.createRadialGradient(cx, cy, 10, cx, cy, 56);
  pit.addColorStop(0, 'rgba(6, 6, 5, 0.75)');
  pit.addColorStop(0.65, 'rgba(9, 8, 6, 0.35)');
  pit.addColorStop(1, 'rgba(9, 8, 6, 0)');
  ctx.fillStyle = pit;
  ctx.beginPath();
  ctx.arc(cx, cy, 56, 0, Math.PI * 2);
  ctx.fill();

  // 6-8 gnarly buttress roots clawing outward into the humus
  const roots = 6 + variant * 2;
  for (let i = 0; i < roots; i++) {
    const a = (i / roots) * Math.PI * 2 + (rng() - 0.5) * 0.45;
    const rLen = 28 + rng() * 24;
    const midA = a + (rng() - 0.5) * 0.4;
    const mx = cx + Math.cos(midA) * (rLen * 0.55);
    const my = cy + Math.sin(midA) * (rLen * 0.55);
    const ex = cx + Math.cos(a) * rLen;
    const ey = cy + Math.sin(a) * rLen;

    // Root shadow
    ctx.strokeStyle = 'rgba(8, 7, 5, 0.82)';
    ctx.lineWidth = 8.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + 2, cy + 2);
    ctx.quadraticCurveTo(mx + 2, my + 2, ex + 1, ey + 1);
    ctx.stroke();

    // Main gnarled bark root
    ctx.strokeStyle = variant === 0 ? '#2f231a' : '#29211b';
    ctx.lineWidth = 6.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();

    // Bark highlight ridge along root spine
    ctx.strokeStyle = 'rgba(96, 78, 58, 0.38)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(cx - 1, cy - 1);
    ctx.quadraticCurveTo(mx - 1, my - 1, ex * 0.8 + cx * 0.2, ey * 0.8 + cy * 0.2);
    ctx.stroke();

    // Creeping green moss patch on root shoulder
    if (rng() > 0.45) {
      ctx.fillStyle = 'rgba(54, 74, 42, 0.55)';
      ctx.beginPath();
      ctx.ellipse(mx, my, 5.5, 3.2, a, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Irregular fluted bark trunk cross-section
  const trunkR = 24;
  ctx.fillStyle = '#15100c';
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const wobble = trunkR + Math.sin(a * 5 + variant) * 2.6 + (rng() - 0.5) * 2.2;
    const px = cx + Math.cos(a) * wobble;
    const py = cy + Math.sin(a) * wobble;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  // Inner weathered bark rings & deep dark fissures
  ctx.fillStyle = '#38291e';
  ctx.beginPath();
  ctx.arc(cx, cy, trunkR - 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#1a120d';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + rng() * 0.2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6);
    ctx.lineTo(cx + Math.cos(a) * (trunkR - 1), cy + Math.sin(a) * (trunkR - 1));
    ctx.stroke();
  }

  // Northwest bark catchlight + moss crest
  ctx.fillStyle = 'rgba(104, 86, 62, 0.36)';
  ctx.beginPath();
  ctx.arc(cx - 5, cy - 5, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(58, 79, 44, 0.45)';
  ctx.beginPath();
  ctx.arc(cx - 8, cy + 4, 6.5, 0, Math.PI * 2);
  ctx.fill();

  return c;
}

let cachedAtlas: ProceduralAtlas | null = null;

export function getProceduralAtlas(): ProceduralAtlas {
  if (cachedAtlas) return cachedAtlas;
  const ground = bakeGroundPair();
  const wood = bakeWoodPair();
  cachedAtlas = {
    groundAlbedo: ground.albedo,
    groundNormalWet: ground.normalWet,
    woodAlbedo: wood.albedo,
    woodNormalWet: wood.normalWet,
    wallLogAlbedo: bakeWallLogAlbedo(),
    wallRuinAlbedo: bakeWallRuinAlbedo(),
    roofAlbedo: bakeRoofShingles(),
    canopySprites: [
      bakeCanopyVariant(0),
      bakeCanopyVariant(1),
      bakeCanopyVariant(2),
      bakeCanopyVariant(3),
    ],
    trunkSprites: [bakeTrunkSprite(0), bakeTrunkSprite(1)],
  };
  return cachedAtlas;
}
