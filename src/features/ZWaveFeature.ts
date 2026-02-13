import { PlatformAccessory, Service, WithUUID } from 'homebridge';
import { Endpoint } from 'zwave-js';
import { IZWaveNode } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { HAPFormat, HAPPerm } from '../platform/settings';

export interface ZWaveFeature {
  init(): void;
  update(): void;
}

export abstract class BaseFeature implements ZWaveFeature {
  constructor(
    protected readonly platform: ZWaveUsbPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly endpoint: Endpoint,
    protected readonly node: IZWaveNode,
  ) {}

  abstract init(): void;
  abstract update(): void;

  protected getService(serviceType: WithUUID<typeof Service>, name?: string, subType?: string): Service {
    if (subType) {
      const existing = this.accessory.getServiceById(serviceType, subType);
      if (existing) {
        return existing;
      }
    } else {
      const existing = this.accessory.getService(serviceType);
      if (existing) {
        return existing;
      }
    }

    const serviceName = name || (this.endpoint.index > 0 
      ? `${this.accessory.displayName} ${this.endpoint.index}` 
      : this.accessory.displayName);
    const ServiceConstructor = serviceType as unknown as new (displayName: string, subtype?: string) => Service;
    const service = subType 
      ? new ServiceConstructor(serviceName, subType) 
      : new ServiceConstructor(serviceName);
    
    const addedService = this.accessory.addService(service);
    
    // Explicitly set the name and configured name characteristics to ensure it's displayed correctly
    addedService.getCharacteristic(this.platform.Characteristic.Name)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ format: HAPFormat.STRING as any, perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue(serviceName);
    
    if (!addedService.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
        addedService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    }
    addedService.getCharacteristic(this.platform.Characteristic.ConfiguredName)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ format: HAPFormat.STRING as any, perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue(serviceName);

    // Add Service Label Index for multi-endpoint devices
    if (this.endpoint.index > 0) {
        if (!addedService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
            addedService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
        }
        addedService.getCharacteristic(this.platform.Characteristic.ServiceLabelIndex).updateValue(this.endpoint.index);
    }
    
    return addedService;
  }
}
