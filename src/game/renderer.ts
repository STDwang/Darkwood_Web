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
import { GROUND_MACRO_SCALE, ProceduralAtlas, getProceduralAtlas } from './textures';
import {
  DecalEvent,
  Enemy,
  LootContainer,
  MovableFurniture,
  RectObstacle,
  RelayNode,
  RockObstacle,
} from './types';
import { Vec2, angleDiff, clamp, createRng, dist, lerp } from './util';
import { Variants } from './variants';
// R3 装备：只读 engine.equip（手势曲线与灯光参数单源取自 equipment.ts）
import {
  ArmPose,
  HandPose,
  TORCH_LIGHT,
  gestureCrouch,
  gestureHeadDip,
  gestureLeftHand,
  gestureProgress,
  gestureRightArm,
  getFlareZ,
} from './equipment';
import { computeVisibilityPolygon, hasLineOfSight } from './visibility';
import { GpuLight, WebGL2Composer } from './webglComposer';
import { drawHauntsAlbedo, drawHauntsOverlay } from './render/hauntsDraw';
import { drawWorldProps } from './render/propsDraw';
import { drawThoughts } from './render/thoughtsDraw';
import {
  buildingHasLitLight,
  drawBuildingFixtures,
  drawBuildingGround,
  drawBuildingOverhead,
  isEnemyLitByBuildingLights,
  pushBuildingLights,
} from './render/buildingsDraw';
import {
  CAMPFIRE_POS,
  GENERATOR_POS,
  HIDEOUT_BRAZIER_POS,
  HIDEOUT_RECT,
  HIDEOUT_STOVE_POS,
  SHELTER_LAMPS,
  WORKBENCH_POS,
  WORLD_HALF,
  WORLD_SIZE,
  isPointInHideout,
} from './world';

const DECAL_TEX_SIZE = 1536;
const DECAL_SCALE = DECAL_TEX_SIZE / WORLD_SIZE;

/** ?v-cine=b：门窗木板缝隙体积光的单条光缝参数（按门窗 id 一次性生成并缓存，每帧零分配） */
interface LightSlit {
  offset: number; // 沿门窗开口切线方向的位置（-0.5..0.5，按开口长度缩放）
  width0: number; // 缝隙处光束宽度 px
  spread: number; // 光束末端额外展开宽度 px
  lenK: number; // 长度系数（0.5..1.0，不等长）
  intensity: number; // 亮度系数（不等亮）
  phase: number; // 独立闪烁/浮尘相位
}

/** ?v-cine=b：屋顶程序化塌陷/补丁/截断边缘破损的一次性几何缓存 */
interface RoofDecor {
  holes: number[][]; // 每个塌陷洞的多边形顶点（世界坐标，x,y 交错）
  holeCenters: number[]; // 洞中心（x,y 交错）用于暖光外溢
  boards: number[]; // 断裂横梁/垂挂木板：x1,y1,x2,y2,width 交错
  patches: number[]; // 锈铁皮补丁：x,y,w,h,rot 交错
  ridge: number[]; // 弯曲屋脊折线顶点（x,y 交错）
  chips: number[]; // 截断边缘的不规则缺口：x,y,w,h 交错
}

/** 每个门窗的光缝数量（2~4，按 id 固定，避免整齐划一） */
const SLIT_COUNT_BY_ID: Record<string, number> = {
  bar_north_win: 4,
  bar_west_win: 3,
  bar_east_door: 2,
  bar_south_door: 3,
};

