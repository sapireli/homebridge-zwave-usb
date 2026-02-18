import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * GarageDoorFeature implements support for Garage Door Openers (Barrier Operator CC).
 */
export class GarageDoorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.GarageDoorOpener, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(this.handleGetCurrentState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onGet(this.handleGetTargetState.bind(this))
      .onSet(this.handleSetTargetState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.ObstructionDetected)
      .onGet(this.handleGetObstruction.bind(this));
  }

  update(args?: ZWaveValueEvent): void {
    if (!this.shouldUpdate(args, CommandClasses['Barrier Operator'])) {
      return;
    }
    const current = this.handleGetCurrentState();
    const target = this.handleGetTargetState();
    const obstruction = this.handleGetObstruction();

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, current);
    this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, obstruction);

    /**
     * UI DESYNC FIX: Update TargetState to match CurrentState if changed manually.
     * This ensures the Home app doesn't show "Opening..." forever if moved via wall button.
     */
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, target);
  }

  private handleGetObstruction(): boolean {
    return (
      this.node.getValue({
        commandClass: CommandClasses['Barrier Operator'],
        property: 'obstruction',
        endpoint: this.endpoint.index,
      }) === true
    );
  }

  private handleGetCurrentState(): number {
    // CommandClasses['Barrier Operator']
    // 0 = Closed, 255 = Open, 252 = Closing, 253 = Stopped, 254 = Opening
    const val = this.node.getValue({
      commandClass: CommandClasses['Barrier Operator'],
      property: 'currentState',
      endpoint: this.endpoint.index,
    });

    if (typeof val === 'number') {
      if (val === 0) {
        return this.platform.Characteristic.CurrentDoorState.CLOSED;
      }
      if (val === 255) {
        return this.platform.Characteristic.CurrentDoorState.OPEN;
      }
      if (val === 252) {
        return this.platform.Characteristic.CurrentDoorState.CLOSING;
      }
      if (val === 254) {
        return this.platform.Characteristic.CurrentDoorState.OPENING;
      }
      if (val === 253) {
        return this.platform.Characteristic.CurrentDoorState.STOPPED;
      }
    }

    if (this.node.ready === false || this.node.status === 3) {
      throw new this.platform.api.hap.HapStatusError(-70402);
    }

    const lastKnown = this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .value as number;
    if (typeof lastKnown === 'number') {
      return lastKnown;
    }

    return this.platform.Characteristic.CurrentDoorState.STOPPED;
  }

  private handleGetTargetState(): number {
    const val = this.node.getValue({
      commandClass: CommandClasses['Barrier Operator'],
      property: 'targetState',
      endpoint: this.endpoint.index,
    });

    if (typeof val === 'number') {
      // 0 = Closed, 255 = Open
      if (val === 255) {
        return this.platform.Characteristic.TargetDoorState.OPEN;
      }
      return this.platform.Characteristic.TargetDoorState.CLOSED;
    }

    // Fallback based on current state to keep UI sane
    try {
      const current = this.handleGetCurrentState();
      return current === this.platform.Characteristic.CurrentDoorState.OPEN
        ? this.platform.Characteristic.TargetDoorState.OPEN
        : this.platform.Characteristic.TargetDoorState.CLOSED;
    } catch {
      return this.platform.Characteristic.TargetDoorState.CLOSED;
    }
  }

  private async handleSetTargetState(value: CharacteristicValue) {
    const target = value === this.platform.Characteristic.TargetDoorState.OPEN ? 255 : 0;
    try {
      await this.node.setValue(
        {
          commandClass: CommandClasses['Barrier Operator'],
          property: 'targetState',
          endpoint: this.endpoint.index,
        },
        target,
      );
    } catch (err) {
      this.platform.log.error('Failed to set garage door state:', err);
      /**
       * SILENT FAILURE FIX: Inform HomeKit that the command failed.
       */
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }
}
