import { Service, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class BinarySwitchFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Switch, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .on('get', this.handleGetOn.bind(this))
      .on('set', this.handleSetOn.bind(this));
  }

  update(): void {
    const value = this.node.getValue({
      commandClass: 37,
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    this.service.updateCharacteristic(this.platform.Characteristic.On, value as boolean);
  }

  private async handleGetOn(callback: CharacteristicGetCallback) {
    const value = this.node.getValue({
      commandClass: 37,
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    callback(null, value as boolean);
  }

  private async handleSetOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    try {
      await this.node.setValue(
        { commandClass: 37, property: 'targetValue', endpoint: this.endpoint.index },
        value,
      );
      callback(null);
    } catch (err) {
      this.platform.log.error(`Failed to set switch value for node ${this.node.nodeId} endpoint ${this.endpoint.index}:`, err);
      callback(err as Error);
    }
  }
}
