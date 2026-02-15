import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

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

  update(args?: ZWaveValueEvent): void {
    if (
      !this.shouldUpdate(args, CommandClasses.Battery) &&
      !this.shouldUpdate(args, CommandClasses.Notification)
    ) {
      return;
    }

    /**
     * NOTIFICATION FIX: Some devices report low battery via Power Management notifications.
     */
    if (args && args.commandClass === CommandClasses.Notification) {
      if (args.property === 'Power Management' && args.newValue === 10) {
        // 10 = Replace battery soon
        this.service.updateCharacteristic(
          this.platform.Characteristic.StatusLowBattery,
          this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
        );
      }
      return;
    }

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
    const level = this.getBatteryLevel();
    const isLowFlag = this.node.getValue({
      commandClass: CommandClasses.Battery,
      property: 'isLow',
      endpoint: this.endpoint.index,
    });

    /**
     * BATTERY CONSISTENCY FIX: Prioritize numerical level (<= 20%) for HomeKit.
     * We also check the Z-Wave 'isLow' flag as a fallback.
     */
    const isLow = (typeof level === 'number' && level > 0 && level <= 20) || isLowFlag === true;

    return isLow
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private handleGetBatteryLevel(): number {
    return this.getBatteryLevel();
  }

  private handleGetStatusLowBattery(): number {
    return this.getStatusLowBattery();
  }
}
