// 东欧暗林手绘油画/蚀刻风专属程序化 SVG 美术资产图标集（纯代码生成，零外部图片依赖）
// 涵盖全部资源素材、消耗品、武器装备、动作按键与状态徽标，高辨识度分层着色。

import React from 'react';
import { ResourceGainKind, ResourceKey, TimePhase, WeatherKind } from '../game/types';

interface IconProps {
  className?: string;
}

/** 专属分层着色资源素材美术资产（木材 / 废铁 / 燃油 / 布草 / 电池 / 幽光菇） */
export function ResourceInkIcon({ kind, className = 'w-5 h-5' }: { kind: ResourceKey; className?: string }) {
  switch (kind) {
    case 'wood':
      return (
        <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
          <path d="M4.5 18.2 18.2 8.2c1.8-1 4.2.5 4.4 2.7.1 1.2-.5 2.3-1.4 2.9L7.6 23.4c-1.9 1-4.3-.6-4.4-2.8-.1-1 .4-1.8 1.3-2.4Z" fill="#5e4328" stroke="#18120c" strokeWidth="1.5" />
          <path d="M5.4 18.4 18.5 9c1.2-.5 2.5.4 2.5 1.8" stroke="#a67c4e" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
          <ellipse cx="6.2" cy="20.7" rx="2.7" ry="3.2" transform="rotate(-24 6.2 20.7)" fill="#c9a573" stroke="#22170e" strokeWidth="1.3" />
          <circle cx="6.2" cy="20.7" r="1.1" stroke="#6c4d2e" strokeWidth="0.9" />
          <path d="M11.8 14.2 15.2 11.7M14.2 16.4 17.8 13.8" stroke="#281c11" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    case 'scrap':
      return (
        <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
          <path d="M14 4.2 16.4 7l3.6-.7.8 3.6 3 2.5-3 2.5-.8 3.6-3.6-.7-2.4 2.8-2.4-2.8-3.6.7-.8-3.6-3-2.5 3-2.5.8-3.6 3.6.7Z" fill="#5c6468" stroke="#14181a" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M10.5 7.5 15.5 6.8l2.5 3.2" stroke="#a5b2b8" strokeWidth="1.1" strokeLinecap="round" opacity="0.7" />
          <circle cx="14" cy="14" r="3.4" fill="#23282a" stroke="#9aa7ad" strokeWidth="1.3" />
          <path d="M17.2 16.8c1-.6 1.8-1.4 2.2-2.4" stroke="#8a4d30" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'fuel':
      return (
        <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
          <path d="M6.8 10.2V22a2 2 0 0 0 2 2h10.4a2 2 0 0 0 2-2V8.8L17.4 5h-6.6L6.8 10.2Z" fill="#9a3a26" stroke="#180e0c" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M11.6 5V3.2h4.2V5" fill="#4f4944" stroke="#180e0c" strokeWidth="1.3" />
          <path d="M8.5 10.5h11v11H8.5z" fill="#b44b32" opacity="0.55" />
          <path d="M10.5 13 17.5 20m0-7-7 7" stroke="#e4a96e" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M18.2 7.2 20 9" stroke="#d9b48a" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case 'herbs':
      return (
        <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
          <path d="M14 23.5V9" stroke="#48663d" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M14 15.5c-5 0-8.2-3.1-8.2-8 4.8 0 8.2 3 8.2 8Z" fill="#5e8a52" stroke="#141e12" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M14 18c5 0 8.2-3.1 8.2-8-4.8 0-8.2 3-8.2 8Z" fill="#73a163" stroke="#141e12" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8.5 10.2 12.6 13.8M19.5 12.6 15.4 16.2" stroke="#b6d6a3" strokeWidth="1" strokeLinecap="round" opacity="0.7" />
        </svg>
      );
    case 'battery':
      return (
        <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
          <rect x="7.8" y="6.2" width="12.4" height="17.8" rx="2" fill="#3a382c" stroke="#14130f" strokeWidth="1.5" />
          <rect x="9.3" y="8" width="9.4" height="14.2" rx="1" fill="#8f7836" />
          <rect x="11.2" y="3.6" width="5.6" height="2.6" rx="0.8" fill="#c9b468" stroke="#14130f" strokeWidth="1.2" />
          <path d="m14.8 10.2-3.2 5h3.2l-1.6 4.8 3.8-5.4h-3.1l.9-4.4Z" fill="#f2dc84" stroke="#221c0e" strokeWidth="0.9" strokeLinejoin="round" />
        </svg>
      );
    case 'essence':
      return (
        <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
          <path d="M11.2 15.2v6.6a2.8 2.8 0 0 0 5.6 0v-6.6" fill="#4b6b64" stroke="#101a18" strokeWidth="1.4" />
          <path d="M4.8 15.4c0-5.4 4.1-9.6 9.2-9.6s9.2 4.2 9.2 9.6H4.8Z" fill="#388a7c" stroke="#0d1b18" strokeWidth="1.5" strokeLinejoin="round" />
          <circle cx="10.8" cy="11.2" r="1.4" fill="#9ff0df" />
          <circle cx="16.8" cy="10.4" r="1.2" fill="#9ff0df" />
          <circle cx="14" cy="13.2" r="0.9" fill="#c8fff3" />
        </svg>
      );
  }
}

/** 通用物品美术资产（用于顶部资源滚动条与快捷栏，支持全部资源 + 消耗品 + 弹药 + 中继零件） */
export function ItemAssetIcon({ kind, className = 'w-5 h-5' }: { kind: ResourceGainKind; className?: string }) {
  switch (kind) {
    case 'wood':
    case 'scrap':
    case 'fuel':
    case 'herbs':
    case 'battery':
    case 'essence':
      return <ResourceInkIcon kind={kind} className={className} />;
    case 'flares':
      return <FlareInkIcon className={className} />;
    case 'bandages':
      return <BandageInkIcon className={className} />;
    case 'traps':
      return <TrapInkIcon className={className} />;
    case 'ammo':
      return <AmmoInkIcon className={className} />;
    case 'relayParts':
      return <RelayInkIcon className={className} />;
  }
}

/** 照明弹：猩红火药筒 + 跃动炽热火花 */
export function FlareInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <path d="m6.2 19.6 8.8-8.8 3.6 3.6-8.8 8.8-3.6-3.6Z" fill="#a83b2a" stroke="#1a0d0a" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m9.4 16.4 3.6 3.6" stroke="#e4c38e" strokeWidth="1.4" />
      <path d="M16.2 10.6c.7-3.2 2.6-5.2 5.4-5.8-.7 2.6-1.2 4.5 1.4 6.2-2.6.7-4.5 1.3-6.4 2" fill="#f09a48" stroke="#ffdf94" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

/** 草药绷带：做旧米白纱布卷 + 暗绿草药十字 */
export function BandageInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <rect x="4" y="9.2" width="20" height="9.6" rx="4.2" transform="rotate(-32 14 14)" fill="#cfc4ab" stroke="#1b1814" strokeWidth="1.5" />
      <rect x="10.2" y="10.2" width="7.6" height="7.6" rx="1.2" transform="rotate(-32 14 14)" fill="#829e74" stroke="#24301f" strokeWidth="1.1" />
      <path d="M14 11.8v4.4M11.8 14h4.4" stroke="#eff4e8" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 捕兽夹：冷铁锯齿夹环 + 中央踏板 */
export function TrapInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <circle cx="14" cy="14" r="9.2" fill="#2c2f30" stroke="#9aa4a8" strokeWidth="1.8" />
      <circle cx="14" cy="14" r="3.2" fill="#824632" stroke="#141414" strokeWidth="1.3" />
      <path d="M14 4.8v3.2M14 20v3.2M4.8 14H8M20 14h3.2M7.5 7.5l2.3 2.3M18.2 18.2l2.3 2.3M20.5 7.5l-2.3 2.3M9.8 18.2l-2.3 2.3" stroke="#d0d6d8" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 子弹：黄铜弹壳 + 铜色弹头 */
export function AmmoInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <path d="M9.5 22V12.5c0-3 1.4-5.8 2.5-7 1.1 1.2 2.5 4 2.5 7V22h-5Z" fill="#c99f4c" stroke="#18130c" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M15.8 22V14c0-2.5 1.1-4.8 2.1-5.8 1 1 2.1 3.3 2.1 5.8V22h-4.2Z" fill="#b48a3e" stroke="#18130c" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9.5 13h5M15.8 14.5H20" stroke="#5a3b18" strokeWidth="1.1" />
    </svg>
  );
}

/** 信号中继零件：苏式无线电线圈 + 发光信号灯 */
export function RelayInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <rect x="6" y="10" width="16" height="12" rx="2" fill="#3a4a48" stroke="#101615" strokeWidth="1.5" />
      <path d="M14 10V4.5M10.5 7.5a5 5 0 0 1 7 0" stroke="#8de8d4" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="11" cy="16" r="2.2" fill="#7ad8c5" stroke="#11211e" strokeWidth="1" />
      <path d="M15.5 14.2h4M15.5 17.6h4" stroke="#b9c7c4" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** 伐木斧 / 近战挥砍美术图标 */
export function AxeInkIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <path d="M6.2 22.8 18.8 10.2" stroke="#8a623c" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M6.2 22.8 18.8 10.2" stroke="#22170e" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M15.2 6.8c3.2-1.8 6.4-.8 8.2 1.8-1.4 3.4-4 5.4-7.4 6.2l-2.6-2.6 1.8-5.4Z" fill="#9ea8ad" stroke="#181c1e" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M21.4 7.6c-.8 2-2.2 3.6-4.2 4.6" stroke="#e4ecef" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** 左轮手枪美术图标 */
export function PistolInkIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <path d="M4 10h16.5l1.8 1.9v1.8H12.8l-1.4 1.6 1.1 6.4H8.1l.8-6.8L4 13.4V10Z" fill="#687074" stroke="#141618" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 16.5h3.5l.6 4.8H8.3l.2-4.8Z" fill="#6b4a2e" stroke="#1a120b" strokeWidth="1.1" />
      <path d="M12.8 13.7c.5 1.8 2 2.4 3.4 1.9" stroke="#a6b0b4" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** 闪避疾影图标 */
export function DodgeInkIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <path d="M4.5 10h8M3.5 14.5h10M6 19h7" stroke="#8fd0ba" strokeWidth="1.8" strokeLinecap="round" opacity="0.7" />
      <path d="M14.5 7.5 23 14l-8.5 6.5v-4.2H11v-4.6h3.5V7.5Z" fill="#a8e3cf" stroke="#12211c" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** 物理交互手掌/搜刮图标 */
export function InteractHandIcon({ className = 'w-6 h-6' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <circle cx="12.5" cy="12.5" r="6.2" fill="rgba(226,192,126,0.18)" stroke="#ead6ab" strokeWidth="1.8" />
      <path d="M17.2 17.2 22.8 22.8" stroke="#d8b062" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="10.8" cy="10.8" r="1.4" fill="#f7e8c6" />
    </svg>
  );
}

/** 换弹循环图标 */
export function ReloadInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <path d="M21 14a7 7 0 1 1-2.1-5" stroke="#e4d6b6" strokeWidth="2" strokeLinecap="round" />
      <path d="M19.5 4.8v4.6h-4.6" stroke="#e4d6b6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 昼夜相位纯美术图标（日 / 黄昏 / 弯月） */
export function DayPhaseInkIcon({ phase, className = 'w-4 h-4' }: { phase: TimePhase; className?: string }) {
  if (phase === 'night') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
        <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" fill="#b7c6db" stroke="#1c2330" strokeWidth="1.3" />
      </svg>
    );
  }
  if (phase === 'dusk') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
        <path d="M4 16h16" stroke="#d9894b" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M7 16a5 5 0 0 1 10 0" fill="#d97b3c" stroke="#29150a" strokeWidth="1.2" />
        <path d="M12 6v2.5M6.5 9.5l1.6 1.6M17.5 9.5l-1.6 1.6" stroke="#e6a262" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" fill="#dfc484" stroke="#2e2414" strokeWidth="1.2" />
      <path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" stroke="#dfc484" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 生命血滴图标 */
