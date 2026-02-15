import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * LeakSensorFeature handles Water leak detection.
 */
export class LeakSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.LeakSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.LeakDetected)
      .onGet(this.handleGetLeakDetected.bind(this));
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
    try {
      const value = this.getSensorValue();
      this.service.updateCharacteristic(this.platform.Characteristic.LeakDetected, value);
    } catch {
      // ignore
    }
  }

  private getSensorValue(): number {
    // 1. Check Notification CC (Water Alarm)
    if (this.node.supportsCC(CommandClasses.Notification)) {
      const val =
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Water Alarm',
          propertyKey: 'Water leak status',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Water Alarm',
          propertyKey: 'Sensor status',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Water Alarm',
          endpoint: this.endpoint.index,
        });

      if (typeof val === 'number') {
        return val === 2
          ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED
          : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
      }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(CommandClasses['Binary Sensor'])) {
      const value =
        this.node.getValue({
          commandClass: CommandClasses['Binary Sensor'],
          property: 'Water',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses['Binary Sensor'],
          property: 'Any',
          endpoint: this.endpoint.index,
        });

      if (value !== undefined) {
        return value
          ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED
          : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
      }
    }

    throw new this.platform.api.hap.HapStatusError(-70402);
  }

  private handleGetLeakDetected(): number {
    return this.getSensorValue();
  }
}
