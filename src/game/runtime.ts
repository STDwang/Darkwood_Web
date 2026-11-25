// Runtime loop & standardized window.__game headless testing contract (penpen-gamePlus-skill §05)

import { AudioFX } from './audio';
import { FIXED_DT, GameEngine } from './engine';
import { I18n } from './i18n';
import { Quality } from './quality';
import { GameRenderer } from './renderer';
import { PilotInput, TimePhase, WeatherKind } from './types';
import { Variants } from './variants';

export interface UiBridge {
  getState: () => string;
  isModalOpen: () => boolean;
  layerTop: () => string | null;
  startGame: () => void;
  setMenu: (open: boolean) => void;
}

export class GameRuntime {
  readonly engine: GameEngine;
  readonly renderer: GameRenderer;
  private canvas: HTMLCanvasElement;
  private rafId = 0;
  private lastTime = 0;
  private accum = 0;
  private manualMode = false;
  private destroyed = false;
  private uiBridge: UiBridge | null = null;
  private onFirstFrame: (() => void) | null = null;
  private firstFrameFired = false;
  private unsubs: Array<() => void> = [];
  // 身体反馈音频：上一步体力（识别疾跑）与耗尽锁定标记
  private prevStamina = -1;
  private exhaustLatch = false;
  // 刷新优化：记录最近一次实际渲染时间戳（用于手机 120Hz 高刷屏稳帧 60fps 与结算页背景降频）及暂停态脏标记
  private lastRenderAt = 0;
  private holdDirty = true;
  private lastMode = '';

  constructor(canvas: HTMLCanvasElement, onFirstFrame?: () => void) {
    this.canvas = canvas;
    this.onFirstFrame = onFirstFrame ?? null;
    this.engine = new GameEngine(19847);
    this.renderer = new GameRenderer(canvas);

    const params = new URLSearchParams(window.location.search);
    this.manualMode = params.has('manual');

    this.handleResize();
    window.addEventListener('resize', this.handleResize);

    // Re-size offscreen FBOs & re-render immediately when Quality or Variants change in hold mode
    this.unsubs.push(
      Quality.subscribe(() => {
        this.holdDirty = true;
        this.handleResize();
      })
    );
    this.unsubs.push(
      Variants.subscribe(() => {
        this.holdDirty = true;
        if (this.engine.mode === 'hold' || this.engine.mode === 'title') {
          this.renderer.render(this.engine);
          this.holdDirty = false;
        }
      })
    );

    document.addEventListener('visibilitychange', this.handleVisibility);

    this.exposeHeadlessHandle();

    this.renderer.render(this.engine);
    this.notifyFirstFrame();

    if (!this.manualMode) {
      this.lastTime = performance.now();
      this.rafId = requestAnimationFrame(this.loop);
    }
  }

  setUiBridge(bridge: UiBridge) {
    this.uiBridge = bridge;
  }

  private notifyFirstFrame() {
    if (this.firstFrameFired) return;
    this.firstFrameFired = true;
    this.onFirstFrame?.();
  }

  private handleResize = () => {
    // 优先使用 clientWidth/clientHeight（在 CSS rotate(90deg) 强制横屏时仍返回精确的逻辑横屏尺寸，而非旋转后外包框）
    const w = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width || window.innerWidth;
    const h = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height || window.innerHeight;
    this.renderer.resize(w, h);
    this.holdDirty = true;
    if (this.engine.mode === 'hold' || this.engine.mode === 'title') {
      this.renderer.render(this.engine);
      this.holdDirty = false;
    }
  };

  private handleVisibility = () => {
    if (document.hidden && this.engine.mode === 'play') {
      this.uiBridge?.setMenu(true);
    }
  };

