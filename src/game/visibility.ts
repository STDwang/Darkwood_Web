// Real-time 2D raycast visibility polygon solver (zero-GC reusable buffers)

import { Segment, Vec2, raySegmentIntersect, wrapAngle } from './util';
import { WorldData, collectOccluderSegments } from './world';

interface RayHit {
  angle: number;
  x: number;
  y: number;
}

const segScratch: Segment[] = [];
const angleScratch: number[] = [];
const hitScratch: RayHit[] = [];

/**
 * Computes a 360° or cone-clipped visibility polygon from (ox, oy) up to maxDist.
 * Reuses internal arrays and returns a newly copied Vec2[] only when requested, or fills `out`.
 */
export function computeVisibilityPolygon(
  world: WorldData,
  ox: number,
  oy: number,
  maxDist: number,
  out: Vec2[],
  coneCenter?: number,
  coneHalfAngle?: number
): Vec2[] {
  const segs = collectOccluderSegments(world, ox, oy, maxDist, segScratch);
  angleScratch.length = 0;
  hitScratch.length = 0;

  const isCone = coneCenter !== undefined && coneHalfAngle !== undefined;
  const half = coneHalfAngle ?? Math.PI;
  const center = coneCenter ?? 0;

  if (isCone) {
    // Explicit cone boundary rays + evenly spaced interior arc rays for smooth radial edge
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const a = wrapAngle(center - half + (i / steps) * (half * 2));
      angleScratch.push(a);
    }
  } else {
    // Subtle 24-ray base circle so open spaces stay round
    for (let i = 0; i < 24; i++) {
      angleScratch.push(-Math.PI + (i / 24) * Math.PI * 2);
    }
  }

  // Add endpoint angles ±eps for crisp shadow edges
  const eps = 0.00045;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const a1 = Math.atan2(s.ay - oy, s.ax - ox);
    const a2 = Math.atan2(s.by - oy, s.bx - ox);

    if (!isCone || Math.abs(wrapAngle(a1 - center)) <= half + 0.04) {
      angleScratch.push(wrapAngle(a1 - eps), a1, wrapAngle(a1 + eps));
    }
    if (!isCone || Math.abs(wrapAngle(a2 - center)) <= half + 0.04) {
      angleScratch.push(wrapAngle(a2 - eps), a2, wrapAngle(a2 + eps));
    }
  }

  for (let i = 0; i < angleScratch.length; i++) {
    const a = angleScratch[i];
    if (isCone && Math.abs(wrapAngle(a - center)) > half + 0.002) continue;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let minT = maxDist;

    for (let j = 0; j < segs.length; j++) {
      const s = segs[j];
      const t = raySegmentIntersect(ox, oy, dx, dy, s.ax, s.ay, s.bx, s.by);
      if (t < minT) minT = t;
    }

    hitScratch.push({
      angle: isCone ? wrapAngle(a - center) : a,
      x: ox + dx * minT,
      y: oy + dy * minT,
    });
  }

  hitScratch.sort((a, b) => a.angle - b.angle);

  out.length = 0;
  if (isCone) {
    out.push({ x: ox, y: oy });
  }
  for (let i = 0; i < hitScratch.length; i++) {
    out.push({ x: hitScratch[i].x, y: hitScratch[i].y });
  }
  return out;
}

/**
 * Line-of-sight check between two points against light-blocking world geometry.
 * Used to hide enemies outside visibility or behind walls/barricades!
 */
export function hasLineOfSight(
  world: WorldData,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const distance = Math.hypot(dx, dy);
  if (distance < 4) return true;
  const ndx = dx / distance;
  const ndy = dy / distance;

  const segs = collectOccluderSegments(world, ax, ay, distance + 10, segScratch);
  // Skip the first 4 bounding-box segments
  for (let i = 4; i < segs.length; i++) {
    const s = segs[i];
    const t = raySegmentIntersect(ax, ay, ndx, ndy, s.ax, s.ay, s.bx, s.by);
    if (t < distance - 6) return false;
  }
  return true;
}
