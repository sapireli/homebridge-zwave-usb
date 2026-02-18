import { PlatformAccessory, Service, WithUUID } from 'homebridge';
import { Endpoint } from 'zwave-js';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { HAPPerm } from '../platform/settings';

export interface ZWaveFeature {
  init(): void;
  update(args?: ZWaveValueEvent): void;
  getServices(): Service[];
  getEndpointIndex(): number;
  stop(): void;
  updateNode(node: IZWaveNode, endpoint: Endpoint): void;
  rename(newName: string): void;
}

export abstract class BaseFeature implements ZWaveFeature {
  protected managedServices: Service[] = [];

  constructor(
    protected readonly platform: ZWaveUsbPlatform,
    protected readonly accessory: PlatformAccessory,
    protected endpoint: Endpoint,
    protected node: IZWaveNode,
  ) {}

  abstract init(): void;
  abstract update(args?: ZWaveValueEvent): void;

  public stop(): void {
    // Optional cleanup in subclasses
  }

  public updateNode(node: IZWaveNode, endpoint: Endpoint): void {
    this.node = node;
    this.endpoint = endpoint;
  }

  /**
   * Dynamically updates the Name characteristic of all managed services.
   */
  public rename(newName: string): void {
    const serviceName =
      this.endpoint.index > 0 ? `${newName} ${this.endpoint.index}` : newName;

    this.platform.log.debug(`Feature Rename [Node ${this.node.nodeId}]: Updating ${this.managedServices.length} services to "${serviceName}"`);

    for (const service of this.managedServices) {
      // Sync internal property
      service.displayName = serviceName;

      if (service.testCharacteristic(this.platform.Characteristic.Name)) {
        const nameChar = service.getCharacteristic(this.platform.Characteristic.Name);
        nameChar.setProps({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          perms: [HAPPerm.PAIRED_READ as any, HAPPerm.NOTIFY as any],
        });
        nameChar.updateValue(serviceName);
      }

      if (service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
        const configuredNameChar = service.getCharacteristic(this.platform.Characteristic.ConfiguredName);
        configuredNameChar.setProps({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          perms: [HAPPerm.PAIRED_READ as any, HAPPerm.PAIRED_WRITE as any, HAPPerm.NOTIFY as any],
        });
        configuredNameChar.updateValue(serviceName);
      }
    }
  }

  public getServices(): Service[] {
    return this.managedServices;
  }

  public getEndpointIndex(): number {
    return this.endpoint.index;
  }

  /**
   * High-Performance Filter: determines if a specific Z-Wave value change is relevant
   * to this feature. If 'args' is undefined, it's a full refresh (e.g. startup).
   * Otherwise, we only proceed if the Command Class and Endpoint match this feature.
   */
  protected shouldUpdate(
    args: ZWaveValueEvent | undefined,
    cc: number,
    property?: string | number,
  ): boolean {
    if (!args) {
      return true;
    } // Force refresh (no args provided)
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
    const serviceName =
      name ||
      (this.endpoint.index > 0
        ? `${this.accessory.displayName} ${this.endpoint.index}`
        : this.accessory.displayName);

    let service: Service;
    if (subType) {
      service =
        this.accessory.getServiceById(serviceType, subType) ||
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.accessory.addService(new (serviceType as any)(serviceName, subType));
    } else {
      service =
        this.accessory.getService(serviceType) ||
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.accessory.addService(new (serviceType as any)(serviceName));
    }

    // Sync internal property
    service.displayName = serviceName;

    // 1. Standard Name: Notify enabled
    if (service.testCharacteristic(this.platform.Characteristic.Name)) {
      const nameChar = service.getCharacteristic(this.platform.Characteristic.Name);
      nameChar.setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any, HAPPerm.NOTIFY as any],
      });
      nameChar.updateValue(serviceName);
    }

    // 2. ConfiguredName: Read/Write/Notify (Critical for Settings/Renaming support)
    if (!service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    }
    const configuredNameChar = service.getCharacteristic(this.platform.Characteristic.ConfiguredName);
    configuredNameChar.setProps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      perms: [HAPPerm.PAIRED_READ as any, HAPPerm.PAIRED_WRITE as any, HAPPerm.NOTIFY as any],
    });
    configuredNameChar.updateValue(serviceName);

    // Add Service Label Index for multi-endpoint devices to help with ordering/naming
    if (this.endpoint.index > 0) {
      if (!service.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
        service.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
      }
      service
        .getCharacteristic(this.platform.Characteristic.ServiceLabelIndex)
        .updateValue(this.endpoint.index);
    }

    /**
     * HEALTH MONITORING FIX: Add StatusFault to functional services where appropriate.
     * We skip this for 'StatelessProgrammableSwitch' (Buttons) as it's not standard there.
     */
    const skipUUID = '00000089-0000-1000-8000-0026BB765291'; // StatelessProgrammableSwitch
    if (
      !service.testCharacteristic(this.platform.Characteristic.StatusFault) &&
      service.UUID !== skipUUID
    ) {
      service.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
    }

    if (!this.managedServices.includes(service)) {
      this.managedServices.push(service);
    }

    return service;
  }
}