  private loop = (now: number) => {
    if (this.destroyed) return;
    this.rafId = requestAnimationFrame(this.loop);

    // 页面处于后台隐藏态时完全休眠，零 CPU/GPU 消耗
    if (document.hidden) {
      this.lastTime = now;
      return;
    }

    const mode = this.engine.mode;
    if (mode !== this.lastMode) {
      this.lastMode = mode;
      this.holdDirty = true;
    }

    // 弹窗暂停态（工作台/地图/日志/排行榜/设置）：画面静止，若无脏标记则完全跳过主画布渲染，释放全部算力给 UI 滑动
    if (mode === 'hold') {
      this.lastTime = now;
      this.feedBodyAudio(FIXED_DT);
      if (this.holdDirty) {
        this.renderer.render(this.engine);
        this.holdDirty = false;
      }
      return;
    }

    // 手机高刷屏（90Hz/120Hz）稳帧节拍器：控制在稳定 ~60fps（>=14.2ms），消除高频 WebGL 上传引发的发热与帧抖动；
    // 死亡/胜利结算背景遮罩态自动降频至 ~15fps（>=64ms）节省电量
    const minRenderGap = mode === 'dead' || mode === 'victory' ? 64 : this.engine.isTouchUi ? 14.2 : 0;
    if (minRenderGap > 0 && now - this.lastRenderAt < minRenderGap) {
      return;
    }
    this.lastRenderAt = now;

    const rawFrameMs = now - this.lastTime;
    this.lastTime = now;
    const clampedSec = Math.min(rawFrameMs / 1000, 0.1);

    const jsStart = performance.now();
    this.accum += clampedSec;
    let steps = 0;
    while (this.accum >= FIXED_DT && steps < 5) {
      this.engine.step(FIXED_DT, this.renderer.width, this.renderer.height);
      this.feedBodyAudio(FIXED_DT);
      this.accum -= FIXED_DT;
      steps++;
    }
    if (steps === 5) this.accum = 0;

    this.renderer.render(this.engine);
    const jsMs = performance.now() - jsStart;

    if (rawFrameMs > 0 && mode === 'play') {
      this.engine.fps = this.engine.fps * 0.9 + (1000 / rawFrameMs) * 0.1;
      Quality.reportFrame(rawFrameMs, jsMs);
    }
  };

  /**
   * 身体反馈音频：只读 engine 字段推导疾跑 / 见底状态并调用 AudioFX.updateBody；非游玩状态只淡出蓄力张力
   */
  private feedBodyAudio(dt: number) {
    const p = this.engine.player;
    const st01 = p.stamina / Math.max(1, p.maxStamina);
    // 引擎未保存疾跑标志：按每步体力下降速率识别（疾跑恒定 28/s；攻击/闪避为一次性大额扣除，不会误判）
    const drop = this.prevStamina < 0 ? 0 : this.prevStamina - p.stamina;
    this.prevStamina = p.stamina;
    if (this.engine.mode !== 'play') {
      AudioFX.setChargeLevel(0);
      // 离开游玩状态（标题/死亡/胜利/暂停）时把异象不安声压回 0，避免残留在菜单里
      (AudioFX as unknown as { setHauntLevel?: (v: number) => void }).setHauntLevel?.(0);
      // 死亡/胜利不经过 engine.setMode，这里统一把火把燃烧声（手持与地上）淡出
      AudioFX.setTorchBurn(0, 0);
      AudioFX.setGroundTorchBurn(0);
      return;
    }
    // 优先读取引擎写入的真实疾跑标志；旧版引擎无此字段时回退为体力下降速率推断
    const sprinting =
      typeof p.isSprinting === 'boolean'
        ? p.isSprinting
        : p.dodgeTimer <= 0 && drop > 20 * dt && drop < 40 * dt;
    // 耗尽锁定期：体力跌到疾跑下限（6）后，直到恢复至 30% 前都视为见底
    if (p.stamina <= 6.5) this.exhaustLatch = true;
    else if (st01 >= 0.3) this.exhaustLatch = false;
    AudioFX.updateBody({
      dt,
      stamina01: st01,
      sprinting,
      exhausted: st01 < 0.15 || this.exhaustLatch,
      hp01: p.hp / Math.max(1, p.maxHp),
      charging01: p.isCharging ? Math.min(1, Math.max(0, p.chargeTimer / 0.65)) : 0,
    });
  }

  stepFrame(dt = FIXED_DT, draw = true, pilotInput?: PilotInput) {
    this.engine.step(dt, this.renderer.width, this.renderer.height, pilotInput);
    if (draw) this.renderer.render(this.engine);
  }

  simulate(
    seconds: number,
    steerFn?: (t: number) => PilotInput,
    opts: { draw?: boolean } = {}
  ) {
    const draw = opts.draw ?? false;
    const steps = Math.max(1, Math.round(seconds / FIXED_DT));
    const prevNoDraw = this.renderer.drawDisabled;
    if (!draw) this.renderer.setNoDraw(true);
    for (let i = 0; i < steps; i++) {
      const inp = steerFn ? steerFn(this.engine.simTime) : undefined;
      this.engine.step(FIXED_DT, this.renderer.width, this.renderer.height, inp);
      if (draw) this.renderer.render(this.engine);
    }
    this.renderer.setNoDraw(prevNoDraw);
    return this.getStats();
  }