export function HeartInkIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M12 20.5c-4.4 0-7.2-2.9-7.2-6.6 0-3.8 4.4-8.2 7.2-10.9 2.8 2.7 7.2 7.1 7.2 10.9 0 3.7-2.8 6.6-7.2 6.6Z" fill="#a8322a" stroke="#210907" strokeWidth="1.4" />
      <path d="M9.6 13.5c0 1.6.9 2.8 2.2 3.1" stroke="#e68a7c" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

/** 体力闪电图标 */
export function StaminaInkIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M13.5 3.2 6.8 13h5l-1.3 7.8 6.7-9.8h-5l1.3-7.8Z" fill="#ded4bd" stroke="#1c1914" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function WeatherInkIcon({ kind, className = 'w-4 h-4' }: { kind: WeatherKind; className?: string }) {
  if (kind === 'storm') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
        <path d="M6.5 15a4 4 0 0 1-.5-7.9A5.5 5.5 0 0 1 16.8 6 4 4 0 0 1 18 14" />
        <path d="m12.5 12-2.5 5h3l-2 4.5" stroke="#e6c873" />
      </svg>
    );
  }
  if (kind === 'drizzle') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
        <path d="M6.5 14.5a4 4 0 0 1-.5-7.9A5.5 5.5 0 0 1 16.8 5.5 4 4 0 0 1 18 13.5" />
        <path d="m9 17-1 3m5-3-1 3m5-3-1 3" stroke="#9ac2cf" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 10h14M6 14h14M3 18h12" />
    </svg>
  );
}

