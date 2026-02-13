import { PlatformAccessory, Service, CharacteristicValue, Characteristic } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { IZWaveController } from '../zwave/interfaces';
import { STATUS_CHAR_UUID, PIN_CHAR_UUID } from '../platform/settings';

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

    // --- 1. Z-Wave Manager Service ---
    this.managerService = 
        this.platformAccessory.getService('Z-Wave Manager') ||
        this.platformAccessory.addService(this.platform.Service.Switch, 'Z-Wave Manager', 'manager');
    
    this.managerService.setCharacteristic(this.platform.Characteristic.Name, 'Z-Wave Manager');

    // System Status Characteristic
    const existingStatus = this.managerService.getCharacteristic(STATUS_CHAR_UUID);
    if (!existingStatus) {
        this.platform.log.debug('Adding new System Status characteristic');
        this.statusChar = this.managerService.addCharacteristic(
            new this.platform.api.hap.Characteristic('System Status', STATUS_CHAR_UUID, {
                format: 'string' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                perms: ['pr' as any, 'ev' as any], // eslint-disable-line @typescript-eslint/no-explicit-any
            })
        );
    } else {
        this.statusChar = existingStatus;
    }
    
    this.statusChar.setProps({
        format: 'string' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        perms: ['pr' as any, 'ev' as any], // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    this.statusChar.updateValue('Driver Ready');

    // S2 PIN Input Characteristic
    const existingPin = this.managerService.getCharacteristic(PIN_CHAR_UUID);
    if (!existingPin) {
        this.platform.log.debug('Adding new S2 PIN Input characteristic');
        this.pinChar = this.managerService.addCharacteristic(
            new this.platform.api.hap.Characteristic('S2 PIN Input', PIN_CHAR_UUID, {
                format: 'string' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                perms: ['pr' as any, 'pw' as any, 'ev' as any], // eslint-disable-line @typescript-eslint/no-explicit-any
            })
        );
    } else {
        this.pinChar = existingPin;
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

    // Manager Switch logic: Turning it ON does nothing, turning it OFF stops all active processes
    this.managerService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => false)
        .onSet(async (value: CharacteristicValue) => {
            if (!value) {
                this.platform.log.info('Manager: Stopping all active processes...');
                await this.controller.stopInclusion();
                await this.controller.stopExclusion();
                await this.controller.stopHealing();
            }
        });

    // --- 2. Inclusion Mode Service ---
    this.inclusionService =
      this.platformAccessory.getService('Inclusion Mode') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Inclusion Mode', 'Inclusion');

    this.inclusionService.setCharacteristic(this.platform.Characteristic.Name, 'Inclusion Mode');

    // --- 3. Exclusion Mode Service ---
    this.exclusionService =
      this.platformAccessory.getService('Exclusion Mode') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Exclusion Mode', 'Exclusion');

    this.exclusionService.setCharacteristic(this.platform.Characteristic.Name, 'Exclusion Mode');

    // --- 4. Heal Network Service ---
    this.healService =
      this.platformAccessory.getService('Heal Network') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Heal Network', 'Heal');

    this.healService.setCharacteristic(this.platform.Characteristic.Name, 'Heal Network');

    // --- Setup Characteristic Handlers ---
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
