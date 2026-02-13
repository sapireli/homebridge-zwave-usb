import { PlatformAccessory, Service, CharacteristicValue, Characteristic } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { IZWaveController } from '../zwave/interfaces';
import { MANAGER_SERVICE_UUID, OBSOLETE_MANAGER_UUIDS, OBSOLETE_CHAR_UUIDS, HAPFormat, HAPPerm } from '../platform/settings';

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

    // --- AGGRESSIVE CLEANUP: Remove ALL obsolete services and characteristics ---
    this.platformAccessory.services.slice().forEach(service => {
        const serviceUuid = service.UUID.toUpperCase();
        
        // Remove obsolete services
        const isObsoleteManager = OBSOLETE_MANAGER_UUIDS.some(u => u.toUpperCase() === serviceUuid);
        const isDuplicateCurrent = serviceUuid === MANAGER_SERVICE_UUID.toUpperCase() && 
                                   service !== this.platformAccessory.getService(MANAGER_SERVICE_UUID);

        if (isObsoleteManager || isDuplicateCurrent) {
            this.platform.log.info(`Pruning obsolete or duplicate service: ${service.displayName} (${service.UUID})`);
            this.platformAccessory.removeService(service);
            return; // Service gone
        }

        // Clean up obsolete characteristics from retained services (like Switch)
        OBSOLETE_CHAR_UUIDS.forEach(charUuid => {
            const found = service.characteristics.find(c => c.UUID.toUpperCase() === charUuid.toUpperCase());
            if (found) {
                this.platform.log.info(`Pruning obsolete characteristic: ${found.displayName} from ${service.displayName}`);
                service.removeCharacteristic(found);
            }
        });
        
    });

    // Add ServiceLabelNamespace to AccessoryInformation to help with naming multi-service accessories
    const infoService = this.platformAccessory.getService(this.platform.Service.AccessoryInformation)!;
    if (!infoService.testCharacteristic(this.platform.Characteristic.ServiceLabelNamespace)) {
        infoService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelNamespace);
    }
    // 1 = Arabic numerals (1, 2, 3...)
    infoService.getCharacteristic(this.platform.Characteristic.ServiceLabelNamespace).updateValue(1);

    // --- 1. System Status Service (Custom Service) ---
    this.statusService = this.platformAccessory.getService(MANAGER_SERVICE_UUID) ||
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        this.platformAccessory.addService(new (this.platform.Service as any).ZWaveManager('System Status', 'Status'));
    this.syncConfiguredName(this.statusService, 'System Status');
    
    // Naming Identity - Strictly Name only
    this.statusService.getCharacteristic(this.platform.Characteristic.Name)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ format: HAPFormat.STRING as any, perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue('System Status');
    
    // Service Label Index
    if (!this.statusService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
        this.statusService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
    }
    this.statusService.getCharacteristic(this.platform.Characteristic.ServiceLabelIndex).updateValue(1);

    // System Status Characteristic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusCharType = (this.platform.Characteristic as any).ZWaveStatus;
    if (!this.statusService.testCharacteristic(statusCharType)) {
        this.statusService.addOptionalCharacteristic(statusCharType);
    }
    this.statusChar = this.statusService.getCharacteristic(statusCharType);
    this.statusChar.setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: HAPFormat.STRING as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any, HAPPerm.NOTIFY as any],
        description: 'Controller Status'
    });
    this.statusChar.updateValue('Driver Ready');

    // Remove PIN from custom status service; Home app treats this custom service as display-only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinCharType = (this.platform.Characteristic as any).S2PinEntry;
    if (this.statusService.testCharacteristic(pinCharType)) {
      const cachedPinChar = this.statusService.getCharacteristic(pinCharType);
      this.statusService.removeCharacteristic(cachedPinChar);
    }

    // --- 2. Inclusion Mode Switch ---
    this.inclusionService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Inclusion') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Inclusion Mode', 'Inclusion');
    this.syncConfiguredName(this.inclusionService, 'Inclusion Mode');
    
    this.inclusionService.getCharacteristic(this.platform.Characteristic.Name)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ format: HAPFormat.STRING as any, perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue('Inclusion Mode');
    
    if (!this.inclusionService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
        this.inclusionService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
    }
    this.inclusionService.getCharacteristic(this.platform.Characteristic.ServiceLabelIndex).updateValue(2);
    this.setupPinEntryCharacteristic(this.inclusionService);


    // --- 3. Exclusion Mode Switch ---
    this.exclusionService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Exclusion') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Exclusion Mode', 'Exclusion');
    this.syncConfiguredName(this.exclusionService, 'Exclusion Mode');
    
    this.exclusionService.getCharacteristic(this.platform.Characteristic.Name)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ format: HAPFormat.STRING as any, perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue('Exclusion Mode');

    if (!this.exclusionService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
        this.exclusionService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
    }
    this.exclusionService.getCharacteristic(this.platform.Characteristic.ServiceLabelIndex).updateValue(3);

    // --- 4. Heal Network Switch ---
    this.healService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Heal') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Heal Network', 'Heal');
    this.syncConfiguredName(this.healService, 'Heal Network');
    
    this.healService.getCharacteristic(this.platform.Characteristic.Name)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .setProps({ format: HAPFormat.STRING as any, perms: [HAPPerm.PAIRED_READ as any] })
        .updateValue('Heal Network');

    if (!this.healService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
        this.healService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
    }
    this.healService.getCharacteristic(this.platform.Characteristic.ServiceLabelIndex).updateValue(4);

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

  private syncConfiguredName(service: Service, value?: string) {
    const configuredNameValue = value || service.displayName;
    if (!service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    }
    service.getCharacteristic(this.platform.Characteristic.ConfiguredName).updateValue(configuredNameValue);
  }

  private setupPinEntryCharacteristic(service: Service) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinCharType = (this.platform.Characteristic as any).S2PinEntry;
    if (service.testCharacteristic(pinCharType)) {
      service.removeCharacteristic(service.getCharacteristic(pinCharType));
    }

    service.addOptionalCharacteristic(pinCharType);
    this.pinChar = service.getCharacteristic(pinCharType);
    this.pinChar.setProps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      format: HAPFormat.UINT32 as any,
      minValue: 0,
      maxValue: 99999,
      minStep: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      perms: [HAPPerm.PAIRED_READ as any, HAPPerm.NOTIFY as any, HAPPerm.PAIRED_WRITE as any],
      description: 'Enter 5-digit S2 PIN',
    });

    this.pinChar.onSet((value: CharacteristicValue) => {
      const raw = Number(value);
      if (!Number.isInteger(raw) || raw < 0 || raw > 99999) {
        this.platform.log.warn(`[S2] Ignoring invalid PIN value from HomeKit: ${value}`);
        return;
      }

      const pin = raw.toString().padStart(5, '0');
      this.platform.log.info(`HomeKit S2 PIN Received: ${pin}`);
      this.controller.setS2Pin(pin);
      setTimeout(() => this.pinChar.updateValue(0), 2000);
    });
    this.pinChar.updateValue(0);
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
