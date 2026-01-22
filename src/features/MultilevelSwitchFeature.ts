import { Service, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class MultilevelSwitchFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Lightbulb, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .on('get', this.handleGetOn.bind(this))
      .on('set', this.handleSetOn.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .on('get', this.handleGetBrightness.bind(this))
      .on('set', this.handleSetBrightness.bind(this));
  }

  update(): void {
    const value = this.node.getValue({
      commandClass: 38,
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    
    if (typeof value === 'number') {
      const isOn = value > 0;
      this.service.updateCharacteristic(this.platform.Characteristic.On, isOn);
      if (isOn && value <= 99) {
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, value);
      }
    }
  }

  private async handleGetOn(callback: CharacteristicGetCallback) {
    const value = this.node.getValue({
      commandClass: 38,
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    const isOn = typeof value === 'number' && value > 0;
    callback(null, isOn);
  }

  private async handleSetOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    const targetValue = value ? 255 : 0;
    try {
      await this.node.setValue(
        { commandClass: 38, property: 'targetValue', endpoint: this.endpoint.index },
        targetValue,
      );
      callback(null);
    } catch (err) {
      this.platform.log.error(`Failed to set ON/OFF for node ${this.node.nodeId} endpoint ${this.endpoint.index}:`, err);
      callback(err as Error);
    }
  }

  private async handleGetBrightness(callback: CharacteristicGetCallback) {
    const value = this.node.getValue({
      commandClass: 38,
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    const brightness = typeof value === 'number' ? Math.min(value, 100) : 0;
    callback(null, brightness);
  }

  private async handleSetBrightness(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    const targetValue = Math.min(Math.max(value as number, 0), 99);
    try {
      await this.node.setValue(
        { commandClass: 38, property: 'targetValue', endpoint: this.endpoint.index },
        targetValue,
      );
      callback(null);
    } catch (err) {
      this.platform.log.error(`Failed to set Brightness for node ${this.node.nodeId} endpoint ${this.endpoint.index}:`, err);
      callback(err as Error);
    }
  }
}
