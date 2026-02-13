import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
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
    const value = this.node.getValue({
      commandClass: CommandClasses.Battery,
      property: 'level',
      endpoint: this.endpoint.index,
    });

    if (typeof value === 'number') {
      const level = Math.max(0, Math.min(value, 100));
      const lowBattery = this.getStatusLowBattery();

      this.service.updateCharacteristic(this.platform.Characteristic.BatteryLevel, level);
      this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, lowBattery);
    }
  }

  private getBatteryLevel(): number {
    const value = this.node.getValue({
      commandClass: CommandClasses.Battery,
      property: 'level',
      endpoint: this.endpoint.index,
    });
    return typeof value === 'number' ? Math.max(0, Math.min(value, 100)) : 0;
  }

  private getStatusLowBattery(): number {
    const value = this.node.getValue({
      commandClass: CommandClasses.Battery,
      property: 'isLow',
      endpoint: this.endpoint.index,
    });

    if (typeof value === 'boolean') {
      return value ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    const level = this.getBatteryLevel();
    // Default to normal if level is 0 (could be unknown) or > 15
    if (level === 0) {
        const rawValue = this.node.getValue({ commandClass: CommandClasses.Battery, property: 'level', endpoint: this.endpoint.index });
        if (typeof rawValue !== 'number') {
            return this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
        }
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
