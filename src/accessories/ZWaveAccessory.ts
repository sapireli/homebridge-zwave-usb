import { PlatformAccessory, Service } from 'homebridge';
import { CommandClasses, NodeStatus } from '@zwave-js/core';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { CONFIGURED_NAME_COMPAT_SERVICE_UUIDS, ZWaveFeature } from '../features/ZWaveFeature';
import { OBSOLETE_CHAR_UUIDS } from '../platform/settings';

export const ACCESSORY_CACHE_REPAIR_VERSION = 1;

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

const STATUS_TAMPERED_SUPPORTED_SERVICE_UUIDS = new Set([
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

const CONFIGURED_NAME_SUPPORTED_SERVICE_UUIDS = new Set([
  '0000003E-0000-1000-8000-0026BB765291', // AccessoryInformation
  '000000D8-0000-1000-8000-0026BB765291', // Television
  '000000D9-0000-1000-8000-0026BB765291', // InputSource
  '00000228-0000-1000-8000-0026BB765291', // SmartSpeaker
  '0000020A-0000-1000-8000-0026BB765291', // WiFiRouter
  ...CONFIGURED_NAME_COMPAT_SERVICE_UUIDS,
]);

export class ZWaveAccessory {
  public readonly platformAccessory: PlatformAccessory;
  private features: ZWaveFeature[] = [];
  private initialized = false;

  constructor(
    public readonly platform: ZWaveUsbPlatform,
    public node: IZWaveNode,
    public readonly homeId: number,
    private readonly category = 1,
  ) {
    // WARNING: This UUID generation string MUST NOT BE CHANGED!
    // This deterministic string ensures that devices maintain the same HomeKit identity across restarts.
    // This is the stable UUID generation scheme.
    const stableId = `homebridge-zwave-usb-${this.homeId}-${this.node.nodeId}`;
    const stableUuid = this.platform.api.hap.uuid.generate(stableId);

    /**
     * MIGRATION PATH: Automated Legacy UUID Adoption.
     * To prevent user automations from breaking after a plugin update that changed UUID schemes,
     * we check if the device already exists in the cache under any known legacy UUID format.
     * If found, we "adopt" that UUID instead of using the new stable one.
     */
    const legacyPatterns = [
      `homebridge-zwave-usb-v7-${this.homeId}-${this.node.nodeId}`,
      `homebridge-zwave-usb-v5-${this.homeId}-${this.node.nodeId}`,
      `homebridge-zwave-usb-v3-${this.homeId}-${this.node.nodeId}`,
      `homebridge-zwave-usb-v1-${this.homeId}-${this.node.nodeId}`,
    ];

    let uuid = stableUuid;
    for (const pattern of legacyPatterns) {
      const legacyUuid = this.platform.api.hap.uuid.generate(pattern);
      if (this.platform.accessories.find((a) => a.UUID === legacyUuid)) {
        this.platform.log.info(
          `Adopting legacy UUID for Node ${this.node.nodeId} to preserve automations: ${legacyUuid}`,
        );
        uuid = legacyUuid;
        break;
      }
    }

    const existingAccessory =
      this.platform.accessories.find((accessory) => {
        const context = accessory.context as
          | { nodeId?: number; homeId?: number }
          | undefined;
        return context?.nodeId === this.node.nodeId && context?.homeId === this.homeId;
      }) ||
      this.platform.accessories.find((accessory) => accessory.UUID === uuid);
    const nodeName = this.getDesiredName();

    if (existingAccessory) {
      this.platformAccessory = existingAccessory;
    } else {
      this.platform.log.info(`Creating new accessory for ${nodeName} (UUID: ${uuid})`);
      this.platformAccessory = new this.platform.api.platformAccessory(
        nodeName,
        uuid,
        this.category,
      );
      this.platform.api.registerPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        this.platformAccessory,
      ]);
      this.platform.accessories.push(this.platformAccessory);
    }

    let didUpdateCategory = false;
    if (this.platformAccessory.category !== this.category) {
      this.platformAccessory.category = this.category;
      didUpdateCategory = !!existingAccessory;
    }

    const context = ((this.platformAccessory.context as {
      nodeId?: number;
      homeId?: number;
      cacheRepairVersion?: number;
      metadataSignature?: string;
      graphSignature?: string;
    }) || {});
    this.platformAccessory.context = context;
    context.nodeId = this.node.nodeId;
    context.homeId = this.homeId;

    const metadataSignature = this.applyAccessoryMetadata({
      syncName: !existingAccessory || !this.platformAccessory.displayName,
    });
    context.metadataSignature = metadataSignature;

    /**
     * Helper to normalize UUIDs for reliable comparison during metadata pruning.
     */
    const normalizeUuid = (u: string) => u.replace(/-/g, '').toUpperCase();

    /**
     * METADATA REPAIR: In-Place Cache Cleaning.
     * Instead of bumping UUIDs (which is destructive), we aggressively prune obsolete
     * characteristics from existing accessories in the cache. This allows us to fix
     * permission bugs or remove ghost services while maintaining the device's identity.
     */
    let didRepairCache = false;
    if (existingAccessory && context.cacheRepairVersion !== ACCESSORY_CACHE_REPAIR_VERSION) {
      this.platformAccessory.services.forEach((service) => {
        service.characteristics.slice().forEach((found) => {
          const charUuidNorm = normalizeUuid(found.UUID);
          if (OBSOLETE_CHAR_UUIDS.some((u) => normalizeUuid(u) === charUuidNorm)) {
            this.platform.log.debug(
              `Pruning obsolete characteristic: ${found.displayName} from ${service.displayName} (Node ${this.node.nodeId})`,
            );
            service.removeCharacteristic(found);
          }
        });
      });

      this.pruneUnsupportedConfiguredName();
      this.pruneUnsupportedHealthCharacteristics();
      this.pruneUnsupportedServiceLabelIndex();
      context.cacheRepairVersion = ACCESSORY_CACHE_REPAIR_VERSION;
      didRepairCache = true;
    } else if (!existingAccessory) {
      context.cacheRepairVersion = ACCESSORY_CACHE_REPAIR_VERSION;
    }

    if (existingAccessory && (didRepairCache || didUpdateCategory)) {
      this.platform.api.updatePlatformAccessories([this.platformAccessory]);
    }
  }

  public addFeature(feature: ZWaveFeature) {
    this.features.push(feature);
  }

  public setGraphSignature(signature: string): void {
    const context = ((this.platformAccessory.context as { graphSignature?: string }) || {});
    this.platformAccessory.context = context;
    context.graphSignature = signature;
  }

  public getGraphSignature(): string | undefined {
    return (this.platformAccessory.context as { graphSignature?: string } | undefined)?.graphSignature;
  }

  /**
   * Applies a plugin-controlled rename to the default accessory metadata.
   * Normal node refreshes do not call this; it is reserved for explicit plugin renames.
   */
  public rename(newName: string): void {
    this.platform.log.info(`Syncing HomeKit name for Node ${this.node.nodeId} -> ${newName}`);
    this.platformAccessory.displayName = newName;

    const infoService = this.platformAccessory.getService(
      this.platform.Service.AccessoryInformation,
    );
    if (infoService) {
      infoService.setCharacteristic(this.platform.Characteristic.Name, newName);
    }

    for (const feature of this.features) {
      feature.rename(newName);
    }

    this.platform.api.updatePlatformAccessories([this.platformAccessory]);
  }

  /**
   * HOT-RECOVERY FIX: Update stale node references.
   * When the driver restarts (hot-plug), the IZWaveNode instance changes.
   * We must update all features with the new reference to ensure they
   * continue to work correctly.
   */
  public updateNode(newNode: IZWaveNode): void {
    this.node = newNode;
    const context = ((this.platformAccessory.context as {
      metadataSignature?: string;
    }) || {});
    const previousSignature = context.metadataSignature;
    const nextSignature = this.applyAccessoryMetadata();
    context.metadataSignature = nextSignature;
    for (const feature of this.features) {
      const endpointIndex = feature.getEndpointIndex();
      const newEndpoint = newNode.getAllEndpoints().find((e) => e.index === endpointIndex);
      if (newEndpoint) {
        feature.updateNode(newNode, newEndpoint);
      }
    }

    if (previousSignature !== nextSignature) {
      this.platform.api.updatePlatformAccessories([this.platformAccessory]);
    }
  }

  public initialize(options: { pruneUnmanagedServices?: boolean } = {}): void {
    if (this.initialized) {
      this.platform.log.debug(`Node ${this.node.nodeId} already initialized, refreshing...`);
      this.refresh();
      return;
    }

    const initializedFeatures: ZWaveFeature[] = [];
    try {
      for (const feature of this.features) {
        feature.init();
        initializedFeatures.push(feature);
      }

      if (options.pruneUnmanagedServices) {
        this.pruneUnmanagedServices();
      }

      this.ensurePrimaryService();
      this.refresh();
      this.platform.api.updatePlatformAccessories([this.platformAccessory]);
      this.initialized = true;
    } catch (error) {
      for (const feature of initializedFeatures.reverse()) {
        feature.stop();
      }
      throw error;
    }
  }

  private getDesiredName(): string {
    return this.node.name || this.node.label || this.node.deviceConfig?.label || `Node ${this.node.nodeId}`;
  }

  private getEffectiveName(): string {
    return this.platformAccessory.displayName || this.getDesiredName();
  }

  private formatFingerprintPart(value: number | undefined): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    return `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
  }

  private getFingerprint(): string | undefined {
    const manufacturerId = this.formatFingerprintPart(this.node.manufacturerId);
    const productType = this.formatFingerprintPart(this.node.productType);
    const productId = this.formatFingerprintPart(this.node.productId);

    if (!manufacturerId || !productType || !productId) {
      return undefined;
    }

    return `${manufacturerId}:${productType}:${productId}`;
  }

  private getModel(): string {
    const fingerprint = this.getFingerprint();
    const model = this.node.deviceConfig?.description || this.node.label || this.node.deviceConfig?.label;

    return model || fingerprint || `Node ${this.node.nodeId}`;
  }

  private getSerialNumber(): string {
    const cachedSerialNumber = this.getCachedDeviceSerialNumber();
    if (cachedSerialNumber) {
      return cachedSerialNumber;
    }

    const fingerprint = this.getFingerprint();
    if (fingerprint) {
      return `zwave-${fingerprint}-node-${this.node.nodeId}`;
    }

    return `node-${this.node.nodeId}`;
  }

  private getCachedDeviceSerialNumber(): string | undefined {
    if (this.node.deviceSerialNumber) {
      return this.node.deviceSerialNumber;
    }

    if (typeof this.node.getValue !== 'function') {
      return undefined;
    }

    const cachedValue = this.node.getValue({
      commandClass: CommandClasses['Manufacturer Specific'],
      endpoint: 0,
      property: 'deviceId',
      propertyKey: 'SerialNumber',
    });

    return typeof cachedValue === 'string' && cachedValue.length > 0 ? cachedValue : undefined;
  }

  private applyAccessoryMetadata(options: { syncName?: boolean } = {}): string {
    const manufacturer = this.node.manufacturer || this.node.deviceConfig?.manufacturer || 'Unknown';
    const model = this.getModel();
    const serial = this.getSerialNumber();
    const name = this.getEffectiveName();
    const firmwareRevision = this.node.firmwareVersion || '1.0.0';
    const metadataSignature = JSON.stringify({
      manufacturer,
      model,
      serial,
      firmwareRevision,
    });

    const infoService = this.platformAccessory.getService(
      this.platform.Service.AccessoryInformation,
    )!;

    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, serial)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, firmwareRevision);

    if (this.platform.Characteristic.SoftwareRevision) {
      infoService.setCharacteristic(
        this.platform.Characteristic.SoftwareRevision,
        firmwareRevision,
      );
    }

    this.ensureAccessoryInformationConfiguredName(infoService, name);

    if (options.syncName) {
      this.platformAccessory.displayName = name;
      infoService.setCharacteristic(this.platform.Characteristic.Name, name);
    }

    return metadataSignature;
  }

  private ensureAccessoryInformationConfiguredName(infoService: Service, name: string): void {
    const configuredNameType = this.platform.Characteristic.ConfiguredName;
    const configuredName = infoService.getCharacteristic(configuredNameType);

    if (configuredName.value === undefined || configuredName.value === '') {
      configuredName.updateValue(name);
    }
  }

  private pruneUnmanagedServices(): void {
    const activeServices = new Set<Service>();
    const infoService = this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!;
    activeServices.add(infoService);

    for (const feature of this.features) {
      for (const service of feature.getServices()) {
        activeServices.add(service);
      }
    }

    this.platformAccessory.services.slice().forEach((service) => {
      if (!activeServices.has(service)) {
        this.platform.log.info(
          `Removing stale service during explicit graph reconcile: ${service.displayName} (Node ${this.node.nodeId})`,
        );
        this.platformAccessory.removeService(service);
      }
    });
  }

  private pruneUnsupportedConfiguredName(): void {
    const infoService = this.platformAccessory.getService(this.platform.Service.AccessoryInformation);
    this.platformAccessory.services.forEach((service) => {
      if (service === infoService) {
        return;
      }

      if (
        service.testCharacteristic(this.platform.Characteristic.ConfiguredName) &&
        !CONFIGURED_NAME_SUPPORTED_SERVICE_UUIDS.has(service.UUID)
      ) {
        service.removeCharacteristic(
          service.getCharacteristic(this.platform.Characteristic.ConfiguredName),
        );
      }
    });
  }

  private pruneUnsupportedHealthCharacteristics(): void {
    const infoService = this.platformAccessory.getService(this.platform.Service.AccessoryInformation);
    this.platformAccessory.services.forEach((service) => {
      if (service === infoService) {
        return;
      }

      if (
        service.testCharacteristic(this.platform.Characteristic.StatusFault) &&
        !STATUS_FAULT_SUPPORTED_SERVICE_UUIDS.has(service.UUID)
      ) {
        service.removeCharacteristic(service.getCharacteristic(this.platform.Characteristic.StatusFault));
      }

      if (
        service.testCharacteristic(this.platform.Characteristic.StatusTampered) &&
        !STATUS_TAMPERED_SUPPORTED_SERVICE_UUIDS.has(service.UUID)
      ) {
        service.removeCharacteristic(
          service.getCharacteristic(this.platform.Characteristic.StatusTampered),
        );
      }
    });
  }

  private pruneUnsupportedServiceLabelIndex(): void {
    const infoService = this.platformAccessory.getService(this.platform.Service.AccessoryInformation);
    this.platformAccessory.services.forEach((service) => {
      if (service === infoService) {
        return;
      }

      if (
        service.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex) &&
        !SERVICE_LABEL_INDEX_SUPPORTED_SERVICE_UUIDS.has(service.UUID)
      ) {
        service.removeCharacteristic(
          service.getCharacteristic(this.platform.Characteristic.ServiceLabelIndex),
        );
      }
    });
  }

  private ensurePrimaryService(): void {
    const primaryService = this.features.flatMap((feature) => feature.getServices())[0];
    if (!primaryService) {
      return;
    }

    const setPrimaryService = (primaryService as Service & {
      setPrimaryService?: (isPrimary?: boolean) => void;
    }).setPrimaryService;

    if (typeof setPrimaryService === 'function') {
      setPrimaryService.call(primaryService, true);
    }
  }

  private getServiceEndpointIndex(service: Service): number {
    const subtype = (service as Service & { subtype?: string }).subtype;
    if (!subtype) {
      return 0;
    }

    const match = /^(\d+)/.exec(subtype);
    return match ? Number(match[1]) : 0;
  }

  private endpointSupportsCC(endpointIndex: number, commandClass: number): boolean {
    const endpoints =
      typeof this.node.getAllEndpoints === 'function' ? this.node.getAllEndpoints() : [];
    const endpoint = endpoints.find((candidate) => candidate.index === endpointIndex);
    if (endpoint && typeof endpoint.supportsCC === 'function') {
      return endpoint.supportsCC(commandClass);
    }

    return typeof this.node.supportsCC === 'function'
      ? this.node.supportsCC(commandClass)
      : false;
  }

  private getTamperedValue(endpointIndex: number): number {
    const NOT_TAMPERED = this.platform.Characteristic.StatusTampered?.NOT_TAMPERED ?? 0;
    const TAMPERED = this.platform.Characteristic.StatusTampered?.TAMPERED ?? 1;

    if (this.endpointSupportsCC(endpointIndex, CommandClasses['Binary Sensor'])) {
      const binaryTamper = this.node.getValue({
        commandClass: CommandClasses['Binary Sensor'],
        property: 'Tamper',
        endpoint: endpointIndex,
      });
      if (typeof binaryTamper === 'boolean') {
        return binaryTamper ? TAMPERED : NOT_TAMPERED;
      }
    }

    if (!this.endpointSupportsCC(endpointIndex, CommandClasses.Notification)) {
      return NOT_TAMPERED;
    }

    const tamperValueIds = this.node.getDefinedValueIDs().filter(
      (valueId) =>
        valueId.commandClass === CommandClasses.Notification &&
        valueId.endpoint === endpointIndex &&
        valueId.property === 'Home Security',
    );

    for (const valueId of tamperValueIds) {
      const metadata = this.node.getValueMetadata(valueId) as
        | { states?: Record<string, string> }
        | undefined;
      const states = metadata?.states ?? {};
      const tamperEntries = Object.entries(states).filter(([, label]) =>
        /tamper/i.test(label),
      );

      if (tamperEntries.length === 0) {
        continue;
      }

      const value = this.node.getValue(valueId);
      if (typeof value === 'number') {
        return tamperEntries.some(([code]) => Number(code) === value) ? TAMPERED : NOT_TAMPERED;
      }

      if (typeof value === 'boolean') {
        return value ? TAMPERED : NOT_TAMPERED;
      }
    }

    return NOT_TAMPERED;
  }

  public refresh(args?: ZWaveValueEvent): void {
    /**
     * NODE HEALTH MONITORING:
     * Map Z-Wave node status (Dead/Alive/Ready) to HomeKit StatusFault.
     * 0 = No Fault, 1 = General Fault.
     * A node is considered faulty if it is Dead OR if it has failed to become ready.
     */
    const isFaulty = !this.node.ready || this.node.status === NodeStatus.Dead;
    const faultValue = isFaulty
      ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
      : this.platform.Characteristic.StatusFault.NO_FAULT;

    this.platformAccessory.services.forEach((service) => {
      if (STATUS_FAULT_SUPPORTED_SERVICE_UUIDS.has(service.UUID)) {
        service.getCharacteristic(this.platform.Characteristic.StatusFault).updateValue(faultValue);
      }
      if (STATUS_TAMPERED_SUPPORTED_SERVICE_UUIDS.has(service.UUID)) {
        service.getCharacteristic(this.platform.Characteristic.StatusTampered).updateValue(
          this.getTamperedValue(this.getServiceEndpointIndex(service)),
        );
      }
    });

    /**
     * INTERVIEW & DEAD NODE GUARD: Only refresh features if the node is ready and alive.
     * This prevents features from trying to read incomplete metadata or stale cache data
     * during the initial Z-Wave interview process or when the device goes offline.
     */
    if (isFaulty) {
      return;
    }

    for (const feature of this.features) {
      /**
       * PERFORMANCE FIX: Granular Event Routing.
       * If this is a specific value update (args is defined), only notify features
       * that belong to the matching endpoint. This avoids redundant CC/Endpoint
       * checks across the entire feature tree on every message.
       */
      if (args && args.endpoint !== undefined && args.endpoint !== feature.getEndpointIndex()) {
        continue;
      }
      feature.update(args);
    }
  }

  public stop(): void {
    for (const feature of this.features) {
      feature.stop();
    }
  }

  public isInitialized(): boolean {
    return this.initialized;
  }
}
