// Steam-Grade Pure-Procedural Renderer (Darkwood-Benchmark Edition):
// - Baked 4-variant hand-painted Baltic canopies, gnarled root trunks & tangent-space normal maps
// - Architectural brushwork: notched log cabin walls, crumbling masonry, Soviet cargo truck, splintered barricades
// - Lived-in Hideout interior furniture & POI environmental storytelling (rug, cot, stove, power cables, sawbench, ritual circle)
// - Iconic asymmetrical Darkwood silhouettes for The Stranger, Savage Hound, Twisted Stalker & Root Banshee
// - Persistent World Decal FBO (species corpses, clotted blood, splinters, scorch marks, muddy prints)
// - WebGL2 Deferred 2D Normal-Mapped Lighting, Soft Penumbra, Volumetric Beam & ACES Post-Process
//   (with automatic graceful Canvas2D fallback and ?v-shader=a|b A/B comparison)

import { GameEngine, SAWMILL_ROOF_RECT } from './engine';
import { I18n } from './i18n';
import { Quality } from './quality';
import { ProceduralAtlas, getProceduralAtlas } from './textures';
import { DecalEvent, Enemy, LootContainer, RectObstacle, RockObstacle } from './types';
import { Vec2, angleDiff, clamp, createRng, dist, lerp } from './util';
import { Variants } from './variants';
import { computeVisibilityPolygon, hasLineOfSight } from './visibility';
import { GpuLight, WebGL2Composer } from './webglComposer';
import {
  GENERATOR_POS,
  HIDEOUT_RECT,
  SHELTER_LAMPS,
  WORKBENCH_POS,
  WORLD_HALF,
  WORLD_SIZE,
} from './world';

const DECAL_TEX_SIZE = 1536;
const DECAL_SCALE = DECAL_TEX_SIZE / WORLD_SIZE;