  getStats() {
    const p = this.engine.player;
    const eq = this.engine.equip;
    return {
      backend: this.renderer.activeBackend,
      drawCalls: this.renderer.lastDrawCalls,
      entities: this.engine.enemies.length + this.engine.flares.length + this.engine.traps.length,
      mode: this.engine.mode,
      day: this.engine.day,
      phase: this.engine.phase,
      weather: this.engine.weather.kind,
      hp: Math.round(p.hp),
      stamina: Math.round(p.stamina),
      x: Math.round(p.x),
      y: Math.round(p.y),
      sprinting: p.isSprinting,
      exhausted: p.pose.exhausted,
      gait: Number(p.pose.gait.toFixed(3)),
      actionKind: p.action.kind,
      actionProgress: Number((p.action.duration > 0 ? p.action.timer / p.action.duration : 0).toFixed(3)),
      actionMoving: p.action.kind !== 'none',
      gesture: eq.gesture,
      gestureProgress: Number((eq.gDur > 0 ? eq.gT / eq.gDur : 0).toFixed(3)),
      torchInHand: eq.torchInHand,
      torchLit: eq.torchLit,
      torchFuel: Number(eq.torchFuel.toFixed(3)),
      torchFlame: Number(eq.flameH.toFixed(3)),
      torchStretch: Number(eq.flameStretch.toFixed(3)),
      torchRainExposure: Number(eq.rainExposure.toFixed(3)),
      audio: AudioFX.getMotionSnapshot(),
      containersLooted: this.engine.containersLooted,
      fps: Math.round(this.engine.fps),
    };
  }

  private exposeHeadlessHandle() {
    const api = {
      boot: async () => {
        this.handleResize();
        this.renderer.render(this.engine);
        return 'ok';
      },
      frame: (dt = FIXED_DT) => this.stepFrame(dt, true),
      sim: (seconds: number, steerFn?: (t: number) => PilotInput, opts?: { draw?: boolean }) =>
        this.simulate(seconds, steerFn, opts),
      noDraw: (on = true) => this.renderer.setNoDraw(on),
      reset: (seed = 19847, startPlaying = true) => {
        this.engine.reset(seed, startPlaying);
        this.renderer.render(this.engine);
      },
      tod: (phase: TimePhase) => {
        this.engine.jumpTimeOfDay(phase);
        this.renderer.render(this.engine);
      },
      weather: (kind: WeatherKind) => {
        this.engine.jumpWeather(kind);
        this.renderer.render(this.engine);
      },
      set: (path: string, value: unknown) => {
        if (path === 'Quality.tier' && typeof value === 'number') {
          Quality.setTier(value as 0 | 1 | 2, false);
        } else if (path.startsWith('Variants.') && typeof value === 'string') {
          Variants.set(path.slice('Variants.'.length), value);
        } else if (path === 'I18n.lang' && (value === 'zh' || value === 'en')) {
          I18n.setLang(value);
        }
        this.renderer.render(this.engine);
      },
      pilot: () => this.engine.createPilot(),
      ui: () => ({
        state: this.uiBridge?.getState() ?? this.engine.mode,
        open: this.uiBridge?.isModalOpen() ?? false,
        layerTop: () => this.uiBridge?.layerTop() ?? null,
        go: () => this.uiBridge?.startGame(),
        menu: (open: boolean) => this.uiBridge?.setMenu(open),
      }),
      shot: async () => this.canvas.toDataURL('image/png'),
      /**
       * 捕获当前主画布的宽高与 RGBA 像素数组，供无头视觉/像素对比脚本使用
       */
      capture: async () => {
        if (!this.renderer.drawDisabled) {
          this.renderer.render(this.engine);
        }
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.canvas.getContext('2d');
        const img = ctx ? ctx.getImageData(0, 0, w, h) : null;
        return {
          w,
          h,
          data: img ? img.data : new Uint8ClampedArray(0),
        };
      },
      /**
       * 临时锁定检查相机坐标（传入 null 解除锁定），配合 shot()/capture() 做同机位像素对比
       */
      view: (x?: number | null, y?: number | null) => {
        this.engine.setCameraLock(x, y);
        this.renderer.render(this.engine);
      },
      stats: () => this.getStats(),
      m: {
        Game: this.engine,
        Render: this.renderer,
        Quality,
        Variants,
        I18n,
        AudioFX,
      },
    };

    (window as unknown as { __game: typeof api }).__game = api;
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.unsubs.forEach((u) => u());
  }
}
