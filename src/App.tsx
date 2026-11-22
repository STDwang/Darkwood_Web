import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Flame,
  Flashlight,
  Hammer,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
  Sunset,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  BandageInkIcon,
  FlareInkIcon,
  ResourceInkIcon,
  TrapInkIcon,
  WeatherInkIcon,
} from './components/InkIcons';
import GameHud from './components/GameHud';
import { MinimapExploreState } from './components/Minimap';
import { AudioFX } from './game/audio';
import { I18n, Lang } from './game/i18n';
import { Quality, QualityTier } from './game/quality';
import { GameRuntime } from './game/runtime';
import { HudSnapshot, ResourceKey, TimePhase, WeatherKind } from './game/types';
import { Variants } from './game/variants';
import { CRAFT_RECIPES } from './game/world';

type LayerId = 'pause' | 'craft' | 'journal' | 'settings' | 'controls' | 'dev';

const RESOURCE_META: Array<{ key: ResourceKey; label: string; color: string }> = [
  { key: 'wood', label: '木材', color: '#cca16f' },
  { key: 'scrap', label: '废铁', color: '#a4b0b6' },
  { key: 'fuel', label: '燃油', color: '#df8158' },
  { key: 'herbs', label: '布草', color: '#8dbb88' },
  { key: 'battery', label: '电池', color: '#e2cb77' },
  { key: 'essence', label: '幽光菇', color: '#7ad8c5' },
];

