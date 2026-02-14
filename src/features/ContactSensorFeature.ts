import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

export class ContactSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.ContactSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.handleGetContactSensorState.bind(this));
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
    this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, value);
  }

  private getSensorValue(): number {
    // 1. Check Notification CC (Access Control / Home Security)
    if (this.node.supportsCC(CommandClasses.Notification)) {
      const val =
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Access Control',
          propertyKey: 'Door status',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Access Control',
          propertyKey: 'Sensor status',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Home Security',
          propertyKey: 'Sensor status',
          endpoint: this.endpoint.index,
        });

      if (typeof val === 'number') {
        if (val === 22) return this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED; // Open
        if (val === 23 || val === 0)
          return this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED; // Closed / Idle
      }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(CommandClasses['Binary Sensor'])) {
      const value =
        this.node.getValue({
          commandClass: CommandClasses['Binary Sensor'],
          property: 'Door/Window',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses['Binary Sensor'],
          property: 'Any',
          endpoint: this.endpoint.index,
        });
      return value
        ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    return this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  private handleGetContactSensorState(): number {
    return this.getSensorValue();
  }
}
