import { Service, CharacteristicValue } from 'homebridge';
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
      commandClass: 37,
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    this.service.updateCharacteristic(this.platform.Characteristic.On, !!value);
  }

  private handleGetOn(): boolean {
    const value = this.node.getValue({
      commandClass: 37,
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    return !!value;
  }

  private async handleSetOn(value: CharacteristicValue) {
    try {
      await this.node.setValue(
        { commandClass: 37, property: 'targetValue', endpoint: this.endpoint.index },
        value,
      );
    } catch (err) {
      this.platform.log.error(`Failed to set switch value for node ${this.node.nodeId} endpoint ${this.endpoint.index}:`, err);
      // -70402: SERVICE_COMMUNICATION_FAILURE
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw new this.platform.api.hap.HapStatusError(-70402 as any);
    }
  }
}
