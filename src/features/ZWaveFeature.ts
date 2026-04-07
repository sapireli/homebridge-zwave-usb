import { PlatformAccessory, Service, WithUUID } from 'homebridge';
import { Endpoint } from 'zwave-js';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';

const STATUS_FAULT_SUPPORTED_SERVICE_UUIDS = new Set([
  '0000008D-0000-1000-8000-0026BB765291', // AirQualitySensor
  '0000007F-0000-1000-8000-0026BB765291', // CarbonMonoxideSensor
  '00000080-0000-1000-8000-0026BB765291', // ContactSensor
  '00000082-0000-1000-8000-0026BB765291', // HumiditySensor
  '00000083-0000-1000-8000-0026BB765291', // LeakSensor
  '00000084-0000-1000-8000-0026BB765291', // LightSensor
  '00000085-0000-1000-8000-0026BB765291', // MotionSensor
  '00000087-0000-1000-8000-0026BB765291', // SmokeSensor
  '0000008A-0000-1000-8000-0026BB765291', // TemperatureSensor
]);

const SERVICE_LABEL_INDEX_SUPPORTED_SERVICE_UUIDS = new Set([
  '00000089-0000-1000-8000-0026BB765291', // StatelessProgrammableSwitch
  '000000D0-0000-1000-8000-0026BB765291', // Valve
]);

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
        nameChar.updateValue(serviceName);
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

    let service: Service | undefined;
    let wasCreated = false;
    if (subType) {
      service =
        this.accessory.getServiceById(serviceType, subType);
      if (!service) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service = this.accessory.addService(new (serviceType as any)(serviceName, subType));
        wasCreated = true;
      }
    } else {
      service =
        this.accessory.getService(serviceType);
      if (!service) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service = this.accessory.addService(new (serviceType as any)(serviceName));
        wasCreated = true;
      }
    }

    // Sync internal property
    service.displayName = serviceName;

    // Seed the service Name only when the service is first created.
    if (wasCreated && service.testCharacteristic(this.platform.Characteristic.Name)) {
      const nameChar = service.getCharacteristic(this.platform.Characteristic.Name);
      nameChar.updateValue(serviceName);
    }

    if (
      this.endpoint.index > 0 &&
      SERVICE_LABEL_INDEX_SUPPORTED_SERVICE_UUIDS.has(service.UUID)
    ) {
      if (!service.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
        service.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
      }
      service
        .getCharacteristic(this.platform.Characteristic.ServiceLabelIndex)
        .updateValue(this.endpoint.index);
    }

    if (
      !service.testCharacteristic(this.platform.Characteristic.StatusFault) &&
      STATUS_FAULT_SUPPORTED_SERVICE_UUIDS.has(service.UUID)
    ) {
      service.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
    }

    if (!this.managedServices.includes(service)) {
      this.managedServices.push(service);
    }

    return service;
  }
}