// ===== ?v-cine=b 俯视透视雨幕（渲染层私有纯视觉粒子池，容量固定、预分配、每帧零分配）=====
/** 雨滴池容量（暴雨急雨高密） */
const RAIN_MAX = 920;
/** 落点水花/积水涟漪池容量（池满时直接不生成，绝不扩容） */
const SPLASH_MAX = 600;
/** 庇护所屋檐滴水槽位数（每槽位 2 颗成串水滴） */
const EAVE_MAX = 64;
/** 待绘制拖影上限 = 雨滴 + 屋檐滴水 */
const RAIN_DRAW_MAX = RAIN_MAX + EAVE_MAX * 2;
/** 透视强度：离地高度 z（0 = 地面，1 = 镜头）处投影放大系数 f = 1 / (1 - K·z)（四周清晰向中心斜落） */
const RAIN_PERSP_K = 0.62;
/** 等效快门时间（秒）：急雨下拖影干脆利落 */
const RAIN_SHUTTER = 0.044;
/** 径向倾斜饱和半径（按屏幕宽度比例）：边缘自然向中心收敛斜落 */
const RAIN_TILT_SAT = 0.42;
/** 拖影屏幕长度上限 */
const RAIN_LEN_CAP = 3.4;
const RAIN_LEN_REF_MIN = 8;
/** 近镜头层（第 3 尺寸桶）拖影略缩短，靠粗细与光晕表达"近" */
const RAIN_NEAR_SHORTEN = 0.74;
/** 透视尺寸桶分界 */
const RAIN_BUCKET_F = [1.08, 1.2, 1.42];
/** 三个景深层每秒生成数（暴雨急雨高密基准）：0 = 远层近地密细，1 = 中层，2 = 近镜头粗急 */
const RAIN_LAYER_RATE = [2750, 960, 130];
/** 各层起始离地高度区间（最小值 + 跨度） */
const RAIN_Z0_MIN = [0.07, 0.22, 0.48];
const RAIN_Z0_SPAN = [0.13, 0.2, 0.2];
/** 各层落地后生成水花的概率（确保中心区域地面雨花急促密实） */
const RAIN_SPLASH_P = [0.52, 0.78, 1.0];
/** 4 个透视尺寸桶：线宽、核心 alpha、失焦光晕线宽与 alpha */
const RAIN_CORE_W = [0.8, 1.1, 1.75, 2.75];
const RAIN_CORE_A = [0.3, 0.36, 0.38, 0.3];
const RAIN_HALO_W = [0, 0, 4.0, 7.5];
const RAIN_HALO_A = [0, 0, 0.055, 0.045];
const RAIN_COL_UNLIT = 'rgb(150, 168, 178)';
const RAIN_COL_LIT = 'rgb(224, 214, 194)';
const RAIN_COL_FLASH = 'rgb(210, 226, 240)';

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
  private currentPaletteMode: 'a' | 'b' = 'b';
  // ?v-cine=b 电影级重制：低频地表叠加层（albedo + 积水遮罩）与相关缓存
  private groundMacroPat: CanvasPattern | null = null;
  private groundMacroWetPat: CanvasPattern | null = null;
  private currentCineMode: 'a' | 'b' = 'b';
  private cineOn = true;
  private slitCache = new Map<string, LightSlit[]>();
  private roofDecorCache = new Map<string, RoofDecor>();
  // 多瓣冠影的 3 个椭圆参数（cx, cy, rx, ry, rot）× 3，预分配复用
  private lobeScratch = new Float64Array(15);
  // 不规则苔石 16 顶点（x,y 交错），预分配复用
  private rockScratch = new Float64Array(32);
  // 缝隙体积光的纵向衰减渐变：定义在局部单位长度坐标（x: 0..1）上，所有光束共享，仅创建一次
  private shaftGrad: CanvasGradient | null = null;
  // Darkwood 精绘东欧波斯椭圆旧地毯离屏缓存（首次绘制烘焙一次，零每帧开销）
  private persianRugCanvas: HTMLCanvasElement | null = null;
  // 室内吊灯物理钟摆摇晃状态（受雷暴/震屏/玩家走过激发，带动光斑与阴影同步摇曳）
  private lampSwingX = new Float32Array(2);
  private lampSwingY = new Float32Array(2);
  private lampVelX = new Float32Array(2);
  private lampVelY = new Float32Array(2);
  private lampLastT = -1;
  // ?v-shade=b：叶隙斑驳的半透明冠影图案（世界锚定）
  private canopyDapplePat: CanvasPattern | null = null;

  // ?v-cine=b 俯视透视雨幕：雨滴池（落点世界坐标、离地高度、下落速度、景深层）
  private rainN = 0;
  private rainGX = new Float32Array(RAIN_MAX);
  private rainGY = new Float32Array(RAIN_MAX);
  private rainZ = new Float32Array(RAIN_MAX);
  private rainVZ = new Float32Array(RAIN_MAX);
  private rainLayer = new Uint8Array(RAIN_MAX);
  private rainAccum = new Float32Array(3);
  // 本帧投影后的拖影端点（尾 x0,y0 → 头 x1,y1）与分桶码 = 尺寸桶 + 受光级 × 4（受光级 0 = 仅环境光，1 = 微光/灯光外圈，2 = 手电光锥/灯光火光核心）
  private rainDrawN = 0;
  private rainX0 = new Float32Array(RAIN_DRAW_MAX);
  private rainY0 = new Float32Array(RAIN_DRAW_MAX);
  private rainX1 = new Float32Array(RAIN_DRAW_MAX);
  private rainY1 = new Float32Array(RAIN_DRAW_MAX);
  private rainCode = new Int8Array(RAIN_DRAW_MAX);
  private rainBucketCount = new Int16Array(12);
  // 落点水花池：kind 0 = 小环 + 2–4 颗弹溅微粒，1 = 积水同心涟漪
  private splashN = 0;
  private splashX = new Float32Array(SPLASH_MAX);
  private splashY = new Float32Array(SPLASH_MAX);
  private splashAge = new Float32Array(SPLASH_MAX);
  private splashLife = new Float32Array(SPLASH_MAX);
  private splashSeed = new Float32Array(SPLASH_MAX);
  private splashKind = new Uint8Array(SPLASH_MAX);
  private splashCode = new Int8Array(SPLASH_MAX);
  // 屋檐成串滴水：上一帧相位（检测落地瞬间生成水花）与檐口悬垂水珠
  private eavePrevU = new Float32Array(EAVE_MAX * 2);
  private beadN = 0;
  private beadX = new Float32Array(EAVE_MAX * 2);
  private beadY = new Float32Array(EAVE_MAX * 2);
  private beadS = new Float32Array(EAVE_MAX * 2);
  private beadLit = new Uint8Array(EAVE_MAX * 2);
  private rainLastT = -1;
  private rainSeed = 0x2f6b9a1d;
  // 手电光锥受光判定（每帧写入一次的标量，供雨滴/水花着色）
  private rainBeamOn = false;
  private rainBeamX = 0;
  private rainBeamY = 0;
  private rainBeamDX = 1;
  private rainBeamDY = 0;
  private rainBeamCos = 0.85;
  // R3：灯光/火光/照明弹/近身微光圈受光判定缓存（每帧从 gpuLights 抽取一次，最多 12 盏，世界坐标；零分配）
  private rainLtN = 0;
  private rainLtX = new Float32Array(12);
  private rainLtY = new Float32Array(12);
  private rainLtR2 = new Float32Array(12); // (0.9·半径)²：微光外圈
  private rainLtStrong = new Uint8Array(12); // 1 = 强光源（强度 ≥ 1.2），0.6·半径内算"受光核心"
  private rainLtIn = new Uint8Array(12); // 1 = 光源在庇护所室内（墙体遮光：室内灯不照亮室外雨，反之亦然）
  // 积水遮罩 CPU 副本（图集重建时读取一次）：基础法线 B 通道 + 低频积水 B 通道
  private puddleBaseData: Uint8ClampedArray | null = null;
  private puddleBaseW = 0;
  private puddleBaseH = 0;
  private puddleMacroData: Uint8ClampedArray | null = null;
  private puddleMacroW = 0;
  private puddleMacroH = 0;

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

    this.currentPaletteMode = Variants.val.palette === 'a' ? 'a' : 'b';
    this.currentCineMode = Variants.val.cine === 'a' ? 'a' : 'b';
    this.cineOn = this.currentCineMode === 'b';
    this.atlas = getProceduralAtlas(this.currentPaletteMode, this.currentCineMode);
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

    this.rebuildAtlasPatterns();
  }

  private rebuildAtlasPatterns() {
    this.groundAlbedoPat = this.albedoCtx.createPattern(this.atlas.groundAlbedo, 'repeat');
    this.woodAlbedoPat = this.albedoCtx.createPattern(this.atlas.woodAlbedo, 'repeat');
    this.wallLogPat = this.albedoCtx.createPattern(this.atlas.wallLogAlbedo, 'repeat');
    this.wallRuinPat = this.albedoCtx.createPattern(this.atlas.wallRuinAlbedo, 'repeat');
    this.roofPat = this.albedoCtx.createPattern(this.atlas.roofAlbedo, 'repeat');
    this.groundNormalPat = this.normalCtx.createPattern(this.atlas.groundNormalWet, 'repeat');
    this.woodNormalPat = this.normalCtx.createPattern(this.atlas.woodNormalWet, 'repeat');

    // 低频地表叠加层：图案矩阵放大 GROUND_MACRO_SCALE 倍，世界坐标锚定（不随镜头滑动）
    this.groundMacroPat = null;
    this.groundMacroWetPat = null;
    if (this.atlas.groundMacroAlbedo && this.atlas.groundMacroWet) {
      this.groundMacroPat = this.albedoCtx.createPattern(this.atlas.groundMacroAlbedo, 'repeat');
      this.groundMacroWetPat = this.normalCtx.createPattern(this.atlas.groundMacroWet, 'repeat');
      const m = { a: GROUND_MACRO_SCALE, b: 0, c: 0, d: GROUND_MACRO_SCALE, e: 0, f: 0 };
      try {
        if (this.groundMacroPat && typeof this.groundMacroPat.setTransform === 'function') this.groundMacroPat.setTransform(m);
        if (this.groundMacroWetPat && typeof this.groundMacroWetPat.setTransform === 'function') this.groundMacroWetPat.setTransform(m);
      } catch {
        // 旧浏览器不支持图案矩阵时退化为原尺寸平铺（仍可工作，只是变化频率更高）
      }
    }

    // ?v-shade=b：叶隙斑驳冠影图案（仅 cine 图集提供）
    this.canopyDapplePat = this.atlas.canopyDapple
      ? this.albedoCtx.createPattern(this.atlas.canopyDapple, 'repeat')
      : null;

    // 雨滴落点“积水/非积水”判定用的遮罩 CPU 副本（与法线缓冲 B 通道同源：基础积水 + 低频积水，均世界锚定）
    const base = this.readCanvasPixels(this.atlas.groundNormalWet);
    this.puddleBaseData = base;
    this.puddleBaseW = base ? this.atlas.groundNormalWet.width : 0;
    this.puddleBaseH = base ? this.atlas.groundNormalWet.height : 0;
    const macro = this.cineOn || this.atlas.cine ? this.readCanvasPixels(this.atlas.groundMacroWet) : null;
    this.puddleMacroData = macro;
    this.puddleMacroW = macro && this.atlas.groundMacroWet ? this.atlas.groundMacroWet.width : 0;
    this.puddleMacroH = macro && this.atlas.groundMacroWet ? this.atlas.groundMacroWet.height : 0;
  }

  /** 读取图集画布像素（仅在图集重建时调用一次；失败时返回 null，雨滴落点退化为普通水花） */
  private readCanvasPixels(c: HTMLCanvasElement | null): Uint8ClampedArray | null {
    if (!c || c.width <= 0 || c.height <= 0) return null;
    try {
      const cctx = c.getContext('2d');
      if (!cctx) return null;
      return cctx.getImageData(0, 0, c.width, c.height).data;
    } catch {
      return null;
    }
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

    // 高画质下按 dpr（最高 1.5x）锐利渲染，彻底告别模糊拉伸；中/低画质沿用 lightScale
    const clarityDpr = Quality.tier >= 2 ? Math.min(this.dpr, 1.5) : 1.0;
    const scale = Quality.preset.lightScale * Quality.dynamicScale * clarityDpr;
    this.renderW = Math.max(320, Math.floor(this.width * scale));
    this.renderH = Math.max(200, Math.floor(this.height * scale));

    this.albedoCanvas.width = this.renderW;
    this.albedoCanvas.height = this.renderH;
    this.normalCanvas.width = this.renderW;
    this.normalCanvas.height = this.renderH;
    // 阴影遮罩分辨率与 G-Buffer 齐平，让墙壁/窗洞/树干投下的 Darkwood 视野锥边界与影柱极度锐利
    this.shadowCanvas.width = this.renderW;
    this.shadowCanvas.height = this.renderH;

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

    // 响应 ?v-palette=a|b 动态切换程序化图集
    const desiredPalette: 'a' | 'b' = Variants.val.palette === 'a' ? 'a' : 'b';
    // 响应 ?v-cine=a|b 动态切换电影级重制图集（屋顶/树冠/低频地表）
    const desiredCine: 'a' | 'b' = Variants.val.cine === 'a' ? 'a' : 'b';
    if (desiredPalette !== this.currentPaletteMode || desiredCine !== this.currentCineMode) {
      this.currentPaletteMode = desiredPalette;
      this.currentCineMode = desiredCine;
      this.atlas = getProceduralAtlas(desiredPalette, desiredCine);
      this.rebuildAtlasPatterns();
    }
    this.cineOn = desiredCine === 'b';

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
    // Darkwood 原版视野扇区张角约 88°–102°（清晰利落的 V 形视野切割）
    const coneHalfRad = Variants.val.cone === 'a' ? (51 * Math.PI) / 180 : (43 * Math.PI) / 180;

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
        // ?v-tone=b：全局雾密度下调（只在雨天轻度加浓），去掉"灰纱罩一层"
        fogDensity: this.isToneOn()
          ? (Variants.val.fog === 'b' ? 0.5 : 0.3) + 0.45 * clamp(engine.weather.rainIntensity, 0, 1)
          : Variants.val.fog === 'b' ? 1.0 : 0.45,
        penumbraSamples: Quality.preset.penumbraSamples,
        enableGrain: Quality.preset.enableGrain && Variants.val.grain === 'b',
        puddleReflections: Quality.preset.puddleReflections,
        coldPalette: Variants.val.palette !== 'a',
        visionFog: Variants.val.vision !== 'a',
        cine: this.cineOn,
        nightAmt: this.getNightAmount(engine),
        // ?v-shade=b（仅 cine=b 生效）：手电树影距离相关软半影 + 冷色本影 + 暖色半影边 + 叶隙斑驳 + 体积暗柱
        shadeMode: this.cineOn && Variants.val.shade !== 'a',
        // ?v-tone=b（仅 cine=b 生效）：Darkwood 锐利视野锥曝光
        tone: this.isToneOn(),
        danger: clamp(engine.dangerLevel / 100 + engine.haunts.level * 0.5, 0, 1),
        lights: this.gpuLights,
      });

      const ctx = this.ctx;
      ctx.save();
      ctx.scale(this.dpr, this.dpr);
      ctx.drawImage(this.webgl.canvas, 0, 0, W, H);
      draws++;

      // 高空多层树冠与树上乌鸦（Over-Lighting Canopy Layer）：绘制在延迟光照与视野锥之后，实现真正的上下空间层次
      draws += this.drawOverLightingCanopies(ctx, engine, W, H, cx, cy, viewL, viewT, viewR, viewB, coneHalfRad);

      this.renderAboveDarknessOverlays(ctx, engine, W, H, viewL, viewT);
      draws += drawHauntsOverlay(ctx, engine, viewL, viewT, W, H);
      draws += drawThoughts(ctx, engine, viewL, viewT, W, H);
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
      draws += this.drawOverLightingCanopies(ctx, engine, W, H, cx, cy, viewL, viewT, viewR, viewB, coneHalfRad);
      this.renderAboveDarknessOverlays(ctx, engine, W, H, viewL, viewT);
      draws += drawHauntsOverlay(ctx, engine, viewL, viewT, W, H);
      draws += drawThoughts(ctx, engine, viewL, viewT, W, H);
      ctx.restore();
    }

    this.lastDrawCalls = draws;
  }

  /**
   * 昼夜混合量（只读 engine 的 phase 与阶段进度，不自行计时）：白昼 0，黄昏按进度 0→1，黑夜 1。
   * 用于后期暗框强度、夜晚曝光呼吸与门窗缝隙光的昼弱夜强。
   */
  private getNightAmount(engine: GameEngine): number {
    if (engine.phase === 'night') return 1;
    if (engine.phase === 'dusk') return clamp(engine.getPhaseProgress(), 0, 1);
    return 0;
  }

  /** ?v-tone=b（仅 cine=b 生效）：R3 协调曝光——锥外可读、夜间环境光下限抬高、轻雾、锥内降增益 */
  private isToneOn(): boolean {
    return this.cineOn && Variants.val.tone !== 'a';
  }

  private getAmbientRGB(engine: GameEngine): { r: number; g: number; b: number } {
    const cold = Variants.val.palette !== 'a';
    if (this.isToneOn()) {
      // Darkwood 昼夜基调：白昼阴郁清晰但保持锥内外明显明暗层次；黄昏冷青铁锈暮色；黑夜深邃压迫，靠火光与手电切开黑暗
      const t = engine.getPhaseProgress();
      if (engine.phase === 'day') {
        return cold
          ? { r: lerp(0.56, 0.48, t), g: lerp(0.58, 0.49, t), b: lerp(0.54, 0.47, t) }
          : { r: lerp(0.48, 0.41, t), g: lerp(0.52, 0.44, t), b: lerp(0.45, 0.39, t) };
      }
      if (engine.phase === 'dusk') {
        return cold
          ? { r: lerp(0.48, 0.19, t), g: lerp(0.44, 0.21, t), b: lerp(0.40, 0.25, t) }
          : { r: lerp(0.41, 0.16, t), g: lerp(0.39, 0.18, t), b: lerp(0.34, 0.21, t) };
      }
      return cold ? { r: 0.13, g: 0.16, b: 0.19 } : { r: 0.11, g: 0.14, b: 0.17 };
    }
    if (engine.phase === 'day') {
      const t = engine.getPhaseProgress();
      if (cold) {
        return {
          r: lerp(0.56, 0.44, t),
          g: lerp(0.54, 0.43, t),
          b: lerp(0.52, 0.42, t),
        };
      }
      return {
        r: lerp(0.46, 0.36, t),
        g: lerp(0.50, 0.38, t),
        b: lerp(0.45, 0.34, t),
      };
    }
    if (engine.phase === 'dusk') {
      const t = engine.getPhaseProgress();
      if (cold) {
        return {
          r: lerp(0.44, 0.11, t),
          g: lerp(0.32, 0.10, t),
          b: lerp(0.26, 0.12, t),
        };
      }
      return {
        r: lerp(0.38, 0.08, t),
        g: lerp(0.24, 0.08, t),
        b: lerp(0.20, 0.11, t),
      };
    }
    return cold ? { r: 0.044, g: 0.048, b: 0.058 } : { r: 0.032, g: 0.038, b: 0.048 };
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
    // 1b. ?v-cine=b：低频大尺度湿泥/积水暗斑/枯叶斑块叠加（世界锚定，约 2304px 一个周期）
    if (this.cineOn && this.groundMacroPat) {
      ctx.fillStyle = this.groundMacroPat;
      ctx.fillRect(viewL, viewT, W, H);
      draws++;
    }

    // 2. Darkwood 有机磨损林间泥径（彻底告别死板等宽“柏油直路”：柔边泥土侵蚀 + 零散碎石车辙 + 局部腐朽枕木）
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let pi = 0; pi < engine.world.paths.length; pi++) {
      const path = engine.world.paths[pi];
      if (path.maxX < viewL - 40 || path.minX > viewR + 40 || path.maxY < viewT - 40 || path.minY > viewB + 40) {
        continue;
      }
      // 构建柔和弯曲的中点二次贝塞尔路径，消除折线拐角机械感
      const traceSoftPath = () => {
        const pts = path.points;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        if (pts.length === 2) {
          ctx.lineTo(pts[1].x, pts[1].y);
        } else {
          for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) * 0.5;
            const my = (pts[i].y + pts[i + 1].y) * 0.5;
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
          }
          ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        }
      };

      // 外围柔化枯泥过渡带（低不透明度大宽度，让路径边缘自然融进林地草泥）
      traceSoftPath();
      ctx.strokeStyle = 'rgba(48, 42, 33, 0.22)';
      ctx.lineWidth = path.width * 1.18;
      ctx.stroke();

      // 中层被踩实的潮湿暗土与干裂土芯
      traceSoftPath();
      ctx.strokeStyle = 'rgba(38, 33, 26, 0.34)';
      ctx.lineWidth = path.width * 0.68;
      ctx.stroke();

      // 中心微弱车辙沟壑（双细线轻微错开，不再画死黑粗边）
      traceSoftPath();
      ctx.strokeStyle = 'rgba(22, 19, 15, 0.20)';
      ctx.lineWidth = path.width * 0.26;
      ctx.stroke();

      // 沿泥径稀疏散落碎石与局部破旧防滑木板（参考原版截图 2、6 的木板栈桥质感）
      for (let s = 0; s < path.points.length - 1; s++) {
        const a = path.points[s];
        const b = path.points[s + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (segLen < 20) continue;
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const nx = -(b.y - a.y) / segLen;
        const ny = (b.x - a.x) / segLen;
        for (let d = 28; d < segLen - 20; d += 54) {
          const px = a.x + ((b.x - a.x) * d) / segLen;
          const py = a.y + ((b.y - a.y) * d) / segLen;
          if (px < viewL - 40 || px > viewR + 40 || py < viewT - 40 || py > viewB + 40) continue;
          const h = Math.sin(pi * 31.7 + s * 13.3 + d * 0.19) * 43758.5453;
          const rnd = h - Math.floor(h);
          if (rnd < 0.22) {
            // 局部腐朽旧木板（跨泥泞处）
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(ang + Math.PI * 0.5 + (rnd - 0.11) * 0.6);
            ctx.fillStyle = 'rgba(54, 46, 36, 0.52)';
            ctx.fillRect(-13, -3.2, 26, 5.5);
            ctx.fillStyle = 'rgba(14, 12, 10, 0.45)';
            ctx.fillRect(-13, 1.5, 26, 1.2);
            ctx.restore();
          } else {
            // 碎石与浅泥斑点
            const off = (rnd - 0.5) * path.width * 0.65;
            ctx.fillStyle = rnd > 0.6 ? 'rgba(92, 86, 74, 0.30)' : 'rgba(26, 23, 19, 0.35)';
            ctx.beginPath();
            ctx.ellipse(px + nx * off, py + ny * off, 2.5 + rnd * 3.5, 1.6 + rnd * 2.0, ang, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
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

    // 3b. 全地图 14 栋建筑地面层（房间地板、低对比叙事污渍、铁轨、沼泽积水与栈道，在贴花与实体之下）
    draws += drawBuildingGround(ctx, engine, viewL, viewT, viewR, viewB, this.woodAlbedoPat);

    // 3c. Lived-in Hideout interior furnishings & POI environmental storytelling props (under decals/entities!)
    if (viewR > HIDEOUT_RECT.x - 90 && viewL < HIDEOUT_RECT.x + HIDEOUT_RECT.w + 90 &&
        viewB > HIDEOUT_RECT.y - 90 && viewT < HIDEOUT_RECT.y + HIDEOUT_RECT.h + 90) {
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

    // 6. 积水双圈同心扩散波纹（主圈 + 滞后细副圈）
    //    ?v-cine=b：改由俯视透视雨幕在真实落点生成水花/涟漪（drawCineRain），此处旧版随机涟漪不再绘制，避免双重涟漪
    if (!this.cineOn && engine.weather.rainIntensity > 0.05) {
      ctx.strokeStyle = 'rgba(186, 200, 208, 0.48)';
      for (let i = 0; i < engine.rainRipples.count; i++) {
        const r = engine.rainRipples.items[i];
        if (!r.active) continue;
        if (r.x < viewL - 22 || r.x > viewR + 22 || r.y < viewT - 22 || r.y > viewB + 22) continue;
        const baseA = clamp(r.alpha, 0, 0.54);
        ctx.globalAlpha = baseA;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, r.radius, r.radius * 0.72, 0, 0, Math.PI * 2);
        ctx.stroke();

        // 滞后细副圈
        const innerR = r.radius - 4.2;
        if (innerR > 1.2) {
          ctx.globalAlpha = baseA * 0.56;
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          ctx.ellipse(r.x, r.y, innerR, innerR * 0.72, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // 7. Bear Traps (rusted steel jaws & chain anchor)
    for (const trap of engine.traps) {
      // R3：放置时钢齿由收拢弹开（openT 0→1，带轻微过冲）
      const trapOpen = trap.openT === undefined ? 1 : clamp(this.animEase(trap.openT) * 1.08, 0, 1.08);
      const jaw = 0.5 + 0.5 * trapOpen;
      ctx.save();
      ctx.translate(trap.x, trap.y);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
      ctx.beginPath();
      ctx.ellipse(1, 2, 13, 11, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = trap.armed ? '#8b9188' : '#7b241e';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, 11.5 * jaw, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = trap.armed ? '#363834' : '#521d1a';
      ctx.beginPath();
      ctx.arc(0, 0, 4.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#c4cac0';
      ctx.lineWidth = 1.5;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 8 * jaw, Math.sin(a) * 8 * jaw);
        ctx.lineTo(Math.cos(a) * 12.5 * jaw, Math.sin(a) * 12.5 * jaw);
        ctx.stroke();
      }
      ctx.restore();
      draws++;
    }

    // 7b. 原作风格地表场景物件（残破木板桥、荒废茶田垄、盘根老树墩、围栏小地窖、独轮手推车与散落原木）
    draws += drawWorldProps(ctx, engine.world.props, viewL, viewT, viewR, viewB);

    // 8. Bioluminescent Odd Essence Mushrooms (organic cap cluster + stem + glow)
    // ?v-cine=b：降低青色饱和度与光晕半径（30 -> 17），避免霓虹感
    const cineShroom = this.cineOn;
    const shroomGlowR = cineShroom ? 17 : 30;
    for (const node of engine.world.essences) {
      if (node.harvested) continue;
      if (node.x < viewL - 40 || node.x > viewR + 40 || node.y < viewT - 40 || node.y > viewB + 40) continue;
      const pulse = 0.74 + Math.sin(engine.simTime * 2.8 + node.pulsePhase) * 0.26;
      const grad = ctx.createRadialGradient(node.x, node.y, 2, node.x, node.y, shroomGlowR);
      if (cineShroom) {
        grad.addColorStop(0, `rgba(122, 168, 156, ${(0.46 * pulse).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(122, 168, 156, 0)');
      } else {
        grad.addColorStop(0, `rgba(98, 224, 194, ${(0.68 * pulse).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(98, 224, 194, 0)');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(node.x, node.y, shroomGlowR, 0, Math.PI * 2);
      ctx.fill();

      // Fungal mycelium rootlets
      ctx.strokeStyle = cineShroom ? 'rgba(86, 116, 106, 0.38)' : 'rgba(72, 168, 144, 0.42)';
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
        ctx.fillStyle = cineShroom ? '#1f2f2b' : '#1b473d';
        ctx.beginPath();
        ctx.arc(node.x + cap.ox, node.y + cap.oy, cap.r + 1.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = cineShroom ? '#a3c7bc' : '#9ff5de';
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

    // 9b. 信号中继零件节点（3 处远方地标的苏式无线电中继组件 + 微弱青琥珀脉冲光）
    for (const rn of engine.world.relayNodes) {
      if (rn.collected) continue;
      if (rn.x < viewL - 48 || rn.x > viewR + 48 || rn.y < viewT - 48 || rn.y > viewB + 48) continue;
      this.drawRelayNode(ctx, rn, engine.simTime);
      draws++;
    }

    // 10. Soviet Generator & Cluttered Workbench
    this.drawGenerator(ctx, engine);
    this.drawWorkbench(ctx);
    draws += 2;

    // 10b. 可拖拽重型家具防线（旧沙发 / 橡木柜 / 长木桌，含受损裂纹与拖拽微弱暖框轮廓）
    for (const furn of engine.world.movables) {
      if (furn.hp <= 0) continue;
      if (
        furn.x + furn.w < viewL - 30 ||
        furn.x > viewR + 30 ||
        furn.y + furn.h < viewT - 30 ||
        furn.y > viewB + 30
      ) {
        continue;
      }
      // 砸桌异象：仅渲染偏移（haunts 状态驱动，碰撞数据不变）
      const hz = engine.haunts.table;
      const jig = hz.furnId === furn.id && (hz.offX !== 0 || hz.offY !== 0);
      if (jig) ctx.translate(hz.offX, hz.offY);
      this.drawMovableFurniture(ctx, furn, engine.draggedFurnitureId === furn.id, engine.simTime);
      if (jig) ctx.translate(-hz.offX, -hz.offY);
      draws++;
    }

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

    // 12b. 全地图 14 栋建筑陈设层（固体家具、全部窗户、全部内外门扇与门廊、灯座、院落围栏/水井/墓碑/矿车/旧木船）
    //      与 world.walls 中所有 table 碰撞体一一对应，彻底消除隐形空气墙并清晰区分大门与窗户
    draws += drawBuildingFixtures(ctx, engine, viewL, viewT, viewR, viewB);

    // 13. 多面苔石、自然林地骨骼枝影、双层立体匍匐枯根与 256px 盘根树干
    const windFactor = 1 + engine.weather.rainIntensity * 1.35;
    const swayShadowOn = Quality.preset.canopySway;

    // 极淡柔和的高空树冠地面投影（绝不把锐利黑枝印在树根旁边，把清晰长影留给树干背光阴影）
    ctx.save();
    for (const t of engine.world.trees) {
      const shSize = t.canopyR * (this.cineOn ? 3.2 : 2.25);
      const pad = shSize * 0.55 + 36;
      if (t.x < viewL - pad || t.x > viewR + pad || t.y < viewT - pad || t.y > viewB + pad) continue;
      const sxOff = swayShadowOn ? Math.sin(engine.simTime * (0.86 * windFactor) + t.phase + t.x * 0.004) * (4.0 * windFactor) : 0;
      const syOff = swayShadowOn ? Math.cos(engine.simTime * (0.68 * windFactor) + t.phase + t.y * 0.004) * (2.6 * windFactor) : 0;
      const shX = t.x + 18 + sxOff;
      const shY = t.y + 22 + syOff;
      const sprite = this.atlas.canopySprites[t.id % this.atlas.canopySprites.length];
      ctx.save();
      ctx.globalAlpha = engine.phase === 'night' ? 0.09 : 0.13;
      ctx.translate(shX, shY);
      ctx.rotate(t.phase + 0.14);
      ctx.scale(1.04, 0.92);
      ctx.drawImage(sprite, -shSize * 0.5, -shSize * 0.5, shSize, shSize);
      ctx.restore();
    }
    ctx.restore();
    draws++;

    // 在庇护所墙角与废墟边缘点缀双层立体匍匐枯根须（树脚地面保持干净，不额外乱画黑须）
    this.drawCreepingBlackRoots(ctx, engine, viewL, viewT, viewR, viewB);
    draws++;

    for (const r of engine.world.rocks) {
      if (r.x < viewL - 44 || r.x > viewR + 44 || r.y < viewT - 44 || r.y > viewB + 44) continue;
      if (this.cineOn) {
        this.drawPainterlyRockCine(ctx, r);
      } else {
        this.drawPainterlyRock(ctx, r);
      }
      draws++;
    }

    const pLightX = engine.player.x;
    const pLightY = engine.player.y;
    const pLookCos = Math.cos(coneHalfRad + 0.18);
    const pLookDx = Math.cos(engine.player.angle);
    const pLookDy = Math.sin(engine.player.angle);
    const torchOn = engine.equip.torchInHand && engine.equip.torchLit && engine.equip.torchLight > 0.1;

    for (const t of engine.world.trees) {
      const pad = t.trunkR * 3.0 + 16;
      if (t.x < viewL - pad || t.x > viewR + pad || t.y < viewT - pad || t.y > viewB + pad) continue;
      if (
        Math.abs(t.x - camX) > W * 0.50 &&
        Math.abs(t.y - camY) > H * 0.50 &&
        dist(pLightX, pLightY, t.x, t.y) > t.canopyR + 34
      ) {
        continue;
      }

      // 树干贴地方向投影：紧贴地面、沿光源反方向由近及远平滑变淡（无死板黑柱、无锯齿条纹）
      const dxP = t.x - pLightX;
      const dyP = t.y - pLightY;
      const dP = Math.hypot(dxP, dyP);
      const dot = dP > 1 ? (dxP * pLookDx + dyP * pLookDy) / dP : 0;
      const inCone = engine.player.flashlightOn && dP > 8 && dP < 560 && dot > pLookCos;
      const inTorch = torchOn && dP > 8 && dP < 220;
      if (inCone || inTorch) {
        const awayAng = Math.atan2(dyP, dxP);
        const shadowLen = clamp(85 + t.trunkR * 3.4 + (inCone ? (1 - dP / 580) * 55 : 20), 90, 180);
        const nearW = t.trunkR * 0.92;
        const farW = t.trunkR * 1.48;
        const strength = clamp((inCone ? 0.72 * (1 - dP / 620) : 0) + (inTorch ? 0.58 * (1 - dP / 240) : 0), 0.16, 0.76);
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.rotate(awayAng);
        // 外层柔边半影（更宽更淡）
        const gOuter = ctx.createLinearGradient(0, 0, shadowLen, 0);
        gOuter.addColorStop(0, `rgba(4, 5, 5, ${(strength * 0.42).toFixed(3)})`);
        gOuter.addColorStop(0.45, `rgba(4, 5, 5, ${(strength * 0.18).toFixed(3)})`);
        gOuter.addColorStop(1, 'rgba(4, 5, 5, 0)');
        ctx.fillStyle = gOuter;
        ctx.beginPath();
        ctx.moveTo(0, -nearW * 1.28);
        ctx.lineTo(shadowLen, -farW * 1.38);
        ctx.lineTo(shadowLen, farW * 1.38);
        ctx.lineTo(0, nearW * 1.28);
        ctx.closePath();
        ctx.fill();
        // 内层贴地主影（根部最深，由近及远逐渐变淡消失）
        const gInner = ctx.createLinearGradient(0, 0, shadowLen * 0.88, 0);
        gInner.addColorStop(0, `rgba(3, 4, 4, ${strength.toFixed(3)})`);
        gInner.addColorStop(0.38, `rgba(4, 5, 5, ${(strength * 0.48).toFixed(3)})`);
        gInner.addColorStop(0.75, `rgba(4, 5, 5, ${(strength * 0.14).toFixed(3)})`);
        gInner.addColorStop(1, 'rgba(4, 5, 5, 0)');
        ctx.fillStyle = gInner;
        ctx.beginPath();
        ctx.moveTo(0, -nearW * 0.88);
        ctx.lineTo(shadowLen * 0.88, -farW * 0.92);
        ctx.lineTo(shadowLen * 0.88, farW * 0.92);
        ctx.lineTo(0, nearW * 0.88);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      const sprite = this.atlas.trunkSprites[t.id % this.atlas.trunkSprites.length];
      // 紧凑贴地的树根与树干基部，让树根四周地面保持干净
      const size = t.trunkR * 4.5;
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.phase);
      ctx.drawImage(sprite, -size * 0.5, -size * 0.5, size, size);
      ctx.restore();

      // 对标原作：受光树干呈现“迎光树皮亮弧边 + 向树梢/背光柔和渐暗过渡”，清晰区分根部、树干与上方阴暗树梢
      if (inCone || inTorch) {
        const rimA = clamp((inCone ? 0.64 * (1 - dP / 580) : 0) + (inTorch ? 0.52 * (1 - dP / 220) : 0), 0, 0.78);
        const toPlayerAng = Math.atan2(-dyP, -dxP);
        const awayX = dxP / dP;
        const awayY = dyP / dP;
        const rimR = t.trunkR * 0.86;
        ctx.save();
        // 1) 树干上部向背光方向柔和晕开的渐暗树身雾影（模拟越往上离地面光源越远、越阴暗）
        const topX = t.x + awayX * (t.trunkR * 0.52);
        const topY = t.y + awayY * (t.trunkR * 0.52);
        const fadeGrad = ctx.createRadialGradient(topX, topY, t.trunkR * 0.15, topX, topY, t.trunkR * 1.45);
        fadeGrad.addColorStop(0, 'rgba(5, 6, 6, 0.68)');
        fadeGrad.addColorStop(0.55, 'rgba(7, 8, 8, 0.34)');
        fadeGrad.addColorStop(1, 'rgba(7, 8, 8, 0)');
        ctx.fillStyle = fadeGrad;
        ctx.beginPath();
        ctx.arc(topX, topY, t.trunkR * 1.45, 0, Math.PI * 2);
        ctx.fill();

        // 2) 原作标志性的精致迎光树皮圆弧亮边（清晰勾勒树干底部轮廓）
        ctx.lineCap = 'round';
        ctx.strokeStyle = inTorch && !inCone ? `rgba(222, 184, 132, ${rimA.toFixed(3)})` : `rgba(196, 192, 168, ${rimA.toFixed(3)})`;
        ctx.lineWidth = 1.65;
        ctx.beginPath();
        ctx.arc(t.x, t.y, rimR, toPlayerAng - 1.32, toPlayerAng + 1.32);
        ctx.stroke();
        ctx.restore();
      }
      draws++;
    }

    // 14. Active Flares
    for (const f of engine.flares) {
      // R3：投掷抛物线离地高度（影子留在地面，本体抬高；落地后 fz=0 与原画法一致）
      const fz = getFlareZ(engine.equip, f.id);
      const fy = f.y - fz * 0.9;
      const fsh = 1 - clamp(fz / 60, 0, 0.5);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.ellipse(f.x + 1, f.y + 2, 7 * fsh, 4 * fsh, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#b93424';
      ctx.fillRect(f.x - 5, fy - 2, 10, 4);
      ctx.fillStyle = '#ff7242';
      ctx.beginPath();
      ctx.arc(f.x + 4, fy, 4.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff7e0';
      ctx.beginPath();
      ctx.arc(f.x + 4, fy, 2.1, 0, Math.PI * 2);
      ctx.fill();
      draws++;
    }

    // 15. Articulated Skeletal Enemies (Darkwood silhouettes, strictly inside real-time light / LOS!)
    // 15a. 死亡倒地动画（压在活体之下；淡出后由尸体贴花接替）
    draws += this.drawDyingEnemies(ctx, engine, coneHalfRad, viewL, viewT, viewR, viewB);

    for (const e of engine.enemies) {
      if (e.x < viewL - 60 || e.x > viewR + 60 || e.y < viewT - 60 || e.y > viewB + 60) continue;
      if (!this.isEnemyVisible(engine, e, coneHalfRad)) continue;
      this.drawArticulatedEnemy(ctx, e, engine.simTime);
      draws++;
    }

    // 16. Articulated Skeletal Player (The Stranger: greatcoat, rucksack, hood, lantern, weapon)
    // 16-pre. R3：地上火把 / 弹壳 / 弹道残影（一次批计数）
    draws += this.drawEquipmentWorld(ctx, engine, viewL, viewT, viewR, viewB);

    this.drawArticulatedPlayer(ctx, engine);
    draws++;

    // 16a. 地面乌鸦（遵守视野锥规则：视野外不画，声音照常；树上与飞行乌鸦移至第 19 层树冠之后绘制）
    draws += this.drawCrows(ctx, engine, coneHalfRad, viewL, viewT, viewR, viewB, 'ground');

    // 16a'. 砸桌女人 / 座椅 / 桌面物件（屋内异象；屋顶之前绘制以便被屋顶遮住）
    draws += drawHauntsAlbedo(ctx, engine, viewL, viewT, viewR, viewB);

    // 16b. Overhead Hanging Shelter Lamp Fixtures（带物理钟摆摇晃 + 灯线透视拉扯）
    if (engine.hideoutRoofAlpha < 0.85 &&
        viewR > HIDEOUT_RECT.x && viewL < HIDEOUT_RECT.x + HIDEOUT_RECT.w &&
        viewB > HIDEOUT_RECT.y && viewT < HIDEOUT_RECT.y + HIDEOUT_RECT.h) {
      const lit = engine.generatorOn && engine.generatorFuel > 0;
      for (let li = 0; li < SHELTER_LAMPS.length; li++) {
        const lamp = SHELTER_LAMPS[li];
        const sx = this.lampSwingX[li] || 0;
        const sy = this.lampSwingY[li] || 0;
        const lx = lamp.x + sx;
        const ly = lamp.y + sy;
        ctx.save();
        // 悬挂电线（从天花板锚点连向摇晃中的灯罩）
        ctx.strokeStyle = 'rgba(14, 14, 13, 0.72)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(lamp.x, lamp.y);
        ctx.lineTo(lx, ly);
        ctx.stroke();
        ctx.translate(lx, ly);
        // 搪瓷铁灯罩与投影
        ctx.fillStyle = 'rgba(0, 0, 0, 0.36)';
        ctx.beginPath();
        ctx.arc(2 + sx * 0.4, 3 + sy * 0.4, 9.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#242724';
        ctx.strokeStyle = '#0c0d0c';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(0, 0, 7.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 暖色灯丝灯泡核
        ctx.fillStyle = lit ? '#ffebb8' : '#3d3c36';
        ctx.beginPath();
        ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 16c. 其他建筑室内顶灯层（玩家进入对应建筑、屋顶渐隐时可见）
    draws += drawBuildingOverhead(ctx, engine, viewL, viewT, viewR, viewB);

    // 17. 世界粒子（鲜血、木屑、火星余烬、热烟、林间孢子、手电浮尘、雨滴反弹水花）
    for (let i = 0; i < engine.particles.count; i++) {
      const pt = engine.particles.items[i];
      if (!pt.active) continue;
      if (pt.x < viewL - 28 || pt.x > viewR + 28 || pt.y < viewT - 28 || pt.y > viewB + 28) continue;
      const a = clamp(pt.life / pt.maxLife, 0, 1);
      if (pt.kind === 'smoke') {
        ctx.globalAlpha = a * 0.32;
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (pt.kind === 'ember') {
        // 明灭飘散的炽热余烬火星
        const flicker = 0.65 + 0.35 * Math.sin(engine.simTime * 28 + i * 1.7);
        ctx.globalAlpha = a * flicker * 0.95;
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (pt.kind === 'splash') {
        // ?v-cine=b：雨滴落点水花已由俯视透视雨幕按受光量绘制（drawCineRain），跳过引擎旧版随机雨溅（#c8d6dc 地面 / #d2e0e6 屋檐），避免黑暗中凭空可见的水点
        if (this.cineOn && (pt.color === '#c8d6dc' || pt.color === '#d2e0e6')) continue;
        ctx.globalAlpha = a * 0.72;
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = pt.kind === 'spore' ? a * 0.45 : pt.kind === 'dust' ? a * 0.62 : a * 0.92;
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
        ctx.fill();
      }
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
    // 18b. 全地图所有可进入 POI 房屋的屋顶渐隐层（屋顶内收至外墙内侧，确保外墙银灰双轨窗框与暖褐大门门廊始终完整外露、一眼辨识）
    const bList = engine.world.buildings;
    for (let bi = 0; bi < bList.length; bi++) {
      const b = bList[bi];
      if (b.externalRoof) continue;
      if (b.x + b.w < viewL - 40 || b.x > viewR + 40 || b.y + b.h < viewT - 40 || b.y > viewB + 40) continue;
      const ra = engine.buildingRoofAlpha[bi] === undefined ? 1 : engine.buildingRoofAlpha[bi];
      if (ra <= 0.02) continue;
      const inset = Math.max(8, b.t - 2);
      this.drawRoofCutaway(
        ctx,
        { x: b.x + inset, y: b.y + inset, w: Math.max(24, b.w - inset * 2), h: Math.max(24, b.h - inset * 2) },
        ra,
        buildingHasLitLight(engine, bi),
        engine.simTime,
        b.chimney
      );
      draws++;
    }

    // 19. 高空树冠与树上乌鸦已迁移至光照合成之后的 drawOverLightingCanopies（实现原作“光锥在下、重重枝叶与暗冠在上”的真实立体层次）

    // 20. Dark impenetrable treeline border
    ctx.strokeStyle = 'rgba(6, 8, 6, 0.96)';
    ctx.lineWidth = 48;
    ctx.strokeRect(-WORLD_HALF, -WORLD_HALF, WORLD_HALF * 2, WORLD_HALF * 2);

    ctx.restore();
    return draws;
  }

  /**
   * 一次性离屏烘焙 Darkwood 精致东欧/波斯椭圆旧地毯（对标原版截图 3、4）
   * 包含多层几何波斯边饰、繁复中心对称花蔓纹样、褪色做旧织纹与边缘细密流苏
   */
  private getPersianRug(): HTMLCanvasElement {
    if (this.persianRugCanvas) return this.persianRugCanvas;
    const W = 280;
    const H = 180;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const cx = W * 0.5;
    const cy = H * 0.5;
    const rx = W * 0.44;
    const ry = H * 0.41;
    const rng = createRng(4813);

    // 柔和接地投影
    g.fillStyle = 'rgba(0, 0, 0, 0.32)';
    g.beginPath();
    g.ellipse(cx + 3, cy + 4, rx + 2, ry + 2, 0, 0, Math.PI * 2);
    g.fill();

    // 边缘磨损短流苏
    g.strokeStyle = 'rgba(164, 146, 114, 0.48)';
    g.lineWidth = 1.0;
    for (let i = 0; i < 84; i++) {
      const a = (i / 84) * Math.PI * 2;
      const x0 = cx + Math.cos(a) * rx;
      const y0 = cy + Math.sin(a) * ry;
      const len = 3 + rng() * 3.5;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x0 + Math.cos(a) * len, y0 + Math.sin(a) * len);
      g.stroke();
    }

    // 裁剪至椭圆形地毯本体
    g.save();
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.clip();

    // 做旧陈年枣褐米金底色（刻意压低亮度 25% 防止在双吊灯+火把下过曝发白，花纹如古旧丝绒般清晰！）
    g.fillStyle = '#5e4c36';
    g.fillRect(0, 0, W, H);

    // 外圈深褐波斯边框
    g.strokeStyle = '#291710';
    g.lineWidth = 14;
    g.beginPath();
    g.ellipse(cx, cy, rx - 7, ry - 7, 0, 0, Math.PI * 2);
    g.stroke();

    // 双道赭红与暗金镶边
    g.strokeStyle = '#5a321e';
    g.lineWidth = 4;
    g.beginPath();
    g.ellipse(cx, cy, rx - 15, ry - 14, 0, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = '#927b59';
    g.lineWidth = 1.6;
    g.beginPath();
    g.ellipse(cx, cy, rx - 20, ry - 18, 0, 0, Math.PI * 2);
    g.stroke();

    // 环形波斯花瓣点饰（外框与内框两圈）
    for (let ring = 0; ring < 2; ring++) {
      const cnt = ring === 0 ? 36 : 24;
      const rrx = ring === 0 ? rx - 9 : rx - 28;
      const rry = ring === 0 ? ry - 8 : ry - 25;
      for (let i = 0; i < cnt; i++) {
        const a = (i / cnt) * Math.PI * 2;
        const px = cx + Math.cos(a) * rrx;
        const py = cy + Math.sin(a) * rry;
        g.fillStyle = i % 2 === 0 ? '#a88c64' : '#572e21';
        g.beginPath();
        g.ellipse(px, py, ring === 0 ? 3.5 : 5, ring === 0 ? 2.2 : 3.2, a, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#251711';
        g.beginPath();
        g.arc(px, py, 1.2, 0, Math.PI * 2);
        g.fill();
      }
    }

    // 中心繁复波斯对称藤蔓图腾（四象限对称）
    g.strokeStyle = '#3a2217';
    g.lineWidth = 1.6;
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        g.save();
        g.translate(cx, cy);
        g.scale(sx, sy);
        g.beginPath();
        g.moveTo(0, 0);
        g.bezierCurveTo(28, -4, 46, 22, 68, 12);
        g.moveTo(14, 2);
        g.bezierCurveTo(24, 18, 12, 34, 34, 34);
        g.moveTo(42, 10);
        g.quadraticCurveTo(54, 28, 44, 38);
        g.stroke();

        // 精细花朵与菱形嵌饰
        const pts: [number, number, number][] = [
          [22, 10, 6],
          [46, 16, 5.5],
          [64, 11, 4.5],
          [30, 29, 5],
          [12, 24, 4.2],
        ];
        for (const [fx, fy, fr] of pts) {
          g.fillStyle = '#5e3222';
          g.beginPath();
          g.arc(fx, fy, fr, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#bca57e';
          g.beginPath();
          g.arc(fx, fy, fr * 0.45, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }
    }

    // 中心菱形徽章
    g.fillStyle = '#4c261b';
    g.strokeStyle = '#c4ae86';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(cx, cy - 18);
    g.lineTo(cx + 26, cy);
    g.lineTo(cx, cy + 18);
    g.lineTo(cx - 26, cy);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = '#a2855e';
    g.beginPath();
    g.ellipse(cx, cy, 10, 6.5, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#261710';
    g.beginPath();
    g.arc(cx, cy, 3.2, 0, Math.PI * 2);
    g.fill();

    // 细密编织纹理与经年污渍磨损（消除任何矢量光滑感）
    for (let y = 0; y < H; y += 2) {
      g.fillStyle = y % 4 === 0 ? 'rgba(20, 14, 10, 0.10)' : 'rgba(220, 204, 174, 0.05)';
      g.fillRect(0, y, W, 1);
    }
    for (let i = 0; i < 420; i++) {
      g.fillStyle = rng() > 0.5 ? 'rgba(32, 22, 16, 0.16)' : 'rgba(182, 164, 134, 0.14)';
      g.fillRect(rng() * W, rng() * H, 1.5 + rng() * 2.5, 1.2);
    }
    // 中央折痕与门口踩踏泥污
    g.strokeStyle = 'rgba(22, 16, 12, 0.24)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - 10, cy - ry);
    g.quadraticCurveTo(cx + 6, cy, cx - 4, cy + ry);
    g.stroke();

    const grime = g.createRadialGradient(cx + 12, cy + 32, 4, cx + 12, cy + 32, 54);
    grime.addColorStop(0, 'rgba(16, 13, 10, 0.42)');
    grime.addColorStop(1, 'rgba(16, 13, 10, 0)');
    g.fillStyle = grime;
    g.fillRect(0, 0, W, H);
    g.restore();

    this.persianRugCanvas = c;
    return c;
  }

  // --- Lived-In Hideout Interior Storytelling Props (Zero Collision Impact!) ---
  private drawHideoutInterior(ctx: CanvasRenderingContext2D, engine: GameEngine) {
    const { x, y, w, h } = HIDEOUT_RECT;
    const t = 18;
    const innerL = x + t;
    const innerT = y + t;
    const innerR = x + w - t;
    const innerB = y + h - t;

    // 1. 精绘东欧波斯椭圆旧地毯（对标原版截图 3, 4）
    const rug = this.getPersianRug();
    ctx.save();
    ctx.translate(0, 24);
    ctx.rotate(-0.04);
    ctx.drawImage(rug, -78, -50, 156, 100);
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
    // 铸铁炭炉炉口跃动余烬活焰（3 层微焰）
    const emberGlow = 0.62 + Math.sin(engine.simTime * 11.5) * 0.22 + Math.sin(engine.simTime * 23.0) * 0.12;
    ctx.fillStyle = `rgba(248, 126, 42, ${clamp(emberGlow, 0.3, 1).toFixed(3)})`;
    ctx.fillRect(-3, -3.5, 4.5, 7);
    this.drawLivingFire(ctx, -2.5, 0, 0.42, engine.simTime, 3.1);
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

    // 6. 庇护所外墙周边的东欧写实雕饰：破旧低矮木篱笆段与墙角堆叠废木板（对标用户特写截图）
    const drawFenceSpan = (fx0: number, fy0: number, len: number, horizontal: boolean) => {
      const posts = Math.max(4, Math.floor(len / 10));
      for (let i = 0; i < posts; i++) {
        const p = i / (posts - 1);
        const jitter = Math.sin(i * 17.3 + fx0) * 1.8;
        const px = horizontal ? fx0 + p * len : fx0 + jitter;
        const py = horizontal ? fy0 + jitter : fy0 + p * len;
        ctx.fillStyle = 'rgba(5, 5, 4, 0.56)';
        ctx.fillRect(px - 2, py - 2, 6, 6);
        ctx.fillStyle = i % 2 === 0 ? '#5c4e3e' : '#4b3f32';
        ctx.strokeStyle = '#120e0b';
        ctx.lineWidth = 1;
        ctx.fillRect(px - 2.2, py - 2.2, 4.4, 4.4);
        ctx.strokeRect(px - 2.2, py - 2.2, 4.4, 4.4);
      }
      ctx.strokeStyle = '#3f352a';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      if (horizontal) {
        ctx.moveTo(fx0, fy0);
        ctx.lineTo(fx0 + len, fy0);
      } else {
        ctx.moveTo(fx0, fy0);
        ctx.lineTo(fx0, fy0 + len);
      }
      ctx.stroke();
    };
    // 西北外墙旁破旧斜向木篱笆（零碰撞纯视觉雕饰）
    drawFenceSpan(x - 66, y + 6, 58, true);
    // 北墙外堆叠旧木板
    for (let k = 0; k < 5; k++) {
      const bx = x + 32 + k * 7.2;
      const by = y - 22 + (k % 2) * 2;
      ctx.fillStyle = 'rgba(6, 5, 4, 0.52)';
      ctx.fillRect(bx + 2, by + 2, 6, 20);
      ctx.fillStyle = k % 2 === 0 ? '#584b3c' : '#4a3e31';
      ctx.strokeStyle = '#14100c';
      ctx.lineWidth = 1;
      ctx.fillRect(bx, by, 5.8, 19);
      ctx.strokeRect(bx, by, 5.8, 19);
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

      // 猎人营地：仍在燃烧的活篝火（炽热炭床 + 3 层跃动火舌）
      ctx.translate(CAMPFIRE_POS.x, CAMPFIRE_POS.y);
      const ash = ctx.createRadialGradient(0, 0, 3, 0, 0, 28);
      ash.addColorStop(0, 'rgba(22, 14, 10, 0.90)');
      ash.addColorStop(0.65, 'rgba(48, 34, 24, 0.48)');
      ash.addColorStop(1, 'rgba(42, 36, 31, 0)');
      ctx.fillStyle = ash;
      ctx.beginPath();
      ctx.arc(0, 0, 28, 0, Math.PI * 2);
      ctx.fill();

      // 熏黑围石圈
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        ctx.fillStyle = i % 2 === 0 ? '#424440' : '#313330';
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 15, Math.sin(a) * 15, 4.4, 0, Math.PI * 2);
        ctx.fill();
      }
      // 交叉炭化柴木与炽热炭床
      ctx.strokeStyle = '#181412';
      ctx.lineWidth = 4.2;
      ctx.beginPath();
      ctx.moveTo(-11, -6);
      ctx.lineTo(11, 6);
      ctx.moveTo(-9, 8);
      ctx.lineTo(10, -7);
      ctx.stroke();

      const bedGlow = ctx.createRadialGradient(0, 0, 1, 0, 0, 11);
      bedGlow.addColorStop(0, 'rgba(255, 224, 140, 0.92)');
      bedGlow.addColorStop(0.55, 'rgba(228, 86, 26, 0.72)');
      bedGlow.addColorStop(1, 'rgba(120, 26, 12, 0)');
      ctx.fillStyle = bedGlow;
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.fill();

      this.drawLivingFire(ctx, 0, 0, 1.15, engine.simTime, 1.7);
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
      ctx.strokeStyle = this.cineOn
        ? `rgba(96, 138, 126, ${(pulse * 0.85).toFixed(3)})`
        : `rgba(88, 198, 174, ${pulse.toFixed(3)})`;
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

    // 4. 庇护所南门外侧生锈铁桶余烬火盆（Brazier，标题页/白昼/黑夜均可见活火光，零碰撞死角）
    if (
      viewR > HIDEOUT_BRAZIER_POS.x - 45 &&
      viewL < HIDEOUT_BRAZIER_POS.x + 45 &&
      viewB > HIDEOUT_BRAZIER_POS.y - 45 &&
      viewT < HIDEOUT_BRAZIER_POS.y + 45
    ) {
      ctx.save();
      ctx.translate(HIDEOUT_BRAZIER_POS.x, HIDEOUT_BRAZIER_POS.y);
      // 焦黑地面炭灰圈与接地投影
      const soot = ctx.createRadialGradient(0, 0, 4, 0, 0, 24);
      soot.addColorStop(0, 'rgba(10, 9, 8, 0.85)');
      soot.addColorStop(0.65, 'rgba(26, 22, 18, 0.45)');
      soot.addColorStop(1, 'rgba(10, 9, 8, 0)');
      ctx.fillStyle = soot;
      ctx.beginPath();
      ctx.arc(0, 0, 24, 0, Math.PI * 2);
      ctx.fill();

      // 锈蚀铁桶桶身与卷边
      ctx.fillStyle = '#3a261e';
      ctx.strokeStyle = '#0e0b0a';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(0, 0, 12.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 桶内深暗炭火腔与炽热余烬
      ctx.fillStyle = '#18110e';
      ctx.beginPath();
      ctx.arc(0, 0, 9.6, 0, Math.PI * 2);
      ctx.fill();

      const coal = ctx.createRadialGradient(0, 0, 1, 0, 0, 9.2);
      coal.addColorStop(0, 'rgba(255, 228, 152, 0.95)');
      coal.addColorStop(0.55, 'rgba(235, 94, 30, 0.78)');
      coal.addColorStop(1, 'rgba(92, 22, 10, 0.15)');
      ctx.fillStyle = coal;
      ctx.beginPath();
      ctx.arc(0, 0, 9.2, 0, Math.PI * 2);
      ctx.fill();

      // 3 层跃动火舌
      this.drawLivingFire(ctx, 0, 0, 0.96, engine.simTime, 5.3);
      ctx.restore();
    }
  }

  /**
   * 3 层跃动活火焰（暗红热气外焰 → 橙红扭曲中焰 → 白黄炽热核心）
   */
  private drawLivingFire(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    scale: number,
    time: number,
    seed: number
  ) {
    const f1 = Math.sin(time * 13.4 + seed) * 2.4 * scale;
    const f2 = Math.cos(time * 19.2 + seed * 1.9) * 1.8 * scale;
    const stretch = 1 + Math.sin(time * 16.5 + seed * 0.7) * 0.18;

    ctx.save();
    ctx.translate(x, y);

    // 外层：暗红热气外焰
    ctx.fillStyle = 'rgba(196, 52, 22, 0.62)';
    ctx.beginPath();
    ctx.moveTo(-7.5 * scale, 3 * scale);
    ctx.quadraticCurveTo(-9 * scale + f2, -6 * scale, f1 * 1.15, -14.5 * scale * stretch);
    ctx.quadraticCurveTo(9 * scale - f2, -6 * scale, 7.5 * scale, 3 * scale);
    ctx.quadraticCurveTo(0, 7 * scale, -7.5 * scale, 3 * scale);
    ctx.closePath();
    ctx.fill();

    // 中层：橙红扭曲中焰
    ctx.fillStyle = 'rgba(248, 128, 36, 0.84)';
    ctx.beginPath();
    ctx.moveTo(-5.2 * scale, 2.2 * scale);
    ctx.quadraticCurveTo(-6.2 * scale - f2 * 0.7, -4.5 * scale, -f1 * 0.7, -10.8 * scale * stretch);
    ctx.quadraticCurveTo(6.2 * scale + f2 * 0.7, -4.5 * scale, 5.2 * scale, 2.2 * scale);
    ctx.quadraticCurveTo(0, 5.2 * scale, -5.2 * scale, 2.2 * scale);
    ctx.closePath();
    ctx.fill();

    // 内核：白黄炽热核心
    ctx.fillStyle = 'rgba(255, 244, 198, 0.94)';
    ctx.beginPath();
    ctx.ellipse(f2 * 0.35, -1.8 * scale, 3.1 * scale, 4.6 * scale * stretch, f1 * 0.08, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * 在庇护所墙角、废墟边缘与老树周围点缀盘根错节的黑色枯枝根须（单次 stroke 批处理）
   */
  private drawCreepingBlackRoots(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number
  ) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // 双层立体匍匐枯根（暗影 + 灰褐枯根脊线，对标原版特写图左下角密织纠结地表根须）
    const addRootCluster = (
      ox: number,
      oy: number,
      seed: number,
      count: number,
      maxLen: number,
      offX: number,
      offY: number
    ) => {
      if (ox < viewL - maxLen - 16 || ox > viewR + maxLen + 16 || oy < viewT - maxLen - 16 || oy > viewB + maxLen + 16) {
        return;
      }
      const rng = createRng(seed);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.72;
        const len = maxLen * (0.58 + rng() * 0.52);
        const mx = ox + Math.cos(a + (rng() - 0.5) * 0.55) * len * 0.52;
        const my = oy + Math.sin(a + (rng() - 0.5) * 0.55) * len * 0.52;
        const ex = ox + Math.cos(a) * len;
        const ey = oy + Math.sin(a) * len;
        ctx.moveTo(ox + offX, oy + offY);
        ctx.quadraticCurveTo(mx + offX, my + offY, ex + offX, ey + offY);
        // 双侧自然分叉细须
        const f1 = a + 0.48 + (rng() - 0.5) * 0.24;
        const f2 = a - 0.52 + (rng() - 0.5) * 0.24;
        ctx.moveTo(mx + offX, my + offY);
        ctx.lineTo(mx + Math.cos(f1) * len * 0.40 + offX, my + Math.sin(f1) * len * 0.40 + offY);
        ctx.moveTo(mx * 0.4 + ex * 0.6 + offX, my * 0.4 + ey * 0.6 + offY);
        ctx.lineTo(mx * 0.4 + ex * 0.6 + Math.cos(f2) * len * 0.30 + offX, my * 0.4 + ey * 0.6 + Math.sin(f2) * len * 0.30 + offY);
      }
    };

    const drawAllClusters = (offX: number, offY: number) => {
      ctx.beginPath();
      const { x, y, w, h } = HIDEOUT_RECT;
      addRootCluster(x - 2, y - 2, 1011, 6, 44, offX, offY);
      addRootCluster(x + w + 2, y - 2, 1021, 6, 42, offX, offY);
      addRootCluster(x - 2, y + h + 2, 1031, 6, 46, offX, offY);
      addRootCluster(x + w + 2, y + h + 2, 1041, 6, 44, offX, offY);
      for (let i = 0; i < engine.world.walls.length; i++) {
        const wall = engine.world.walls[i];
        if (wall.kind !== 'ruin_wall') continue;
        addRootCluster(wall.x, wall.y, 2003 + i * 71, 4, 34, offX, offY);
        addRootCluster(wall.x + wall.w, wall.y + wall.h, 2111 + i * 89, 3, 28, offX, offY);
      }
      // 树根周围保持干净（仅由紧凑的 trunkSprites 表现短板根，不再在地面叠画杂乱黑须）
      ctx.stroke();
    };

    // 第 1 层：贴地深暗投影（压出立体感）
    ctx.strokeStyle = 'rgba(7, 7, 6, 0.62)';
    ctx.lineWidth = 2.6;
    drawAllClusters(1.3, 1.6);

    // 第 2 层：清晰灰褐枯根背脊（在手电与火光下根根分明）
    ctx.strokeStyle = 'rgba(116, 108, 92, 0.42)';
    ctx.lineWidth = 1.15;
    drawAllClusters(0, 0);

    ctx.restore();
  }

  // --- Architectural Brushwork: Darkwood Pitch-Black Cutaway Timber Walls（对标原版截图 3, 4, 5） ---
  private drawCabinTimberWall(ctx: CanvasRenderingContext2D, w: RectObstacle) {
    // 墙根深沉接触投影（压出建筑体量感）
    ctx.fillStyle = 'rgba(3, 4, 4, 0.62)';
    ctx.fillRect(w.x - 3, w.y - 2, w.w + 7, w.h + 7);

    // Darkwood 标志性近纯黑建筑剖面顶面，极度干净利落
    ctx.fillStyle = '#060707';
    ctx.fillRect(w.x, w.y, w.w, w.h);

    // 极克制的墙体剖面内部木筋暗纹（仅在强光贴近时隐约可见）
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = this.wallLogPat ?? '#241e18';
    ctx.fillRect(w.x + 2, w.y + 2, Math.max(0, w.w - 4), Math.max(0, w.h - 4));
    ctx.restore();

    // 极细墙体截断灰白微边（模拟原版截图 1, 3, 4 室内外墙体的锐利剖面轮廓）
    ctx.strokeStyle = 'rgba(130, 134, 128, 0.18)';
    ctx.lineWidth = 1.0;
    ctx.strokeRect(w.x + 0.5, w.y + 0.5, Math.max(0, w.w - 1), Math.max(0, w.h - 1));
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

    // 废墟石墙厚重近纯黑截断边框（#070808 + 破损石块缺口）
    ctx.strokeStyle = '#070808';
    ctx.lineWidth = 4.4;
    ctx.strokeRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);

    // 确定性冷灰苔藓斑块、墙顶破损黑块与散落碎石
    const rng = createRng(Math.abs(Math.floor(w.x * 13 + w.y * 29)) + 7);
    const specks = Math.max(3, Math.floor((w.w + w.h) / 38));
    for (let i = 0; i < specks; i++) {
      const mx = w.x + rng() * w.w;
      const my = w.y + rng() * w.h;
      ctx.fillStyle = Variants.val.palette !== 'a' ? 'rgba(54, 58, 52, 0.42)' : 'rgba(46, 68, 36, 0.45)';
      ctx.beginPath();
      ctx.ellipse(mx, my, 5 + rng() * 6, 3 + rng() * 4, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#070808';
      ctx.fillRect(mx - 2, my - 2, 3.5, 3.5);

      // 墙边散落碎石
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
    // 贴地柔和软影（由车底向外逐渐变淡，无硬边黑块，车上方无影柱）
    const shCx = w.x + w.w * 0.5 + 4;
    const shCy = w.y + w.h * 0.5 + 5;
    const shR = Math.max(w.w, w.h) * 0.72;
    const shGrad = ctx.createRadialGradient(shCx, shCy, shR * 0.22, shCx, shCy, shR);
    shGrad.addColorStop(0, 'rgba(4, 5, 4, 0.58)');
    shGrad.addColorStop(0.6, 'rgba(4, 5, 4, 0.26)');
    shGrad.addColorStop(1, 'rgba(4, 5, 4, 0)');
    ctx.fillStyle = shGrad;
    ctx.beginPath();
    ctx.ellipse(shCx, shCy, w.w * 0.68, w.h * 0.82, 0, 0, Math.PI * 2);
    ctx.fill();

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

  // --- Architectural Brushwork: Recessed Barricaded Doors & Darkwood Dual-Rail Windows（对标截图 3, 4） ---
  private drawBarricadeSlot(
    ctx: CanvasRenderingContext2D,
    b: { x: number; y: number; w: number; h: number; orientation: 'h' | 'v'; hp: number; maxHp: number; kind: 'door' | 'window' }
  ) {
    // 窗台/门槛底槽：窗户用亮灰双轨金属窗框，大门配外伸做旧木门廊踏板与宽厚暖褐门槛（一眼区分门与窗）
    if (b.kind === 'window') {
      ctx.fillStyle = '#5a5e5a';
      if (b.orientation === 'h') {
        ctx.fillRect(b.x - 1, b.y - 2.5, b.w + 2, b.h + 5);
        ctx.fillStyle = '#787d78';
        ctx.fillRect(b.x, b.y - 2, b.w, 2.2);
        ctx.fillRect(b.x, b.y + b.h - 0.2, b.w, 2.2);
        ctx.fillStyle = '#101313';
        ctx.fillRect(b.x + 2, b.y + 1.5, b.w - 4, b.h - 3);
        ctx.fillStyle = '#9aa09b';
        ctx.fillRect(b.x + 2, b.y + b.h * 0.28, b.w - 4, 1.8);
        ctx.fillRect(b.x + 2, b.y + b.h * 0.62, b.w - 4, 1.8);
        ctx.fillStyle = '#3c403e';
        ctx.fillRect(b.x + b.w * 0.5 - 1.5, b.y + 1, 3, b.h - 2);
        ctx.strokeStyle = '#070808';
        ctx.lineWidth = 1.6;
        ctx.strokeRect(b.x - 1, b.y - 2.5, b.w + 2, b.h + 5);
      } else {
        ctx.fillRect(b.x - 2.5, b.y - 1, b.w + 5, b.h + 2);
        ctx.fillStyle = '#787d78';
        ctx.fillRect(b.x - 2, b.y, 2.2, b.h);
        ctx.fillRect(b.x + b.w - 0.2, b.y, 2.2, b.h);
        ctx.fillStyle = '#101313';
        ctx.fillRect(b.x + 1.5, b.y + 2, b.w - 3, b.h - 4);
        ctx.fillStyle = '#9aa09b';
        ctx.fillRect(b.x + b.w * 0.28, b.y + 2, 1.8, b.h - 4);
        ctx.fillRect(b.x + b.w * 0.62, b.y + 2, 1.8, b.h - 4);
        ctx.fillStyle = '#3c403e';
        ctx.fillRect(b.x + 1, b.y + b.h * 0.5 - 1.5, b.w - 2, 3);
        ctx.strokeStyle = '#070808';
        ctx.lineWidth = 1.6;
        ctx.strokeRect(b.x - 2.5, b.y - 1, b.w + 5, b.h + 2);
      }
    } else {
      // 可进入大门：外伸破旧木门廊台阶 + 宽厚暖褐磨损门槛 + 醒目门框
      if (b.orientation === 'h') {
        const outDir = b.y > HIDEOUT_RECT.y + HIDEOUT_RECT.h * 0.5 ? 1 : -1;
        const stepY = outDir > 0 ? b.y + b.h + 1 : b.y - 22;
        ctx.fillStyle = 'rgba(4, 3, 2, 0.52)';
        ctx.fillRect(b.x - 4, stepY + 2, b.w + 8, 22);
        for (let p = 0; p < 3; p++) {
          const py = stepY + p * 7;
          ctx.fillStyle = p === 1 ? '#5b4834' : '#4d3c2b';
          ctx.fillRect(b.x - 4, py, b.w + 8, 6.2);
          ctx.strokeStyle = '#120d09';
          ctx.lineWidth = 1.1;
          ctx.strokeRect(b.x - 4, py, b.w + 8, 6.2);
        }
      } else {
        const outDir = b.x > HIDEOUT_RECT.x + HIDEOUT_RECT.w * 0.5 ? 1 : -1;
        const stepX = outDir > 0 ? b.x + b.w + 1 : b.x - 22;
        ctx.fillStyle = 'rgba(4, 3, 2, 0.52)';
        ctx.fillRect(stepX + 2, b.y - 4, 22, b.h + 8);
        for (let p = 0; p < 3; p++) {
          const px = stepX + p * 7;
          ctx.fillStyle = p === 1 ? '#5b4834' : '#4d3c2b';
          ctx.fillRect(px, b.y - 4, 6.2, b.h + 8);
          ctx.strokeStyle = '#120d09';
          ctx.lineWidth = 1.1;
          ctx.strokeRect(px, b.y - 4, 6.2, b.h + 8);
        }
      }
      ctx.fillStyle = '#5c4631';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = 'rgba(150, 124, 92, 0.36)';
      ctx.fillRect(b.x + 2, b.y + 2, Math.max(0, b.w - 4), Math.max(0, b.h - 4));
      ctx.strokeStyle = '#120d09';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }

    // 门窗两端厚重立柱
    ctx.fillStyle = '#1c1814';
    if (b.orientation === 'h') {
      ctx.fillRect(b.x - 3, b.y - 2, 5, b.h + 4);
      ctx.fillRect(b.x + b.w - 2, b.y - 2, 5, b.h + 4);
    } else {
      ctx.fillRect(b.x - 2, b.y - 3, b.w + 4, 5);
      ctx.fillRect(b.x - 2, b.y + b.h - 2, b.w + 4, 5);
    }

    // 碎玻璃冷光锯齿
    if (b.kind === 'window') {
      ctx.fillStyle = 'rgba(176, 198, 196, 0.34)';
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

  /**
   * 沿预计算顶点（x,y 交错）构建二次曲线平滑闭合路径，可整体缩放(sc，相对 cx,cy)与平移(ox,oy)。
   * 用于不规则苔石轮廓，避免规则多边形直边。
   */
  private traceSmoothLoop(
    ctx: CanvasRenderingContext2D,
    pts: Float64Array,
    n: number,
    cx: number,
    cy: number,
    sc: number,
    ox: number,
    oy: number
  ) {
    // 内联索引计算（不创建闭包，保持每帧零额外分配）
    const bx = cx * (1 - sc) + ox;
    const by = cy * (1 - sc) + oy;
    ctx.beginPath();
    ctx.moveTo(bx + (pts[0] + pts[2]) * 0.5 * sc, by + (pts[1] + pts[3]) * 0.5 * sc);
    for (let i = 1; i <= n; i++) {
      const i0 = (i % n) * 2;
      const i1 = ((i + 1) % n) * 2;
      const qx = bx + pts[i0] * sc;
      const qy = by + pts[i0 + 1] * sc;
      ctx.quadraticCurveTo(qx, qy, bx + (pts[i0] + pts[i1]) * 0.5 * sc, by + (pts[i0 + 1] + pts[i1 + 1]) * 0.5 * sc);
    }
    ctx.closePath();
  }

  /**
   * ?v-cine=b：不规则噪声轮廓苔石（16 顶点平滑、无深色硬描边），
   * 以双层柔和接地影、裁剪内的西北受光/东南暗面渐变、低饱和苔斑与细裂隙塑形，替代规则九边形 + 描边。
   */
  private drawPainterlyRockCine(ctx: CanvasRenderingContext2D, r: RockObstacle) {
    const n = 16;
    const pts = this.rockScratch;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r.seed * 0.37;
      // 确定性伪随机（正弦哈希），不创建 rng 闭包
      const h = Math.sin(r.id * 12.9898 + i * 78.233 + r.seed * 3.1) * 43758.5453;
      const jitter = h - Math.floor(h);
      const lump = 0.86 + 0.1 * Math.sin(a * 2 + r.seed * 5.0) + 0.07 * Math.sin(a * 3 + r.id) + (jitter - 0.5) * 0.16;
      pts[i * 2] = r.x + Math.cos(a) * r.r * lump;
      pts[i * 2 + 1] = r.y + Math.sin(a) * r.r * lump * 0.92;
    }

    // 双层柔和接地阴影
    ctx.fillStyle = 'rgba(4, 5, 4, 0.30)';
    this.traceSmoothLoop(ctx, pts, n, r.x, r.y, 1.1, 5, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(4, 5, 4, 0.34)';
    this.traceSmoothLoop(ctx, pts, n, r.x, r.y, 1.0, 2.5, 3.5);
    ctx.fill();

    // 冷灰花岗岩本体（低对比）
    ctx.save();
    ctx.fillStyle = '#30332e';
    this.traceSmoothLoop(ctx, pts, n, r.x, r.y, 1, 0, 0);
    ctx.fill();
    ctx.clip();

    // 西北受光 -> 东南暗面
    const g = ctx.createRadialGradient(r.x - r.r * 0.38, r.y - r.r * 0.42, r.r * 0.08, r.x, r.y, r.r * 1.25);
    g.addColorStop(0, 'rgba(118, 120, 110, 0.30)');
    g.addColorStop(0.5, 'rgba(60, 62, 57, 0)');
    g.addColorStop(1, 'rgba(6, 7, 6, 0.62)');
    ctx.fillStyle = g;
    ctx.fillRect(r.x - r.r * 1.3, r.y - r.r * 1.3, r.r * 2.6, r.r * 2.6);

    // 低饱和冷灰苔斑
    ctx.fillStyle = 'rgba(56, 64, 52, 0.42)';
    ctx.beginPath();
    ctx.ellipse(r.x - r.r * 0.28, r.y - r.r * 0.3, r.r * 0.5, r.r * 0.26, -0.55 + r.seed * 0.2, 0, Math.PI * 2);
    ctx.fill();

    // 细裂隙
    ctx.strokeStyle = 'rgba(12, 13, 12, 0.48)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(pts[2] * 0.55 + r.x * 0.45, pts[3] * 0.55 + r.y * 0.45);
    ctx.lineTo(r.x + r.r * 0.05, r.y + r.r * 0.08);
    ctx.lineTo(pts[18] * 0.6 + r.x * 0.4, pts[19] * 0.6 + r.y * 0.4);
    ctx.stroke();
    ctx.restore();
  }

  private drawRoofCutaway(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number },
    alpha: number,
    warmWindowLeak: boolean,
    simTime: number,
    hasChimney: boolean
  ) {
    // ?v-cine=b：破旧焦油毡/朽木瓦/锈铁皮屋顶（塌陷破洞 + 厚重近黑截断边）
    if (this.cineOn) {
      this.drawRoofCutawayCine(ctx, rect, alpha, warmWindowLeak, simTime, hasChimney);
      return;
    }
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

  /**
   * ?v-cine=b 屋顶几何装饰：按屋顶矩形一次性确定性生成并缓存（塌陷破洞、断椽、锈铁皮补丁、弯曲屋脊、截断边缺口），
   * 保证每帧零分配、画面稳定不闪烁。
   */
  private getRoofDecor(rect: { x: number; y: number; w: number; h: number }, hasChimney: boolean): RoofDecor {
    const key = `${rect.x},${rect.y},${rect.w},${rect.h}`;
    const cached = this.roofDecorCache.get(key);
    if (cached) return cached;

    const rng = createRng(Math.abs(Math.floor(rect.x * 31 + rect.y * 17 + rect.w * 7)) + 913);
    const L = rect.x - 8;
    const T = rect.y - 8;
    const RW = rect.w + 16;
    const RH = rect.h + 16;
    const midY = rect.y + rect.h * 0.5;

    // 塌陷破洞：大屋顶 2 个、小屋顶 1 个，避开屋脊与烟囱
    const holes: number[][] = [];
    const holeCenters: number[] = [];
    const boards: number[] = [];
    const holeCount = rect.w * rect.h > 60000 ? 2 : 1;
    const anchors = [0.7, 0.72, 0.3, 0.26];
    for (let i = 0; i < holeCount; i++) {
      let hx = rect.x + rect.w * (anchors[i * 2] + (rng() - 0.5) * 0.12);
      const hy = rect.y + rect.h * (anchors[i * 2 + 1] + (rng() - 0.5) * 0.08);
      if (hasChimney && hx < rect.x + 100 && hy < rect.y + 80) hx += 70;
      const rx = 16 + rng() * 12;
      const ry = 10 + rng() * 8;
      const poly: number[] = [];
      const nv = 17;
      for (let k = 0; k < nv; k++) {
        const a = (k / nv) * Math.PI * 2;
        // 参差半径 = 碎裂木茬（随机长刺 + 低频凹凸，避免规则菱形/透镜形）
        const spike = rng() < 0.35 ? 0.25 + rng() * 0.35 : 0;
        const j = 0.55 + rng() * 0.35 + spike + 0.18 * Math.sin(a * 2 + rx);
        poly.push(hx + Math.cos(a) * rx * j, hy + Math.sin(a) * ry * j);
      }
      holes.push(poly);
      holeCenters.push(hx, hy, rx, ry);
      // 横跨破洞的断裂椽木（只伸出一半，另一半已断落）
      const bc = 1 + Math.floor(rng() * 2);
      for (let k = 0; k < bc; k++) {
        const ang = (rng() - 0.5) * 0.5;
        const off = (rng() - 0.5) * ry * 0.9;
        const half = rx * (0.9 + rng() * 0.5);
        boards.push(
          hx - Math.cos(ang) * half,
          hy + off - Math.sin(ang) * half,
          hx + Math.cos(ang) * half * (0.3 + rng() * 0.5),
          hy + off + Math.sin(ang) * half * 0.5,
          3 + rng() * 2
        );
      }
    }

    // 锈铁皮补丁
    const patches: number[] = [];
    const pc = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < pc; i++) {
      const pw = 30 + rng() * 34;
      const ph = 18 + rng() * 16;
      const px = rect.x + 10 + rng() * Math.max(4, rect.w - pw - 20);
      const span = Math.max(4, rect.h * 0.5 - ph - 20);
      const py = rng() > 0.5 ? midY + 10 + rng() * span : rect.y + 10 + rng() * span;
      patches.push(px, py, pw, ph, (rng() - 0.5) * 0.12);
    }

    // 中段下垂的弯曲屋脊
    const ridge: number[] = [];
    const steps = Math.max(6, Math.round(RW / 22));
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      ridge.push(L - 1 + u * (RW + 2), midY + Math.sin(u * Math.PI) * 3.5 + (rng() - 0.5) * 2.2);
    }

    // 截断边缘不规则缺口
    const chips: number[] = [];
    const chipCount = Math.round((RW + RH) / 13);
    for (let i = 0; i < chipCount; i++) {
      const side = Math.floor(rng() * 4);
      const along = rng();
      const cw = 3 + rng() * 7;
      const chh = 2 + rng() * 4;
      const depth = 3 + rng() * 4;
      if (side === 0) chips.push(L + along * (RW - cw), T + depth, cw, chh);
      else if (side === 1) chips.push(L + along * (RW - cw), T + RH - depth - chh, cw, chh);
      else if (side === 2) chips.push(L + depth, T + along * (RH - cw), chh, cw);
      else chips.push(L + RW - depth - chh, T + along * (RH - cw), chh, cw);
    }

    const decor: RoofDecor = { holes, holeCenters, boards, patches, ridge, chips };
    this.roofDecorCache.set(key, decor);
    return decor;
  }

  /** 沿折线顶点（x,y 交错）描边，整体纵向偏移 oy */
  private strokePolyline(ctx: CanvasRenderingContext2D, pts: number[], oy: number) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      if (i === 0) ctx.moveTo(pts[i], pts[i + 1] + oy);
      else ctx.lineTo(pts[i], pts[i + 1] + oy);
    }
    ctx.stroke();
  }

  /**
   * ?v-cine=b：破旧焦油毡/腐朽木瓦/锈铁皮屋顶。
   * 低对比坡面明暗、局部下沉暗斑与塌陷破洞（发电机运转时洞底透出暖黄室内光）、断椽、锈铁皮补丁、下垂屋脊，
   * 边缘保留厚重近黑截断面（#070808）与不规则缺口。
   */
  private drawRoofCutawayCine(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; w: number; h: number },
    alpha: number,
    warmWindowLeak: boolean,
    simTime: number,
    hasChimney: boolean
  ) {
    const decor = this.getRoofDecor(rect, hasChimney);
    const L = rect.x - 8;
    const T = rect.y - 8;
    const RW = rect.w + 16;
    const RH = rect.h + 16;

    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);

    // 双层柔和屋檐投影
    ctx.fillStyle = 'rgba(5, 6, 5, 0.46)';
    ctx.fillRect(rect.x + 10, rect.y + 12, rect.w + 4, rect.h + 4);
    ctx.fillStyle = 'rgba(5, 6, 5, 0.22)';
    ctx.fillRect(rect.x + 14, rect.y + 17, rect.w + 8, rect.h + 8);

    // 焦油毡 / 朽木瓦 / 锈铁皮基底
    ctx.fillStyle = this.roofPat ?? '#1f1b16';
    ctx.fillRect(L, T, RW, RH);

    // 以下装饰全部裁剪在屋顶范围内
    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T, RW, RH);
    ctx.clip();

    // 坡面明暗：北坡背光更深、屋脊下沿最暗、南坡受光、屋檐雨水污积
    const slope = ctx.createLinearGradient(0, T, 0, T + RH);
    slope.addColorStop(0, 'rgba(0, 0, 0, 0.40)');
    slope.addColorStop(0.47, 'rgba(0, 0, 0, 0.22)');
    slope.addColorStop(0.5, 'rgba(0, 0, 0, 0.30)');
    slope.addColorStop(0.53, 'rgba(0, 0, 0, 0.02)');
    slope.addColorStop(0.88, 'rgba(0, 0, 0, 0.08)');
    slope.addColorStop(1, 'rgba(0, 0, 0, 0.34)');
    ctx.fillStyle = slope;
    ctx.fillRect(L, T, RW, RH);

    // 结构下沉区域的大块柔和暗斑（破洞周围）
    const hc = decor.holeCenters;
    for (let i = 0; i < hc.length; i += 4) {
      const sr = hc[i + 2] * 2.6;
      const sag = ctx.createRadialGradient(hc[i], hc[i + 1], 4, hc[i], hc[i + 1], sr);
      sag.addColorStop(0, 'rgba(0, 0, 0, 0.34)');
      sag.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = sag;
      ctx.fillRect(hc[i] - sr, hc[i + 1] - sr, sr * 2, sr * 2);
    }

    // 锈铁皮补丁（四角铆钉、细瓦楞、下缘锈水）
    const pt = decor.patches;
    for (let i = 0; i < pt.length; i += 5) {
      const pw = pt[i + 2];
      const ph = pt[i + 3];
      const hw = pw * 0.5;
      const hh = ph * 0.5;
      ctx.save();
      ctx.translate(pt[i] + hw, pt[i + 1] + hh);
      ctx.rotate(pt[i + 4]);
      ctx.fillStyle = 'rgba(4, 4, 3, 0.45)';
      ctx.fillRect(-hw + 2, -hh + 3, pw, ph);
      ctx.fillStyle = '#29231e';
      ctx.fillRect(-hw, -hh, pw, ph);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.26)';
      for (let k = -hw + 3; k < hw - 1; k += 4.5) ctx.fillRect(k, -hh, 1.5, ph);
      ctx.fillStyle = 'rgba(84, 54, 34, 0.24)';
      ctx.fillRect(-hw, hh - ph * 0.35, pw * 0.6, ph * 0.35);
      ctx.fillStyle = '#141210';
      ctx.fillRect(-hw + 2, -hh + 2, 2, 2);
      ctx.fillRect(hw - 4, -hh + 2, 2, 2);
      ctx.fillRect(-hw + 2, hh - 4, 2, 2);
      ctx.fillRect(hw - 4, hh - 4, 2, 2);
      ctx.restore();
    }

    // 塌陷破洞：翻起的碎毡边 + 深黑洞口（发电机运转时洞底透出暖黄室内灯光）
    for (let h = 0; h < decor.holes.length; h++) {
      const poly = decor.holes[h];
      const hx = hc[h * 4];
      const hy = hc[h * 4 + 1];
      const hrx = hc[h * 4 + 2];
      ctx.fillStyle = 'rgba(58, 52, 44, 0.32)';
      ctx.beginPath();
      for (let k = 0; k < poly.length; k += 2) {
        const px = hx + (poly[k] - hx) * 1.22;
        const py = hy + (poly[k + 1] - hy) * 1.22 - 1;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      for (let k = 0; k < poly.length; k += 2) {
        if (k === 0) ctx.moveTo(poly[k], poly[k + 1]);
        else ctx.lineTo(poly[k], poly[k + 1]);
      }
      ctx.closePath();
      if (warmWindowLeak) {
        const fl = 0.85 + Math.sin(simTime * 9.5 + h * 1.7) * 0.1;
        const glow = ctx.createRadialGradient(hx, hy, 1, hx, hy, hrx);
        glow.addColorStop(0, `rgba(118, 84, 46, ${(0.8 * fl).toFixed(3)})`);
        glow.addColorStop(0.55, 'rgba(34, 24, 14, 0.96)');
        glow.addColorStop(1, 'rgba(10, 8, 6, 1)');
        ctx.fillStyle = glow;
      } else {
        ctx.fillStyle = '#080706';
      }
      ctx.fill();
    }

    // 断裂椽木（带投影）
    const bd = decor.boards;
    ctx.lineCap = 'butt';
    for (let i = 0; i < bd.length; i += 5) {
      ctx.strokeStyle = 'rgba(4, 4, 3, 0.6)';
      ctx.lineWidth = bd[i + 4] + 2;
      ctx.beginPath();
      ctx.moveTo(bd[i] + 1.5, bd[i + 1] + 2);
      ctx.lineTo(bd[i + 2] + 1.5, bd[i + 3] + 2);
      ctx.stroke();
      ctx.strokeStyle = '#2b2219';
      ctx.lineWidth = bd[i + 4];
      ctx.beginPath();
      ctx.moveTo(bd[i], bd[i + 1]);
      ctx.lineTo(bd[i + 2], bd[i + 3]);
      ctx.stroke();
    }

    // 中段下垂的手斫屋脊（投影 -> 本体 -> 极弱磨损高光）
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(4, 4, 3, 0.55)';
    ctx.lineWidth = 12;
    this.strokePolyline(ctx, decor.ridge, 3);
    ctx.strokeStyle = '#211b15';
    ctx.lineWidth = 8;
    this.strokePolyline(ctx, decor.ridge, 0);
    ctx.strokeStyle = 'rgba(150, 140, 122, 0.07)';
    ctx.lineWidth = 2;
    this.strokePolyline(ctx, decor.ridge, -2.5);
    // 发电机运转时，屋脊接缝透出一线极弱暖光
    if (warmWindowLeak) {
      ctx.strokeStyle = `rgba(206, 146, 72, ${(0.14 + Math.sin(simTime * 9.5) * 0.03).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      this.strokePolyline(ctx, decor.ridge, 5);
    }

    // 砖砌烟囱（烟熏污渍 + 深黑烟道）与随风飘散的炉烟
    if (hasChimney) {
      const chx = rect.x + 42;
      const chy = rect.y + 30;
      ctx.fillStyle = 'rgba(4, 4, 3, 0.5)';
      ctx.fillRect(chx + 4, chy + 6, 28, 28);
      ctx.fillStyle = '#32261f';
      ctx.fillRect(chx, chy, 28, 28);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fillRect(chx, chy + 9, 28, 1.5);
      ctx.fillRect(chx, chy + 18, 28, 1.5);
      ctx.fillRect(chx + 13, chy, 1.5, 9);
      ctx.fillRect(chx + 6, chy + 9, 1.5, 9);
      ctx.fillRect(chx + 20, chy + 18, 1.5, 10);
      ctx.fillStyle = '#0a0807';
      ctx.fillRect(chx + 6, chy + 6, 16, 16);
      ctx.strokeStyle = '#070808';
      ctx.lineWidth = 2.4;
      ctx.strokeRect(chx, chy, 28, 28);
      if (warmWindowLeak) {
        for (let k = 0; k < 3; k++) {
          const p = (simTime * 0.35 + k * 0.33) % 1;
          const sx = chx + 14 + p * 34 + Math.sin(simTime * 1.4 + k) * 5;
          const sy = chy + 14 - p * 22;
          ctx.fillStyle = `rgba(108, 112, 106, ${((1 - p) * 0.2).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx, sy, 8 + p * 16, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();

    // 厚重近黑截断面（#070808）+ 粗糙破损缺口 + 内侧极弱磨损边交代厚度
    ctx.strokeStyle = '#070808';
    ctx.lineWidth = 7;
    ctx.strokeRect(L + 3, T + 3, RW - 6, RH - 6);
    ctx.fillStyle = '#070808';
    const ch = decor.chips;
    for (let i = 0; i < ch.length; i += 4) ctx.fillRect(ch[i], ch[i + 1], ch[i + 2], ch[i + 3]);
    ctx.strokeStyle = 'rgba(150, 146, 136, 0.06)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(L + 7.5, T + 7.5, RW - 15, RH - 15);

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
    // 1b. ?v-cine=b：低频积水遮罩以 lighter 叠加到 B 通道（R/G 为 0，不改动法线方向）
    if (this.cineOn && this.groundMacroWetPat) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = this.groundMacroWetPat;
      ctx.fillRect(viewL, viewT, W, H);
      ctx.restore();
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

    // Channel R: 手电筒冷白聚焦远射光束 / 白昼自然中性前向视野锥
    const isDayVision = engine.phase === 'day' && engine.mode !== 'title';
    const coneActive = (p.flashlightOn && p.flickerVal > 0.05) || isDayVision;
    if (coneActive) {
      const hasBeam = p.flashlightOn && p.flickerVal > 0.05;
      // 手电筒：远射高锐度冷白/微青光锥（660px）；白昼关手电：中性冷灰自然视觉前向锥
      const coneLen = hasBeam ? 660 : 540;
      const effConeHalf = hasBeam ? coneHalfRad * 0.90 : coneHalfRad;
      const isTitle = engine.mode === 'title';
      const beamX = isTitle ? 0 : p.x;
      const beamY = isTitle ? HIDEOUT_RECT.y + HIDEOUT_RECT.h + 14 : p.y;
      computeVisibilityPolygon(
        engine.world,
        beamX,
        beamY,
        coneLen,
        this.polyScratch,
        p.angle,
        effConeHalf + 0.05
      );
      fillPoly(this.polyScratch, '#ff0000');

      const coldPalette = Variants.val.palette !== 'a';
      const baseInt = hasBeam
        ? (coldPalette ? 2.65 : 2.35) * p.flickerVal
        : 1.32;
      this.gpuLights.push({
        x: beamX - viewL,
        y: beamY - viewT,
        radius: coneLen,
        intensity: baseInt,
        // 手电筒呈冷白微青聚焦电光，与火把的炽热暖橘形成鲜明反差
        r: hasBeam ? 0.84 : 0.93,
        g: hasBeam ? 0.94 : 0.96,
        b: hasBeam ? 1.0 : 0.94,
        dirX: Math.cos(p.angle),
        dirY: Math.sin(p.angle),
        coneCos: Math.cos(effConeHalf),
        shadowChannel: 0,
      });
    }

    // Channel B: 角色近身极微弱轮廓感知圈（手持火把时大幅压低无源暖光，让真实暖橘火把主导照明）
    const holdingLitTorch = engine.equip.torchInHand && engine.equip.torchLight > 0.1;
    const auraR = holdingLitTorch ? 72 : engine.phase === 'day' ? 96 : 82;
    computeVisibilityPolygon(engine.world, p.x, p.y, auraR, this.auraPolyScratch);
    fillPoly(this.auraPolyScratch, '#0000ff');
    this.gpuLights.push({
      x: p.x - viewL,
      y: p.y - viewT,
      radius: auraR,
      intensity: holdingLitTorch ? 0.44 : engine.phase === 'night' ? 0.86 : 1.05,
      r: holdingLitTorch ? 0.88 : 0.86,
      g: holdingLitTorch ? 0.88 : 0.90,
      b: holdingLitTorch ? 0.92 : 0.92,
      dirX: 0,
      dirY: 0,
      coneCos: -2.0,
      shadowChannel: 2,
    });

    // R3：右手火把浓郁暖橘点光 / 枪口一帧强光 / 地上火把（高优先级，带火焰摇曳）
    this.pushEquipmentLights(engine, viewL, viewT, maxLights, fillPoly);

    // Channel G: 庇护所发电机暖黄吊灯（带真实物理钟摆摇曳：受雷暴风、怪物砸门震屏及主角穿行激发）
    const lampDt = this.lampLastT < 0 ? 0 : clamp(engine.simTime - this.lampLastT, 0, 0.05);
    this.lampLastT = engine.simTime;
    if (lampDt > 0) {
      const windAmp = 1.4 + engine.weather.rainIntensity * 3.5 + engine.shake * 2.2;
      for (let li = 0; li < SHELTER_LAMPS.length; li++) {
        const lamp = SHELTER_LAMPS[li];
        // 玩家快步走过灯下时带起气流微推
        const dp = dist(p.x, p.y, lamp.x, lamp.y);
        if (dp < 42) {
          this.lampVelX[li] += p.vx * 0.06 * lampDt;
          this.lampVelY[li] += p.vy * 0.06 * lampDt;
        }
        // 微弱自然风/发电机震动激励 + 欠阻尼弹簧回复
        const driveX = Math.sin(engine.simTime * (1.7 + li * 0.45) + li * 2.1) * windAmp;
        const driveY = Math.cos(engine.simTime * (1.35 + li * 0.38) + li * 1.4) * windAmp * 0.7;
        const k = 11.5;
        const damp = 1.65;
        this.lampVelX[li] += (-k * this.lampSwingX[li] - damp * this.lampVelX[li] + driveX) * lampDt;
        this.lampVelY[li] += (-k * this.lampSwingY[li] - damp * this.lampVelY[li] + driveY) * lampDt;
        this.lampSwingX[li] = clamp(this.lampSwingX[li] + this.lampVelX[li] * lampDt, -13, 13);
        this.lampSwingY[li] = clamp(this.lampSwingY[li] + this.lampVelY[li] * lampDt, -11, 11);
      }
    }
    const coldPalette = Variants.val.palette !== 'a';
    if (engine.generatorOn && engine.generatorFuel > 0) {
      const sputter =
        engine.generatorFuel < 16
          ? Math.sin(engine.simTime * 24) > 0.35
            ? 0.32
            : 0.96
          : 0.96 + Math.sin(engine.simTime * 7.2) * 0.04;
      const lampR = 248;
      for (let li = 0; li < SHELTER_LAMPS.length; li++) {
        const lamp = SHELTER_LAMPS[li];
        if (this.gpuLights.length >= maxLights) break;
        if (dist(lamp.x, lamp.y, engine.camX, engine.camY) > W * 0.9) continue;
        const lx = lamp.x + (this.lampSwingX[li] || 0);
        const ly = lamp.y + (this.lampSwingY[li] || 0);
        computeVisibilityPolygon(engine.world, lx, ly, lampR, this.lampPolyScratch);
        fillPoly(this.lampPolyScratch, '#00ff00');
        this.gpuLights.push({
          x: lx - viewL,
          y: ly - viewT,
          radius: lampR,
          intensity: (coldPalette ? 1.88 : 1.72) * sputter,
          r: 1.0,
          g: coldPalette ? 0.78 : 0.68,
          b: coldPalette ? 0.48 : 0.34,
          dirX: 0,
          dirY: 0,
          coneCos: -2.0,
          shadowChannel: 1,
        });
      }
    }

    // 活篝火与生锈铁桶余烬火盆：不规则高频呼吸频闪暖色动态点光 + 柔和阴影摇曳
    const fireSources = [
      { pos: HIDEOUT_BRAZIER_POS, r: 190, baseIntensity: 2.35, seed: 5.3, shadowed: true },
      { pos: CAMPFIRE_POS, r: 230, baseIntensity: 2.85, seed: 1.7, shadowed: true },
      { pos: HIDEOUT_STOVE_POS, r: 100, baseIntensity: 1.28, seed: 3.1, shadowed: false },
    ];
    for (const fire of fireSources) {
      if (this.gpuLights.length >= maxLights) break;
      if (dist(fire.pos.x, fire.pos.y, engine.camX, engine.camY) > W * 0.85) continue;
      const t = engine.simTime;
      const flicker =
        0.84 +
        Math.sin(t * 11.7 + fire.seed) * 0.09 +
        Math.sin(t * 25.3 + fire.seed * 2.1) * 0.07;
      const jitterX = Math.sin(t * 9.2 + fire.seed) * 2.4;
      const jitterY = Math.cos(t * 13.6 + fire.seed) * 2.0;
      const fx = fire.pos.x + jitterX;
      const fy = fire.pos.y + jitterY;

      if (fire.shadowed) {
        computeVisibilityPolygon(engine.world, fx, fy, fire.r, this.lampPolyScratch);
        fillPoly(this.lampPolyScratch, '#00ff00');
      }
      this.gpuLights.push({
        x: fx - viewL,
        y: fy - viewT,
        radius: fire.r,
        intensity: fire.baseIntensity * flicker,
        r: 1.0,
        g: 0.64,
        b: 0.32,
        dirX: 0,
        dirY: 0,
        coneCos: -2.0,
        shadowChannel: fire.shadowed ? 1 : 3,
      });
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
    // ?v-cine=b：菌光半径 95 -> 58、强度 0.85 -> 0.55、色相去饱和（冷灰青）
    const cineGlow = this.cineOn;
    for (const node of engine.world.essences) {
      if (node.harvested || this.gpuLights.length >= maxLights) continue;
      if (dist(node.x, node.y, engine.camX, engine.camY) > W * 0.65) continue;
      const pulse = 0.75 + Math.sin(engine.simTime * 2.8 + node.pulsePhase) * 0.25;
      this.gpuLights.push({
        x: node.x - viewL,
        y: node.y - viewT,
        radius: cineGlow ? 46 : 75,
        intensity: (cineGlow ? 0.34 : 0.65) * pulse,
        r: cineGlow ? 0.48 : 0.40,
        g: cineGlow ? 0.68 : 0.88,
        b: cineGlow ? 0.62 : 0.77,
        dirX: 0,
        dirY: 0,
        coneCos: -2.0,
        shadowChannel: 3,
      });
    }

    // 全地图 POI 建筑室内灯具（油灯、台灯、吊灯、蜡烛）推入 GPU 动态光照
    pushBuildingLights(engine, this.gpuLights, maxLights, viewL, viewT, W, H, this.lampPolyScratch, fillPoly);

    sctx.restore();
  }

  /**
   * 光照后高空前景树冠层（Darkwood 核心立体架构）：
   * 在延迟光照与视野锥合成之后绘制双层强视差树冠（丰富树叶簇 + 粗壮扭曲黑枝 + 高空失焦暗冠），
   * 使手电与火光从重重枝叶下方照亮草地、树根与树干，而越往上是越阴暗、有层次的树梢与树叶！
   * 随后在树冠之上绘制树枝栖息与起飞/飞行的乌鸦。
   */
  private drawOverLightingCanopies(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    W: number,
    H: number,
    camX: number,
    camY: number,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number,
    coneHalfRad: number
  ): number {
    let draws = 0;
    const swayOn = Quality.preset.canopySway;
    const stormWind = 1 + engine.weather.rainIntensity * 1.55;
    const night = this.getNightAmount(engine);
    // 昼夜层次微调：白天略透以展示丰富的叶簇与枝干层次，夜晚更深沉幽暗
    const baseOpacity = lerp(0.88, 0.96, night);
    const topOpacity = lerp(0.92, 0.99, night);

    ctx.save();
    ctx.translate(-viewL, -viewT);

    // 第零遍（贴地树后方向阴影层，位于光照之后、高空树冠之下）：
    // 在光照后直接压暗树干背光侧地面，不被手电高光冲淡，由近及远平滑淡出，清晰拉开“明亮地面 → 树后地面影 → 高空树枝”的光暗高层差别！
    const pLightX = engine.player.x;
    const pLightY = engine.player.y;
    const pLookCos = Math.cos(coneHalfRad + 0.14);
    const pLookDx = Math.cos(engine.player.angle);
    const pLookDy = Math.sin(engine.player.angle);
    const torchOn = engine.equip.torchInHand && engine.equip.torchLit && engine.equip.torchLight > 0.1;

    for (const t of engine.world.trees) {
      if (t.x < viewL - 220 || t.x > viewR + 220 || t.y < viewT - 220 || t.y > viewB + 220) continue;
      const dxP = t.x - pLightX;
      const dyP = t.y - pLightY;
      const dP = Math.hypot(dxP, dyP);
      if (dP < 10 || dP > 580) continue;
      const dot = (dxP * pLookDx + dyP * pLookDy) / dP;
      const inCone = engine.player.flashlightOn && dot > pLookCos;
      const inTorch = torchOn && dP < 240;
      if (!inCone && !inTorch) continue;

      const awayAng = Math.atan2(dyP, dxP);
      // 树影长度随树干粗细与距光源远近自然拉伸（近光源长、远光源短），由近及远平滑淡出
      const shadowLen = clamp(125 + t.trunkR * 4.2 + (inCone ? (1 - dP / 580) * 95 : 25), 130, 260);
      const nearW = t.trunkR * 0.96;
      const farW = t.trunkR * 1.62;
      const strength = clamp((inCone ? 0.72 * (1 - dP / 640) : 0) + (inTorch ? 0.56 * (1 - dP / 260) : 0), 0.18, 0.76);

      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(awayAng);
      // 1) 外层宽柔半影（模拟高空枝叶散射的柔和边缘）
      const gOuter = ctx.createLinearGradient(0, 0, shadowLen, 0);
      gOuter.addColorStop(0, `rgba(4, 5, 5, ${(strength * 0.46).toFixed(3)})`);
      gOuter.addColorStop(0.42, `rgba(4, 5, 5, ${(strength * 0.24).toFixed(3)})`);
      gOuter.addColorStop(0.8, `rgba(4, 5, 5, ${(strength * 0.06).toFixed(3)})`);
      gOuter.addColorStop(1, 'rgba(4, 5, 5, 0)');
      ctx.fillStyle = gOuter;
      ctx.beginPath();
      ctx.moveTo(0, -nearW * 1.35);
      ctx.lineTo(shadowLen, -farW * 1.48);
      ctx.lineTo(shadowLen, farW * 1.48);
      ctx.lineTo(0, nearW * 1.35);
      ctx.closePath();
      ctx.fill();

      // 2) 内层贴地深影（树干根部背光处最深，向远处平滑衰减，无硬边黑柱感）
      const gInner = ctx.createLinearGradient(0, 0, shadowLen * 0.85, 0);
      gInner.addColorStop(0, `rgba(3, 4, 4, ${(strength * 0.88).toFixed(3)})`);
      gInner.addColorStop(0.32, `rgba(4, 5, 5, ${(strength * 0.52).toFixed(3)})`);
      gInner.addColorStop(0.68, `rgba(4, 5, 5, ${(strength * 0.18).toFixed(3)})`);
      gInner.addColorStop(1, 'rgba(4, 5, 5, 0)');
      ctx.fillStyle = gInner;
      ctx.beginPath();
      ctx.moveTo(0, -nearW * 0.86);
      ctx.lineTo(shadowLen * 0.85, -farW * 0.92);
      ctx.lineTo(shadowLen * 0.85, farW * 0.92);
      ctx.lineTo(0, nearW * 0.86);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 第一遍：中低层树冠（丰富锯齿叶簇 + 粗壮扭曲主枝，中等高度视差，让光锥透过叶隙照亮下方地面与树根）
    for (const t of engine.world.trees) {
      const size = t.canopyR * (this.cineOn ? 4.35 : 2.85);
      const cPad = size * 0.56 + 68;
      if (t.x < viewL - cPad || t.x > viewR + cPad || t.y < viewT - cPad || t.y > viewB + cPad) continue;
      const dPlayer = dist(engine.player.x, engine.player.y, t.x, t.y);
      const fadeR = t.canopyR * 1.4 + 26;
      const canopyAlpha = dPlayer < fadeR ? lerp(0.18, 1.0, clamp((dPlayer - 30) / Math.max(1, fadeR - 30), 0, 1)) : 1.0;
      const variantIdx = t.id % this.atlas.canopySprites.length;

      const waveBase = swayOn ? Math.sin(engine.simTime * (0.86 * stormWind) + t.phase + t.x * 0.004) : 0;
      const waveBaseY = swayOn ? Math.cos(engine.simTime * (0.68 * stormWind) + t.phase + t.y * 0.004) : 0;
      const baseSwayX = waveBase * (4.6 * stormWind);
      const baseSwayY = waveBaseY * (3.0 * stormWind);
      const baseParaX = clamp((t.x - camX) * 0.078, -42, 42);
      const baseParaY = clamp((t.y - camY) * 0.078, -42, 42);

      const baseSprite = this.atlas.canopySprites[variantIdx];
      ctx.save();
      ctx.globalAlpha = canopyAlpha * baseOpacity;
      ctx.translate(t.x + baseSwayX + baseParaX, t.y + baseSwayY + baseParaY);
      ctx.rotate(t.phase + waveBase * 0.015);
      ctx.drawImage(baseSprite, -size * 0.5, -size * 0.5, size, size);
      ctx.restore();
      draws++;
    }

    // 第二遍：最高空树梢与失焦暗冠层（更强视差、错相摇曳、最深邃漆黑，统一叠在中低层树冠之上形成森林天盖！）
    for (const t of engine.world.trees) {
      if (Math.abs(t.x - camX) > W * 0.54 || Math.abs(t.y - camY) > H * 0.58) continue;
      const size = t.canopyR * (this.cineOn ? 4.65 : 3.0);
      const dPlayer = dist(engine.player.x, engine.player.y, t.x, t.y);
      const fadeR = t.canopyR * 1.48 + 30;
      const canopyAlpha = dPlayer < fadeR ? lerp(0.14, 1.0, clamp((dPlayer - 28) / Math.max(1, fadeR - 28), 0, 1)) : 1.0;
      const variantIdx = t.id % this.atlas.canopyTopSprites.length;

      const waveBase = swayOn ? Math.sin(engine.simTime * (0.86 * stormWind) + t.phase + t.x * 0.004) : 0;
      const waveBaseY = swayOn ? Math.cos(engine.simTime * (0.68 * stormWind) + t.phase + t.y * 0.004) : 0;
      const waveTop = swayOn ? Math.sin(engine.simTime * (1.32 * stormWind) + t.phase + 1.55 + t.x * 0.006) : 0;
      const waveTopY = swayOn ? Math.cos(engine.simTime * (1.06 * stormWind) + t.phase + 0.95 + t.y * 0.006) : 0;
      const topSwayX = waveBase * (4.6 * stormWind) + waveTop * (6.2 * stormWind);
      const topSwayY = waveBaseY * (3.0 * stormWind) + waveTopY * (4.2 * stormWind);
      const topParaX = clamp((t.x - camX) * 0.175, -82, 82);
      const topParaY = clamp((t.y - camY) * 0.175, -82, 82);

      const topSprite = this.atlas.canopyTopSprites[variantIdx];
      ctx.save();
      ctx.globalAlpha = canopyAlpha * topOpacity;
      ctx.translate(t.x + topSwayX + topParaX, t.y + topSwayY + topParaY);
      ctx.rotate(t.phase + waveTop * 0.032);
      ctx.drawImage(topSprite, -size * 0.5, -size * 0.5, size, size);
      ctx.restore();
      draws++;
    }

    // 树冠之上栖息、起飞、飞行与降落的乌鸦
    draws += this.drawCrows(ctx, engine, coneHalfRad, viewL, viewT, viewR, viewB, 'canopy');

    ctx.restore();
    return draws;
  }

  private renderAboveDarknessOverlays(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    W: number,
    H: number,
    viewL: number,
    viewT: number
  ) {
    // 1. 极克制的林缘冷暗雾丝（去掉遮盖画面的灰白雾球，保持画面阴郁沉实且刀刻般清晰）
    const rainFog = clamp(engine.weather.rainIntensity, 0, 1);
    const baseAlpha = (0.008 + 0.012 * rainFog) * (engine.phase === 'dusk' ? 1.15 : engine.phase === 'night' ? 0.75 : 1);
    if (baseAlpha > 0.002 && Quality.preset.fogLayers > 0) {
      ctx.save();
      const driftX = (engine.simTime * 11 + viewL * 0.16) % 420;
      const driftY = (engine.simTime * 4 + viewT * 0.16) % 360;
      for (let i = 0; i < 4; i++) {
        const fx = ((i * 310 - driftX + 840) % (W + 420)) - 210;
        const fy = ((i * 217 - driftY + 720) % (H + 360)) - 180;
        const cd = clamp((Math.hypot(fx - W * 0.5, fy - H * 0.5) / W - 0.24) / 0.32, 0, 1);
        const fogW = cd * cd;
        if (fogW < 0.05) continue;
        ctx.globalAlpha = clamp(baseAlpha * fogW, 0, 0.03);
        const grad = ctx.createRadialGradient(fx, fy, 16, fx, fy, 190);
        grad.addColorStop(0, 'rgba(72, 84, 78, 1)');
        grad.addColorStop(1, 'rgba(72, 84, 78, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(fx, fy, 190, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 1b. 庇护所门窗木板缝隙的锐利条状漏光光束（参考 Darkwood ref_1_t4）
    ctx.save();
    ctx.translate(-viewL, -viewT);
    this.drawBarricadeLightSlits(ctx, engine, viewL, viewT, viewL + W, viewT + H);

    // 2. 雨幕：?v-cine=b = 俯视透视雨（从镜头方向落向地面，落点水花/积水涟漪/屋檐成串滴水）
    //    ?v-cine=a = release_v1 旧版双景深斜雨丝（柔化暗区纯白对比度：中景冷灰雾细雨 + 近景微冷雾色雨线）
    if (this.cineOn) {
      this.drawCineRain(ctx, engine, W, H, viewL, viewT);
    } else if (engine.weather.rainIntensity > 0.04) {
      const windDx = Math.cos(engine.weather.windAngle);
      const windDy = Math.sin(engine.weather.windAngle);
      const flashBoost = engine.weather.lightningFlash * 0.45;
      const nightSoften = engine.phase === 'night' ? 0.76 : engine.phase === 'dusk' ? 0.88 : 1.0;

      // 中景细密倾斜雨丝（layer === 0）：压低远景/暗区 alpha 避免过白突兀
      const midAlpha = flashBoost > 0.1 ? 0.42 : 0.24 * nightSoften;
      ctx.strokeStyle =
        flashBoost > 0.1
          ? `rgba(178, 196, 212, ${midAlpha.toFixed(3)})`
          : `rgba(128, 146, 156, ${midAlpha.toFixed(3)})`;
      ctx.lineWidth = 0.95;
      ctx.beginPath();
      for (let i = 0; i < engine.rainDrops.count; i++) {
        const d = engine.rainDrops.items[i];
        if (!d.active || d.layer !== 0) continue;
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - windDx * d.len, d.y - windDy * d.len);
      }
      ctx.stroke();

      // 近景更粗、更快、微带冷雾色调的近镜头雨线（layer === 1）
      const nearAlpha = flashBoost > 0.1 ? 0.58 : 0.37 * nightSoften;
      ctx.strokeStyle =
        flashBoost > 0.1
          ? `rgba(204, 220, 234, ${nearAlpha.toFixed(3)})`
          : `rgba(154, 174, 186, ${nearAlpha.toFixed(3)})`;
      ctx.lineWidth = 1.65;
      ctx.beginPath();
      for (let i = 0; i < engine.rainDrops.count; i++) {
        const d = engine.rainDrops.items[i];
        if (!d.active || d.layer !== 1) continue;
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

    // 4b. 世界空间动作 UI：限时交互墨线弧环 / 蓄力余烬细弧（暗部之上）
    this.drawActionUI(ctx, engine);

    // 5. Diegetic Interact Prompt（限时动作进行中进度由角色旁弧环表现，提示框不再重复画环）
    const snapPrompt = engine.getHudSnapshot().prompt;
    if (engine.mode === 'play' && snapPrompt) {
      this.drawDiegeticPrompt(
        ctx,
        snapPrompt.worldX,
        snapPrompt.worldY,
        snapPrompt.label,
        engine.player.action.kind !== 'none' ? 0 : snapPrompt.progress
      );
    }

    ctx.restore();
  }

  /**
   * ?v-cine=b：俯视透视雨幕——雨从屏幕（镜头）方向落向地面。
   * 每滴雨有固定的世界落点 G 与离地高度 z（0 = 地面，1 = 镜头高度），按针孔透视投影：
   *   P(z) = C + (G - 风偏移·z - C) · f(z)，f(z) = 1 / (1 - K·z)，C = 屏幕中心对应的世界点。
   * 因此快门拖影天然沿“屏幕中心→外”径向发散：越靠边缘越斜越长、中心近乎一点；
   * 越接近镜头越大/越亮/略失焦（光晕），落地时缩为细小锐利的点，并在落点生成小环 + 2–4 颗弹溅微粒，
   * 落在积水处（与法线缓冲 B 通道同源的积水遮罩 + 湿润度）改为同心涟漪。
   * 纯视觉粒子：渲染层私有、容量固定的 TypedArray 池，每帧零分配；只读 engine 的 simTime / weather / 屋顶 alpha，
   * 暂停定格时 dt = 0 雨幕同步定格；时钟回退或跳变（重置、读档、切换 variant）时清空。
   * 绘制提交：雨丝 ≤ 12 次 stroke（2 受光态 × 4 透视桶 + 2 个近层失焦光晕桶），水花 ≤ 4 次 stroke + 2 次 fill。
   */
  private drawCineRain(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    W: number,
    H: number,
    viewL: number,
    viewT: number
  ) {
    const t = engine.simTime;
    let dt = t - this.rainLastT;
    if (this.rainLastT < 0 || dt < 0 || dt > 0.25) {
      this.rainN = 0;
      this.splashN = 0;
      this.rainAccum[0] = 0;
      this.rainAccum[1] = 0;
      this.rainAccum[2] = 0;
      this.eavePrevU.fill(-1);
      this.rainSeed = 0x2f6b9a1d;
      dt = 0;
    }
    this.rainLastT = t;

    const rain = clamp(engine.weather.rainIntensity, 0, 1);
    this.rainDrawN = 0;
    this.beadN = 0;
    this.rainBucketCount.fill(0);
    if (rain < 0.03 && this.rainN === 0 && this.splashN === 0) return;

    const cxW = viewL + W * 0.5;
    const cyW = viewT + H * 0.5;
    const windDx = Math.cos(engine.weather.windAngle);
    const windDy = Math.sin(engine.weather.windAngle);
    // 俯视雨幕保持极轻风偏，让屏幕四周雨丝明确向画面/角色中心斜落收敛，中心区不出现横向长线
    const windS = 10 + 22 * rain;
    const wetness = engine.weather.wetness;

    // 手电光锥受光判定参数（光锥原点与 renderShadowMasksAndLights 一致）
    const p = engine.player;
    const isTitle = engine.mode === 'title';
    const coneHalf = Variants.val.cone === 'a' ? (39 * Math.PI) / 180 : (31 * Math.PI) / 180;
    this.rainBeamOn = p.flashlightOn && p.flickerVal > 0.05;
    this.rainBeamX = isTitle ? 0 : p.x;
    this.rainBeamY = isTitle ? HIDEOUT_RECT.y + HIDEOUT_RECT.h + 14 : p.y;
    this.rainBeamDX = Math.cos(p.angle);
    this.rainBeamDY = Math.sin(p.angle);
    this.rainBeamCos = Math.cos(coneHalf + 0.03);
    // R3：灯光/火光/照明弹/近身微光圈受光缓存（只读本帧 gpuLights；手电走上面的可见性多边形判定）
    this.rainLtN = 0;
    for (let li = 0; li < this.gpuLights.length; li++) {
      const gl = this.gpuLights[li];
      if (gl.shadowChannel === 0 || this.rainLtN >= 12) continue;
      const n = this.rainLtN++;
      const lx = gl.x + viewL;
      const ly = gl.y + viewT;
      const rr = gl.radius * 0.9;
      this.rainLtX[n] = lx;
      this.rainLtY[n] = ly;
      this.rainLtR2[n] = rr * rr;
      this.rainLtStrong[n] = gl.shadowChannel !== 2 && gl.intensity >= 1.2 ? 1 : 0;
      this.rainLtIn[n] = isPointInHideout(lx, ly) ? 1 : 0;
    }

    // 1) 按景深层生成：数量随 Quality.rainScale 与画面面积缩放，池满即停
    if (dt > 0 && rain >= 0.03) {
      const k = rain * Quality.preset.rainScale * ((W * H) / (1280 * 720)) * dt;
      const roofA = engine.hideoutRoofAlpha;
      const sawA = engine.sawmillRoofAlpha;
      const sr = SAWMILL_ROOF_RECT;
      for (let layer = 0; layer < 3; layer++) {
        this.rainAccum[layer] += RAIN_LAYER_RATE[layer] * k;
        while (this.rainAccum[layer] >= 1) {
          this.rainAccum[layer] -= 1;
          if (this.rainN >= RAIN_MAX) continue;
          const gx = viewL - 30 + this.rainRand() * (W + 60);
          const gy = viewT - 30 + this.rainRand() * (H + 60);
          // 玩家在室内、屋顶已渐隐：不画落进室内地面的雨（按屋顶 alpha 平滑过渡）
          if (roofA < 0.999 && isPointInHideout(gx, gy) && this.rainRand() >= roofA) continue;
          if (
            sawA < 0.999 &&
            gx >= sr.x &&
            gx <= sr.x + sr.w &&
            gy >= sr.y &&
            gy <= sr.y + sr.h &&
            this.rainRand() >= sawA
          ) {
            continue;
          }
          const i = this.rainN++;
          this.rainGX[i] = gx;
          this.rainGY[i] = gy;
          this.rainZ[i] = RAIN_Z0_MIN[layer] + this.rainRand() * RAIN_Z0_SPAN[layer];
          // 急雨高速下落（接近 2 倍落速）
          this.rainVZ[i] = 2.15 + this.rainRand() * 0.55;
          this.rainLayer[i] = layer;
        }
      }
    }

    // 2) 下落：落地瞬间在落点生成水花并以“末位填补”移除；其余透视投影为拖影写入绘制缓冲
    for (let i = 0; i < this.rainN; ) {
      const z = this.rainZ[i] - this.rainVZ[i] * dt;
      const gx = this.rainGX[i];
      const gy = this.rainGY[i];
      if (z <= 0) {
        if (this.rainRand() < RAIN_SPLASH_P[this.rainLayer[i]]) this.spawnRainSplash(gx, gy, wetness);
        const last = --this.rainN;
        if (i !== last) {
          this.rainGX[i] = this.rainGX[last];
          this.rainGY[i] = this.rainGY[last];
          this.rainZ[i] = this.rainZ[last];
          this.rainVZ[i] = this.rainVZ[last];
          this.rainLayer[i] = this.rainLayer[last];
        }
        continue;
      }
      this.rainZ[i] = z;
      this.queueRainStreak(gx, gy, z, this.rainVZ[i] * RAIN_SHUTTER, cxW, cyW, windDx, windDy, windS, viewL, viewT, W, H);
      i++;
    }

    // 3) 庇护所屋檐成串滴落（檐口在墙外，屋顶显隐都保留）
    if (rain > 0.06) this.updateEaveDrips(t, dt, rain, wetness, cxW, cyW, viewL, viewT, W, H);

    // 4) 水花推进与分桶（0/1 = 未受光 新/旧，2/3 = 手电光锥内 新/旧）
    for (let i = 0; i < this.splashN; ) {
      const age = this.splashAge[i] + dt;
      if (age >= this.splashLife[i]) {
        const last = --this.splashN;
        if (i !== last) {
          this.splashX[i] = this.splashX[last];
          this.splashY[i] = this.splashY[last];
          this.splashAge[i] = this.splashAge[last];
          this.splashLife[i] = this.splashLife[last];
          this.splashSeed[i] = this.splashSeed[last];
          this.splashKind[i] = this.splashKind[last];
        }
        continue;
      }
      this.splashAge[i] = age;
      const u = age / this.splashLife[i];
      // 分桶码 = 新/旧 + 受光级 × 2（0..5）
      this.splashCode[i] = (u < 0.45 ? 0 : 1) + this.rainLightAt(this.splashX[i], this.splashY[i]) * 2;
      i++;
    }

    // 5) 绘制（颜色均为预置常量串，alpha 走 globalAlpha，零字符串分配）
    const night = this.getNightAmount(engine);
    const flash = clamp(engine.weather.lightningFlash, 0, 1);
    const flashing = flash > 0.08;
    const fadeIn = clamp(0.35 + rain, 0.35, 1);
    // R3"光里才看见雨"：可见度 ∝ 该点受光量。仅环境光（受光级 0）：白昼 0.8，黑夜 0.06（近乎不可见）；
    // 微光圈/灯光外圈（受光级 1）：至少 0.5；手电光锥/灯光火光核心（受光级 2）：闪亮；闪电瞬间全部被照亮
    const unlitMul = (0.06 + 0.74 * (1 - night) + flash * 1.6) * fadeIn;
    const dimMul = Math.max(unlitMul, 0.5 * fadeIn);
    const litMul = 1.55 * (1 + flash * 0.6) * fadeIn;
    const unlitCol = flashing ? RAIN_COL_FLASH : RAIN_COL_UNLIT;
    const hiQ = Quality.preset.tier >= 1;

    ctx.save();
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 3; pass++) {
      const litOff = pass * 4;
      const mul = pass === 2 ? litMul : pass === 1 ? dimMul : unlitMul;
      if (mul < 0.012) continue;
      ctx.strokeStyle = pass === 2 ? RAIN_COL_LIT : unlitCol;
      for (let b = 0; b < 4; b++) {
        const code = b + litOff;
        if (this.rainBucketCount[code] === 0) continue;
        // 近镜头层轻微失焦：先画一层宽而淡的光晕，再画核心
        if (hiQ && RAIN_HALO_W[b] > 0) this.strokeRainBucket(ctx, code, RAIN_HALO_W[b], RAIN_HALO_A[b] * mul);
        this.strokeRainBucket(ctx, code, RAIN_CORE_W[b], RAIN_CORE_A[b] * mul);
      }
    }

    // 落点碎环 / 积水涟漪（R3：不画整圆——每个水花只画一段随机起点、0.9π–1.6π 的断弧，半径更小；
    // 未受光处对比再压低：白昼仅环境光时 alpha ≈ 0.08/0.03，黑夜 ≈ 0.007，受光处才明显）
    ctx.lineWidth = 0.8;
    for (let code = 0; code < 6; code++) {
      const lvl = code >> 1;
      const mulS = lvl === 2 ? litMul : lvl === 1 ? dimMul : unlitMul;
      const baseA = code % 2 === 0 ? (lvl === 0 ? 0.11 : 0.2) : lvl === 0 ? 0.045 : 0.09;
      if (baseA * mulS < 0.004) continue;
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < this.splashN; i++) {
        if (this.splashCode[i] !== code) continue;
        any = true;
        const x = this.splashX[i];
        const y = this.splashY[i];
        const u = this.splashAge[i] / this.splashLife[i];
        const sd = this.splashSeed[i];
        const a0 = sd * 37.7;
        const span = Math.PI * (0.9 + 0.7 * ((sd * 13.1) % 1));
        if (this.splashKind[i] === 0) {
          const r = 0.6 + 2.6 * Math.sqrt(u);
          ctx.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
          ctx.arc(x, y, r, a0, a0 + span);
        } else {
          const rm = 4 + sd * 4;
          const r1 = 1 + rm * u;
          ctx.moveTo(x + Math.cos(a0) * r1, y + Math.sin(a0) * r1);
          ctx.arc(x, y, r1, a0, a0 + span + 0.5);
          const r2 = 1 + rm * (u - 0.3);
          if (r2 > 1.4) {
            const a1 = a0 + 2.4;
            ctx.moveTo(x + Math.cos(a1) * r2, y + Math.sin(a1) * r2);
            ctx.arc(x, y, r2, a1, a1 + span * 0.7);
          }
        }
      }
      if (!any) continue;
      ctx.strokeStyle = lvl === 2 ? RAIN_COL_LIT : unlitCol;
      ctx.globalAlpha = clamp(baseA * mulS, 0, 0.9);
      ctx.stroke();
    }

    // 弹溅微粒（2–4 颗，抛物线上抬按透视略向外偏）+ 檐口悬垂水珠（同样按受光级分 3 批）
    for (let pass = 0; pass < 3; pass++) {
      const mulP = pass === 2 ? litMul : pass === 1 ? dimMul : unlitMul;
      const alphaP = (pass === 0 ? 0.3 : 0.45) * mulP;
      if (alphaP < 0.004) continue;
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < this.splashN; i++) {
        if (this.splashKind[i] !== 0 || this.splashCode[i] >> 1 !== pass) continue;
        const u = this.splashAge[i] / this.splashLife[i];
        if (u > 0.85) continue;
        any = true;
        const x = this.splashX[i];
        const y = this.splashY[i];
        const sd = this.splashSeed[i];
        const cnt = 2 + Math.floor(sd * 2.99);
        const lift = 4 * u * (1 - u);
        const sq = Math.sqrt(u);
        for (let k = 0; k < cnt; k++) {
          const a = sd * 40 + k * 2.39996;
          let fr = sd * 7.3 + k * 0.37;
          fr -= Math.floor(fr);
          const dd = (1.5 + 5.5 * fr) * sq;
          const px = x + Math.cos(a) * dd + (x - cxW) * lift * 0.01;
          const py = y + Math.sin(a) * dd + (y - cyW) * lift * 0.01;
          ctx.rect(px - 0.55, py - 0.55, 1.1, 1.1);
        }
      }
      for (let i = 0; i < this.beadN; i++) {
        if (this.beadLit[i] !== pass) continue;
        any = true;
        const s = this.beadS[i];
        ctx.moveTo(this.beadX[i] + s, this.beadY[i]);
        ctx.arc(this.beadX[i], this.beadY[i], s, 0, Math.PI * 2);
      }
      if (!any) continue;
      ctx.fillStyle = pass === 2 ? RAIN_COL_LIT : unlitCol;
      ctx.globalAlpha = clamp(alphaP, 0, 0.9);
      ctx.fill();
    }
    ctx.restore();
  }

  /** 将一滴雨（落点 gx,gy、离地高度 z、快门内高度变化 dz）透视投影为拖影，写入本帧绘制缓冲并分桶 */
  private queueRainStreak(
    gx: number,
    gy: number,
    z: number,
    dz: number,
    cxW: number,
    cyW: number,
    windDx: number,
    windDy: number,
    windS: number,
    viewL: number,
    viewT: number,
    W: number,
    H: number
  ) {
    if (this.rainDrawN >= RAIN_DRAW_MAX) return;
    const K = RAIN_PERSP_K;
    // 头：当前高度（越高越偏上风向，下落中顺风漂移）
    const f1 = 1 / (1 - K * z);
    const hx = gx - windDx * windS * z;
    const hy = gy - windDy * windS * z;
    const x1 = cxW + (hx - cxW) * f1;
    const y1 = cyW + (hy - cyW) * f1;
    // 尾：快门开启时更高的位置
    const zt = Math.min(z + dz, 0.92);
    const f0 = 1 / (1 - K * zt);
    // 拖影向量（尾 → 头）
    let vx = x1 - (cxW + (gx - windDx * windS * zt - cxW) * f0);
    let vy = y1 - (cyW + (gy - windDy * windS * zt - cyW) * f0);
    // 俯视透视：屏幕四周向中心斜落，越靠近中心斜度越小；屏幕中心附近基本看不见空中雨丝轨迹，只见地面雨花
    const rx = x1 - cxW;
    const ry = y1 - cyW;
    const rd = Math.sqrt(rx * rx + ry * ry);
    const halfMin = Math.min(W, H) * 0.5;
    const rNorm = halfMin > 1 ? rd / halfMin : 1;
    // 中心静默区（rNorm < 0.22）：完全隐藏空中雨丝轨迹，仅由落点地面雨花/涟漪表现下雨
    if (rNorm < 0.22) return;
    // 过渡区（0.22 ~ 0.46）：随离中心距离平滑渐显（通过确定性哈希概率淡入 + 缩短轨迹，避免生硬圆环边）
    if (rNorm < 0.46) {
      const fadeK = (rNorm - 0.22) / 0.24;
      const keepHash = this.hash01(Math.floor(gx * 1.7 + gy * 3.1));
      if (keepHash > fadeK * fadeK) return;
      vx *= 0.32 + 0.68 * fadeK;
      vy *= 0.32 + 0.68 * fadeK;
    }
    if (rd > 1) {
      const ux = rx / rd;
      const uy = ry / rd;
      const rs = RAIN_TILT_SAT * W;
      const dv = (vx * ux + vy * uy) * ((rs * Math.tanh(rd / rs)) / rd - 1);
      vx += ux * dv;
      vy += uy * dv;
    }
    const bucket = f1 < RAIN_BUCKET_F[0] ? 0 : f1 < RAIN_BUCKET_F[1] ? 1 : f1 < RAIN_BUCKET_F[2] ? 2 : 3;
    let cap = Math.max(windS * dz * f1, RAIN_LEN_REF_MIN) * RAIN_LEN_CAP;
    if (bucket === 3) {
      vx *= RAIN_NEAR_SHORTEN;
      vy *= RAIN_NEAR_SHORTEN;
      cap *= RAIN_NEAR_SHORTEN;
    }
    const len2 = vx * vx + vy * vy;
    if (len2 > cap * cap) {
      const s = cap / Math.sqrt(len2);
      vx *= s;
      vy *= s;
    }
    // 过短轨迹（接近中心）直接不画，保持中心视觉干净，突出地面雨花
    if (vx * vx + vy * vy < 2.2) return;
    const x0 = x1 - vx;
    const y0 = y1 - vy;
    const r = viewL + W + 8;
    const b = viewT + H + 8;
    if ((x1 < viewL - 8 && x0 < viewL - 8) || (x1 > r && x0 > r) || (y1 < viewT - 8 && y0 < viewT - 8) || (y1 > b && y0 > b)) {
      return;
    }
    const code = bucket + this.rainLightAt(hx, hy) * 4;
    const n = this.rainDrawN++;
    this.rainX0[n] = x0;
    this.rainY0[n] = y0;
    this.rainX1[n] = x1;
    this.rainY1[n] = y1;
    this.rainCode[n] = code;
    this.rainBucketCount[code]++;
  }

  /** 批量描一桶雨丝（单次 stroke） */
  private strokeRainBucket(ctx: CanvasRenderingContext2D, code: number, width: number, alpha: number) {
    // 近乎不可见的桶（如黑夜未受光雨丝的失焦光晕）直接跳过，省一次 stroke
    if (alpha < 0.004) return;
    ctx.lineWidth = width;
    ctx.globalAlpha = clamp(alpha, 0, 0.85);
    ctx.beginPath();
    for (let i = 0; i < this.rainDrawN; i++) {
      if (this.rainCode[i] !== code) continue;
      ctx.moveTo(this.rainX0[i], this.rainY0[i]);
      ctx.lineTo(this.rainX1[i], this.rainY1[i]);
    }
    ctx.stroke();
  }

  /**
   * 庇护所屋檐成串滴落：沿屋檐外挑线等距布置槽位，每槽 2 颗相位错开 0.5 的水滴（成串），
   * 下落段写入雨丝缓冲；落地瞬间生成水花；其余时间在檐口画逐渐鼓胀的悬垂水珠。全部由 simTime 解析计算，零状态分配。
   */
  private updateEaveDrips(
    t: number,
    dt: number,
    rain: number,
    wetness: number,
    cxW: number,
    cyW: number,
    viewL: number,
    viewT: number,
    W: number,
    H: number
  ) {
    const out = 7; // 屋檐外挑（世界 px）
    const ex0 = HIDEOUT_RECT.x - out;
    const ey0 = HIDEOUT_RECT.y - out;
    const ew = HIDEOUT_RECT.w + out * 2;
    const eh = HIDEOUT_RECT.h + out * 2;
    if (ex0 + ew < viewL - 20 || ex0 > viewL + W + 20 || ey0 + eh < viewT - 20 || ey0 > viewT + H + 20) return;
    const perim = 2 * (ew + eh);
    const slots = Math.min(EAVE_MAX, Math.floor(perim / 20));
    const spacing = perim / slots;
    const eaveZ = 0.06; // 檐口离地高度（相对镜头高度）
    const fallT = 0.17; // 从檐口落地用时（秒）
    const fEave = 1 / (1 - RAIN_PERSP_K * eaveZ);
    for (let j = 0; j < slots; j++) {
      const h1 = this.hash01(j * 3 + 1);
      const h2 = this.hash01(j * 3 + 2);
      const h3 = this.hash01(j * 3 + 3);
      let s = (j + 0.2 + h1 * 0.6) * spacing;
      let px = ex0;
      let py = ey0;
      let nx = 0;
      let ny = 0;
      if (s < ew) {
        px = ex0 + s;
        ny = -1;
      } else if ((s -= ew) < eh) {
        px = ex0 + ew;
        py = ey0 + s;
        nx = 1;
      } else if ((s -= eh) < ew) {
        px = ex0 + ew - s;
        py = ey0 + eh;
        ny = 1;
      } else {
        s -= ew;
        py = ey0 + eh - s;
        nx = -1;
      }
      const slot0 = j * 2;
      if (px < viewL - 12 || px > viewL + W + 12 || py < viewT - 12 || py > viewT + H + 12) {
        this.eavePrevU[slot0] = -1;
        this.eavePrevU[slot0 + 1] = -1;
        continue;
      }
      const gx = px + nx * 3;
      const gy = py + ny * 3;
      const period = (0.75 + h2 * 0.9) / (0.45 + rain);
      const fallU = Math.min(0.6, fallT / period);
      for (let c = 0; c < 2; c++) {
        const slot = slot0 + c;
        let u = t / period + h3 + c * 0.5;
        u -= Math.floor(u);
        const prev = this.eavePrevU[slot];
        this.eavePrevU[slot] = u;
        if (u < fallU) {
          // 下落中：从檐口高度落向墙外地面（几乎不受风偏）
          const z = Math.max(eaveZ * (1 - u / fallU), 0.002);
          this.queueRainStreak(gx, gy, z, (eaveZ / fallT) * RAIN_SHUTTER * 2.2, cxW, cyW, 0, 0, 0, viewL, viewT, W, H);
        } else {
          // 刚落地：生成水花
          if (dt > 0 && prev >= 0 && prev < fallU) this.spawnRainSplash(gx, gy, wetness);
          // 檐口悬垂水珠：逐渐鼓胀，下一滴即将坠落
          if (this.beadN < EAVE_MAX * 2) {
            const g = (u - fallU) / Math.max(1 - fallU, 0.001);
            const bi = this.beadN++;
            this.beadX[bi] = cxW + (gx - cxW) * fEave;
            this.beadY[bi] = cyW + (gy - cyW) * fEave;
            this.beadS[bi] = 0.45 + 0.75 * g;
            this.beadLit[bi] = this.rainLightAt(gx, gy);
          }
        }
      }
    }
  }

  /** 落点生成水花：落在积水处（积水遮罩 × 湿润度）为同心涟漪，否则为小环 + 弹溅微粒；池满即不生成 */
  private spawnRainSplash(x: number, y: number, wetness: number) {
    if (this.splashN >= SPLASH_MAX) return;
    const seed = this.rainRand();
    let kind = 0;
    if (!isPointInHideout(x, y)) {
      const puddle = this.samplePuddleAt(x, y);
      const activeWet = clamp(puddle * (0.28 + wetness * 0.95) + wetness * 0.16, 0, 1);
      if (activeWet > 0.42) kind = 1;
    }
    const i = this.splashN++;
    this.splashX[i] = x;
    this.splashY[i] = y;
    this.splashAge[i] = 0;
    this.splashLife[i] = kind === 1 ? 0.34 + seed * 0.16 : 0.12 + seed * 0.08;
    this.splashSeed[i] = seed;
    this.splashKind[i] = kind;
    this.splashCode[i] = 0;
  }

  /** 采样世界坐标处的积水遮罩（与法线缓冲 B 通道同源：基础 256 平铺 + 低频 384×GROUND_MACRO_SCALE 平铺），0..1 */
  private samplePuddleAt(x: number, y: number): number {
    let v = 0;
    const base = this.puddleBaseData;
    if (base && this.puddleBaseW > 0 && this.puddleBaseH > 0) {
      const w = this.puddleBaseW;
      const h = this.puddleBaseH;
      const ix = ((Math.floor(x) % w) + w) % w;
      const iy = ((Math.floor(y) % h) + h) % h;
      v += base[(iy * w + ix) * 4 + 2];
    }
    const mac = this.puddleMacroData;
    if (mac && this.puddleMacroW > 0 && this.puddleMacroH > 0) {
      const w = this.puddleMacroW;
      const h = this.puddleMacroH;
      const ix = ((Math.floor(x / GROUND_MACRO_SCALE) % w) + w) % w;
      const iy = ((Math.floor(y / GROUND_MACRO_SCALE) % h) + h) % h;
      v += mac[(iy * w + ix) * 4 + 2];
    }
    return Math.min(1, v / 255);
  }

  /**
   * 雨滴/水花是否被手电照亮：先做角度 + 距离快速剔除，再对本帧已算好的手电可见性多边形（polyScratch，
   * 由 renderShadowMasksAndLights / renderFallbackDarkness 调用 computeVisibilityPolygon 生成）做点在多边形内判定——
   * 只读复用现有遮挡结果：被树干/墙体挡住的雨丝不受光，光锥里的雨幕因此同样被树干“切开”。
   */
  private rainLitAt(x: number, y: number): boolean {
    if (!this.rainBeamOn) return false;
    const dx = x - this.rainBeamX;
    const dy = y - this.rainBeamY;
    const d2 = dx * dx + dy * dy;
    if (d2 > 450 * 450) return false;
    if (d2 < 1) return true;
    if (dx * this.rainBeamDX + dy * this.rainBeamDY <= this.rainBeamCos * Math.sqrt(d2)) return false;
    const poly = this.polyScratch;
    const n = poly.length;
    if (n < 3) return true;
    // 偶奇规则射线法（零分配）
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = poly[i];
      const pj = poly[j];
      if ((pi.y > y) !== (pj.y > y) && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
    }
    return inside;
  }

  /**
   * R3：雨滴/水花所在点的受光级（"光里才看见雨"）：2 = 手电可见性多边形内，或强光源（吊灯/篝火/火盆/照明弹）0.6·半径内；
   * 1 = 近身微光圈、弱光源（菌光）或强光源外圈（0.9·半径内）；0 = 仅环境光。
   * 灯光不做逐盏遮挡多边形（lampPolyScratch 每盏覆盖复用），以"光源与该点是否同在庇护所室内"近似墙体遮光。
   */
  private rainLightAt(x: number, y: number): number {
    if (this.rainLitAt(x, y)) return 2;
    if (this.rainLtN === 0) return 0;
    const inHide = isPointInHideout(x, y) ? 1 : 0;
    let lvl = 0;
    for (let i = 0; i < this.rainLtN; i++) {
      const dx = x - this.rainLtX[i];
      const dy = y - this.rainLtY[i];
      const d2 = dx * dx + dy * dy;
      const r2 = this.rainLtR2[i];
      if (d2 >= r2 || this.rainLtIn[i] !== inHide) continue;
      // (0.6 / 0.9)² ≈ 0.444
      if (this.rainLtStrong[i] === 1 && d2 < r2 * 0.444) return 2;
      lvl = 1;
    }
    return lvl;
  }

  /** 雨幕私有 PRNG（Mulberry32，状态为 32 位整数；重置时回到固定种子，保证同一帧重复渲染结果一致） */
  private rainRand(): number {
    const s = (this.rainSeed + 0x6d2b79f5) | 0;
    this.rainSeed = s;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  }

  /** 整数 → [0,1) 的确定性哈希（屋檐滴水槽位的位置/周期/相位抖动） */
  private hash01(n: number): number {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /**
   * 庇护所门窗木板缝隙透出的锐利条状漏光光束（随屋内发电机灯光轻微晃动）
   */
  private drawBarricadeLightSlits(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number
  ) {
    // ?v-cine=b：改为从木板缝隙透出的锐利窄条体积光（非等距、非等长、昼弱夜强）
    if (this.cineOn) {
      this.drawBarricadeLightShafts(ctx, engine, viewL, viewT, viewR, viewB);
      return;
    }
    const genLit = engine.generatorOn && engine.generatorFuel > 0;
    if (!genLit && engine.phase === 'night') return;
    if (
      viewR < HIDEOUT_RECT.x - 160 ||
      viewL > HIDEOUT_RECT.x + HIDEOUT_RECT.w + 160 ||
      viewB < HIDEOUT_RECT.y - 160 ||
      viewT > HIDEOUT_RECT.y + HIDEOUT_RECT.h + 160
    ) {
      return;
    }

    const sway = Math.sin(engine.simTime * 2.6) * 5;
    const flicker = genLit ? 0.88 + Math.sin(engine.simTime * 9.5) * 0.12 : 0.45;
    const beamLen = engine.phase === 'night' ? 128 : 88;
    const baseAlpha = (engine.phase === 'night' ? 0.24 : 0.13) * flicker;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const b of engine.world.barricades) {
      // 未封死的门洞不画木板缝隙光条（保留完整视野光锥）
      if (b.hp <= 0 && b.kind === 'door') continue;
      const cx = b.x + b.w * 0.5;
      const cy = b.y + b.h * 0.5;

      // 计算门窗朝向屋外的法线方向
      let nx = 0;
      let ny = 0;
      if (b.id === 'bar_north_win') ny = -1;
      else if (b.id === 'bar_south_door') ny = 1;
      else if (b.id === 'bar_west_win') nx = -1;
      else if (b.id === 'bar_east_door') nx = 1;
      else continue;

      const tx = -ny;
      const ty = nx;
      const slitOffsets = [-16, 0, 16];

      for (let s = 0; s < slitOffsets.length; s++) {
        const off = slitOffsets[s];
        const sx = cx + tx * off + nx * 6;
        const sy = cy + ty * off + ny * 6;
        const fan = (s - 1) * 26 + sway;
        const ex = sx + nx * beamLen + tx * fan;
        const ey = sy + ny * beamLen + ty * fan;

        const grad = ctx.createLinearGradient(sx, sy, ex, ey);
        if (genLit) {
          grad.addColorStop(0, `rgba(238, 188, 108, ${baseAlpha.toFixed(3)})`);
          grad.addColorStop(0.55, `rgba(196, 152, 86, ${(baseAlpha * 0.45).toFixed(3)})`);
          grad.addColorStop(1, 'rgba(180, 140, 80, 0)');
        } else {
          grad.addColorStop(0, `rgba(176, 188, 192, ${(baseAlpha * 0.8).toFixed(3)})`);
          grad.addColorStop(1, 'rgba(176, 188, 192, 0)');
        }

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(sx - tx * 2.2, sy - ty * 2.2);
        ctx.lineTo(sx + tx * 2.2, sy + ty * 2.2);
        ctx.lineTo(ex + tx * 11, ey + ty * 11);
        ctx.lineTo(ex - tx * 11, ey - ty * 11);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }

  /** 为门窗生成 2~4 条光缝：位置随机且带最小间距约束，宽度/长度/亮度各不相同；按 id 一次性缓存 */
  private getSlits(id: string): LightSlit[] {
    const cached = this.slitCache.get(id);
    if (cached) return cached;
    let seed = 7;
    for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
    const rng = createRng(seed);
    const count = SLIT_COUNT_BY_ID[id] ?? 3;
    const slits: LightSlit[] = [];
    let guard = 0;
    while (slits.length < count && guard++ < 60) {
      const offset = (rng() - 0.5) * 0.8;
      let ok = true;
      for (const s of slits) {
        if (Math.abs(s.offset - offset) < 0.13) ok = false;
      }
      if (!ok) continue;
      slits.push({
        offset,
        width0: 1.3 + rng() * 2.7,
        spread: 6 + rng() * 22,
        lenK: 0.5 + rng() * 0.5,
        intensity: 0.6 + rng() * 0.5,
        phase: rng() * 10,
      });
    }
    this.slitCache.set(id, slits);
    return slits;
  }

  /** 光束纵向衰减渐变：局部单位长度坐标 x ∈ [0,1]（绘制时 scale(len,1)），全部光束共享、只创建一次 */
  private getShaftGradient(ctx: CanvasRenderingContext2D): CanvasGradient {
    if (this.shaftGrad) return this.shaftGrad;
    const g = ctx.createLinearGradient(0, 0, 1, 0);
    g.addColorStop(0, 'rgba(240, 204, 132, 0)');
    g.addColorStop(0.035, 'rgba(240, 204, 132, 1)');
    g.addColorStop(0.18, 'rgba(232, 196, 128, 0.72)');
    g.addColorStop(0.4, 'rgba(218, 188, 128, 0.40)');
    g.addColorStop(0.65, 'rgba(204, 180, 130, 0.17)');
    g.addColorStop(0.86, 'rgba(196, 176, 132, 0.05)');
    g.addColorStop(1, 'rgba(196, 176, 132, 0)');
    this.shaftGrad = g;
    return g;
  }

  /**
   * ?v-cine=b：门窗木板缝隙透出的锐利窄条体积光（参考 ref_sheet_1 长条光）。
   * - 每个门窗 2~4 条，位置/宽度/长度/亮度各不相同（参数缓存，非等距非等长）
   * - 方向 = 室内吊灯 -> 缝隙 的投射方向（与门窗外法线混合），吊灯摆动带动光束摇曳
   * - 沿长度柔和衰减（共享渐变）+ 柔边光晕 + 沿光束漂移的浮尘
   * - 亮度跟随发电机电压抖动闪烁；白天大幅减弱，黄昏渐强，黑夜最明显
   * 只读 engine 状态（发电机/阶段/门窗 hp），不做任何室内外或碰撞判定。
   */
  private drawBarricadeLightShafts(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number
  ) {
    const genLit = engine.generatorOn && engine.generatorFuel > 0;
    if (!genLit) return; // 室内无灯则无光可漏
    if (
      viewR < HIDEOUT_RECT.x - 280 ||
      viewL > HIDEOUT_RECT.x + HIDEOUT_RECT.w + 280 ||
      viewB < HIDEOUT_RECT.y - 280 ||
      viewT > HIDEOUT_RECT.y + HIDEOUT_RECT.h + 280
    ) {
      return;
    }

    const t = engine.simTime;
    const night = this.getNightAmount(engine);
    // 收束门窗缝隙光为细腻克制的微光（白昼几乎不可见，黑夜轻柔外渗，杜绝“黄色大三角纸片”违和感）
    const phaseK = 0.04 + 0.34 * night;
    // 与 GPU 吊灯同源的发电机电压抖动（燃油 <16 时断续闪烁）
    const sputter =
      engine.generatorFuel < 16
        ? Math.sin(t * 24) > 0.35
          ? 0.32
          : 0.96
        : 0.96 + Math.sin(t * 7.2) * 0.04;
    const grad = this.getShaftGradient(ctx);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const b of engine.world.barricades) {
      // 未封死的门洞不画缝隙光
      if (b.hp <= 0 && b.kind === 'door') continue;
      let nx = 0;
      let ny = 0;
      if (b.id === 'bar_north_win') ny = -1;
      else if (b.id === 'bar_south_door') ny = 1;
      else if (b.id === 'bar_west_win') nx = -1;
      else if (b.id === 'bar_east_door') nx = 1;
      else continue;

      const tx = -ny;
      const ty = nx;
      const openLen = b.orientation === 'h' ? b.w : b.h;
      const cx = b.x + b.w * 0.5;
      const cy = b.y + b.h * 0.5;

      // 最近的室内吊灯（循环比较，无分配）
      let lampIdx = 0;
      let best = Infinity;
      for (let i = 0; i < SHELTER_LAMPS.length; i++) {
        const d = dist(SHELTER_LAMPS[i].x, SHELTER_LAMPS[i].y, cx, cy);
        if (d < best) {
          best = d;
          lampIdx = i;
        }
      }
      const lamp = SHELTER_LAMPS[lampIdx];
      // 吊灯摆动（两组错频正弦），带动所有光束角度轻微摇曳
      const lx = lamp.x + Math.sin(t * 1.35 + lampIdx * 2.1) * 7 + Math.sin(t * 2.9 + lampIdx) * 2.5;
      const ly = lamp.y + Math.cos(t * 1.1 + lampIdx * 1.3) * 4;
      // 木板越破损，缝越宽
      const broken = clamp(1 - b.hp / Math.max(1, b.maxHp), 0, 1);
      const slits = this.getSlits(b.id);

      for (let si = 0; si < slits.length; si++) {
        const s = slits[si];
        const sx = cx + tx * s.offset * openLen + nx * 5;
        const sy = cy + ty * s.offset * openLen + ny * 5;
        let dx = sx - lx;
        let dy = sy - ly;
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl;
        dy /= dl;
        let ddx = dx * 0.62 + nx * 0.38;
        let ddy = dy * 0.62 + ny * 0.38;
        // 过于掠射时向外法线收拢
        if (ddx * nx + ddy * ny < 0.5) {
          ddx = ddx * 0.5 + nx * 0.5;
          ddy = ddy * 0.5 + ny * 0.5;
        }
        const dn = Math.hypot(ddx, ddy) || 1;
        ddx /= dn;
        ddy /= dn;

        const flick = sputter * (0.86 + 0.08 * Math.sin(t * 9.5 + s.phase * 3) + 0.06 * Math.sin(t * 23 + s.phase * 7));
        const a = clamp(0.3 * phaseK * s.intensity * flick, 0, 0.5);
        if (a < 0.004) continue;
        const len = (110 + 140 * night) * s.lenK;
        const w0 = s.width0 * (1 + broken * 1.4);
        const w1 = w0 + s.spread * (0.6 + 0.4 * night);

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(Math.atan2(ddy, ddx));
        ctx.scale(len, 1);
        ctx.fillStyle = grad;
        // 柔边光晕
        ctx.globalAlpha = a * 0.36;
        ctx.beginPath();
        ctx.moveTo(0, -w0 * 1.2);
        ctx.lineTo(1, -w1);
        ctx.lineTo(1, w1);
        ctx.lineTo(0, w0 * 1.2);
        ctx.closePath();
        ctx.fill();
        // 锐利核心
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.moveTo(0, -w0 * 0.5);
        ctx.lineTo(1, -w1 * 0.5);
        ctx.lineTo(1, w1 * 0.5);
        ctx.lineTo(0, w0 * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // 沿光束缓慢漂移的浮尘（只在光束内可见）
        ctx.fillStyle = 'rgb(255, 228, 176)';
        for (let k = 0; k < 3; k++) {
          const u = (t * (0.045 + k * 0.017) + s.phase * 0.37 + k * 0.31) % 1;
          const prof = clamp(u / 0.06, 0, 1) * Math.pow(1 - u, 1.5);
          const lat = Math.sin(t * 0.8 + k * 2.1 + s.phase * 5) * 0.4 * (w0 + (w1 - w0) * u);
          const twinkle = 0.55 + 0.45 * Math.sin(t * 3.1 + k * 1.9 + s.phase);
          const ma = a * 1.5 * prof * twinkle;
          if (ma < 0.01) continue;
          const mx = sx + ddx * u * len - ddy * lat;
          const my = sy + ddy * u * len + ddx * lat;
          ctx.globalAlpha = clamp(ma, 0, 0.8);
          const ms = 1.0 + ((k + si) % 2) * 0.6;
          ctx.fillRect(mx - ms * 0.5, my - ms * 0.5, ms, ms);
        }
      }
    }
    ctx.globalAlpha = 1;
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
      const isTitle = engine.mode === 'title';
      const beamX = isTitle ? 0 : p.x;
      const beamY = isTitle ? HIDEOUT_RECT.y + HIDEOUT_RECT.h + 14 : p.y;
      computeVisibilityPolygon(engine.world, beamX, beamY, 440, this.polyScratch, p.angle, coneHalfRad);
      punch(beamX, beamY, 440, this.polyScratch, 0.97 * p.flickerVal);
    }

    if (engine.generatorOn && engine.generatorFuel > 0) {
      for (const lamp of SHELTER_LAMPS) {
        computeVisibilityPolygon(engine.world, lamp.x, lamp.y, 195, this.lampPolyScratch);
        punch(lamp.x, lamp.y, 195, this.lampPolyScratch, 0.95);
      }
    }

    // Canvas2D 回退同样照亮活篝火与庇护所火盆
    for (const fire of [
      { pos: HIDEOUT_BRAZIER_POS, r: 175 },
      { pos: CAMPFIRE_POS, r: 215 },
    ]) {
      computeVisibilityPolygon(engine.world, fire.pos.x, fire.pos.y, fire.r, this.lampPolyScratch);
      punch(fire.pos.x, fire.pos.y, fire.r, this.lampPolyScratch, 0.92);
    }

    for (const f of engine.flares) {
      const fr = 265 * clamp(f.life / 3, 0.2, 1);
      computeVisibilityPolygon(engine.world, f.x, f.y, fr, this.lampPolyScratch);
      punch(f.x, f.y, fr, this.lampPolyScratch, 0.97);
    }

    // R3：Canvas2D 回退同样照亮手持火把 / 地上火把 / 枪口火光
    const eqf = engine.equip;
    if (eqf.torchInHand && eqf.torchLight > 0.05) {
      const tr = TORCH_LIGHT.radius * (0.85 + 0.15 * eqf.torchLight);
      computeVisibilityPolygon(engine.world, this.uiTorchTipX, this.uiTorchTipY, tr, this.equipPolyScratch);
      punch(this.uiTorchTipX, this.uiTorchTipY, tr, this.equipPolyScratch, 0.9 * eqf.torchLight);
    }
    for (const gt of eqf.groundTorches) {
      if (!gt.active || gt.flameH < 0.05) continue;
      computeVisibilityPolygon(engine.world, gt.x, gt.y, TORCH_LIGHT.groundRadius, this.equipPolyScratch);
      punch(gt.x, gt.y, TORCH_LIGHT.groundRadius, this.equipPolyScratch, 0.86 * gt.flameH);
    }
    if (eqf.muzzleFlash > 0) {
      computeVisibilityPolygon(engine.world, eqf.muzzleX, eqf.muzzleY, TORCH_LIGHT.muzzleRadius, this.equipPolyScratch);
      punch(eqf.muzzleX, eqf.muzzleY, TORCH_LIGHT.muzzleRadius, this.equipPolyScratch, 0.95);
    }

    lctx.restore();
    ctx.drawImage(this.fallbackLightCanvas, 0, 0, W, H);
  }

  private isEnemyVisible(engine: GameEngine, e: Enemy, coneHalfRad: number): boolean {
    // 传统可见对照组（?v-vision=a）：始终渲染敌人
    if (Variants.val.vision === 'a') return true;

    const p = engine.player;
    const d = dist(p.x, p.y, e.x, e.y);

    // ④ 闪电劈照瞬间显形
    if (engine.weather.lightningFlash > 0.25 && d < 560) return true;

    // ② 玩家近身微光圈内（dist < 115 且有视线）
    if (d < 115 && hasLineOfSight(engine.world, p.x, p.y, e.x, e.y)) return true;

    // ① 玩家手电视野锥内（有射线视线）
    if (p.flashlightOn && p.flickerVal > 0.1 && d < 465) {
      const angToE = Math.atan2(e.y - p.y, e.x - p.x);
      if (
        Math.abs(angleDiff(p.angle, angToE)) <= coneHalfRad + 0.08 &&
        hasLineOfSight(engine.world, p.x, p.y, e.x, e.y)
      ) {
        return true;
      }
    }

    // ③ 室内吊灯 / 活篝火 / 火盆 / 照明弹照亮范围内且有视线
    if (engine.generatorOn && engine.generatorFuel > 0) {
      for (const lamp of SHELTER_LAMPS) {
        if (dist(lamp.x, lamp.y, e.x, e.y) < 210 && hasLineOfSight(engine.world, lamp.x, lamp.y, e.x, e.y)) {
          return true;
        }
      }
    }

    if (
      dist(HIDEOUT_BRAZIER_POS.x, HIDEOUT_BRAZIER_POS.y, e.x, e.y) < 185 &&
      hasLineOfSight(engine.world, HIDEOUT_BRAZIER_POS.x, HIDEOUT_BRAZIER_POS.y, e.x, e.y)
    ) {
      return true;
    }

    if (
      dist(CAMPFIRE_POS.x, CAMPFIRE_POS.y, e.x, e.y) < 220 &&
      hasLineOfSight(engine.world, CAMPFIRE_POS.x, CAMPFIRE_POS.y, e.x, e.y)
    ) {
      return true;
    }

    for (const f of engine.flares) {
      if (dist(f.x, f.y, e.x, e.y) < 265 && hasLineOfSight(engine.world, f.x, f.y, e.x, e.y)) {
        return true;
      }
    }

    // ⑤ R3：手持火把 / 地上火把的暖光圈内且有视线；枪口火光瞬间显形
    const eqv = engine.equip;
    if (eqv.torchInHand && eqv.torchLight > 0.1 && d < TORCH_LIGHT.revealRadius && hasLineOfSight(engine.world, p.x, p.y, e.x, e.y)) {
      return true;
    }
    for (const gt of eqv.groundTorches) {
      if (!gt.active || gt.flameH < 0.1) continue;
      if (dist(gt.x, gt.y, e.x, e.y) < TORCH_LIGHT.revealRadius && hasLineOfSight(engine.world, gt.x, gt.y, e.x, e.y)) {
        return true;
      }
    }
    if (eqv.muzzleFlash > 0 && d < 360 && hasLineOfSight(engine.world, p.x, p.y, e.x, e.y)) return true;

    // ⑥ 建筑室内灯具照亮显形
    if (isEnemyLitByBuildingLights(engine, e)) return true;

    // 盲区中的敌人本体完全隐藏（仅保留声波涟漪、挠门木屑与低吼）
    return false;
  }

  // --- Darkwood-Benchmark Player Silhouette: The Stranger（程序化骨骼姿态层） ---
  // 姿态层：idle 呼吸 / 行走·疾跑 / 搜刮·钉板·采集·加油 / 蓄力 / 轻重挥砍 / 闪避扑跃 / 受击 / 喘息
  // 全部权重读自 engine 的 player.pose / player.action（engine 内按时间平滑混合），渲染层不写任何游戏状态
  private drawArticulatedPlayer(ctx: CanvasRenderingContext2D, engine: GameEngine) {
    const p = engine.player;
    const pose = p.pose;
    const act = p.action;
    const t = engine.simTime;
    const isAxe = engine.inv.weaponTier === 2;

    const kind = pose.actionKind;
    const actW = kind !== 'none' ? clamp(pose.action, 0, 1) : 0;
    const actDur = act.duration > 0 ? act.duration : 1;
    const actProg = act.kind !== 'none' ? clamp(act.timer / actDur, 0, 1) : pose.actionProgress;
    const actTime = actProg * actDur;
    const moveW = pose.move;
    const sprintW = pose.sprint;
    const chargeW = pose.charge;
    const exhaustW = pose.exhaust * (1 - actW);
    const hurtW = clamp(pose.hurt / 0.32, 0, 1);
    const landW = clamp(pose.land / 0.22, 0, 1);
    const dodging = p.dodgeTimer > 0;
    const dodgeArc = dodging ? Math.sin(clamp(1 - p.dodgeTimer / 0.18, 0, 1) * Math.PI) : 0;
    const vaulting = p.vaultTimer > 0;
    const vaultProg = vaulting ? clamp(1 - p.vaultTimer / Math.max(0.01, p.vaultDur), 0, 1) : 0;
    const vaultArc = vaulting ? Math.sin(vaultProg * Math.PI) : 0;
    const fullCharge = p.isCharging && p.chargeTimer >= 0.65;

    // 1. 闪避残影（2–3 帧，按寿命淡出）
    for (let g = 0; g < 3; g++) {
      const life = pose.ghostLife[g];
      if (life <= 0) continue;
      const ga = (life / 0.2) * 0.26;
      ctx.save();
      ctx.translate(pose.ghostX[g], pose.ghostY[g]);
      ctx.rotate(pose.ghostA[g]);
      ctx.fillStyle = `rgba(34, 38, 30, ${ga.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(-1, 0, 9.5, 14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(78, 70, 54, ${(ga * 0.9).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(3, 0, 6.5, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 2. 运动学参数（R3：步态相位 pose.gait 由 engine 按真实位移推进，整数时刻 = 前脚落地帧，与 playFootstep 同步）
    const eqp = engine.equip;
    const improvedMotion = Variants.val.motion !== 'a';
    const gArm = gestureRightArm(eqp, this.eqArmScratch);
    const gHand = gestureLeftHand(eqp, this.eqHandScratch);
    const gCrouch = gestureCrouch(eqp);
    const gDip = gestureHeadDip(eqp);
    const gProg = gestureProgress(eqp);
    const pistolW = clamp(eqp.pistolW, 0, 1);
    // 持枪瞄准权重：疾跑时枪口下垂转为摆臂，限时交互时收枪
    const aimW = pistolW * (1 - sprintW * 0.75) * (1 - actW);
    const gaitPhase = Math.PI * pose.gait;
    const gaitW = moveW * (1 - actW * 0.9) * (1 - gCrouch * 0.7);
    const strideAmp = gaitW * (1 + sprintW * 0.45);
    // stride > 0：左脚（+y）在前 → 右臂前摆、左臂后摆（与双腿反向）
    const stride = Math.cos(gaitPhase) * strideAmp;
    const bob = Math.abs(Math.sin(gaitPhase)) * moveW * (1 - actW);
    const breathe = lerp(Math.sin(p.breathePhase) * 0.7, Math.sin(t * 7.6) * 1.8, exhaustW);
    const crouchK =
      kind === 'search' ? 1 : kind === 'harvest' ? 0.8 : kind === 'refuel' ? 0.35 : kind === 'barricade' ? 0.15 : 0;
    const crouch = Math.max(actW * crouchK, gCrouch);
    const harvestDip = kind === 'harvest' ? Math.sin(actProg * Math.PI) : 0;
    const hammerRaise = kind === 'barricade' ? this.hammerRaise(actTime, actDur) : 0;
    // 躯干前探量（局部 +x）：疾跑前倾（R3 加大，俯视可读跑姿）/ 交互前探 / 喘息弯腰 / 蓄力后仰 / 手势弯腰
    const lean =
      sprintW * 4.2 +
      actW * (kind === 'search' ? 3.5 : kind === 'harvest' ? 2 + harvestDip * 3 : 1.5) +
      exhaustW * 2.4 -
      chargeW * 2.8 +
      gCrouch * 2.5;
    const tremble = fullCharge ? Math.sin(t * 57) * 0.55 + Math.cos(t * 43) * 0.4 : 0;

    // 3. 根变换：受击后仰（沿受击方向）→ 闪避压扁拉伸（沿闪避方向）→ 朝向 → 蹲伏/落地屈膝缩放
    ctx.save();
    ctx.translate(p.x + Math.cos(pose.hurtAngle) * hurtW * 3.5, p.y + Math.sin(pose.hurtAngle) * hurtW * 3.5);

    // 接触阴影（不随压扁拉伸；闪避与翻窗腾空时缩小并后移，呈现真实离地高度）
    const shadowK = 1 - dodgeArc * 0.18 - vaultArc * 0.24 - crouch * 0.06;
    ctx.save();
    ctx.rotate(p.angle);
    ctx.fillStyle = `rgba(0, 0, 0, ${(0.48 - vaultArc * 0.18).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(-3 - vaultArc * 4, 2 + vaultArc * 3, 16 * shadowK, 19 * shadowK, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (dodging) {
      const da = Math.atan2(p.dodgeDirY, p.dodgeDirX);
      ctx.rotate(da);
      ctx.scale(1 + dodgeArc * 0.3, 1 - dodgeArc * 0.22);
      ctx.rotate(-da);
    }
    ctx.rotate(p.angle);
    const bodyK = (1 - crouch * 0.1 - landW * 0.06 - dodgeArc * 0.06) * (1 + vaultArc * 0.15);
    ctx.scale(bodyK * (1 + bob * 0.025 + vaultArc * 0.06), bodyK * (1 + breathe * 0.012 - vaultArc * 0.06));
    ctx.translate(tremble, tremble * 0.6);

    // 4. R3 俯视双腿（新增 Darkwood 翻窗跨腿姿态：前半段前脚跨过窗台、后脚蹬离，后半段收腿落地）
    const footSpread = lerp(5.8, 4.4, sprintW) + crouch * 1.8 + landW * 2.2 + exhaustW * 1.2 + vaultArc * 2.4;
    const footBack = -crouch * 3.5 - exhaustW * 1.5;
    const legReach = 10.5 + sprintW * 8;
    const legExt = Math.cos(gaitPhase) * gaitW;
    // 摆动相抬脚（左脚在 gait∈(1,2) 前摆，右脚在 gait∈(0,1) 前摆）
    const liftL = vaulting ? clamp(Math.sin(vaultProg * Math.PI * 1.2), 0, 1) : Math.max(0, -Math.sin(gaitPhase)) * gaitW;
    const liftR = vaulting ? clamp(Math.sin((vaultProg - 0.18) * Math.PI * 1.2), 0, 1) : Math.max(0, Math.sin(gaitPhase)) * gaitW;
    const fLx = vaulting ? lerp(-10, 16, clamp(vaultProg * 1.35, 0, 1)) : 1.5 + footBack + legExt * legReach;
    const fRx = vaulting ? lerp(-14, 10, clamp((vaultProg - 0.22) * 1.35, 0, 1)) : 1.5 + footBack - legExt * legReach;
    const footRot = 0.08 - crouch * 0.25 + vaultArc * 0.22;
    // 裤腿（髋 → 脚踝）：大腿根被大衣盖住，伸出轮廓的小腿与靴子可见
    ctx.strokeStyle = '#23271f';
    ctx.lineCap = 'round';
    ctx.lineWidth = 5.2;
    ctx.beginPath();
    ctx.moveTo(-1, footSpread * 0.7);
    ctx.lineTo(fLx - 2.5, footSpread);
    ctx.moveTo(-1, -footSpread * 0.7);
    ctx.lineTo(fRx - 2.5, -footSpread);
    ctx.stroke();
    this.drawBoot(ctx, fLx, footSpread, footRot, liftL);
    this.drawBoot(ctx, fRx, -footSpread, -footRot, liftR);

    // 5. 武器臂（战斗层）：严格对照《Darkwood》原作——无论行走还是疾跑，持火把右臂稳稳端举在右前方绝不挥动！
    const dirSign = p.swingDir;
    const steadyArmSway = stride * (0.025 + sprintW * 0.02);
    let armAngle = 0.24 - steadyArmSway;
    let torsoTwist = stride * (0.07 + sprintW * 0.09);
    // 蓄力：向下一刀的起手侧后拉（与挥砍起手角连续，松手不跳变）
    armAngle = lerp(armAngle, 1.28 * dirSign, chargeW);
    torsoTwist = lerp(torsoTwist, 0.32 * dirSign, chargeW);

    let trailFrom = 0;
    let trailTo = 0;
    let trailAlpha = 0;
    const heavySwing = isAxe ? p.swingDuration >= 0.4 : p.swingDuration >= 0.32;
    if (p.swingTimer > 0 && !p.isCharging) {
      const prog = 1 - p.swingTimer / p.swingDuration;
      const startA = -1.22 * dirSign;
      const endA = 1.12 * dirSign;
      if (prog < 0.22) {
        const k = prog / 0.22;
        // 重击承接蓄力架势，直接从起手角爆发
        armAngle = heavySwing ? startA : lerp(0.2, startA, k);
        torsoTwist = startA * 0.28 * (heavySwing ? 1 : k);
      } else if (prog < 0.72) {
        const k = (prog - 0.22) / 0.5;
        const ease = 1 - (1 - k) * (1 - k);
        armAngle = lerp(startA, endA, ease);
        torsoTwist = armAngle * 0.3;
        trailFrom = startA;
        trailTo = armAngle;
        trailAlpha = 1;
      } else {
        const k = (prog - 0.72) / 0.28;
        armAngle = lerp(endA, 0.25, this.animEase(k));
        torsoTwist = lerp(endA * 0.3, 0, k);
        trailFrom = startA;
        trailTo = endA;
        trailAlpha = 1 - k;
      }
    }

    // 6. 限时交互的手部目标（局部坐标），与战斗层按 actW 时间平滑混合
    const shRX = 3;
    const shRY = -10.5;
    const shLX = 2;
    const shLY = 10.5;
    let rhx = 14;
    let rhy = -8;
    let lhx = 13;
    let lhy = 8.2;
    let canTilt = 0;
    if (kind === 'search') {
      // 蹲下双手前伸交替翻找
      const ph = t * 10.5;
      rhx = 17 + Math.sin(ph) * 4;
      rhy = -6 + Math.cos(ph) * 2;
      lhx = 17 - Math.sin(ph) * 4;
      lhy = 6 + Math.cos(ph) * 2;
    } else if (kind === 'harvest') {
      // 弯腰前探摘取 → 收回
      if (actProg < 0.55) {
        const k = this.animEase(actProg / 0.55);
        rhx = lerp(10, 21, k);
        rhy = lerp(-7, -2, k);
      } else {
        const k = this.animEase((actProg - 0.55) / 0.45);
        rhx = lerp(21, 9, k);
        rhy = lerp(-2, -9, k);
      }
      lhx = 12;
      lhy = 7.5;
    } else if (kind === 'refuel') {
      // 双手托油桶倾倒
      rhx = 15;
      rhy = -4.5;
      lhx = 15;
      lhy = 4.5;
      canTilt = this.animEase(clamp(actProg / 0.25, 0, 1)) * 0.95;
      if (actProg > 0.25) canTilt += Math.sin(t * 14) * 0.05;
      if (actProg > 0.85) canTilt *= 1 - ((actProg - 0.85) / 0.15) * 0.8;
    } else if (kind === 'barricade') {
      // 左手按住木板与钉子，右手持锤
      lhx = 19;
      lhy = 5;
    }

    let rAng = armAngle;
    let rLen = 13;
    if (actW > 0.001) {
      let tAng = 0;
      let tLen = 13;
      if (kind === 'barricade') {
        // 举起时手臂回收过肩（俯视透视缩短），砸下时前伸
        tAng = lerp(0.15, -1.75, hammerRaise);
        tLen = lerp(14, 8, hammerRaise);
      } else {
        tAng = Math.atan2(rhy - shRY, rhx - shRX);
        tLen = Math.hypot(rhx - shRX, rhy - shRY);
      }
      rAng = lerp(rAng, tAng, actW);
      rLen = lerp(rLen, tLen, actW);
    }
    const exK = exhaustW * (1 - chargeW);
    if (exK > 0.001) {
      // 体力耗尽：弯腰双手扶膝喘息
      rAng = lerp(rAng, 0.34, exK);
      rLen = lerp(rLen, 8, exK);
    }
    // R3：持枪姿态（右手单手持枪前伸，后坐时手臂上扬回落）+ 装备手势覆盖（丢火把/拔枪/捡火把/放陷阱/换弹/缠布）
    if (aimW > 0.001) {
      rAng = lerp(rAng, 0.06 - eqp.recoil * 0.16, aimW);
      rLen = lerp(rLen, 16 - eqp.recoil * 4.5, aimW);
    }
    if (gArm.w > 0.001) {
      let ga = gArm.a;
      let gl = gArm.len;
      if (eqp.gesture === 'pickup') {
        // 弯腰探手：手伸向地上火把的实际位置（世界 → 局部）
        const dxw = eqp.gTargetX - p.x;
        const dyw = eqp.gTargetY - p.y;
        const cna = Math.cos(-p.angle);
        const sna = Math.sin(-p.angle);
        const tlx = cna * dxw - sna * dyw;
        const tly = sna * dxw + cna * dyw;
        ga = Math.atan2(tly - shRY, tlx - shRX);
        gl = clamp(Math.hypot(tlx - shRX, tly - shRY), 8, 21);
      }
      rAng = lerp(rAng, ga, gArm.w);
      rLen = lerp(rLen, gl, gArm.w);
    }
    // 严格还原原作：跑步持火把时不挥动右臂，仅保留极微小的步频前后颠簸
    const torchRunW = improvedMotion && eqp.torchInHand ? sprintW * (1 - actW) * (1 - gArm.w) * (1 - aimW) : 0;
    rAng += Math.sin(gaitPhase * 2) * 0.018 * torchRunW;
    rLen += Math.sin(gaitPhase * 2) * 0.45 * torchRunW;

    // 左臂（手电）：稳稳前指照亮前方，行走/疾跑时仅随步频轻度起伏，不向后乱甩
    let lX = clamp(12.8 - sprintW * 1.2 - stride * (0.9 + sprintW * 0.8), 8, 15) - chargeW * 2.5;
    let lY = 8.4 + chargeW * 1.0 + sprintW * 0.6;
    if (actW > 0.001) {
      lX = lerp(lX, lhx, actW);
      lY = lerp(lY, lhy, actW);
    }
    if (exK > 0.001) {
      lX = lerp(lX, 10, exK);
      lY = lerp(lY, 8, exK);
    }
    // R3：持枪时左手交叉托手电于右腕下方（手电仍在左手，光锥朝前）；投掷照明弹等手势覆盖
    if (aimW > 0.001) {
      lX = lerp(lX, 15 - eqp.recoil * 3.5, aimW);
      lY = lerp(lY, -1.5, aimW);
    }
    if (gHand.w > 0.001) {
      lX = lerp(lX, gHand.x, gHand.w);
      lY = lerp(lY, gHand.y, gHand.w);
    }

    const twist =
      torsoTwist * (1 - actW) +
      gArm.twist +
      (improvedMotion ? stride * sprintW * 0.06 * (1 - actW) : 0);
    const leanX = lean * 0.6;
    ctx.rotate(twist);
    ctx.translate(leanX, 0);

    // 7a. 拖尾大衣下摆（随步幅与疾跑翻飞）
    const hemK = moveW * (1 + sprintW * 0.6) + dodgeArc;
    ctx.fillStyle = p.hitFlash > 0 ? '#7c241e' : '#2a3024';
    ctx.strokeStyle = '#0e110c';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-4 - leanX * 0.5, -13);
    ctx.quadraticCurveTo(-15 - hemK * 4 - leanX, -9 - stride * 2.5, -14 - hemK * 3 - leanX, 0 - stride * 2);
    ctx.quadraticCurveTo(-15 - hemK * 4 - leanX, 9 - stride * 2.5, -4 - leanX * 0.5, 13);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 7b. 挥砍弧线拖影（爆发段多层笔触 + 收招段残留淡出）
    if (trailAlpha > 0.02) {
      const arcMin = Math.min(trailFrom, trailTo);
      const arcMax = Math.max(trailFrom, trailTo);
      const baseR = isAxe ? 44 : 36;
      const wMul = heavySwing ? 1.4 : 1;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = heavySwing
        ? `rgba(226, 170, 118, ${(0.34 * trailAlpha).toFixed(3)})`
        : isAxe
        ? `rgba(232, 206, 172, ${(0.32 * trailAlpha).toFixed(3)})`
        : `rgba(196, 160, 114, ${(0.26 * trailAlpha).toFixed(3)})`;
      ctx.lineWidth = (isAxe ? 14 : 9) * wMul;
      ctx.beginPath();
      ctx.arc(0, 0, baseR, arcMin, arcMax);
      ctx.stroke();
      // 刃口前缘亮线（只覆盖靠近当前刃位的一段，形成速度感）
      const lead = trailTo;
      const leadSpan = 0.42 * Math.sign(trailTo - trailFrom || 1);
      const la = Math.min(lead - leadSpan, lead);
      const lb = Math.max(lead - leadSpan, lead);
      ctx.strokeStyle = isAxe
        ? `rgba(248, 232, 206, ${(0.66 * trailAlpha).toFixed(3)})`
        : `rgba(224, 192, 146, ${(0.54 * trailAlpha).toFixed(3)})`;
      ctx.lineWidth = 2.6 * wMul;
      ctx.beginPath();
      ctx.arc(0, 0, baseR + 4, la, lb);
      ctx.stroke();
      ctx.restore();
    }

    // 7c. 加油：双手间的油桶（倾倒时前倾缩短 + 油流滴落）
    if (kind === 'refuel' && actW > 0.02) {
      ctx.save();
      ctx.globalAlpha = actW;
      ctx.translate(16 + canTilt * 3, 0);
      ctx.scale(1 - canTilt * 0.35, 1);
      ctx.fillStyle = '#6e2a1c';
      ctx.strokeStyle = '#1a0d08';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.roundRect(-5, -6, 10, 12, 1.5);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-3.5, -4.5);
      ctx.lineTo(3.5, 4.5);
      ctx.moveTo(3.5, -4.5);
      ctx.lineTo(-3.5, 4.5);
      ctx.stroke();
      ctx.strokeStyle = '#3a3a36';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(5, -3);
      ctx.lineTo(8 + canTilt * 2, -4);
      ctx.stroke();
      ctx.restore();
      if (canTilt > 0.55) {
        ctx.fillStyle = `rgba(52, 44, 30, ${(0.75 * actW).toFixed(3)})`;
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          const dx = 26 + ((t * 42 + k * 4) % 12);
          ctx.moveTo(dx + 0.9, -4);
          ctx.arc(dx, -4, 0.9, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }

    // 8. 右臂（武器手 / 锤手）：角度 + 臂长表示，便于各姿态连续混合
    ctx.save();
    ctx.translate(shRX, shRY);
    ctx.rotate(rAng);
    ctx.strokeStyle = '#3a4234';
    ctx.lineWidth = 5.6;
    ctx.lineCap = 'round';
    const rElbowX = rLen * 0.52;
    const rElbowY = 2 + stride * sprintW * 2.4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    if (improvedMotion) ctx.lineTo(rElbowX, rElbowY);
    ctx.lineTo(rLen, 2);
    ctx.stroke();
    ctx.fillStyle = '#241b14';
    ctx.beginPath();
    ctx.arc(rLen, 2, 3.2, 0, Math.PI * 2);
    ctx.fill();
    if (improvedMotion) {
      ctx.beginPath();
      ctx.arc(rElbowX, rElbowY, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 手中武器（R3：右手火把——木柄 + 浸油布头，Tier2 柄上绑锈斧头；手枪模式改为单手持枪）
    // 火把：搜刮/采摘时仍握在手中；钉板/加油需要双手时斜插在身侧地上（plantW），火焰位置随之连续过渡
    const plantW = kind === 'barricade' || kind === 'refuel' ? actW : 0;
    const torchShown = eqp.torchInHand && !(eqp.gesture === 'dropTorch' && eqp.gEventDone);
    const pistolShown =
      !torchShown && eqp.mode === 'pistol' && (eqp.gesture === 'draw' ? gProg > 0.5 : pistolW > 0.35);
    const torchA = torchShown ? 1 - plantW : 0;
    const pistolA = pistolShown ? 1 - actW : 0;
    if (torchA > 0.02) {
      ctx.save();
      ctx.globalAlpha = torchA;
      // 垂直向上的火把：俯视图下木棍完全被垂直投影遮挡，不可见木棍，只在右手握持正上方呈现圆顶炭头与火焰
      const tipX = rLen + 3.5;
      const tipY = 2;
      if (isAxe && p.swingTimer > 0.02) {
        // 仅在近战横挥瞬间短暂露出绑斧金属刃
        ctx.save();
        ctx.globalAlpha = torchA * clamp(p.swingTimer * 4, 0, 1);
        ctx.fillStyle = '#5d6263';
        ctx.strokeStyle = '#141717';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(tipX - 3, tipY - 1);
        ctx.lineTo(tipX + 4, tipY - 9);
        ctx.quadraticCurveTo(tipX + 8, tipY - 4, tipX + 6.5, tipY + 2);
        ctx.lineTo(tipX, tipY + 1.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      // 俯视火把顶端浸油布炭芯（圆形顶面，无水平木棍）
      ctx.fillStyle = eqp.torchLit ? '#36190d' : '#1b1612';
      ctx.strokeStyle = '#0d0a08';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (eqp.torchLit) {
        ctx.fillStyle = 'rgba(255, 134, 52, 0.88)';
        ctx.beginPath();
        ctx.arc(tipX, tipY, 1.9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (pistolA > 0.02) {
      // 手枪：握把在手心、套筒朝前；换弹时弹匣滑出下坠；枪口一帧火光
      ctx.save();
      ctx.globalAlpha = pistolA;
      ctx.translate(rLen, 2);
      ctx.fillStyle = '#1d1c1a';
      ctx.fillRect(-1.6, -2.2, 4.2, 4.6);
      ctx.fillStyle = '#2f302d';
      ctx.strokeStyle = '#090908';
      ctx.lineWidth = 1;
      ctx.fillRect(0, -1.8, 11.5, 3.4);
      ctx.strokeRect(0, -1.8, 11.5, 3.4);
      ctx.fillStyle = 'rgba(150, 152, 146, 0.5)';
      ctx.fillRect(1.2, -1.5, 9.4, 0.9);
      if (eqp.gesture === 'reload' && gProg > 0.2 && gProg < 0.62) {
        const k = (gProg - 0.2) / 0.42;
        ctx.globalAlpha = pistolA * (1 - k);
        ctx.fillStyle = '#26231f';
        ctx.fillRect(0.2, 2.4 + k * 9, 2.6, 4);
      }
      if (eqp.muzzleFlash > 0) {
        const mf = clamp(eqp.muzzleFlash / 0.05, 0, 1);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255, 214, 140, ${(0.9 * mf).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(11.5, -1);
        ctx.lineTo(24 + mf * 6, 0);
        ctx.lineTo(11.5, 1);
        ctx.lineTo(15, 5.5);
        ctx.lineTo(13.5, 0);
        ctx.lineTo(15, -5.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(255, 250, 225, ${mf.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(13.5, 0, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 钉板：手持羊角锤（砸下瞬间锤头微闪）
    if (kind === 'barricade' && actW > 0.02) {
      ctx.save();
      ctx.globalAlpha = actW;
      ctx.strokeStyle = '#5a3f27';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(rLen - 2, 2);
      ctx.lineTo(rLen + 12, 2);
      ctx.stroke();
      ctx.fillStyle = pose.hammerImpact > 0 ? '#9aa0a0' : '#55595a';
      ctx.strokeStyle = '#141616';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(rLen + 10, -3, 4.5, 10);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#3b3f40';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(rLen + 12, -3);
      ctx.quadraticCurveTo(rLen + 9, -6.5, rLen + 7.5, -5);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // 9. 左臂（持手电）：两段式肘部弯曲
    ctx.strokeStyle = '#384032';
    ctx.lineWidth = 5.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(shLX, shLY);
    ctx.quadraticCurveTo((shLX + lX) * 0.5 + 1, (shLY + lY) * 0.5 + 2.2, lX, lY);
    ctx.stroke();
    ctx.fillStyle = '#241b14';
    ctx.beginPath();
    ctx.arc(lX, lY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#333028';
    ctx.strokeStyle = '#11100d';
    ctx.lineWidth = 1.2;
    ctx.fillRect(lX - 2, lY - 2.6, 10, 4.8);
    ctx.strokeRect(lX - 2, lY - 2.6, 10, 4.8);
    ctx.fillStyle = '#8b7042';
    ctx.fillRect(lX + 6, lY - 3.4, 3, 6.4);
    if (p.flashlightOn) {
      ctx.fillStyle = Variants.val.light === 'b' ? '#fbe098' : '#d6ebff';
      ctx.fillRect(lX + 8.4, lY - 2.8, 2.4, 5.2);
    }
    // R3：左手手势道具——换弹时捏着新弹匣、投掷前握着点燃的照明弹
    if (eqp.gesture === 'reload' && gProg > 0.3 && gProg < 0.8) {
      ctx.fillStyle = '#26231f';
      ctx.fillRect(lX - 1.5, lY - 4.5, 2.8, 4.2);
    } else if (eqp.gesture === 'throwFlare' && gProg < 0.5) {
      ctx.fillStyle = '#b93424';
      ctx.fillRect(lX - 3, lY + 1.8, 8, 3);
      ctx.fillStyle = '#ffd194';
      ctx.beginPath();
      ctx.arc(lX + 5.5, lY + 3.3, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // 10. 背包 + 卷起的帆布铺盖 + 水壶
    ctx.fillStyle = '#4e3927';
    ctx.strokeStyle = '#15100b';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.roundRect(-14.5, -10, 9.5, 20, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#6f6551';
    ctx.fillRect(-13.5, -11.5, 4.5, 23);
    ctx.strokeRect(-13.5, -11.5, 4.5, 23);
    ctx.fillStyle = '#646c64';
    ctx.beginPath();
    ctx.arc(-11, 11.5, 2.8, 0, Math.PI * 2);
    ctx.fill();

    // R3：钉板/加油需要双手时，火把垂直插在右前方地上（俯视仅见炭顶与垂直火焰，不露长木柄）
    if (torchShown && plantW > 0.02) {
      ctx.save();
      ctx.globalAlpha = plantW;
      ctx.fillStyle = eqp.torchLit ? '#36190d' : '#1b1612';
      ctx.strokeStyle = '#0d0a08';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(8.4, -21.6, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (eqp.torchLit) {
        ctx.fillStyle = 'rgba(255, 134, 52, 0.88)';
        ctx.beginPath();
        ctx.arc(8.4, -21.6, 1.9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    // R3：右胯枪套（枪不在手中时露出握把）
    ctx.fillStyle = '#2b241c';
    ctx.fillRect(-6.5, -14.6, 7, 3.6);
    if (!pistolShown || pistolA < 0.5) {
      ctx.fillStyle = '#3c3d3a';
      ctx.fillRect(-8.2, -14.2, 3, 2.6);
    }

    // 11. Darkwood 主角外乡人厚重灰褐长风衣双肩（对标原版截图 4 特写：柔和立体体积渐变 + 自然垂坠衣褶）
    const hunch = exhaustW * 1.2;
    const coatGrad = ctx.createRadialGradient(2, -1, 2, -2, 0, 18);
    if (p.hitFlash > 0) {
      coatGrad.addColorStop(0, '#a64238');
      coatGrad.addColorStop(1, '#581c18');
    } else {
      coatGrad.addColorStop(0, '#6a6558');
      coatGrad.addColorStop(0.55, '#46453c');
      coatGrad.addColorStop(1, '#242520');
    }
    ctx.fillStyle = coatGrad;
    ctx.strokeStyle = 'rgba(12, 13, 11, 0.88)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(7 + breathe * 0.4, -12.2 + hunch);
    ctx.quadraticCurveTo(10.5, 0, 7 + breathe * 0.4, 12.2 - hunch);
    ctx.quadraticCurveTo(0, 16.8, -7.5, 13.2);
    ctx.quadraticCurveTo(-11.2 - vaultArc * 3, 0, -7.5, -13.2);
    ctx.quadraticCurveTo(0, -16.8, 7 + breathe * 0.4, -12.2 + hunch);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 风衣肩部自然折痕与垂坠暗线
    ctx.strokeStyle = 'rgba(16, 16, 14, 0.42)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-6, -9.5);
    ctx.quadraticCurveTo(0, -7.5, 5.5, -9);
    ctx.moveTo(-6, 9.5);
    ctx.quadraticCurveTo(0, 7.5, 5.5, 9);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(204, 194, 172, 0.24)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(1, 0, 11, -1.05, 1.05);
    ctx.stroke();

    // 12. Darkwood 外乡人标志性多层折痕宽檐旧软帽/兜帽（直击原版截图 1, 2, 3, 4, 8, 10 经典顶视圆帽剪影！）
    const headX =
      crouch * 2 + exhaustW * 2.6 + sprintW * 2.4 - chargeW * 1.2 + actW * (harvestDip * 1.5 - hammerRaise * 1.2) +
      gDip * 2.4 + vaultArc * 2.2;
    ctx.save();
    ctx.translate(headX + 1, 0);
    // 帽檐柔和投影
    ctx.fillStyle = 'rgba(8, 8, 7, 0.52)';
    ctx.beginPath();
    ctx.ellipse(-1.2, 1.2, 10.6, 10.2, 0, 0, Math.PI * 2);
    ctx.fill();
    // 外层宽帽檐（深灰褐做旧绒布）
    const brimGrad = ctx.createRadialGradient(2.2, -1.2, 2, 0, 0, 10.4);
    if (p.hitFlash > 0) {
      brimGrad.addColorStop(0, '#b85044');
      brimGrad.addColorStop(1, '#541e19');
    } else {
      brimGrad.addColorStop(0, '#786c57');
      brimGrad.addColorStop(0.62, '#4a4337');
      brimGrad.addColorStop(1, '#221f1a');
    }
    ctx.fillStyle = brimGrad;
    ctx.strokeStyle = '#11100d';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, 10.2, 9.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 中层帽冠折环（截图中标志性的圆环层次）
    ctx.strokeStyle = 'rgba(20, 18, 14, 0.62)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(0.4, 0, 6.8, 6.4, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 帽顶受光旧布暖灰高光圆顶
    const crownGrad = ctx.createRadialGradient(1.2, -0.6, 0.8, 0.4, 0, 6.4);
    crownGrad.addColorStop(0, '#c6b490');
    crownGrad.addColorStop(0.55, '#86785e');
    crownGrad.addColorStop(1, '#3d362b');
    ctx.fillStyle = crownGrad;
    ctx.beginPath();
    ctx.ellipse(0.4, 0, 6.0, 5.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // 帽顶中心标志性小凹槽折纹（对标截图 4 高清特写）
    ctx.strokeStyle = 'rgba(34, 28, 20, 0.58)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0.6, 0, 2.6, 2.2, 0.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(226, 212, 180, 0.42)';
    ctx.beginPath();
    ctx.arc(1.2, -0.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.restore();

    // 13. 缓存武器端世界坐标（仅渲染层自用，供覆盖层蓄力细弧使用；不写游戏状态）
    const tipR = rLen - 13 + (isAxe ? 42 : 32);
    const tlx = shRX + Math.cos(rAng) * tipR - Math.sin(rAng) * 2;
    const tly = shRY + Math.sin(rAng) * tipR + Math.cos(rAng) * 2;
    const qx = Math.cos(twist) * (tlx + leanX) - Math.sin(twist) * tly;
    const qy = Math.sin(twist) * (tlx + leanX) + Math.cos(twist) * tly;
    const ca = Math.cos(p.angle);
    const sa = Math.sin(p.angle);
    this.uiWeaponTipX = p.x + (ca * qx - sa * qy) * bodyK;
    this.uiWeaponTipY = p.y + (sa * qx + ca * qy) * bodyK;

    // 13b. 垂直火把头世界坐标（就在右手握持上方 ⇄ 垂直插地连续过渡）→ 绘制俯视物理火焰；同一坐标供本帧火把点光源使用
    if (torchShown) {
      const hr = rLen + 3.5;
      const hlx = lerp(shRX + Math.cos(rAng) * hr - Math.sin(rAng) * 2, 8.4, plantW);
      const hly = lerp(shRY + Math.sin(rAng) * hr + Math.cos(rAng) * 2, -21.6, plantW);
      const hqx = Math.cos(twist) * (hlx + leanX) - Math.sin(twist) * hly;
      const hqy = Math.sin(twist) * (hlx + leanX) + Math.cos(twist) * hly;
      this.uiTorchTipX = p.x + (ca * hqx - sa * hqy) * bodyK;
      this.uiTorchTipY = p.y + (sa * hqx + ca * hqy) * bodyK;
      if (eqp.flameH > 0.02) {
        // 插地时火焰回到竖直燃烧（惯性偏移按 plantW 衰减）
        const fk = 1 - plantW * 0.7;
        this.drawTorchFlame(ctx, this.uiTorchTipX, this.uiTorchTipY, eqp.flameX * fk, eqp.flameY * fk, eqp.flameH, t, 1.7, eqp.rainExposure, 1);
      }
    } else {
      this.uiTorchTipX = p.x;
      this.uiTorchTipY = p.y;
    }

    // 14. 体力低时口鼻前低垂飘散的呼吸白雾（仅雨天/夜晚，极淡）
    const lowSt = clamp((32 - p.stamina) / 32, 0, 1);
    const fogK = Math.max(pose.exhaust, lowSt * 0.6);
    if (fogK > 0.04 && (engine.weather.rainIntensity > 0.15 || engine.phase === 'night')) {
      const wx = Math.cos(engine.weather.windAngle);
      const wy = Math.sin(engine.weather.windAngle);
      for (let k = 0; k < 3; k++) {
        const cyc = (t * (0.8 + pose.exhaust * 0.9) + k / 3) % 1;
        const d = 11 + cyc * 13;
        const fx = p.x + ca * d + wx * cyc * 6;
        const fy = p.y + sa * d + wy * cyc * 6 + cyc * 3;
        const a = fogK * 0.11 * Math.sin(cyc * Math.PI);
        ctx.fillStyle = `rgba(214, 222, 224, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(fx, fy, 2.5 + cyc * 5.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // --- Darkwood-Benchmark Monster Silhouettes（程序化动画：速度驱动步态 / 窥伺伏低 / 攻击前摇 / 扑击 / 抓挠门板 / 受击抽搐 / 死亡倒地） ---
  // 只读 engine 的 Enemy 状态（walkPhase / windup / lunge / crouch / clawPhase / clawSide / hitFlash）
  private drawArticulatedEnemy(
    ctx: CanvasRenderingContext2D,
    e: Enemy,
    time: number,
    dyingTime = -1,
    fallSide = 1
  ) {
    const dying = dyingTime >= 0;
    const fall = dying ? this.animEase(clamp(dyingTime / 0.45, 0, 1)) : 0;
    const alive = 1 - fall;
    const spdN = dying ? 0 : clamp(Math.hypot(e.vx, e.vy) / Math.max(1, e.speed), 0, 1.4);
    const gaitAmp = Math.max(0.18, Math.min(1.2, spdN * 1.15)) * alive;
    const stride = Math.sin(e.walkPhase) * gaitAmp;
    const wind = e.windup > 0 && e.windupDur > 0 ? clamp(1 - e.windup / e.windupDur, 0, 1) : 0;
    const windE = this.animEase(wind) * alive;
    const lungeW = clamp(e.lunge / 0.2, 0, 1) * alive;
    const crouch = clamp(e.crouch, 0, 1) * alive;
    const scratching = !dying && e.state === 'attack_barricade';
    const flash = e.hitFlash > 0;
    const jerk = e.hitFlash > 0 ? Math.sin(time * 61 + e.id * 1.7) * clamp(e.hitFlash / 0.3, 0, 1) : 0;
    const twitch =
      (Math.sin(time * 19 + e.id * 2.3) * 2.8 + Math.sin(time * 71 + e.id) * 1.3 * windE) * alive + jerk * 2.2;
    // 左(-y)/右(+y)臂伸展：扑击（clawSide 侧为主）+ 抓挠门板（双臂交替）- 前摇收拢后拉 + 扑击前冲
    const scrR = scratching ? Math.max(0, Math.sin(time * 12.5 + e.id)) : 0;
    const scrL = scratching ? Math.max(0, Math.sin(time * 12.5 + e.id + Math.PI)) : 0;
    const hitR = e.clawPhase * (e.clawSide === 1 ? 1 : 0.35);
    const hitL = e.clawPhase * (e.clawSide === -1 ? 1 : 0.35);
    const reachR = ((hitR * 10 + scrR * 7) * (1 - windE) - windE * 6 + lungeW * 5) * alive;
    const reachL = ((hitL * 10 + scrL * 7) * (1 - windE) - windE * 6 + lungeW * 5) * alive;
    const spread = windE * 5 - crouch * 3;
    const clawLunge = Math.max(e.clawPhase, lungeW) * 10 * alive;

    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(e.angle);

    // 接触阴影
    ctx.fillStyle = 'rgba(0, 0, 0, 0.50)';
    ctx.beginPath();
    ctx.ellipse(
      -2 - windE * 2 + lungeW * 3,
      2,
      e.r * (1.18 + lungeW * 0.15 + fall * 0.2),
      e.r * (0.98 + crouch * 0.1 + fall * 0.25),
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();

    // 姿态根变换：前摇后仰蓄势 / 扑击前冲拉伸 / 窥伺伏低压扁 / 受击抽搐 / 倒地侧翻
    ctx.translate(-windE * 5 + lungeW * 6 + jerk * 1.6, jerk * 1.2);
    ctx.rotate(jerk * 0.12 + fallSide * fall * 0.95);
    ctx.scale(
      1 + lungeW * 0.14 - windE * 0.1 - crouch * 0.05 - fall * 0.1,
      1 - lungeW * 0.08 + windE * 0.07 + crouch * 0.12 + fall * 0.2
    );

    if (e.kind === 'hound') {
      // --- SAVAGE RABID HOUND ---
      const tailW = twitch * (1 - crouch * 0.7);
      ctx.strokeStyle = flash ? '#b84239' : '#261a16';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-14, 0);
      ctx.quadraticCurveTo(-21, tailW * 1.6 + stride * 2, -26 + windE * 3, -tailW * 1.4);
      ctx.stroke();

      // 四足对角小跑步态（左后+右前 / 右后+左前 交替）；伏低/前摇时四肢外撇、前爪前探撑地
      const legOut = crouch * 3 + Math.max(0, spread) * 0.4;
      ctx.strokeStyle = flash ? '#b84239' : '#291c18';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(-7, -6);
      ctx.lineTo(-12 - stride * 6.5 - windE * 2, -12.5 - legOut);
      ctx.moveTo(-7, 6);
      ctx.lineTo(-12 + stride * 6.5 - windE * 2, 12.5 + legOut);
      ctx.moveTo(6, -6.5);
      ctx.lineTo(13 + stride * 6.5 + reachL * 0.5 + windE * 3, -11 - legOut);
      ctx.moveTo(6, 6.5);
      ctx.lineTo(13 - stride * 6.5 + reachR * 0.5 + windE * 3, 11 + legOut);
      ctx.stroke();

      // 瘦削躯干
      ctx.fillStyle = flash ? '#b84239' : '#3b2821';
      ctx.strokeStyle = '#100a08';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, -7.5);
      ctx.quadraticCurveTo(4, -10.5, -3, -7);
      ctx.quadraticCurveTo(-11, -5.2, -16, -6.5);
      ctx.quadraticCurveTo(-18, stride * 1.2, -16, 6.5);
      ctx.quadraticCurveTo(-11, 5.2, -3, 7);
      ctx.quadraticCurveTo(4, 10.5, 12, 7.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = 'rgba(186, 162, 134, 0.34)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-13, 0);
      ctx.lineTo(7, 0);
      ctx.moveTo(-7, -5.2);
      ctx.lineTo(-8.5, 5.2);
      ctx.moveTo(-3, -5.2);
      ctx.lineTo(-4.5, 5.2);
      ctx.moveTo(1, -5.2);
      ctx.lineTo(-0.5, 5.2);
      ctx.stroke();

      // 头部：前摇时缩颈后拉、扑击时前探；下颌随扑咬张合
      ctx.save();
      ctx.translate(-windE * 2.2 + lungeW * 2, twitch * 0.15);
      const jawOpen = clawLunge * 0.35 + windE * 1.5;
      ctx.fillStyle = '#6c1614';
      ctx.beginPath();
      ctx.ellipse(17 + jawOpen * 0.4, 0, 5.5 + jawOpen * 0.3, 3.6 + jawOpen * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e7dec4';
      ctx.fillRect(19 + jawOpen * 0.4, -2.8, 2.2, 1.5);
      ctx.fillRect(19 + jawOpen * 0.4, 1.3, 2.2, 1.5);
      ctx.fillStyle = flash ? '#c85046' : '#2d1e19';
      ctx.strokeStyle = '#0e0908';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(19, -3.5);
      ctx.lineTo(10, -6.8);
      ctx.lineTo(6 - crouch * 2, -11.5 + crouch * 2);
      ctx.lineTo(9, -3);
      ctx.lineTo(9, 3);
      ctx.lineTo(6 - crouch * 2, 11.5 - crouch * 2);
      ctx.lineTo(10, 6.8);
      ctx.lineTo(19, 3.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = windE > 0.2 ? '#fff2c8' : '#f4e4b2';
      ctx.fillRect(12.5, -3.8, 2.8, 2.1);
      ctx.fillRect(12.5, 1.7, 2.8, 2.1);
      ctx.restore();
    } else if (e.kind === 'banshee') {
      // --- ROOT-WEEPING BANSHEE ---
      ctx.strokeStyle = flash ? '#b84239' : '#1b1511';
      ctx.lineCap = 'round';
      // 身后拖曳的根须触手：按 walkPhase 交替波动
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (let k = -1; k <= 1; k++) {
        const wv = Math.sin(e.walkPhase + k * 2.1) * 4.5 * gaitAmp;
        const wv2 = Math.sin(e.walkPhase * 1.3 + k * 1.4) * 5 * gaitAmp;
        ctx.moveTo(-10, k * 5);
        ctx.quadraticCurveTo(-18, k * 8 + wv, -27 - gaitAmp * 3, k * 11 + wv2);
      }
      ctx.stroke();
      for (let side = -1; side <= 1; side += 2) {
        const reach = side === 1 ? reachR : reachL;
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(-4, side * 6);
        ctx.quadraticCurveTo(-15, side * (16 + twitch * 0.5 + spread), -24, side * (22 + twitch + spread));
        ctx.moveTo(-12, side * 13);
        ctx.lineTo(-22, side * 10);
        ctx.stroke();

        // 两对扭曲枝爪臂：步态交替摆动，前摇外张后拉，扑击/刮擦前伸
        const elbowX = 8 + stride * 3.5 * side - windE * 3;
        const elbowY = side * (15 + twitch * 0.55 + spread);
        const handX = 22 + reach + Math.cos(time * 8 + side) * 3 * alive;
        const handY = side * (17 - reach * 0.45 + twitch + spread * 1.4);
        ctx.lineWidth = 3.6;
        ctx.beginPath();
        ctx.moveTo(1, side * 9);
        ctx.lineTo(elbowX, elbowY);
        ctx.lineTo(handX, handY);
        ctx.stroke();
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(handX, handY);
        ctx.lineTo(handX + 7, handY - side * 4);
        ctx.moveTo(handX, handY);
        ctx.lineTo(handX + 8, handY + side * 2);
        ctx.stroke();
      }

      // 根须女妖周身暗影黑雾环绕与环飞黑羽微粒（Darkwood Banshee 压迫氛围）
      if (alive > 0.2) {
        const mistG = ctx.createRadialGradient(0, 0, 6, 0, 0, 32);
        mistG.addColorStop(0, 'rgba(6, 7, 7, 0.52)');
        mistG.addColorStop(0.65, 'rgba(10, 12, 12, 0.22)');
        mistG.addColorStop(1, 'rgba(8, 10, 10, 0)');
        ctx.fillStyle = mistG;
        ctx.beginPath();
        ctx.arc(0, 0, 32, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(9, 10, 10, 0.72)';
        for (let f = 0; f < 4; f++) {
          const fa = time * 1.9 + f * 1.57 + e.id;
          const fr = 19 + Math.sin(time * 3.1 + f * 2) * 5;
          ctx.beginPath();
          ctx.ellipse(Math.cos(fa) * fr, Math.sin(fa) * fr, 3.2, 1.3, fa + 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.save();
      ctx.translate(-1, 0);
      if (Variants.val.creature !== 'a') ctx.rotate(Math.sin(time * 2.2 + e.id) * 0.08 + stride * 0.07);
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
      ctx.restore();

      ctx.save();
      ctx.translate(-windE * 2 + lungeW * 2, 0);
      if (Variants.val.creature === 'a') {
        ctx.fillStyle = '#2d241d';
        ctx.beginPath();
        ctx.ellipse(5, 0, 8.5, 7.5, 0, 0, Math.PI * 2);
        ctx.fill();
        const glow = (0.72 + Math.sin(time * 6 + e.id) * 0.28) * (dying ? alive : 1) + windE * 0.25;
        ctx.fillStyle = `rgba(242, 106, 68, ${clamp(glow, 0, 1).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(9.5, -4.2, 2.3, 0, Math.PI * 2);
        ctx.moveTo(11.8, 4.2);
        ctx.arc(9.5, 4.2, 2.3, 0, Math.PI * 2);
        ctx.moveTo(7.7, 0.5);
        ctx.arc(6.2, 0.5, 1.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.rotate(Math.sin(time * 3.1 + e.id) * 0.07 + twitch * 0.025);
        const bloomOpen = clamp(0.18 + windE * 0.5 + lungeW * 0.55 + clawLunge * 0.012, 0, 1);
        ctx.translate(7, 0);
        for (let petal = 0; petal < 5; petal++) {
          ctx.save();
          ctx.rotate((petal * Math.PI * 2) / 5 + Math.sin(time * 1.7 + e.id + petal) * 0.05);
          ctx.fillStyle = flash ? '#9e3129' : petal % 2 === 0 ? '#3d3024' : '#29261d';
          ctx.strokeStyle = '#110e0b';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(5 + bloomOpen * 2, -3.2, 9 + bloomOpen * 5, 0);
          ctx.quadraticCurveTo(5 + bloomOpen * 2, 3.2, 0, 0);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.strokeStyle = 'rgba(177, 115, 77, 0.36)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(1, 0);
          ctx.lineTo(7 + bloomOpen * 2, 0);
          ctx.stroke();
          ctx.restore();
        }
        ctx.fillStyle = '#120a08';
        ctx.beginPath();
        ctx.ellipse(0, 0, 3.2 + bloomOpen * 2.5, 2.4 + bloomOpen * 1.5, 0, 0, Math.PI * 2);
        ctx.fill();
        const glow = (0.72 + Math.sin(time * 6 + e.id) * 0.28) * (dying ? alive : 1) + windE * 0.25;
        ctx.fillStyle = `rgba(242, 106, 68, ${clamp(glow, 0, 1).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(0, -0.8, 1.05, 0, Math.PI * 2);
        ctx.moveTo(1.05, 0.8);
        ctx.arc(0, 0.8, 1.05, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else {
      // --- TWISTED STALKER / CHOMPER ---
      // 褴褛衣摆下交替迈出的双足
      ctx.fillStyle = '#121310';
      ctx.beginPath();
      ctx.ellipse(stride * 5 - 2, -6.5 - crouch * 1.5, 4.2, 2.6, 0, 0, Math.PI * 2);
      ctx.moveTo(-stride * 5 - 2 + 4.2, 6.5 + crouch * 1.5);
      ctx.ellipse(-stride * 5 - 2, 6.5 + crouch * 1.5, 4.2, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = flash ? '#942e27' : '#1b1f1a';
      ctx.beginPath();
      ctx.moveTo(-6, -12);
      ctx.lineTo(-17, -9 + stride * 2);
      ctx.lineTo(-13, 0);
      ctx.lineTo(-19, 8 - stride * 2);
      ctx.lineTo(-6, 12);
      ctx.closePath();
      ctx.fill();

      // 不对称两段长臂：步态交替摆动；前摇外张后拉；扑击/抓挠门板双臂交替前伸
      ctx.lineCap = 'round';
      for (let side = -1; side <= 1; side += 2) {
        const reach = side === 1 ? reachR : reachL;
        const reachBias = side === 1 ? 1.15 : 0.92;
        const elbowX = 6 + stride * 4 * side - windE * 4 - crouch * 2;
        const elbowY = side * (13 * reachBias + spread);
        const clawX = (18 + reach + stride * 4.5 * side) * reachBias - crouch * 3;
        const clawY = side * (13.5 - reach * 0.4 + twitch * 0.8 + spread * 1.3);
        ctx.strokeStyle = flash ? '#b84239' : '#2a2e28';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(1, side * 9);
        ctx.lineTo(elbowX, elbowY);
        ctx.lineTo(clawX, clawY);
        ctx.stroke();
        ctx.strokeStyle = '#b4ab94';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(clawX, clawY);
        ctx.lineTo(clawX + 5.5, clawY - side * 3);
        ctx.moveTo(clawX, clawY);
        ctx.lineTo(clawX + 6, clawY + side * 1.5);
        ctx.stroke();
      }

      // 腐朽躯干体积明暗 + 外露佝偻脊椎骨节
      const stGrad = ctx.createRadialGradient(2, -1, 2, -1, 1, 16);
      if (flash) {
        stGrad.addColorStop(0, '#c84b40');
        stGrad.addColorStop(1, '#681d18');
      } else {
        stGrad.addColorStop(0, '#3a3e35');
        stGrad.addColorStop(0.6, '#232721');
        stGrad.addColorStop(1, '#111310');
      }
      ctx.fillStyle = stGrad;
      ctx.strokeStyle = '#0b0c0b';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.ellipse(-1, 0.8, 12.5, 15.2, 0.12 + stride * 0.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 脊柱凸起骨节与干涸污血斑
      ctx.fillStyle = 'rgba(156, 148, 130, 0.34)';
      for (let v = -8; v <= 2; v += 3.5) {
        ctx.beginPath();
        ctx.ellipse(v, 0.6 + stride * 0.4, 1.4, 2.1, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(88, 16, 15, 0.72)';
      ctx.beginPath();
      ctx.ellipse(3, -5, 5.2, 4.1, 0.4, 0, Math.PI * 2);
      ctx.fill();

      // Darkwood 标志性 Chomper 裂颚头骨：常态痉挛抽搐，前摇与扑咬瞬间头颅撕裂成血红花瓣巨口！
      const mawSplit = clamp(windE * 0.9 + lungeW * 1.1 + clawLunge * 0.04, 0, 1);
      ctx.save();
      ctx.translate(6.5 - windE * 2.5 + lungeW * 3.0 - crouch * 1.5, twitch * 0.4);
      ctx.rotate(twitch * 0.1);
      if (mawSplit > 0.16) {
        // 裂开的四瓣血红颚骨 + 惨白利齿
        ctx.fillStyle = '#5e1010';
        ctx.strokeStyle = '#120808';
        ctx.lineWidth = 1.4;
        for (let side = -1; side <= 1; side += 2) {
          ctx.save();
          ctx.rotate(side * (0.28 + mawSplit * 0.55));
          ctx.beginPath();
          ctx.ellipse(2.5, side * 1.2, 7.8, 3.6, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          // 锯齿状惨白尖牙
          ctx.fillStyle = '#ede3c8';
          for (let t = 2; t <= 7; t += 2.3) {
            ctx.fillRect(t, side * -1.4, 1.5, 1.4);
          }
          ctx.fillStyle = '#5e1010';
          ctx.restore();
        }
        ctx.fillStyle = '#240505';
        ctx.beginPath();
        ctx.ellipse(4.5, 0, 4.2, 3.2 * mawSplit, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#625e52';
        ctx.strokeStyle = '#121310';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(0, 0, 7.6, 6.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#310d0c';
        ctx.beginPath();
        ctx.ellipse(5.4, 0, 3.2, 2.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#efe7cb';
        ctx.fillRect(2.2, -3.8, 2.4, 1.9);
        ctx.fillRect(2.2, 1.9, 2.4, 1.9);
      }
      ctx.restore();
    }

    ctx.restore();

    if (!dying && e.hp < e.maxHp) {
      const bw = 28;
      const ratio = clamp(e.hp / e.maxHp, 0, 1);
      ctx.fillStyle = 'rgba(10, 10, 10, 0.82)';
      ctx.fillRect(e.x - bw * 0.5, e.y - e.r - 13, bw, 4);
      ctx.fillStyle = '#b4342d';
      ctx.fillRect(e.x - bw * 0.5 + 1, e.y - e.r - 12, (bw - 2) * ratio, 2);
    }
  }

  // ===================== 动画 / 乌鸦 / 动作 UI 辅助（仅渲染层自用缓存，不写游戏状态） =====================

  /** 钉刺木板的钉子端点（x, 尖端 y）成对排列，零分配 */
  private static readonly NAIL_PTS: readonly number[] = [20, -6, 25, -7.5, 29, -5.5, 23, 6];
  /** 武器端世界坐标缓存（玩家绘制时写入，覆盖层蓄力细弧读取） */
  private uiWeaponTipX = 0;
  private uiWeaponTipY = 0;

  // ===================== R3 装备渲染（只读 engine.equip，不写回任何游戏状态） =====================
  /** 火把头世界坐标缓存（玩家绘制写入；本帧火把点光源与 Canvas2D 回退读取） */
  private uiTorchTipX = 0;
  private uiTorchTipY = 0;
  private eqArmScratch: ArmPose = { a: 0.25, len: 13, twist: 0, w: 0 };
  private eqHandScratch: HandPose = { x: 13, y: 8.2, w: 0 };
  private equipPolyScratch: Vec2[] = [];

  /** 俯视靴子：抬起（摆动相）的脚略大略亮并带离地小影；落地（支撑相）的脚压暗贴地 */
  private drawBoot(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, lift: number) {
    const k = 1 + lift * 0.14;
    if (lift > 0.05) {
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.22 * lift).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(x - 1.5, y + 1.5, 5.6, 3.2, rot, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = lift > 0.3 ? '#2a2019' : '#1e1611';
    ctx.strokeStyle = '#0c0907';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(x, y, 6.2 * k, 3.5 * k, rot, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // 鞋尖磨亮边
    ctx.strokeStyle = 'rgba(150, 128, 98, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x + 3.2 * k, y, 2.4 * k, rot - 1.1, rot + 1.1);
    ctx.stroke();
  }

  /**
   * 多层火舌（外焰暗红 → 中焰橙 → 白黄内核 + 两条独立跳动的侧舌）。
   * 火舌尖 = 竖直上窜（屏幕 -y，俯视透视）+ engine 惯性偏移 (ox, oy)；外层跟随系数最大（拖得最长），内核最贴近火头。
   * 雨中（rain）火焰更矮更暗。
   */
  /**
   * 俯视垂直火把火焰：
   * 静止时为垂直向上升腾的饱满热浪火团（不再强行朝 -y 歪斜），叠加多频呼吸明灭脉冲；
   * 角色运动/急转/受风时，外层与中层火舌按 engine 弹簧物理偏移 (ox, oy) 产生真实惯性拖曳与翻卷摆动。
   */
  private drawTorchFlame(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    ox: number,
    oy: number,
    h: number,
    t: number,
    seed: number,
    rain: number,
    scale: number
  ) {
    const hh = clamp(h, 0, 1);
    // 多频呼吸明灭因子（不规则柴火跳动 + 降雨瞬时压焰闪烁）
    const pulse =
      0.86 +
      Math.sin(t * 13.7 + seed) * 0.09 +
      Math.sin(t * 27.9 + seed * 1.9) * 0.06 +
      Math.cos(t * 43.3 + seed * 0.7) * 0.03 -
      rain * (0.06 + 0.06 * Math.max(0, Math.sin(t * 31.1 + seed)));
    const pK = clamp(pulse, 0.62, 1.16);

    // 柔和外圈明灭火光晕（随火焰偏移微微漂移）
    const haloR = (9 + 6.5 * hh) * scale * pK;
    const haloGrad = ctx.createRadialGradient(x + ox * 0.25, y + oy * 0.25, 1, x + ox * 0.25, y + oy * 0.25, haloR);
    haloGrad.addColorStop(0, `rgba(255, 152, 56, ${(0.34 * hh * pK).toFixed(3)})`);
    haloGrad.addColorStop(0.55, `rgba(232, 82, 26, ${(0.14 * hh * pK).toFixed(3)})`);
    haloGrad.addColorStop(1, 'rgba(180, 42, 12, 0)');
    ctx.fillStyle = haloGrad;
    ctx.beginPath();
    ctx.arc(x + ox * 0.25, y + oy * 0.25, haloR, 0, Math.PI * 2);
    ctx.fill();
    if (hh < 0.03) return;

    // 俯视火焰摆动向量：完全由物理弹簧 (ox, oy) + 高频热浪乱流驱动（静止时接近中心垂直上升）
    const turbX = Math.sin(t * 18.3 + seed) * 1.55 + Math.cos(t * 31.7 + seed * 1.3) * 0.75;
    const turbY = Math.cos(t * 21.1 + seed * 1.7) * 1.55 + Math.sin(t * 29.3 + seed * 0.9) * 0.75;
    const swayMag = Math.hypot(ox, oy);

    for (let layer = 0; layer < 3; layer++) {
      const k = layer === 0 ? 1.05 : layer === 1 ? 0.72 : 0.36;
      const baseR = (layer === 0 ? 5.0 : layer === 1 ? 3.5 : 2.0) * scale * (0.68 + 0.32 * hh) * pK * (1 - rain * 0.14);
      const tipX = x + ox * k + turbX * (1 - layer * 0.28);
      const tipY = y + oy * k + turbY * (1 - layer * 0.28);
      const dx = tipX - x;
      const dy = tipY - y;
      const dl = Math.hypot(dx, dy);

      ctx.fillStyle =
        layer === 0
          ? `rgba(206, 56, 20, ${(clamp((0.68 - rain * 0.14) * pK, 0.25, 0.85)).toFixed(3)})`
          : layer === 1
          ? `rgba(252, 138, 34, ${(clamp(0.88 * pK, 0.45, 0.96)).toFixed(3)})`
          : `rgba(255, 244, 202, ${(clamp(0.95 * pK, 0.65, 1.0)).toFixed(3)})`;

      if (dl < 2.2) {
        // 静止/微动：垂直向上升腾的饱满火团（多瓣微颤圆心，俯视自然无方向畸变）
        ctx.beginPath();
        ctx.ellipse(
          x + dx * 0.5,
          y + dy * 0.5,
          baseR * (1 + 0.12 * Math.sin(t * 24 + seed + layer)),
          baseR * (1 + 0.12 * Math.cos(t * 21 + seed + layer)),
          t * 1.8 + seed,
          0,
          Math.PI * 2
        );
        ctx.fill();
      } else {
        // 运动/受风摆动：沿物理偏移方向拉长的俯视水滴状火舌
        const ux = dx / dl;
        const uy = dy / dl;
        const nx = -uy;
        const ny = ux;
        const tipExt = Math.min(dl + baseR * 0.65, (6 + 9 * hh) * scale * (1 + swayMag * 0.08));
        const tx = x + ux * tipExt;
        const ty = y + uy * tipExt;
        ctx.beginPath();
        ctx.moveTo(x + nx * baseR, y + ny * baseR);
        ctx.quadraticCurveTo(x + nx * baseR * 1.12 + ux * tipExt * 0.48, y + ny * baseR * 1.12 + uy * tipExt * 0.48, tx, ty);
        ctx.quadraticCurveTo(x - nx * baseR * 1.12 + ux * tipExt * 0.48, y - ny * baseR * 1.12 + uy * tipExt * 0.48, x - nx * baseR, y - ny * baseR);
        ctx.quadraticCurveTo(x - ux * baseR * 0.92, y - uy * baseR * 0.92, x + nx * baseR, y + ny * baseR);
        ctx.closePath();
        ctx.fill();

        if (layer === 0 && swayMag > 1.8) {
          // 运动拖曳时衍生两条翻卷侧舌
          for (let s = -1; s <= 1; s += 2) {
            const lick = 0.48 + 0.36 * Math.sin(t * (20 + s * 4.5) + seed * 2.3 + s);
            const bx = x + nx * baseR * 0.55 * s;
            const by = y + ny * baseR * 0.55 * s;
            const tx2 = bx + ux * tipExt * 0.58 * lick + nx * s * 2.4;
            const ty2 = by + uy * tipExt * 0.58 * lick + ny * s * 2.4;
            ctx.beginPath();
            ctx.moveTo(bx + nx * 1.5, by + ny * 1.5);
            ctx.quadraticCurveTo(bx + ux * tipExt * 0.3 + nx * s * 2.4, by + uy * tipExt * 0.3 + ny * s * 2.4, tx2, ty2);
            ctx.lineTo(bx - nx * 1.5, by - ny * 1.5);
            ctx.closePath();
            ctx.fill();
          }
        }
      }
    }
  }

  /** 地上火把（抛物线影子 + 木柄 + 竖直火舌）/ 弹壳 / 弹道残影；返回计入 drawCalls 的批次数（至多 1） */
  private drawEquipmentWorld(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number
  ): number {
    const eq = engine.equip;
    const t = engine.simTime;
    let any = false;

    if (eq.tracer > 0) {
      const a = clamp(eq.tracer / 0.07, 0, 1);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255, 226, 170, ${(0.5 * a).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(eq.tracerX0, eq.tracerY0);
      ctx.lineTo(eq.tracerX1, eq.tracerY1);
      ctx.stroke();
      ctx.restore();
      any = true;
    }

    for (let i = 0; i < eq.shells.length; i++) {
      const s = eq.shells[i];
      if (!s.active) continue;
      if (s.x < viewL - 20 || s.x > viewR + 20 || s.y < viewT - 20 || s.y > viewB + 20) continue;
      ctx.save();
      ctx.globalAlpha = clamp(s.life / 1.2, 0, 1);
      ctx.translate(s.x, s.y - s.z * 0.9);
      ctx.rotate(s.rot);
      ctx.fillStyle = '#b08a3e';
      ctx.fillRect(-1.8, -0.9, 3.6, 1.8);
      ctx.fillStyle = 'rgba(255, 236, 170, 0.6)';
      ctx.fillRect(-1.6, -0.9, 1.6, 0.7);
      ctx.restore();
      any = true;
    }

    for (let i = 0; i < eq.groundTorches.length; i++) {
      const gt = eq.groundTorches[i];
      if (!gt.active) continue;
      if (gt.x < viewL - 60 || gt.x > viewR + 60 || gt.y < viewT - 60 || gt.y > viewB + 60) continue;
      const lift = gt.z * 0.9;
      const shK = 1 - clamp(gt.z / 60, 0, 0.5);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.beginPath();
      ctx.ellipse(gt.x + 1, gt.y + 2, 11 * shK, 3.6 * shK, gt.rot, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(gt.x, gt.y - lift);
      ctx.rotate(gt.rot);
      ctx.strokeStyle = '#5e4128';
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-13, 0);
      ctx.lineTo(8, 0);
      ctx.stroke();
      ctx.strokeStyle = '#8b795c';
      ctx.lineWidth = 3.8;
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(-5, 0);
      ctx.stroke();
      ctx.fillStyle = gt.lit ? '#3a1d10' : '#1b1612';
      ctx.beginPath();
      ctx.ellipse(10, 0, 4.4, 3.6, 0, 0, Math.PI * 2);
      ctx.fill();
      if (gt.lit) {
        ctx.fillStyle = 'rgba(255, 128, 48, 0.85)';
        ctx.beginPath();
        ctx.ellipse(10.5, 0, 2.6, 2.2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      const hx = gt.x + Math.cos(gt.rot) * 10;
      const hy = gt.y - lift + Math.sin(gt.rot) * 10;
      if (gt.flameH > 0.02) {
        const rainG = isPointInHideout(gt.x, gt.y) ? 0 : engine.weather.rainIntensity;
        this.drawTorchFlame(ctx, hx, hy, gt.swayX, gt.swayY, gt.flameH, t, 3.1 + gt.id, rainG, 1.05);
      }
      if (gt.landFlash > 0) {
        ctx.fillStyle = `rgba(255, 196, 110, ${(gt.landFlash * 1.6).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 12 + (0.25 - gt.landFlash) * 30, 0, Math.PI * 2);
        ctx.fill();
      }
      any = true;
    }
    return any ? 1 : 0;
  }

  /** 推入 R3 装备光源：枪口一帧强光 / 右手火把暖光（随火焰抖动与偏移）/ 最近两支地上火把（均带阴影遮罩，G 通道） */
  private pushEquipmentLights(
    engine: GameEngine,
    viewL: number,
    viewT: number,
    maxLights: number,
    fillPoly: (poly: Vec2[], color: string) => void
  ) {
    const eq = engine.equip;
    const t = engine.simTime;
    // 火把与手电鲜明区分：浓郁炽热暖橘/琥珀火焰光（多频自然跳动 + 光心微摇曳，驱动真实墙影晃动）
    const dayK = engine.phase === 'night' ? 1.08 : engine.phase === 'dusk' ? 0.92 : 0.72;

    if (eq.muzzleFlash > 0 && this.gpuLights.length < maxLights) {
      const mf = clamp(eq.muzzleFlash / 0.05, 0, 1);
      computeVisibilityPolygon(engine.world, eq.muzzleX, eq.muzzleY, TORCH_LIGHT.muzzleRadius, this.equipPolyScratch);
      fillPoly(this.equipPolyScratch, '#00ff00');
      this.gpuLights.push({
        x: eq.muzzleX - viewL,
        y: eq.muzzleY - viewT,
        radius: TORCH_LIGHT.muzzleRadius,
        intensity: TORCH_LIGHT.muzzleIntensity * mf,
        r: 1.0,
        g: 0.84,
        b: 0.58,
        dirX: 0,
        dirY: 0,
        coneCos: -2.0,
        shadowChannel: 1,
      });
    }

    if (eq.torchInHand && eq.torchLight > 0.03 && this.gpuLights.length < maxLights) {
      // 真实火焰明灭呼吸：多频明暗起伏 + 降雨瞬时微暗 + 光心随物理火焰摆动偏移，驱动墙影与树影摇晃
      const flick =
        0.82 +
        Math.sin(t * 9.7) * 0.11 +
        Math.sin(t * 21.3 + 1.3) * 0.08 +
        Math.sin(t * 39.7 + 0.4) * 0.04 -
        eq.rainExposure * 0.06 * Math.max(0, Math.sin(t * 28.4));
      const jitterX = Math.sin(t * 14.5) * 1.9 + Math.cos(t * 29.1) * 0.9;
      const jitterY = Math.cos(t * 16.2 + 0.7) * 1.9 + Math.sin(t * 25.4) * 0.9;
      const lx = this.uiTorchTipX + eq.flameX * 0.75 + jitterX;
      const ly = this.uiTorchTipY + eq.flameY * 0.75 + jitterY;
      const rad = TORCH_LIGHT.radius * (0.85 + 0.15 * eq.torchLight * clamp(flick, 0.7, 1.12));
      computeVisibilityPolygon(engine.world, lx, ly, rad, this.equipPolyScratch);
      fillPoly(this.equipPolyScratch, '#00ff00');
      this.gpuLights.push({
        x: lx - viewL,
        y: ly - viewT,
        radius: rad,
        intensity: TORCH_LIGHT.intensity * eq.torchLight * clamp(flick, 0.58, 1.15) * dayK,
        // 明灭同步色温微变：亮时偏暖琥珀，暗时偏深橘红
        r: 1.0,
        g: clamp(0.46 + (flick - 0.82) * 0.35, 0.36, 0.56),
        b: clamp(0.13 + (flick - 0.82) * 0.15, 0.08, 0.19),
        dirX: 0,
        dirY: 0,
        coneCos: -2.0,
        shadowChannel: 1,
      });
    }

    let n = 0;
    for (let i = 0; i < eq.groundTorches.length && n < 2; i++) {
      const gt = eq.groundTorches[i];
      if (!gt.active || gt.flameH < 0.03 || this.gpuLights.length >= maxLights) continue;
      if (dist(gt.x, gt.y, engine.camX, engine.camY) > 900) continue;
      const flick = 0.83 + Math.sin(t * 12.1 + gt.id) * 0.1 + Math.sin(t * 27.3 + gt.id * 1.7) * 0.06;
      const lx = gt.x + gt.swayX * 0.5 + Math.sin(t * 15 + gt.id) * 1.4;
      const ly = gt.y - gt.z * 0.9 + gt.swayY * 0.5 - 4 + Math.cos(t * 17 + gt.id) * 1.4;
      const rad = TORCH_LIGHT.groundRadius * (0.85 + 0.15 * gt.flameH);
      computeVisibilityPolygon(engine.world, lx, ly, rad, this.equipPolyScratch);
      fillPoly(this.equipPolyScratch, '#00ff00');
      this.gpuLights.push({
        x: lx - viewL,
        y: ly - viewT,
        radius: rad,
        intensity: TORCH_LIGHT.groundIntensity * gt.flameH * flick * dayK,
        r: 1.0,
        g: 0.46,
        b: 0.13,
        dirX: 0,
        dirY: 0,
        coneCos: -2.0,
        shadowChannel: 1,
      });
      n++;
    }
  }
  /** 可见性探针：复用 isEnemyVisible 单一可见规则（只读 x/y），并充当倒地尸体的绘制载体；零分配 */
  private visProbe: Enemy = {
    id: 0,
    kind: 'stalker',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    r: 15,
    hp: 1,
    maxHp: 1,
    speed: 1,
    damage: 0,
    state: 'prowl',
    attackCd: 0,
    hitFlash: 0,
    snareTimer: 0,
    stalkTimer: 0,
    stalkRippleCd: 0,
    stepTimer: 0,
    walkPhase: 0,
    clawPhase: 0,
    targetBarricadeId: null,
    patrolX: 0,
    patrolY: 0,
    windup: 0,
    windupDur: 0.3,
    lunge: 0,
    crouch: 0,
    clawSide: 1,
  };

  private animEase(x: number): number {
    const k = clamp(x, 0, 1);
    return k * k * (3 - 2 * k);
  }

  /** 钉板举锤高度 0..1：与 engine 锤击时刻（GameEngine.HAMMER_HIT_FRACS）严格对齐，命中瞬间恰好砸到底 */
  private hammerRaise(time: number, dur: number): number {
    const fr = GameEngine.HAMMER_HIT_FRACS;
    let prev = 0;
    for (let i = 0; i < fr.length; i++) {
      const hit = fr[i] * dur;
      if (time <= hit) {
        const local = clamp((time - prev) / Math.max(0.01, hit - prev), 0, 1);
        if (local < 0.7) return this.animEase(local / 0.7);
        const k = (local - 0.7) / 0.3;
        return 1 - k * k;
      }
      prev = hit;
    }
    const after = clamp((time - prev) / Math.max(0.01, dur - prev), 0, 1);
    return Math.sin(after * Math.PI) * 0.25;
  }

  /** 怪物死亡倒地：侧翻、肢体松弛，烘焙贴花后淡出（视野锥外不画） */
  private drawDyingEnemies(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    coneHalfRad: number,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number
  ): number {
    const ring = engine.dyingEnemies;
    const probe = this.visProbe;
    const bakeT = GameEngine.DYING_BAKE_T;
    const endT = GameEngine.DYING_END_T;
    let n = 0;
    for (let i = 0; i < ring.count; i++) {
      const d = ring.items[i];
      if (!d.active) continue;
      if (d.x < viewL - 60 || d.x > viewR + 60 || d.y < viewT - 60 || d.y > viewB + 60) continue;
      probe.x = d.x;
      probe.y = d.y;
      if (!this.isEnemyVisible(engine, probe, coneHalfRad)) continue;
      probe.kind = d.kind;
      probe.id = Math.floor(d.seed * 997);
      probe.angle = d.angle;
      probe.r = d.r;
      probe.vx = 0;
      probe.vy = 0;
      probe.speed = 1;
      probe.walkPhase = d.walkPhase;
      probe.clawPhase = 0;
      probe.clawSide = 1;
      probe.windup = 0;
      probe.lunge = 0;
      probe.crouch = 0;
      probe.state = 'prowl';
      probe.hp = 1;
      probe.maxHp = 1;
      // 致命一击瞬间的闪红与抽搐
      probe.hitFlash = d.timer < 0.16 ? 0.3 - d.timer : 0;
      const fade = d.timer < bakeT ? 1 : clamp(1 - (d.timer - bakeT) / (endT - bakeT), 0, 1);
      if (fade <= 0.01) continue;
      const rel = angleDiff(d.angle, d.fallDir);
      ctx.save();
      ctx.globalAlpha = fade;
      this.drawArticulatedEnemy(ctx, probe, engine.simTime, d.timer, rel >= 0 ? 1 : -1);
      ctx.restore();
      n++;
    }
    return n;
  }

  /**
   * 乌鸦分层绘制：
   * - pass === 'ground'：仅绘制地面踱步/啄食乌鸦（位于树冠之下）；
   * - pass === 'canopy'：绘制栖息在树冠枝头的乌鸦（叠加树冠高度视差与风摆）以及起飞/飞行乌鸦（位于树冠之上，绝不被遮挡）。
   */
  private drawCrows(
    ctx: CanvasRenderingContext2D,
    engine: GameEngine,
    coneHalfRad: number,
    viewL: number,
    viewT: number,
    viewR: number,
    viewB: number,
    pass: 'ground' | 'canopy'
  ): number {
    const crows = engine.crows;
    const probe = this.visProbe;
    const camX = engine.camX;
    const camY = engine.camY;
    const swayOn = Quality.preset.canopySway;
    const stormWind = 1 + engine.weather.rainIntensity * 1.55;
    let drawn = 0;
    for (let i = 0; i < crows.length; i++) {
      const c = crows[i];
      if (!c.active) continue;
      const isGround = c.state === 'ground';
      if (pass === 'ground' && !isGround) continue;
      if (pass === 'canopy' && isGround) continue;

      // 树上栖息乌鸦：叠加对应树冠的视差与风摆偏移，让乌鸦稳稳踩在摇晃的树枝上
      let drawX = c.x;
      let drawY = c.y;
      if (c.state === 'perched' && c.treeId >= 0 && c.treeId < engine.world.trees.length) {
        const t = engine.world.trees[c.treeId];
        const waveBase = swayOn ? Math.sin(engine.simTime * (0.86 * stormWind) + t.phase + t.x * 0.004) : 0;
        const waveBaseY = swayOn ? Math.cos(engine.simTime * (0.68 * stormWind) + t.phase + t.y * 0.004) : 0;
        const baseSwayX = waveBase * (4.6 * stormWind);
        const baseSwayY = waveBaseY * (3.0 * stormWind);
        const paraX = clamp((t.x - camX) * 0.12, -56, 56);
        const paraY = clamp((t.y - camY) * 0.12, -56, 56);
        drawX = t.x + c.perchOffX + baseSwayX + paraX;
        drawY = t.y + c.perchOffY + baseSwayY + paraY;
      }

      if (drawX < viewL - 56 || drawX > viewR + 56 || drawY < viewT - 56 || drawY > viewB + 56) continue;
      probe.x = c.x;
      probe.y = c.y;
      if (!this.isEnemyVisible(engine, probe, coneHalfRad)) continue;
      drawn++;

      const z = c.z;
      // 俯视高度透视大小变化：地面(z=0)为 1.0x，树枝(z≈0.45)为 ~1.42x，飞到高空贴近镜头(z→1.0)平滑放大至 2.25x！
      const s = 1 + z * 0.85 + z * z * 0.4;
      // 地面/起飞阴影：离地越高，地面影子向反方向拉远、缩小并淡出，强化升空立体感
      if (c.state !== 'perched') {
        const shOff = z * 28;
        const shK = Math.max(0.35, 1 - z * 0.48);
        ctx.fillStyle = `rgba(0, 0, 0, ${(0.36 * Math.max(0, 1 - z * 0.82)).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(drawX + shOff * 0.65, drawY + shOff, 4.6 * shK, 2.6 * shK, c.angle, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.save();
      ctx.translate(drawX, drawY);
      ctx.rotate(c.angle);
      ctx.scale(s * 1.24, s * 1.24);
      ctx.globalAlpha = c.state === 'perched' ? 0.96 : clamp(1.06 - z * 0.46, 0.28, 0.98);

      if (c.state === 'ground' || c.state === 'perched') {
        const perched = c.state === 'perched';
        const hopLift = perched ? 0 : Math.sin(c.hop * Math.PI) * 0.14;
        const peckK = Math.sin(c.peck * Math.PI);
        const preenK = perched ? Math.sin(c.preen * Math.PI) : 0;
        const alertShake = perched && c.alert > 0.05 ? Math.sin(engine.simTime * 28 + c.seed * 10) * 0.09 * c.alert : 0;
        ctx.scale(1 + hopLift, 1 + hopLift);
        if (alertShake !== 0) ctx.rotate(alertShake);
        // 树枝乌鸦抖羽/微张翅膀动作
        if (preenK > 0.05 || (perched && c.alert > 0.35)) {
          const flutter = Math.max(preenK * 0.9, c.alert * 0.65);
          const wOut = 3.2 + flutter * 3.8 * (0.65 + 0.35 * Math.sin(engine.simTime * 34 + c.seed * 12));
          ctx.fillStyle = '#07080a';
          ctx.beginPath();
          for (let side = -1; side <= 1; side += 2) {
            ctx.moveTo(1.2, side * 1.4);
            ctx.lineTo(-1.2, side * wOut);
            ctx.lineTo(-3.4, side * (wOut * 0.65));
            ctx.lineTo(-2.6, side * 1.4);
            ctx.closePath();
          }
          ctx.fill();
        }
        // 尾羽（小扇形）
        ctx.fillStyle = '#07080a';
        ctx.beginPath();
        ctx.moveTo(-3.6, 0);
        ctx.lineTo(-8.2, -2.1);
        ctx.quadraticCurveTo(-9, 0, -8.2, 2.1);
        ctx.closePath();
        ctx.fill();
        // 身体
        ctx.beginPath();
        ctx.ellipse(0, 0, 4.6, 2.7, 0, 0, Math.PI * 2);
        ctx.fill();
        // 树上乌鸦极克制的冷蓝灰羽背微光（让乌鸦在深黑树枝上依然一眼可辨）
        if (perched) {
          ctx.strokeStyle = c.alert > 0.1 ? 'rgba(158, 174, 186, 0.62)' : 'rgba(116, 130, 142, 0.40)';
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.arc(0.4, 0, 3.3, -1.1, 1.1);
          ctx.stroke();
        }
        // 头与喙：啄食前探，鸣叫张喙
        const hx = 4.2 + peckK * 1.8;
        ctx.fillStyle = '#07080a';
        ctx.beginPath();
        ctx.arc(hx, 0, 1.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        const gape = c.caw * 1.05;
        ctx.moveTo(hx + 1.4, -0.6 - gape);
        ctx.lineTo(hx + 4.4, -gape * 0.65);
        ctx.lineTo(hx + 1.6, 0);
        ctx.lineTo(hx + 4.4, gape * 0.65);
        ctx.lineTo(hx + 1.4, 0.6 + gape);
        ctx.closePath();
        ctx.fill();
      } else {
        // 起飞(takeoff) / 爬升飞行(fly) / 降落(landing)：清晰生动的扑腾翅膀动画
        const isTakeoff = c.state === 'takeoff';
        const isLanding = c.state === 'landing';
        // 滑翔/扑腾节奏：起飞与降落前高频剧烈扑腾，高空巡航间歇拍打+滑翔
        const glideCycle = !isTakeoff && !isLanding && c.flyTime > 1.15 ? Math.sin(c.flyTime * 2.4 + c.seed * 6) : 1;
        const flapAmp = isTakeoff ? 1.0 : isLanding ? 0.92 : glideCycle > -0.25 ? 0.88 : 0.18;
        const flap = Math.sin(c.wingPhase);
        // 俯视翼展随拍动大幅收展（0.42..1.16），清晰呈现一扇一扇扑腾翅膀的动作
        const spanK = 0.78 + 0.38 * Math.cos(c.wingPhase) * flapAmp;
        const span = (isTakeoff ? 9.8 : 11.4) * spanK;
        const sweepX = (isTakeoff ? 2.4 : 1.9) * flap * flapAmp;
        const tailSpread = isTakeoff || isLanding ? 3.4 : 2.5;
        // 高空扑腾翼端拖影（增强振翅动感）
        if (z > 0.22 && flapAmp > 0.3) {
          const gf = Math.sin(c.wingPhase - 0.85);
          const gspan = (isTakeoff ? 9.8 : 11.4) * (0.78 + 0.38 * Math.cos(c.wingPhase - 0.85) * flapAmp);
          ctx.fillStyle = `rgba(6, 7, 9, ${(0.24 * clamp(z, 0.25, 0.9)).toFixed(3)})`;
          ctx.beginPath();
          for (let side = -1; side <= 1; side += 2) {
            ctx.moveTo(1.4, side * 1.2);
            ctx.lineTo(-0.4 + gf * 2.0 + 0.9, side * gspan);
            ctx.lineTo(-2.5, side * 1.4);
            ctx.closePath();
          }
          ctx.fill();
        }
        ctx.fillStyle = '#060708';
        ctx.beginPath();
        for (let side = -1; side <= 1; side += 2) {
          // 弯曲有力的鸟翼轮廓 + 翼尖飞羽分叉
          ctx.moveTo(1.5, side * 1.1);
          ctx.quadraticCurveTo(1.2 + sweepX * 0.45, side * (span * 0.56), sweepX + 0.7, side * span);
          ctx.lineTo(sweepX - 1.9, side * (span * 0.94));
          ctx.lineTo(sweepX - 0.9, side * (span * 0.74));
          ctx.lineTo(-1.8, side * (span * 0.62));
          ctx.lineTo(-1.2, side * (span * 0.42));
          ctx.lineTo(-2.6, side * 1.4);
          ctx.closePath();
        }
        ctx.fill();
        // 身体、撑开的扇形尾羽与头部
        ctx.beginPath();
        ctx.ellipse(0, 0, 4.7, 2.2, 0, 0, Math.PI * 2);
        ctx.moveTo(-3.6, 0);
        ctx.lineTo(-8.5, -tailSpread);
        ctx.quadraticCurveTo(-9.6, 0, -8.5, tailSpread);
        ctx.closePath();
        ctx.moveTo(6.4, 0);
        ctx.arc(4.8, 0, 1.65, 0, Math.PI * 2);
        ctx.moveTo(6.2, -0.65);
        ctx.lineTo(8.5, 0);
        ctx.lineTo(6.2, 0.65);
        ctx.fill();
      }
      ctx.restore();
    }
    return drawn > 0 ? 1 : 0;
  }

  /**
   * 世界空间动作 UI（覆盖层，暗部之上；克制、无廉价进度条）：
   * ① 限时交互：角色旁一圈细墨线弧环逐渐闭合（钉板另标三处锤击刻痕）
   * ② 蓄力：武器端余烬色细弧 + 满蓄时一次微闪
   * （闪避冷却不显示 UI，用动作体现；低体力呼吸白雾在玩家绘制中表现）
   */
  private drawActionUI(ctx: CanvasRenderingContext2D, engine: GameEngine) {
    if (engine.mode !== 'play') return;
    const p = engine.player;
    const pose = p.pose;
    const act = p.action;

    if (pose.actionKind !== 'none' && pose.action > 0.03) {
      const prog = act.kind !== 'none' ? clamp(act.timer / Math.max(0.01, act.duration), 0, 1) : pose.actionProgress;
      const a = clamp(pose.action, 0, 1);
      const R = 23;
      const start = -Math.PI / 2;
      const endA = start + Math.PI * 2 * prog;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(12, 10, 8, ${(0.34 * a).toFixed(3)})`;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.stroke();
      if (prog > 0.002) {
        ctx.strokeStyle = `rgba(226, 208, 170, ${(0.6 * a).toFixed(3)})`;
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.arc(p.x, p.y, R, start, endA);
        ctx.stroke();
        // 笔锋墨点
        ctx.fillStyle = `rgba(236, 220, 186, ${(0.7 * a).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(endA) * R, p.y + Math.sin(endA) * R, 1.35, 0, Math.PI * 2);
        ctx.fill();
      }
      if (pose.actionKind === 'barricade') {
        const fr = GameEngine.HAMMER_HIT_FRACS;
        ctx.lineWidth = 1.1;
        for (let k = 0; k < fr.length; k++) {
          const ang = start + Math.PI * 2 * fr[k];
          const done = prog >= fr[k];
          ctx.strokeStyle = done
            ? `rgba(232, 150, 84, ${(0.75 * a).toFixed(3)})`
            : `rgba(206, 190, 160, ${(0.32 * a).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(ang) * (R - 3), p.y + Math.sin(ang) * (R - 3));
          ctx.lineTo(p.x + Math.cos(ang) * (R + 3), p.y + Math.sin(ang) * (R + 3));
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (pose.charge > 0.04 || pose.chargeFull > 0) {
      const cw = clamp(pose.charge, 0, 1);
      const tx = this.uiWeaponTipX;
      const ty = this.uiWeaponTipY;
      const ang = Math.atan2(ty - p.y, tx - p.x);
      const R = Math.hypot(tx - p.x, ty - p.y) + 3;
      const span = 0.14 + cw * 0.36;
      const ready = p.isCharging && p.chargeTimer >= 0.22;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = ready
        ? `rgba(240, 150, 74, ${(0.32 + 0.4 * cw).toFixed(3)})`
        : `rgba(214, 138, 86, ${(0.18 + 0.3 * cw).toFixed(3)})`;
      ctx.lineWidth = ready ? 1.4 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, ang - span, ang + span * 0.35);
      ctx.stroke();
      if (pose.chargeFull > 0) {
        const f = clamp(pose.chargeFull / 0.22, 0, 1);
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255, 178, 96, ${(0.32 * f).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(tx, ty, 4 + (1 - f) * 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255, 214, 150, ${(0.5 * f).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, R + 2, ang - span * 1.2, ang + span * 0.5);
        ctx.stroke();
      }
      ctx.restore();
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

  /**
   * 绘制可拖拽重型家具（旧沙发 / 橡木柜 / 长木桌），采用东欧冷腐油画笔触、受损裂纹与拖拽微弱暖框
   */
  private drawMovableFurniture(
    ctx: CanvasRenderingContext2D,
    f: MovableFurniture,
    dragging: boolean,
    time: number
  ) {
    const cx = f.x + f.w * 0.5;
    const cy = f.y + f.h * 0.5;
    const hw = f.w * 0.5;
    const hh = f.h * 0.5;
    const hpRatio = clamp(f.hp / f.maxHp, 0, 1);

    ctx.save();
    ctx.translate(cx, cy);

    // 接地厚重暗影
    ctx.fillStyle = 'rgba(5, 4, 4, 0.54)';
    ctx.fillRect(-hw + 3, -hh + 4, f.w, f.h);

    if (f.kind === 'sofa') {
      // 腐朽暗褐绒布旧沙发：厚靠背 + 磨损双扶手 + 塌陷坐垫缝线
      ctx.fillStyle = f.hitFlash > 0 ? '#78322a' : '#4a352c';
      ctx.strokeStyle = '#120d0a';
      ctx.lineWidth = 2;
      ctx.fillRect(-hw, -hh, f.w, f.h);
      ctx.strokeRect(-hw, -hh, f.w, f.h);

      // 靠背与左右扶手立体厚边
      ctx.fillStyle = f.hitFlash > 0 ? '#8c3d34' : '#382720';
      ctx.fillRect(-hw + 1, -hh + 1, f.w - 2, 7);
      ctx.fillRect(-hw + 1, -hh + 1, 7, f.h - 2);
      ctx.fillRect(hw - 8, -hh + 1, 7, f.h - 2);

      // 坐垫拼接缝与陈旧污渍
      ctx.strokeStyle = 'rgba(18, 12, 9, 0.65)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -hh + 8);
      ctx.lineTo(0, hh - 2);
      ctx.moveTo(-hw + 8, -hh + 8);
      ctx.lineTo(hw - 8, -hh + 8);
      ctx.stroke();

      ctx.fillStyle = 'rgba(20, 15, 12, 0.32)';
      ctx.beginPath();
      ctx.ellipse(-10, 3, 9, 5, 0.2, 0, Math.PI * 2);
      ctx.fill();
    } else if (f.kind === 'cabinet') {
      // 沉重橡木柜：暗沉木板顶面 + 铁质包角 + 暗铜抽屉把手
      ctx.fillStyle = f.hitFlash > 0 ? '#7a3b2c' : '#423022';
      ctx.strokeStyle = '#0e0a07';
      ctx.lineWidth = 2.2;
      ctx.fillRect(-hw, -hh, f.w, f.h);
      ctx.strokeRect(-hw, -hh, f.w, f.h);

      // 顶面木纹与厚黑边内框
      ctx.strokeStyle = 'rgba(18, 12, 8, 0.62)';
      ctx.lineWidth = 1.3;
      ctx.strokeRect(-hw + 4, -hh + 4, f.w - 8, f.h - 8);
      ctx.beginPath();
      ctx.moveTo(-hw + 4, 0);
      ctx.lineTo(hw - 4, 0);
      ctx.stroke();

      // 锈蚀铁包角与暗铜拉手
      ctx.fillStyle = '#333836';
      ctx.fillRect(-hw, -hh, 5, 5);
      ctx.fillRect(hw - 5, -hh, 5, 5);
      ctx.fillRect(-hw, hh - 5, 5, 5);
      ctx.fillRect(hw - 5, hh - 5, 5, 5);
      ctx.fillStyle = '#9c7e4e';
      ctx.fillRect(-5, hh - 3, 10, 2);
    } else {
      // 长木桌：厚重划痕橡木拼板 + 桌面旧油渍
      ctx.fillStyle = f.hitFlash > 0 ? '#7c3d2d' : '#533c28';
      ctx.strokeStyle = '#140e09';
      ctx.lineWidth = 2;
      ctx.fillRect(-hw, -hh, f.w, f.h);
      ctx.strokeRect(-hw, -hh, f.w, f.h);

      ctx.strokeStyle = 'rgba(20, 14, 9, 0.58)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-hw + 2, -hh + f.h * 0.35);
      ctx.lineTo(hw - 2, -hh + f.h * 0.35);
      ctx.moveTo(-hw + 2, -hh + f.h * 0.68);
      ctx.lineTo(hw - 2, -hh + f.h * 0.68);
      ctx.stroke();

      // 桌面暗痕与钉头
      ctx.fillStyle = 'rgba(16, 12, 9, 0.42)';
      ctx.fillRect(-hw + 4, -hh + 4, 2.5, 2.5);
      ctx.fillRect(hw - 6.5, -hh + 4, 2.5, 2.5);
      ctx.fillRect(-hw + 4, hh - 6.5, 2.5, 2.5);
      ctx.fillRect(hw - 6.5, hh - 6.5, 2.5, 2.5);
    }

    // 受损木裂纹（hp 低于 70% 时逐步显现）
    if (hpRatio < 0.72) {
      ctx.strokeStyle = 'rgba(14, 9, 7, 0.88)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-hw * 0.5, -hh + 2);
      ctx.lineTo(-hw * 0.15, 0);
      ctx.lineTo(-hw * 0.35, hh - 3);
      if (hpRatio < 0.4) {
        ctx.moveTo(hw * 0.4, -hh + 3);
        ctx.lineTo(hw * 0.1, 2);
        ctx.lineTo(hw * 0.5, hh - 2);
      }
      ctx.stroke();
    }

    // 拖拽时的微弱暖框轮廓（极克制，帮助玩家确认当前抓取对象）
    if (dragging) {
      const pulse = 0.55 + Math.sin(time * 6.5) * 0.18;
      ctx.strokeStyle = `rgba(226, 184, 108, ${pulse.toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(-hw - 3, -hh - 3, f.w + 6, f.h + 6);
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  /**
   * 绘制地标处的信号中继零件节点（苏式金属无线电中继组件 + 微弱青琥珀脉冲光）
   */
  private drawRelayNode(ctx: CanvasRenderingContext2D, rn: RelayNode, time: number) {
    const pulse = 0.65 + Math.sin(time * 3.4 + rn.x * 0.02) * 0.35;
    ctx.save();
    ctx.translate(rn.x, rn.y);

    // 微弱青琥珀脉冲光晕
    const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
    grad.addColorStop(0, `rgba(122, 212, 188, ${(0.42 * pulse).toFixed(3)})`);
    grad.addColorStop(0.55, `rgba(218, 174, 96, ${(0.22 * pulse).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(122, 212, 188, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();

    // 地面投影
    ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
    ctx.fillRect(-11, -7, 24, 18);

    // 锈蚀苏式无线电中继金属箱体
    ctx.fillStyle = '#36443f';
    ctx.strokeStyle = '#111614';
    ctx.lineWidth = 2;
    ctx.fillRect(-12, -9, 24, 18);
    ctx.strokeRect(-12, -9, 24, 18);

    // 铜线圈与仪表刻度盘
    ctx.fillStyle = '#9c7844';
    ctx.fillRect(-8, -5, 7, 10);
    ctx.fillStyle = '#1b201e';
    ctx.beginPath();
    ctx.arc(5, 0, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // 脉冲信号指示灯
    ctx.fillStyle = pulse > 0.72 ? '#8ef0d6' : '#d8b062';
    ctx.beginPath();
    ctx.arc(5, 0, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // 折断的天线杆
    ctx.strokeStyle = '#8b9490';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(8, -9);
    ctx.lineTo(14, -18);
    ctx.stroke();

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
