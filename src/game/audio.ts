// Physically-driven procedural Web Audio synthesizer (zero external audio files)
// Continuous beds: Wind, Rain (muffled roof-patter indoors vs crisp forest leaves outdoors),
// Generator Hum, Night Dread + Parameterized Transients (Thunder, Wet/Wood Footsteps, Melee, etc.)

import { clamp } from './util';

const MUTE_KEY = 'blackwood_mute_v1';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private genGain: GainNode | null = null;
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
      // ignore
    }
    this.applyMasterGain();
    this.listeners.forEach((fn) => fn());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

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

        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 18;
        comp.ratio.value = 8;
        comp.attack.value = 0.005;
        comp.release.value = 0.12;

        const master = ctx.createGain();
        master.gain.value = 0;
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

  private applyMasterGain() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const target = this.muted || this.pageHidden ? 0 : 0.72;
    this.masterGain.gain.setTargetAtTime(target, now, 0.06);
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
    // 1. Forest wind bed
    if (this.pinkBuf) {
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = this.pinkBuf;
      windSrc.loop = true;

      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 320;
      windFilter.Q.value = 1.4;

      const windGain = ctx.createGain();
      windGain.gain.value = 0.08;

      windSrc.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);
      windSrc.start();

      this.windFilter = windFilter;
      this.windGain = windGain;
    }

    // 2. Continuous Rain bed (muffles into wooden roof patter indoors!)
    if (this.whiteBuf) {
      const rainSrc = ctx.createBufferSource();
      rainSrc.buffer = this.whiteBuf;
      rainSrc.loop = true;

      const rainFilter = ctx.createBiquadFilter();
      rainFilter.type = 'bandpass';
      rainFilter.frequency.value = 1350;
      rainFilter.Q.value = 0.65;

      const rainGain = ctx.createGain();
      rainGain.gain.value = 0;

      rainSrc.connect(rainFilter);
      rainFilter.connect(rainGain);
      rainGain.connect(master);
      rainSrc.start();

      this.rainFilter = rainFilter;
      this.rainGain = rainGain;
    }

    // 3. Hideout Generator hum
    const genOsc = ctx.createOscillator();
    genOsc.type = 'sawtooth';
    genOsc.frequency.value = 54;

    const genOsc2 = ctx.createOscillator();
    genOsc2.type = 'triangle';
    genOsc2.frequency.value = 108;

    const genFilter = ctx.createBiquadFilter();
    genFilter.type = 'lowpass';
    genFilter.frequency.value = 165;

    const genGain = ctx.createGain();
    genGain.gain.value = 0;

    genOsc.connect(genFilter);
    genOsc2.connect(genFilter);
    genFilter.connect(genGain);
    genGain.connect(master);
    genOsc.start();
    genOsc2.start();

    this.genOsc = genOsc;
    this.genOsc2 = genOsc2;
    this.genGain = genGain;

    // 4. Night dread sub-drone
    const dreadOsc = ctx.createOscillator();
    dreadOsc.type = 'sine';
    dreadOsc.frequency.value = 41.2;

    const dreadGain = ctx.createGain();
    dreadGain.gain.value = 0;

    dreadOsc.connect(dreadGain);
    dreadGain.connect(master);
    dreadOsc.start();

    this.dreadOsc = dreadOsc;
    this.dreadGain = dreadGain;
  }

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

    // Rain: bright crisp pine-needle patter outside -> cozy muffled roof drum inside Hideout
    if (this.rainGain && this.rainFilter) {
      const rGain = params.rainIntensity * (params.inHideout ? 0.075 : 0.145);
      const rFreq = params.inHideout ? 520 : 1480 + params.rainIntensity * 420;
      this.rainGain.gain.setTargetAtTime(clamp(rGain, 0, 0.22), now, 0.22);
      this.rainFilter.frequency.setTargetAtTime(rFreq, now, 0.22);
    }

    if (this.genGain && this.genOsc && this.genOsc2) {
      if (params.genOn) {
        const proximity = clamp(1 - params.genDist / 520, 0, 1);
        const sputter =
          params.genFuel < 18 && Math.sin(params.time * 17) > 0.55 ? 0.25 : 1.0;
        this.genGain.gain.setTargetAtTime(proximity * proximity * 0.14 * sputter, now, 0.08);
        const freqShift = params.genFuel < 18 ? 48 + Math.sin(params.time * 11) * 5 : 54;
        this.genOsc.frequency.setTargetAtTime(freqShift, now, 0.08);
        this.genOsc2.frequency.setTargetAtTime(freqShift * 2, now, 0.08);
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

    // Distant rolling thunder noise burst
    const src = this.ctx.createBufferSource();
    src.buffer = this.pinkBuf;
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(340, now);
    filter.frequency.exponentialRampToValueAtTime(75, now + 2.4);
    filter.Q.value = 1.1;

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
      filter.frequency.value = ((surface === 'gravel' ? 1400 : 720) + wetBoost) * pitchJitter;
      filter.Q.value = wetness > 0.35 ? 0.9 : surface === 'gravel' ? 1.8 : 1.1;

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

  playSwing(heavy: boolean) {
    if (!this.ctx || !this.masterGain || !this.pinkBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.pinkBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(heavy ? 380 : 520, now);
    filter.frequency.exponentialRampToValueAtTime(140, now + 0.18);
    filter.Q.value = 1.6;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.26, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(now, Math.random() * 1.5, 0.22);
  }

  playImpact(kind: 'flesh' | 'wood' | 'metal') {
    if (!this.ctx || !this.masterGain || !this.whiteBuf || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const jitter = 0.9 + Math.random() * 0.2;

    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = kind === 'metal' ? 'square' : 'triangle';
    const startFreq = kind === 'metal' ? 620 : kind === 'wood' ? 210 : 140;
    osc.frequency.setValueAtTime(startFreq * jitter, now);
    osc.frequency.exponentialRampToValueAtTime(kind === 'metal' ? 180 : 38, now + 0.14);

    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(kind === 'metal' ? 0.18 : 0.28, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.18);

    const src = this.ctx.createBufferSource();
    src.buffer = this.whiteBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = (kind === 'wood' ? 950 : kind === 'metal' ? 2200 : 520) * jitter;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.001, now);
    ng.gain.linearRampToValueAtTime(0.22, now + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    src.connect(f);
    f.connect(ng);
    ng.connect(this.masterGain);
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
    f.frequency.value = 1800;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.2, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    src.connect(f);
    f.connect(g);
    g.connect(this.masterGain);
    src.start(now, 0, 0.6);
  }

  playMonsterSnarl(proximity: number) {
    if (!this.ctx || !this.masterGain || this.muted || this.pageHidden) return;
    const now = this.ctx.currentTime;
    const vol = clamp(proximity * 0.24, 0.04, 0.24);
    const osc = this.ctx.createOscillator();
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();

    osc.type = 'sawtooth';
    const base = 78 + Math.random() * 34;
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.exponentialRampToValueAtTime(base * 0.58, now + 0.42);

    lfo.frequency.value = 28 + Math.random() * 12;
    lfoGain.gain.value = 18;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    f.type = 'bandpass';
    f.frequency.value = 460;
    f.Q.value = 2.4;

    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

    osc.connect(f);
    f.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    lfo.start(now);
    osc.stop(now + 0.48);
    lfo.stop(now + 0.48);
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
    f.frequency.value = night ? 220 : 380;
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
