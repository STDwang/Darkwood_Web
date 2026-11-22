// 3-tier graphics quality + dynamic framerate governor (desktop 60fps + mobile scaling)

export type QualityTier = 0 | 1 | 2; // 0 = 流畅 Smooth, 1 = 均衡 Balanced, 2 = 高 High

export interface QualityPreset {
  tier: QualityTier;
  label: string;
  maxDpr: number;
  lightScale: number; // offscreen shadow/lightmap & WebGL2 lighting scale
  particleScale: number;
  rainScale: number;
  fogLayers: number;
  penumbraSamples: number; // 1 = hard/fast, 3 = soft, 5 = ultra soft Poisson
  puddleReflections: boolean;
  maxLights: number;
  enableGrain: boolean;
  canopySway: boolean;
}

export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  0: {
    tier: 0,
    label: '流畅',
    maxDpr: 1.0,
    lightScale: 0.5,
    particleScale: 0.45,
    rainScale: 0.38,
    fogLayers: 1,
    penumbraSamples: 1,
    puddleReflections: false,
    maxLights: 6,
    enableGrain: false,
    canopySway: false,
  },
  1: {
    tier: 1,
    label: '均衡',
    maxDpr: 1.5,
    lightScale: 0.72,
    particleScale: 0.75,
    rainScale: 0.7,
    fogLayers: 2,
    penumbraSamples: 3,
    puddleReflections: true,
    maxLights: 9,
    enableGrain: true,
    canopySway: true,
  },
  2: {
    tier: 2,
    label: '高',
    maxDpr: 2.0,
    lightScale: 0.92,
    particleScale: 1.0,
    rainScale: 1.0,
    fogLayers: 3,
    penumbraSamples: 5,
    puddleReflections: true,
    maxLights: 12,
    enableGrain: true,
    canopySway: true,
  },
};

const STORAGE_KEY = 'blackwood_quality_v2';

function detectInitialTier(): QualityTier {
  try {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('quality');
    if (forced === '0' || forced === '1' || forced === '2') {
      return Number(forced) as QualityTier;
    }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === '0' || saved === '1' || saved === '2') {
      return Number(saved) as QualityTier;
    }
  } catch {
    // ignore
  }
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  return coarse ? 1 : 2;
}

function isGovernorEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('gov') === '0' || params.has('quality')) return false;
  } catch {
    // ignore
  }
  return true;
}

let currentTier: QualityTier = detectInitialTier();
let resScale = 1.0;
let slowFrames = 0;
let smoothSeconds = 0;
const govEnabled = isGovernorEnabled();
const listeners = new Set<() => void>();

export const Quality = {
  get tier(): QualityTier {
    return currentTier;
  },
  get preset(): QualityPreset {
    return QUALITY_PRESETS[currentTier];
  },
  get dynamicScale(): number {
    return resScale;
  },

  setTier(tier: QualityTier, persist = true) {
    if (tier === currentTier && resScale === 1.0) return;
    currentTier = tier;
    resScale = 1.0;
    slowFrames = 0;
    smoothSeconds = 0;
    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, String(tier));
      } catch {
        // ignore
      }
    }
    listeners.forEach((fn) => fn());
  },

  reportFrame(frameMs: number, jsMs: number) {
    if (!govEnabled) return;
    // Ignore isolated JS GC spikes so we don't mistakenly blame GPU
    if (jsMs > 14 && frameMs - jsMs < 10) return;

    if (frameMs > 26) {
      slowFrames++;
      smoothSeconds = 0;
      if (slowFrames >= 45) {
        slowFrames = 0;
        if (resScale > 0.78) {
          resScale = 0.75;
        } else if (currentTier > 0) {
          this.setTier((currentTier - 1) as QualityTier, true);
        }
      }
    } else if (frameMs < 18.5) {
      slowFrames = Math.max(0, slowFrames - 2);
      smoothSeconds += frameMs / 1000;
      if (smoothSeconds >= 60) {
        smoothSeconds = 0;
        if (resScale < 1.0) {
          resScale = 1.0;
        }
      }
    }
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
