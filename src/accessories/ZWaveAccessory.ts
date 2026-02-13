import { PlatformAccessory } from 'homebridge';
import { IZWaveNode } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { ZWaveFeature } from '../features/ZWaveFeature';

export class ZWaveAccessory {
  public readonly platformAccessory: PlatformAccessory;
  private features: ZWaveFeature[] = [];
  private initialized = false;

  constructor(
    public readonly platform: ZWaveUsbPlatform,
    public readonly node: IZWaveNode,
    public readonly homeId: number,
  ) {
    const uuid = this.platform.api.hap.uuid.generate(
      `homebridge-zwave-usb-${this.homeId}-${this.node.nodeId}`,
    );
    const existingAccessory = this.platform.accessories.find(
      (accessory) => accessory.UUID === uuid,
    );

    if (existingAccessory) {
      this.platformAccessory = existingAccessory;
    } else {
      const accessoryName = `Node ${this.node.nodeId}`;
      this.platform.log.info(`Creating new accessory for ${accessoryName}`);
      this.platformAccessory = new this.platform.api.platformAccessory(
        accessoryName,
        uuid,
      );
      this.platform.api.registerPlatformAccessories(
        'homebridge-zwave-usb',
        'ZWaveUSB',
        [this.platformAccessory],
      );
      this.platform.accessories.push(this.platformAccessory);
    }

    // Set accessory information
    const manufacturer = this.node.deviceConfig?.manufacturer || 'Unknown';
    const model = this.node.deviceConfig?.label || `Node ${this.node.nodeId}`;
    
    this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `Node ${this.node.nodeId}`);
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
  
  public refresh(): void {
    for (const feature of this.features) {
      feature.update();
    }
  }
}
