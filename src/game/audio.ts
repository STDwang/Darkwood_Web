// 物理驱动的纯程序化 Web Audio 立体声恐怖音频引擎（零外部音频文件）
// 连续氛围层：林风、雨声（室内厚木顶闷响 vs 室外松针清脆雨打）、发电机低鸣与低油量咳喘、黑夜低频压迫
// 立体声空间路由：StereoPannerNode 左右声像 + 距离衰减 + 隔墙低通（~650Hz）闷响
// 所有运行期参数变化严格使用 setTargetAtTime 平滑过渡，末端统一经 DynamicsCompressorNode 防削波

import { clamp } from './util';

const MUTE_KEY = 'blackwood_mute_v1';

/**
 * 2D 空间音效定位与隔墙衰减参数
 */
export interface SpatialAudioOpts {
  worldX: number;
  worldY: number;
  listenerX: number;
  listenerY: number;
  /** 发声源与听者分处庇护所内外时为 true，启用 ~650Hz 低通模拟厚木墙闷响 */
  muffled?: boolean;
  /** 最大可听衰减距离（像素），默认 680 */
  maxDist?: number;
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private genGain: GainNode | null = null;
  private genFilter: BiquadFilterNode | null = null;
  private genOsc: OscillatorNode | null = null;
  private genOsc2: OscillatorNode | null = null;
  private dreadGain: GainNode | null = null;
  private dreadOsc: OscillatorNode | null = null;

  private whiteBuf: AudioBuffer | null = null;
  private pinkBuf: AudioBuffer | null = null;

  private muted = false;
  private pageHidden = false;
  private initialized = false;
  private heartbeatPhase = 0;
  private lastDragSoundAt = -10;
  private listeners = new Set<() => void>();