const LANDMARK_MAP_NODES = [
  { name: '坠毁货车', x: 46, y: 42 },
  { name: '废弃锯木厂', x: 214, y: 46 },
  { name: '猎人营地', x: 48, y: 148 },
  { name: '枯林祭坛', x: 212, y: 146 },
];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<GameRuntime | null>(null);

  const [veilHidden, setVeilHidden] = useState(false);
  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [layers, setLayers] = useState<LayerId[]>([]);
  const [lang, setLang] = useState<Lang>(I18n.lang);
  const [qualityTier, setQualityTier] = useState<QualityTier>(Quality.tier);
  const [muted, setMuted] = useState<boolean>(AudioFX.isMuted);
  const [variantTick, setVariantTick] = useState(0);
  const [isTouch, setIsTouch] = useState(false);
  const isDev = Variants.isDevMode();

  const moveStickRef = useRef<{ id: number | null; ox: number; oy: number }>({
    id: null,
    ox: 0,
    oy: 0,
  });
  const aimStickRef = useRef<{ id: number | null; ox: number; oy: number }>({
    id: null,
    ox: 0,
    oy: 0,
  });
  const [moveKnob, setMoveKnob] = useState({ x: 0, y: 0 });
  const [aimKnob, setAimKnob] = useState({ x: 0, y: 0 });

  // 小地图探索网格（UI 层自维护，跨 HUD 卸载/重挂保留；Minimap 检测到 engine.world 更换即新开局重置）
  const exploreRef = useRef<MinimapExploreState | null>(null);

  const layersRef = useRef<LayerId[]>(layers);
  layersRef.current = layers;
  // 记录由代码主动调用 window.history.back() 触发的 popstate 次数，避免嵌套弹层被重复弹出
  const ignorePopStateRef = useRef(0);

  useEffect(() => {
    const u1 = I18n.subscribe(() => setLang(I18n.lang));
    const u2 = Quality.subscribe(() => setQualityTier(Quality.tier));
    const u3 = AudioFX.subscribe(() => setMuted(AudioFX.isMuted));
    const u4 = Variants.subscribe(() => setVariantTick((n) => n + 1));
    const coarse = window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
    setIsTouch(Boolean(coarse));
    return () => {
      u1();
      u2();
      u3();
      u4();
    };
  }, []);

  const syncEngineHold = useCallback((nextLayers: LayerId[]) => {
    const rt = runtimeRef.current;
    if (!rt) return;
    if (rt.engine.mode === 'title' || rt.engine.mode === 'dead' || rt.engine.mode === 'victory') return;
    if (nextLayers.length > 0 && rt.engine.mode === 'play') {
      rt.engine.setMode('hold');
    } else if (nextLayers.length === 0 && rt.engine.mode === 'hold') {
      rt.engine.setMode('play');
    }
  }, []);

  const pushLayer = useCallback(
    (id: LayerId) => {
      const prev = layersRef.current;
      if (prev[prev.length - 1] === id) return;
      const next = [...prev.filter((l) => l !== id), id];
      layersRef.current = next;
      setLayers(next);
      syncEngineHold(next);
      try {
        window.history.pushState({ blackwoodLayer: id }, '');
      } catch {
        // 忽略沙盒环境 history 异常
      }
    },
    [syncEngineHold]
  );

  const popLayer = useCallback(
    (fromPopState = false) => {
      const prev = layersRef.current;
      if (prev.length === 0) return;
      const next = prev.slice(0, -1);
      layersRef.current = next;
      setLayers(next);
      syncEngineHold(next);
      if (!fromPopState && window.history.state?.blackwoodLayer) {
        ignorePopStateRef.current += 1;
        try {
          window.history.back();
        } catch {
          ignorePopStateRef.current = Math.max(0, ignorePopStateRef.current - 1);
        }
      }
    },
    [syncEngineHold]
  );

  const clearLayers = useCallback(() => {
    layersRef.current = [];
    setLayers([]);
    syncEngineHold([]);
  }, [syncEngineHold]);

  const startSurvival = useCallback(() => {
    const rt = runtimeRef.current;
    if (!rt) return;
    AudioFX.unlock();
    clearLayers();
    rt.engine.startPlay();
  }, [clearLayers]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rt = new GameRuntime(canvas, () => {
      requestAnimationFrame(() => setVeilHidden(true));
    });
    runtimeRef.current = rt;

    rt.engine.setWorkbenchCallback(() => {
      pushLayer('craft');
    });

    rt.setUiBridge({
      getState: () => rt.engine.mode,
      isModalOpen: () => layersRef.current.length > 0,
      layerTop: () => layersRef.current[layersRef.current.length - 1] ?? null,
      startGame: () => startSurvival(),
      setMenu: (open: boolean) => {
        if (open) pushLayer('pause');
        else clearLayers();
      },
    });

    const unsubHud = rt.engine.subscribeHud((snap) => setHud(snap));

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.repeat &&
        ['KeyF', 'KeyC', 'KeyJ', 'KeyQ', 'KeyR', 'Tab', 'Escape', 'Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(
          e.code
        )
      ) {
        return;
      }

      if (e.code === 'Escape') {
        e.preventDefault();
        if (layersRef.current.length > 0) {
          popLayer();
        } else if (rt.engine.mode === 'play') {
          pushLayer('pause');
        }
        return;
      }

      if (rt.engine.mode === 'play' || rt.engine.mode === 'hold') {
        if (e.code === 'KeyC' || e.code === 'Tab') {
          e.preventDefault();
          if (layersRef.current[layersRef.current.length - 1] === 'craft') popLayer();
          else pushLayer('craft');
          return;
        }
        if (e.code === 'KeyJ') {
          e.preventDefault();
          if (layersRef.current[layersRef.current.length - 1] === 'journal') popLayer();
          else pushLayer('journal');
          return;
        }
      }

      if (rt.engine.mode !== 'play') return;

      AudioFX.unlock();
      rt.engine.keys.add(e.code);

      if (e.code === 'KeyF') {
        rt.engine.toggleFlashlight();
      } else if (e.code === 'KeyE' && !e.repeat) {
        rt.engine.triggerInstantInteract();
      } else if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        rt.engine.triggerDodge();
      } else if (e.code === 'KeyQ') {
        // R3：火把 ⇄ 手枪（切枪时火把丢到身侧，靠近按 E 捡回）
        rt.engine.toggleWeapon();
      } else if (e.code === 'KeyR') {
        // R3：手枪换弹 / 火把模式下用木材+燃油重新点燃
        rt.engine.reloadWeapon();
      } else if (e.code === 'Digit1') {
        rt.engine.useQuickSlot(1);
      } else if (e.code === 'Digit2') {
        rt.engine.useQuickSlot(2);
      } else if (e.code === 'Digit3') {
        rt.engine.useQuickSlot(3);
      } else if (e.code === 'Digit4') {
        rt.engine.useQuickSlot(4);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      rt.engine.keys.delete(e.code);
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      rt.engine.mouseScreenX = e.clientX - rect.left;
      rt.engine.mouseScreenY = e.clientY - rect.top;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (rt.engine.mode !== 'play') return;
      if (e.target !== canvas) return;
      AudioFX.unlock();
      if (e.button === 0) {
        rt.engine.mouseDownLeft = true;
        rt.engine.beginAttackCharge();
      } else if (e.button === 2) {
        rt.engine.throwFlare();
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        rt.engine.mouseDownLeft = false;
        rt.engine.releaseAttackCharge();
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      if (e.target === canvas) e.preventDefault();
    };

    const onPopState = () => {
      if (ignorePopStateRef.current > 0) {
        ignorePopStateRef.current -= 1;
        return;
      }
      if (layersRef.current.length > 0) {
        popLayer(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('popstate', onPopState);

    return () => {
      unsubHud();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('popstate', onPopState);
      rt.destroy();
      runtimeRef.current = null;
    };
  }, [clearLayers, popLayer, pushLayer, startSurvival]);

  // Touch Virtual Sticks
  const onMoveTouchStart = (e: React.TouchEvent) => {
    if (moveStickRef.current.id !== null) return;
    AudioFX.unlock();
    const touch = e.changedTouches[0];
    moveStickRef.current = { id: touch.identifier, ox: touch.clientX, oy: touch.clientY };
  };

  const onMoveTouchMove = (e: React.TouchEvent) => {
    const st = moveStickRef.current;
    if (st.id === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier !== st.id) continue;
      const dx = touch.clientX - st.ox;
      const dy = touch.clientY - st.oy;
      const maxR = 44;
      const mag = Math.hypot(dx, dy);
      const scale = mag > maxR ? maxR / mag : 1;
      const nx = (dx * scale) / maxR;
      const ny = (dy * scale) / maxR;
      setMoveKnob({ x: nx * 30, y: ny * 30 });
      if (runtimeRef.current) {
        runtimeRef.current.engine.touchMoveX = nx;
        runtimeRef.current.engine.touchMoveY = ny;
        runtimeRef.current.engine.touchSprint = mag > maxR * 0.92;
      }
    }
  };

  const onMoveTouchEnd = (e: React.TouchEvent) => {
    const st = moveStickRef.current;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === st.id) {
        moveStickRef.current.id = null;
        setMoveKnob({ x: 0, y: 0 });
        if (runtimeRef.current) {
          runtimeRef.current.engine.touchMoveX = 0;
          runtimeRef.current.engine.touchMoveY = 0;
          runtimeRef.current.engine.touchSprint = false;
        }
      }
    }
  };

  const onAimTouchStart = (e: React.TouchEvent) => {
    if (aimStickRef.current.id !== null) return;
    AudioFX.unlock();
    const touch = e.changedTouches[0];
    aimStickRef.current = { id: touch.identifier, ox: touch.clientX, oy: touch.clientY };
    if (runtimeRef.current) runtimeRef.current.engine.touchAimActive = true;
  };

  const onAimTouchMove = (e: React.TouchEvent) => {
    const st = aimStickRef.current;
    if (st.id === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier !== st.id) continue;
      const dx = touch.clientX - st.ox;
      const dy = touch.clientY - st.oy;
      const maxR = 44;
      const mag = Math.hypot(dx, dy);
      const scale = mag > maxR ? maxR / mag : 1;
      const nx = (dx * scale) / maxR;
      const ny = (dy * scale) / maxR;
      setAimKnob({ x: nx * 30, y: ny * 30 });
      if (runtimeRef.current) {
        runtimeRef.current.engine.touchAimX = nx;
        runtimeRef.current.engine.touchAimY = ny;
      }
    }
  };

  const onAimTouchEnd = (e: React.TouchEvent) => {
    const st = aimStickRef.current;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === st.id) {
        aimStickRef.current.id = null;
        setAimKnob({ x: 0, y: 0 });
        if (runtimeRef.current) {
          runtimeRef.current.engine.touchAimActive = false;
        }
      }
    }
  };

  const topLayer = layers[layers.length - 1] ?? null;
  const t = (key: string, vars?: Record<string, string | number>) => {
    void lang;
    void variantTick;
    return I18n.t(key, vars);
  };

  const usePaperUI = Variants.val.paper !== 'a';
  const hudCls = usePaperUI ? 'paper-hud' : 'clean-hud';
  const panelCls = usePaperUI ? 'paper-panel' : 'clean-panel';
  const cardCls = usePaperUI ? 'paper-card' : 'clean-card';

  const phaseIcon =
    hud?.phase === 'night' ? (
      <Moon className="w-4 h-4 text-[#a9b8cf]" />
    ) : hud?.phase === 'dusk' ? (
      <Sunset className="w-4 h-4 text-[#d88959]" />
    ) : (
      <Sun className="w-4 h-4 text-[#d6be86]" />
    );

  const phaseLabel =
    hud?.phase === 'night' ? t('黑夜') : hud?.phase === 'dusk' ? t('黄昏') : t('白昼');

  const weatherLabel =
    hud?.weather === 'storm' ? t('雷暴') : hud?.weather === 'drizzle' ? t('细雨') : t('浓雾');

  const hpStatus =
    !hud || hud.hp > 60 ? t('状态正常') : hud.hp > 28 ? t('受伤') : t('濒危');

  // Map player world coord (-1300..1300) onto the hand-drawn journal sketch (260 x 190)
  const sketchPx = hud ? 130 + (hud.playerX / 1300) * 105 : 130;
  const sketchPy = hud ? 95 + (hud.playerY / 1300) * 76 : 95;

  return (
    <div id="app" className="bg-[#070807] text-[#e7e2d8]">
      {/* 游戏画布：骨白圆环准星 CSS 光标（标题层/弹层覆盖画布时自动回到系统指针） */}
      <canvas id="view" ref={canvasRef} className="block w-full h-full ember-cursor" />

      {/* Smooth pitch-black #veil curtain */}
      <div
        id="veil"
        className={`pointer-events-none fixed inset-0 z-50 bg-[#070807] ${
          veilHidden ? 'opacity-0' : 'opacity-100'
        }`}
      />

      {/* TITLE SCREEN OVER LIVE RAINY FOREST */}
      {/* 电影开场：title-seq 系列按 场景(#veil 淡出) → 标题 → 副标题 → 按钮 依次显影，总时长 ≤ 2.2s；
          只动画透明度/模糊，按钮从第一帧起即可点击（详见 index.css） */}
      {hud?.mode === 'title' && (
        <>
          <div
            id="shade"
            className="pointer-events-none fixed inset-0 z-10 bg-gradient-to-b from-black/75 via-black/22 to-black/88"
          />
          <div
            className="fixed inset-0 z-20 flex flex-col justify-between"
            style={{
              paddingLeft: 'var(--gl)',
              paddingRight: 'var(--gr)',
              paddingTop: 'var(--gt)',
              paddingBottom: 'var(--gb)',
            }}
          >
            <div className="title-seq title-seq--chrome flex items-center justify-between">
              <span className="text-xs tracking-widest text-[#a89f8e]/75 whitespace-nowrap">
                {lang === 'zh' ? '东欧暗林恐怖生存 · 实时法线光影' : 'Eastern European Survival Horror'}
              </span>
              <div className="flex items-center gap-3">
                {isDev && (
                  <button
                    type="button"
                    onClick={() => pushLayer('dev')}
                    className="min-h-[44px] px-3 text-xs font-medium text-[#c9b083] hover:text-[#ecdcbc] transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5"
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    <span>Variants</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    AudioFX.unlock();
                    AudioFX.setMuted(!muted);
                  }}
                  aria-label={t('声音')}
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[#b4ab9a] hover:text-[#ecdcbc] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#b87b3b]/80"
                >
                  {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="max-w-xl my-auto">
              {/* 标题：系统宋体/衬线 + 宽字距骨白，SVG 噪声蒙版做旧（外层负责模糊显影动画） */}
              <div className="title-seq title-seq--1">
                <h1
                  className={`title-mark ${lang === 'en' ? 'is-latin' : ''}`}
                  style={{ textWrap: 'balance' }}
                >
                  <span className="title-mark__ink">{t('幽林余烬')}</span>
                </h1>
              </div>
              <p className="title-sub title-seq title-seq--2">{t('BLACKWOOD EMBER')}</p>
              <p className="title-seq title-seq--3 mt-5 text-sm sm:text-base text-[#b9af9c]/85 max-w-md leading-relaxed">
                {t('在黑暗吞噬庇护所前，搜集一切能活下去的东西。')}
              </p>

              {/* 克制的文字按钮：左侧余烬点/短横线，悬停余烬微光 + 字距展开；文案与可访问名称保持不变 */}
              <div className="title-seq title-seq--4 mt-8 flex flex-wrap items-center gap-x-6 gap-y-1 sm:gap-x-8">
                <button
                  type="button"
                  onClick={startSurvival}
                  className={`title-btn title-btn--primary ${lang === 'en' ? 'is-latin' : ''}`}
                >
                  <span className="title-btn__ember" aria-hidden="true" />
                  <span>{t('开始求生')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => pushLayer('controls')}
                  className={`title-btn ${lang === 'en' ? 'is-latin' : ''}`}
                >
                  <span className="title-btn__ember" aria-hidden="true" />
                  <span>{t('操作说明')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => pushLayer('settings')}
                  className={`title-btn ${lang === 'en' ? 'is-latin' : ''}`}
                >
                  <span className="title-btn__ember" aria-hidden="true" />
                  <span>{t('设置')}</span>
                </button>
              </div>
            </div>

            <div className="title-seq title-seq--chrome flex items-center justify-between text-xs text-[#91897a] gap-3">
              <span className="hidden sm:inline">
                {lang === 'zh'
                  ? 'WASD 移动 · 鼠标照明 · 长按 E 搜刮与加固 · 左键挥击 · 右键照明弹 · J 翻阅日志'
                  : 'WASD Move · Mouse Light · Hold E Loot & Barricade · LMB Swing · RMB Flare · J Journal'}
              </span>
              <span className="sm:hidden">
                {lang === 'zh' ? '双摇杆移动照明 · 右侧搜刮攻击' : 'Twin-Stick Move & Aim'}
              </span>
              <span className="font-mono-num whitespace-nowrap shrink-0">
                {I18n.lang === 'zh' ? '中文' : 'EN'} · {t(Quality.preset.label)}
              </span>
            </div>
          </div>
        </>
      )}

      {/* 电影遮幅黑边：仅标题页展开，开局（mode 离开 title）时 scaleY 平滑收起；纯装饰、不拦截点击 */}
      {hud && (
        <>
          <div
            aria-hidden="true"
            className={`letterbox letterbox--top ${hud.mode === 'title' ? 'is-on' : ''}`}
          />
          <div
            aria-hidden="true"
            className={`letterbox letterbox--bottom ${hud.mode === 'title' ? 'is-on' : ''}`}
          />
        </>
      )}

      {/* ACTIVE PLAY / HOLD HUD —— paper=b：第二轮"融入世界的旧物"HUD + 实时小地图（独立组件） */}
      {hud && (hud.mode === 'play' || hud.mode === 'hold') && usePaperUI && (
        <GameHud
          hud={hud}
          t={t}
          isDev={isDev}
          runtimeRef={runtimeRef}
          exploreRef={exploreRef}
          onOpenLayer={pushLayer}
        />
      )}

      {/* paper=a 对照组：保留旧版卡片式 HUD（暗色极简 clean-hud 样式），供 A/B 截图比对 */}
      {hud && (hud.mode === 'play' || hud.mode === 'hold') && !usePaperUI && (
        <div
          className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between"
          style={{
            paddingLeft: 'var(--gl)',
            paddingRight: 'var(--gr)',
            paddingTop: 'var(--gt)',
            paddingBottom: 'var(--gb)',
          }}
        >
          {/* Top Bar */}
          <div className="flex items-start justify-between gap-2 sm:gap-4">
            <div
              className={`pointer-events-auto min-w-0 flex-1 sm:flex-initial sm:min-w-[260px] flex flex-col gap-1.5 rounded px-2.5 py-2 sm:px-3.5 sm:py-2.5 ${hudCls}`}
            >
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 sm:gap-2 text-xs sm:text-sm font-medium text-[#ddd2bc]">
                {phaseIcon}
                <span className="font-mono-num whitespace-nowrap">{t('第 {n} 天', { n: hud.day })}</span>
                <span className="text-[#8a8070]" aria-hidden="true">·</span>
                <span
                  className={
                    hud.phase === 'night'
                      ? 'text-[#cf6c5d] whitespace-nowrap'
                      : hud.phase === 'dusk'
                      ? 'text-[#e09d5e] whitespace-nowrap'
                      : 'text-[#e0d4be] whitespace-nowrap'
                  }
                >
                  {phaseLabel}
                </span>
                <span className="text-[#8a8070] hidden sm:inline" aria-hidden="true">·</span>
                <span className="flex items-center gap-1 text-xs text-[#b8c4c2] whitespace-nowrap">
                  <WeatherInkIcon kind={hud.weather} className="w-3.5 h-3.5" />
                  <span>{weatherLabel}</span>
                </span>
                <span className="text-[#8a8070] hidden sm:inline" aria-hidden="true">·</span>
                <span className="text-[#c5b9a3] text-xs whitespace-nowrap">{t(hud.zoneName)}</span>
              </div>

              <div className="w-full sm:w-60 h-1 bg-[#1e1d19] rounded-xs overflow-hidden">
                <div
                  className={`h-full transition-transform duration-150 origin-left ${
                    hud.phase === 'night'
                      ? 'bg-[#9b443b]'
                      : hud.phase === 'dusk'
                      ? 'bg-[#c97c3e]'
                      : 'bg-[#b7a57b]'
                  }`}
                  style={{ transform: `scaleX(${hud.phaseProgress.toFixed(3)})` }}
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] sm:text-xs text-[#b8ae9c] font-mono-num">
                <Flame
                  className={`w-3.5 h-3.5 ${
                    hud.generatorOn && hud.generatorFuel > 0
                      ? hud.generatorFuel < 20
                        ? 'text-[#de8a3e]'
                        : 'text-[#dfb763]'
                      : 'text-[#6c6860]'
                  }`}
                />
                <span>{t('发电机燃油')}</span>
                <span
                  className={
                    hud.generatorFuel <= 0
                      ? 'text-[#c95347]'
                      : hud.generatorFuel < 20
                      ? 'text-[#de9b5c]'
                      : 'text-[#d8cdb8]'
                  }
                >
                  {hud.generatorFuel}%
                </span>
                {hud.generatorFuel <= 0 && (
                  <span className="text-[#c95347]">· {t('发电机熄火')}</span>
                )}
              </div>

              {/* 当前目标：paper 变体下改为手写日志便签样式（楷体 + 左侧细余烬线），a 变体保持原样 */}
              <div
                className={`text-[11px] sm:text-[12px] leading-snug ${
                  usePaperUI ? 'hud-note' : 'text-[#d8be8a]/90'
                }`}
              >
                {t(hud.objectiveText)}
              </div>
            </div>

            {/* Right Utility Actions (Journal, Craft, Pause, Dev) */}
            <div className="pointer-events-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
              {isDev && (
                <button
                  type="button"
                  onClick={() => pushLayer('dev')}
                  className={`min-h-[44px] px-2.5 sm:px-3 rounded text-xs font-medium text-[#e6c98e] hover:text-[#ecdcbc] transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${hudCls}`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span className="font-mono-num">
                    {hud.backend === 'webgl2' ? 'GL2' : '2D'} · {hud.fps}fps
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={() => pushLayer('journal')}
                aria-label={t('日志')}
                className={`min-w-[44px] min-h-[44px] px-2.5 sm:px-3.5 rounded text-xs font-medium text-[#d8cdb8] hover:border-[#d8be8a]/60 transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-1.5 ${hudCls}`}
              >
                <BookOpen className="w-4 h-4 text-[#c8a974]" />
                <span className="hidden sm:inline">{t('日志')}</span>
                <span className="hidden md:inline text-[#8a8070] font-mono-num">J</span>
              </button>

              <button
                type="button"
                onClick={() => pushLayer('craft')}
                aria-label={t('制作')}
                className={`min-w-[44px] min-h-[44px] px-2.5 sm:px-3.5 rounded text-xs font-medium text-[#d8cdb8] hover:border-[#d8be8a]/60 transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-1.5 ${hudCls}`}
              >
                <Hammer className="w-4 h-4 text-[#d1a464]" />
                <span className="hidden sm:inline">{t('制作')}</span>
                <span className="hidden md:inline text-[#8a8070] font-mono-num">C</span>
              </button>

              <button
                type="button"
                onClick={() => pushLayer('pause')}
                aria-label={t('暂停')}
                className={`min-w-[44px] min-h-[44px] px-2.5 sm:px-3 rounded text-xs font-medium text-[#d8cdb8] hover:border-[#d8be8a]/60 transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-1.5 ${hudCls}`}
              >
                <Pause className="w-4 h-4" />
                <span className="hidden sm:inline">{t('暂停')}</span>
              </button>
            </div>
          </div>

          {/* Center-top atmospheric narrative toasts（日志便签式提示条，位置与尺寸不变） */}
          <div className="pointer-events-none fixed left-1/2 -translate-x-1/2 top-24 z-20 flex flex-col items-center gap-1.5 w-[min(90vw,440px)]">
            {hud.toasts.map((msg) => (
              <div
                key={msg.id}
                className={`px-3.5 py-1.5 rounded text-xs sm:text-sm text-center border ${
                  usePaperUI
                    ? `ink-note ${
                        msg.tone === 'danger'
                          ? 'ink-note--danger'
                          : msg.tone === 'warn'
                          ? 'ink-note--warn'
                          : msg.tone === 'loot'
                          ? 'ink-note--loot'
                          : ''
                      }`
                    : `backdrop-blur-xs ${
                        msg.tone === 'danger'
                          ? 'bg-[#2a0f0e]/92 border-[#b03c34]/55 text-[#f2c4bf]'
                          : msg.tone === 'warn'
                          ? 'bg-[#271b0e]/92 border-[#c9873c]/48 text-[#f0d6b1]'
                          : msg.tone === 'loot'
                          ? 'bg-[#121e18]/92 border-[#5f9c7c]/42 text-[#cfe8d7]'
                          : 'bg-[#14120f]/90 border-[#b8ae9c]/25 text-[#d8cdb8]'
                      }`
                }`}
              >
                {t(msg.text)}
              </div>
            ))}
          </div>

          {/* Bottom HUD: Vitals left · Hand-Drawn Resource Ledger + Quickbar right */}
          <div className="flex flex-col md:flex-row items-stretch md:items-end justify-between gap-3">
            <div className={`pointer-events-auto rounded px-3.5 py-2.5 w-full md:w-64 flex flex-col gap-2 ${hudCls}`}>
              <div>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-[#c7bfb0]">{t('生命')}</span>
                  <span className="font-mono-num font-medium text-[#ddd2bc]">
                    {hud.hp}/{hud.maxHp} · {hpStatus}
                  </span>
                </div>
                <div className="h-1.5 bg-[#1e1d19] rounded-xs overflow-hidden">
                  <div
                    className={`h-full origin-left transition-transform duration-150 ${
                      hud.hp <= 28 ? 'bg-[#c93e36]' : 'bg-[#9d3a33]'
                    }`}
                    style={{ transform: `scaleX(${(hud.hp / hud.maxHp).toFixed(3)})` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1 text-[#a8a091]">
                    <span>{t('体力')}</span>
                    <span className="font-mono-num font-medium">{hud.stamina}</span>
                  </div>
                  <div className="h-1 bg-[#1e1d19] rounded-xs overflow-hidden">
                    <div
                      className="h-full bg-[#8f9b76] origin-left"
                      style={{ transform: `scaleX(${(hud.stamina / hud.maxStamina).toFixed(3)})` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-[11px] mb-1 text-[#a8a091]">
                    <span className="flex items-center gap-1">
                      <Flashlight className="w-3 h-3 text-[#d8be8a]" />
                      {t('电量')}
                    </span>
                    <span
                      className={`font-mono-num font-medium ${
                        hud.battery < 20 ? 'text-[#d96c54]' : 'text-[#d8be8a]'
                      }`}
                    >
                      {hud.battery}%
                    </span>
                  </div>
                  <div className="h-1 bg-[#1e1d19] rounded-xs overflow-hidden">
                    <div
                      className={`h-full origin-left ${
                        hud.flashlightOn ? 'bg-[#d8b463]' : 'bg-[#69655c]'
                      }`}
                      style={{ transform: `scaleX(${(hud.battery / 100).toFixed(3)})` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="pointer-events-auto flex flex-col items-stretch sm:items-end gap-2">
              {/* Hand-Drawn Ink Icon Resource Ledger */}
              <div className={`rounded px-2.5 sm:px-3 py-1.5 flex flex-wrap items-center gap-x-3 sm:gap-x-3.5 gap-y-1 text-xs ${hudCls}`}>
                {RESOURCE_META.map((item) => (
                  <div key={item.key} className="flex items-center gap-1.5 whitespace-nowrap">
                    <span style={{ color: item.color }} aria-hidden="true">
                      <ResourceInkIcon kind={item.key} className="w-3.5 h-3.5" />
                    </span>
                    <span className="text-[#b2a896]">{t(item.label)}</span>
                    <span className="font-mono-num font-medium text-[#ddd2bc]">
                      {hud.inv[item.key]}
                    </span>
                  </div>
                ))}
              </div>

              {/* Quickbar with Ink Icons */}
              <div className="flex items-center justify-between sm:justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => runtimeRef.current?.engine.toggleFlashlight()}
                  aria-label={t('手电')}
                  className={`min-w-[44px] min-h-[44px] px-2.5 sm:px-3 rounded text-xs flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 border ${
                    hud.flashlightOn
                      ? 'bg-[#2c2417]/92 border-[#d8b463]/70 text-[#f5e3b6]'
                      : `${hudCls} text-[#9b9384]`
                  }`}
                >
                  <span className="hidden sm:inline font-mono-num text-[10px] opacity-70">F</span>
                  <Flashlight className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('手电')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => runtimeRef.current?.engine.useQuickSlot(1)}
                  aria-label={t('照明弹')}
                  className={`min-w-[44px] min-h-[44px] px-2.5 sm:px-3 rounded text-xs text-[#d8cdb8] hover:border-[#df8158]/70 flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${hudCls}`}
                >
                  <span className="hidden sm:inline font-mono-num text-[10px] text-[#8a8070]">1</span>
                  <FlareInkIcon className="w-3.5 h-3.5 text-[#df8158]" />
                  <span className="hidden sm:inline">{t('照明弹')}</span>
                  <span className="font-mono-num text-[#df8158]">{hud.inv.flares}</span>
                </button>

                <button
                  type="button"
                  onClick={() => runtimeRef.current?.engine.useQuickSlot(2)}
                  aria-label={t('草药绷带')}
                  className={`min-w-[44px] min-h-[44px] px-2.5 sm:px-3 rounded text-xs text-[#d8cdb8] hover:border-[#8dbb88]/70 flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${hudCls}`}
                >
                  <span className="hidden sm:inline font-mono-num text-[10px] text-[#8a8070]">2</span>
                  <BandageInkIcon className="w-3.5 h-3.5 text-[#8dbb88]" />
                  <span className="hidden sm:inline">{t('草药绷带')}</span>
                  <span className="font-mono-num text-[#8dbb88]">{hud.inv.bandages}</span>
                </button>

                <button
                  type="button"
                  onClick={() => runtimeRef.current?.engine.useQuickSlot(3)}
                  aria-label={t('捕兽夹')}
                  className={`min-w-[44px] min-h-[44px] px-2.5 sm:px-3 rounded text-xs text-[#d8cdb8] hover:border-[#a4b0b6]/70 flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${hudCls}`}
                >
                  <span className="hidden sm:inline font-mono-num text-[10px] text-[#8a8070]">3</span>
                  <TrapInkIcon className="w-3.5 h-3.5 text-[#b4bec2]" />
                  <span className="hidden sm:inline">{t('捕兽夹')}</span>
                  <span className="font-mono-num text-[#d4cbb8]">{hud.inv.traps}</span>
                </button>

                <button
                  type="button"
                  onClick={() => runtimeRef.current?.engine.useQuickSlot(4)}
                  aria-label={t('电池')}
                  className={`min-w-[44px] min-h-[44px] px-2.5 sm:px-3 rounded text-xs text-[#d8cdb8] hover:border-[#e2cb77]/70 flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${hudCls}`}
                >
                  <span className="hidden sm:inline font-mono-num text-[10px] text-[#8a8070]">4</span>
                  <ResourceInkIcon kind="battery" className="w-3.5 h-3.5 text-[#e2cb77]" />
                  <span className="hidden sm:inline">{t('电池')}</span>
                  <span className="font-mono-num text-[#e2cb77]">{hud.inv.battery}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TOUCH CONTROLS */}
      {isTouch && hud?.mode === 'play' && topLayer === null && (
        <div className="pointer-events-none fixed inset-0 z-25">
          <div
            onTouchStart={onMoveTouchStart}
            onTouchMove={onMoveTouchMove}
            onTouchEnd={onMoveTouchEnd}
            onTouchCancel={onMoveTouchEnd}
            className="pointer-events-auto fixed left-4 bottom-36 sm:bottom-24 md:left-6 md:bottom-28 w-24 h-24 sm:w-28 sm:h-28 rounded-full border border-[#b8ae9c]/25 bg-black/25 flex items-center justify-center"
          >
            <div
              className="w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-[#b8ae9c]/35 border border-[#e7e2d8]/45"
              style={{ transform: `translate(${moveKnob.x}px, ${moveKnob.y}px)` }}
            />
          </div>

          <div className="pointer-events-auto fixed right-4 bottom-36 sm:bottom-24 md:right-6 md:bottom-28 flex items-end gap-2.5">
            <div className="flex flex-col gap-2 items-end">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onTouchStart={() => runtimeRef.current?.engine.triggerDodge()}
                  className="min-w-[48px] min-h-[48px] rounded-full bg-[#1b2220]/90 border border-[#84b8a6]/55 text-xs font-medium text-[#dceee8] whitespace-nowrap"
                >
                  {t('闪避')}
                </button>
                <button
                  type="button"
                  onTouchStart={() => {
                    if (!runtimeRef.current) return;
                    runtimeRef.current.engine.touchInteract = true;
                    runtimeRef.current.engine.triggerInstantInteract();
                  }}
                  onTouchEnd={() => {
                    if (runtimeRef.current) runtimeRef.current.engine.touchInteract = false;
                  }}
                  className="min-w-[48px] min-h-[48px] rounded-full bg-[#1a1814]/88 border border-[#d8b463]/55 text-xs font-medium text-[#efe8da] whitespace-nowrap"
                >
                  {hud.draggingFurniture ? t('松开') : t('搜刮')}
                </button>
              </div>
              {/* R3：触控切换火把/手枪（≥44px）；手枪模式下额外显示换弹 */}
              <div className="flex items-center gap-2">
                {hud.equip?.mode === 'pistol' && (
                  <button
                    type="button"
                    aria-label={t('换弹')}
                    onTouchStart={() => runtimeRef.current?.engine.reloadWeapon()}
                    className="min-w-[48px] min-h-[48px] rounded-full bg-[#1a1814]/88 border border-[#b8ae9c]/45 text-xs font-medium text-[#efe8da] whitespace-nowrap"
                  >
                    {t('换弹')}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('切换武器')}
                  onTouchStart={() => runtimeRef.current?.engine.toggleWeapon()}
                  className="min-w-[48px] min-h-[48px] rounded-full bg-[#1a1814]/88 border border-[#c9824f]/55 text-xs font-medium text-[#efe8da] whitespace-nowrap"
                >
                  {hud.equip?.mode === 'pistol' ? t('火把') : t('手枪')}
                </button>
              </div>
              <button
                type="button"
                onTouchStart={() => {
                  if (!runtimeRef.current) return;
                  runtimeRef.current.engine.mouseDownLeft = true;
                  runtimeRef.current.engine.beginAttackCharge();
                }}
                onTouchEnd={() => {
                  if (!runtimeRef.current) return;
                  runtimeRef.current.engine.mouseDownLeft = false;
                  runtimeRef.current.engine.releaseAttackCharge();
                }}
                className="min-w-[52px] min-h-[52px] rounded-full bg-[#6d241f]/88 border border-[#d67a70]/60 text-xs font-medium text-[#f5e1de] whitespace-nowrap"
              >
                {hud.equip?.mode === 'pistol' ? t('射击') : t('攻击')}
              </button>
            </div>

            <div
              onTouchStart={onAimTouchStart}
              onTouchMove={onAimTouchMove}
              onTouchEnd={onAimTouchEnd}
              onTouchCancel={onAimTouchEnd}
              className="w-24 h-24 sm:w-28 sm:h-28 rounded-full border border-[#b8ae9c]/25 bg-black/25 flex items-center justify-center"
            >
              <div
                className="w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-[#d8b463]/35 border border-[#e5b968]/55"
                style={{ transform: `translate(${aimKnob.x}px, ${aimKnob.y}px)` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* UNIFIED LAYER STACK MODALS (Esc / Scrim / Back / Popstate) */}
      {topLayer && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/58 backdrop-blur-[2px] p-5"
          onClick={() => popLayer()}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-lg max-h-[85vh] rounded-md flex flex-col overflow-hidden ${panelCls}`}
          >
            {/* Fixed Modal Header (zero position: sticky) */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#b8ae9c]/18 shrink-0">
              <h2 className="font-display text-lg font-semibold tracking-wide text-[#f0e6d2]">
                {topLayer === 'pause' && t('暂停')}
                {topLayer === 'craft' && t('工作台制作')}
                {topLayer === 'journal' && t('羊皮生存日志')}
                {topLayer === 'settings' && t('设置')}
                {topLayer === 'controls' && t('操作说明')}
                {topLayer === 'dev' && t('开发者 Variants 面板')}
              </h2>
              <button
                type="button"
                onClick={() => popLayer()}
                aria-label={t('关闭')}
                className="min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center text-[#a8a091] hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body */}
            <div className="ember-scroll overflow-y-auto px-5 py-4 flex-1 space-y-4">
              {topLayer === 'pause' && (
                <div className="flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => clearLayers()}
                    className="min-h-[46px] px-4 bg-[#b87b3b] hover:bg-[#cc8b46] text-[#110e0a] font-semibold text-sm rounded transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    <span>{t('继续求生')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => pushLayer('journal')}
                    className="min-h-[46px] px-4 border border-[#b8ae9c]/25 hover:border-[#d8be8a]/60 text-[#f0e6d2] text-sm font-medium rounded transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <BookOpen className="w-4 h-4 text-[#c8a974]" />
                    <span>{t('羊皮生存日志')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => pushLayer('craft')}
                    className="min-h-[46px] px-4 border border-[#b8ae9c]/25 hover:border-[#d8be8a]/60 text-[#f0e6d2] text-sm font-medium rounded transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <Hammer className="w-4 h-4 text-[#d1a464]" />
                    <span>{t('工作台制作')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => pushLayer('settings')}
                    className="min-h-[46px] px-4 border border-[#b8ae9c]/25 hover:border-[#d8be8a]/60 text-[#f0e6d2] text-sm font-medium rounded transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <Settings className="w-4 h-4" />
                    <span>{t('设置')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => pushLayer('controls')}
                    className="min-h-[46px] px-4 border border-[#b8ae9c]/25 hover:border-[#d8be8a]/60 text-[#f0e6d2] text-sm font-medium rounded transition-colors whitespace-nowrap"
                  >
                    {t('操作说明')}
                  </button>
                  <div className="pt-2 border-t border-[#b8ae9c]/15 grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        clearLayers();
                        runtimeRef.current?.engine.reset(
                          (runtimeRef.current.engine.world.seed + 7) % 99991,
                          true
                        );
                      }}
                      className="min-h-[44px] px-4 border border-[#b8ae9c]/20 hover:border-[#c95347]/60 text-[#d8c7c4] text-sm rounded transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>{t('重新开始')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        clearLayers();
                        runtimeRef.current?.engine.reset(19847, false);
                      }}
                      className="min-h-[44px] px-4 border border-[#b8ae9c]/20 hover:border-[#b8ae9c]/50 text-[#b8ae9c] text-sm rounded transition-colors whitespace-nowrap"
                    >
                      {t('回到标题')}
                    </button>
                  </div>
                </div>
              )}

              {/* PARCHMENT FIELD JOURNAL: Hand-Drawn Sector Compass Sketch + Survival Log */}
              {topLayer === 'journal' && hud && (
                <div className="space-y-4">
                  <div className={`p-3.5 rounded ${cardCls}`}>
                    <div className="flex items-center justify-between text-xs text-[#b8ae9c] mb-2">
                      <span>{t('手绘林区方位草图')}</span>
                      <span className="font-mono-num">
                        {hud.discoveredZones.length}/5
                      </span>
                    </div>

                    {/* Hand-drawn ink sector sketch SVG */}
                    <svg
                      viewBox="0 0 260 190"
                      className="w-full h-44 rounded border border-[#b8ae9c]/18 bg-[#12100d]"
                    >
                      {/* Rough compass grid & dashed trails */}
                      <g stroke="rgba(180,156,118,0.22)" strokeWidth="1" strokeDasharray="3 4" fill="none">
                        <path d="M130 95 L46 42" />
                        <path d="M130 95 L214 46" />
                        <path d="M130 95 L48 148" />
                        <path d="M130 95 L212 146" />
                        <circle cx="130" cy="95" r="56" strokeOpacity="0.14" />
                      </g>

                      {/* Compass rose N/S/W/E */}
                      <g fill="rgba(184,168,140,0.45)" fontSize="9" fontFamily="monospace" textAnchor="middle">
                        <text x="130" y="14">N</text>
                        <text x="130" y="183">S</text>
                        <text x="12" y="98">W</text>
                        <text x="248" y="98">E</text>
                      </g>

                      {/* Central Hideout cabin mark */}
                      <g transform="translate(130, 95)">
                        <rect x="-7" y="-5" width="14" height="10" fill="#2e2418" stroke="#dfb763" strokeWidth="1.4" />
                        <text y="19" fill="#e5d4b3" fontSize="9" textAnchor="middle">
                          {t('庇护所')}
                        </text>
                      </g>

                      {/* 4 Outer Landmarks + 3 信号中继零件地标收集状态 */}
                      {LANDMARK_MAP_NODES.map((node) => {
                        const found = hud.discoveredZones.includes(node.name);
                        const hasRelay =
                          node.name === '坠毁货车' ||
                          node.name === '废弃锯木厂' ||
                          node.name === '枯林祭坛';
                        const relayCollected = hud.relayCollectedZones.includes(node.name);
                        return (
                          <g key={node.name} transform={`translate(${node.x}, ${node.y})`}>
                            {hasRelay && !relayCollected && (
                              <circle
                                r="9.5"
                                fill="none"
                                stroke="#cf5d47"
                                strokeWidth="1.2"
                                strokeDasharray="3 2"
                                className="animate-pulse"
                              />
                            )}
                            <circle
                              r="4.5"
                              fill={
                                relayCollected ? '#4c947d' : found ? '#b87b3b' : 'transparent'
                              }
                              stroke={
                                relayCollected
                                  ? '#a5ebd4'
                                  : found
                                  ? '#f0d8a8'
                                  : hasRelay
                                  ? '#d89b5a'
                                  : 'rgba(168,154,132,0.45)'
                              }
                              strokeWidth="1.3"
                              strokeDasharray={found || relayCollected ? undefined : '2 2'}
                            />
                            {relayCollected && (
                              <path
                                d="M-2.2 0.2 L-0.4 2.1 L2.8 -2.1"
                                fill="none"
                                stroke="#f4fff9"
                                strokeWidth="1.4"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            )}
                            <text
                              y="16"
                              fill={found || relayCollected ? '#e8dbc2' : 'rgba(168,154,132,0.62)'}
                              fontSize="8.5"
                              textAnchor="middle"
                            >
                              {found || relayCollected ? t(node.name) : hasRelay ? `${t(node.name)}*` : '?'}
                            </text>
                          </g>
                        );
                      })}

                      {/* Current survivor ink cross */}
                      <g transform={`translate(${sketchPx.toFixed(1)}, ${sketchPy.toFixed(1)})`}>
                        <circle r="3.5" fill="#d95a45" stroke="#f7e8d8" strokeWidth="1.2" />
                      </g>
                    </svg>
                  </div>

                  {/* Survival Chronicles */}
                  <div>
                    <div className="text-xs text-[#a8a091] mb-2">{t('生存纪事')}</div>
                    <div className="space-y-2.5">
                      {hud.journal.map((entry) => (
                        <div key={entry.id} className={`p-3 rounded ${cardCls}`}>
                          <div className="flex items-center justify-between gap-2 text-xs text-[#b89f74]">
                            <span className="font-medium text-[#efe4cf]">{entry.title}</span>
                            <span className="font-mono-num shrink-0">
                              {t('第 {n} 天', { n: entry.day })} ·{' '}
                              {entry.phase === 'night'
                                ? t('黑夜')
                                : entry.phase === 'dusk'
                                ? t('黄昏')
                                : t('白昼')}
                            </span>
                          </div>
                          <p className="text-xs text-[#bdb3a1] mt-1.5 leading-relaxed">
                            {entry.body}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {topLayer === 'craft' && hud && (
                <div className="space-y-3">
                  <p className="text-xs text-[#a8a091]">
                    {t('消耗资源合成求生道具，随时可在暗处应急。')}
                  </p>
                  <div className="space-y-2.5">
                    {CRAFT_RECIPES.map((r) => {
                      const ownedAxe = r.id === 'axe' && hud.inv.weaponTier >= 2;
                      const canAfford =
                        !ownedAxe &&
                        (Object.entries(r.cost) as [ResourceKey, number][]).every(
                          ([k, qty]) => hud.inv[k] >= qty
                        );
                      return (
                        <div
                          key={r.id}
                          className={`flex items-center justify-between gap-4 p-3 rounded ${cardCls}`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm font-medium text-[#f0e6d2]">
                              <span>{t(r.name)}</span>
                              <span className="text-xs font-mono-num text-[#d8be8a]">
                                {r.outputText}
                              </span>
                            </div>
                            <p className="text-xs text-[#a39a8a] mt-0.5">{t(r.desc)}</p>
                            <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs font-mono-num">
                              {(Object.entries(r.cost) as [ResourceKey, number][]).map(([k, qty]) => {
                                const meta = RESOURCE_META.find((m) => m.key === k);
                                const enough = hud.inv[k] >= qty;
                                return (
                                  <span
                                    key={k}
                                    className={`inline-flex items-center gap-1 ${
                                      enough ? 'text-[#cec5b4]' : 'text-[#cf584c]'
                                    }`}
                                  >
                                    <ResourceInkIcon kind={k} className="w-3 h-3" />
                                    <span>
                                      {t(meta?.label ?? k)} {hud.inv[k]}/{qty}
                                    </span>
                                  </span>
                                );
                              })}
                            </div>
                          </div>

                          <button
                            type="button"
                            disabled={!canAfford}
                            onClick={() => runtimeRef.current?.engine.craft(r.id)}
                            className={`min-h-[44px] px-4 rounded text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                              ownedAxe
                                ? 'bg-[#22241f] text-[#8a8274] cursor-default'
                                : canAfford
                                ? 'bg-[#b87b3b] hover:bg-[#cc8b46] text-[#110e0a]'
                                : 'bg-[#1c1d19] text-[#6d675d] cursor-not-allowed'
                            }`}
                          >
                            {ownedAxe ? t('已装备') : t('合成')}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {topLayer === 'settings' && (
                <div className="space-y-5">
                  <div>
                    <div className="text-xs text-[#a8a091] mb-2">{t('画质档位')}</div>
                    <div className="grid grid-cols-3 gap-2">
                      {([2, 1, 0] as QualityTier[]).map((tier) => {
                        const label = tier === 2 ? '高' : tier === 1 ? '均衡' : '流畅';
                        const active = qualityTier === tier;
                        return (
                          <button
                            key={tier}
                            type="button"
                            onClick={() => Quality.setTier(tier)}
                            className={`min-h-[44px] rounded text-sm font-medium border transition-colors whitespace-nowrap ${
                              active
                                ? 'bg-[#b87b3b] border-[#d8b463] text-[#110e0a]'
                                : 'bg-[#1b1915] border-[#b8ae9c]/22 text-[#c7bfb0] hover:text-white'
                            }`}
                          >
                            {t(label)}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-[#a8a091] mb-2">{t('声音')}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          AudioFX.unlock();
                          AudioFX.setMuted(false);
                        }}
                        className={`min-h-[44px] rounded text-sm font-medium border transition-colors whitespace-nowrap ${
                          !muted
                            ? 'bg-[#b87b3b] border-[#d8b463] text-[#110e0a]'
                            : 'bg-[#1b1915] border-[#b8ae9c]/22 text-[#c7bfb0]'
                        }`}
                      >
                        {t('开启')}
                      </button>
                      <button
                        type="button"
                        onClick={() => AudioFX.setMuted(true)}
                        className={`min-h-[44px] rounded text-sm font-medium border transition-colors whitespace-nowrap ${
                          muted
                            ? 'bg-[#b87b3b] border-[#d8b463] text-[#110e0a]'
                            : 'bg-[#1b1915] border-[#b8ae9c]/22 text-[#c7bfb0]'
                        }`}
                      >
                        {t('静音')}
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-[#a8a091] mb-2">{t('语言')}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => I18n.setLang('zh')}
                        className={`min-h-[44px] rounded text-sm font-medium border transition-colors whitespace-nowrap ${
                          lang === 'zh'
                            ? 'bg-[#b87b3b] border-[#d8b463] text-[#110e0a]'
                            : 'bg-[#1b1915] border-[#b8ae9c]/22 text-[#c7bfb0]'
                        }`}
                      >
                        简体中文
                      </button>
                      <button
                        type="button"
                        onClick={() => I18n.setLang('en')}
                        className={`min-h-[44px] rounded text-sm font-medium border transition-colors whitespace-nowrap ${
                          lang === 'en'
                            ? 'bg-[#b87b3b] border-[#d8b463] text-[#110e0a]'
                            : 'bg-[#1b1915] border-[#b8ae9c]/22 text-[#c7bfb0]'
                        }`}
                      >
                        English
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {topLayer === 'controls' && (
                <div className="space-y-3 text-sm">
                  {[
                    ['移动与闪避', 'WASD / 方向键移动，Shift 冲刺，Space 消耗体力向移动/反方向急退闪避'],
                    ['照明与视线', '鼠标控制视线锥光方向，按 F 开关手电节省电量'],
                    ['搜集、家具与防线', '长按 E 搜刮物资箱；按 E 拖拽/松开屋内家具堵门、加固门窗、装零件或加油'],
                    ['蓄力重击与道具', '左键挥动火把轻点快劈、长按蓄力爆发重击，右键投掷照明弹，1-4 快捷道具，C 制作，J 翻阅日志'],
                    [
                      '火把与手枪',
                      'Q 切换火把/手枪（切枪时火把丢在身侧继续燃烧，靠近按 E 捡回）；手枪左键射击、R 换弹；火把燃尽后按 R 用木材+燃油重新点燃',
                    ],
                  ].map(([title, desc]) => (
                    <div key={title} className={`p-3 rounded ${cardCls}`}>
                      <div className="font-medium text-[#f0e6d2]">{t(title)}</div>
                      <div className="text-xs text-[#aba190] mt-1 leading-relaxed">{t(desc)}</div>
                    </div>
                  ))}
                </div>
              )}

              {topLayer === 'dev' && (
                <div className="space-y-4">
                  <div>
                    <div className="text-xs text-[#a8a091] mb-2">{t('时间跳转')}</div>
                    <div className="grid grid-cols-3 gap-2">
                      {(['day', 'dusk', 'night'] as TimePhase[]).map((ph) => (
                        <button
                          key={ph}
                          type="button"
                          onClick={() => runtimeRef.current?.engine.jumpTimeOfDay(ph)}
                          className="min-h-[44px] rounded border border-[#b8ae9c]/22 bg-[#1b1915] hover:border-[#d8b463]/60 text-xs text-[#efe8da] whitespace-nowrap"
                        >
                          {ph === 'day' ? t('白昼') : ph === 'dusk' ? t('黄昏') : t('黑夜')}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-[#a8a091] mb-2">{t('天气跳转')}</div>
                    <div className="grid grid-cols-3 gap-2">
                      {(['mist', 'drizzle', 'storm'] as WeatherKind[]).map((wk) => (
                        <button
                          key={wk}
                          type="button"
                          onClick={() => runtimeRef.current?.engine.jumpWeather(wk)}
                          className="min-h-[44px] rounded border border-[#b8ae9c]/22 bg-[#1b1915] hover:border-[#d8b463]/60 text-xs text-[#efe8da] whitespace-nowrap"
                        >
                          {wk === 'mist' ? t('浓雾') : wk === 'drizzle' ? t('细雨') : t('雷暴')}
                        </button>
                      ))}
                    </div>
                  </div>

                  {Variants.defs.map((v) => (
                    <div key={v.name}>
                      <div className="text-xs text-[#a8a091] mb-1.5">
                        {t(v.label)}{' '}
                        <span className="font-mono-num text-[#777165]">?v-{v.name}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {v.options.map(([optId, optLabel]) => {
                          const active = Variants.val[v.name] === optId;
                          return (
                            <button
                              key={optId}
                              type="button"
                              onClick={() => Variants.set(v.name, optId)}
                              className={`min-h-[44px] rounded text-xs font-medium border transition-colors whitespace-nowrap ${
                                active
                                  ? 'bg-[#b87b3b] border-[#d8b463] text-[#110e0a]'
                                  : 'bg-[#1b1915] border-[#b8ae9c]/22 text-[#c7bfb0]'
                              }`}
                            >
                              {optId.toUpperCase()} · {t(optLabel)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-[#b8ae9c]/15 flex justify-end shrink-0">
              <button
                type="button"
                onClick={() => popLayer()}
                className="min-h-[44px] px-5 text-sm text-[#c7bfb0] hover:text-white border border-[#b8ae9c]/24 rounded transition-colors whitespace-nowrap"
              >
                {t('返回')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* VICTORY SUMMARY: 破雾撤离通关结算 */}
      {hud?.mode === 'victory' && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/82 backdrop-blur-xs p-5">
          <div className={`w-full max-w-md rounded-md p-6 text-center space-y-5 ${panelCls}`}>
            <div className="flex justify-center">
              <Sun className="w-9 h-9 text-[#dfb763]" />
            </div>
            <div>
              <h2 className="font-display text-2xl sm:text-3xl font-semibold text-[#f3e6c8]">
                {t('破雾撤离')}
              </h2>
              <p className="mt-2 text-xs sm:text-sm text-[#c5b9a3] leading-relaxed">
                {t('信号中继电台穿透了黑林浓雾，你在灰白黎明中找到了逃出生天的路。')}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-left pt-1">
              <div className={`p-3 rounded ${cardCls}`}>
                <div className="text-xs text-[#9c9485]">{t('存活天数')}</div>
                <div className="font-mono-num text-xl font-semibold text-[#f0e6d2] mt-0.5">
                  {hud.day}
                </div>
              </div>
              <div className={`p-3 rounded ${cardCls}`}>
                <div className="text-xs text-[#9c9485]">{t('搜刮容器')}</div>
                <div className="font-mono-num text-xl font-semibold text-[#f0e6d2] mt-0.5">
                  {hud.containersLooted}/{hud.totalContainers}
                </div>
              </div>
              <div className={`p-3 rounded ${cardCls}`}>
                <div className="text-xs text-[#9c9485]">{t('击退怪物')}</div>
                <div className="font-mono-num text-xl font-semibold text-[#f0e6d2] mt-0.5">
                  {hud.enemiesDefeated}
                </div>
              </div>
              <div className={`p-3 rounded ${cardCls}`}>
                <div className="text-xs text-[#9c9485]">{t('中继零件')}</div>
                <div className="font-mono-num text-xl font-semibold text-[#7ad8c5] mt-0.5">
                  {hud.relayInstalled}/3
                </div>
              </div>
            </div>

            <div className="pt-2 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => runtimeRef.current?.engine.continueEndless()}
                className="min-h-[46px] px-5 bg-[#b87b3b] hover:bg-[#cc8b46] text-[#110e0a] font-semibold text-sm rounded transition-colors whitespace-nowrap"
              >
                {t('继续无尽求生')}
              </button>
              <button
                type="button"
                onClick={startSurvival}
                className="min-h-[44px] px-5 border border-[#d8be8a]/40 hover:border-[#d8be8a]/80 text-[#f0e6d2] text-sm rounded transition-colors whitespace-nowrap"
              >
                {t('再次踏入森林')}
              </button>
              <button
                type="button"
                onClick={() => runtimeRef.current?.engine.reset(19847, false)}
                className="min-h-[44px] px-5 border border-[#b8ae9c]/25 text-[#c7bfb0] hover:text-white text-sm rounded transition-colors whitespace-nowrap"
              >
                {t('回到标题')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GAME OVER SUMMARY */}
      {hud?.mode === 'dead' && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/82 backdrop-blur-xs p-5">
          <div className={`w-full max-w-md rounded-md p-6 text-center space-y-5 ${panelCls}`}>
            <div className="flex justify-center">
              <ShieldAlert className="w-9 h-9 text-[#c95347]" />
            </div>
            <h2 className="font-display text-2xl sm:text-3xl font-semibold text-[#f0dcd8]">
              {t('黑暗吞噬了你')}
            </h2>

            <div className="grid grid-cols-2 gap-3 text-left pt-2">
              <div className={`p-3 rounded ${cardCls}`}>
                <div className="text-xs text-[#9c9485]">{t('存活天数')}</div>
                <div className="font-mono-num text-xl font-semibold text-[#f0e6d2] mt-0.5">
                  {hud.day}
                </div>
              </div>
              <div className={`p-3 rounded ${cardCls}`}>
                <div className="text-xs text-[#9c9485]">{t('搜刮容器')}</div>
                <div className="font-mono-num text-xl font-semibold text-[#f0e6d2] mt-0.5">
                  {hud.containersLooted}/{hud.totalContainers}
                </div>
              </div>
              <div className={`p-3 rounded ${cardCls}`}>
                <div className="text-xs text-[#9c9485]">{t('击退怪物')}</div>
                <div className="font-mono-num text-xl font-semibold text-[#f0e6d2] mt-0.5">
                  {hud.enemiesDefeated}
                </div>
              </div>
              <div className={`p-3 rounded ${cardCls}`}>
                <div className="text-xs text-[#9c9485]">{t('幽光菇收集')}</div>
                <div className="font-mono-num text-xl font-semibold text-[#7ad8c5] mt-0.5">
                  {hud.essenceCollected}
                </div>
              </div>
            </div>

            <div className="pt-2 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={startSurvival}
                className="min-h-[46px] px-5 bg-[#b87b3b] hover:bg-[#cc8b46] text-[#110e0a] font-semibold text-sm rounded transition-colors whitespace-nowrap"
              >
                {t('再次踏入森林')}
              </button>
              <button
                type="button"
                onClick={() => runtimeRef.current?.engine.reset(19847, false)}
                className="min-h-[44px] px-5 border border-[#b8ae9c]/25 text-[#c7bfb0] hover:text-white text-sm rounded transition-colors whitespace-nowrap"
              >
                {t('回到标题')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
