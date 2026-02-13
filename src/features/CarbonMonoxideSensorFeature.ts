import { Service } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class CarbonMonoxideSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.CarbonMonoxideSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.CarbonMonoxideDetected)
      .onGet(this.handleGetCODetected.bind(this));
  }

  update(): void {
    const value = this.getSensorValue();
    this.service.updateCharacteristic(this.platform.Characteristic.CarbonMonoxideDetected, value);
  }

  private getSensorValue(): number {
    // 1. Check Notification CC (CO Alarm)
    if (this.node.supportsCC(113)) {
        const val = this.node.getValue({
            commandClass: 113,
            property: 'Carbon Monoxide Alarm',
            endpoint: this.endpoint.index,
        }) ?? this.node.getValue({
            commandClass: 113,
            property: 'Carbon Monoxide Alarm',
            propertyKey: 'Sensor status',
            endpoint: this.endpoint.index,
        });

        // 1 or 2 = CO Detected, 0 = Idle
        if (typeof val === 'number') {
            return (val === 1 || val === 2) 
                ? this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL 
                : this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
        }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(48)) { 
       const value = this.node.getValue({
        commandClass: 48,
        property: 'CO', 
        endpoint: this.endpoint.index,
      }) ?? this.node.getValue({
        commandClass: 48,
        property: 'CO2', 
        endpoint: this.endpoint.index,
      });
      return value ? this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL : this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
    }
    
    return this.platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
  }

  private handleGetCODetected(): number {
    return this.getSensorValue();
  }
}
