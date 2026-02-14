import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

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
      .onGet(() => false); // Z-Wave doesn't map cleanly to this generic boolean often
  }

  update(args?: ZWaveValueEvent): void {
    if (!this.shouldUpdate(args, CommandClasses['Barrier Operator'])) {
      return;
    }
    const current = this.handleGetCurrentState();
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, current);
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
      if (val === 0) return this.platform.Characteristic.CurrentDoorState.CLOSED;
      if (val === 255) return this.platform.Characteristic.CurrentDoorState.OPEN;
      if (val === 252) return this.platform.Characteristic.CurrentDoorState.CLOSING;
      if (val === 254) return this.platform.Characteristic.CurrentDoorState.OPENING;
      if (val === 253) return this.platform.Characteristic.CurrentDoorState.STOPPED;
    }
    return this.platform.Characteristic.CurrentDoorState.CLOSED;
  }

  private handleGetTargetState(): number {
    const val = this.node.getValue({
      commandClass: CommandClasses['Barrier Operator'],
      property: 'targetState',
      endpoint: this.endpoint.index,
    });

    if (typeof val === 'number') {
      // 0 = Closed, 255 = Open
      if (val === 255) return this.platform.Characteristic.TargetDoorState.OPEN;
      return this.platform.Characteristic.TargetDoorState.CLOSED;
    }
    return this.platform.Characteristic.TargetDoorState.CLOSED;
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
    }
  }
}