export class GameRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private atlas: ProceduralAtlas;
  private webgl: WebGL2Composer;

  // Offscreen G-Buffer & Shadow canvases
  private albedoCanvas: HTMLCanvasElement;
  private albedoCtx: CanvasRenderingContext2D;
  private normalCanvas: HTMLCanvasElement;
  private normalCtx: CanvasRenderingContext2D;
  private shadowCanvas: HTMLCanvasElement;
  private shadowCtx: CanvasRenderingContext2D;

  // Persistent world-space decal canvas (blood pools, corpses, splinters, scorch marks)
  private decalCanvas: HTMLCanvasElement;
  private decalCtx: CanvasRenderingContext2D;
  private lastDecalReset = -1;

  // Fallback Canvas2D shadow composite canvas
  private fallbackLightCanvas: HTMLCanvasElement;
  private fallbackLightCtx: CanvasRenderingContext2D;

  // Cached CanvasPatterns
  private groundAlbedoPat: CanvasPattern | null = null;
  private groundNormalPat: CanvasPattern | null = null;
  private woodAlbedoPat: CanvasPattern | null = null;
  private woodNormalPat: CanvasPattern | null = null;
  private wallLogPat: CanvasPattern | null = null;
  private wallRuinPat: CanvasPattern | null = null;
  private roofPat: CanvasPattern | null = null;

  private polyScratch: Vec2[] = [];
  private auraPolyScratch: Vec2[] = [];
  private lampPolyScratch: Vec2[] = [];
  private gpuLights: GpuLight[] = [];

  width = 1280;
  height = 720;
  dpr = 1;
  renderW = 1280;
  renderH = 720;
  drawDisabled = false;
  lastDrawCalls = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Failed to acquire 2D context');
    this.ctx = ctx;

    this.atlas = getProceduralAtlas();
    this.webgl = new WebGL2Composer();

    this.albedoCanvas = document.createElement('canvas');
    this.albedoCtx = this.albedoCanvas.getContext('2d', { alpha: false })!;

    this.normalCanvas = document.createElement('canvas');
    this.normalCtx = this.normalCanvas.getContext('2d', { alpha: false })!;

    this.shadowCanvas = document.createElement('canvas');
    this.shadowCtx = this.shadowCanvas.getContext('2d', { alpha: false })!;

    this.fallbackLightCanvas = document.createElement('canvas');
    this.fallbackLightCtx = this.fallbackLightCanvas.getContext('2d')!;

    this.decalCanvas = document.createElement('canvas');
    this.decalCanvas.width = DECAL_TEX_SIZE;
    this.decalCanvas.height = DECAL_TEX_SIZE;
    this.decalCtx = this.decalCanvas.getContext('2d')!;

    this.groundAlbedoPat = this.albedoCtx.createPattern(this.atlas.groundAlbedo, 'repeat');
    this.woodAlbedoPat = this.albedoCtx.createPattern(this.atlas.woodAlbedo, 'repeat');
    this.wallLogPat = this.albedoCtx.createPattern(this.atlas.wallLogAlbedo, 'repeat');
    this.wallRuinPat = this.albedoCtx.createPattern(this.atlas.wallRuinAlbedo, 'repeat');
    this.roofPat = this.albedoCtx.createPattern(this.atlas.roofAlbedo, 'repeat');
    this.groundNormalPat = this.normalCtx.createPattern(this.atlas.groundNormalWet, 'repeat');
    this.woodNormalPat = this.normalCtx.createPattern(this.atlas.woodNormalWet, 'repeat');
  }

  get activeBackend(): 'webgl2' | 'canvas2d' {
    return this.webgl.available && Variants.val.shader !== 'a' ? 'webgl2' : 'canvas2d';
  }

  setNoDraw(on: boolean) {
    this.drawDisabled = on;
  }

  resize(cssWidth: number, cssHeight: number) {
    this.width = Math.max(320, Math.floor(cssWidth));
    this.height = Math.max(240, Math.floor(cssHeight));
    const maxDpr = Quality.preset.maxDpr * Quality.dynamicScale;
    this.dpr = clamp(window.devicePixelRatio || 1, 1, Math.max(1, maxDpr));

    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);

    const scale = Quality.preset.lightScale * Quality.dynamicScale;
    this.renderW = Math.max(320, Math.floor(this.width * scale));
    this.renderH = Math.max(200, Math.floor(this.height * scale));

    this.albedoCanvas.width = this.renderW;
    this.albedoCanvas.height = this.renderH;
    this.normalCanvas.width = this.renderW;
    this.normalCanvas.height = this.renderH;
    this.shadowCanvas.width = Math.max(240, Math.floor(this.renderW * 0.75));
    this.shadowCanvas.height = Math.max(150, Math.floor(this.renderH * 0.75));

    this.fallbackLightCanvas.width = this.shadowCanvas.width;
    this.fallbackLightCanvas.height = this.shadowCanvas.height;

    this.webgl.resize(this.renderW, this.renderH);
  }

  private drainDecals(engine: GameEngine) {
    if (this.lastDecalReset !== engine.decalResetCounter) {
      this.lastDecalReset = engine.decalResetCounter;
      this.decalCtx.clearRect(0, 0, DECAL_TEX_SIZE, DECAL_TEX_SIZE);
    }
    if (engine.pendingDecals.length === 0) return;

    const dctx = this.decalCtx;
    for (let i = 0; i < engine.pendingDecals.length; i++) {
      this.stampDecal(dctx, engine.pendingDecals[i]);
    }
    engine.pendingDecals.length = 0;
  }

  private stampDecal(ctx: CanvasRenderingContext2D, evt: DecalEvent) {
    const dx = (evt.x + WORLD_HALF) * DECAL_SCALE;
    const dy = (evt.y + WORLD_HALF) * DECAL_SCALE;
    const rng = createRng(Math.floor(evt.seed * 1000) + 17);

    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(evt.angle);
    ctx.scale(DECAL_SCALE * evt.scale, DECAL_SCALE * evt.scale);

    if (evt.kind === 'blood') {
      // Rich dark Eastern European clotted crimson pool with irregular feathered edges
      ctx.fillStyle = 'rgba(54, 9, 9, 0.78)';
      ctx.beginPath();
      ctx.ellipse(0, 0, 18, 13, 0.3, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 8; i++) {
        const a = rng() * Math.PI * 2;
        const r = 7 + rng() * 15;
        ctx.fillStyle = i % 2 === 0 ? 'rgba(78, 13, 13, 0.62)' : 'rgba(38, 6, 6, 0.56)';
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2.5 + rng() * 5.2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (evt.kind === 'splatter') {
      for (let i = 0; i < 11; i++) {
        const distOut = 4 + rng() * 26;
        const spread = (rng() - 0.5) * 16;
        ctx.fillStyle = rng() > 0.35 ? 'rgba(84, 14, 13, 0.68)' : 'rgba(46, 7, 7, 0.58)';
        ctx.beginPath();
        ctx.ellipse(distOut, spread, 3 + rng() * 4.5, 1.4 + rng() * 2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (evt.kind === 'corpse') {
      // Species-specific persistent fallen horror remains
      ctx.fillStyle = 'rgba(48, 8, 8, 0.74)';
      ctx.beginPath();
      ctx.ellipse(-2, 1, 22, 15, 0.25, 0, Math.PI * 2);
      ctx.fill();

      if (evt.enemyKind === 'hound') {
        // Sprawled mangy hound carcass with pale exposed ribs
        ctx.fillStyle = 'rgba(42, 30, 25, 0.9)';
        ctx.beginPath();
        ctx.ellipse(0, 0, 15, 8, 0.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(26, 18, 15, 0.88)';
        ctx.lineWidth = 2.8;
        ctx.beginPath();
        ctx.moveTo(-7, -4);
        ctx.lineTo(-14, -12);
        ctx.moveTo(6, 4);
        ctx.lineTo(14, 11);
        ctx.moveTo(-12, 1);
        ctx.lineTo(-20, 5);
        ctx.stroke();
        // Exposed pale rib lines
        ctx.strokeStyle = 'rgba(182, 166, 142, 0.45)';
        ctx.lineWidth = 1.2;
        for (let r = -5; r <= 5; r += 3.5) {
          ctx.beginPath();
          ctx.moveTo(r, -4);
          ctx.lineTo(r + 1, 4);
          ctx.stroke();
        }
      } else if (evt.enemyKind === 'banshee') {
        // Collapsed root-crown & tattered shroud
        ctx.strokeStyle = 'rgba(22, 18, 15, 0.9)';
        ctx.lineWidth = 2.8;
        for (let b = 0; b < 6; b++) {
          const a = (b / 6) * Math.PI * 2 + 0.3;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(a) * 20, Math.sin(a) * 16);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(26, 24, 20, 0.92)';
        ctx.beginPath();
        ctx.ellipse(0, 0, 11, 9, 0.1, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Twisted hunched Stalker limbs & torn burial coat
        ctx.strokeStyle = 'rgba(26, 28, 24, 0.88)';
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(-5, -4);
        ctx.lineTo(14, -15);
        ctx.lineTo(22, -10);
        ctx.moveTo(-3, 6);
        ctx.lineTo(15, 13);
        ctx.moveTo(-10, 0);
        ctx.lineTo(-19, -7);
        ctx.stroke();
        ctx.fillStyle = 'rgba(34, 36, 30, 0.9)';
        ctx.beginPath();
        ctx.ellipse(-1, 0, 11, 8, 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(120, 114, 98, 0.55)';
        ctx.beginPath();
        ctx.arc(8, -2, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (evt.kind === 'wood') {
      for (let i = 0; i < 6; i++) {
        ctx.save();
        ctx.translate((rng() - 0.5) * 24, (rng() - 0.5) * 24);
        ctx.rotate(rng() * Math.PI);
        ctx.fillStyle = i % 2 === 0 ? 'rgba(98, 70, 44, 0.82)' : 'rgba(62, 44, 28, 0.8)';
        ctx.fillRect(-8, -1.8, 16, 3.2);
        ctx.fillStyle = 'rgba(16, 12, 9, 0.65)';
        ctx.fillRect(-8, 1, 16, 1);
        ctx.restore();
      }
    } else if (evt.kind === 'scorch') {
      const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 18);
      g.addColorStop(0, 'rgba(9, 8, 8, 0.88)');
      g.addColorStop(0.55, 'rgba(32, 23, 18, 0.5)');
      g.addColorStop(1, 'rgba(10, 9, 9, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();
    } else if (evt.kind === 'footprint') {
      ctx.fillStyle = 'rgba(10, 9, 7, 0.30)';
      ctx.beginPath();
      ctx.ellipse(0, evt.left ? -4 : 4, 4.8, 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  render(engine: GameEngine) {
    if (this.drawDisabled) return;

    const useWebGL = this.activeBackend === 'webgl2';
    engine.backendName = useWebGL ? 'webgl2' : 'canvas2d';

    this.drainDecals(engine);

    const W = this.width;
    const H = this.height;
    const cx = engine.camX + engine.shakeOffsetX;
    const cy = engine.camY + engine.shakeOffsetY;
    const viewL = cx - W * 0.5;
    const viewT = cy - H * 0.5;
    const viewR = viewL + W;
    const viewB = viewT + H;
    const coneHalfRad = Variants.val.cone === 'a' ? (39 * Math.PI) / 180 : (31 * Math.PI) / 180;

    let draws = 0;

    if (useWebGL) {
      const sx = this.renderW / W;
      const sy = this.renderH / H;

      draws += this.renderSceneAlbedo(
        this.albedoCtx,
        engine,
        W,
        H,
        sx,
        sy,
        cx,
        cy,
        viewL,
        viewT,
        viewR,
        viewB,
        coneHalfRad
      );

      this.renderSceneNormals(
        this.normalCtx,
        engine,
        W,
        H,
        sx,
        sy,
        viewL,
        viewT,
        viewR,
        viewB
      );

      this.renderShadowMasksAndLights(engine, W, H, viewL, viewT, coneHalfRad);

      const ambient = this.getAmbientRGB(engine);
      const lowHp = clamp((40 - engine.player.hp) / 40, 0, 1);
      const bloodDread = clamp(lowHp * 0.55 + engine.player.hitFlash * 1.15, 0, 1);

      this.webgl.compose(this.albedoCanvas, this.normalCanvas, this.shadowCanvas, {
        width: W,
        height: H,
        camX: cx,
        camY: cy,
        time: engine.simTime,
        ambientR: ambient.r,
        ambientG: ambient.g,
        ambientB: ambient.b,
        wetness: engine.weather.wetness,
        rainIntensity: engine.weather.rainIntensity,
        lightningFlash: engine.weather.lightningFlash,
        bloodDread,
        fogDensity: Variants.val.fog === 'b' ? 1.0 : 0.45,
        penumbraSamples: Quality.preset.penumbraSamples,
        enableGrain: Quality.preset.enableGrain && Variants.val.grain === 'b',
        puddleReflections: Quality.preset.puddleReflections,
        lights: this.gpuLights,
      });

      const ctx = this.ctx;
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      ctx.drawImage(this.webgl.canvas, 0, 0, W, H);
      draws++;

      this.renderAboveDarknessOverlays(ctx, engine, W, H, viewL, viewT);
      ctx.restore();
    } else {
      const ctx = this.ctx;
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      draws += this.renderSceneAlbedo(
        ctx,
        engine,
        W,
        H,
        1,
        1,
        cx,
        cy,
        viewL,
        viewT,
        viewR,
        viewB,
        coneHalfRad
      );
      this.renderFallbackDarkness(ctx, engine, W, H, viewL, viewT, coneHalfRad);
      this.renderAboveDarknessOverlays(ctx, engine, W, H, viewL, viewT);
      ctx.restore();
    }

    this.lastDrawCalls = draws;
  }

  private getAmbientRGB(engine: GameEngine): { r: number; g: number; b: number } {
    if (engine.phase === 'day') {
      const t = engine.getPhaseProgress();
      return {
        r: lerp(0.46, 0.36, t),
        g: lerp(0.50, 0.38, t),
        b: lerp(0.45, 0.34, t),
      };
    }
    if (engine.phase === 'dusk') {
      const t = engine.getPhaseProgress();
      return {
        r: lerp(0.38, 0.08, t),
        g: lerp(0.24, 0.08, t),
        b: lerp(0.20, 0.11, t),
      };
    }
    return { r: 0.032, g: 0.038, b: 0.048 };
  }

  private renderSceneAlbedo(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    W: number,
    H: number,
    sx: number,
    sy: number,
    camX: number,
    camY: number,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number,
    coneHalfRad: number
  ): number {
    let draws = 0;
    ctx.save();
    ctx.scale(sx, sy);
    ctx.fillStyle = '#121611';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(-viewL, -viewT);

    // 1. Baked painterly Eastern European forest floor
    if (this.groundAlbedoPat) {
      ctx.fillStyle = this.groundAlbedoPat;
      ctx.fillRect(viewL, viewT, W, H);
      draws++;
    }

    // 2. Winding rutted mud trails connecting Hideout to the 4 landmarks
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const path of engine.world.paths) {
      ctx.strokeStyle = 'rgba(42, 33, 22, 0.62)';
      ctx.lineWidth = path.width;
      ctx.beginPath();
      path.points.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();

      // Subtle cart wheel ruts along mud trail center
      ctx.strokeStyle = 'rgba(24, 19, 13, 0.34)';
      ctx.lineWidth = path.width * 0.56;
      ctx.stroke();

      ctx.strokeStyle = 'rgba(66, 53, 37, 0.35)';
      ctx.lineWidth = path.width * 0.28;
      ctx.stroke();
      draws += 3;
    }

    // 3. Interior timber plank & gravel floor zones
    for (const z of engine.world.zones) {
      if (z.x + z.w < viewL - 40 || z.x > viewR + 40 || z.y + z.h < viewT - 40 || z.y > viewB + 40) {
        continue;
      }
      if (z.surface === 'wood' && this.woodAlbedoPat) {
        ctx.fillStyle = this.woodAlbedoPat;
        ctx.fillRect(z.x, z.y, z.w, z.h);
        // Deep floorboard-wall junction shadow & moisture grime
        ctx.strokeStyle = 'rgba(8, 6, 4, 0.58)';
        ctx.lineWidth = 14;
        ctx.strokeRect(z.x + 7, z.y + 7, z.w - 14, z.h - 14);
      } else if (z.surface === 'gravel') {
        ctx.fillStyle = 'rgba(42, 44, 40, 0.72)';
        ctx.fillRect(z.x, z.y, z.w, z.h);
        ctx.strokeStyle = 'rgba(18, 20, 17, 0.45)';
        ctx.lineWidth = 8;
        ctx.strokeRect(z.x + 4, z.y + 4, z.w - 8, z.h - 8);
      }
      draws++;
    }

    // 3b. Lived-in Hideout interior furnishings & POI environmental storytelling props (under decals/entities!)
    if (viewR > HIDEOUT_RECT.x - 40 && viewL < HIDEOUT_RECT.x + HIDEOUT_RECT.w + 40 &&
        viewB > HIDEOUT_RECT.y - 40 && viewT < HIDEOUT_RECT.y + HIDEOUT_RECT.h + 40) {
      this.drawHideoutInterior(ctx, engine);
      draws += 6;
    }
    this.drawPoiStorytelling(ctx, engine, viewL, viewT, viewR, viewB);
    draws += 4;

    // 4. Persistent World Decals (clotted blood pools, species corpses, wood splinters, scorch rings)
    ctx.drawImage(this.decalCanvas, -WORLD_HALF, -WORLD_HALF, WORLD_SIZE, WORLD_SIZE);
    draws++;

    // 5. Recent fading footprints
    for (let i = 0; i < engine.footprints.count; i++) {
      const fp = engine.footprints.items[i];
      if (!fp.active) continue;
      if (fp.x < viewL - 20 || fp.x > viewR + 20 || fp.y < viewT - 20 || fp.y > viewB + 20) continue;
      const alpha = (fp.life / fp.maxLife) * 0.36;
      ctx.save();
      ctx.translate(fp.x, fp.y);
      ctx.rotate(fp.angle);
      ctx.fillStyle = `rgba(11, 10, 8, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(0, fp.left ? -4 : 4, 4.5, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 6. Raindrop ground/puddle ripples
    if (engine.weather.rainIntensity > 0.05) {
      ctx.strokeStyle = 'rgba(182, 198, 206, 0.42)';
      ctx.lineWidth = 1.1;
      for (let i = 0; i < engine.rainRipples.count; i++) {
        const r = engine.rainRipples.items[i];
        if (!r.active) continue;
        if (r.x < viewL - 20 || r.x > viewR + 20 || r.y < viewT - 20 || r.y > viewB + 20) continue;
        ctx.globalAlpha = clamp(r.alpha, 0, 0.5);
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, r.radius, r.radius * 0.72, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 7. Bear Traps (rusted steel jaws & chain anchor)
    for (const trap of engine.traps) {
      ctx.save();
      ctx.translate(trap.x, trap.y);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
      ctx.beginPath();
      ctx.ellipse(1, 2, 13, 11, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = trap.armed ? '#8b9188' : '#7b241e';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, 11.5, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = trap.armed ? '#363834' : '#521d1a';
      ctx.beginPath();
      ctx.arc(0, 0, 4.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#c4cac0';
      ctx.lineWidth = 1.5;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 8, Math.sin(a) * 8);
        ctx.lineTo(Math.cos(a) * 12.5, Math.sin(a) * 12.5);
        ctx.stroke();
      }
      ctx.restore();
      draws++;
    }

    // 8. Bioluminescent Odd Essence Mushrooms (organic cap cluster + stem + glow)
    for (const node of engine.world.essences) {
      if (node.harvested) continue;
      if (node.x < viewL - 40 || node.x > viewR + 40 || node.y < viewT - 40 || node.y > viewB + 40) continue;
      const pulse = 0.74 + Math.sin(engine.simTime * 2.8 + node.pulsePhase) * 0.26;
      const grad = ctx.createRadialGradient(node.x, node.y, 2, node.x, node.y, 30);
      grad.addColorStop(0, `rgba(98, 224, 194, ${(0.68 * pulse).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(98, 224, 194, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 30, 0, Math.PI * 2);
      ctx.fill();

      // Fungal mycelium rootlets
      ctx.strokeStyle = 'rgba(72, 168, 144, 0.42)';
      ctx.lineWidth = 1.1;
      for (let k = 0; k < 5; k++) {
        const a = node.pulsePhase + k * 1.25;
        ctx.beginPath();
        ctx.moveTo(node.x, node.y);
        ctx.lineTo(node.x + Math.cos(a) * 14, node.y + Math.sin(a) * 14);
        ctx.stroke();
      }

      // Three layered bioluminescent mushroom caps with dark rims
      const caps = [
        { ox: -4.5, oy: -2, r: 5.2 },
        { ox: 5.5, oy: 3.2, r: 4.1 },
        { ox: 1.5, oy: -5.5, r: 3.4 },
      ];
      for (const cap of caps) {
        ctx.fillStyle = '#1b473d';
        ctx.beginPath();
        ctx.arc(node.x + cap.ox, node.y + cap.oy, cap.r + 1.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#9ff5de';
        ctx.beginPath();
        ctx.arc(node.x + cap.ox - 0.6, node.y + cap.oy - 0.6, cap.r * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
      draws++;
    }

    // 9. Hand-Painted Loot Containers (with pried-open / ransacked searched states)
    for (const c of engine.world.containers) {
      if (c.x < viewL - 44 || c.x > viewR + 44 || c.y < viewT - 44 || c.y > viewB + 44) continue;
      this.drawContainer(ctx, c, engine.simTime);
      draws++;
    }

    // 10. Soviet Generator & Cluttered Workbench
    this.drawGenerator(ctx, engine);
    this.drawWorkbench(ctx);
    draws += 2;

    // 11. Architectural Walls, Crumbling Masonry & Iconic Crashed Soviet Supply Truck
    for (const w of engine.world.walls) {
      if (w.kind === 'table') continue;
      if (w.x + w.w < viewL - 40 || w.x > viewR + 40 || w.y + w.h < viewT - 40 || w.y > viewB + 40) {
        continue;
      }
      if (w.kind === 'truck') {
        this.drawTruckSegment(ctx, w);
      } else if (w.kind === 'wall') {
        this.drawCabinTimberWall(ctx, w);
      } else {
        this.drawRuinMasonryWall(ctx, w);
      }
      draws++;
    }

    // Interlocking log-cabin corner overhangs on Hideout
    if (viewR > HIDEOUT_RECT.x - 30 && viewL < HIDEOUT_RECT.x + HIDEOUT_RECT.w + 30 &&
        viewB > HIDEOUT_RECT.y - 30 && viewT < HIDEOUT_RECT.y + HIDEOUT_RECT.h + 30) {
      this.drawHideoutCornerNotches(ctx);
    }

    // 12. Recessed Barricaded Doors & Broken-Glass Windows
    for (const b of engine.world.barricades) {
      if (b.x + b.w < viewL - 30 || b.x > viewR + 30 || b.y + b.h < viewT - 30 || b.y > viewB + 30) {
        continue;
      }
      this.drawBarricadeSlot(ctx, b);
      draws++;
    }

    // 13. Multi-Faceted Mossy Boulders & Gnarled Root-Flared Tree Trunks
    for (const r of engine.world.rocks) {
      if (r.x < viewL - 44 || r.x > viewR + 44 || r.y < viewT - 44 || r.y > viewB + 44) continue;
      this.drawPainterlyRock(ctx, r);
      draws++;
    }

    for (const t of engine.world.trees) {
      if (t.x < viewL - 95 || t.x > viewR + 95 || t.y < viewT - 95 || t.y > viewB + 95) continue;
      const sprite = this.atlas.trunkSprites[t.id % this.atlas.trunkSprites.length];
      const size = t.trunkR * 5.2;
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.phase);
      ctx.drawImage(sprite, -size * 0.5, -size * 0.5, size, size);
      ctx.restore();
      draws++;
    }

    // 14. Active Flares
    for (const f of engine.flares) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.ellipse(f.x + 1, f.y + 2, 7, 4, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#b93424';
      ctx.fillRect(f.x - 5, f.y - 2, 10, 4);
      ctx.fillStyle = '#ff7242';
      ctx.beginPath();
      ctx.arc(f.x + 4, f.y, 4.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff7e0';
      ctx.beginPath();
      ctx.arc(f.x + 4, f.y, 2.1, 0, Math.PI * 2);
      ctx.fill();
      draws++;
    }

    // 15. Articulated Skeletal Enemies (Darkwood silhouettes, strictly inside real-time light / LOS!)
    for (const e of engine.enemies) {
      if (e.x < viewL - 60 || e.x > viewR + 60 || e.y < viewT - 60 || e.y > viewB + 60) continue;
      if (!this.isEnemyVisible(engine, e, coneHalfRad)) continue;
      this.drawArticulatedEnemy(ctx, e, engine.simTime);
      draws++;
    }

    // 16. Articulated Skeletal Player (The Stranger: greatcoat, rucksack, hood, lantern, weapon)
    this.drawArticulatedPlayer(ctx, engine);
    draws++;

    // 16b. Overhead Hanging Shelter Lamp Fixtures (above player head when indoors!)
    if (engine.hideoutRoofAlpha < 0.85 &&
        viewR > HIDEOUT_RECT.x && viewL < HIDEOUT_RECT.x + HIDEOUT_RECT.w &&
        viewB > HIDEOUT_RECT.y && viewT < HIDEOUT_RECT.y + HIDEOUT_RECT.h) {
      const lit = engine.generatorOn && engine.generatorFuel > 0;
      for (const lamp of SHELTER_LAMPS) {
        ctx.save();
        ctx.translate(lamp.x, lamp.y);
        // Enamel iron hanging lamp shade
        ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
        ctx.beginPath();
        ctx.arc(2, 3, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#252925';
        ctx.strokeStyle = '#0e100e';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Warm glowing filament bulb center
        ctx.fillStyle = lit ? '#ffe6a8' : '#3d3c36';
        ctx.beginPath();
        ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 17. World Particles (blood, splinters, sparks, forest spores & flashlight dust motes)
    for (let i = 0; i < engine.particles.count; i++) {
      const pt = engine.particles.items[i];
      if (!pt.active) continue;
      if (pt.x < viewL - 20 || pt.x > viewR + 20 || pt.y < viewT - 20 || pt.y > viewB + 20) continue;
      const a = clamp(pt.life / pt.maxLife, 0, 1);
      ctx.globalAlpha = pt.kind === 'spore' ? a * 0.5 : pt.kind === 'dust' ? a * 0.65 : a * 0.92;
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 18. Hideout & Old Sawmill Weathered Shingle Roof Cutaway
    if (engine.hideoutRoofAlpha > 0.02) {
      this.drawRoofCutaway(
        ctx,
        HIDEOUT_RECT,
        engine.hideoutRoofAlpha,
        engine.generatorOn && engine.generatorFuel > 0,
        engine.simTime,
        true
      );
      draws++;
    }
    if (engine.sawmillRoofAlpha > 0.02) {
      this.drawRoofCutaway(ctx, SAWMILL_ROOF_RECT, engine.sawmillRoofAlpha, false, engine.simTime, false);
      draws++;
    }

    // 19. 4-Variant Hand-Painted Baltic Forest Canopies (with subtle vertical height parallax + storm sway!)
    const swayOn = Quality.preset.canopySway;
    const stormWind = 1 + engine.weather.rainIntensity * 1.45;
    for (const t of engine.world.trees) {
      if (t.x < viewL - 135 || t.x > viewR + 135 || t.y < viewT - 135 || t.y > viewB + 135) continue;
      const swayX = swayOn ? Math.sin(engine.simTime * (0.95 * stormWind) + t.phase) * (3.8 * stormWind) : 0;
      const swayY = swayOn ? Math.cos(engine.simTime * (0.72 * stormWind) + t.phase) * (2.6 * stormWind) : 0;
      // Classic Darkwood top-down verticality: tree crowns lean slightly away from camera center
      const paraX = clamp((t.x - camX) * 0.055, -24, 24);
      const paraY = clamp((t.y - camY) * 0.055, -24, 24);
      const dPlayer = dist(engine.player.x, engine.player.y, t.x, t.y);
      const canopyAlpha = dPlayer < t.canopyR + 18 ? 0.24 : 0.92;

      const sprite = this.atlas.canopySprites[t.id % this.atlas.canopySprites.length];
      const size = t.canopyR * 2.55;
      ctx.save();
      ctx.globalAlpha = canopyAlpha;
      ctx.translate(t.x + swayX + paraX, t.y + swayY + paraY);
      ctx.rotate(t.phase);
      ctx.drawImage(sprite, -size * 0.5, -size * 0.5, size, size);
      ctx.restore();
      draws++;
    }

    // 20. Dark impenetrable treeline border
    ctx.strokeStyle = 'rgba(6, 8, 6, 0.96)';
    ctx.lineWidth = 48;
    ctx.strokeRect(-WORLD_HALF, -WORLD_HALF, WORLD_HALF * 2, WORLD_HALF * 2);

    ctx.restore();
    return draws;
  }

  // --- Lived-In Hideout Interior Storytelling Props (Zero Collision Impact!) ---
  private drawHideoutInterior(ctx: CanvasRenderingContext2D, engine: GameEngine) {
    const { x, y, w, h } = HIDEOUT_RECT;
    const t = 18;
    const innerL = x + t;
    const innerT = y + t;
    const innerR = x + w - t;
    const innerB = y + h - t;

    // 1. Frayed Eastern European Folk-Pattern Woven Rug in Cabin Center
    ctx.save();
    ctx.translate(0, 26);
    ctx.rotate(-0.04);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
    ctx.fillRect(-66, -38, 134, 78);
    // Base aged burgundy wool weave
    ctx.fillStyle = '#47221d';
    ctx.fillRect(-65, -39, 130, 76);
    // Woven ochre & charcoal inner border
    ctx.strokeStyle = '#7e5a34';
    ctx.lineWidth = 3;
    ctx.strokeRect(-58, -32, 116, 62);
    ctx.strokeStyle = '#241814';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-52, -26, 104, 50);
    // Geometric Eastern European diamond motifs
    ctx.fillStyle = '#683928';
    for (const dx of [-30, 0, 30]) {
      ctx.beginPath();
      ctx.moveTo(dx, -15);
      ctx.lineTo(dx + 14, 0);
      ctx.lineTo(dx, 15);
      ctx.lineTo(dx - 14, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#8b6a42';
      ctx.beginPath();
      ctx.arc(dx, 0, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#683928';
    }
    // Frayed fringe threads along left & right rug ends
    ctx.strokeStyle = 'rgba(136, 116, 86, 0.45)';
    ctx.lineWidth = 1.1;
    for (let fy = -36; fy <= 34; fy += 5) {
      ctx.beginPath();
      ctx.moveTo(-65, fy);
      ctx.lineTo(-71, fy + (fy % 2 === 0 ? 1 : -1));
      ctx.moveTo(65, fy);
      ctx.lineTo(71, fy + (fy % 2 === 0 ? -1 : 1));
      ctx.stroke();
    }
    // Grime & muddy boot stain near South door edge of rug
    ctx.fillStyle = 'rgba(18, 14, 10, 0.36)';
    ctx.beginPath();
    ctx.ellipse(4, 24, 28, 11, 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 2. Snaking Black Power Cables from Generator to Shelter Lamps
    ctx.save();
    ctx.lineCap = 'round';
    for (let idx = 0; idx < SHELTER_LAMPS.length; idx++) {
      const lamp = SHELTER_LAMPS[idx];
      ctx.strokeStyle = 'rgba(8, 8, 8, 0.65)';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(GENERATOR_POS.x + 14, GENERATOR_POS.y + 8);
      if (idx === 0) {
        ctx.bezierCurveTo(-110, -35, -92, -10, lamp.x, lamp.y);
      } else {
        ctx.bezierCurveTo(-45, -62, 32, -38, lamp.x, lamp.y);
      }
      ctx.stroke();

      ctx.strokeStyle = '#2b2d2b';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();

    // 3. Rusted Iron Field Cot (tucked neatly against SW interior wall, clear of window & south door)
    ctx.save();
    ctx.translate(innerL + 38, innerB - 24);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.fillRect(-31, -15, 64, 32);
    // Iron cot frame
    ctx.fillStyle = '#2d2f2c';
    ctx.strokeStyle = '#121311';
    ctx.lineWidth = 1.8;
    ctx.fillRect(-32, -16, 64, 30);
    ctx.strokeRect(-32, -16, 64, 30);
    // Stained cotton mattress
    ctx.fillStyle = '#6c6352';
    ctx.fillRect(-29, -13, 58, 24);
    // Crumpled olive wool blanket draped diagonally
    ctx.fillStyle = '#3b4232';
    ctx.beginPath();
    ctx.moveTo(-14, -13);
    ctx.lineTo(29, -13);
    ctx.lineTo(29, 11);
    ctx.lineTo(-19, 11);
    ctx.quadraticCurveTo(-8, -1, -14, -13);
    ctx.closePath();
    ctx.fill();
    // Wrinkle folds on blanket
    ctx.strokeStyle = 'rgba(15, 17, 13, 0.48)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-6, -10);
    ctx.quadraticCurveTo(8, -4, 24, -8);
    ctx.moveTo(-10, 3);
    ctx.quadraticCurveTo(7, 7, 25, 2);
    ctx.stroke();
    // Flat yellowed pillow at left headboard
    ctx.fillStyle = '#8b806a';
    ctx.strokeStyle = '#3a342a';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(-27, -10, 12, 18, 3);
    ctx.fill();
    ctx.stroke();
    // Rusted iron headboard bar
    ctx.fillStyle = '#483226';
    ctx.fillRect(-33, -17, 4, 32);
    ctx.restore();

    // 4. Cast-Iron Potbelly Stove & Stacked Firewood (tucked in SE corner)
    ctx.save();
    ctx.translate(innerR - 26, innerB - 24);
    // Brick hearth pad beneath stove
    ctx.fillStyle = '#362a23';
    ctx.strokeStyle = '#16110e';
    ctx.lineWidth = 1.6;
    ctx.fillRect(-22, -20, 42, 38);
    ctx.strokeRect(-22, -20, 42, 38);
    // Stacked split logs next to stove
    ctx.fillStyle = '#5c4129';
    ctx.strokeStyle = '#1b130c';
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 3; k++) {
      ctx.fillRect(-20, -16 + k * 5, 12, 4.4);
      ctx.strokeRect(-20, -16 + k * 5, 12, 4.4);
    }
    // Round cast-iron stove body
    ctx.fillStyle = '#202120';
    ctx.strokeStyle = '#0c0d0c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(5, 0, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Flickering dull ember slit in stove grate
    const emberGlow = 0.45 + Math.sin(engine.simTime * 6.5) * 0.25;
    ctx.fillStyle = `rgba(225, 96, 36, ${emberGlow.toFixed(3)})`;
    ctx.fillRect(-2, -3, 3.5, 6);
    // Top iron stove pipe ring
    ctx.fillStyle = '#333633';
    ctx.beginPath();
    ctx.arc(7, -1, 5.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 5. Wall-flush dusty shelf / supply crate & scattered yellowed journal pages near North wall
    ctx.save();
    ctx.fillStyle = '#423020';
    ctx.strokeStyle = '#18110b';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-48, innerT + 2, 38, 12);
    ctx.strokeRect(-48, innerT + 2, 38, 12);
    // Tiny dusty glass jars on shelf
    ctx.fillStyle = 'rgba(136, 152, 134, 0.65)';
    ctx.beginPath();
    ctx.arc(-40, innerT + 8, 3, 0, Math.PI * 2);
    ctx.arc(-31, innerT + 7, 2.6, 0, Math.PI * 2);
    ctx.fill();

    // Scattered yellowed parchment notes on floorboards
    const notes = [
      { nx: 52, ny: -62, rot: 0.35 },
      { nx: 64, ny: -56, rot: -0.22 },
      { nx: -56, ny: -50, rot: 0.58 },
    ];
    for (const n of notes) {
      ctx.save();
      ctx.translate(n.nx, n.ny);
      ctx.rotate(n.rot);
      ctx.fillStyle = 'rgba(182, 166, 132, 0.72)';
      ctx.fillRect(-5, -6.5, 10, 13);
      ctx.fillStyle = 'rgba(38, 30, 22, 0.55)';
      ctx.fillRect(-3.5, -3.5, 7, 1.2);
      ctx.fillRect(-3.5, -0.5, 6, 1.2);
      ctx.fillRect(-3.5, 2.5, 5, 1.2);
      ctx.restore();
    }

    // Claw gouges scratched into floorboards by East door & North window
    ctx.strokeStyle = 'rgba(12, 9, 7, 0.55)';
    ctx.lineWidth = 1.2;
    for (let s = 0; s < 4; s++) {
      ctx.beginPath();
      ctx.moveTo(innerR - 18, -14 + s * 4.2);
      ctx.lineTo(innerR - 3, -12 + s * 4.4);
      ctx.stroke();
    }

    // Tracked-in rain mud puddle inside South door during wet weather
    if (engine.weather.wetness > 0.25) {
      ctx.fillStyle = `rgba(18, 22, 22, ${(engine.weather.wetness * 0.42).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(0, innerB - 14, 24, 10, 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // --- POI Environmental Storytelling Props (Sawmill, Hunter Camp, Withered Shrine) ---
  private drawPoiStorytelling(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number
  ) {
    // 1. Old Sawmill (NE: ~740, -490): Circular Saw Bench + Sawdust Mound + Timber Trestles
    if (viewR > 580 && viewL < 900 && viewB > -650 && viewT < -350) {
      ctx.save();
      // Golden rotting sawdust mound
      const sd = ctx.createRadialGradient(718, -500, 4, 718, -500, 34);
      sd.addColorStop(0, 'rgba(124, 94, 52, 0.62)');
      sd.addColorStop(0.65, 'rgba(92, 68, 38, 0.34)');
      sd.addColorStop(1, 'rgba(92, 68, 38, 0)');
      ctx.fillStyle = sd;
      ctx.beginPath();
      ctx.arc(718, -500, 34, 0, Math.PI * 2);
      ctx.fill();

      // Rusted circular saw table
      ctx.translate(722, -502);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(-28, -14, 58, 30);
      ctx.fillStyle = '#473626';
      ctx.strokeStyle = '#18120c';
      ctx.lineWidth = 2;
      ctx.fillRect(-29, -15, 58, 30);
      ctx.strokeRect(-29, -15, 58, 30);
      // Steel saw slot & rusted circular blade edge
      ctx.fillStyle = '#141514';
      ctx.fillRect(-16, -2, 32, 4);
      ctx.fillStyle = '#8b8f8c';
      ctx.fillRect(-13, -1.2, 26, 2.4);
      ctx.fillStyle = 'rgba(126, 44, 28, 0.55)';
      ctx.fillRect(-4, -1.2, 10, 2.4);
      ctx.restore();
    }

    // 2. Hunter Camp (SW: ~-640, 630): Charred Stone Firepit, Torn Tarp & Dried Blood Trail
    if (viewR > -790 && viewL < -500 && viewB > 490 && viewT < 760) {
      ctx.save();
      // Tattered olive canvas lean-to ground sheet near camp walls
      ctx.fillStyle = 'rgba(56, 62, 44, 0.55)';
      ctx.strokeStyle = 'rgba(20, 22, 16, 0.72)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-718, 568);
      ctx.lineTo(-650, 568);
      ctx.lineTo(-662, 616);
      ctx.lineTo(-718, 628);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Dead charred campfire pit
      ctx.translate(-636, 646);
      const ash = ctx.createRadialGradient(0, 0, 3, 0, 0, 24);
      ash.addColorStop(0, 'rgba(18, 16, 15, 0.85)');
      ash.addColorStop(0.7, 'rgba(42, 36, 31, 0.45)');
      ash.addColorStop(1, 'rgba(42, 36, 31, 0)');
      ctx.fillStyle = ash;
      ctx.beginPath();
      ctx.arc(0, 0, 24, 0, Math.PI * 2);
      ctx.fill();

      // Ring of soot-stained stones
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        ctx.fillStyle = i % 2 === 0 ? '#454842' : '#353732';
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 14, Math.sin(a) * 14, 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
      // Crossed charred firewood logs
      ctx.strokeStyle = '#181412';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(-10, -6);
      ctx.lineTo(10, 6);
      ctx.moveTo(-8, 7);
      ctx.lineTo(9, -7);
      ctx.stroke();
      ctx.restore();

      // Dried dark blood drag streak leading toward the fallen hunter corpse (-690, 685)
      ctx.save();
      ctx.strokeStyle = 'rgba(64, 12, 12, 0.56)';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-648, 658);
      ctx.quadraticCurveTo(-672, 668, -688, 684);
      ctx.stroke();
      ctx.restore();
    }

    // 3. Withered Shrine (SE: ~690, 610): Cracked Pagan Stone Circle, Ash Sigils & Fungal Veins
    if (viewR > 540 && viewL < 840 && viewB > 470 && viewT < 760) {
      ctx.save();
      ctx.translate(690, 605);
      // Outer weathered stone ring
      ctx.strokeStyle = 'rgba(28, 30, 26, 0.78)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, 68, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(138, 134, 118, 0.28)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, 52, 0, Math.PI * 2);
      ctx.stroke();

      // Eastern European pagan sun-wheel / chalk sigil spokes
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 26, Math.sin(a) * 26);
        ctx.lineTo(Math.cos(a) * 64, Math.sin(a) * 64);
        ctx.stroke();
      }

      // Creeping bioluminescent mycelium veins pulsing faintly toward Odd Essence mushrooms
      const pulse = 0.25 + Math.sin(engine.simTime * 2.2) * 0.12;
      ctx.strokeStyle = `rgba(88, 198, 174, ${pulse.toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(-12, -24, 0, -45);
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(18, 22, 30, 50);
      ctx.stroke();

      // Melted tallow candle stubs around inner ring
      for (const [cx, cy] of [
        [-28, -28],
        [30, -24],
        [-24, 32],
        [26, 28],
      ]) {
        ctx.fillStyle = 'rgba(196, 184, 154, 0.65)';
        ctx.beginPath();
        ctx.arc(cx, cy, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#181412';
        ctx.fillRect(cx - 0.6, cy - 0.6, 1.2, 1.2);
      }
      ctx.restore();
    }
  }

  // --- Architectural Brushwork: Hewn Cabin Timber Walls ---
  private drawCabinTimberWall(ctx: CanvasRenderingContext2D, w: RectObstacle) {
    // Ground contact drop shadow
    ctx.fillStyle = 'rgba(5, 4, 3, 0.56)';
    ctx.fillRect(w.x + 4, w.y + 5, w.w, w.h);

    // Base textured hewn log fill
    ctx.fillStyle = this.wallLogPat ?? '#4a392a';
    ctx.fillRect(w.x, w.y, w.w, w.h);

    // Individual log course divisions along wall length
    const horiz = w.w >= w.h;
    ctx.strokeStyle = 'rgba(16, 11, 7, 0.72)';
    ctx.lineWidth = 1.4;
    if (horiz) {
      ctx.beginPath();
      ctx.moveTo(w.x, w.y + w.h * 0.34);
      ctx.lineTo(w.x + w.w, w.y + w.h * 0.34);
      ctx.moveTo(w.x, w.y + w.h * 0.68);
      ctx.lineTo(w.x + w.w, w.y + w.h * 0.68);
      ctx.stroke();
      // Cross timber pegs every 34px
      for (let px = w.x + 18; px < w.x + w.w - 10; px += 34) {
        ctx.fillStyle = 'rgba(14, 10, 7, 0.58)';
        ctx.fillRect(px, w.y + 2, 2, w.h - 4);
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(w.x + w.w * 0.34, w.y);
      ctx.lineTo(w.x + w.w * 0.34, w.y + w.h);
      ctx.moveTo(w.x + w.w * 0.68, w.y);
      ctx.lineTo(w.x + w.w * 0.68, w.y + w.h);
      ctx.stroke();
      for (let py = w.y + 18; py < w.y + w.h - 10; py += 34) {
        ctx.fillStyle = 'rgba(14, 10, 7, 0.58)';
        ctx.fillRect(w.x + 2, py, w.w - 4, 2);
      }
    }

    // Crisp outer dark ink outline & subtle northwest timber top highlight
    ctx.strokeStyle = '#120d09';
    ctx.lineWidth = 2.2;
    ctx.strokeRect(w.x, w.y, w.w, w.h);
    ctx.fillStyle = 'rgba(235, 208, 168, 0.14)';
    ctx.fillRect(w.x + 2, w.y + 2, w.w - 4, 3);
    ctx.fillRect(w.x + 2, w.y + 2, 3, w.h - 4);
  }

  private drawHideoutCornerNotches(ctx: CanvasRenderingContext2D) {
    const { x, y, w, h } = HIDEOUT_RECT;
    const corners = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ];
    for (const [cx, cy] of corners) {
      ctx.fillStyle = '#3a2b1e';
      ctx.strokeStyle = '#100b08';
      ctx.lineWidth = 2;
      ctx.fillRect(cx - 5, cy - 5, 10, 10);
      ctx.strokeRect(cx - 5, cy - 5, 10, 10);
      // Rusted iron corner strap nail
      ctx.fillStyle = '#626862';
      ctx.fillRect(cx - 2, cy - 2, 4, 4);
    }
  }

  // --- Architectural Brushwork: Crumbling Stone Masonry Ruin Walls ---
  private drawRuinMasonryWall(ctx: CanvasRenderingContext2D, w: RectObstacle) {
    ctx.fillStyle = 'rgba(5, 6, 5, 0.55)';
    ctx.fillRect(w.x + 4, w.y + 5, w.w, w.h);

    ctx.fillStyle = this.wallRuinPat ?? '#3d4039';
    ctx.fillRect(w.x, w.y, w.w, w.h);

    ctx.strokeStyle = '#121412';
    ctx.lineWidth = 2.2;
    ctx.strokeRect(w.x, w.y, w.w, w.h);

    // Deterministic moss patches & scattered crumbling rubble chunks along edges
    const rng = createRng(Math.abs(Math.floor(w.x * 13 + w.y * 29)) + 7);
    const specks = Math.max(3, Math.floor((w.w + w.h) / 38));
    for (let i = 0; i < specks; i++) {
      const mx = w.x + rng() * w.w;
      const my = w.y + rng() * w.h;
      ctx.fillStyle = 'rgba(46, 68, 36, 0.45)';
      ctx.beginPath();
      ctx.ellipse(mx, my, 5 + rng() * 6, 3 + rng() * 4, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();

      // Fallen rubble stone beside ruin wall
      const rx = w.x + rng() * w.w;
      const ry = w.y + (rng() > 0.5 ? -3 : w.h + 3);
      ctx.fillStyle = '#484a43';
      ctx.fillRect(rx - 2.5, ry - 2, 5, 4);
    }
  }

  // --- Iconic Set-Piece: Crashed Soviet Supply Truck (Cargo Bed + Rusted Cab) ---
  private drawTruckSegment(ctx: CanvasRenderingContext2D, w: RectObstacle) {
    const isBody = w.id === 'truck_body';
    ctx.save();
    // Deep undercarriage drop shadow + leaked black engine oil slick on gravel
    ctx.fillStyle = 'rgba(4, 5, 4, 0.68)';
    ctx.fillRect(w.x + 5, w.y + 6, w.w + 2, w.h + 2);

    if (isBody) {
      // Leaked motor oil slick beneath cargo rear
      ctx.fillStyle = 'rgba(10, 12, 13, 0.62)';
      ctx.beginPath();
      ctx.ellipse(w.x + w.w * 0.72, w.y + w.h + 6, 26, 9, 0.12, 0, Math.PI * 2);
      ctx.fill();

      // Heavy rear tires protruding slightly beneath bed
      ctx.fillStyle = '#151615';
      for (const tx of [w.x + 22, w.x + w.w - 30]) {
        ctx.fillRect(tx, w.y - 4, 18, 5);
        ctx.fillRect(tx, w.y + w.h - 1, 18, 5);
      }

      // Steel cargo bed frame
      ctx.fillStyle = '#333b34';
      ctx.strokeStyle = '#121512';
      ctx.lineWidth = 2.4;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeRect(w.x, w.y, w.w, w.h);

      // Torn olive-drab canvas tarpaulin cover with metal hoop ribs
      ctx.fillStyle = '#464d3e';
      ctx.fillRect(w.x + 4, w.y + 3, w.w * 0.68, w.h - 6);
      // Exposed rotting wooden cargo floor inside torn rear section
      ctx.fillStyle = '#3d2d20';
      ctx.fillRect(w.x + w.w * 0.68, w.y + 4, w.w * 0.30, w.h - 8);
      // Cracked canvas hoop ribs across roof
      ctx.strokeStyle = 'rgba(18, 20, 16, 0.65)';
      ctx.lineWidth = 2.4;
      for (let rx = w.x + 16; rx < w.x + w.w - 10; rx += 22) {
        ctx.beginPath();
        ctx.moveTo(rx, w.y + 2);
        ctx.lineTo(rx, w.y + w.h - 2);
        ctx.stroke();
      }
      // Rust corrosion blotches & rain grime
      ctx.fillStyle = 'rgba(110, 52, 28, 0.48)';
      ctx.beginPath();
      ctx.ellipse(w.x + 36, w.y + 14, 18, 8, 0.2, 0, Math.PI * 2);
      ctx.ellipse(w.x + 92, w.y + 34, 14, 7, -0.3, 0, Math.PI * 2);
      ctx.fill();
      // Canvas tie-down ropes along top & bottom edges
      ctx.fillStyle = '#9a8c6c';
      for (let rx = w.x + 12; rx < w.x + w.w * 0.68; rx += 16) {
        ctx.fillRect(rx, w.y + 1, 2.5, 3);
        ctx.fillRect(rx, w.y + w.h - 4, 2.5, 3);
      }
    } else {
      // Front cab tires
      ctx.fillStyle = '#151615';
      ctx.fillRect(w.x + 14, w.y - 4, 16, 5);
      ctx.fillRect(w.x + 14, w.y + w.h - 1, 16, 5);

      // Soviet olive-green rusted cab & engine hood
      ctx.fillStyle = '#39443a';
      ctx.strokeStyle = '#121512';
      ctx.lineWidth = 2.2;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeRect(w.x, w.y, w.w, w.h);

      // Cracked blue-grey windshield glass strip
      ctx.fillStyle = '#253136';
      ctx.fillRect(w.x + 15, w.y + 4, 9, w.h - 8);
      ctx.strokeStyle = 'rgba(182, 206, 214, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w.x + 16, w.y + 9);
      ctx.lineTo(w.x + 23, w.y + 18);
      ctx.moveTo(w.x + 21, w.y + 15);
      ctx.lineTo(w.x + 17, w.y + 26);
      ctx.stroke();

      // Hood louvers & heavy rust spot
      ctx.fillStyle = 'rgba(118, 54, 28, 0.58)';
      ctx.fillRect(w.x + 25, w.y + 6, 14, w.h - 12);
      ctx.strokeStyle = '#1b1d1a';
      ctx.lineWidth = 1.4;
      for (let ly = w.y + 10; ly < w.y + w.h - 8; ly += 6) {
        ctx.beginPath();
        ctx.moveTo(w.x + 28, ly);
        ctx.lineTo(w.x + 38, ly);
        ctx.stroke();
      }
      // Broken front bumper & headlights
      ctx.fillStyle = '#242624';
      ctx.fillRect(w.x + w.w - 2, w.y + 2, 4, w.h - 4);
      ctx.fillStyle = '#9aa392';
      ctx.fillRect(w.x + w.w - 1, w.y + 5, 3, 6);
      ctx.fillRect(w.x + w.w - 1, w.y + w.h - 11, 3, 6);
    }
    ctx.restore();
  }

  // --- Architectural Brushwork: Recessed Barricaded Doors & Broken Windows ---
  private drawBarricadeSlot(
    ctx: CanvasRenderingContext2D,
    b: { x: number; y: number; w: number; h: number; orientation: 'h' | 'v'; hp: number; maxHp: number; kind: 'door' | 'window' }
  ) {
    // Sill / doorway threshold
    ctx.fillStyle = b.kind === 'window' ? 'rgba(22, 30, 29, 0.82)' : 'rgba(28, 20, 14, 0.72)';
    ctx.fillRect(b.x, b.y, b.w, b.h);

    // Timber jamb posts at both ends
    ctx.fillStyle = '#2b1f15';
    if (b.orientation === 'h') {
      ctx.fillRect(b.x - 2, b.y - 1, 4, b.h + 2);
      ctx.fillRect(b.x + b.w - 2, b.y - 1, 4, b.h + 2);
    } else {
      ctx.fillRect(b.x - 1, b.y - 2, b.w + 2, 4);
      ctx.fillRect(b.x - 1, b.y + b.h - 2, b.w + 2, 4);
    }

    // Jagged broken window glass shards catching faint light
    if (b.kind === 'window') {
      ctx.fillStyle = 'rgba(154, 178, 174, 0.36)';
      if (b.orientation === 'h') {
        ctx.beginPath();
        ctx.moveTo(b.x + 6, b.y + 2);
        ctx.lineTo(b.x + 14, b.y + b.h * 0.65);
        ctx.lineTo(b.x + 20, b.y + 2);
        ctx.moveTo(b.x + b.w - 8, b.y + b.h - 2);
        ctx.lineTo(b.x + b.w - 16, b.y + b.h * 0.3);
        ctx.lineTo(b.x + b.w - 22, b.y + b.h - 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(b.x + 2, b.y + 8);
        ctx.lineTo(b.x + b.w * 0.7, b.y + 16);
        ctx.lineTo(b.x + 2, b.y + 22);
        ctx.fill();
      }
    }

    // Rough nailed-across barricade planks with crooked nails
    if (b.hp > 0) {
      const planks = Math.ceil((b.hp / b.maxHp) * 3);
      for (let k = 0; k < planks; k++) {
        const tilt = (k - 1) * 0.032;
        ctx.save();
        if (b.orientation === 'h') {
          const py = b.y + 1 + k * 4.4;
          ctx.translate(b.x + b.w * 0.5, py + 2);
          ctx.rotate(tilt);
          ctx.fillStyle = k === 1 ? '#6e4e31' : '#805d3b';
          ctx.strokeStyle = '#1b120a';
          ctx.lineWidth = 1.4;
          ctx.fillRect(-b.w * 0.5 - 4, -2.2, b.w + 8, 4.4);
          ctx.strokeRect(-b.w * 0.5 - 4, -2.2, b.w + 8, 4.4);
          // Nail heads
          ctx.fillStyle = '#181817';
          ctx.fillRect(-b.w * 0.5, -0.8, 2, 2);
          ctx.fillRect(b.w * 0.5 - 2, -0.8, 2, 2);
        } else {
          const px = b.x + 1 + k * 4.4;
          ctx.translate(px + 2, b.y + b.h * 0.5);
          ctx.rotate(tilt);
          ctx.fillStyle = k === 1 ? '#6e4e31' : '#805d3b';
          ctx.strokeStyle = '#1b120a';
          ctx.lineWidth = 1.4;
          ctx.fillRect(-2.2, -b.h * 0.5 - 4, 4.4, b.h + 8);
          ctx.strokeRect(-2.2, -b.h * 0.5 - 4, 4.4, b.h + 8);
          ctx.fillStyle = '#181817';
          ctx.fillRect(-0.8, -b.h * 0.5, 2, 2);
          ctx.fillRect(-0.8, b.h * 0.5 - 2, 2, 2);
        }
        ctx.restore();
      }
    }
  }

  // --- Multi-Faceted Hand-Painted Mossy Boulders ---
  private drawPainterlyRock(ctx: CanvasRenderingContext2D, r: RockObstacle) {
    const rng = createRng(Math.floor(r.seed * 100) + r.id * 19 + 3);
    const sides = 9;
    const pts: Vec2[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + r.seed * 0.1;
      const rad = r.r * (0.82 + rng() * 0.28);
      pts.push({ x: r.x + Math.cos(a) * rad, y: r.y + Math.sin(a) * rad });
    }

    // Drop shadow
    ctx.fillStyle = 'rgba(5, 6, 5, 0.55)';
    ctx.beginPath();
    pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x + 3, p.y + 4) : ctx.lineTo(p.x + 3, p.y + 4)));
    ctx.closePath();
    ctx.fill();

    // Base cold Baltic granite polygon
    ctx.fillStyle = '#363b34';
    ctx.strokeStyle = '#121512';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Upper-west lighter rock facet
    ctx.fillStyle = 'rgba(98, 106, 94, 0.34)';
    ctx.beginPath();
    ctx.moveTo(r.x - r.r * 0.1, r.y - r.r * 0.1);
    ctx.lineTo(pts[4].x, pts[4].y);
    ctx.lineTo(pts[5].x, pts[5].y);
    ctx.lineTo(pts[6].x, pts[6].y);
    ctx.closePath();
    ctx.fill();

    // Rock fissure crevice
    ctx.strokeStyle = 'rgba(14, 16, 14, 0.65)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pts[1].x * 0.5 + r.x * 0.5, pts[1].y * 0.5 + r.y * 0.5);
    ctx.lineTo(r.x - 2, r.y + 1);
    ctx.lineTo(pts[6].x * 0.65 + r.x * 0.35, pts[6].y * 0.65 + r.y * 0.35);
    ctx.stroke();

    // Creeping damp moss crest
    ctx.fillStyle = 'rgba(68, 94, 54, 0.44)';
    ctx.beginPath();
    ctx.ellipse(r.x - r.r * 0.25, r.y - r.r * 0.22, r.r * 0.46, r.r * 0.28, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawRoofCutaway(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number },
    alpha: number,
    warmWindowLeak: boolean,
    simTime: number,
    hasChimney: boolean
  ) {
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);

    // Deep eave drop shadow onto surrounding forest ground
    ctx.fillStyle = 'rgba(5, 6, 5, 0.62)';
    ctx.fillRect(rect.x + 10, rect.y + 12, rect.w + 4, rect.h + 4);

    // Shingled Eastern European timber roof with broken shingle holes
    ctx.fillStyle = this.roofPat ?? '#251e18';
    ctx.fillRect(rect.x - 8, rect.y - 8, rect.w + 16, rect.h + 16);

    // Pitched ridge shadow split (north slope deeper shadow)
    const midY = rect.y + rect.h * 0.5;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.fillRect(rect.x - 8, rect.y - 8, rect.w + 16, rect.h * 0.5 + 8);

    // Hand-hewn wooden ridge beam with cap planks
    ctx.fillStyle = '#33261b';
    ctx.strokeStyle = '#110d09';
    ctx.lineWidth = 2;
    ctx.fillRect(rect.x - 9, midY - 5, rect.w + 18, 10);
    ctx.strokeRect(rect.x - 9, midY - 5, rect.w + 18, 10);

    // Patched nailed board repairs on roof slopes
    ctx.fillStyle = '#4c3827';
    ctx.strokeStyle = '#16100b';
    ctx.lineWidth = 1.4;
    ctx.fillRect(rect.x + rect.w * 0.62, rect.y + 28, 42, 16);
    ctx.strokeRect(rect.x + rect.w * 0.62, rect.y + 28, 42, 16);

    // Weathered rusted gutters & eave trim
    ctx.strokeStyle = '#14110e';
    ctx.lineWidth = 3;
    ctx.strokeRect(rect.x - 8, rect.y - 8, rect.w + 16, rect.h + 16);

    // Brick chimney & rusted iron stove pipe on Hideout
    if (hasChimney) {
      ctx.fillStyle = '#3d2c24';
      ctx.strokeStyle = '#130e0c';
      ctx.lineWidth = 2;
      ctx.fillRect(rect.x + 42, rect.y + 30, 28, 28);
      ctx.strokeRect(rect.x + 42, rect.y + 30, 28, 28);
      // Dark flue cavity
      ctx.fillStyle = '#0c0a09';
      ctx.fillRect(rect.x + 48, rect.y + 36, 16, 16);

      // Subtle rising hearth smoke wisps drifting in the wind
      if (warmWindowLeak) {
        for (let k = 0; k < 3; k++) {
          const p = (simTime * 0.35 + k * 0.33) % 1;
          const sx = rect.x + 56 + p * 34 + Math.sin(simTime * 1.4 + k) * 5;
          const sy = rect.y + 44 - p * 22;
          ctx.fillStyle = `rgba(116, 122, 114, ${((1 - p) * 0.24).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx, sy, 8 + p * 16, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Warm golden glow leaking through eaves & cracks when Generator burns indoors
    if (warmWindowLeak) {
      ctx.strokeStyle = 'rgba(235, 168, 76, 0.38)';
      ctx.lineWidth = 3.2;
      ctx.strokeRect(rect.x - 8, rect.y - 8, rect.w + 16, rect.h + 16);
    }

    ctx.restore();
  }

  private renderSceneNormals(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    W: number,
    H: number,
    sx: number,
    sy: number,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number
  ) {
    ctx.save();
    ctx.scale(sx, sy);
    ctx.fillStyle = 'rgb(128, 128, 20)';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(-viewL, -viewT);

    // 1. Baked ground tangent-space normal + Blue puddle mask
    if (this.groundNormalPat) {
      ctx.fillStyle = this.groundNormalPat;
      ctx.fillRect(viewL, viewT, W, H);
    }

    // 2. Cabin & Sawmill timber plank normals (dry indoors -> B=18)
    if (this.woodNormalPat) {
      for (const z of engine.world.zones) {
        if (z.surface !== 'wood') continue;
        if (z.x + z.w < viewL - 40 || z.x > viewR + 40 || z.y + z.h < viewT - 40 || z.y > viewB + 40) {
          continue;
        }
        ctx.fillStyle = this.woodNormalPat;
        ctx.fillRect(z.x, z.y, z.w, z.h);
      }
    }

    // 3. Beveled wall & metallic truck normals
    for (const w of engine.world.walls) {
      if (w.kind === 'table') continue;
      if (w.x + w.w < viewL - 30 || w.x > viewR + 30 || w.y + w.h < viewT - 30 || w.y > viewB + 30) {
        continue;
      }
      ctx.fillStyle = w.kind === 'truck' ? 'rgb(128, 128, 155)' : 'rgb(128, 128, 32)';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = 'rgb(128, 228, 32)';
      ctx.fillRect(w.x, w.y, w.w, 4);
      ctx.fillStyle = 'rgb(128, 32, 32)';
      ctx.fillRect(w.x, w.y + w.h - 4, w.w, 4);
      ctx.fillStyle = 'rgb(32, 128, 32)';
      ctx.fillRect(w.x, w.y, 4, w.h);
      ctx.fillStyle = 'rgb(228, 128, 32)';
      ctx.fillRect(w.x + w.w - 4, w.y, 4, w.h);
    }

    // 4. Cylindrical radial normals for tree trunks & rocks
    for (const t of engine.world.trees) {
      if (t.x < viewL - 50 || t.x > viewR + 50 || t.y < viewT - 50 || t.y > viewB + 50) continue;
      const g = ctx.createRadialGradient(t.x - t.trunkR * 0.35, t.y - t.trunkR * 0.35, 1, t.x, t.y, t.trunkR * 1.15);
      g.addColorStop(0, 'rgb(196, 196, 35)');
      g.addColorStop(1, 'rgb(60, 60, 35)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.trunkR * 1.15, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const r of engine.world.rocks) {
      if (r.x < viewL - 50 || r.x > viewR + 50 || r.y < viewT - 50 || r.y > viewB + 50) continue;
      const g = ctx.createRadialGradient(r.x - r.r * 0.3, r.y - r.r * 0.3, 2, r.x, r.y, r.r);
      g.addColorStop(0, 'rgb(204, 204, 90)');
      g.addColorStop(1, 'rgb(54, 54, 50)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private renderShadowMasksAndLights(
    engine: GameEngine,
    W: number,
    H: number,
    viewL: number,
    viewT: number,
    coneHalfRad: number
  ) {
    const sctx = this.shadowCtx;
    const sw = this.shadowCanvas.width;
    const sh = this.shadowCanvas.height;
    const sx = sw / W;
    const sy = sh / H;

    sctx.save();
    sctx.globalCompositeOperation = 'source-over';
    sctx.fillStyle = '#000000';
    sctx.fillRect(0, 0, sw, sh);
    sctx.scale(sx, sy);
    sctx.translate(-viewL, -viewT);
    sctx.globalCompositeOperation = 'lighter';

    this.gpuLights.length = 0;
    const maxLights = Quality.preset.maxLights;
    const p = engine.player;

    const fillPoly = (poly: Vec2[], color: string) => {
      if (poly.length < 3) return;
      sctx.fillStyle = color;
      sctx.beginPath();
      sctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) sctx.lineTo(poly[i].x, poly[i].y);
      sctx.closePath();
      sctx.fill();
    };

    // Channel R: Player Flashlight Cone
    if (p.flashlightOn && p.flickerVal > 0.05) {
      const coneLen = 455;
      computeVisibilityPolygon(
        engine.world,
        p.x,
        p.y,
        coneLen,
        this.polyScratch,
        p.angle,
        coneHalfRad + 0.06
      );
      fillPoly(this.polyScratch, '#ff0000');

      const warmTone = Variants.val.light === 'b';
      this.gpuLights.push({
        x: p.x - viewL,
        y: p.y - viewT,
        radius: coneLen,
        intensity: 2.35 * p.flickerVal,
        r: warmTone ? 1.0 : 0.78,
        g: warmTone ? 0.80 : 0.90,
        b: warmTone ? 0.50 : 1.0,
        dirX: Math.cos(p.angle),
        dirY: Math.sin(p.angle),
        coneCos: Math.cos(coneHalfRad),
        shadowChannel: 0,
      });
    }

    // Channel B: Close 360° Ambient Awareness Halo
    const auraR = engine.phase === 'day' ? 175 : engine.phase === 'dusk' ? 132 : 98;
    computeVisibilityPolygon(engine.world, p.x, p.y, auraR, this.auraPolyScratch);
    fillPoly(this.auraPolyScratch, '#0000ff');
    this.gpuLights.push({
      x: p.x - viewL,
      y: p.y - viewT,
      radius: auraR,
      intensity: engine.phase === 'night' ? 0.85 : 1.15,
      r: 0.74,
      g: 0.78,
      b: 0.74,
      dirX: 0,
      dirY: 0,
      coneCos: -2.0,
      shadowChannel: 2,
    });

    // Channel G: Hideout Generator Shelter Lamps + Active Crimson Flares
    if (engine.generatorOn && engine.generatorFuel > 0) {
      const sputter =
        engine.generatorFuel < 16
          ? Math.sin(engine.simTime * 24) > 0.35
            ? 0.32
            : 0.96
          : 0.96 + Math.sin(engine.simTime * 7.2) * 0.04;
      const lampR = 205;
      for (const lamp of SHELTER_LAMPS) {
        if (this.gpuLights.length >= maxLights) break;
        if (dist(lamp.x, lamp.y, engine.camX, engine.camY) > W * 0.9) continue;
        computeVisibilityPolygon(engine.world, lamp.x, lamp.y, lampR, this.lampPolyScratch);
        fillPoly(this.lampPolyScratch, '#00ff00');
        this.gpuLights.push({
          x: lamp.x - viewL,
          y: lamp.y - viewT,
          radius: lampR,
          intensity: 2.05 * sputter,
          r: 1.0,
          g: 0.69,
          b: 0.34,
          dirX: 0,
          dirY: 0,
          coneCos: -2.0,
          shadowChannel: 1,
        });
      }
    }

    for (const f of engine.flares) {
      if (this.gpuLights.length >= maxLights) break;
      const fade = clamp(f.life / 3, 0.2, 1);
      const flicker = 0.9 + Math.sin(engine.simTime * 36 + f.id) * 0.1;
      const flareR = 275 * fade;
      computeVisibilityPolygon(engine.world, f.x, f.y, flareR, this.lampPolyScratch);
      fillPoly(this.lampPolyScratch, '#00ff00');
      this.gpuLights.push({
        x: f.x - viewL,
        y: f.y - viewT,
        radius: flareR,
        intensity: 2.4 * fade * flicker,
        r: 1.0,
        g: 0.36,
        b: 0.22,
        dirX: 0,
        dirY: 0,
        coneCos: -2.0,
        shadowChannel: 1,
      });
    }

    // Channel 3 (Unshadowed subtle point glow): Nearby Odd Essence Mushrooms
    for (const node of engine.world.essences) {
      if (node.harvested || this.gpuLights.length >= maxLights) continue;
      if (dist(node.x, node.y, engine.camX, engine.camY) > W * 0.65) continue;
      const pulse = 0.75 + Math.sin(engine.simTime * 2.8 + node.pulsePhase) * 0.25;
      this.gpuLights.push({
        x: node.x - viewL,
        y: node.y - viewT,
        radius: 95,
        intensity: 0.85 * pulse,
        r: 0.40,
        g: 0.88,
        b: 0.77,
        dirX: 0,
        dirY: 0,
        coneCos: -2.0,
        shadowChannel: 3,
      });
    }

    sctx.restore();
  }

  private renderAboveDarknessOverlays(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    W: number,
    H: number,
    viewL: number,
    viewT: number
  ) {
    // 1. Drifting Eastern European Forest Fog Tendrils
    const dense = Variants.val.fog === 'b';
    const layers = Quality.preset.fogLayers;
    const baseAlpha =
      (dense ? 0.10 : 0.05) * (engine.phase === 'dusk' ? 1.25 : engine.phase === 'night' ? 0.85 : 1);

    ctx.save();
    for (let l = 0; l < layers; l++) {
      const driftX = (engine.simTime * (12 + l * 6) + viewL * (0.18 + l * 0.08)) % 420;
      const driftY = (engine.simTime * (4 + l * 3) + viewT * (0.18 + l * 0.08)) % 360;
      const count = 4 + l * 2;
      for (let i = 0; i < count; i++) {
        const fx = ((i * 290 - driftX + 840) % (W + 420)) - 210;
        const fy = ((i * 197 + l * 130 - driftY + 720) % (H + 360)) - 180;
        const rad = 170 + l * 55;
        const grad = ctx.createRadialGradient(fx, fy, 10, fx, fy, rad);
        grad.addColorStop(0, `rgba(148, 162, 146, ${baseAlpha.toFixed(3)})`);
        grad.addColorStop(1, 'rgba(148, 162, 146, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(fx, fy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // 2. Slanted Rain Streaks
    ctx.save();
    ctx.translate(-viewL, -viewT);

    if (engine.weather.rainIntensity > 0.04) {
      const windDx = Math.cos(engine.weather.windAngle);
      const windDy = Math.sin(engine.weather.windAngle);
      const flashBoost = engine.weather.lightningFlash * 0.45;
      ctx.strokeStyle =
        flashBoost > 0.1 ? 'rgba(214, 228, 244, 0.72)' : 'rgba(176, 192, 196, 0.55)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let i = 0; i < engine.rainDrops.count; i++) {
        const d = engine.rainDrops.items[i];
        if (!d.active) continue;
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - windDx * d.len, d.y - windDy * d.len);
      }
      ctx.stroke();
    }

    // 3. Eerie Sound Ripples piercing the pitch dark
    for (let i = 0; i < engine.ripples.count; i++) {
      const r = engine.ripples.items[i];
      if (!r.active) continue;
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = clamp(r.alpha, 0, 1);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 4. Dusk/Night Hideout Return Compass Arrow
    if (engine.mode === 'play' && (engine.phase === 'dusk' || engine.phase === 'night')) {
      const dHome = dist(engine.player.x, engine.player.y, 0, 0);
      if (dHome > 290) {
        const homeAng = Math.atan2(-engine.player.y, -engine.player.x);
        const ax = engine.player.x + Math.cos(homeAng) * 68;
        const ay = engine.player.y + Math.sin(homeAng) * 68;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(homeAng);
        ctx.fillStyle = 'rgba(232, 174, 88, 0.9)';
        ctx.beginPath();
        ctx.moveTo(9, 0);
        ctx.lineTo(-5, -5);
        ctx.lineTo(-2, 0);
        ctx.lineTo(-5, 5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // 5. Diegetic Interact Prompt & Hold-to-Search Ring
    const snapPrompt = engine.getHudSnapshot().prompt;
    if (engine.mode === 'play' && snapPrompt) {
      this.drawDiegeticPrompt(
        ctx,
        snapPrompt.worldX,
        snapPrompt.worldY,
        snapPrompt.label,
        snapPrompt.progress
      );
    }

    ctx.restore();
  }

  private renderFallbackDarkness(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    W: number,
    H: number,
    viewL: number,
    viewT: number,
    coneHalfRad: number
  ) {
    const lctx = this.fallbackLightCtx;
    const lw = this.fallbackLightCanvas.width;
    const lh = this.fallbackLightCanvas.height;
    const sx = lw / W;
    const sy = lh / H;

    let alpha = engine.phase === 'night' ? 0.965 : engine.phase === 'dusk' ? 0.78 : 0.56;
    alpha = clamp(alpha - engine.weather.lightningFlash * 0.55, 0.12, 0.97);

    lctx.save();
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, lw, lh);
    lctx.fillStyle = `rgba(7, 9, 8, ${alpha.toFixed(3)})`;
    lctx.fillRect(0, 0, lw, lh);
    lctx.scale(sx, sy);
    lctx.translate(-viewL, -viewT);

    const punch = (ox: number, oy: number, r: number, poly: Vec2[], a: number) => {
      if (poly.length < 3) return;
      lctx.save();
      lctx.beginPath();
      lctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) lctx.lineTo(poly[i].x, poly[i].y);
      lctx.closePath();
      lctx.clip();
      lctx.globalCompositeOperation = 'destination-out';
      const g = lctx.createRadialGradient(ox, oy, r * 0.06, ox, oy, r);
      g.addColorStop(0, `rgba(0,0,0,${a.toFixed(3)})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.fillRect(ox - r, oy - r, r * 2, r * 2);
      lctx.restore();
    };

    const p = engine.player;
    const auraR = engine.phase === 'night' ? 92 : 165;
    computeVisibilityPolygon(engine.world, p.x, p.y, auraR, this.auraPolyScratch);
    punch(p.x, p.y, auraR, this.auraPolyScratch, 0.9);

    if (p.flashlightOn && p.flickerVal > 0.05) {
      computeVisibilityPolygon(engine.world, p.x, p.y, 440, this.polyScratch, p.angle, coneHalfRad);
      punch(p.x, p.y, 440, this.polyScratch, 0.97 * p.flickerVal);
    }

    if (engine.generatorOn && engine.generatorFuel > 0) {
      for (const lamp of SHELTER_LAMPS) {
        computeVisibilityPolygon(engine.world, lamp.x, lamp.y, 195, this.lampPolyScratch);
        punch(lamp.x, lamp.y, 195, this.lampPolyScratch, 0.95);
      }
    }

    for (const f of engine.flares) {
      const fr = 265 * clamp(f.life / 3, 0.2, 1);
      computeVisibilityPolygon(engine.world, f.x, f.y, fr, this.lampPolyScratch);
      punch(f.x, f.y, fr, this.lampPolyScratch, 0.97);
    }

    lctx.restore();
    ctx.drawImage(this.fallbackLightCanvas, 0, 0, W, H);
  }

  private isEnemyVisible(engine: GameEngine, e: Enemy, coneHalfRad: number): boolean {
    const p = engine.player;
    const d = dist(p.x, p.y, e.x, e.y);

    if (engine.weather.lightningFlash > 0.45 && d < 520) return true;

    const awarenessR = engine.phase === 'day' ? 148 : 92;
    if (d < awarenessR && hasLineOfSight(engine.world, p.x, p.y, e.x, e.y)) return true;

    if (p.flashlightOn && p.flickerVal > 0.1 && d < 445) {
      const angToE = Math.atan2(e.y - p.y, e.x - p.x);
      if (
        Math.abs(angleDiff(p.angle, angToE)) <= coneHalfRad + 0.09 &&
        hasLineOfSight(engine.world, p.x, p.y, e.x, e.y)
      ) {
        return true;
      }
    }

    if (engine.generatorOn && engine.generatorFuel > 0) {
      for (const lamp of SHELTER_LAMPS) {
        if (dist(lamp.x, lamp.y, e.x, e.y) < 185 && hasLineOfSight(engine.world, lamp.x, lamp.y, e.x, e.y)) {
          return true;
        }
      }
    }

    for (const f of engine.flares) {
      if (dist(f.x, f.y, e.x, e.y) < 260 && hasLineOfSight(engine.world, f.x, f.y, e.x, e.y)) {
        return true;
      }
    }

    return false;
  }

  // --- Darkwood-Benchmark Player Silhouette: The Stranger (Greatcoat, Rucksack, Bedroll, Pointed Hood) ---
  private drawArticulatedPlayer(ctx: CanvasRenderingContext2D, engine: GameEngine) {
    const p = engine.player;
    const spd = Math.hypot(p.vx, p.vy);
    const moveFactor = clamp(spd / 130, 0, 1);
    const stride = Math.sin(p.walkPhase) * moveFactor;
    const breathe = Math.sin(p.breathePhase) * 0.7;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);

    // Sculpted ground contact shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
    ctx.beginPath();
    ctx.ellipse(-3, 2, 16, 19, 0, 0, Math.PI * 2);
    ctx.fill();

    // Mud-caked heavy leather boots striding beneath coat hem
    ctx.fillStyle = '#1e1611';
    ctx.strokeStyle = '#0c0907';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(stride * 7.2 + 2, -6.5, 5.8, 3.4, 0.08, 0, Math.PI * 2);
    ctx.ellipse(-stride * 7.2 + 2, 6.5, 5.8, 3.4, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 3-phase weapon swing: Wind-up (0..0.22) -> Explosive Slash (0.22..0.72) -> Recovery (0.72..1.0)
    const isAxe = engine.inv.weaponTier === 2;
    let armAngle = 0.25 + stride * 0.14;
    let torsoTwist = stride * 0.09;

    if (p.swingTimer > 0) {
      const prog = 1 - p.swingTimer / p.swingDuration;
      const startA = -1.22 * p.swingDir;
      const endA = 1.12 * p.swingDir;
      if (prog < 0.22) {
        const t = prog / 0.22;
        armAngle = lerp(0.2, startA, t);
        torsoTwist = startA * 0.28 * t;
      } else if (prog < 0.72) {
        const t = (prog - 0.22) / 0.5;
        const ease = 1 - (1 - t) * (1 - t);
        armAngle = lerp(startA, endA, ease);
        torsoTwist = lerp(startA, endA, ease) * 0.30;

        // Multi-layered impasto painterly slash ribbon
        const arcMin = Math.min(startA, armAngle);
        const arcMax = Math.max(startA, armAngle);
        ctx.strokeStyle = isAxe ? 'rgba(232, 206, 172, 0.38)' : 'rgba(196, 160, 114, 0.30)';
        ctx.lineWidth = isAxe ? 14 : 9;
        ctx.beginPath();
        ctx.arc(0, 0, isAxe ? 44 : 36, arcMin, arcMax);
        ctx.stroke();
        ctx.strokeStyle = isAxe ? 'rgba(248, 232, 206, 0.65)' : 'rgba(224, 192, 146, 0.52)';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.arc(0, 0, isAxe ? 48 : 39, arcMin, arcMax);
        ctx.stroke();
      } else {
        const t = (prog - 0.72) / 0.28;
        armAngle = lerp(endA, 0.25, t);
        torsoTwist = lerp(endA * 0.28, 0, t);
      }
    }

    ctx.rotate(torsoTwist);

    // Trailing ragged olive-ochre survivalist greatcoat hem (billows subtly behind stride)
    ctx.fillStyle = p.hitFlash > 0 ? '#7c241e' : '#2a3024';
    ctx.strokeStyle = '#0e110c';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-4, -13);
    ctx.quadraticCurveTo(-15 - moveFactor * 4, -9 - stride * 2.5, -14 - moveFactor * 3, 0 - stride * 2);
    ctx.quadraticCurveTo(-15 - moveFactor * 4, 9 - stride * 2.5, -4, 13);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Right Weapon Arm + Gloved Hand + Barbed Spiked Plank / Bearded Forestman's Axe
    ctx.save();
    ctx.translate(3, -10.5);
    ctx.rotate(armAngle);
    // Coat sleeve
    ctx.strokeStyle = '#3a4234';
    ctx.lineWidth = 5.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(13, 2);
    ctx.stroke();
    // Leather glove gripping handle
    ctx.fillStyle = '#241b14';
    ctx.beginPath();
    ctx.arc(13, 2, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Weapon shaft with cloth grip wrap
    ctx.strokeStyle = '#6c4d31';
    ctx.lineWidth = 3.8;
    ctx.beginPath();
    ctx.moveTo(7, 2);
    ctx.lineTo(isAxe ? 39 : 32, 2);
    ctx.stroke();
    ctx.strokeStyle = '#8b795c';
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.moveTo(9, 2);
    ctx.lineTo(16, 2);
    ctx.stroke();

    if (isAxe) {
      // Bearded forestman's iron axe head with dried blood & bright honed edge
      ctx.fillStyle = '#666c6d';
      ctx.strokeStyle = '#141717';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(28, 0);
      ctx.lineTo(39, -10.5);
      ctx.quadraticCurveTo(43.5, -3, 42, 5.5);
      ctx.lineTo(31, 4.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Honed pale bevel + blood tip
      ctx.strokeStyle = '#d4dad8';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(39, -10.2);
      ctx.quadraticCurveTo(43.2, -3, 41.8, 5.2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(116, 20, 18, 0.72)';
      ctx.beginPath();
      ctx.arc(40, -5, 2.6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Splintered nail-studded board with crooked rusty spikes & wire wrap
      ctx.strokeStyle = '#a9afb0';
      ctx.lineWidth = 1.6;
      for (const [nx, dy] of [
        [20, -6],
        [25, -7.5],
        [29, -5.5],
        [23, 6],
      ]) {
        ctx.beginPath();
        ctx.moveTo(nx, 1);
        ctx.lineTo(nx + 2.2, dy);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Left Forearm holding heavy Eastern European brass flashlight
    ctx.strokeStyle = '#384032';
    ctx.lineWidth = 5.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(2, 10.5);
    ctx.lineTo(13, 8.2);
    ctx.stroke();
    ctx.fillStyle = '#241b14';
    ctx.beginPath();
    ctx.arc(13, 8.2, 3, 0, Math.PI * 2);
    ctx.fill();

    // Brass flashlight barrel + flared bezel
    ctx.fillStyle = '#333028';
    ctx.strokeStyle = '#11100d';
    ctx.lineWidth = 1.2;
    ctx.fillRect(11, 5.6, 10, 4.8);
    ctx.strokeRect(11, 5.6, 10, 4.8);
    ctx.fillStyle = '#8b7042';
    ctx.fillRect(19, 4.8, 3, 6.4);
    if (p.flashlightOn) {
      ctx.fillStyle = Variants.val.light === 'b' ? '#fbe098' : '#d6ebff';
      ctx.fillRect(21.4, 5.4, 2.4, 5.2);
    }

    // Distinct Protruding Survivalist Leather Rucksack + Rolled Canvas Bedroll behind shoulders!
    ctx.fillStyle = '#4e3927';
    ctx.strokeStyle = '#15100b';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.roundRect(-14.5, -10, 9.5, 20, 3);
    ctx.fill();
    ctx.stroke();
    // Rolled grey-ochre canvas bedroll strapped across top of rucksack
    ctx.fillStyle = '#6f6551';
    ctx.fillRect(-13.5, -11.5, 4.5, 23);
    ctx.strokeRect(-13.5, -11.5, 4.5, 23);
    // Tin canteen clipped to rucksack side
    ctx.fillStyle = '#646c64';
    ctx.beginPath();
    ctx.arc(-11, 11.5, 2.8, 0, Math.PI * 2);
    ctx.fill();

    // Sculpted Asymmetric Layered Wool Coat Shoulders & Cape Mantle
    ctx.fillStyle = p.hitFlash > 0 ? '#8c312b' : '#404839';
    ctx.strokeStyle = '#11140f';
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    ctx.moveTo(7 + breathe * 0.4, -12.5);
    ctx.quadraticCurveTo(10, 0, 7 + breathe * 0.4, 12.5);
    ctx.quadraticCurveTo(0, 17, -7, 13.5);
    ctx.quadraticCurveTo(-10.5, 0, -7, -13.5);
    ctx.quadraticCurveTo(0, -17, 7 + breathe * 0.4, -12.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Coat seam crease & shoulder mantle highlight
    ctx.strokeStyle = 'rgba(174, 184, 152, 0.22)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(0, 0, 11.5, -1.2, 1.2);
    ctx.stroke();

    // Leather rucksack straps across shoulders
    ctx.strokeStyle = '#5c412a';
    ctx.lineWidth = 2.3;
    ctx.beginPath();
    ctx.moveTo(-7, -8.5);
    ctx.lineTo(5, -7.8);
    ctx.moveTo(-7, 8.5);
    ctx.lineTo(5, 7.8);
    ctx.stroke();

    // Iconic Darkwood Deep Pointed Hood (recessed dark face opening + trailing hood peak!)
    ctx.fillStyle = p.hitFlash > 0 ? '#9c3b32' : '#585040';
    ctx.strokeStyle = '#12100d';
    ctx.lineWidth = 1.9;
    ctx.beginPath();
    ctx.moveTo(9.5, -4.8);
    ctx.quadraticCurveTo(11.5, 0, 9.5, 4.8);
    ctx.quadraticCurveTo(3, 9.5, -4.5, 7.2);
    ctx.lineTo(-10.5, 0.5); // pointed hood tail resting on rucksack
    ctx.lineTo(-4.5, -7.2);
    ctx.quadraticCurveTo(3, -9.5, 9.5, -4.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Dark recessed hood cowl shadow over face
    ctx.fillStyle = '#12100e';
    ctx.beginPath();
    ctx.ellipse(8.2, 0, 2.2, 4.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Hood crown fabric fold highlight
    ctx.strokeStyle = 'rgba(188, 174, 146, 0.28)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-5, 0);
    ctx.lineTo(6.5, -1);
    ctx.stroke();

    ctx.restore();
  }

  // --- Darkwood-Benchmark Monster Silhouettes (Savage Hound, Twisted Stalker, Root Banshee) ---
  private drawArticulatedEnemy(ctx: CanvasRenderingContext2D, e: Enemy, time: number) {
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(e.angle);

    const flash = e.hitFlash > 0;
    const stride = Math.sin(e.walkPhase);
    const clawLunge = e.clawPhase * 10;
    const twitch = Math.sin(time * 19 + e.id * 2.3) * 2.8;

    // Ground contact shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.50)';
    ctx.beginPath();
    ctx.ellipse(-2, 2, e.r * 1.18, e.r * 0.98, 0, 0, Math.PI * 2);
    ctx.fill();

    if (e.kind === 'hound') {
      // --- SAVAGE RABID HOUND ---
      // Twitching mangy tail whipping behind haunches
      ctx.strokeStyle = flash ? '#b84239' : '#261a16';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-14, 0);
      ctx.quadraticCurveTo(-21, twitch * 1.6, -26, -twitch * 1.4);
      ctx.stroke();

      // 4 muscular bounding legs with splayed paws
      ctx.strokeStyle = flash ? '#b84239' : '#291c18';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(-7, -6);
      ctx.lineTo(-12 - stride * 6.5, -12.5);
      ctx.moveTo(-7, 6);
      ctx.lineTo(-12 + stride * 6.5, 12.5);
      ctx.moveTo(6, -6.5);
      ctx.lineTo(13 + stride * 6.5 + clawLunge * 0.5, -11);
      ctx.moveTo(6, 6.5);
      ctx.lineTo(13 - stride * 6.5 + clawLunge * 0.5, 11);
      ctx.stroke();

      // Sculpted gaunt predator torso (broad muscular shoulders, starved narrow waist)
      ctx.fillStyle = flash ? '#b84239' : '#3b2821';
      ctx.strokeStyle = '#100a08';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, -7.5);
      ctx.quadraticCurveTo(4, -10.5, -3, -7);
      ctx.quadraticCurveTo(-11, -5.2, -16, -6.5);
      ctx.quadraticCurveTo(-18, 0, -16, 6.5);
      ctx.quadraticCurveTo(-11, 5.2, -3, 7);
      ctx.quadraticCurveTo(4, 10.5, 12, 7.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Protruding spine ridge & pale starved rib stripes
      ctx.strokeStyle = 'rgba(186, 162, 134, 0.34)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-13, 0);
      ctx.lineTo(7, 0);
      for (const rx of [-7, -3, 1]) {
        ctx.moveTo(rx, -5.2);
        ctx.lineTo(rx - 1.5, 5.2);
      }
      ctx.stroke();

      // Mangy head, pinned tattered ears & bloody snapping jaws with fangs
      const jawOpen = clawLunge * 0.35;
      ctx.fillStyle = '#6c1614'; // bloody maw interior
      ctx.beginPath();
      ctx.ellipse(17 + jawOpen * 0.4, 0, 5.5 + jawOpen * 0.3, 3.6 + jawOpen * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();

      // White fang points
      ctx.fillStyle = '#e7dec4';
      ctx.fillRect(19 + jawOpen * 0.4, -2.8, 2.2, 1.5);
      ctx.fillRect(19 + jawOpen * 0.4, 1.3, 2.2, 1.5);

      ctx.fillStyle = flash ? '#c85046' : '#2d1e19';
      ctx.strokeStyle = '#0e0908';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(19, -3.5);
      ctx.lineTo(10, -6.8);
      ctx.lineTo(6, -11.5); // left pinned ear
      ctx.lineTo(9, -3);
      ctx.lineTo(9, 3);
      ctx.lineTo(6, 11.5); // right pinned ear
      ctx.lineTo(10, 6.8);
      ctx.lineTo(19, 3.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Pale rabid eyes
      ctx.fillStyle = '#f4e4b2';
      ctx.fillRect(12.5, -3.8, 2.8, 2.1);
      ctx.fillRect(12.5, 1.7, 2.8, 2.1);
    } else if (e.kind === 'banshee') {
      // --- ROOT-WEEPING BANSHEE (BOTANICAL HORROR) ---
      // Multi-forked black root-and-branch crown fanning behind tattered shroud
      ctx.strokeStyle = flash ? '#b84239' : '#1b1511';
      ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(-4, side * 6);
        ctx.quadraticCurveTo(-15, side * (16 + twitch * 0.5), -24, side * (22 + twitch));
        ctx.moveTo(-12, side * 13);
        ctx.lineTo(-22, side * 10);
        ctx.stroke();

        // 2 pairs of gnarled reaching twig-claw arms
        const elbowX = 8 + stride * 3.5 * side;
        const elbowY = side * (15 + twitch * 0.55);
        const handX = 22 + clawLunge + Math.cos(time * 8 + side) * 3;
        const handY = side * (17 - clawLunge * 0.45 + twitch);
        ctx.lineWidth = 3.6;
        ctx.beginPath();
        ctx.moveTo(1, side * 9);
        ctx.lineTo(elbowX, elbowY);
        ctx.lineTo(handX, handY);
        ctx.stroke();

        // Splayed forked twig fingers
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(handX, handY);
        ctx.lineTo(handX + 7, handY - side * 4);
        ctx.moveTo(handX, handY);
        ctx.lineTo(handX + 8, handY + side * 2);
        ctx.stroke();
      }

      // Tattered dark shroud trailing behind body
      ctx.fillStyle = flash ? '#9e3129' : '#171512';
      ctx.strokeStyle = '#070706';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, -10);
      ctx.quadraticCurveTo(16, 0, 12, 10);
      ctx.lineTo(-4, 15);
      ctx.lineTo(-16, 11 + stride * 2);
      ctx.lineTo(-12, 3);
      ctx.lineTo(-19, -2 - stride * 2);
      ctx.lineTo(-13, -12);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Gnarled bark-flesh skull & pulsing fungal ember pustule eyes
      ctx.fillStyle = '#2d241d';
      ctx.beginPath();
      ctx.ellipse(5, 0, 8.5, 7.5, 0, 0, Math.PI * 2);
      ctx.fill();
      const glow = 0.72 + Math.sin(time * 6 + e.id) * 0.28;
      ctx.fillStyle = `rgba(242, 106, 68, ${glow.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(9.5, -4.2, 2.3, 0, Math.PI * 2);
      ctx.arc(9.5, 4.2, 2.3, 0, Math.PI * 2);
      ctx.arc(6.2, 0.5, 1.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // --- TWISTED STALKER / CHOMPER (ICONIC DARKWOOD ASYMMETRICAL HORROR) ---
      // Trailing ragged burial cloth tatters
      ctx.fillStyle = flash ? '#942e27' : '#1b1f1a';
      ctx.beginPath();
      ctx.moveTo(-6, -12);
      ctx.lineTo(-17, -9 + stride * 2);
      ctx.lineTo(-13, 0);
      ctx.lineTo(-19, 8 - stride * 2);
      ctx.lineTo(-6, 12);
      ctx.closePath();
      ctx.fill();

      // Elongated lopsided two-segment arms ending in curved pale bone claws
      ctx.strokeStyle = flash ? '#b84239' : '#2a2e28';
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        const reachBias = side === 1 ? 1.15 : 0.92; // unsettling anatomical asymmetry
        const elbowX = 6 + stride * 4 * side;
        const elbowY = side * 13 * reachBias;
        const clawX = (18 + clawLunge + stride * 4.5 * side) * reachBias;
        const clawY = side * (13.5 - clawLunge * 0.4 + twitch * 0.8);
        ctx.beginPath();
        ctx.moveTo(1, side * 9);
        ctx.lineTo(elbowX, elbowY);
        ctx.lineTo(clawX, clawY);
        ctx.stroke();

        // Pale curved bone claws
        ctx.strokeStyle = '#b4ab94';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(clawX, clawY);
        ctx.lineTo(clawX + 5.5, clawY - side * 3);
        ctx.moveTo(clawX, clawY);
        ctx.lineTo(clawX + 6, clawY + side * 1.5);
        ctx.stroke();
        ctx.strokeStyle = flash ? '#b84239' : '#2a2e28';
        ctx.lineWidth = 3.5;
      }

      // Hunched lopsided ragged coat torso
      ctx.fillStyle = flash ? '#b84239' : '#252923';
      ctx.strokeStyle = '#0b0c0b';
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.ellipse(-1, 0.8, 12.5, 15.2, 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Dried bloodstain across front shoulder
      ctx.fillStyle = 'rgba(84, 15, 14, 0.65)';
      ctx.beginPath();
      ctx.ellipse(3, -5, 5, 4, 0.4, 0, Math.PI * 2);
      ctx.fill();

      // Twitching gaunt pale split-jaw skull jutting forward
      ctx.save();
      ctx.translate(6.5, twitch * 0.35);
      ctx.rotate(twitch * 0.08);
      ctx.fillStyle = '#5c594e';
      ctx.strokeStyle = '#121310';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(0, 0, 7.6, 6.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Dark weeping split-mouth cavity
      ctx.fillStyle = '#2d0c0b';
      ctx.beginPath();
      ctx.ellipse(5.4, 0, 3.2, 2.6 + clawLunge * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();
      // Pale pinprick horror eyes
      ctx.fillStyle = '#efe7cb';
      ctx.fillRect(2.2, -3.8, 2.4, 1.9);
      ctx.fillRect(2.2, 1.9, 2.4, 1.9);
      ctx.restore();
    }

    ctx.restore();

    if (e.hp < e.maxHp) {
      const bw = 28;
      const ratio = clamp(e.hp / e.maxHp, 0, 1);
      ctx.fillStyle = 'rgba(10, 10, 10, 0.82)';
      ctx.fillRect(e.x - bw * 0.5, e.y - e.r - 13, bw, 4);
      ctx.fillStyle = '#b4342d';
      ctx.fillRect(e.x - bw * 0.5 + 1, e.y - e.r - 12, (bw - 2) * ratio, 2);
    }
  }

  // --- High-Craft Painterly Loot Containers (with Pried-Open / Ransacked Searched States) ---
  private drawContainer(ctx: CanvasRenderingContext2D, c: LootContainer, time: number) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);

    // Ground contact shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.44)';
    ctx.beginPath();
    ctx.ellipse(2, 3, c.r * 0.9, c.r * 0.78, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = c.searched ? 0.58 : 1;

    if (c.kind === 'barrel') {
      // Rusted Soviet fuel drum with ribbed steel rim & filler bung
      ctx.fillStyle = c.searched ? '#3d221c' : '#683026';
      ctx.strokeStyle = '#18100d';
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = '#8b7155';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
      ctx.stroke();

      // Filler cap (missing/open hole when searched)
      ctx.fillStyle = c.searched ? '#0d0b0a' : '#a88c5d';
      ctx.beginPath();
      ctx.arc(4, -3, 2.8, 0, Math.PI * 2);
      ctx.fill();
    } else if (c.kind === 'logpile') {
      // Stacked cut pine logs with pale wood end-grain
      const count = c.searched ? 1 : 3;
      for (let k = -1; k < -1 + count; k++) {
        ctx.fillStyle = k === 0 ? '#6e4e32' : '#5b3f28';
        ctx.strokeStyle = '#1a120b';
        ctx.lineWidth = 1.6;
        ctx.fillRect(-15, k * 6 - 3, 30, 5.8);
        ctx.strokeRect(-15, k * 6 - 3, 30, 5.8);
        // Pale cut log ends
        ctx.fillStyle = '#9c7b54';
        ctx.fillRect(-15, k * 6 - 2, 2.5, 3.8);
        ctx.fillRect(12.5, k * 6 - 2, 2.5, 3.8);
      }
    } else if (c.kind === 'backpack') {
      // Canvas survivalist pack with leather straps & brass buckles
      ctx.fillStyle = '#4c573c';
      ctx.strokeStyle = '#161a12';
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      ctx.roundRect(-11, -13, 22, 26, 5);
      ctx.fill();
      ctx.stroke();
      // Flapped pocket (open dark cavity when searched)
      ctx.fillStyle = c.searched ? '#181915' : '#606d4d';
      ctx.fillRect(-8, -9, 16, 9);
      ctx.fillStyle = '#7c6241';
      ctx.fillRect(-9, -1, 18, 3.6);
      ctx.fillStyle = '#c4a86c';
      ctx.fillRect(-5, -1.5, 2.5, 4.5);
      ctx.fillRect(3, -1.5, 2.5, 4.5);
    } else if (c.kind === 'toolbox') {
      // Dented red-oxide mechanic toolbox
      ctx.fillStyle = '#73342a';
      ctx.strokeStyle = '#1a110e';
      ctx.lineWidth = 1.9;
      ctx.fillRect(-14, -9, 28, 18);
      ctx.strokeRect(-14, -9, 28, 18);
      if (c.searched) {
        ctx.fillStyle = '#161413';
        ctx.fillRect(-11, -6, 22, 12);
      } else {
        ctx.fillStyle = '#9fa6a0';
        ctx.fillRect(-6, -2, 12, 3.5);
        ctx.fillStyle = '#b4986a';
        ctx.fillRect(-11, 5, 4, 3);
        ctx.fillRect(7, 5, 4, 3);
      }
    } else if (c.kind === 'corpse') {
      // Fallen forest scavenger in tattered coat & clotted blood pool
      ctx.fillStyle = 'rgba(66, 13, 12, 0.78)';
      ctx.beginPath();
      ctx.ellipse(-4, 3, 14, 10, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3c3e35';
      ctx.strokeStyle = '#121310';
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.ellipse(0, 0, 14, 8.5, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Sprawled arm & pale head
      ctx.strokeStyle = '#34362e';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(4, -5);
      ctx.lineTo(15, -11);
      ctx.stroke();
      ctx.fillStyle = '#7b7464';
      ctx.beginPath();
      ctx.arc(-11, -3, 5.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Military supply crate with diagonal cross-brace (pried open hollow when searched!)
      ctx.fillStyle = '#624a31';
      ctx.strokeStyle = '#19120c';
      ctx.lineWidth = 2;
      ctx.fillRect(-13.5, -13.5, 27, 27);
      ctx.strokeRect(-13.5, -13.5, 27, 27);
      if (c.searched) {
        ctx.fillStyle = '#17120e';
        ctx.fillRect(-10, -10, 20, 20);
        // Loose pried lid resting crookedly
        ctx.save();
        ctx.translate(6, -5);
        ctx.rotate(0.45);
        ctx.fillStyle = '#5c442d';
        ctx.fillRect(-9, -4, 18, 8);
        ctx.strokeRect(-9, -4, 18, 8);
        ctx.restore();
      } else {
        ctx.strokeStyle = '#2d2014';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(-12, -12);
        ctx.lineTo(12, 12);
        ctx.moveTo(12, -12);
        ctx.lineTo(-12, 12);
        ctx.stroke();
        ctx.strokeStyle = '#19120c';
        ctx.lineWidth = 1.6;
        ctx.strokeRect(-10, -10, 20, 20);
      }
    }

    if (!c.searched) {
      const glint = 0.28 + Math.sin(time * 3.2 + c.x) * 0.22;
      ctx.fillStyle = `rgba(240, 212, 150, ${glint.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // --- Detailed Soviet Industrial Generator ---
  private drawGenerator(ctx: CanvasRenderingContext2D, engine: GameEngine) {
    const gx = GENERATOR_POS.x;
    const gy = GENERATOR_POS.y;
    const running = engine.generatorOn && engine.generatorFuel > 0;
    const vibrate = running ? Math.sin(engine.simTime * 55) * 0.85 : 0;

    ctx.save();
    ctx.translate(gx + vibrate, gy);
    // Floor oil stain + shadow
    ctx.fillStyle = 'rgba(8, 7, 6, 0.56)';
    ctx.beginPath();
    ctx.ellipse(2, 4, 26, 19, 0.1, 0, Math.PI * 2);
    ctx.fill();

    // Heavy iron base skid frame
    ctx.fillStyle = '#323732';
    ctx.strokeStyle = '#121412';
    ctx.lineWidth = 2.2;
    ctx.fillRect(-22, -15, 44, 30);
    ctx.strokeRect(-22, -15, 44, 30);

    // Rusted Soviet crimson fuel tank + brass filler cap
    ctx.fillStyle = '#7e3326';
    ctx.strokeStyle = '#1a100d';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-18, -11, 16, 22);
    ctx.strokeRect(-18, -11, 16, 22);
    ctx.fillStyle = '#b89454';
    ctx.beginPath();
    ctx.arc(-10, -4, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Engine cylinder fins & radiator grille
    ctx.fillStyle = '#4c524b';
    ctx.fillRect(0, -11, 18, 22);
    ctx.strokeStyle = '#1c1f1c';
    ctx.lineWidth = 1.4;
    for (let fy = -8; fy <= 8; fy += 4) {
      ctx.beginPath();
      ctx.moveTo(2, fy);
      ctx.lineTo(16, fy);
      ctx.stroke();
    }

    // Coiled exhaust muffler pipe on top edge
    ctx.strokeStyle = '#5c4636';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(8, -12);
    ctx.lineTo(14, -19);
    ctx.stroke();

    // Pulsing amber status indicator lamp
    ctx.fillStyle = running ? (engine.generatorFuel < 20 ? '#e58e35' : '#f4cf68') : '#292929';
    ctx.beginPath();
    ctx.arc(10, 0, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#161614';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  // --- Cluttered Survivalist Workbench (Cast-Iron Vise, Saw, Blueprint, Shavings, Tin Mug) ---
  private drawWorkbench(ctx: CanvasRenderingContext2D) {
    const wx = WORKBENCH_POS.x;
    const wy = WORKBENCH_POS.y;
    ctx.save();
    ctx.translate(wx, wy);

    // Drop shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
    ctx.fillRect(-26, -12, 56, 30);

    // Scarred oak benchtop planks
    ctx.fillStyle = '#60452d';
    ctx.strokeStyle = '#1a120b';
    ctx.lineWidth = 2.2;
    ctx.fillRect(-28, -14, 56, 28);
    ctx.strokeRect(-28, -14, 56, 28);

    // Benchtop plank seam lines
    ctx.strokeStyle = 'rgba(22, 14, 9, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-27, -4);
    ctx.lineTo(27, -4);
    ctx.moveTo(-27, 5);
    ctx.lineTo(27, 5);
    ctx.stroke();

    // Oil-stained crafting schematic parchment pinned in center
    ctx.save();
    ctx.rotate(-0.08);
    ctx.fillStyle = '#afa184';
    ctx.fillRect(-9, -8, 17, 15);
    ctx.strokeStyle = '#4c3f2e';
    ctx.lineWidth = 1;
    ctx.strokeRect(-7, -6, 13, 11);
    ctx.restore();

    // Rusted hand saw lying on left side
    ctx.fillStyle = '#8b928d';
    ctx.fillRect(-24, -6, 13, 4.5);
    ctx.fillStyle = '#472c1c';
    ctx.fillRect(-26, -7, 4, 6.5);

    // Mounted cast-iron bench vise on right edge
    ctx.fillStyle = '#3b4240';
    ctx.strokeStyle = '#141716';
    ctx.lineWidth = 1.4;
    ctx.fillRect(14, -9, 10, 12);
    ctx.strokeRect(14, -9, 10, 12);
    ctx.fillStyle = '#8b9290';
    ctx.fillRect(22, -4, 7, 2.5);

    // Tin enamel mug & wood shavings
    ctx.fillStyle = '#6a746c';
    ctx.beginPath();
    ctx.arc(17, 8, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b9935f';
    ctx.fillRect(-16, 6, 4, 2);
    ctx.fillRect(-10, 9, 3, 2);

    ctx.restore();
  }

  private drawDiegeticPrompt(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    labelKey: string,
    progress: number
  ) {
    const text = I18n.t(labelKey);
    ctx.save();
    ctx.font = '500 12px "DM Sans", system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    const padX = 10;
    const boxW = tw + padX * 2;
    const boxH = 26;

    ctx.fillStyle = 'rgba(18, 16, 13, 0.90)';
    ctx.strokeStyle = 'rgba(206, 174, 120, 0.54)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - boxW * 0.5, y - boxH, boxW, boxH, 3);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#efe6d5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - boxH * 0.5);

    if (progress > 0.01) {
      ctx.strokeStyle = '#e5b968';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y + 24, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.stroke();
    }

    ctx.restore();
  }
}
