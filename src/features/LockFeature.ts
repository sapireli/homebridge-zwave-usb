import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * LockFeature supports both basic 'Lock' CC (76) and 'Door Lock' CC (98/159).
 */
export class LockFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.LockMechanism, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .onGet(this.handleGetLockCurrentState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.LockTargetState)
      .onGet(this.handleGetLockTargetState.bind(this))
      .onSet(this.handleSetLockTargetState.bind(this));
  }

  update(args?: ZWaveValueEvent): void {
    if (
      !this.shouldUpdate(args, CommandClasses['Door Lock']) &&
      !this.shouldUpdate(args, CommandClasses.Lock)
    ) {
      return;
    }

    try {
      const state = this.handleGetLockCurrentState();
      const target = this.handleGetLockTargetState();

      this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, state);

      /**
       * UI DESYNC FIX: Update TargetState to match CurrentState if changed manually.
       * This prevents HomeKit from being stuck in "Locking..." or "Unlocking..."
       */
      this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, target);
    } catch {
      // Ignore background update errors
    }
  }

  private mapZWaveToHomeKit(value: number): number {
    // Door Lock CC (255=Secured, 0=Unsecured) or Basic Lock (true=Secured, false=Unsecured)
    if (value === 255 || value === 1 || value === 0xff) {
      return this.platform.Characteristic.LockCurrentState.SECURED;
    }
    if (value === 0) {
      return this.platform.Characteristic.LockCurrentState.UNSECURED;
    }
    return this.platform.Characteristic.LockCurrentState.UNKNOWN;
  }

  private handleGetLockCurrentState(): number {
    const value =
      this.node.getValue({
        commandClass: CommandClasses['Door Lock'],
        property: 'currentMode',
        endpoint: this.endpoint.index,
      }) ??
      this.node.getValue({
        commandClass: CommandClasses.Lock,
        property: 'locked',
        endpoint: this.endpoint.index,
      });

    if (typeof value === 'number' || typeof value === 'boolean') {
      return this.mapZWaveToHomeKit(Number(value));
    }

    if (this.node.ready === false || this.node.status === 3) {
      throw new this.platform.api.hap.HapStatusError(-70402);
    }

    const lastKnown = this.service.getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .value as number;
    if (typeof lastKnown === 'number') {
      return lastKnown;
    }

    return this.platform.Characteristic.LockCurrentState.UNKNOWN;
  }

  private handleGetLockTargetState(): number {
    const value =
      this.node.getValue({
        commandClass: CommandClasses['Door Lock'],
        property: 'targetMode',
        endpoint: this.endpoint.index,
      }) ??
      this.node.getValue({
        commandClass: CommandClasses['Door Lock'],
        property: 'currentMode',
        endpoint: this.endpoint.index,
      }) ??
      this.node.getValue({
        commandClass: CommandClasses.Lock,
        property: 'locked',
        endpoint: this.endpoint.index,
      });

    if (typeof value === 'number' || typeof value === 'boolean') {
      const state = this.mapZWaveToHomeKit(Number(value));
      if (state === this.platform.Characteristic.LockCurrentState.SECURED) {
        return this.platform.Characteristic.LockTargetState.SECURED;
      }
      if (state === this.platform.Characteristic.LockCurrentState.UNSECURED) {
        return this.platform.Characteristic.LockTargetState.UNSECURED;
      }
    }

    if (this.node.ready === false || this.node.status === 3) {
      throw new this.platform.api.hap.HapStatusError(-70402);
    }

    const lastKnown = this.service.getCharacteristic(this.platform.Characteristic.LockTargetState)
      .value as number;
    if (typeof lastKnown === 'number') {
      return lastKnown;
    }

    return this.platform.Characteristic.LockTargetState.UNSECURED;
  }

  private async handleSetLockTargetState(value: CharacteristicValue) {
    const isSecure = value === this.platform.Characteristic.LockTargetState.SECURED;
    const targetValue = isSecure ? 255 : 0;

    const useDoorLock = this.endpoint.supportsCC(CommandClasses['Door Lock']);
    const cc = useDoorLock ? CommandClasses['Door Lock'] : CommandClasses.Lock;
    const property = useDoorLock ? 'targetMode' : 'locked';

    try {
      await this.node.setValue(
        {
          commandClass: cc,
          property: property,
          endpoint: this.endpoint.index,
        },
        useDoorLock ? targetValue : !!isSecure,
      );
    } catch (err) {
      this.platform.log.error(
        `Failed to set Lock Target for node ${this.node.nodeId} endpoint ${this.endpoint.index}:`,
        err,
      );
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }
}
