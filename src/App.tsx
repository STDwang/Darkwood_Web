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
  Share2,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Sunset,
  Trophy,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  AxeInkIcon,
  BandageInkIcon,
  DodgeInkIcon,
  FlameInkIcon,
  FlareInkIcon,
  InteractHandIcon,
  PistolInkIcon,
  ReloadInkIcon,
  ResourceInkIcon,
  SoulDivider,
  SoulFrameCorners,
  TrapInkIcon,
  WeatherInkIcon,
} from './components/InkIcons';
import GameHud from './components/GameHud';
import { MinimapExploreState, WorldMapView } from './components/Minimap';
import { AudioFX } from './game/audio';
import { I18n, Lang } from './game/i18n';
import { Quality, QualityTier, VIEW_SCALE_PRESETS, ViewScaleLevel } from './game/quality';
import { GameRuntime } from './game/runtime';
import { HudSnapshot, ResourceKey, TimePhase, WeatherKind } from './game/types';
import { Variants } from './game/variants';
import { CRAFT_RECIPES } from './game/world';
import {
  applyXhsWindowMetrics,
  fetchXhsRankList,
  getLocalBestScore,
  hydrateLocalBestScore,
  isMiniToolEnv,
  postXhsReviveNote,
  setXhsKeepScreenOn,
  shareXhsReviveCard,
  submitXhsScore,
  XhsRankListResult,
  XhsRankPeriod,
} from './game/xhsBridge';

