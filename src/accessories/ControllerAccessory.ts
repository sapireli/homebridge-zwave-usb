import { PlatformAccessory, Service, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { IZWaveController } from '../zwave/interfaces';

export class ControllerAccessory {
  private inclusionService: Service;
  private exclusionService: Service;
  private healService: Service;
  public readonly platformAccessory: PlatformAccessory;

  constructor(
    private readonly platform: ZWaveUsbPlatform,
    private readonly controller: IZWaveController,
  ) {
    const homeId = this.controller.homeId;
    const uuid = this.platform.api.hap.uuid.generate(`ZWaveController-${homeId}`);
    const existingAccessory = this.platform.accessories.find(
      (accessory) => accessory.UUID === uuid,
    );

    if (existingAccessory) {
      this.platformAccessory = existingAccessory;
    } else {
      this.platform.log.info('Creating new Z-Wave Controller accessory');
      this.platformAccessory = new this.platform.api.platformAccessory(
        'Z-Wave Controller',
        uuid,
      );
      this.platform.api.registerPlatformAccessories(
        'homebridge-zwave-usb',
        'ZWaveUSB',
        [this.platformAccessory],
      );
      this.platform.accessories.push(this.platformAccessory);
    }

    this.inclusionService =
      this.platformAccessory.getService('Inclusion Mode') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Inclusion Mode', 'Inclusion');

    this.exclusionService =
      this.platformAccessory.getService('Exclusion Mode') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Exclusion Mode', 'Exclusion');

    this.healService =
      this.platformAccessory.getService('Heal Network') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Heal Network', 'Heal');

    this.inclusionService
      .getCharacteristic(this.platform.Characteristic.On)
      .on('set', this.handleSetInclusion.bind(this))
      .on('get', this.handleGetInclusion.bind(this));

    this.exclusionService
      .getCharacteristic(this.platform.Characteristic.On)
      .on('set', this.handleSetExclusion.bind(this))
      .on('get', this.handleGetExclusion.bind(this));

    this.healService
      .getCharacteristic(this.platform.Characteristic.On)
      .on('set', this.handleSetHeal.bind(this))
      .on('get', this.handleGetHeal.bind(this));

    // Listen for controller events to sync state
    this.controller.on('inclusion started', () => {
      this.platform.log.info('Controller event: Inclusion Started');
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('inclusion stopped', () => {
      this.platform.log.info('Controller event: Inclusion Stopped');
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('exclusion started', () => {
      this.platform.log.info('Controller event: Exclusion Started');
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('exclusion stopped', () => {
      this.platform.log.info('Controller event: Exclusion Stopped');
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('heal network done', () => {
      this.platform.log.info('Controller event: Heal Network Done');
      this.healService.updateCharacteristic(this.platform.Characteristic.On, false);
    });
  }

  private async handleSetInclusion(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    if (value) {
      this.platform.log.info('Requesting Inclusion Mode ON');
      // We rely on the event listener to update the characteristic
      // But for UI responsiveness, we might want to acknowledge the command
      await this.controller.startInclusion();
    } else {
      this.platform.log.info('Requesting Inclusion Mode OFF');
      await this.controller.stopInclusion();
    }
    callback(null);
  }

  private async handleGetInclusion(callback: CharacteristicGetCallback) {
    callback(null, false);
  }

  private async handleSetExclusion(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    if (value) {
      this.platform.log.info('Requesting Exclusion Mode ON');
      await this.controller.startExclusion();
    } else {
      this.platform.log.info('Requesting Exclusion Mode OFF');
      await this.controller.stopExclusion();
    }
    callback(null);
  }

  private async handleGetExclusion(callback: CharacteristicGetCallback) {
    callback(null, false);
  }

  private async handleSetHeal(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    if (value) {
      this.platform.log.info('Requesting Heal Network ON');
      await this.controller.startHealing();
    } else {
      this.platform.log.info('Requesting Heal Network OFF');
      await this.controller.stopHealing();
    }
    callback(null);
  }

  private async handleGetHeal(callback: CharacteristicGetCallback) {
    callback(null, false);
  }
}
