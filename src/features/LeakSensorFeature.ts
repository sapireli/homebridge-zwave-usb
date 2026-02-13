import { Service } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class LeakSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.LeakSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.LeakDetected)
      .onGet(this.handleGetLeakDetected.bind(this));
  }

  update(): void {
    const value = this.getSensorValue();
    this.service.updateCharacteristic(this.platform.Characteristic.LeakDetected, value);
  }

  private getSensorValue(): number {
    // 1. Check Notification CC (Water Alarm)
    if (this.node.supportsCC(113)) {
        const val = this.node.getValue({
            commandClass: 113,
            property: 'Water Alarm',
            propertyKey: 'Water leak status',
            endpoint: this.endpoint.index,
        }) ?? this.node.getValue({
            commandClass: 113,
            property: 'Water Alarm',
            propertyKey: 'Sensor status',
            endpoint: this.endpoint.index,
        }) ?? this.node.getValue({
            commandClass: 113,
            property: 'Water Alarm',
            endpoint: this.endpoint.index,
        });

        // 2 = Water Leak Detected, 0 = Idle
        if (typeof val === 'number') {
            return val === 2 ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
        }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(48)) { 
       const value = this.node.getValue({
        commandClass: 48,
        property: 'Water', 
        endpoint: this.endpoint.index,
      }) ?? this.node.getValue({
        commandClass: 48,
        property: 'Any', 
        endpoint: this.endpoint.index,
      });
      return value ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
    }
    
    return this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  }

  private handleGetLeakDetected(): number {
    return this.getSensorValue();
  }
}
