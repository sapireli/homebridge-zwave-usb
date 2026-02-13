import { Service } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class SmokeSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.SmokeSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.SmokeDetected)
      .onGet(this.handleGetSmokeDetected.bind(this));
  }

  update(): void {
    const value = this.getSensorValue();
    this.service.updateCharacteristic(this.platform.Characteristic.SmokeDetected, value);
  }

  private getSensorValue(): number {
    // 1. Check Notification CC (Smoke Alarm)
    if (this.node.supportsCC(113)) {
        const val = this.node.getValue({
            commandClass: 113,
            property: 'Smoke Alarm',
            endpoint: this.endpoint.index,
        }) ?? this.node.getValue({
            commandClass: 113,
            property: 'Smoke Alarm',
            propertyKey: 'Sensor status',
            endpoint: this.endpoint.index,
        });

        // 1 or 2 = Smoke Detected, 0 = Idle
        if (typeof val === 'number') {
            return (val === 1 || val === 2) 
                ? this.platform.Characteristic.SmokeDetected.SMOKE_DETECTED 
                : this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
        }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(48)) { 
       const value = this.node.getValue({
        commandClass: 48,
        property: 'Smoke', 
        endpoint: this.endpoint.index,
      });
      return value ? this.platform.Characteristic.SmokeDetected.SMOKE_DETECTED : this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
    }
    
    return this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
  }

  private handleGetSmokeDetected(): number {
    return this.getSensorValue();
  }
}
