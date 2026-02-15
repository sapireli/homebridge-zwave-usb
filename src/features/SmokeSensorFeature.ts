import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * SmokeSensorFeature handles Z-Wave smoke detectors.
 */
export class SmokeSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.SmokeSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.SmokeDetected)
      .onGet(this.handleGetSmokeDetected.bind(this));
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
      this.service.updateCharacteristic(this.platform.Characteristic.SmokeDetected, value);
    } catch {
      // Ignore background update errors
    }
  }

  private getSensorValue(): number {
    // 1. Check Notification CC (Smoke Alarm)
    if (this.node.supportsCC(CommandClasses.Notification)) {
      const val =
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Smoke Alarm',
          endpoint: this.endpoint.index,
        }) ??
        this.node.getValue({
          commandClass: CommandClasses.Notification,
          property: 'Smoke Alarm',
          propertyKey: 'Sensor status',
          endpoint: this.endpoint.index,
        });

      // 1 or 2 = Smoke Detected, 0 = Idle
      if (typeof val === 'number') {
        return val === 1 || val === 2
          ? this.platform.Characteristic.SmokeDetected.SMOKE_DETECTED
          : this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
      }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(CommandClasses['Binary Sensor'])) {
      const value = this.node.getValue({
        commandClass: CommandClasses['Binary Sensor'],
        property: 'Smoke',
        endpoint: this.endpoint.index,
      });

      if (value !== undefined) {
        return value
          ? this.platform.Characteristic.SmokeDetected.SMOKE_DETECTED
          : this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
      }
    }

    /**
     * SECURITY FALLBACK FIX: Throw error if data is missing to avoid false 'Safe' state.
     */
    throw new this.platform.api.hap.HapStatusError(-70402);
  }

  private handleGetSmokeDetected(): number {
    return this.getSensorValue();
  }
}