  constructor() {
    try {
      this.muted = window.localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.pageHidden = document.hidden;
        this.applyMasterGain();
      });
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(next: boolean) {
    this.muted = next;
    try {
      window.localStorage.setItem(MUTE_KEY, next ? '1' : '0');
    } catch {
      // 忽略无痕模式或禁存环境异常
    }
    this.applyMasterGain();
    this.listeners.forEach((fn) => fn());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 首次用户交互时解锁 AudioContext，并初始化主压缩限幅与连续氛围音床
   */
  unlock() {
    if (typeof window === 'undefined') return;
    if (!this.initialized) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      try {
        const ctx = new AudioCtx();
        this.ctx = ctx;

        // 末端软限幅压缩器，防止多声源叠加削波爆音
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.setValueAtTime(-14, ctx.currentTime);
        comp.knee.setValueAtTime(18, ctx.currentTime);
        comp.ratio.setValueAtTime(8, ctx.currentTime);
        comp.attack.setValueAtTime(0.005, ctx.currentTime);
        comp.release.setValueAtTime(0.12, ctx.currentTime);

        const master = ctx.createGain();
        master.gain.setValueAtTime(0, ctx.currentTime);
        master.connect(comp);
        comp.connect(ctx.destination);

        this.compressor = comp;
        this.masterGain = master;

        this.whiteBuf = this.buildWhiteNoiseBuffer(ctx, 2.5);
        this.pinkBuf = this.buildPinkNoiseBuffer(ctx, 3.0);

        this.setupContinuousBeds(ctx, master);
        this.initialized = true;
      } catch {
        return;
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.applyMasterGain();
  }

  /**
   * 静音与切后台统一走 setTargetAtTime 平滑过渡，杜绝咔哒爆音
   */
  private applyMasterGain() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const target = this.muted || this.pageHidden ? 0 : 0.72;
    this.masterGain.gain.setTargetAtTime(target, now, 0.06);
  }

  /**
   * 统一 2D 空间音效路由：根据声源与听者坐标计算左右声像、距离衰减与隔墙低通闷响
   */
  private createSpatialRoute(spatial?: SpatialAudioOpts): {
    input: AudioNode;
    gainScale: number;
  } {
    if (!this.ctx || !this.masterGain) {
      throw new Error('AudioContext not initialized');
    }
    if (!spatial) {
      return { input: this.masterGain, gainScale: 1 };
    }

    const now = this.ctx.currentTime;
    const dx = spatial.worldX - spatial.listenerX;
    const dy = spatial.worldY - spatial.listenerY;
    const distance = Math.hypot(dx, dy);
    const maxDist = spatial.maxDist ?? 680;
    const distLinear = clamp(1 - distance / maxDist, 0.08, 1);
    const muffleGain = spatial.muffled ? 0.78 : 1.0;
    const gainScale = distLinear * (0.35 + 0.65 * distLinear) * muffleGain;

    let tail: AudioNode = this.masterGain;

    // 左右声像 StereoPannerNode（clamp 到 [-0.88, 0.88] 保留自然头影感）
    if (typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      const pan = clamp(dx / 420, -0.88, 0.88);
      panner.pan.setValueAtTime(pan, now);
      panner.connect(tail);
      tail = panner;
    }

    // 隔墙低通滤波（截止 ~650Hz，模拟厚木墙闷响）
    if (spatial.muffled) {
      const lpf = this.ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.setValueAtTime(650, now);
      lpf.Q.setValueAtTime(0.85, now);
      lpf.connect(tail);
      tail = lpf;
    }

    return { input: tail, gainScale };
  }

  private buildWhiteNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  private buildPinkNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
      b6 = white * 0.115926;
    }
    return buf;
  }

  private setupContinuousBeds(ctx: AudioContext, master: GainNode) {
    const now = ctx.currentTime;

    // 1. 森林寒风底噪
    if (this.pinkBuf) {
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = this.pinkBuf;
      windSrc.loop = true;

      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.setValueAtTime(320, now);
      windFilter.Q.setValueAtTime(1.4, now);

      const windGain = ctx.createGain();
      windGain.gain.setValueAtTime(0.08, now);

      windSrc.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);
      windSrc.start();

      this.windFilter = windFilter;
      this.windGain = windGain;
    }

    // 2. 连续雨幕层（室外清脆松针雨打 -> 室内厚木屋顶沉闷鼓点）
    if (this.whiteBuf) {
      const rainSrc = ctx.createBufferSource();
      rainSrc.buffer = this.whiteBuf;
      rainSrc.loop = true;

      const rainFilter = ctx.createBiquadFilter();
      rainFilter.type = 'bandpass';
      rainFilter.frequency.setValueAtTime(1350, now);
      rainFilter.Q.setValueAtTime(0.65, now);

      const rainGain = ctx.createGain();
      rainGain.gain.setValueAtTime(0, now);

      rainSrc.connect(rainFilter);
      rainFilter.connect(rainGain);
      rainGain.connect(master);
      rainSrc.start();

      this.rainFilter = rainFilter;
      this.rainGain = rainGain;
    }

    // 3. 庇护所苏式柴油发电机低鸣（含可调低通滤波，供低油量咳喘调制）
    const genOsc = ctx.createOscillator();
    genOsc.type = 'sawtooth';
    genOsc.frequency.setValueAtTime(54, now);

    const genOsc2 = ctx.createOscillator();
    genOsc2.type = 'triangle';
    genOsc2.frequency.setValueAtTime(108, now);

    const genFilter = ctx.createBiquadFilter();
    genFilter.type = 'lowpass';
    genFilter.frequency.setValueAtTime(165, now);
    genFilter.Q.setValueAtTime(1.1, now);

    const genGain = ctx.createGain();
    genGain.gain.setValueAtTime(0, now);

    genOsc.connect(genFilter);
    genOsc2.connect(genFilter);
    genFilter.connect(genGain);
    genGain.connect(master);
    genOsc.start();
    genOsc2.start();

    this.genOsc = genOsc;
    this.genOsc2 = genOsc2;
    this.genFilter = genFilter;
    this.genGain = genGain;

    // 4. 黑夜低频恐惧次声底噪
    const dreadOsc = ctx.createOscillator();
    dreadOsc.type = 'sine';
    dreadOsc.frequency.setValueAtTime(41.2, now);

    const dreadGain = ctx.createGain();
    dreadGain.gain.setValueAtTime(0, now);

    dreadOsc.connect(dreadGain);
    dreadGain.connect(master);
    dreadOsc.start();

    this.dreadOsc = dreadOsc;
    this.dreadGain = dreadGain;
  }

  /**
   * 每帧物理氛围参数平滑调制（风、雨、发电机低油量咳喘、黑夜压迫、危险心跳）
   */
  updateAmbience(params: {
    dt: number;
    nightFactor: number;
    rainIntensity: number;
    inHideout: boolean;
    genDist: number;
    genOn: boolean;
    genFuel: number;
    danger: number;
    time: number;
  }) {
    if (!this.ctx || !this.initialized || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;

    if (this.windGain && this.windFilter) {
      const gust = Math.sin(params.time * 0.43) * 0.5 + Math.sin(params.time * 1.17) * 0.3;
      const outdoorScale = params.inHideout ? 0.32 : 1.0;
      const targetGain =
        (0.08 + params.nightFactor * 0.09 + params.rainIntensity * 0.06 + gust * 0.03) *
        outdoorScale;
      const targetFreq =
        (240 + params.nightFactor * 150 + params.rainIntensity * 120 + gust * 90) *
        (params.inHideout ? 0.62 : 1);
      this.windGain.gain.setTargetAtTime(clamp(targetGain, 0.02, 0.34), now, 0.25);
      this.windFilter.frequency.setTargetAtTime(clamp(targetFreq, 120, 780), now, 0.25);
    }

    // 雨声：室外清脆松针雨打 -> 室内厚木屋顶沉闷鼓点
    if (this.rainGain && this.rainFilter) {
      const rGain = params.rainIntensity * (params.inHideout ? 0.075 : 0.145);
      const rFreq = params.inHideout ? 520 : 1480 + params.rainIntensity * 420;
      this.rainGain.gain.setTargetAtTime(clamp(rGain, 0, 0.22), now, 0.22);
      this.rainFilter.frequency.setTargetAtTime(rFreq, now, 0.22);
    }

    // 发电机低鸣与低油量（< 22）间歇性熄火咳喘调制
    if (this.genGain && this.genOsc && this.genOsc2 && this.genFilter) {
      if (params.genOn) {
        const proximity = clamp(1 - params.genDist / 520, 0, 1);
        let gainMod = 1.0;
        let baseFreq = 54;
        let filterFreq = 165;

        if (params.genFuel < 22) {
          // 越接近耗尽，咳喘幅度与频次越剧烈
          const severity = clamp((22 - params.genFuel) / 22, 0.2, 1);
          const slowCough = Math.sin(params.time * 2.4) * 0.5 + 0.5;
          const misfirePulse = Math.sin(params.time * 15.8 + Math.sin(params.time * 3.1) * 1.4);
          const isStalling = slowCough > 0.52 && misfirePulse > 0.28;
          gainMod = isStalling ? 0.22 + (1 - severity) * 0.3 : 0.85 + Math.sin(params.time * 9.2) * 0.15;
          baseFreq = isStalling
            ? 38 + (1 - severity) * 6 + Math.sin(params.time * 19) * 2.5
            : 51 + Math.sin(params.time * 11.5) * 3.5;
          filterFreq = isStalling ? 105 : 155 + severity * 38;
        }

        const wallAtten = params.inHideout ? 1.0 : 0.65;
        this.genGain.gain.setTargetAtTime(
          proximity * proximity * 0.145 * gainMod * wallAtten,
          now,
          0.055
        );
        this.genOsc.frequency.setTargetAtTime(baseFreq, now, 0.055);
        this.genOsc2.frequency.setTargetAtTime(baseFreq * 2, now, 0.055);
        this.genFilter.frequency.setTargetAtTime(
          params.inHideout ? filterFreq : filterFreq * 0.72,
          now,
          0.08
        );
      } else {
        this.genGain.gain.setTargetAtTime(0, now, 0.12);
      }
    }

    if (this.dreadGain && this.dreadOsc) {
      const intensity = clamp(params.nightFactor * 0.35 + params.danger * 0.65, 0, 1);
      this.dreadGain.gain.setTargetAtTime(intensity * 0.13, now, 0.3);
      this.dreadOsc.frequency.setTargetAtTime(38 + params.danger * 9, now, 0.3);
    }

    if (params.danger > 0.25) {
      const rate = 1.15 + params.danger * 1.45;
      this.heartbeatPhase += params.dt * rate;
      if (this.heartbeatPhase >= 1) {
        this.heartbeatPhase -= 1;
        this.playHeartbeat(params.danger);
      }
    } else {
      this.heartbeatPhase = 0;
    }
  }

  playThunder(intensity = 0.8) {
    if (!this.ctx || !this.masterGain || !this.pinkBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const vol = clamp(intensity * 0.42, 0.12, 0.45);

    const src = this.ctx.createBufferSource();
    src.buffer = this.pinkBuf;
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(340, now);
    filter.frequency.exponentialRampToValueAtTime(75, now + 2.4);
    filter.Q.setValueAtTime(1.1, now);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.09);
    g.gain.exponentialRampToValueAtTime(vol * 0.48, now + 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 2.8);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(now, Math.random());
    src.stop(now + 2.85);
  }

  private playHeartbeat(intensity: number) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const vol = clamp(intensity * 0.26, 0.04, 0.26);

    const pulse = (offset: number, freq: number, gainPeak: number) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + offset);
      osc.frequency.exponentialRampToValueAtTime(28, now + offset + 0.14);

      g.gain.setValueAtTime(0.0001, now + offset);
      g.gain.linearRampToValueAtTime(gainPeak, now + offset + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);

      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(now + offset);
      osc.stop(now + offset + 0.18);
    };

    pulse(0, 68, vol);
    pulse(0.17, 56, vol * 0.7);
  }

  playFootstep(surface: 'wood' | 'mud' | 'gravel', sprint: boolean, wetness = 0) {
    if (!this.ctx || !this.masterGain || !this.whiteBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const pitchJitter = 0.88 + Math.random() * 0.24;

    if (surface === 'wood') {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(125 * pitchJitter, now);
      osc.frequency.exponentialRampToValueAtTime(52, now + 0.08);
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(sprint ? 0.14 : 0.08, now + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.1);
    } else {
      const src = this.ctx.createBufferSource();
      src.buffer = this.whiteBuf;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      const wetBoost = wetness > 0.35 ? 650 : 0;
      filter.frequency.setValueAtTime(
        ((surface === 'gravel' ? 1400 : 720) + wetBoost) * pitchJitter,
        now
      );
      filter.Q.setValueAtTime(wetness > 0.35 ? 0.9 : surface === 'gravel' ? 1.8 : 1.1, now);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime((sprint ? 0.12 : 0.065) * (1 + wetness * 0.35), now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);

      src.connect(filter);
      filter.connect(g);
      g.connect(this.masterGain);
      src.start(now, Math.random() * 1.4, 0.11);
    }
  }

  /**
   * 轻击短促挥风 vs 蓄力重击沉重低频破风声
   */
  playChargeSwing(heavy: boolean) {
    if (!this.ctx || !this.masterGain || !this.pinkBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const dur = heavy ? 0.28 : 0.16;

    // 空气切割噪声层
    const src = this.ctx.createBufferSource();
    src.buffer = this.pinkBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(heavy ? 340 : 640, now);
    filter.frequency.exponentialRampToValueAtTime(heavy ? 95 : 210, now + dur);
    filter.Q.setValueAtTime(heavy ? 1.35 : 1.8, now);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(heavy ? 0.34 : 0.22, now + (heavy ? 0.045 : 0.022));
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.02);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(now, Math.random() * 1.5, dur + 0.04);

    // 蓄力重击额外叠加沉重低频压迫感
    if (heavy) {
      const sub = this.ctx.createOscillator();
      const sg = this.ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(132, now);
      sub.frequency.exponentialRampToValueAtTime(44, now + 0.22);

      sg.gain.setValueAtTime(0.001, now);
      sg.gain.linearRampToValueAtTime(0.24, now + 0.03);
      sg.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

      sub.connect(sg);
      sg.connect(this.masterGain);
      sub.start(now);
      sub.stop(now + 0.27);
    }
  }

  /**
   * 兼容旧接口：转发至 playChargeSwing
   */
  playSwing(heavy: boolean) {
    this.playChargeSwing(heavy);
  }

  /**
   * 闪避急退的衣料与空气破风声
   */
  playDodgeWhoosh() {
    if (!this.ctx || !this.masterGain || !this.whiteBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;

    const src = this.ctx.createBufferSource();
    src.buffer = this.whiteBuf;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1150, now);
    filter.frequency.exponentialRampToValueAtTime(310, now + 0.16);
    filter.Q.setValueAtTime(1.25, now);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.18, now + 0.022);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.17);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(now, Math.random() * 1.2, 0.19);
  }

  /**
   * 重型家具在旧木地板上拖拽时的低沉摩擦木响（内置 0.18s 节流避免高频堆叠）
   */
  playFurnitureDrag(speed01: number) {
    if (!this.ctx || !this.masterGain || !this.pinkBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    if (now - this.lastDragSoundAt < 0.18) return;
    this.lastDragSoundAt = now;

    const intensity = clamp(speed01, 0.15, 1);
    const pitch = 0.86 + Math.random() * 0.28;

    // 1. 粗糙木地板摩擦噪声
    const src = this.ctx.createBufferSource();
    src.buffer = this.pinkBuf;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime((240 + intensity * 140) * pitch, now);
    bp.frequency.linearRampToValueAtTime((180 + intensity * 90) * pitch, now + 0.21);
    bp.Q.setValueAtTime(1.9, now);

    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.001, now);
    ng.gain.linearRampToValueAtTime(0.16 * intensity, now + 0.035);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    src.connect(bp);
    bp.connect(ng);
    ng.connect(this.masterGain);
    src.start(now, Math.random() * 1.6, 0.24);

    // 2. 厚重木腿低频共鸣咯吱声
    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(92 * pitch, now);
    osc.frequency.exponentialRampToValueAtTime(58 * pitch, now + 0.19);

    og.gain.setValueAtTime(0.001, now);
    og.gain.linearRampToValueAtTime(0.11 * intensity, now + 0.03);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.20);

    osc.connect(og);
    og.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  /**
   * 门窗木板诡异刮擦声（供怪物 stalk 窥伺期与开局 6 秒钩子使用，支持立体声方位与隔墙闷响）
   */
  playWoodScrape(spatial?: SpatialAudioOpts) {
    if (!this.ctx || !this.masterGain || !this.pinkBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const scale = clamp(route.gainScale, 0.08, 1);
    const jitter = 0.9 + Math.random() * 0.22;

    // 1. 利爪/指甲划过潮湿旧木板的刺耳带通噪声
    const src = this.ctx.createBufferSource();
    src.buffer = this.pinkBuf;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(980 * jitter, now);
    filter.frequency.linearRampToValueAtTime(460 * jitter, now + 0.22);
    filter.frequency.linearRampToValueAtTime(820 * jitter, now + 0.42);
    filter.frequency.exponentialRampToValueAtTime(320 * jitter, now + 0.56);
    filter.Q.setValueAtTime(4.2, now);

    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.001, now);
    ng.gain.linearRampToValueAtTime(0.24 * scale, now + 0.06);
    ng.gain.linearRampToValueAtTime(0.14 * scale, now + 0.28);
    ng.gain.linearRampToValueAtTime(0.20 * scale, now + 0.42);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.58);

    src.connect(filter);
    filter.connect(ng);
    ng.connect(route.input);
    src.start(now, Math.random() * 1.4, 0.62);

    // 2. 木板箱体低沉共鸣颤振
    const osc = this.ctx.createOscillator();
    const lfo = this.ctx.createOscillator();
    const lfoG = this.ctx.createGain();
    const og = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(172 * jitter, now);
    osc.frequency.exponentialRampToValueAtTime(118 * jitter, now + 0.54);

    lfo.frequency.setValueAtTime(22 + Math.random() * 8, now);
    lfoG.gain.setValueAtTime(14, now);
    lfo.connect(lfoG);
    lfoG.connect(osc.frequency);

    const bodyFilter = this.ctx.createBiquadFilter();
    bodyFilter.type = 'bandpass';
    bodyFilter.frequency.setValueAtTime(310, now);
    bodyFilter.Q.setValueAtTime(2.6, now);

    og.gain.setValueAtTime(0.001, now);
    og.gain.linearRampToValueAtTime(0.12 * scale, now + 0.08);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.56);

    osc.connect(bodyFilter);
    bodyFilter.connect(og);
    og.connect(route.input);
    osc.start(now);
    lfo.start(now);
    osc.stop(now + 0.58);
    lfo.stop(now + 0.58);
  }

  /**
   * 撞击/破门/捕兽夹/近战命中音效（支持 2D 立体声方位与隔墙低通衰减）
   */
  playImpact(kind: 'flesh' | 'wood' | 'metal', spatial?: SpatialAudioOpts) {
    if (!this.ctx || !this.masterGain || !this.whiteBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const scale = clamp(route.gainScale, 0.08, 1);
    const jitter = 0.9 + Math.random() * 0.2;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = kind === 'metal' ? 'square' : 'triangle';
    const startFreq = kind === 'metal' ? 620 : kind === 'wood' ? 210 : 140;
    osc.frequency.setValueAtTime(startFreq * jitter, now);
    osc.frequency.exponentialRampToValueAtTime(kind === 'metal' ? 180 : 38, now + 0.14);

    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime((kind === 'metal' ? 0.18 : 0.28) * scale, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    osc.connect(g);
    g.connect(route.input);
    osc.start(now);
    osc.stop(now + 0.18);

    const src = this.ctx.createBufferSource();
    src.buffer = this.whiteBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime((kind === 'wood' ? 950 : kind === 'metal' ? 2200 : 520) * jitter, now);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.001, now);
    ng.gain.linearRampToValueAtTime(0.22 * scale, now + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    src.connect(f);
    f.connect(ng);
    ng.connect(route.input);
    src.start(now, Math.random(), 0.13);
  }

  playClick(on: boolean) {
    if (!this.ctx || !this.masterGain || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(on ? 1450 : 980, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.03);
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.11, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.04);
  }

  playFlareHiss() {
    if (!this.ctx || !this.masterGain || !this.whiteBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.whiteBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.setValueAtTime(1800, now);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.2, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    src.connect(f);
    f.connect(g);
    g.connect(this.masterGain);
    src.start(now, 0, 0.6);
  }

  /**
   * 怪物低吼（支持 2D 立体声方位声像与隔墙闷响）
   */
  playMonsterSnarl(proximity: number, spatial?: SpatialAudioOpts) {
    if (!this.ctx || !this.masterGain || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const route = this.createSpatialRoute(spatial);
    const effectiveProx = spatial ? Math.max(proximity * 0.5, route.gainScale) : proximity;
    const vol = clamp(effectiveProx * 0.25, 0.04, 0.25);

    const osc = this.ctx.createOscillator();
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();

    osc.type = 'sawtooth';
    const base = 78 + Math.random() * 34;
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.exponentialRampToValueAtTime(base * 0.58, now + 0.42);

    lfo.frequency.setValueAtTime(28 + Math.random() * 12, now);
    lfoGain.gain.setValueAtTime(18, now);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    f.type = 'bandpass';
    f.frequency.setValueAtTime(460, now);
    f.Q.setValueAtTime(2.4, now);

    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

    osc.connect(f);
    f.connect(g);
    g.connect(route.input);
    osc.start(now);
    lfo.start(now);
    osc.stop(now + 0.48);
    lfo.stop(now + 0.48);
  }

  /**
   * 拾取/安装信号中继零件与破晓撤离时的苏式短波无线电嗡鸣与清脆提示音
   */
  playRelayChime(complete: boolean) {
    if (!this.ctx || !this.masterGain || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;

    // 1. 短波无线电静电脉冲底噪
    if (this.whiteBuf) {
      const staticSrc = this.ctx.createBufferSource();
      staticSrc.buffer = this.whiteBuf;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2150, now);
      bp.Q.setValueAtTime(2.8, now);
      const sg = this.ctx.createGain();
      const sDur = complete ? 0.55 : 0.24;
      sg.gain.setValueAtTime(0.001, now);
      sg.gain.linearRampToValueAtTime(0.055, now + 0.03);
      sg.gain.exponentialRampToValueAtTime(0.0001, now + sDur);
      staticSrc.connect(bp);
      bp.connect(sg);
      sg.connect(this.masterGain);
      staticSrc.start(now, Math.random(), sDur + 0.04);
    }

    // 2. 苏式短波载波嗡鸣
    const hum = this.ctx.createOscillator();
    const humG = this.ctx.createGain();
    hum.type = 'sine';
    hum.frequency.setValueAtTime(complete ? 220 : 196, now);
    hum.frequency.exponentialRampToValueAtTime(complete ? 261.6 : 220, now + (complete ? 0.65 : 0.28));
    humG.gain.setValueAtTime(0.001, now);
    humG.gain.linearRampToValueAtTime(0.065, now + 0.04);
    humG.gain.exponentialRampToValueAtTime(0.0001, now + (complete ? 0.72 : 0.3));
    hum.connect(humG);
    humG.connect(this.masterGain);
    hum.start(now);
    hum.stop(now + (complete ? 0.75 : 0.32));

    // 3. 清脆无线电应答电码音列
    const notes = complete ? [523.25, 659.25, 783.99, 1046.5] : [622.25, 880.0];
    const step = complete ? 0.11 : 0.09;
    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const t0 = now + 0.04 + idx * step;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.001, t0);
      g.gain.linearRampToValueAtTime(complete ? 0.12 : 0.095, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (complete ? 0.42 : 0.24));
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + (complete ? 0.45 : 0.26));
    });
  }

  playLootChime() {
    if (!this.ctx || !this.masterGain || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const notes = [330, 440];
    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.07);
      g.gain.setValueAtTime(0.001, now + idx * 0.07);
      g.gain.linearRampToValueAtTime(0.09, now + idx * 0.07 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.07 + 0.22);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(now + idx * 0.07);
      osc.stop(now + idx * 0.07 + 0.24);
    });
  }

  playPhaseHorn(night: boolean) {
    if (!this.ctx || !this.masterGain || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const f = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(night ? 65.4 : 110, now);
    osc.frequency.exponentialRampToValueAtTime(night ? 58.2 : 146.8, now + 1.4);
    f.type = 'lowpass';
    f.frequency.setValueAtTime(night ? 220 : 380, now);
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.16, now + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
    osc.connect(f);
    f.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 1.65);
  }
}

export const AudioFX = new SoundEngine();
