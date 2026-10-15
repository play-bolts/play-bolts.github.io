import { playerShotSpread, type Stance } from './config';

/** Seconds to close 90% of the gap to the current movement/stance target. */
export const HIP_SPREAD_TIMING = { widen90: .075, recover90: .45 } as const;
export const CROSSHAIR_DISPLAY_SCALE = 1.2;

/** One shared angular spread state drives both player bullets and the HUD. */
export function advanceHipSpread(current: number, stance: Stance, moving: number, dt: number): number {
  if (dt <= 0) return current;
  const target = playerShotSpread(false, stance, moving);
  const duration = target > current ? HIP_SPREAD_TIMING.widen90 : HIP_SPREAD_TIMING.recover90;
  // Exact exponential integration avoids refresh-rate-dependent accuracy.
  return target + (current - target) * Math.exp(-Math.LN10 * dt / duration);
}

/** Project the bullet distribution's half-angle into the vertical camera FOV. */
export function crosshairGapPixels(spread: number, viewportHeight: number, verticalFov = 72): number {
  return Math.max(2, Math.tan(spread / 2) * viewportHeight / (2 * Math.tan(verticalFov * Math.PI / 360)));
}

/** Presentation padding keeps the reticle legible without changing bullets. */
export function crosshairDisplayGapPixels(spread: number, viewportHeight: number, verticalFov = 72): number {
  return crosshairGapPixels(spread, viewportHeight, verticalFov) * CROSSHAIR_DISPLAY_SCALE;
}
