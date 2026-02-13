import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { IZWaveController } from '../zwave/interfaces';
import { STATUS_CHAR_UUID, PIN_CHAR_UUID } from '../platform/settings';

export class ControllerAccessory {
  private inclusionService: Service;
  private exclusionService: Service;
  private healService: Service;
  public readonly platformAccessory: PlatformAccessory;
  private inclusionTimer?: NodeJS.Timeout;
  private exclusionTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: ZWaveUsbPlatform,
    private readonly controller: IZWaveController,
  ) {
    const homeId = this.controller.homeId;
    if (!homeId) {
      throw new Error('Cannot create ControllerAccessory: homeId is not available');
    }
    const uuid = this.platform.api.hap.uuid.generate(`homebridge-zwave-usb-controller-${homeId}`);
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

    // Set accessory information
    this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aeotec / Z-Wave JS')
      .setCharacteristic(this.platform.Characteristic.Model, 'Z-Wave USB Controller')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, homeId.toString());

    // Add Custom Status Service (using standard Label service as a container for text)
    const statusService = 
        this.platformAccessory.getService('Z-Wave Status') ||
        this.platformAccessory.addService(this.platform.Service.ServiceLabel, 'Z-Wave Status', 'status');
    
    // Add Custom Characteristic for the text
    let statusChar = statusService.getCharacteristic(STATUS_CHAR_UUID);
    if (!statusChar) {
        statusChar = statusService.addCharacteristic(
            new this.platform.api.hap.Characteristic('System Status', STATUS_CHAR_UUID, {
                format: 'string' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                perms: ['pr' as any, 'ev' as any], // eslint-disable-line @typescript-eslint/no-explicit-any
            })
        );
    }
    statusChar.updateValue('Driver Ready');

    // Add Custom Characteristic for PIN input
    let pinChar = statusService.getCharacteristic(PIN_CHAR_UUID);
    if (!pinChar) {
        pinChar = statusService.addCharacteristic(
            new this.platform.api.hap.Characteristic('S2 PIN Input', PIN_CHAR_UUID, {
                format: 'string' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                perms: ['pr' as any, 'pw' as any, 'ev' as any], // eslint-disable-line @typescript-eslint/no-explicit-any
            })
        );
    }
    pinChar.onSet((value: CharacteristicValue) => {
        this.controller.setS2Pin(value as string);
    });
    pinChar.updateValue('');

    this.inclusionService =
      this.platformAccessory.getService('Inclusion Mode') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Inclusion Mode', 'Inclusion');

    this.inclusionService.setCharacteristic(this.platform.Characteristic.Name, 'Inclusion Mode');
    this.inclusionService.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Inclusion Mode');

    this.exclusionService =
      this.platformAccessory.getService('Exclusion Mode') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Exclusion Mode', 'Exclusion');

    this.exclusionService.setCharacteristic(this.platform.Characteristic.Name, 'Exclusion Mode');
    this.exclusionService.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Exclusion Mode');

    this.healService =
      this.platformAccessory.getService('Heal Network') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Heal Network', 'Heal');

    this.healService.setCharacteristic(this.platform.Characteristic.Name, 'Heal Network');
    this.healService.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Heal Network');

    this.inclusionService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetInclusion.bind(this))
      .onGet(this.handleGetInclusion.bind(this));

    this.exclusionService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetExclusion.bind(this))
      .onGet(this.handleGetExclusion.bind(this));

    this.healService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetHeal.bind(this))
      .onGet(this.handleGetHeal.bind(this));

    // Listen for controller events to sync state
    this.controller.on('status updated', (status: string) => {
        statusChar.updateValue(status);
    });

    this.controller.on('inclusion started', () => {
      this.platform.log.info('Controller event: Inclusion Started');
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('inclusion stopped', () => {
      this.platform.log.info('Controller event: Inclusion Stopped');
      if (this.inclusionTimer) {
        clearTimeout(this.inclusionTimer);
        this.inclusionTimer = undefined;
      }
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('exclusion started', () => {
      this.platform.log.info('Controller event: Exclusion Started');
      if (this.inclusionTimer) {
        clearTimeout(this.inclusionTimer);
        this.inclusionTimer = undefined;
      }
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('exclusion stopped', () => {
      this.platform.log.info('Controller event: Exclusion Stopped');
      if (this.exclusionTimer) {
        clearTimeout(this.exclusionTimer);
        this.exclusionTimer = undefined;
      }
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('heal network done', () => {
      this.platform.log.info('Controller event: Heal Network Done');
      this.healService.updateCharacteristic(this.platform.Characteristic.On, false);
    });
  }

  private async handleSetInclusion(value: CharacteristicValue) {
    if (this.inclusionTimer) {
      clearTimeout(this.inclusionTimer);
      this.inclusionTimer = undefined;
    }

    if (value) {
      const timeoutSeconds = this.platform.config.inclusionTimeoutSeconds || 60;
      this.platform.log.info(`Requesting Inclusion Mode ON (Timeout: ${timeoutSeconds}s)`);
      await this.controller.startInclusion();

      this.inclusionTimer = setTimeout(async () => {
        this.platform.log.info('Inclusion Mode timed out');
        await this.controller.stopInclusion();
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, timeoutSeconds * 1000);
    } else {
      this.platform.log.info('Requesting Inclusion Mode OFF');
      await this.controller.stopInclusion();
    }
  }

  private handleGetInclusion(): boolean {
    return false;
  }

  private async handleSetExclusion(value: CharacteristicValue) {
    if (this.exclusionTimer) {
      clearTimeout(this.exclusionTimer);
      this.exclusionTimer = undefined;
    }

    if (value) {
      const timeoutSeconds = this.platform.config.inclusionTimeoutSeconds || 60;
      this.platform.log.info(`Requesting Exclusion Mode ON (Timeout: ${timeoutSeconds}s)`);
      await this.controller.startExclusion();

      this.exclusionTimer = setTimeout(async () => {
        this.platform.log.info('Exclusion Mode timed out');
        await this.controller.stopExclusion();
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, timeoutSeconds * 1000);
    } else {
      this.platform.log.info('Requesting Exclusion Mode OFF');
      await this.controller.stopExclusion();
    }
  }

  private handleGetExclusion(): boolean {
    return false;
  }

  private async handleSetHeal(value: CharacteristicValue) {
    if (value) {
      this.platform.log.info('Requesting Heal Network ON');
      await this.controller.startHealing();
    } else {
      this.platform.log.info('Requesting Heal Network OFF');
      await this.controller.stopHealing();
    }
  }

  private handleGetHeal(): boolean {
    return false;
  }

  public stop() {
    if (this.inclusionTimer) {
      clearTimeout(this.inclusionTimer);
    }
    if (this.exclusionTimer) {
      clearTimeout(this.exclusionTimer);
    }
  }
}
