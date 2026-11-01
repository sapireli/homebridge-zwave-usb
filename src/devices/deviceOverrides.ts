import { IZWaveNode } from '../zwave/interfaces';

/**
 * Some devices cannot be classified from their Command Classes alone, either because they
 * implement a generic CC for a specialized purpose or because they report status information
 * that does not match reality. Overrides are keyed on the Manufacturer Specific fingerprint so
 * the exception stays confined to the exact hardware it was verified against.
 */
export interface DeviceOverride {
  /** Manufacturer Specific manufacturer ID. */
  readonly manufacturerId: number;
  /** Manufacturer Specific product type. */
  readonly productType: number;
  /** Manufacturer Specific product ID. */
  readonly productId: number;
  /** Names the device in the log when an override changes what it publishes. */
  readonly label: string;
  /**
   * The device drives a window covering through Multilevel Switch CC because it does not
   * implement Window Covering CC.
   */
  readonly multilevelSwitchDrivesCovering?: true;
  /**
   * How long a position request waits for a quieter one to replace it before anything is
   * transmitted. Dragging a HomeKit slider produces a burst of writes a few hundred milliseconds
   * apart; without this every one of them becomes a separate command. Left unset, requests are
   * transmitted as they arrive.
   */
  readonly coalescePositionCommandsMs?: number;
  /**
   * The least time between the end of one position write and the start of the next. The device
   * mishandles a command that arrives right behind another (ignoring it, stopping short or
   * pausing), so a later request is held for the rest of this time and the newest one wins. A
   * stop is never held.
   */
  readonly minPositionCommandGapMs?: number;
}

export const DEVICE_OVERRIDES: readonly DeviceOverride[] = [
  {
    manufacturerId: 0x026e,
    productType: 0x5253,
    productId: 0x5a31,
    label: 'Springs Window Fashions RSZ1 (Somfy Motorized Shade)',
    multilevelSwitchDrivesCovering: true,
    /**
     * Observed slider bursts from this shade arrive 250-420 ms apart, so 600 ms collapses a drag
     * into one command while leaving a deliberate second request a few seconds later intact.
     */
    coalescePositionCommandsMs: 600,
    minPositionCommandGapMs: 1500,
  },
];

export function findDeviceOverride(node: IZWaveNode): DeviceOverride | undefined {
  const { manufacturerId, productType, productId } = node;
  if (manufacturerId === undefined || productType === undefined || productId === undefined) {
    return undefined;
  }

  return DEVICE_OVERRIDES.find(
    (override) =>
      override.manufacturerId === manufacturerId &&
      override.productType === productType &&
      override.productId === productId,
  );
}

/**
 * Decides whether a device's Multilevel Switch CC controls a covering instead of a light.
 *
 * Only a verified fingerprint qualifies. Reclassifying an accessory replaces its HomeKit service,
 * which breaks the automations built on the old one, so a guess drawn from the Specific Device
 * Class is not worth the damage it would do to the devices it got wrong.
 */
export function multilevelSwitchDrivesCovering(node: IZWaveNode): boolean {
  return Boolean(findDeviceOverride(node)?.multilevelSwitchDrivesCovering);
}
