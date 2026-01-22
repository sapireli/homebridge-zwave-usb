import { PlatformAccessory, Service, CharacteristicGetCallback } from 'homebridge';
import { IZWaveNode } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { ZWaveFeature } from '../features/ZWaveFeature';

export class ZWaveAccessory {
  public readonly platformAccessory: PlatformAccessory;
  private features: ZWaveFeature[] = [];
  protected batteryService: Service | undefined;
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

    // Battery Service (Native support)
    if (this.node.supportsCC(128)) { // Battery CC
      this.batteryService =
        this.platformAccessory.getService(this.platform.Service.Battery) ||
        this.platformAccessory.addService(this.platform.Service.Battery);

      this.batteryService
        .getCharacteristic(this.platform.Characteristic.BatteryLevel)
        .on('get', this.handleGetBatteryLevel.bind(this));

      this.batteryService
        .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
        .on('get', this.handleGetStatusLowBattery.bind(this));
    }
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
    this.updateBattery();
    for (const feature of this.features) {
      feature.update();
    }
  }

  protected updateBattery(): void {
    if (!this.batteryService || !this.node.supportsCC(128)) {
      return;
    }

    const value = this.node.getValue({
      commandClass: 128,
      property: 'level',
    });

    if (typeof value === 'number') {
      this.batteryService.updateCharacteristic(
        this.platform.Characteristic.BatteryLevel,
        value,
      );
      this.batteryService.updateCharacteristic(
        this.platform.Characteristic.StatusLowBattery,
        value <= 20
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    }
  }

  private async handleGetBatteryLevel(callback: CharacteristicGetCallback) {
    if (!this.node.supportsCC(128)) {
      callback(null, 100);
      return;
    }
    const value = this.node.getValue({
      commandClass: 128,
      property: 'level',
    });
    callback(null, (value as number) || 100);
  }

  private async handleGetStatusLowBattery(callback: CharacteristicGetCallback) {
    if (!this.node.supportsCC(128)) {
      callback(null, this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      return;
    }
    const value = this.node.getValue({
      commandClass: 128,
      property: 'level',
    });
    const level = (value as number) || 100;
    callback(
      null,
      level <= 20
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  }
}
