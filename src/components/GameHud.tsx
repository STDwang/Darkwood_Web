// 第二轮游戏内 HUD（paper 变体 b）：对标 Darkwood / The Forest / Amnesia 等 PC 端恐怖游戏，
// HUD 像"融入世界的旧物"——去掉圆角卡片与方框面板，只留墨线、铁框、做旧纸与余烬色。
// 布局：左上 衬线时段行 + 昼夜弧形刻度 + 发电机 + 目标便签；右上 墨线图标按钮 + 实时小地图；
//       左下 手绘生命/体力条 + 电池刻度格（兼手电开关）；右下 资源极小计数行 + 4 格做旧快捷栏。
// 约束：保留检查脚本依赖的 aria-label（暂停 / 日志 / 制作 / 手电 / 照明弹 / 草药绷带 / 捕兽夹 / 电池）；
//       全部按钮命中区 ≥ 44px；悬停提示仅 opacity 显隐（隐藏时 < 0.05 不参与文字审计）；零 sticky。

import React, { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import {
  BandageInkIcon,
  CraftInkIcon,
  FlameInkIcon,
  FlareInkIcon,
  FlashlightInkIcon,
  JournalInkIcon,
  PauseInkIcon,
  ResourceInkIcon,
  TrapInkIcon,
  WeatherInkIcon,
} from './InkIcons';
import Minimap, { MinimapExploreState } from './Minimap';
import { GameRuntime } from '../game/runtime';
import { HudSnapshot, ResourceKey } from '../game/types';

type HudLayer = 'journal' | 'craft' | 'pause' | 'dev';
type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface GameHudProps {
  hud: HudSnapshot;
  t: TFn;
  isDev: boolean;
  guidanceMode: 'full' | 'reduced';
  runtimeRef: { current: GameRuntime | null };
  exploreRef: { current: MinimapExploreState | null };
  onOpenLayer: (id: HudLayer) => void;
}

/** 资源极小计数：低饱和墨色，避免与场景抢视线 */
const RES_META: Array<{ key: ResourceKey; label: string; color: string }> = [
  { key: 'wood', label: '木材', color: '#b8996e' },
  { key: 'scrap', label: '废铁', color: '#9aa1a3' },
  { key: 'fuel', label: '燃油', color: '#c98a5e' },
  { key: 'herbs', label: '布草', color: '#8fa882' },
  { key: 'battery', label: '电池', color: '#cdb56e' },
  { key: 'essence', label: '幽光菇', color: '#7fb8aa' },
];

/** 昼夜弧：与 engine.ts 90s 昼 / 25s 黄昏 / 75s 夜 的分段一致（纯装饰） */
const ARC_DAY_END = 90 / 190;
const ARC_DUSK_END = 115 / 190;
const ARC_W = 132;
const ARC_R = 150;
const ARC_CY = 156;
const ARC_HALF = Math.asin((ARC_W / 2 - 4) / ARC_R);

function arcPoint(u: number, r = ARC_R) {
  const a = -ARC_HALF + ARC_HALF * 2 * Math.min(1, Math.max(0, u));
  return { x: ARC_W / 2 + r * Math.sin(a), y: ARC_CY - r * Math.cos(a) };
}

function arcPath(u0: number, u1: number) {
  const p0 = arcPoint(u0);
  const p1 = arcPoint(u1);
  return `M${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A${ARC_R} ${ARC_R} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

/** R3：手枪墨线小图标（与 InkIcons 同风格：细描边、无填充） */
function PistolInkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 8.5h14.5l1.5 1.6v1.4H11l-1.2 1.2.8 5.3H6.8l.6-5.6-3.9-1.1z" />
      <path d="M11 11.5c.4 1.4 1.6 2 2.6 1.6" />
    </svg>
  );
}

/** 数值变化时短暂置 true（默认 1.5s），首帧不触发 */
function useFlash(value: number, ms = 1500): boolean {
  const prev = useRef(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setOn(true);
    const id = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return on;
}

/** 昼夜进度：一枚极细弧形刻度 + 日/月相游标 */
function DayArc({ dayTime, phase }: { dayTime: number; phase: HudSnapshot['phase'] }) {
  const ticks: React.ReactNode[] = [];
  for (let i = 0; i <= 19; i++) {
    const u = i / 19;
    const major = i % 5 === 0;
    const a = arcPoint(u);
    const b = arcPoint(u, ARC_R - (major ? 3.6 : 2.2));
    ticks.push(
      <line
        key={i}
        x1={a.x.toFixed(2)}
        y1={a.y.toFixed(2)}
        x2={b.x.toFixed(2)}
        y2={b.y.toFixed(2)}
        strokeWidth={major ? 0.9 : 0.6}
      />
    );
  }
  const m = arcPoint(dayTime);
  const bounds = [ARC_DAY_END, ARC_DUSK_END].map((u, i) => {
    const a = arcPoint(u, ARC_R + 2.4);
    const b = arcPoint(u, ARC_R - 4.4);
    return <line key={`b${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={1} />;
  });
  return (
    <svg className="hud2-arc" viewBox={`0 0 ${ARC_W} 24`} aria-hidden="true">
      <path d={arcPath(0, ARC_DAY_END)} className="hud2-arc__seg hud2-arc__seg--day" />
      <path d={arcPath(ARC_DAY_END, ARC_DUSK_END)} className="hud2-arc__seg hud2-arc__seg--dusk" />
      <path d={arcPath(ARC_DUSK_END, 1)} className="hud2-arc__seg hud2-arc__seg--night" />
      <g className="hud2-arc__ticks">{ticks}</g>
      <g className="hud2-arc__bounds">{bounds}</g>
      <g transform={`translate(${m.x.toFixed(2)} ${m.y.toFixed(2)})`}>
        {phase === 'night' ? (
          <path className="hud2-arc__moon" d="M0 -3.1 A3.1 3.1 0 1 0 0 3.1 A3.8 3.8 0 0 1 0 -3.1 Z" />
        ) : (
          <>
            <circle r="4.6" className="hud2-arc__glow" />
            <circle r="2.5" className={`hud2-arc__sun ${phase === 'dusk' ? 'is-dusk' : ''}`} />
          </>
        )}
      </g>
    </svg>
  );
}