/** 日志：摊开的旧本子 */
export function JournalInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3.4 6.3c2.9-1 5.7-.6 8.4 1.1l.1 12.1c-2.7-1.6-5.5-1.9-8.4-1.1Z" fill="rgba(164,142,104,0.18)" />
      <path d="M20.6 6.1c-2.9-.9-5.8-.5-8.7 1.3l.1 12.1c2.8-1.7 5.7-2 8.7-1.2Z" fill="rgba(164,142,104,0.12)" />
      <path d="M5.9 9.7c1.5-.3 2.9-.1 4.2.6M6 12.7c1.4-.2 2.7 0 4 .5M14 10.1c1.3-.5 2.6-.6 4-.3" strokeWidth="1.05" opacity="0.7" />
    </svg>
  );
}

/** 制作：锈锤 */
export function CraftInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M13.4 10.1 4.9 18.6a1.6 1.6 0 0 0 2.3 2.3l8.6-8.5" fill="rgba(138,98,60,0.35)" />
      <path d="m11.9 5.6 2.7-1.8c1.6-.6 3.4-.2 4.5.9l.8.9-2 .7.3 2-1.9 1.9-2.1-.3-1.3 1.3-2.4-2.4Z" fill="rgba(176,184,188,0.28)" />
    </svg>
  );
}

