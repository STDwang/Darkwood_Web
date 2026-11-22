// Deterministic PRNG (Mulberry32), geometry helpers, and zero-GC LiveRing pool

export interface Vec2 {
  x: number;
  y: number;
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export function createRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function expDecay(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Zero-allocation fixed-capacity ring buffer for particles, footprints, and sound ripples.
 */
export class LiveRing<T> {
  readonly items: T[];
  readonly cap: number;
  count = 0;
  private cursor = 0;

  constructor(capacity: number, factory: () => T) {
    this.cap = capacity;
    this.items = new Array<T>(capacity);
    for (let i = 0; i < capacity; i++) {
      this.items[i] = factory();
    }
  }

  alloc(): T {
    const item = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    return item;
  }

  clear(): void {
    this.count = 0;
    this.cursor = 0;
  }
}

/**
 * Circle vs AABB resolution (Single Source of Truth for entity-wall collision).
 * Returns pushed position if overlapping, else null.
 */
export function resolveCircleRect(
  cx: number,
  cy: number,
  r: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number
): Vec2 | null {
  const closestX = clamp(cx, rx, rx + rw);
  const closestY = clamp(cy, ry, ry + rh);
  const dx = cx - closestX;
  const dy = cy - closestY;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;

  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    const push = r - d;
    return { x: cx + (dx / d) * push, y: cy + (dy / d) * push };
  }

  // Center inside rect: push out along shallowest axis
  const left = cx - rx;
  const right = rx + rw - cx;
  const top = cy - ry;
  const bottom = ry + rh - cy;
  const minPen = Math.min(left, right, top, bottom);
  if (minPen === left) return { x: rx - r, y: cy };
  if (minPen === right) return { x: rx + rw + r, y: cy };
  if (minPen === top) return { x: cx, y: ry - r };
  return { x: cx, y: ry + rh + r };
}

/**
 * Circle vs Circle push-out resolution.
 */
export function resolveCircleCircle(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number
): Vec2 | null {
  const dx = ax - bx;
  const dy = ay - by;
  const minD = ar + br;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minD * minD) return null;
  const d = Math.sqrt(d2) || 0.001;
  const push = minD - d;
  return { x: ax + (dx / d) * push, y: ay + (dy / d) * push };
}

/**
 * Ray vs segment intersection distance (parametric t along ray, or Infinity).
 */
export function raySegmentIntersect(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const sx = bx - ax;
  const sy = by - ay;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-8) return Infinity;
  const qpx = ax - ox;
  const qpy = ay - oy;
  const t = (qpx * sy - qpy * sx) / denom;
  if (t < 0) return Infinity;
  const u = (qpx * dy - qpy * dx) / denom;
  if (u < -1e-6 || u > 1 + 1e-6) return Infinity;
  return t;
}