/** 手绘质感细长条：生命（左起收缩、受伤溅墨）/ 体力（两端收缩、低于 25% 颤动） */
function InkBar({
  kind,
  value,
  max,
  label,
}: {
  kind: 'hp' | 'st';
  value: number;
  max: number;
  label: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const flash = useFlash(value);

  // 受伤溅墨：生命下降时在条的当前末端炸开一团干涸墨点（key 递增以重放动画）
  const prevRef = useRef(value);
  const [splat, setSplat] = useState<{ n: number; at: number }>({ n: 0, at: 1 });
  useEffect(() => {
    if (kind === 'hp' && value < prevRef.current - 0.5) {
      setSplat((s) => ({ n: s.n + 1, at: max > 0 ? Math.min(1, Math.max(0, value / max)) : 0 }));
    }
    prevRef.current = value;
  }, [kind, value, max]);

  const clip =
    kind === 'hp'
      ? `inset(0 ${((1 - ratio) * 100).toFixed(2)}% 0 0)`
      : `inset(0 ${((1 - ratio) * 50).toFixed(2)}% 0 ${((1 - ratio) * 50).toFixed(2)}%)`;
  const low = kind === 'hp' ? value <= 28 : ratio < 0.25;

  return (
    <div className={`hud2-barrow hud2-barrow--${kind}`}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className={`hud2-bar hud2-bar--${kind} ${low ? 'is-low' : ''}`}
      >
        <div className="hud2-bar__clip">
          <div className="hud2-bar__track" />
          <div className="hud2-bar__fill" style={{ clipPath: clip }} />
          {kind === 'hp' && (
            <div
              className="hud2-bar__rider"
              style={{ transform: `translateX(${(-(1 - ratio) * 100).toFixed(2)}%)` }}
            />
          )}
        </div>
        {kind === 'hp' && splat.n > 0 && (
          <span key={splat.n} className="hud2-splat" style={{ left: `${(splat.at * 100).toFixed(2)}%` }}>
            <svg viewBox="0 0 30 22" className="hud2-splat__ink" aria-hidden="true">
              <path d="M13 9.2c1.6-2.4 4.6-2.2 5.6.2 1 2.4-.4 4.8-3 4.9-2.6.2-4-2.6-2.6-5.1Z" />
              <circle cx="22.6" cy="6.2" r="1.6" />
              <circle cx="25.8" cy="12.6" r="1.1" />
              <circle cx="7.2" cy="13.8" r="1.4" />
              <circle cx="9.6" cy="5" r="0.9" />
              <circle cx="18.4" cy="17.6" r="1.2" />
              <path d="M19.4 11.4c2 .4 3.6 1.4 4.6 2.8" strokeWidth="0.9" fill="none" stroke="currentColor" />
            </svg>
          </span>
        )}
      </div>
      <span className={`hud2-num ${flash ? 'is-on' : ''}`}>{value}</span>
    </div>
  );
}

export default function GameHud({
  hud,
  t,
  isDev,
  guidanceMode,
  runtimeRef,
  exploreRef,
  onOpenLayer,
}: GameHudProps) {
  const phaseLabel = hud.phase === 'night' ? t('黑夜') : hud.phase === 'dusk' ? t('黄昏') : t('白昼');
  const weatherLabel =
    hud.weather === 'storm' ? t('雷暴') : hud.weather === 'drizzle' ? t('细雨') : t('浓雾');

  const batteryCells = hud.battery <= 0 ? 0 : Math.min(5, Math.ceil(hud.battery / 20));
  const batteryLow = hud.battery < 20;

  const slots: Array<{ n: number; label: string; count: number; tint: string; icon: React.ReactNode }> = [
    {
      n: 1,
      label: '照明弹',
      count: hud.inv.flares,
      tint: '#c9824f',
      icon: <FlareInkIcon className="hud2-slot__svg" />,
    },
    {
      n: 2,
      label: '草药绷带',
      count: hud.inv.bandages,
      tint: '#93ab86',
      icon: <BandageInkIcon className="hud2-slot__svg" />,
    },
    {
      n: 3,
      label: '捕兽夹',
      count: hud.inv.traps,
      tint: '#aaa69c',
      icon: <TrapInkIcon className="hud2-slot__svg" />,
    },
    {
      n: 4,
      label: '电池',
      count: hud.inv.battery,
      tint: '#cdb56e',
      icon: <ResourceInkIcon kind="battery" className="hud2-slot__svg" />,
    },
  ];

  return (
    <div
      className={`hud2 pointer-events-none fixed inset-0 z-20 flex flex-col justify-between ${
        hud.dangerLevel >= 65 ? 'is-threat' : ''
      }`}
      aria-live="polite"
      data-guidance-mode={guidanceMode}
    >
      {/* ================= 顶部：左上时段 / 右上图标 + 小地图 ================= */}
      <div className="hud2-top">
        <div className="hud2-tl">
          <div className="hud2-time">
            <span className="hud2-time__day">{t('第 {n} 天', { n: hud.day })}</span>
            <span className="hud2-time__sep" aria-hidden="true">
              ·
            </span>
            <span className={`hud2-time__phase is-${hud.phase}`}>{phaseLabel}</span>
            <span className="hud2-time__sep" aria-hidden="true">
              ·
            </span>
            <span className="hud2-time__wx">
              <WeatherInkIcon kind={hud.weather} className="hud2-time__wxicon" />
              <span>{weatherLabel}</span>
            </span>
            <span className="hud2-time__sep" aria-hidden="true">
              ·
            </span>
            <span className="hud2-time__zone">{t(hud.zoneName)}</span>
          </div>

          <DayArc dayTime={hud.dayTime} phase={hud.phase} />

          <div
            className={`hud2-gen ${
              hud.generatorFuel <= 0 ? 'is-out' : hud.generatorFuel < 20 ? 'is-low' : ''
            } ${hud.generatorOn && hud.generatorFuel > 0 ? 'is-on' : ''}`}
          >
            <FlameInkIcon className="hud2-gen__icon" />
            <span>{t('发电机燃油')}</span>
            <span className="hud2-gen__val">{hud.generatorFuel}%</span>
            {hud.generatorFuel <= 0 && <span className="hud2-gen__warn">{t('发电机熄火')}</span>}
          </div>

          {/* 当前目标：保留手写日志便签样式 */}
          {guidanceMode === 'full' && (
            <div className="hud-note hud2-objective" data-hud="objective">
              {t(hud.objectiveText)}
            </div>
          )}
        </div>

        <div className="hud2-tr">
          <div className="hud2-actions">
            {isDev && (
              <button
                type="button"
                onClick={() => onOpenLayer('dev')}
                className="hud2-devbtn"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span className="font-mono-num">
                  {hud.backend === 'webgl2' ? 'GL2' : '2D'} · {hud.fps}fps
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenLayer('journal')}
              aria-label={t('日志')}
              className="hud2-iconbtn"
            >
              <JournalInkIcon className="hud2-iconbtn__svg" />
              <span className="hud2-tip" aria-hidden="true">
                {t('日志')}
                <span className="hud2-kbd">J</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => onOpenLayer('craft')}
              aria-label={t('制作')}
              className="hud2-iconbtn"
            >
              <CraftInkIcon className="hud2-iconbtn__svg" />
              <span className="hud2-tip" aria-hidden="true">
                {t('制作')}
                <span className="hud2-kbd">C</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => onOpenLayer('pause')}
              aria-label={t('暂停')}
              className="hud2-iconbtn"
            >
              <PauseInkIcon className="hud2-iconbtn__svg" />
              <span className="hud2-tip hud2-tip--end" aria-hidden="true">
                {t('暂停')}
                <span className="hud2-kbd">Esc</span>
              </span>
            </button>
          </div>

          {/* 实时小地图：纯装饰 canvas（pointer-events:none / aria-hidden / 无 DOM 文字） */}
          {guidanceMode === 'full' && (
            <div className="hud2-minimap" aria-hidden="true" data-hud="minimap">
              <Minimap runtimeRef={runtimeRef} exploreRef={exploreRef} />
            </div>
          )}
        </div>
      </div>

      {/* ================= 中上：日志便签式提示条 ================= */}
      <div className="hud2-toasts pointer-events-none">
        {hud.toasts.map((msg) => (
          <div
            key={msg.id}
            className={`px-3.5 py-1.5 rounded text-xs sm:text-sm text-center border ink-note ${
              msg.tone === 'danger'
                ? 'ink-note--danger'
                : msg.tone === 'warn'
                ? 'ink-note--warn'
                : msg.tone === 'loot'
                ? 'ink-note--loot'
                : ''
            }`}
          >
            {t(msg.text)}
          </div>
        ))}
      </div>

      {/* ================= 底部：左下体征 / 右下资源 + 快捷栏 ================= */}
      <div className="hud2-bottom">
        <div className="hud2-vitals">
          <div className="hud2-bars">
            <InkBar kind="hp" value={hud.hp} max={hud.maxHp} label={t('生命')} />
            <InkBar kind="st" value={hud.stamina} max={hud.maxStamina} label={t('体力')} />
          </div>
          <button
            type="button"
            onClick={() => runtimeRef.current?.engine.toggleFlashlight()}
            aria-label={t('手电')}
            aria-pressed={hud.flashlightOn}
            title={`${t('电量')} ${hud.battery}%`}
            className={`hud2-batt ${hud.flashlightOn ? 'is-on' : ''} ${batteryLow ? 'is-low' : ''}`}
          >
            <FlashlightInkIcon className="hud2-batt__icon" />
            <span className="hud2-batt__cells" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className={`hud2-batt__cell ${i < batteryCells ? 'is-full' : ''} ${
                    batteryLow && i === batteryCells - 1 ? 'is-blink' : ''
                  }`}
                />
              ))}
            </span>
          </button>
          {/* R3：当前武器（火把 / 手枪 弹匣/备弹），点击 = Q 切换；沿用做旧电池格样式 */}
          {hud.equip && (
            <button
              type="button"
              onClick={() => runtimeRef.current?.engine.toggleWeapon()}
              aria-label={t('切换武器')}
              title={
                hud.equip.mode === 'pistol'
                  ? `${t('手枪')} ${hud.equip.mag}/${hud.equip.reserve}`
                  : `${t('火把')} ${hud.equip.torchFuel}%`
              }
              className={`hud2-batt hud2-weapon ${hud.equip.mode === 'pistol' || hud.equip.torchLit ? 'is-on' : ''} ${
                hud.equip.mode === 'pistol' ? (hud.equip.mag === 0 ? 'is-low' : '') : hud.equip.torchFuel < 20 ? 'is-low' : ''
              }`}
              style={{ minWidth: 44, minHeight: 44 }}
            >
              {hud.equip.mode === 'pistol' ? (
                <>
                  <PistolInkIcon className="hud2-batt__icon" />
                  <span
                    className="font-mono-num"
                    aria-hidden="true"
                    style={{ fontSize: 11, marginLeft: 4, color: '#d8cdb6', whiteSpace: 'nowrap' }}
                  >
                    {hud.equip.reloading ? '··' : hud.equip.mag}/{hud.equip.reserve}
                  </span>
                </>
              ) : (
                <>
                  <FlameInkIcon className="hud2-batt__icon" />
                  <span className="hud2-batt__cells" aria-hidden="true">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className={`hud2-batt__cell ${
                          hud.equip && hud.equip.torchLit && i < Math.ceil(hud.equip.torchFuel / 34) ? 'is-full' : ''
                        }`}
                      />
                    ))}
                  </span>
                </>
              )}
            </button>
          )}
        </div>

        <div className="hud2-res" role="group" aria-label={t('资源')}>
          {RES_META.map((item) => {
            const n = hud.inv[item.key];
            return (
              <span
                key={item.key}
                role="img"
                aria-label={`${t(item.label)} ${n}`}
                title={t(item.label)}
                className={`hud2-res__item ${n <= 0 ? 'is-zero' : ''}`}
              >
                <span style={{ color: item.color }} className="hud2-res__icon">
                  <ResourceInkIcon kind={item.key} className="w-3 h-3" />
                </span>
                <span className="hud2-res__n">{n}</span>
              </span>
            );
          })}
        </div>

        <div className="hud2-quickbar" role="group" aria-label={t('快捷栏')}>
          {slots.map((s) => (
            <button
              key={s.n}
              type="button"
              onClick={() => runtimeRef.current?.engine.useQuickSlot(s.n)}
              aria-label={t(s.label)}
              className={`hud2-slot ${s.count <= 0 ? 'is-empty' : ''} ${
                hud.activeSlot === s.n ? 'is-active' : ''
              }`}
            >
              <span className="hud2-slot__key" aria-hidden="true">
                {s.n}
              </span>
              <span className="hud2-slot__icon" style={{ color: s.tint }} aria-hidden="true">
                {s.icon}
              </span>
              {s.count > 0 && <span className="hud2-slot__count">{s.count}</span>}
              <span className="hud2-tip hud2-tip--up" aria-hidden="true">
                {t(s.label)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