/** 暂停：两道粗墨竖笔 + 未闭合墨环 */
export function PauseInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9.6 7.4c-.2 3.2-.1 6.3.3 9.4" strokeWidth="2.1" />
      <path d="M14.6 7.2c.1 3.2 0 6.4-.3 9.6" strokeWidth="2.1" />
      <path d="M12.1 2.9c5.1-.1 9.1 3.9 9 9.1-.1 5-4.2 9-9.2 8.9-5-.1-8.9-4.2-8.8-9.2.1-3.3 1.9-6.2 4.7-7.7" strokeWidth="1.05" opacity="0.5" />
    </svg>
  );
}

/** 手电：铁皮筒身 + 灯头 + 开关钮 */
export function FlashlightInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8.3 3.6h7.3l-1.1 5.1.1 10.7c0 .8-.6 1.3-1.5 1.3h-2c-.9 0-1.5-.5-1.5-1.3l.1-10.7Z" fill="rgba(218,194,126,0.22)" />
      <path d="M9.3 8.7h5.2" />
      <path d="M12 12.1v2.7" strokeWidth="1.9" />
    </svg>
  );
}

/** 炉火 / 火把 / 发电机：双层炽热火舌 */
export function FlameInkIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3 2.1-4.6 3.2-6.9.4 1.4 1.2 2.3 2.1 2.7-.2-3 .9-5.8 3.1-7.7-.2 2.9 1.2 4.6 2.6 6.4 1 1.3 1.6 2.7 1.6 4.4 0 3.9-2.9 6.7-6.6 6.7Z" fill="rgba(224,132,58,0.45)" />
      <path d="M12 18.4c-1.3 0-2.2-.9-2.2-2.1 0-1 .8-1.8 1.4-2.7.3.9 1 1.3 1.6 1.4.6.6 1.1 1.2 1.1 2 0 .8-.8 1.4-1.9 1.4Z" fill="#f3cb74" stroke="none" />
    </svg>
  );
}