type LayerId = 'pause' | 'craft' | 'journal' | 'settings' | 'controls' | 'dev' | 'map' | 'rank';

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
  const [viewScale, setViewScale] = useState<ViewScaleLevel>(Quality.viewScale);
  const [muted, setMuted] = useState<boolean>(AudioFX.isMuted);
  const [variantTick, setVariantTick] = useState(0);
  const [isTouch, setIsTouch] = useState(false);
  const [rankPeriod, setRankPeriod] = useState<XhsRankPeriod>('all');
  const [rankLoading, setRankLoading] = useState(false);
  const [rankData, setRankData] = useState<XhsRankListResult | null>(null);
  const [reviveBusy, setReviveBusy] = useState(false);
  const [reviveMsg, setReviveMsg] = useState<string | null>(null);
  const lastSubmittedModeRef = useRef<string>('title');
  const forceLandscapeRef = useRef(false);
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
    const u2 = Quality.subscribe(() => {
      setQualityTier(Quality.tier);
      setViewScale(Quality.viewScale);
    });
    const u3 = AudioFX.subscribe(() => setMuted(AudioFX.isMuted));
    const u4 = Variants.subscribe(() => setVariantTick((n) => n + 1));

    // 同步检测竖屏手机/小红书小工具容器，自动启用强制横屏（rotate 90deg）与触控双摇杆层
    const syncViewportMode = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const shouldForceLandscape = vh > vw && vw <= 768;
      forceLandscapeRef.current = shouldForceLandscape;
      document.documentElement.classList.toggle('force-landscape', shouldForceLandscape);
      const coarse = window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
      const mobileLike = Boolean(coarse || shouldForceLandscape || Math.min(vw, vh) <= 520 || isMiniToolEnv());
      setIsTouch(mobileLike);
      if (runtimeRef.current) {
        runtimeRef.current.engine.isTouchUi = mobileLike;
      }
      applyXhsWindowMetrics();
    };

    syncViewportMode();
    // 若浏览器支持原生屏幕方向锁定，优先请求横屏
    try {
      (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('landscape')?.catch?.(() => {});
    } catch {
      // 忽略不支持横屏锁定的环境，交由 CSS force-landscape 兜底
    }

    // 小红书小工具容器适配：异步水合偏好存储 + 窗口安全区与右上角胶囊避让测算
    I18n.hydrateFromContainer();
    Quality.hydrateFromContainer();
    AudioFX.hydrateFromContainer();
    hydrateLocalBestScore();
    window.addEventListener('resize', syncViewportMode);
    window.addEventListener('orientationchange', syncViewportMode);

    return () => {
      u1();
      u2();
      u3();
      u4();
      window.removeEventListener('resize', syncViewportMode);
      window.removeEventListener('orientationchange', syncViewportMode);
      document.documentElement.classList.remove('force-landscape');
    };
  }, []);

  // 游玩态保持屏幕常亮（9.55+），防止黑夜守屋观察动静时手机自动息屏
  useEffect(() => {
    setXhsKeepScreenOn(hud?.mode === 'play');
    // 进入死亡或黎明胜利结算时，自动提交一次生存积分至小红书排行榜（带去重，避免重复刷接口）
    const mode = hud?.mode ?? 'title';
    if ((mode === 'dead' || mode === 'victory') && lastSubmittedModeRef.current !== mode) {
      const score = runtimeRef.current?.engine.getSurvivalScore() ?? 0;
      if (score > 0) {
        submitXhsScore(score).catch(() => {});
      }
      setReviveMsg(null);
    }
    lastSubmittedModeRef.current = mode;
  }, [hud?.mode]);

  const topLayer = layers[layers.length - 1] ?? null;

  // 打开排行榜弹层或切换周期时查询榜单（内部自带 45s 缓存）
  useEffect(() => {
    if (topLayer !== 'rank') return;
    let alive = true;
    setRankLoading(true);
    fetchXhsRankList(rankPeriod)
      .then((res) => {
        if (alive) setRankData(res);
      })
      .finally(() => {
        if (alive) setRankLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [topLayer, rankPeriod]);

  const handleReviveByNote = useCallback(async () => {
    const rt = runtimeRef.current;
    if (!rt || reviveBusy) return;
    setReviveBusy(true);
    setReviveMsg(null);
    try {
      const score = rt.engine.getSurvivalScore();
      const looted = rt.engine.world.containers.filter((c) => c.searched).length;
      const res = await postXhsReviveNote({
        day: rt.engine.day,
        defeated: rt.engine.enemiesDefeated,
        looted,
        score,
      });
      if (res.ok) {
        rt.engine.revivePlayer();
      } else {
        setReviveMsg(res.message || '未完成发布，暂未触发复活');
      }
    } finally {
      setReviveBusy(false);
    }
  }, [reviveBusy]);

  const handleReviveByShare = useCallback(async () => {
    const rt = runtimeRef.current;
    if (!rt || reviveBusy) return;
    setReviveBusy(true);
    setReviveMsg(null);
    try {
      const res = await shareXhsReviveCard();
      if (res.ok) {
        rt.engine.revivePlayer();
      } else {
        setReviveMsg(res.message || '未完成分享，暂未触发复活');
      }
    } finally {
      setReviveBusy(false);
    }
  }, [reviveBusy]);

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
    rt.engine.isTouchUi =
      forceLandscapeRef.current ||
      Boolean(window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window || isMiniToolEnv());
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
        ['KeyF', 'KeyC', 'KeyJ', 'KeyM', 'KeyQ', 'KeyR', 'Tab', 'Escape', 'Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(
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
        if (e.code === 'KeyM') {
          e.preventDefault();
          if (layersRef.current[layersRef.current.length - 1] === 'map') popLayer();
          else pushLayer('map');
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
      if (forceLandscapeRef.current) {
        // 顺时针旋转 90° 强制横屏坐标逆映射：物理(clientX, clientY) -> 逻辑横屏(clientY, innerWidth - clientX)
        rt.engine.mouseScreenX = e.clientY;
        rt.engine.mouseScreenY = window.innerWidth - e.clientX;
      } else {
        const rect = canvas.getBoundingClientRect();
        rt.engine.mouseScreenX = e.clientX - rect.left;
        rt.engine.mouseScreenY = e.clientY - rect.top;
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (rt.engine.mode !== 'play') return;
      if (e.target !== canvas) return;
      AudioFX.unlock();
      if (e.button === 0) {
        // 手机/触控模式下，先检测是否点中了世界中的物理交互徽章（点一下即可直接交互，不误触攻击）
        if (rt.engine.isTouchUi) {
          const prompt = rt.engine.getHudSnapshot().prompt;
          if (prompt) {
            const sx = forceLandscapeRef.current ? e.clientY : e.clientX - canvas.getBoundingClientRect().left;
            const sy = forceLandscapeRef.current
              ? window.innerWidth - e.clientX
              : e.clientY - canvas.getBoundingClientRect().top;
            const worldPt = rt.renderer.screenToWorld(sx, sy, rt.engine);
            if (Math.hypot(worldPt.x - prompt.worldX, worldPt.y - (prompt.worldY - 16)) <= 62) {
              rt.engine.triggerInstantInteract();
              return;
            }
          }
          // 手机端画面直接点地不触发挥砍（攻击走右侧大红按钮），避免误触
          return;
        }
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

  // 统一 Pointer Events 虚拟双摇杆（同时兼容手机真机多指触控与电脑端手机模拟器，并自动处理 90° 强制横屏方向映射）
  const onMovePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (moveStickRef.current.id !== null) return;
    e.stopPropagation();
    AudioFX.unlock();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 忽略不支持指针捕获的环境
    }
    moveStickRef.current = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
  };

  const onMovePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = moveStickRef.current;
    if (st.id !== e.pointerId) return;
    const rawDx = e.clientX - st.ox;
    const rawDy = e.clientY - st.oy;
    // 顺时针旋转 90° 后，物理向下(+rawDy)为横屏向右(+dx)，物理向右(+rawDx)为横屏向上(-dy)
    const dx = forceLandscapeRef.current ? rawDy : rawDx;
    const dy = forceLandscapeRef.current ? -rawDx : rawDy;
    const maxR = 46;
    const mag = Math.hypot(dx, dy);
    const scale = mag > maxR ? maxR / mag : 1;
    const nx = (dx * scale) / maxR;
    const ny = (dy * scale) / maxR;
    setMoveKnob({ x: nx * 32, y: ny * 32 });
    if (runtimeRef.current) {
      runtimeRef.current.engine.touchMoveX = nx;
      runtimeRef.current.engine.touchMoveY = ny;
      runtimeRef.current.engine.touchSprint = mag > maxR * 0.88;
    }
  };

  const onMovePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (moveStickRef.current.id !== e.pointerId) return;
    moveStickRef.current.id = null;
    setMoveKnob({ x: 0, y: 0 });
    if (runtimeRef.current) {
      runtimeRef.current.engine.touchMoveX = 0;
      runtimeRef.current.engine.touchMoveY = 0;
      runtimeRef.current.engine.touchSprint = false;
    }
  };

  const onAimPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (aimStickRef.current.id !== null) return;
    e.stopPropagation();
    AudioFX.unlock();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 忽略
    }
    aimStickRef.current = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
    if (runtimeRef.current) runtimeRef.current.engine.touchAimActive = true;
  };

  const onAimPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = aimStickRef.current;
    if (st.id !== e.pointerId) return;
    const rawDx = e.clientX - st.ox;
    const rawDy = e.clientY - st.oy;
    const dx = forceLandscapeRef.current ? rawDy : rawDx;
    const dy = forceLandscapeRef.current ? -rawDx : rawDy;
    const maxR = 46;
    const mag = Math.hypot(dx, dy);
    const scale = mag > maxR ? maxR / mag : 1;
    const nx = (dx * scale) / maxR;
    const ny = (dy * scale) / maxR;
    setAimKnob({ x: nx * 32, y: ny * 32 });
    if (runtimeRef.current) {
      runtimeRef.current.engine.touchAimX = nx;
      runtimeRef.current.engine.touchAimY = ny;
    }
  };

  const onAimPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (aimStickRef.current.id !== e.pointerId) return;
    aimStickRef.current.id = null;
    setAimKnob({ x: 0, y: 0 });
    if (runtimeRef.current) {
      runtimeRef.current.engine.touchAimActive = false;
    }
  };

  const t = (key: string, vars?: Record<string, string | number>) => {
    void lang;
    void variantTick;
    return I18n.t(key, vars);
  };

  const usePaperUI = Variants.val.paper !== 'a';
  const guidanceMode = isDev && Variants.val.guidance === 'b' ? 'reduced' : 'full';
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

  return (
    <div id="app" className="bg-[#070807] text-[#e7e2d8]">
      {/* 游戏画布：骨白圆环准星 CSS 光标（手机端支持直接轻点场景中的物理交互徽章一键交互） */}
      <canvas
        id="view"
        ref={canvasRef}
        onPointerDown={(e) => {
          if (!isTouch || e.pointerType === 'mouse') return;
          const rt = runtimeRef.current;
          if (!rt || rt.engine.mode !== 'play' || topLayer !== null) return;
          AudioFX.unlock();
          const prompt = rt.engine.getHudSnapshot().prompt;
          if (!prompt) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const sx = forceLandscapeRef.current ? e.clientY : e.clientX - rect.left;
          const sy = forceLandscapeRef.current ? window.innerWidth - e.clientX : e.clientY - rect.top;
          const worldPt = rt.renderer.screenToWorld(sx, sy, rt.engine);
          if (Math.hypot(worldPt.x - prompt.worldX, worldPt.y - (prompt.worldY - 16)) <= 66) {
            e.stopPropagation();
            rt.engine.triggerInstantInteract();
          }
        }}
        className="block w-full h-full ember-cursor"
      />

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
              <div
                className="title-top-actions flex items-center gap-3"
                style={{ marginTop: 'var(--xhs-cap-offset, 0px)' }}
              >
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

                <button
                  type="button"
                  onClick={() => pushLayer('rank')}
                  className={`title-btn ${lang === 'en' ? 'is-latin' : ''}`}
                >
                  <span className="title-btn__ember" aria-hidden="true" />
                  <span>{t('排行榜')}</span>
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
          guidanceMode={guidanceMode}
          runtimeRef={runtimeRef}
          exploreRef={exploreRef}
          onOpenLayer={pushLayer}
        />
      )}

      {/* paper=a 对照组：保留旧版卡片式 HUD（暗色极简 clean-hud 样式），供 A/B 截图比对 */}
      {hud && (hud.mode === 'play' || hud.mode === 'hold') && !usePaperUI && (
        <div
          className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between"
          data-guidance-mode={guidanceMode}
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
              {guidanceMode === 'full' && (
                <div
                  className={`text-[11px] sm:text-[12px] leading-snug ${
                    usePaperUI ? 'hud-note' : 'text-[#d8be8a]/90'
                  }`}
                  data-hud="objective"
                >
                  {t(hud.objectiveText)}
                </div>
              )}
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

      {/* TOUCH CONTROLS（手机横屏大尺寸人体工学纯美术图标物理交互，Pointer Events 同时兼容真机多指与模拟器） */}
      {isTouch && hud?.mode === 'play' && topLayer === null && (
        <div className="pointer-events-none fixed inset-0 z-25">
          {/* 左侧大尺寸移动虚拟摇杆（拉满边缘自动疾跑） */}
          <div
            onPointerDown={onMovePointerDown}
            onPointerMove={onMovePointerMove}
            onPointerUp={onMovePointerUp}
            onPointerCancel={onMovePointerUp}
            className="touch-stick touch-stick--move pointer-events-auto fixed w-28 h-28 rounded-full border-2 border-[#c9b796]/42 bg-black/38 flex items-center justify-center shadow-[0_6px_22px_rgba(0,0,0,0.68)]"
          >
            <div
              className="w-12 h-12 rounded-full bg-[#c9b796]/48 border border-[#f2e8d2]/60 pointer-events-none"
              style={{ transform: `translate(${moveKnob.x}px, ${moveKnob.y}px)` }}
            />
          </div>

          {/* 右侧物理化纯图标动作集群 + 瞄准摇杆 */}
          <div className="touch-cluster pointer-events-auto fixed flex items-end gap-3">
            <div className="flex flex-col gap-2.5 items-end">
              <div className="flex items-center gap-2.5">
                {(hud.equip?.mode === 'pistol' || (hud.equip && !hud.equip.torchLit)) && (
                  <button
                    type="button"
                    aria-label={t('换弹')}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      AudioFX.unlock();
                      runtimeRef.current?.engine.reloadWeapon();
                    }}
                    className="w-12 h-12 min-w-[48px] min-h-[48px] rounded-full bg-[#1a1814]/92 border border-[#d6c8ad]/55 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
                  >
                    <ReloadInkIcon className="w-6 h-6" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('闪避')}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    AudioFX.unlock();
                    runtimeRef.current?.engine.triggerDodge();
                  }}
                  className="w-[52px] h-[52px] min-w-[52px] min-h-[52px] rounded-full bg-[#152420]/92 border border-[#7bc2ac]/65 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
                >
                  <DodgeInkIcon className="w-6 h-6" />
                </button>
                <button
                  type="button"
                  aria-label={hud.draggingFurniture ? t('松开') : t('搜刮')}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    AudioFX.unlock();
                    if (!runtimeRef.current) return;
                    runtimeRef.current.engine.touchInteract = true;
                    runtimeRef.current.engine.triggerInstantInteract();
                  }}
                  onPointerUp={() => {
                    if (runtimeRef.current) runtimeRef.current.engine.touchInteract = false;
                  }}
                  onPointerCancel={() => {
                    if (runtimeRef.current) runtimeRef.current.engine.touchInteract = false;
                  }}
                  className={`w-[54px] h-[54px] min-w-[54px] min-h-[54px] rounded-full border-2 flex items-center justify-center shadow-lg active:scale-95 transition-transform ${
                    hud.prompt
                      ? 'bg-[#2e2414]/95 border-[#e8be6c] shadow-[0_0_18px_rgba(232,190,108,0.55)]'
                      : 'bg-[#1a1814]/90 border-[#d8b463]/55'
                  }`}
                >
                  <InteractHandIcon className="w-7 h-7" />
                </button>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  aria-label={t('切换武器')}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    AudioFX.unlock();
                    runtimeRef.current?.engine.toggleWeapon();
                  }}
                  className="w-12 h-12 min-w-[48px] min-h-[48px] rounded-full bg-[#1a1814]/92 border border-[#c9824f]/65 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
                >
                  {hud.equip?.mode === 'pistol' ? (
                    <FlameInkIcon className="w-6 h-6 text-[#e8a354]" />
                  ) : (
                    <PistolInkIcon className="w-6 h-6" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label={hud.equip?.mode === 'pistol' ? t('射击') : t('攻击')}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    AudioFX.unlock();
                    if (!runtimeRef.current) return;
                    runtimeRef.current.engine.mouseDownLeft = true;
                    runtimeRef.current.engine.beginAttackCharge();
                  }}
                  onPointerUp={() => {
                    if (!runtimeRef.current) return;
                    runtimeRef.current.engine.mouseDownLeft = false;
                    runtimeRef.current.engine.releaseAttackCharge();
                  }}
                  onPointerCancel={() => {
                    if (!runtimeRef.current) return;
                    runtimeRef.current.engine.mouseDownLeft = false;
                    runtimeRef.current.engine.releaseAttackCharge();
                  }}
                  className="relative w-16 h-16 min-w-[64px] min-h-[64px] rounded-full bg-[#6d221c]/94 border-2 border-[#e08276]/80 flex items-center justify-center shadow-[0_6px_22px_rgba(0,0,0,0.75)] active:scale-95 transition-transform"
                >
                  {hud.chargeRatio > 0.05 && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -inset-1 rounded-full border-2 border-[#f2c46d]"
                      style={{ opacity: hud.chargeRatio }}
                    />
                  )}
                  {hud.equip?.mode === 'pistol' ? (
                    <PistolInkIcon className="w-8 h-8" />
                  ) : (
                    <AxeInkIcon className="w-8 h-8" />
                  )}
                </button>
              </div>
            </div>

            {/* 右侧瞄准与照明摇杆 */}
            <div
              onPointerDown={onAimPointerDown}
              onPointerMove={onAimPointerMove}
              onPointerUp={onAimPointerUp}
              onPointerCancel={onAimPointerUp}
              className="w-28 h-28 rounded-full border-2 border-[#d8b463]/42 bg-black/38 flex items-center justify-center shadow-[0_6px_22px_rgba(0,0,0,0.68)]"
            >
              <div
                className="w-12 h-12 rounded-full bg-[#d8b463]/48 border border-[#f2cf84]/65 pointer-events-none"
                style={{ transform: `translate(${aimKnob.x}px, ${aimKnob.y}px)` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* UNIFIED LAYER STACK MODALS（类魂游实物载体美术：四角蚀刻雕花 / 渐隐暗金分隔纹 / 严格上下留白不顶边） */}
      {topLayer && (
        <div
          className="fixed inset-0 z-[45] flex items-center justify-center bg-black/72 backdrop-blur-[2px]"
          style={{
            paddingLeft: 'max(16px, var(--gl))',
            paddingRight: 'max(16px, var(--gr))',
            paddingTop: 'max(16px, var(--gt))',
            paddingBottom: 'max(16px, var(--gb))',
          }}
          onClick={() => popLayer()}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full ${topLayer === 'map' || topLayer === 'craft' ? 'max-w-xl' : 'max-w-lg'} max-h-full sm:max-h-[86vh] flex flex-col overflow-hidden carrier-sheet ${
              topLayer === 'map'
                ? 'carrier-scroll'
                : topLayer === 'craft'
                ? 'carrier-workbench'
                : topLayer === 'journal'
                ? 'carrier-notebook'
                : topLayer === 'pause'
                ? 'carrier-parchment'
                : 'carrier-dossier'
            }`}
          >
            {/* 类魂游四角暗金雕花角饰 */}
            <SoulFrameCorners />

            {/* 卷轴顶部木杆装饰（仅地图卷轴显示） */}
            {topLayer === 'map' && <div className="carrier-scroll__rod" aria-hidden="true" />}

            {/* Fixed Modal Header (zero position: sticky) */}
            <div className="carrier-header flex items-center justify-between px-5 py-3 shrink-0">
              <div className="flex items-center gap-2.5">
                <span className="carrier-seal" aria-hidden="true" />
                <h2 className="font-display text-base sm:text-lg font-semibold tracking-[0.14em] text-[#f0e6d2]">
                  {topLayer === 'pause' && t('暂停')}
                  {topLayer === 'craft' && t('工作台')}
                  {topLayer === 'journal' && t('生存日志')}
                  {topLayer === 'map' && t('探索地图')}
                  {topLayer === 'rank' && t('生存排行榜')}
                  {topLayer === 'settings' && t('设置')}
                  {topLayer === 'controls' && t('操作说明')}
                  {topLayer === 'dev' && t('开发者 Variants 面板')}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => popLayer()}
                aria-label={t('关闭')}
                className="min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center text-[#c7b99c] hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <SoulDivider className="px-4 shrink-0" />

            {/* Scrollable Body */}
            <div className="carrier-body ember-scroll overflow-y-auto px-5 py-3.5 flex-1 space-y-3.5">
              {topLayer === 'pause' && (
                <div className="soul-pause-grid flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => clearLayers()}
                    className="soul-menuitem soul-menuitem--primary"
                  >
                    <Play className="w-3.5 h-3.5 fill-current text-[#e5be72]" />
                    <span>{t('继续求生')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => pushLayer('journal')}
                    className="soul-menuitem"
                  >
                    <BookOpen className="w-4 h-4 text-[#c8a974]" />
                    <span>{t('羊皮生存日志')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => pushLayer('craft')}
                    className="soul-menuitem"
                  >
                    <Hammer className="w-4 h-4 text-[#d1a464]" />
                    <span>{t('工作台制作')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => pushLayer('settings')}
                    className="soul-menuitem"
                  >
                    <Settings className="w-4 h-4 text-[#c4b49a]" />
                    <span>{t('设置')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => pushLayer('rank')}
                    className="soul-menuitem"
                  >
                    <Trophy className="w-4 h-4 text-[#dfb763]" />
                    <span>{t('生存排行榜')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => pushLayer('controls')}
                    className="soul-menuitem"
                  >
                    <span>{t('操作说明')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      clearLayers();
                      runtimeRef.current?.engine.reset(
                        (runtimeRef.current.engine.world.seed + 7) % 99991,
                        true
                      );
                    }}
                    className="soul-menuitem soul-menuitem--danger text-[#d8c2bc]"
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
                    className="soul-menuitem text-[#b8ae9c]"
                  >
                    <span>{t('回到标题')}</span>
                  </button>
                </div>
              )}

              {/* 真实探索大地图（M 键 / 手机端点击右上角小地图直接展开，展示走过的范围与实时位置） */}
              {topLayer === 'map' && hud && (
                <div className="space-y-2.5">
                  <WorldMapView runtimeRef={runtimeRef} exploreRef={exploreRef} />
                </div>
              )}

              {/* 生存纪事（已去除手绘草图，地图请直接按 M 或点击小地图查看真实探索范围） */}
              {topLayer === 'journal' && hud && (
                <div className="space-y-3">
                  <div className="space-y-2.5">
                    {hud.journal.map((entry) => (
                      <div key={entry.id} className={`p-3 rounded ${cardCls}`}>
                        <div className="flex items-center justify-between gap-2 text-xs text-[#b89f74]">
                          <span className="font-medium text-[#efe4cf]">{entry.title}</span>
                          <span className="font-mono-num shrink-0">
                            D{entry.day} ·{' '}
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
              )}

              {/* 东欧旧木工台：缝线麻布材料袋 + 蓝图锻造卡片（少文字、所见即所得） */}
              {topLayer === 'craft' && hud && (
                <div className="workbench-surface space-y-3.5">
                  {/* 顶部缝线麻布工具袋（实体素材包） */}
                  <div className="carrier-pouch workbench-tray">
                    {RESOURCE_META.map((item) => (
                      <div
                        key={item.key}
                        className={`workbench-mat ${hud.inv[item.key] <= 0 ? 'is-zero' : ''}`}
                        title={t(item.label)}
                      >
                        <ResourceInkIcon kind={item.key} className="w-6 h-6" />
                        <span className="font-mono-num text-sm font-bold text-[#efe4cc]">
                          {hud.inv[item.key]}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* 物理锻造蓝图卡片网格 */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {CRAFT_RECIPES.map((r) => {
                      const ownedAxe = r.id === 'axe' && hud.inv.weaponTier >= 2;
                      const canAfford =
                        !ownedAxe &&
                        (Object.entries(r.cost) as [ResourceKey, number][]).every(
                          ([k, qty]) => hud.inv[k] >= qty
                        );
                      const outputIcon =
                        r.id === 'bandage' ? (
                          <BandageInkIcon className="w-11 h-11" />
                        ) : r.id === 'flare' ? (
                          <FlareInkIcon className="w-11 h-11" />
                        ) : r.id === 'trap' ? (
                          <TrapInkIcon className="w-11 h-11" />
                        ) : r.id === 'cell' ? (
                          <ResourceInkIcon kind="battery" className="w-11 h-11" />
                        ) : (
                          <AxeInkIcon className="w-11 h-11" />
                        );
                      return (
                        <button
                          key={r.id}
                          type="button"
                          disabled={!canAfford}
                          onClick={() => runtimeRef.current?.engine.craft(r.id)}
                          aria-label={t(r.name)}
                          className={`workbench-card ${
                            ownedAxe ? 'is-owned' : canAfford ? 'is-ready' : 'is-locked'
                          }`}
                        >
                          <div className="workbench-card__icon">
                            {outputIcon}
                            <span className="workbench-card__badge font-mono-num">
                              {ownedAxe ? '✓' : r.outputText}
                            </span>
                          </div>
                          <div className="workbench-card__body">
                            <div className="workbench-card__costs">
                              {(Object.entries(r.cost) as [ResourceKey, number][]).map(([k, qty]) => {
                                const enough = hud.inv[k] >= qty;
                                return (
                                  <span
                                    key={k}
                                    className={`workbench-cost ${enough ? 'is-ok' : 'is-lack'}`}
                                  >
                                    <ResourceInkIcon kind={k} className="w-5 h-5" />
                                    <span className="font-mono-num">
                                      {hud.inv[k]}/{qty}
                                    </span>
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                          <span className="workbench-card__forge" aria-hidden="true">
                            <Hammer className="w-5 h-5" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {topLayer === 'rank' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        ['all', '总榜'],
                        ['week', '周榜'],
                        ['day', '日榜'],
                      ] as Array<[XhsRankPeriod, string]>
                    ).map(([period, label]) => (
                      <button
                        key={period}
                        type="button"
                        onClick={() => setRankPeriod(period)}
                        className={`min-h-[40px] rounded text-xs font-medium border transition-colors ${
                          rankPeriod === period
                            ? 'bg-[#b87b3b]/30 border-[#e0b86c] text-[#f6e8c9]'
                            : 'bg-[#171410] border-[#b8ae9c]/22 text-[#b8ae9c] hover:text-white'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* 本人战绩 / 排名概览条 */}
                  <div className="flex items-center justify-between px-3 py-2 rounded border border-[#c8a468]/30 bg-black/35 text-xs">
                    <span className="text-[#c7b99c]">我的最佳排名</span>
                    <span className="font-mono-num text-[#f0dcb4] font-semibold">
                      {rankLoading
                        ? '读取中...'
                        : rankData?.ok
                        ? rankData.myRank.status === 'EXACT' && rankData.myRank.rank !== null
                          ? `第 ${rankData.myRank.rank} 名 · ${rankData.myRank.score ?? 0} 分`
                          : rankData.myRank.status === 'OVER_LIMIT'
                          ? `500+ 名 · 最高 ${rankData.localBest} 分`
                          : `暂未上榜 · 本机最高 ${rankData.localBest} 分`
                        : `本机最高 ${rankData?.localBest ?? getLocalBestScore()} 分`}
                    </span>
                  </div>

                  {rankLoading ? (
                    <div className="py-6 text-center text-xs text-[#a89e8c]">正在同步幽林幸存者名录……</div>
                  ) : rankData?.ok && rankData.entries.length > 0 ? (
                    <div className="rounded border border-[#b8ae9c]/20 bg-black/28 overflow-hidden">
                      {rankData.entries.slice(0, 50).map((item) => (
                        <div
                          key={`${item.rank}-${item.nickname}`}
                          className={`soul-rank-row ${item.rank <= 3 ? 'is-top' : ''}`}
                        >
                          <span
                            className={`font-mono-num font-bold text-center ${
                              item.rank === 1
                                ? 'text-[#f2c86b]'
                                : item.rank === 2
                                ? 'text-[#cfd6dc]'
                                : item.rank === 3
                                ? 'text-[#d49664]'
                                : 'text-[#8c8272]'
                            }`}
                          >
                            #{item.rank}
                          </span>
                          <span className="truncate text-[#e6dcc6]">{item.nickname}</span>
                          <span className="font-mono-num text-[#d8be8a] font-semibold">{item.score}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-5 px-4 text-center space-y-1.5 rounded border border-[#b8ae9c]/18 bg-black/25">
                      <div className="text-sm text-[#e4d8c0]">
                        {rankData?.ok
                          ? '本期暂无人上榜，成为第一位幸存者吧！'
                          : rankData?.reason === 'unauthorized'
                          ? '排行榜需在小工具授权昵称后开启'
                          : '请在小红书小工具内查看全服排行榜'}
                      </div>
                      <div className="text-xs text-[#9c9282]">
                        当前已为你保留本机最高生存积分（{rankData?.localBest ?? getLocalBestScore()} 分）
                      </div>
                    </div>
                  )}
                </div>
              )}

              {topLayer === 'settings' && (
                <div className="space-y-4">
                  <div>
                    <div className="text-xs text-[#a8a091] mb-2">{t('视野范围')}</div>
                    <div className="grid grid-cols-4 gap-2">
                      {([0, 1, 2, 3] as ViewScaleLevel[]).map((lvl) => {
                        const active = viewScale === lvl;
                        return (
                          <button
                            key={lvl}
                            type="button"
                            onClick={() => Quality.setViewScale(lvl)}
                            className={`min-h-[44px] rounded text-xs sm:text-sm font-medium border transition-colors whitespace-nowrap ${
                              active
                                ? 'bg-[#b87b3b] border-[#d8b463] text-[#110e0a]'
                                : 'bg-[#1b1915] border-[#b8ae9c]/22 text-[#c7bfb0] hover:text-white'
                            }`}
                          >
                            {VIEW_SCALE_PRESETS[lvl].label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
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
                        {v.reloadOnChange && <span className="text-[#777165] ml-1">· 切换后重载</span>}
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

            <SoulDivider className="px-4 shrink-0" />
            <div className="carrier-footer px-5 py-2.5 flex justify-end shrink-0">
              <button
                type="button"
                onClick={() => popLayer()}
                className="soul-menuitem min-h-[44px] px-6 text-sm"
              >
                {t('返回')}
              </button>
            </div>
            {/* 卷轴底部木杆装饰 */}
            {topLayer === 'map' && <div className="carrier-scroll__rod" aria-hidden="true" />}
          </div>
        </div>
      )}

      {/* VICTORY SUMMARY: 破雾撤离通关结算（类魂游双栏封缄信笺，横屏一屏完整展示零滚动） */}
      {hud?.mode === 'victory' && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/82 backdrop-blur-xs"
          style={{
            paddingLeft: 'max(16px, var(--gl))',
            paddingRight: 'max(16px, var(--gr))',
            paddingTop: 'max(16px, var(--gt))',
            paddingBottom: 'max(16px, var(--gb))',
          }}
        >
          <div className="soul-summary-sheet w-full max-w-md max-h-full overflow-y-auto ember-scroll p-5 sm:p-6 text-center carrier-sheet carrier-parchment carrier-parchment--gold">
            <SoulFrameCorners />
            <div className="soul-summary-grid space-y-4 sm:space-y-0">
              <div className="space-y-3">
                <div className="flex items-center justify-center sm:justify-start gap-2.5">
                  <Sun className="w-7 h-7 text-[#dfb763] shrink-0" />
                  <div>
                    <h2 className="font-display text-xl sm:text-2xl font-semibold tracking-[0.12em] text-[#f3e6c8]">
                      {t('破雾撤离')}
                    </h2>
                    <div className="font-mono-num text-xs text-[#d6be86]">
                      生存积分 {runtimeRef.current?.engine.getSurvivalScore() ?? 0}
                    </div>
                  </div>
                </div>
                <SoulDivider />
                <div className="grid grid-cols-2 gap-2 text-left">
                  <div className={`px-3 py-2 rounded ${cardCls}`}>
                    <div className="text-[11px] text-[#9c9485]">{t('存活天数')}</div>
                    <div className="font-mono-num text-lg font-semibold text-[#f0e6d2]">{hud.day}</div>
                  </div>
                  <div className={`px-3 py-2 rounded ${cardCls}`}>
                    <div className="text-[11px] text-[#9c9485]">{t('搜刮容器')}</div>
                    <div className="font-mono-num text-lg font-semibold text-[#f0e6d2]">
                      {hud.containersLooted}/{hud.totalContainers}
                    </div>
                  </div>
                  <div className={`px-3 py-2 rounded ${cardCls}`}>
                    <div className="text-[11px] text-[#9c9485]">{t('击退怪物')}</div>
                    <div className="font-mono-num text-lg font-semibold text-[#f0e6d2]">
                      {hud.enemiesDefeated}
                    </div>
                  </div>
                  <div className={`px-3 py-2 rounded ${cardCls}`}>
                    <div className="text-[11px] text-[#9c9485]">{t('中继零件')}</div>
                    <div className="font-mono-num text-lg font-semibold text-[#7ad8c5]">
                      {hud.relayInstalled}/3
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => runtimeRef.current?.engine.continueEndless()}
                  className="soul-menuitem soul-menuitem--primary"
                >
                  <Play className="w-3.5 h-3.5 fill-current text-[#e5be72]" />
                  <span>{t('继续无尽求生')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => pushLayer('rank')}
                  className="soul-menuitem"
                >
                  <Trophy className="w-4 h-4 text-[#dfb763]" />
                  <span>{t('生存排行榜')}</span>
                </button>
                <button type="button" onClick={startSurvival} className="soul-menuitem">
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>{t('再次踏入森林')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => runtimeRef.current?.engine.reset(19847, false)}
                  className="soul-menuitem text-[#b8ae9c]"
                >
                  <span>{t('回到标题')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* GAME OVER SUMMARY（类魂游双栏血染遗书：横屏一屏完整展示 + 发笔记/分享复活 + 排行榜） */}
      {hud?.mode === 'dead' && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/82 backdrop-blur-xs"
          style={{
            paddingLeft: 'max(16px, var(--gl))',
            paddingRight: 'max(16px, var(--gr))',
            paddingTop: 'max(16px, var(--gt))',
            paddingBottom: 'max(16px, var(--gb))',
          }}
        >
          <div className="soul-summary-sheet w-full max-w-md max-h-full overflow-y-auto ember-scroll p-5 sm:p-6 text-center carrier-sheet carrier-parchment carrier-parchment--blood">
            <SoulFrameCorners />
            <div className="soul-summary-grid space-y-4 sm:space-y-0">
              {/* 左栏：标题 + 积分 + 2×2 战绩 */}
              <div className="space-y-3">
                <div className="flex items-center justify-center sm:justify-start gap-2.5">
                  <ShieldAlert className="w-7 h-7 text-[#c95347] shrink-0" />
                  <div>
                    <h2 className="font-display text-xl sm:text-2xl font-semibold tracking-[0.12em] text-[#f0dcd8]">
                      {t('黑暗吞噬了你')}
                    </h2>
                    <div className="font-mono-num text-xs text-[#d6a39a]">
                      生存积分 {runtimeRef.current?.engine.getSurvivalScore() ?? 0}
                    </div>
                  </div>
                </div>
                <SoulDivider />
                <div className="grid grid-cols-2 gap-2 text-left">
                  <div className={`px-3 py-2 rounded ${cardCls}`}>
                    <div className="text-[11px] text-[#9c9485]">{t('存活天数')}</div>
                    <div className="font-mono-num text-lg font-semibold text-[#f0e6d2]">{hud.day}</div>
                  </div>
                  <div className={`px-3 py-2 rounded ${cardCls}`}>
                    <div className="text-[11px] text-[#9c9485]">{t('搜刮容器')}</div>
                    <div className="font-mono-num text-lg font-semibold text-[#f0e6d2]">
                      {hud.containersLooted}/{hud.totalContainers}
                    </div>
                  </div>
                  <div className={`px-3 py-2 rounded ${cardCls}`}>
                    <div className="text-[11px] text-[#9c9485]">{t('击退怪物')}</div>
                    <div className="font-mono-num text-lg font-semibold text-[#f0e6d2]">
                      {hud.enemiesDefeated}
                    </div>
                  </div>
                  <div className={`px-3 py-2 rounded ${cardCls}`}>
                    <div className="text-[11px] text-[#9c9485]">{t('幽光菇收集')}</div>
                    <div className="font-mono-num text-lg font-semibold text-[#7ad8c5]">
                      {hud.essenceCollected}
                    </div>
                  </div>
                </div>
                <div className="text-[11px] text-[#a99a86] leading-snug">
                  点右上角「···」关注作者支持更新
                </div>
              </div>

              {/* 右栏：类魂游复活 & 榜单 & 重开操作栏 */}
              <div className="flex flex-col gap-2">
                {(runtimeRef.current?.engine.revivesUsed ?? 0) < (runtimeRef.current?.engine.maxRevives ?? 2) && (
                  <>
                    <button
                      type="button"
                      disabled={reviveBusy}
                      onClick={handleReviveByNote}
                      className="soul-menuitem soul-menuitem--primary"
                    >
                      <Sparkles className="w-4 h-4 text-[#f0c774]" />
                      <span>{reviveBusy ? '唤起中...' : '发笔记原地复活'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={reviveBusy}
                      onClick={handleReviveByShare}
                      className="soul-menuitem"
                    >
                      <Share2 className="w-4 h-4 text-[#d8b463]" />
                      <span>{reviveBusy ? '唤起中...' : '分享卡片复活'}</span>
                    </button>
                  </>
                )}
                {reviveMsg && (
                  <div className="text-[11px] text-[#e0927c] text-center px-1">{reviveMsg}</div>
                )}
                <button
                  type="button"
                  onClick={() => pushLayer('rank')}
                  className="soul-menuitem"
                >
                  <Trophy className="w-4 h-4 text-[#dfb763]" />
                  <span>{t('生存排行榜')}</span>
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={startSurvival}
                    className="soul-menuitem px-2 text-xs"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{t('再次踏入')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => runtimeRef.current?.engine.reset(19847, false)}
                    className="soul-menuitem px-2 text-xs text-[#b8ae9c]"
                  >
                    <span>{t('回到标题')}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
