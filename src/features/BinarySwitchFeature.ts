import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';

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

  update(): void {
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
    try {
      await this.node.setValue(
        { commandClass: CommandClasses['Binary Switch'], property: 'targetValue', endpoint: this.endpoint.index },
        value,
      );
    } catch (err) {
      this.platform.log.error(`Failed to set switch value for node ${this.node.nodeId} endpoint ${this.endpoint.index}:`, err);
      // SERVICE_COMMUNICATION_FAILURE = -70402
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }
}
