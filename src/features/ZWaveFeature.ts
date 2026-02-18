import { PlatformAccessory, Service, WithUUID } from 'homebridge';
import { Endpoint } from 'zwave-js';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { HAPFormat, HAPPerm } from '../platform/settings';

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
      if (service.testCharacteristic(this.platform.Characteristic.Name)) {
        service.updateCharacteristic(this.platform.Characteristic.Name, serviceName);
      }
      if (service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
        service.updateCharacteristic(this.platform.Characteristic.ConfiguredName, serviceName);
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

    // Mark the first functional service as primary to help HomeKit with naming/tiles
    if (this.managedServices.length === 0) {
      service.setPrimaryService(true);
    }

    // Explicitly set the name characteristic to ensure it's displayed correctly
    service.updateCharacteristic(this.platform.Characteristic.Name, serviceName);

    // Also set ConfiguredName which many HomeKit versions prioritize for plugin-side renaming
    if (!service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    }
    service.updateCharacteristic(this.platform.Characteristic.ConfiguredName, serviceName);

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
