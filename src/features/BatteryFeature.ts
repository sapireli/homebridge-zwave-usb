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
      const alarmState = this.getLowBatteryAlarmStateFromEvent(args);
      if (alarmState !== undefined) {
        this.service.updateCharacteristic(
          this.platform.Characteristic.StatusLowBattery,
          alarmState
            ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
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
    const alarmState = this.getLowBatteryAlarmStateFromCache();
    if (alarmState !== undefined) {
      return alarmState
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    const isLowFlag = this.node.getValue({
      commandClass: CommandClasses.Battery,
      property: 'isLow',
      endpoint: this.endpoint.index,
    });
    if (typeof isLowFlag === 'boolean') {
      return isLowFlag
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    const level = this.getBatteryLevel();

    /**
     * Final fallback only when no explicit alarm/flag is available.
     */
    const isLow = typeof level === 'number' && level > 0 && level <= 20;

    return isLow
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private getLowBatteryAlarmStateFromEvent(args: ZWaveValueEvent): boolean | undefined {
    if (args.property !== 'Power Management') {
      return undefined;
    }
    return this.parseLowBatteryNotificationValue(args.newValue);
  }

  private getLowBatteryAlarmStateFromCache(): boolean | undefined {
    const notificationKeys = [
      'Replace battery soon status',
      'Replace battery now status',
      'Battery is low',
      'Low battery level status',
    ];

    for (const key of notificationKeys) {
      const val = this.node.getValue({
        commandClass: CommandClasses.Notification,
        property: 'Power Management',
        propertyKey: key,
        endpoint: this.endpoint.index,
      });
      const parsed = this.parseLowBatteryNotificationValue(val);
      if (parsed !== undefined) {
        return parsed;
      }
    }

    const fallback = this.node.getValue({
      commandClass: CommandClasses.Notification,
      property: 'Power Management',
      endpoint: this.endpoint.index,
    });
    return this.parseLowBatteryNotificationValue(fallback);
  }

  private parseLowBatteryNotificationValue(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'number') {
      return undefined;
    }

    // Notification event values used by devices for low battery alarms.
    if (value === 10 || value === 11) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return undefined;
  }

  private handleGetBatteryLevel(): number {
    return this.getBatteryLevel();
  }

  private handleGetStatusLowBattery(): number {
    return this.getStatusLowBattery();
  }
}
