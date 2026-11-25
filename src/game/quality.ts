// 3-tier graphics quality + dynamic framerate governor (desktop 60fps + mobile scaling)
import { hydratePrefAsync, safePrefGet, safePrefSet } from './xhsBridge';

export type QualityTier = 0 | 1 | 2; // 0 = 流畅 Smooth, 1 = 均衡 Balanced, 2 = 高 High
export type ViewScaleLevel = 0 | 1 | 2 | 3; // 0 = 近景, 1 = 标准(默认更广), 2 = 广阔, 3 = 超广

export const VIEW_SCALE_PRESETS: Record<ViewScaleLevel, { level: ViewScaleLevel; label: string; factor: number }> = {
  0: { level: 0, label: '近景', factor: 1.12 },
  1: { level: 1, label: '标准', factor: 0.94 },
  2: { level: 2, label: '广阔', factor: 0.82 },
  3: { level: 3, label: '超广', factor: 0.72 },
};

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
    lightScale: 1.0,
    particleScale: 1.0,
    rainScale: 1.0,
    fogLayers: 2,
    penumbraSamples: 5,
    puddleReflections: true,
    maxLights: 12,
    enableGrain: true,
    canopySway: true,
  },
};

const STORAGE_KEY = 'blackwood_quality_v3';
const VIEW_SCALE_KEY = 'blackwood_view_scale_v1';

function detectInitialViewScale(): ViewScaleLevel {
  try {
    const saved = safePrefGet(VIEW_SCALE_KEY);
    if (saved === '0' || saved === '1' || saved === '2' || saved === '3') {
      return Number(saved) as ViewScaleLevel;
    }
  } catch {
    // ignore
  }
  return 1;
}

function hasForcedUrlQuality(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('quality');
    return forced === '0' || forced === '1' || forced === '2';
  } catch {
    return false;
  }
}

function detectInitialTier(): QualityTier {
  try {
    const params = new URLSearchParams(window.location.search);
    const forced = params.get('quality');
    if (forced === '0' || forced === '1' || forced === '2') {
      return Number(forced) as QualityTier;
    }
    const saved = safePrefGet(STORAGE_KEY);
    if (saved === '0' || saved === '1' || saved === '2') {
      return Number(saved) as QualityTier;
    }
  } catch {
    // ignore
  }
  // 默认始终开启高画质（保证清晰度与完整光影细节）
  return 2;
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
let currentViewScale: ViewScaleLevel = detectInitialViewScale();
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
  get viewScale(): ViewScaleLevel {
    return currentViewScale;
  },
  get viewZoomFactor(): number {
    return VIEW_SCALE_PRESETS[currentViewScale].factor;
  },
  get dynamicScale(): number {
    return resScale;
  },

  setViewScale(level: ViewScaleLevel, persist = true) {
    if (level === currentViewScale) return;
    currentViewScale = level;
    if (persist) {
      safePrefSet(VIEW_SCALE_KEY, String(level));
    }
    listeners.forEach((fn) => fn());
  },

  setTier(tier: QualityTier, persist = true) {
    if (tier === currentTier && resScale === 1.0) return;
    currentTier = tier;
    resScale = 1.0;
    slowFrames = 0;
    smoothSeconds = 0;
    if (persist) {
      safePrefSet(STORAGE_KEY, String(tier));
    }
    listeners.forEach((fn) => fn());
  },

  hydrateFromContainer() {
    hydratePrefAsync(VIEW_SCALE_KEY, (saved) => {
      if (saved === '0' || saved === '1' || saved === '2' || saved === '3') {
        this.setViewScale(Number(saved) as ViewScaleLevel, false);
      }
    });
    if (hasForcedUrlQuality()) return;
    hydratePrefAsync(STORAGE_KEY, (saved) => {
      if (saved === '0' || saved === '1' || saved === '2') {
        this.setTier(Number(saved) as QualityTier, false);
      }
    });
  },

  reportFrame(frameMs: number, jsMs: number) {
    if (!govEnabled) return;
    // 默认保持清晰高画质：绝不因短暂波动偷偷降低分辨率缩放或持久化降档
    if (jsMs > 14 && frameMs - jsMs < 10) return;

    if (frameMs > 44) {
      slowFrames++;
      smoothSeconds = 0;
      if (slowFrames >= 120) {
        slowFrames = 0;
        if (currentTier > 1) {
          this.setTier((currentTier - 1) as QualityTier, false);
        }
      }
    } else if (frameMs < 20) {
      slowFrames = Math.max(0, slowFrames - 2);
      smoothSeconds += frameMs / 1000;
      if (smoothSeconds >= 30) {
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
