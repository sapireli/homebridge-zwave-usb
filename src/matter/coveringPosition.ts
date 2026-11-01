/**
 * Matter and HomeKit describe a covering's position with opposite polarity.
 *
 * HomeKit's CurrentPosition is how far the covering is open: 100 is fully open, 0 is fully
 * closed. Matter's LiftPercent100ths is how far it is closed, in hundredths of a percent: the
 * spec has UpOrOpen set the target to 0.00%, and 10000 is fully closed.
 *
 * Getting this backward makes "close the shades" open them, so the conversion lives here on its
 * own and is covered by tests.
 */

const MATTER_LIFT_MAX = 10000;
const HOMEKIT_MAX = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** HomeKit percent open to Matter hundredths of a percent closed. */
export function homeKitPositionToMatterLift(position: number): number {
  if (!Number.isFinite(position)) {
    return 0;
  }

  return clamp(Math.round((HOMEKIT_MAX - position) * 100), 0, MATTER_LIFT_MAX);
}

/** Matter hundredths of a percent closed to HomeKit percent open. */
export function matterLiftToHomeKitPosition(liftPercent100ths: number): number {
  if (!Number.isFinite(liftPercent100ths)) {
    return 0;
  }

  const closed = clamp(liftPercent100ths, 0, MATTER_LIFT_MAX) / 100;

  return clamp(Math.round(HOMEKIT_MAX - closed), 0, HOMEKIT_MAX);
}

/**
 * Matter reports battery charge in half-percent units, so a full battery is 200 rather than 100.
 */
export function homeKitBatteryToMatterPercent(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }

  return clamp(Math.round(level * 2), 0, 200);
}
