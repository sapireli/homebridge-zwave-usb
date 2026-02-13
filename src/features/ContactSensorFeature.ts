import { Service } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class ContactSensorFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.ContactSensor, undefined, subType);
    this.service
      .getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.handleGetContactSensorState.bind(this));
  }

  update(): void {
    const value = this.getSensorValue();
    this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, value);
  }

  private getSensorValue(): number {
    // 1. Check Notification CC (Access Control / Home Security)
    if (this.node.supportsCC(113)) {
        const val = this.node.getValue({
            commandClass: 113,
            property: 'Access Control',
            propertyKey: 'Door status',
            endpoint: this.endpoint.index,
        }) ?? this.node.getValue({
            commandClass: 113,
            property: 'Access Control',
            propertyKey: 'Sensor status',
            endpoint: this.endpoint.index,
        }) ?? this.node.getValue({
            commandClass: 113,
            property: 'Home Security',
            propertyKey: 'Sensor status',
            endpoint: this.endpoint.index,
        });

        if (typeof val === 'number') {
            if (val === 22) return this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED; // Open
            if (val === 23 || val === 0) return this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED; // Closed / Idle
        }
    }

    // 2. Fallback to Binary Sensor
    if (this.node.supportsCC(48)) { 
       const value = this.node.getValue({
        commandClass: 48,
        property: 'Door/Window',
        endpoint: this.endpoint.index,
      }) ?? this.node.getValue({
        commandClass: 48,
        property: 'Any', 
        endpoint: this.endpoint.index,
      });
      return value ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
    }
    
    return this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  private handleGetContactSensorState(): number {
    return this.getSensorValue();
  }
}
