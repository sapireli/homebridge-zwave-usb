import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

export class BinarySwitchFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Switch, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleGetOn.bind(this))
      .onSet(this.handleSetOn.bind(this));
  }

  update(args?: ZWaveValueEvent): void {
    if (!this.shouldUpdate(args, CommandClasses['Binary Switch'])) {
      return;
    }
    const value = this.node.getValue({
      commandClass: CommandClasses['Binary Switch'],
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    this.service.updateCharacteristic(this.platform.Characteristic.On, !!value);
  }

  private handleGetOn(): boolean {
    const value = this.node.getValue({
      commandClass: CommandClasses['Binary Switch'],
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    return !!value;
  }

  private async handleSetOn(value: CharacteristicValue) {
    await this.writeZWaveValue({
      characteristic: 'On',
      commandClass: CommandClasses['Binary Switch'],
      property: 'targetValue',
      requestedValue: value,
      zwaveValue: value,
    });
  }
}
