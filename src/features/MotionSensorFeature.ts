import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

export class MotionSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.MotionSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.MotionDetected)
      .onGet(this.handleGetMotionDetected.bind(this));
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
    this.service.updateCharacteristic(this.platform.Characteristic.MotionDetected, value);
  }

  private getSensorValue(): boolean {
    // 1. Check Notification CC (Home Security - Motion)
    if (this.node.supportsCC(CommandClasses.Notification)) {
      const val =
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Home Security',
          propertyKey: 'Motion sensor status',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Home Security',
          propertyKey: 'Sensor status',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Home Security',
          endpoint: this.endpoint.index,
        });

      if (typeof val === 'number') {
        return val === 8 || val === 7; // 8 = Motion, 7 = Motion (location unknown)
      }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(CommandClasses['Binary Sensor'])) {
      const value =
        this.node.getValue({
          commandClass: CommandClasses['Binary Sensor'],
          property: 'Motion',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses['Binary Sensor'],
          property: 'Any',
          endpoint: this.endpoint.index,
        });
      return !!value;
    }

    return false;
  }

  private handleGetMotionDetected(): boolean {
    return this.getSensorValue();
  }
}
