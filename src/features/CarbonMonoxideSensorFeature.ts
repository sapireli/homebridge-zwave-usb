import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

export class CarbonMonoxideSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.CarbonMonoxideSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.CarbonMonoxideDetected)
      .onGet(this.handleGetCODetected.bind(this));
  }

  update(args?: ZWaveValueEvent): void {
    if (args) {
      if ((args.endpoint || 0) !== this.endpoint.index) {
        return;
      }
      if (
        args.commandClass !== CommandClasses.Notification &&
        args.commandClass !== CommandClasses['Binary Sensor']
      ) {
        return;
      }
    }
    const value = this.getSensorValue();
    this.service.updateCharacteristic(this.platform.Characteristic.CarbonMonoxideDetected, value);
  }

  private getSensorValue(): number {
    // 1. Check Notification CC (CO Alarm)
    if (this.node.supportsCC(CommandClasses.Notification)) {
      const val =
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Carbon Monoxide Alarm',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Carbon Monoxide Alarm',
          propertyKey: 'Sensor status',
          endpoint: this.endpoint.index,
        });

      // 1 or 2 = CO Detected, 0 = Idle
      if (typeof val === 'number') {
        return val === 1 || val === 2
          ? this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
          : this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
      }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(CommandClasses['Binary Sensor'])) {
      const value =
        this.node.getValue({
          commandClass: CommandClasses['Binary Sensor'],
          property: 'CO',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses['Binary Sensor'],
          property: 'CO2',
          endpoint: this.endpoint.index,
        });
      return value
        ? this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
        : this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
    }

    return this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
  }

  private handleGetCODetected(): number {
    return this.getSensorValue();
  }
}
