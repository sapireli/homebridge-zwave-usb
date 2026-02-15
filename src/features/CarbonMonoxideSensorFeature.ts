import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * CarbonMonoxideSensorFeature handles Z-Wave CO detectors.
 */
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
    try {
      const value = this.getSensorValue();
      this.service.updateCharacteristic(this.platform.Characteristic.CarbonMonoxideDetected, value);
    } catch {
      // Ignore background update errors
    }
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

      // 1-5 = CO Detected (various levels/locations), 0 = Idle
      if (typeof val === 'number') {
        return val >= 1 && val <= 5
          ? this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
          : this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
      }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(CommandClasses['Binary Sensor'])) {
      /**
       * CO2 FIX: Do not check for CO2 property here. Binary CO2 sensors are now
       * mapped to the MultilevelSensorFeature (Air Quality) in AccessoryFactory.
       */
      const value = this.node.getValue({
        commandClass: CommandClasses['Binary Sensor'],
        property: 'CO',
        endpoint: this.endpoint.index,
      });

      if (value !== undefined) {
        return value
          ? this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
          : this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
      }
    }

    /**
     * SECURITY FALLBACK FIX: Throw error if data is missing to avoid false 'Safe' state.
     */
    throw new this.platform.api.hap.HapStatusError(-70402);
  }

  private handleGetCODetected(): number {
    return this.getSensorValue();
  }
}
