import { Service } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class BatteryFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Battery, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(this.handleGetBatteryLevel.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(this.handleGetStatusLowBattery.bind(this));
  }

  update(): void {
    const level = this.getBatteryLevel();
    const lowBattery = this.getStatusLowBattery();

    this.service.updateCharacteristic(this.platform.Characteristic.BatteryLevel, level);
    this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, lowBattery);
  }

  private getBatteryLevel(): number {
    const value = this.node.getValue({
      commandClass: 128, // Battery CC
      property: 'level',
      endpoint: this.endpoint.index,
    });
    return typeof value === 'number' ? Math.max(0, Math.min(value, 100)) : -1;
  }

  private getStatusLowBattery(): number {
    const value = this.node.getValue({
      commandClass: 128,
      property: 'isLow',
      endpoint: this.endpoint.index,
    });

    if (typeof value === 'boolean') {
      return value ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    const level = this.getBatteryLevel();
    // -1 means unknown/unavailable, don't show low battery warning for unknown
    if (level < 0) {
      return this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
    return level <= 15 ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private handleGetBatteryLevel(): number {
    return this.getBatteryLevel();
  }

  private handleGetStatusLowBattery(): number {
    return this.getStatusLowBattery();
  }
}
