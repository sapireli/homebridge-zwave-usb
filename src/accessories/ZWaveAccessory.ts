import { PlatformAccessory } from 'homebridge';
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
    public readonly node: IZWaveNode,
    public readonly homeId: number,
  ) {
    // WARNING: This UUID generation string MUST NOT BE CHANGED!
    const stableUuid = this.platform.api.hap.uuid.generate(
      `homebridge-zwave-usb-${this.homeId}-${this.node.nodeId}`,
    );

    // MIGRATION PATH: Check for legacy UUIDs in cache before falling back to stable
    // Historical patterns from changelog: v7, v5, v3...
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

    if (existingAccessory) {
      this.platformAccessory = existingAccessory;
    } else {
      const accessoryName = `Node ${this.node.nodeId}`;
      this.platform.log.info(`Creating new accessory for ${accessoryName} (UUID: ${uuid})`);
      this.platformAccessory = new this.platform.api.platformAccessory(accessoryName, uuid);
      this.platform.api.registerPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        this.platformAccessory,
      ]);
      this.platform.accessories.push(this.platformAccessory);
    }

    // Set accessory information
    const manufacturer = this.node.deviceConfig?.manufacturer || 'Unknown';
    const model = this.node.deviceConfig?.label || `Node ${this.node.nodeId}`;

    this.platformAccessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `Node ${this.node.nodeId}`);

    // METADATA REPAIR: Prune obsolete characteristics from all services
    this.platformAccessory.services.forEach((service) => {
      OBSOLETE_CHAR_UUIDS.forEach((charUuid) => {
        const found = service.characteristics.find(
          (c) => c.UUID.toUpperCase() === charUuid.toUpperCase(),
        );
        if (found) {
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

  public initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Initialize all features
    for (const feature of this.features) {
      feature.init();
    }
    this.refresh();
  }

  public refresh(args?: ZWaveValueEvent): void {
    for (const feature of this.features) {
      feature.update(args);
    }
  }
}
