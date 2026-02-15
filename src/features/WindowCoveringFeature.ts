import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * WindowCoveringFeature handles shades and blinds using Window Covering or Multilevel Switch CC.
 */
export class WindowCoveringFeature extends BaseFeature {
  private service!: Service;
  private localTargetPosition?: number;
  private lockoutTimer?: NodeJS.Timeout;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.WindowCovering, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.handleGetCurrentPosition.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.handleGetTargetPosition.bind(this))
      .onSet(this.handleSetTargetPosition.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handleGetPositionState.bind(this));
  }

  public stop(): void {
    if (this.lockoutTimer) {
      clearTimeout(this.lockoutTimer);
      this.lockoutTimer = undefined;
    }
  }

  update(args?: ZWaveValueEvent): void {
    if (
      !this.shouldUpdate(args, CommandClasses['Window Covering']) &&
      !this.shouldUpdate(args, CommandClasses['Multilevel Switch'])
    ) {
      return;
    }

    /**
     * UI LOCKOUT FIX: If we recently sent a set command (lockoutTimer active),
     * we ignore incoming 'targetValue' updates from the driver for 3 seconds.
     * This prevents the HomeKit slider from jumping back to an old cached position
     * while the Z-Wave device is still processing the request.
     */
    if (this.lockoutTimer && args && args.property === 'targetValue') {
      return;
    }

    try {
      const current = this.handleGetCurrentPosition();
      const target = this.handleGetTargetPosition();
      const state = this.handleGetPositionState();

      this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, current);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, target);
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, state);
    } catch {
      // Ignore background update errors
    }
  }

  private handleGetCurrentPosition(): number {
    const val =
      this.node.getValue({
        commandClass: CommandClasses['Window Covering'],
        property: 'currentValue',
        endpoint: this.endpoint.index,
      }) ??
      this.node.getValue({
        commandClass: CommandClasses['Multilevel Switch'],
        property: 'currentValue',
        endpoint: this.endpoint.index,
      });

    if (typeof val === 'number') {
      return val === 99 ? 100 : val;
    }

    /**
     * OFFLINE COVERING FIX: Throw error if state is unknown to avoid false 'Closed' report.
     */
    throw new this.platform.api.hap.HapStatusError(-70402);
  }

  private handleGetTargetPosition(): number {
    const val =
      this.node.getValue({
        commandClass: CommandClasses['Window Covering'],
        property: 'targetValue',
        endpoint: this.endpoint.index,
      }) ??
      this.node.getValue({
        commandClass: CommandClasses['Multilevel Switch'],
        property: 'targetValue',
        endpoint: this.endpoint.index,
      });

    if (typeof val === 'number') {
      const pos = val === 99 ? 100 : val;
      this.localTargetPosition = pos;
      return pos;
    }

    /**
     * TARGET FALLBACK FIX: Use the locally tracked target if the driver value is missing.
     * This prevents the shade from appearing "Stopped" while it is still moving.
     */
    if (this.localTargetPosition !== undefined) {
      return this.localTargetPosition;
    }

    // Fallback to current position if target is unknown
    try {
      return this.handleGetCurrentPosition();
    } catch {
      return 0;
    }
  }

  private async handleSetTargetPosition(value: CharacteristicValue) {
    const target = value as number;
    this.localTargetPosition = target;

    if (this.lockoutTimer) {
      clearTimeout(this.lockoutTimer);
    }
    this.lockoutTimer = setTimeout(() => {
      this.lockoutTimer = undefined;
    }, 3000);

    let zwaveVal = target;

    /**
     * EXPLICIT STOP FIX: If target matches current exactly (e.g. user pressed Stop),
     * sending the level command forces many Z-Wave covers to halt movement.
     */
    if (target === 100) {
      zwaveVal = 99;
    }

    const cc = this.endpoint.supportsCC(CommandClasses['Window Covering'])
      ? CommandClasses['Window Covering']
      : CommandClasses['Multilevel Switch'];

    try {
      await this.node.setValue(
        {
          commandClass: cc,
          property: 'targetValue',
          endpoint: this.endpoint.index,
        },
        zwaveVal,
      );
    } catch (err) {
      if (this.lockoutTimer) {
        clearTimeout(this.lockoutTimer);
        this.lockoutTimer = undefined;
      }
      this.platform.log.error('Failed to set window covering position:', err);
      /**
       * SILENT FAILURE FIX: Inform HomeKit that the command failed.
       */
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  private handleGetPositionState(): number {
    // 0 = Decreasing, 1 = Increasing, 2 = Stopped
    const current = this.handleGetCurrentPosition();
    const target = this.handleGetTargetPosition();

    /**
     * FLICKER FIX: Z-Wave shades often report +/- 1-2% difference during movement.
     * We use a 2% tolerance to prevent HomeKit from briefly switching to 'STOPPED'
     * while the shade is still in transit.
     *
     * BOUNDARY FIX: We only apply this tolerance if the target is NOT 0 or 100,
     * to ensure the shade accurately reports reaching its limits.
     */
    const isAtLimit = target === 0 || target === 100;
    const tolerance = isAtLimit ? 0 : 2;

    if (Math.abs(current - target) <= tolerance) {
      return this.platform.Characteristic.PositionState.STOPPED;
    }

    if (current < target) {
      return this.platform.Characteristic.PositionState.INCREASING;
    }
    return this.platform.Characteristic.PositionState.DECREASING;
  }
}
