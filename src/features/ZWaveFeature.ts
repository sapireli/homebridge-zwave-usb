import { PlatformAccessory, Service, WithUUID } from 'homebridge';
import { Endpoint } from 'zwave-js';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';

export const CONFIGURED_NAME_COMPAT_SERVICE_UUIDS = new Set([
  '0000008D-0000-1000-8000-0026BB765291', // AirQualitySensor
  '00000097-0000-1000-8000-0026BB765291', // CarbonDioxideSensor
  '0000007F-0000-1000-8000-0026BB765291', // CarbonMonoxideSensor
  '00000080-0000-1000-8000-0026BB765291', // ContactSensor
  '00000040-0000-1000-8000-0026BB765291', // Fan
  '00000041-0000-1000-8000-0026BB765291', // GarageDoorOpener
  '00000082-0000-1000-8000-0026BB765291', // HumiditySensor
  '00000083-0000-1000-8000-0026BB765291', // LeakSensor
  '00000043-0000-1000-8000-0026BB765291', // Lightbulb
  '00000084-0000-1000-8000-0026BB765291', // LightSensor
  '00000045-0000-1000-8000-0026BB765291', // LockMechanism
  '00000085-0000-1000-8000-0026BB765291', // MotionSensor
  '00000087-0000-1000-8000-0026BB765291', // SmokeSensor
  '00000089-0000-1000-8000-0026BB765291', // StatelessProgrammableSwitch
  '00000049-0000-1000-8000-0026BB765291', // Switch
  '0000008A-0000-1000-8000-0026BB765291', // TemperatureSensor
  '0000004A-0000-1000-8000-0026BB765291', // Thermostat
  '0000008C-0000-1000-8000-0026BB765291', // WindowCovering
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

      if (service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
        const configuredNameChar = service.getCharacteristic(
          this.platform.Characteristic.ConfiguredName,
        );
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

  protected supportsCC(commandClass: number): boolean {
    if (typeof this.endpoint.supportsCC === 'function') {
      return this.endpoint.supportsCC(commandClass);
    }

    return typeof this.node.supportsCC === 'function'
      ? this.node.supportsCC(commandClass)
      : false;
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
    const serviceConstructor = serviceType as unknown as new (
      displayName?: string,
      subtype?: string,
    ) => Service;
    const normalizedSubType = subType && subType !== '0' ? subType : undefined;
    const serviceName =
      name ||
      (this.endpoint.index > 0
        ? `${this.accessory.displayName} ${this.endpoint.index}`
        : this.accessory.displayName);

    let service: Service | undefined;
    let wasCreated = false;
    if (normalizedSubType) {
      service =
        this.accessory.getServiceById(serviceType, normalizedSubType);
      if (!service) {
        service = this.accessory.addService(
          new serviceConstructor(serviceName, normalizedSubType),
        );
        wasCreated = true;
      }
    } else {
      service =
        this.accessory.getService(serviceType);
      if (!service) {
        service = this.accessory.addService(new serviceConstructor(serviceName));
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

    this.ensureConfiguredNameCompatibility(service, serviceName);

    if (
      this.endpoint.index > 0 &&
      SERVICE_LABEL_INDEX_SUPPORTED_SERVICE_UUIDS.has(service.UUID)
    ) {
      service
        .getCharacteristic(this.platform.Characteristic.ServiceLabelIndex)
        .updateValue(this.endpoint.index);
    }

    if (!this.managedServices.includes(service)) {
      this.managedServices.push(service);
    }

    return service;
  }

  private ensureConfiguredNameCompatibility(service: Service, serviceName: string): void {
    if (!CONFIGURED_NAME_COMPAT_SERVICE_UUIDS.has(service.UUID)) {
      return;
    }

    if (!service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      if (typeof service.addCharacteristic !== 'function') {
        return;
      }
      service.addCharacteristic(this.platform.Characteristic.ConfiguredName);
    }

    const configuredNameChar = service.getCharacteristic(
      this.platform.Characteristic.ConfiguredName,
    );

    if (configuredNameChar.value === undefined || configuredNameChar.value === '') {
      configuredNameChar.updateValue(serviceName);
    }
  }
}
