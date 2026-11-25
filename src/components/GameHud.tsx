// 第三轮全美术化手机横屏 & 桌面统一 HUD（少文字、所见即所得）：
// - 顶部左：纯图形昼夜表盘 + 日历角标(D1) + 天气图标 + 发电机油量图形条（零冗长文字）
// - 顶部中：资源获取滚动播报带（专属彩色美术图标 + "+N" 实时滚动）
// - 顶部右：大尺寸纯图标工具按钮（日志 / 制作 / 暂停）+ 实时小地图
// - 底部左：手绘生命血槽 + 体力槽（配血滴/闪电图标）
// - 底部中：全套快捷键栏（F 手电 / Q 火把·手枪 / 1 照明弹 / 2 绷带 / 3 捕兽夹 / 4 电池），大触控靶点
// - 底部右：紧凑彩色资源美术图标计数行（纯图标 + 数字）
// 约束：完整保留 layout-check / smoke-check 契约（aria-label / data-hud / data-guidance-mode / .hud2.is-threat / 零 sticky / 按钮 ≥ 44px）。

import React, { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import {
  BandageInkIcon,
  CraftInkIcon,
  DayPhaseInkIcon,
  FlameInkIcon,
  FlareInkIcon,
  FlashlightInkIcon,
  HeartInkIcon,
  ItemAssetIcon,
  JournalInkIcon,
  PauseInkIcon,
  PistolInkIcon,
  RelayInkIcon,
  ResourceInkIcon,
  StaminaInkIcon,
  TrapInkIcon,
  WeatherInkIcon,
} from './InkIcons';
import Minimap, { MinimapExploreState } from './Minimap';
import { GameRuntime } from '../game/runtime';
import { HudSnapshot, ResourceKey } from '../game/types';

type HudLayer = 'journal' | 'craft' | 'pause' | 'dev' | 'map';
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

const RES_META: Array<{ key: ResourceKey; label: string }> = [
  { key: 'wood', label: '木材' },
  { key: 'scrap', label: '废铁' },
  { key: 'fuel', label: '燃油' },
  { key: 'herbs', label: '布草' },
  { key: 'battery', label: '电池' },
  { key: 'essence', label: '幽光菇' },
];

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

function useFlash(value: number, ms = 1400): boolean {
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

/** 昼夜进度表盘：三段弧线 + 日/月相游标 */
function DayArc({ dayTime, phase }: { dayTime: number; phase: HudSnapshot['phase'] }) {
  const ticks: React.ReactNode[] = [];
  for (let i = 0; i <= 19; i++) {
    const u = i / 19;
    const major = i % 5 === 0;
    const a = arcPoint(u);
    const b = arcPoint(u, ARC_R - (major ? 3.8 : 2.2));
    ticks.push(
      <line
        key={i}
        x1={a.x.toFixed(2)}
        y1={a.y.toFixed(2)}
        x2={b.x.toFixed(2)}
        y2={b.y.toFixed(2)}
        strokeWidth={major ? 1 : 0.65}
      />
    );
  }
  const m = arcPoint(dayTime);
  const bounds = [ARC_DAY_END, ARC_DUSK_END].map((u, i) => {
    const a = arcPoint(u, ARC_R + 2.4);
    const b = arcPoint(u, ARC_R - 4.4);
    return <line key={`b${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={1.1} />;
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
          <path className="hud2-arc__moon" d="M0 -3.4 A3.4 3.4 0 1 0 0 3.4 A4.1 4.1 0 0 1 0 -3.4 Z" />
        ) : (
          <>
            <circle r="5" className="hud2-arc__glow" />
            <circle r="2.8" className={`hud2-arc__sun ${phase === 'dusk' ? 'is-dusk' : ''}`} />
          </>
        )}
      </g>
    </svg>
  );
}

/** 手绘质感体征条（带专属血滴/闪电图标） */
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
      <span className="hud2-bar__ico" aria-hidden="true">
        {kind === 'hp' ? <HeartInkIcon className="w-4 h-4" /> : <StaminaInkIcon className="w-3.5 h-3.5" />}
      </span>
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
  const batteryCells = hud.battery <= 0 ? 0 : Math.min(5, Math.ceil(hud.battery / 20));
  const batteryLow = hud.battery < 20;

  const slots: Array<{ n: number; label: string; count: number; icon: React.ReactNode }> = [
    { n: 1, label: '照明弹', count: hud.inv.flares, icon: <FlareInkIcon className="hud2-slot__svg" /> },
    { n: 2, label: '草药绷带', count: hud.inv.bandages, icon: <BandageInkIcon className="hud2-slot__svg" /> },
    { n: 3, label: '捕兽夹', count: hud.inv.traps, icon: <TrapInkIcon className="hud2-slot__svg" /> },
    { n: 4, label: '电池', count: hud.inv.battery, icon: <ResourceInkIcon kind="battery" className="hud2-slot__svg" /> },
  ];

  // 仅保留关键危机警示（过滤掉已改由顶部滚动资源条展示的普通拾取文字）
  const importantToasts = hud.toasts.filter((m) => m.tone === 'danger' || m.tone === 'warn');

  return (
    <div
      className={`hud2 pointer-events-none fixed inset-0 z-20 flex flex-col justify-between ${
        hud.dangerLevel >= 65 ? 'is-threat' : ''
      }`}
      aria-live="polite"
      data-guidance-mode={guidanceMode}
    >
      {/* ================= 顶部：左上纯图形表盘 / 顶部中央资源滚动条 / 右上图标 + 小地图 ================= */}
      <div className="hud2-top">
        <div className="hud2-tl">
          {/* 图形化状态行：昼夜图标 + D1 + 天气图标 + 发电机油量图形槽 */}
          <div className="hud2-time">
            <span className="inline-flex items-center gap-1.5">
              <DayPhaseInkIcon phase={hud.phase} className="w-4 h-4" />
              <span className="hud2-time__day font-mono-num">D{hud.day}</span>
            </span>
            <span className="hud2-time__wx" aria-hidden="true">
              <WeatherInkIcon kind={hud.weather} className="hud2-time__wxicon" />
            </span>
            {/* 发电机油量纯视觉槽（火苗图标 + 迷你油量条 + 百分比） */}
            <span
              className={`hud2-gen ${
                hud.generatorFuel <= 0 ? 'is-out' : hud.generatorFuel < 20 ? 'is-low' : ''
              } ${hud.generatorOn && hud.generatorFuel > 0 ? 'is-on' : ''}`}
              aria-label={`${t('发电机燃油')} ${hud.generatorFuel}%`}
            >
              <FlameInkIcon className="hud2-gen__icon" />
              <span className="hud2-gen__meter" aria-hidden="true">
                <span
                  className="hud2-gen__fill"
                  style={{ transform: `scaleX(${(hud.generatorFuel / 100).toFixed(3)})` }}
                />
              </span>
              <span className="hud2-gen__val">{hud.generatorFuel}%</span>
            </span>
          </div>

          <DayArc dayTime={hud.dayTime} phase={hud.phase} />

          {/* 纯图形中继进度徽章（替代大段目标文字，同时保留 data-hud="objective" 契约） */}
          {guidanceMode === 'full' && (
            <div className="hud2-obj-icons" data-hud="objective" title={t(hud.objectiveText)}>
              <RelayInkIcon className="w-4 h-4 shrink-0" />
              <span className="hud2-obj-dots" aria-hidden="true">
                {[0, 1, 2].map((idx) => (
                  <span
                    key={idx}
                    className={`hud2-obj-dot ${
                      idx < hud.relayInstalled
                        ? 'is-installed'
                        : idx < hud.relayInstalled + hud.relayParts
                        ? 'is-carried'
                        : ''
                    }`}
                  />
                ))}
              </span>
              <span className="font-mono-num text-[11px] text-[#cfe8df]">
                {hud.relayInstalled}/3
              </span>
            </div>
          )}
        </div>

        {/* 右上：大触控纯图标按钮 + 实时小地图 */}
        <div className="hud2-tr">
          <div className="hud2-actions">
            {isDev && (
              <button type="button" onClick={() => onOpenLayer('dev')} className="hud2-devbtn">
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span className="font-mono-num">
                  {hud.backend === 'webgl2' ? 'GL2' : '2D'} · {hud.fps}
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
            </button>
            <button
              type="button"
              onClick={() => onOpenLayer('craft')}
              aria-label={t('制作')}
              className="hud2-iconbtn"
            >
              <CraftInkIcon className="hud2-iconbtn__svg" />
            </button>
            <button
              type="button"
              onClick={() => onOpenLayer('pause')}
              aria-label={t('暂停')}
              className="hud2-iconbtn"
            >
              <PauseInkIcon className="hud2-iconbtn__svg" />
            </button>
          </div>

          {guidanceMode === 'full' && (
            <button
              type="button"
              onClick={() => onOpenLayer('map')}
              aria-label={t('地图')}
              className="hud2-minimap"
              data-hud="minimap"
            >
              <Minimap runtimeRef={runtimeRef} exploreRef={exploreRef} />
            </button>
          )}
        </div>
      </div>

      {/* ================= 界面正上方：资源获取滚动播报带（专属美术图标 + +N） ================= */}
      {hud.resourceGains && hud.resourceGains.length > 0 && (
        <div className="hud2-ticker pointer-events-none" aria-hidden="true">
          {hud.resourceGains.map((g) => (
            <div key={g.id} className="hud2-ticker__pill">
              <ItemAssetIcon kind={g.kind} className="w-5 h-5 shrink-0" />
              <span className="hud2-ticker__qty font-mono-num">+{g.amount}</span>
            </div>
          ))}
        </div>
      )}

      {/* 仅显示极简高危提示（无普通拾取文字干扰） */}
      {importantToasts.length > 0 && (
        <div className="hud2-toasts pointer-events-none">
          {importantToasts.slice(-1).map((msg) => (
            <div
              key={msg.id}
              className={`px-3 py-1 rounded text-xs text-center border ink-note ${
                msg.tone === 'danger' ? 'ink-note--danger' : 'ink-note--warn'
              }`}
            >
              {t(msg.text)}
            </div>
          ))}
        </div>
      )}

      {/* ================= 底部：左体征 / 中央统一快捷键栏 / 右资源美术图标 ================= */}
      <div className="hud2-bottom">
        <div className="hud2-vitals">
          <div className="hud2-bars">
            <InkBar kind="hp" value={hud.hp} max={hud.maxHp} label={t('生命')} />
            <InkBar kind="st" value={hud.stamina} max={hud.maxStamina} label={t('体力')} />
          </div>
        </div>

        {/* 界面下方居中：必要操作键位条 + 全部快捷键槽（F 手电 + Q 武器切换 + 1~4 快捷物品） */}
        <div className="hud2-qb-wrap">
          <div className="hud2-keyhints" aria-hidden="true">
            <span><kbd>WASD</kbd>{t('移动')}</span>
            <span><kbd>E</kbd>{t('交互')}</span>
            <span><kbd>LMB</kbd>{t('攻击')}</span>
            <span><kbd>Space</kbd>{t('闪避')}</span>
            <span><kbd>M</kbd>{t('地图')}</span>
            <span><kbd>R</kbd>{t('换弹')}</span>
            <span><kbd>C</kbd>{t('制作')}</span>
          </div>
          <div className="hud2-quickbar" role="group" aria-label={t('快捷栏')}>
          {/* [F] 手电快捷键 + 电量格 */}
          <button
            type="button"
            onClick={() => runtimeRef.current?.engine.toggleFlashlight()}
            aria-label={t('手电')}
            aria-pressed={hud.flashlightOn}
            className={`hud2-slot hud2-slot--tool ${hud.flashlightOn ? 'is-active' : ''} ${
              batteryLow ? 'is-low' : ''
            }`}
          >
            <span className="hud2-slot__key" aria-hidden="true">
              F
            </span>
            <span className="hud2-slot__icon" style={{ color: hud.flashlightOn ? '#ebd28a' : '#8d8576' }} aria-hidden="true">
              <FlashlightInkIcon className="hud2-slot__svg" />
            </span>
            <span className="hud2-slot__mini-bars" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className={`hud2-slot__mbar ${i < batteryCells ? 'is-full' : ''}`} />
              ))}
            </span>
          </button>

          {/* [Q] 火把 / 手枪武器快捷键 */}
          {hud.equip && (
            <button
              type="button"
              onClick={() => runtimeRef.current?.engine.toggleWeapon()}
              aria-label={t('切换武器')}
              className={`hud2-slot hud2-slot--tool ${
                hud.equip.mode === 'pistol' || hud.equip.torchLit ? 'is-active' : ''
              }`}
            >
              <span className="hud2-slot__key" aria-hidden="true">
                Q
              </span>
              <span className="hud2-slot__icon" aria-hidden="true">
                {hud.equip.mode === 'pistol' ? (
                  <PistolInkIcon className="hud2-slot__svg" />
                ) : (
                  <FlameInkIcon className="hud2-slot__svg text-[#e8a354]" />
                )}
              </span>
              <span className="hud2-slot__count font-mono-num" aria-hidden="true">
                {hud.equip.mode === 'pistol'
                  ? hud.equip.reloading
                    ? '··'
                    : `${hud.equip.mag}/${hud.equip.reserve}`
                  : `${hud.equip.torchFuel}%`}
              </span>
            </button>
          )}

          {/* [1]~[4] 快捷求生道具槽 */}
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
              <span className="hud2-slot__icon" aria-hidden="true">
                {s.icon}
              </span>
              {s.count > 0 && <span className="hud2-slot__count">{s.count}</span>}
            </button>
          ))}
          </div>
        </div>

        {/* 右下：专属美术素材图标计数行（纯图标 + 数字） */}
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
                <span className="hud2-res__icon">
                  <ResourceInkIcon kind={item.key} className="w-4 h-4" />
                </span>
                <span className="hud2-res__n">{n}</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
