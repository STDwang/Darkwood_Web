// Hand-drawn Eastern European etched ink-line SVG icons for resources, tools, weather, and journal

import React from 'react';
import { ResourceKey, WeatherKind } from '../game/types';

interface IconProps {
  className?: string;
}

export function ResourceInkIcon({ kind, className = 'w-4 h-4' }: { kind: ResourceKey; className?: string }) {
  switch (kind) {
    case 'wood':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M4 15.5 16.5 7c1.4-.7 3.2.5 3.2 2.2 0 1-.5 1.8-1.2 2.2L6.5 19.5c-1.4.7-3.2-.5-3.2-2.2 0-.8.3-1.4.7-1.8Z" />
          <path d="M5.5 15.8c1.1-.4 2.1.7 1.8 2.1" />
          <path d="M10.5 11.2 13 9.7" />
        </svg>
      );
    case 'scrap':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M12 4.5 14 7l3-.6.6 3 2.5 2-2.5 2-.6 3-3-.6-2 2.5-2-2.5-3 .6-.6-3-2.5-2 2.5-2 .6-3 3 .6Z" />
          <circle cx="12" cy="12" r="2.7" />
        </svg>
      );
    case 'fuel':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M6 8.5V19a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5L15 4.5H9.5L6 8.5Z" />
          <path d="M10 4.5V3h3v1.5" />
          <path d="m9.5 11 5 5m0-5-5 5" />
        </svg>
      );
    case 'herbs':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M12 20V8" />
          <path d="M12 13c-4 0-6.5-2.5-6.5-6.5 3.8 0 6.5 2.4 6.5 6.5Z" />
          <path d="M12 15c4 0 6.5-2.5 6.5-6.5-3.8 0-6.5 2.4-6.5 6.5Z" />
        </svg>
      );
    case 'battery':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <rect x="7" y="5.5" width="10" height="14.5" rx="1.5" />
          <path d="M10 3.5h4" />
          <path d="m12.5 9.5-2 3.5h3l-2 3.5" />
        </svg>
      );
    case 'essence':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M5 13c0-4.2 3.1-7.5 7-7.5s7 3.3 7 7.5H5Z" />
          <path d="M10 13v5.5a2 2 0 0 0 4 0V13" />
          <circle cx="9.5" cy="9.5" r="0.9" fill="currentColor" />
          <circle cx="14.2" cy="8.8" r="0.8" fill="currentColor" />
        </svg>
      );
  }
}

export function FlareInkIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 18 7-7 3 3-7 7-3-3Z" />
      <path d="M15 9c.5-2.5 2-4 4-4.5-.5 2-1 3.5 1 5-2 .5-3.5 1-5 1.5" />
    </svg>
  );
}

export function BandageInkIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="8" width="16" height="8" rx="3" transform="rotate(-35 12 12)" />
      <path d="M10.5 10.5h3v3h-3z" />
    </svg>
  );
}

export function TrapInkIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 4.5v2.5M12 17v2.5M4.5 12H7M17 12h2.5M6.8 6.8l1.8 1.8M15.4 15.4l1.8 1.8M17.2 6.8l-1.8 1.8M8.6 15.4l-1.8 1.8" />
    </svg>
  );
}

export function WeatherInkIcon({ kind, className = 'w-3.5 h-3.5' }: { kind: WeatherKind; className?: string }) {
  if (kind === 'storm') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M6.5 15a4 4 0 0 1-.5-7.9A5.5 5.5 0 0 1 16.8 6 4 4 0 0 1 18 14" />
        <path d="m12.5 12-2.5 5h3l-2 4.5" />
      </svg>
    );
  }
  if (kind === 'drizzle') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M6.5 14.5a4 4 0 0 1-.5-7.9A5.5 5.5 0 0 1 16.8 5.5 4 4 0 0 1 18 13.5" />
        <path d="m9 17-1 3m5-3-1 3m5-3-1 3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 10h14M6 14h14M3 18h12" />
    </svg>
  );
}

// ================================================================
// 第二轮 HUD：无框墨线图标（手绘抖动笔触，currentColor 着色，统一 24×24 视框）
// ================================================================

/** 日志：摊开的旧本子，左页两行墨迹 */
export function JournalInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3.4 6.3c2.9-1 5.7-.6 8.4 1.1l.1 12.1c-2.7-1.6-5.5-1.9-8.4-1.1Z" />
      <path d="M20.6 6.1c-2.9-.9-5.8-.5-8.7 1.3l.1 12.1c2.8-1.7 5.7-2 8.7-1.2Z" />
      <path d="M5.9 9.7c1.5-.3 2.9-.1 4.2.6M6 12.7c1.4-.2 2.7 0 4 .5M14 10.1c1.3-.5 2.6-.6 4-.3" strokeWidth="1.05" opacity="0.7" />
    </svg>
  );
}

/** 制作：锈锤（斜置锤头 + 木柄） */
export function CraftInkIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M13.4 10.1 4.9 18.6a1.6 1.6 0 0 0 2.3 2.3l8.6-8.5" />
      <path d="m11.9 5.6 2.7-1.8c1.6-.6 3.4-.2 4.5.9l.8.9-2 .7.3 2-1.9 1.9-2.1-.3-1.3 1.3-2.4-2.4Z" />
      <path d="M8.1 17.3l-.9-.9" strokeWidth="1.05" opacity="0.65" />
    </svg>
  );
}

/** 暂停：两道粗墨竖笔 + 一圈未闭合的淡墨环 */
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
export function FlashlightInkIcon({ className = 'w-4 h-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8.3 3.6h7.3l-1.1 5.1.1 10.7c0 .8-.6 1.3-1.5 1.3h-2c-.9 0-1.5-.5-1.5-1.3l.1-10.7Z" />
      <path d="M9.3 8.7h5.2" />
      <path d="M12 12.1v2.7" strokeWidth="1.9" />
    </svg>
  );
}

/** 炉火 / 发电机：双层火舌 */
export function FlameInkIcon({ className = 'w-3.5 h-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3 2.1-4.6 3.2-6.9.4 1.4 1.2 2.3 2.1 2.7-.2-3 .9-5.8 3.1-7.7-.2 2.9 1.2 4.6 2.6 6.4 1 1.3 1.6 2.7 1.6 4.4 0 3.9-2.9 6.7-6.6 6.7Z" />
      <path d="M12 18.4c-1.3 0-2.2-.9-2.2-2.1 0-1 .8-1.8 1.4-2.7.3.9 1 1.3 1.6 1.4.6.6 1.1 1.2 1.1 2 0 .8-.8 1.4-1.9 1.4Z" strokeWidth="1.1" opacity="0.7" />
    </svg>
  );
}
