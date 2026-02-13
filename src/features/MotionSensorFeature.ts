import { Service } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class MotionSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.MotionSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.MotionDetected)
      .onGet(this.handleGetMotionDetected.bind(this));
  }

  update(): void {
    const value = this.getSensorValue();
    this.service.updateCharacteristic(this.platform.Characteristic.MotionDetected, value);
  }

  private getSensorValue(): boolean {
    // 1. Check Notification CC (Home Security - Motion)
    if (this.node.supportsCC(113)) {
        const val = this.node.getValue({
            commandClass: 113,
            property: 'Home Security',
            propertyKey: 'Motion sensor status',
            endpoint: this.endpoint.index,
        }) ?? this.node.getValue({
            commandClass: 113,
            property: 'Home Security',
            propertyKey: 'Sensor status',
            endpoint: this.endpoint.index,
        }) ?? this.node.getValue({
            commandClass: 113,
            property: 'Home Security',
            endpoint: this.endpoint.index,
        });

        if (typeof val === 'number') {
            return val === 8 || val === 7; // 8 = Motion, 7 = Motion (location unknown)
        }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(48)) { 
       const value = this.node.getValue({
        commandClass: 48,
        property: 'Motion',
        endpoint: this.endpoint.index,
      }) ?? this.node.getValue({
        commandClass: 48,
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
