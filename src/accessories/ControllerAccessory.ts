import { PlatformAccessory, Service, CharacteristicValue, Characteristic } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { IZWaveController } from '../zwave/interfaces';
import { STATUS_CHAR_UUID, PIN_CHAR_UUID, MANAGER_SERVICE_UUID, OBSOLETE_STATUS_UUID, OBSOLETE_PIN_UUID } from '../platform/settings';

export class ControllerAccessory {
  private managerService: Service;
  private inclusionService: Service;
  private exclusionService: Service;
  private healService: Service;
  public readonly platformAccessory: PlatformAccessory;
  private inclusionTimer?: NodeJS.Timeout;
  private exclusionTimer?: NodeJS.Timeout;
  private statusChar!: Characteristic;
  private pinChar!: Characteristic;

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

    // --- 1. Z-Wave Manager Service (Custom Service) ---
    // Using a custom Service UUID ensures third-party apps treat this as a specialized management container.
    this.managerService = 
        this.platformAccessory.getService(MANAGER_SERVICE_UUID) ||
        this.platformAccessory.addService(new this.platform.api.hap.Service('Z-Wave Manager', MANAGER_SERVICE_UUID, 'manager'));
    
    // Ensure Name is set correctly
    this.managerService.setCharacteristic(this.platform.Characteristic.Name, 'Z-Wave Manager');

    // Cleanup: Remove obsolete characteristics from previous versions to prevent UUID collisions
    [OBSOLETE_STATUS_UUID, OBSOLETE_PIN_UUID].forEach(obsoleteUuid => {
        const found = this.managerService.characteristics.find(c => c.UUID.toUpperCase() === obsoleteUuid.toUpperCase());
        if (found) {
            this.platform.log.info(`Cleaning up obsolete characteristic: ${obsoleteUuid}`);
            this.managerService.removeCharacteristic(found);
        }
    });

    // System Status Characteristic
    // Case-insensitive lookup to be absolutely safe against HAP variations
    const statusCharacteristic = this.managerService.characteristics.find(c => c.UUID.toUpperCase() === STATUS_CHAR_UUID.toUpperCase());
    
    if (statusCharacteristic) {
        this.statusChar = statusCharacteristic;
    } else {
        this.platform.log.debug('Adding new System Status characteristic');
        this.statusChar = this.managerService.addCharacteristic(
            new this.platform.api.hap.Characteristic('System Status', STATUS_CHAR_UUID, {
                format: 'string' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                perms: ['pr' as any, 'ev' as any], // eslint-disable-line @typescript-eslint/no-explicit-any
            })
        );
    }
    
    this.statusChar.setProps({
        format: 'string' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        perms: ['pr' as any, 'ev' as any], // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    this.statusChar.updateValue('Driver Ready');

    // S2 PIN Input Characteristic
    const pinCharacteristic = this.managerService.characteristics.find(c => c.UUID.toUpperCase() === PIN_CHAR_UUID.toUpperCase());
    
    if (pinCharacteristic) {
        this.pinChar = pinCharacteristic;
    } else {
        this.platform.log.debug('Adding new S2 PIN Input characteristic');
        this.pinChar = this.managerService.addCharacteristic(
            new this.platform.api.hap.Characteristic('S2 PIN Input', PIN_CHAR_UUID, {
                format: 'string' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                perms: ['pr' as any, 'pw' as any, 'ev' as any], // eslint-disable-line @typescript-eslint/no-explicit-any
            })
        );
    }

    this.pinChar.setProps({
        format: 'string' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        perms: ['pr' as any, 'pw' as any, 'ev' as any], // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    this.pinChar.onSet((value: CharacteristicValue) => {
        this.platform.log.info(`HomeKit S2 PIN Received: ${value}`);
        this.controller.setS2Pin(value as string);
        // Clear the value after a short delay so the UI doesn't keep the PIN visible
        setTimeout(() => this.pinChar.updateValue(''), 1000);
    });
    this.pinChar.updateValue('');

    // --- 2. Inclusion Mode Service ---
    this.inclusionService =
      this.platformAccessory.getService('Inclusion Mode') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Inclusion Mode', 'Inclusion');

    this.inclusionService.updateCharacteristic(this.platform.Characteristic.Name, 'Inclusion Mode');

    // --- 3. Exclusion Mode Service ---
    this.exclusionService =
      this.platformAccessory.getService('Exclusion Mode') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Exclusion Mode', 'Exclusion');

    this.exclusionService.updateCharacteristic(this.platform.Characteristic.Name, 'Exclusion Mode');

    // --- 4. Heal Network Service ---
    this.healService =
      this.platformAccessory.getService('Heal Network') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Heal Network', 'Heal');

    this.healService.updateCharacteristic(this.platform.Characteristic.Name, 'Heal Network');

    // Cleanup: Remove old "Z-Wave Manager" Switch if it was cached from previous version
    const oldSwitchManager = this.platformAccessory.getService('Z-Wave Manager');
    if (oldSwitchManager && oldSwitchManager.UUID !== MANAGER_SERVICE_UUID) {
        this.platform.log.info('Cleaning up obsolete Z-Wave Manager switch service');
        this.platformAccessory.removeService(oldSwitchManager);
    }

    // --- Listen for controller events to sync state ---
    this.controller.on('status updated', (status: string) => {
        this.statusChar.updateValue(status);
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
      this.platform.log.info('Requesting Inclusion Mode OFF');
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
