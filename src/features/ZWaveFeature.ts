import { PlatformAccessory, Service, WithUUID } from 'homebridge';
import { Endpoint } from 'zwave-js';
import { IZWaveNode } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';

export interface ZWaveFeature {
  init(): void;
  update(): void;
}

export abstract class BaseFeature implements ZWaveFeature {
  constructor(
    protected readonly platform: ZWaveUsbPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly endpoint: Endpoint,
  ) {}

  protected get node(): IZWaveNode {
    return (this.endpoint as unknown as { node: IZWaveNode }).node || (this.endpoint as unknown as IZWaveNode);
  }

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
    return this.accessory.addService(service);
  }
}
