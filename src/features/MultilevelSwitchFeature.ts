import { Service, CharacteristicValue } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class MultilevelSwitchFeature extends BaseFeature {
  private service!: Service;
  private lastKnownBrightness = 0;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Lightbulb, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleGetOn.bind(this))
      .onSet(this.handleSetOn.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(this.handleGetBrightness.bind(this))
      .onSet(this.handleSetBrightness.bind(this));
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
      
      if (value <= 99) {
        this.lastKnownBrightness = value;
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, value);
      } else if (value === 255 && isOn) {
        // 255 = restore previous level
        // Use our tracked brightness, default to 100 if unknown
        const brightness = this.lastKnownBrightness > 0 ? this.lastKnownBrightness : 100;
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, brightness);
      }
    }
  }

  private handleGetOn(): boolean {
    const value = this.node.getValue({
      commandClass: 38,
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    return typeof value === 'number' && value > 0;
  }

  private async handleSetOn(value: CharacteristicValue) {
    const targetValue = value ? 255 : 0;
    try {
      await this.node.setValue(
        { commandClass: 38, property: 'targetValue', endpoint: this.endpoint.index },
        targetValue,
      );
    } catch (err) {
      this.platform.log.error(`Failed to set ON/OFF for node ${this.node.nodeId} endpoint ${this.endpoint.index}:`, err);
      // -70402: SERVICE_COMMUNICATION_FAILURE
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw new this.platform.api.hap.HapStatusError(-70402 as any);
    }
  }

  private handleGetBrightness(): number {
    const value = this.node.getValue({
      commandClass: 38,
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    return typeof value === 'number' ? Math.min(value, 100) : 0;
  }

  private async handleSetBrightness(value: CharacteristicValue) {
    const targetValue = Math.min(Math.max(value as number, 0), 99);
    try {
      await this.node.setValue(
        { commandClass: 38, property: 'targetValue', endpoint: this.endpoint.index },
        targetValue,
      );
    } catch (err) {
      this.platform.log.error(`Failed to set Brightness for node ${this.node.nodeId} endpoint ${this.endpoint.index}:`, err);
      // -70402: SERVICE_COMMUNICATION_FAILURE
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw new this.platform.api.hap.HapStatusError(-70402 as any);
    }
  }
}
