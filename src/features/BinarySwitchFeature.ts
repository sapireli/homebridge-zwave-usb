import { Endpoint } from 'zwave-js';
import { IZWaveNode } from '../zwave/interfaces';
import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature, definedValues, hasValue } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

export class BinarySwitchFeature extends BaseFeature {
  /** Reads `currentValue` and writes `targetValue`; without both the switch cannot work. */
  public static canBePrimary(node: IZWaveNode, endpoint: Endpoint): boolean {
    const values = definedValues(node, endpoint.index);

    return (
      hasValue(values, CommandClasses['Binary Switch'], 'currentValue') &&
      hasValue(values, CommandClasses['Binary Switch'], 'targetValue')
    );
  }

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
