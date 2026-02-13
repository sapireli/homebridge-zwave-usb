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
    const serviceName = name || (this.endpoint.index > 0
      ? `${this.accessory.displayName} ${this.endpoint.index}`
      : this.accessory.displayName);

    if (subType) {
      const existing = this.accessory.getServiceById(serviceType, subType);
      if (existing) {
        this.configureServiceIdentity(existing, serviceName);
        return existing;
      }
    } else {
      const existing = this.accessory.getService(serviceType);
      if (existing) {
        this.configureServiceIdentity(existing, serviceName);
        return existing;
      }
    }

    const ServiceConstructor = serviceType as unknown as new (displayName: string, subtype?: string) => Service;
    const service = subType
      ? new ServiceConstructor(serviceName, subType)
      : new ServiceConstructor(serviceName);

    const addedService = this.accessory.addService(service);
    this.configureServiceIdentity(addedService, serviceName);
    return addedService;
  }

  private configureServiceIdentity(service: Service, serviceName: string): void {
    // Explicitly set Name as read-only and lock ConfiguredName to avoid user edits.
    const nameChar = service.getCharacteristic(this.platform.Characteristic.Name);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nameChar.setProps({ format: HAPFormat.STRING as any, perms: [HAPPerm.PAIRED_READ as any] })
      .updateValue(serviceName);

    if (service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      const configuredNameChar = service.getCharacteristic(this.platform.Characteristic.ConfiguredName);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configuredNameChar.setProps({ format: HAPFormat.STRING as any, perms: [HAPPerm.PAIRED_READ as any, HAPPerm.NOTIFY as any] })
        .updateValue(serviceName);
    }

    // Add Service Label Index for multi-endpoint devices to help with ordering/naming
    if (this.endpoint.index > 0) {
      if (!service.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
        service.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
      }
      service.getCharacteristic(this.platform.Characteristic.ServiceLabelIndex).updateValue(this.endpoint.index);
    }
  }
}
