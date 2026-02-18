import { PlatformAccessory, Service } from 'homebridge';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { ZWaveFeature } from '../features/ZWaveFeature';
import { OBSOLETE_CHAR_UUIDS, HAPFormat, HAPPerm } from '../platform/settings';

export class ZWaveAccessory {
  public readonly platformAccessory: PlatformAccessory;
  private features: ZWaveFeature[] = [];
  private initialized = false;

  constructor(
    public readonly platform: ZWaveUsbPlatform,
    public node: IZWaveNode,
    public readonly homeId: number,
  ) {
    // WARNING: This UUID generation string MUST NOT BE CHANGED!
    // This deterministic string ensures that devices maintain the same HomeKit identity across restarts.
    // This is the stable UUID generation scheme.
    const stableUuid = this.platform.api.hap.uuid.generate(
      `homebridge-zwave-usb-${this.homeId}-${this.node.nodeId}`,
    );

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

    const existingAccessory = this.platform.accessories.find((accessory) => accessory.UUID === uuid);
    const nodeName = this.node.name || this.node.deviceConfig?.label || `Node ${this.node.nodeId}`;

    if (existingAccessory) {
      this.platformAccessory = existingAccessory;
    } else {
      this.platform.log.info(`Creating new accessory for ${nodeName} (UUID: ${uuid})`);
      this.platformAccessory = new this.platform.api.platformAccessory(nodeName, uuid);
      this.platform.api.registerPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        this.platformAccessory,
      ]);
      this.platform.accessories.push(this.platformAccessory);
    }

    // Set accessory information
    const manufacturer = this.node.deviceConfig?.manufacturer || 'Unknown';
    const model = this.node.deviceConfig?.label || nodeName;

    const infoService = this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `Node ${this.node.nodeId}`);

    if (!infoService.testCharacteristic(this.platform.Characteristic.Name)) {
      infoService.addOptionalCharacteristic(this.platform.Characteristic.Name);
    }
    infoService.updateCharacteristic(this.platform.Characteristic.Name, nodeName);

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
   * Syncs the HomeKit name and service names when the node is renamed.
   */
  public rename(newName: string): void {
    this.platform.log.info(`Syncing HomeKit name for Node ${this.node.nodeId} -> ${newName}`);
    this.platformAccessory.displayName = newName;

    // Update the Accessory Information Service (Most Authoritative)
    const infoService = this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!;
    if (!infoService.testCharacteristic(this.platform.Characteristic.Name)) {
      infoService.addOptionalCharacteristic(this.platform.Characteristic.Name);
    }
    infoService.updateCharacteristic(this.platform.Characteristic.Name, newName);

    // Force metadata invalidation by updating the revision
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const version = require('../../package.json').version;
    infoService.updateCharacteristic(this.platform.Characteristic.SoftwareRevision, version);

    // Update the Model and Serial if they were using the generic name
    const model = this.node.deviceConfig?.label || newName;
    infoService.setCharacteristic(this.platform.Characteristic.Model, model);

    // Update all features
    for (const feature of this.features) {
      feature.rename(newName);
    }

    // Notify Homebridge of changes
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
    activeServices.add(this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!);
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

    this.refresh();
  }

  public refresh(args?: ZWaveValueEvent): void {
    /**
     * INTERVIEW GUARD: Only refresh if the node is ready.
     * This prevents features from trying to read incomplete metadata or values
     * during the initial Z-Wave interview process.
     *
     * DEAD NODE GUARD: If the node is marked Dead (4), we stop refreshing features
     * to prevent stale cache data from masquerading as a valid state.
     * The StatusFault characteristic will still report the failure.
     */
    if (!this.node.ready || this.node.status === 4) {
      return;
    }

    /**
     * NODE HEALTH MONITORING:
     * Map Z-Wave node status (Dead/Alive) to HomeKit StatusFault.
     * 0 = No Fault, 1 = General Fault (Dead).
     */
    const isDead = this.node.status === 4; // 4 = Dead
    const faultValue = isDead
      ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
      : this.platform.Characteristic.StatusFault.NO_FAULT;

    this.platformAccessory.services.forEach((service) => {
      if (service.testCharacteristic(this.platform.Characteristic.StatusFault)) {
        service.updateCharacteristic(this.platform.Characteristic.StatusFault, faultValue);
      }
    });

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
