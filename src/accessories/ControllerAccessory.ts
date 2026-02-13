import { PlatformAccessory, Service, CharacteristicValue, Characteristic } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { IZWaveController } from '../zwave/interfaces';
import { MANAGER_SERVICE_UUID, OBSOLETE_STATUS_UUID, OBSOLETE_PIN_UUID, OBSOLETE_MANAGER_SERVICE_UUID, OBSOLETE_EVE_PIN_UUID, OBSOLETE_EVE_STATUS_UUID, HAPFormat, HAPPerm } from '../platform/settings';

export class ControllerAccessory {
  private statusService: Service;
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

    // --- Aggressive Cleanup: Remove obsolete or duplicate services ---
    const currentManagerUuid = MANAGER_SERVICE_UUID.toUpperCase();
    const obsoleteUuids = [
        OBSOLETE_MANAGER_SERVICE_UUID.toUpperCase(),
        'manager'.toUpperCase(),
        'Status'.toUpperCase(),
        'System Status'.toUpperCase()
    ];

    // Identify and remove services matching obsolete criteria
    this.platformAccessory.services.slice().forEach(service => {
        const serviceUuid = service.UUID.toUpperCase();
        const isObsoleteUuid = obsoleteUuids.includes(serviceUuid);
        const isDuplicateCurrent = serviceUuid === currentManagerUuid && service !== this.platformAccessory.getService(MANAGER_SERVICE_UUID);
        
        if (isObsoleteUuid || isDuplicateCurrent) {
            this.platform.log.info(`Pruning obsolete or duplicate service: ${service.displayName} (${service.UUID})`);
            this.platformAccessory.removeService(service);
        }
    });

    // --- 1. System Status Service (Custom Service) ---
    this.statusService = this.platformAccessory.getService(MANAGER_SERVICE_UUID) ||
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        this.platformAccessory.addService(new (this.platform.Service as any).ZWaveManager('System Status', 'Status'));
    
    // Enforce name and configured name
    this.statusService.getCharacteristic(this.platform.Characteristic.Name)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue('System Status');
    this.statusService.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'System Status');

    // System Status Characteristic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.statusChar = this.statusService.getCharacteristic((this.platform.Characteristic as any).ZWaveStatus) ||
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      this.statusService.addCharacteristic((this.platform.Characteristic as any).ZWaveStatus);
    
    // Force Props to ensure it's up to date in cache
    this.statusChar.setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: HAPFormat.STRING as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any, HAPPerm.NOTIFY as any],
        description: 'Controller Status'
    });
    this.statusChar.updateValue('Driver Ready');

    // S2 PIN Entry Characteristic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.pinChar = this.statusService.getCharacteristic((this.platform.Characteristic as any).S2PinEntry) ||
                   // eslint-disable-next-line @typescript-eslint/no-explicit-any
                   this.statusService.addCharacteristic((this.platform.Characteristic as any).S2PinEntry);
    
    // Force Props to ensure it is WRITABLE in HomeKit apps
    this.pinChar.setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: HAPFormat.STRING as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any, HAPPerm.PAIRED_WRITE as any, HAPPerm.NOTIFY as any],
        maxLen: 5,
        description: 'Enter 5-digit S2 PIN'
    });

    this.pinChar.onSet((value: CharacteristicValue) => {
        this.platform.log.info(`HomeKit S2 PIN Received: ${value}`);
        this.controller.setS2Pin(value as string);
        setTimeout(() => this.pinChar.updateValue(''), 1000);
    });
    this.pinChar.updateValue('');

    // --- 2. Inclusion Mode Switch ---
    this.inclusionService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Inclusion') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Inclusion Mode', 'Inclusion');

    this.inclusionService.getCharacteristic(this.platform.Characteristic.Name)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue('Inclusion Mode');
    this.inclusionService.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Inclusion Mode');

    // --- 3. Exclusion Mode Switch ---
    this.exclusionService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Exclusion') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Exclusion Mode', 'Exclusion');

    this.exclusionService.getCharacteristic(this.platform.Characteristic.Name)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue('Exclusion Mode');
    this.exclusionService.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Exclusion Mode');

    // --- 4. Heal Network Switch ---
    this.healService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Heal') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Heal Network', 'Heal');

    this.healService.getCharacteristic(this.platform.Characteristic.Name)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue('Heal Network');
    this.healService.setCharacteristic(this.platform.Characteristic.ConfiguredName, 'Heal Network');

    // Setup Switch characteristic Handlers
    [this.inclusionService, this.exclusionService, this.healService].forEach(service => {
        service.getCharacteristic(this.platform.Characteristic.On)
            .onGet(() => false);
    });

    this.inclusionService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetInclusion.bind(this));

    this.exclusionService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetExclusion.bind(this));

    this.healService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetHeal.bind(this));

    // --- CLEANUP: Remove obsolete characteristics from AccessoryInformation ---
    const allObsoleteUuids = [
        OBSOLETE_STATUS_UUID, OBSOLETE_PIN_UUID, 
        OBSOLETE_EVE_STATUS_UUID, OBSOLETE_EVE_PIN_UUID
    ];

    const infoService = this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!;
    allObsoleteUuids.forEach(uuid => {
        const found = infoService.characteristics.find(c => c.UUID.toUpperCase() === uuid.toUpperCase());
        if (found) infoService.removeCharacteristic(found);
    });

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

  private async handleSetHeal(value: CharacteristicValue) {
    if (value) {
      this.platform.log.info('Requesting Heal Network ON');
      await this.controller.startHealing();
    } else {
      this.platform.log.info('Requesting Heal Network OFF');
      await this.controller.stopHealing();
    }
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
