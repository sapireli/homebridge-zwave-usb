import { PlatformAccessory, Service, WithUUID } from 'homebridge';
import { Endpoint } from 'zwave-js';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { HAPFormat, HAPPerm } from '../platform/settings';

export interface ZWaveFeature {
  init(): void;
  update(args?: ZWaveValueEvent): void;
}

export abstract class BaseFeature implements ZWaveFeature {
  constructor(
    protected readonly platform: ZWaveUsbPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly endpoint: Endpoint,
    protected readonly node: IZWaveNode,
  ) {}

  abstract init(): void;
  abstract update(args?: ZWaveValueEvent): void;

  protected shouldUpdate(
    args: ZWaveValueEvent | undefined,
    cc: number,
    property?: string | number,
  ): boolean {
    if (!args) {
      return true;
    } // Force refresh
    const endpoint = args.endpoint || 0;
    if (endpoint !== this.endpoint.index) {
      return false;
    }
    if (args.commandClass !== cc) {
      return false;
    }
    if (property !== undefined && args.property !== property) {
      return false;
    }
    return true;
  }

  protected getService(
    serviceType: WithUUID<typeof Service>,
    name?: string,
    subType?: string,
  ): Service {
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

    const serviceName =
      name ||
      (this.endpoint.index > 0
        ? `${this.accessory.displayName} ${this.endpoint.index}`
        : this.accessory.displayName);
    const ServiceConstructor = serviceType as unknown as new (
      displayName: string,
      subtype?: string,
    ) => Service;
    const service = subType
      ? new ServiceConstructor(serviceName, subType)
      : new ServiceConstructor(serviceName);

    const addedService = this.accessory.addService(service);
    // Explicitly set the name characteristic to ensure it's displayed correctly
    const nameChar = addedService.getCharacteristic(this.platform.Characteristic.Name);
    nameChar
      .setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: HAPFormat.STRING as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any],
      })
      .updateValue(serviceName);

    // Add Service Label Index for multi-endpoint devices to help with ordering/naming
    if (this.endpoint.index > 0) {
      if (!addedService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
        addedService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
      }
      addedService
        .getCharacteristic(this.platform.Characteristic.ServiceLabelIndex)
        .updateValue(this.endpoint.index);
    }

    return addedService;
  }
}
