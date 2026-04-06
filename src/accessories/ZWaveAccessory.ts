import { PlatformAccessory, Service } from 'homebridge';
import { NodeStatus } from '@zwave-js/core';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { ZWaveFeature } from '../features/ZWaveFeature';
import { OBSOLETE_CHAR_UUIDS } from '../platform/settings';

export class ZWaveAccessory {
  public readonly platformAccessory: PlatformAccessory;
  private features: ZWaveFeature[] = [];
  private initialized = false;

  constructor(
    public readonly platform: ZWaveUsbPlatform,
    public node: IZWaveNode,
    public readonly homeId: number,
    private readonly options: { forceUuidSeed?: string } = {},
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
          | { nodeId?: number; homeId?: number; renameGeneration?: string }
          | undefined;
        return context?.nodeId === this.node.nodeId && context?.homeId === this.homeId;
      }) ||
      this.platform.accessories.find((accessory) => accessory.UUID === uuid);
    const nodeName = this.node.name || this.node.deviceConfig?.label || `Node ${this.node.nodeId}`;
    const forceUuidSeed = this.options.forceUuidSeed?.trim();

    if (existingAccessory) {
      this.platformAccessory = existingAccessory;
    } else {
      const creationUuid = forceUuidSeed
        ? this.platform.api.hap.uuid.generate(`${stableId}-rename-${forceUuidSeed}`)
        : uuid;
      this.platform.log.info(`Creating new accessory for ${nodeName} (UUID: ${uuid})`);
      this.platformAccessory = new this.platform.api.platformAccessory(nodeName, creationUuid);
      this.platform.api.registerPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        this.platformAccessory,
      ]);
      this.platform.accessories.push(this.platformAccessory);
    }

    // Set accessory information (Hardware Fingerprint - Must be stable)
    const manufacturer = this.node.deviceConfig?.manufacturer || 'Unknown';
    const model = this.node.deviceConfig?.label || `Node ${this.node.nodeId}`;
    const serial = `Node ${this.node.nodeId}`;

    const infoService = this.platformAccessory.getService(
      this.platform.Service.AccessoryInformation,
    )!;

    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, serial)
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        this.node.firmwareVersion || '1.0.0',
      );

    if (!existingAccessory) {
      // Seed the initial HomeKit-facing name once for freshly created accessories.
      this.platformAccessory.displayName = nodeName;
      infoService.setCharacteristic(this.platform.Characteristic.Name, nodeName);
    }

    const context = ((this.platformAccessory.context as {
      nodeId?: number;
      homeId?: number;
      renameGeneration?: string;
    }) || {});
    this.platformAccessory.context = context;
    context.nodeId = this.node.nodeId;
    context.homeId = this.homeId;
    if (forceUuidSeed) {
      context.renameGeneration = forceUuidSeed;
    }

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
  }

  public addFeature(feature: ZWaveFeature) {
    this.features.push(feature);
  }

  /**
   * Applies a plugin-controlled rename to the default accessory metadata.
   * This is intentionally conservative and is only used for explicit recreate flows.
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
  }

  /**
   * HOT-RECOVERY FIX: Update stale node references.
   * When the driver restarts (hot-plug), the IZWaveNode instance changes.
   * We must update all features with the new reference to ensure they
   * continue to work correctly.
   */
  public updateNode(newNode: IZWaveNode): void {
    this.node = newNode;
    for (const feature of this.features) {
      const endpointIndex = feature.getEndpointIndex();
      const newEndpoint = newNode.getAllEndpoints().find((e) => e.index === endpointIndex);
      if (newEndpoint) {
        feature.updateNode(newNode, newEndpoint);
      }
    }
  }

  public initialize(): void {
    if (this.initialized) {
      this.platform.log.debug(`Node ${this.node.nodeId} already initialized, refreshing...`);
      this.refresh();
      return;
    }
    this.initialized = true;

    // Initialize all features
    for (const feature of this.features) {
      feature.init();
    }

    /**
     * GHOST SERVICE PRUNING:
     * We keep only the services that were explicitly created/managed by the added features.
     * This prevents redundant or broken services from lingering in the cache if the device
     * configuration or CC support changes.
     */
    const activeServices = new Set<Service>();
    activeServices.add(
      this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!,
    );
    for (const feature of this.features) {
      for (const service of feature.getServices()) {
        activeServices.add(service);
      }
    }

    this.platformAccessory.services.slice().forEach((service) => {
      if (!activeServices.has(service)) {
        this.platform.log.info(
          `Pruning ghost service from cache: ${service.displayName} (Node ${this.node.nodeId})`,
        );
        this.platformAccessory.removeService(service);
      }
    });

    this.seedConfiguredNameOnPrimaryService();
    this.platform.api.updatePlatformAccessories([this.platformAccessory]);

    this.refresh();
  }

  private seedConfiguredNameOnPrimaryService(): void {
    const primaryService = this.features.flatMap((feature) => feature.getServices())[0];
    if (!primaryService) {
      return;
    }

    if (typeof (primaryService as { setPrimaryService?: (isPrimary?: boolean) => void }).setPrimaryService === 'function') {
      (primaryService as { setPrimaryService: (isPrimary?: boolean) => void }).setPrimaryService(true);
    }

    if (!primaryService.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      primaryService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    }

    const configuredName = primaryService.getCharacteristic(this.platform.Characteristic.ConfiguredName);
    if (!configuredName.value) {
      configuredName.updateValue(primaryService.displayName || this.platformAccessory.displayName);
    }
  }

  public refresh(args?: ZWaveValueEvent): void {
    /**
     * NODE HEALTH MONITORING:
     * Map Z-Wave node status (Dead/Alive/Ready) to HomeKit StatusFault and StatusActive.
     * 0 = No Fault, 1 = General Fault.
     * A node is considered faulty if it is Dead OR if it has failed to become ready.
     */
    const isFaulty = !this.node.ready || this.node.status === NodeStatus.Dead;
    const faultValue = isFaulty
      ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
      : this.platform.Characteristic.StatusFault.NO_FAULT;
    const activeValue = !isFaulty;

    /**
     * GLOBAL TAMPER MONITORING:
     * Map Z-Wave tamper alarms (from Home Security) to HomeKit StatusTampered.
     */
    const NOT_TAMPERED = this.platform.Characteristic.StatusTampered?.NOT_TAMPERED ?? 0;
    const TAMPERED = this.platform.Characteristic.StatusTampered?.TAMPERED ?? 1;
    let tamperedVal = NOT_TAMPERED;
    
    // Fallback: If not ready, skip checking specific CC values to avoid cache errors.
    if (!isFaulty && this.node.supportsCC?.(CommandClasses.Notification)) {
      const tamperCover = this.node.getValue({
        commandClass: CommandClasses.Notification,
        property: 'Home Security',
        propertyKey: 'Tampering, product covering removed',
      });
      const tamperCode = this.node.getValue({
        commandClass: CommandClasses.Notification,
        property: 'Home Security',
        propertyKey: 'Tampering, Invalid Code',
      });

      if (tamperCover === 3 || tamperCode === 4) {
        tamperedVal = TAMPERED;
      }
    }

    this.platformAccessory.services.forEach((service) => {
      if (service.testCharacteristic(this.platform.Characteristic.StatusFault)) {
        service.updateCharacteristic(this.platform.Characteristic.StatusFault, faultValue);
      }
      if (service.testCharacteristic(this.platform.Characteristic.StatusActive)) {
        service.updateCharacteristic(this.platform.Characteristic.StatusActive, activeValue);
      }
      if (service.testCharacteristic(this.platform.Characteristic.StatusTampered)) {
        service.updateCharacteristic(this.platform.Characteristic.StatusTampered, tamperedVal);
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
}
