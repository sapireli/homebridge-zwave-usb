import { PlatformAccessory, Service, CharacteristicValue, Characteristic } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { IZWaveController } from '../zwave/interfaces';
import {
  MANAGER_SERVICE_UUID,
  OBSOLETE_MANAGER_UUIDS,
  OBSOLETE_CHAR_UUIDS,
  HAPFormat,
  HAPPerm,
} from '../platform/settings';

export class ControllerAccessory {
  private statusService: Service;
  private inclusionService: Service;
  private exclusionService: Service;
  private healService: Service;
  private pruneService: Service;
  public readonly platformAccessory: PlatformAccessory;
  private inclusionTimer?: NodeJS.Timeout;
  private exclusionTimer?: NodeJS.Timeout;
  private statusChar!: Characteristic;
  private pinChar!: Characteristic;

  private isInclusionActive = false;
  private isExclusionActive = false;
  private isHealActive = false;
  private isPruneActive = false;

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
      this.platformAccessory = new this.platform.api.platformAccessory('Z-Wave Controller', uuid);
      this.platform.api.registerPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        this.platformAccessory,
      ]);
      this.platform.accessories.push(this.platformAccessory);
    }

    // Set accessory information
    this.platformAccessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aeotec / Z-Wave JS')
      .setCharacteristic(this.platform.Characteristic.Model, 'Z-Wave USB Controller')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, homeId.toString());

    /**
     * Helper to normalize UUIDs for reliable comparison during metadata pruning.
     */
    const normalizeUuid = (u: string) => u.replace(/-/g, '').toUpperCase();

    // --- AGGRESSIVE CLEANUP: Remove ALL obsolete services and characteristics ---
    this.platformAccessory.services.slice().forEach((service) => {
      const serviceUuidNorm = normalizeUuid(service.UUID);

      // Remove obsolete services
      const isObsoleteManager = OBSOLETE_MANAGER_UUIDS.some(
        (u) => normalizeUuid(u) === serviceUuidNorm,
      );
      const isDuplicateCurrent =
        serviceUuidNorm === normalizeUuid(MANAGER_SERVICE_UUID) &&
        service !== this.platformAccessory.getService(MANAGER_SERVICE_UUID);

      if (isObsoleteManager || isDuplicateCurrent) {
        this.platform.log.info(
          `Pruning obsolete or duplicate service: ${service.displayName} (${service.UUID})`,
        );
        this.platformAccessory.removeService(service);
        return; // Service gone
      }

      // Clean up obsolete characteristics from retained services (like Switch)
      service.characteristics.slice().forEach((found) => {
        const charUuidNorm = normalizeUuid(found.UUID);
        if (OBSOLETE_CHAR_UUIDS.some((u) => normalizeUuid(u) === charUuidNorm)) {
          this.platform.log.info(
            `Pruning obsolete characteristic: ${found.displayName} from ${service.displayName}`,
          );
          service.removeCharacteristic(found);
        }
      });
    });

    // Add ServiceLabelNamespace to AccessoryInformation to help with naming multi-service accessories
    const infoService = this.platformAccessory.getService(
      this.platform.Service.AccessoryInformation,
    )!;
    if (!infoService.testCharacteristic(this.platform.Characteristic.ServiceLabelNamespace)) {
      infoService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelNamespace);
    }
    // 1 = Arabic numerals (1, 2, 3...)
    infoService
      .getCharacteristic(this.platform.Characteristic.ServiceLabelNamespace)
      .updateValue(1);

    // --- 1. System Status Service (Custom Service) ---
    this.statusService =
      this.platformAccessory.getService(MANAGER_SERVICE_UUID) ||
      this.platformAccessory.addService(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new (this.platform.Service as any).ZWaveManager('System Status', 'Status'),
      );
    this.syncConfiguredName(this.statusService, 'System Status');

    this.statusService
      .getCharacteristic(this.platform.Characteristic.Name)
      .setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: HAPFormat.STRING as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any],
      })
      .updateValue('System Status');

    if (!this.statusService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
      this.statusService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
    }
    this.statusService
      .getCharacteristic(this.platform.Characteristic.ServiceLabelIndex)
      .updateValue(1);

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
      description: 'Controller Status',
    });
    this.statusChar.updateValue('Driver Ready');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinCharType = (this.platform.Characteristic as any).S2PinEntry;
    if (this.statusService.testCharacteristic(pinCharType)) {
      const cachedPinChar = this.statusService.getCharacteristic(pinCharType);
      this.statusService.removeCharacteristic(cachedPinChar);
    }

    // --- 2. Inclusion Mode Switch ---
    this.inclusionService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Inclusion') ||
      this.platformAccessory.addService(
        this.platform.Service.Switch,
        'Inclusion Mode',
        'Inclusion',
      );
    this.syncConfiguredName(this.inclusionService, 'Inclusion Mode');

    this.inclusionService
      .getCharacteristic(this.platform.Characteristic.Name)
      .setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: HAPFormat.STRING as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any],
      })
      .updateValue('Inclusion Mode');

    if (!this.inclusionService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
      this.inclusionService.addOptionalCharacteristic(
        this.platform.Characteristic.ServiceLabelIndex,
      );
    }
    this.inclusionService
      .getCharacteristic(this.platform.Characteristic.ServiceLabelIndex)
      .updateValue(2);
    this.setupPinEntryCharacteristic(this.inclusionService);

    // --- 3. Exclusion Mode Switch ---
    this.exclusionService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Exclusion') ||
      this.platformAccessory.addService(
        this.platform.Service.Switch,
        'Exclusion Mode',
        'Exclusion',
      );
    this.syncConfiguredName(this.exclusionService, 'Exclusion Mode');

    this.exclusionService
      .getCharacteristic(this.platform.Characteristic.Name)
      .setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: HAPFormat.STRING as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any],
      })
      .updateValue('Exclusion Mode');

    if (!this.exclusionService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
      this.exclusionService.addOptionalCharacteristic(
        this.platform.Characteristic.ServiceLabelIndex,
      );
    }
    this.exclusionService
      .getCharacteristic(this.platform.Characteristic.ServiceLabelIndex)
      .updateValue(3);

    // --- 4. Heal Network Switch ---
    this.healService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Heal') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Heal Network', 'Heal');
    this.syncConfiguredName(this.healService, 'Heal Network');

    this.healService
      .getCharacteristic(this.platform.Characteristic.Name)
      .setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: HAPFormat.STRING as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any],
      })
      .updateValue('Heal Network');

    if (!this.healService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
      this.healService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
    }
    this.healService
      .getCharacteristic(this.platform.Characteristic.ServiceLabelIndex)
      .updateValue(4);

    // --- 5. Prune Dead Nodes Switch ---
    this.pruneService =
      this.platformAccessory.getServiceById(this.platform.Service.Switch, 'Prune') ||
      this.platformAccessory.addService(this.platform.Service.Switch, 'Prune Dead Nodes', 'Prune');
    this.syncConfiguredName(this.pruneService, 'Prune Dead Nodes');

    this.pruneService
      .getCharacteristic(this.platform.Characteristic.Name)
      .setProps({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: HAPFormat.STRING as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        perms: [HAPPerm.PAIRED_READ as any],
      })
      .updateValue('Prune Dead Nodes');

    if (!this.pruneService.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
      this.pruneService.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
    }
    this.pruneService
      .getCharacteristic(this.platform.Characteristic.ServiceLabelIndex)
      .updateValue(5);

    // Setup Switch characteristic Handlers
    this.inclusionService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.isInclusionActive)
      .onSet(this.handleSetInclusion.bind(this));

    this.exclusionService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.isExclusionActive)
      .onSet(this.handleSetExclusion.bind(this));

    this.healService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.isHealActive)
      .onSet(this.handleSetHeal.bind(this));

    this.pruneService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.isPruneActive)
      .onSet(this.handleSetPrune.bind(this));

    // --- Listen for controller events to sync state ---
    this.controller.on('status updated', (status: string) => {
      this.statusChar.updateValue(status);
    });

    this.controller.on('inclusion started', () => {
      this.platform.log.info('Controller event: Inclusion Started');
      this.isInclusionActive = true;
      this.isExclusionActive = false;
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('inclusion stopped', () => {
      this.platform.log.info('Controller event: Inclusion Stopped');
      this.isInclusionActive = false;
      if (this.inclusionTimer) {
        clearTimeout(this.inclusionTimer);
        this.inclusionTimer = undefined;
      }
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('exclusion started', () => {
      this.platform.log.info('Controller event: Exclusion Started');
      this.isExclusionActive = true;
      this.isInclusionActive = false;
      if (this.inclusionTimer) {
        clearTimeout(this.inclusionTimer);
        this.inclusionTimer = undefined;
      }
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('exclusion stopped', () => {
      this.platform.log.info('Controller event: Exclusion Stopped');
      this.isExclusionActive = false;
      if (this.exclusionTimer) {
        clearTimeout(this.exclusionTimer);
        this.exclusionTimer = undefined;
      }
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    });

    this.controller.on('heal network done', () => {
      this.platform.log.info('Controller event: Heal Network Done');
      this.isHealActive = false;
      this.healService.updateCharacteristic(this.platform.Characteristic.On, false);
    });
  }

  private syncConfiguredName(service: Service, value?: string) {
    const configuredNameValue = value || service.displayName;
    if (!service.testCharacteristic(this.platform.Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    }
    service
      .getCharacteristic(this.platform.Characteristic.ConfiguredName)
      .updateValue(configuredNameValue);
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
      if (this.isExclusionActive) {
        await this.handleSetExclusion(false);
      }
      if (this.isHealActive) {
        await this.handleSetHeal(false);
      }
      if (this.isPruneActive) {
        this.isPruneActive = false;
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
      }

      const timeoutSeconds = this.platform.config.inclusionTimeoutSeconds || 60;
      this.platform.log.info(`Requesting Inclusion Mode ON (Timeout: ${timeoutSeconds}s)`);
      this.isInclusionActive = true;
      await this.controller.startInclusion();

      this.inclusionTimer = setTimeout(async () => {
        this.platform.log.info('Inclusion Mode timed out');
        await this.controller.stopInclusion();
        this.isInclusionActive = false;
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, timeoutSeconds * 1000);
    } else {
      this.platform.log.info('Requesting Inclusion Mode OFF');
      this.isInclusionActive = false;
      await this.controller.stopInclusion();
    }
  }

  private async handleSetExclusion(value: CharacteristicValue) {
    if (this.exclusionTimer) {
      clearTimeout(this.exclusionTimer);
      this.exclusionTimer = undefined;
    }

    if (value) {
      if (this.isInclusionActive) {
        await this.handleSetInclusion(false);
      }
      if (this.isHealActive) {
        await this.handleSetHeal(false);
      }
      if (this.isPruneActive) {
        this.isPruneActive = false;
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
      }

      const timeoutSeconds = this.platform.config.inclusionTimeoutSeconds || 60;
      this.platform.log.info(`Requesting Exclusion Mode ON (Timeout: ${timeoutSeconds}s)`);
      this.isExclusionActive = true;
      await this.controller.startExclusion();

      this.exclusionTimer = setTimeout(async () => {
        this.platform.log.info('Exclusion Mode timed out');
        await this.controller.stopExclusion();
        this.isExclusionActive = false;
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, timeoutSeconds * 1000);
    } else {
      this.platform.log.info('Requesting Exclusion Mode OFF');
      this.isExclusionActive = false;
      await this.controller.stopExclusion();
    }
  }

  private async handleSetHeal(value: CharacteristicValue) {
    if (value) {
      if (this.isInclusionActive) {
        await this.handleSetInclusion(false);
      }
      if (this.isExclusionActive) {
        await this.handleSetExclusion(false);
      }
      if (this.isPruneActive) {
        this.isPruneActive = false;
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
      }

      this.platform.log.info('Requesting Heal Network ON');
      this.isHealActive = true;
      await this.controller.startHealing();
    } else {
      this.platform.log.info('Requesting Heal Network OFF');
      this.isHealActive = false;
      await this.controller.stopHealing();
    }
  }

  private async handleSetPrune(value: CharacteristicValue) {
    if (value) {
      if (this.isInclusionActive) {
        await this.handleSetInclusion(false);
      }
      if (this.isExclusionActive) {
        await this.handleSetExclusion(false);
      }
      if (this.isHealActive) {
        await this.handleSetHeal(false);
      }

      this.platform.log.info('Requesting Prune Dead Nodes...');
      this.isPruneActive = true;

      // Find all Dead nodes
      const deadNodeIds: number[] = [];
      for (const [nodeId, node] of this.controller.nodes) {
        if (node.status === 4) {
          // 4 = Dead
          deadNodeIds.push(nodeId);
        } else if (node.status === 3) {
          this.platform.log.debug(`Prune: Node ${nodeId} is ASLEEP (Battery). Skipping.`);
        }
      }

      if (deadNodeIds.length === 0) {
        this.platform.log.info('No Dead nodes found to prune.');
        setTimeout(() => {
          this.isPruneActive = false;
          this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
        }, 1000);
        return;
      }

      this.platform.log.info(`Found ${deadNodeIds.length} dead nodes: ${deadNodeIds.join(', ')}`);

      for (const nodeId of deadNodeIds) {
        try {
          await this.controller.removeFailedNode(nodeId);
        } catch (err) {
          this.platform.log.error(`Failed to prune node ${nodeId}:`, err);
        }
      }

      this.platform.log.info('Pruning complete.');
      setTimeout(() => {
        this.isPruneActive = false;
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
      }, 2000);
    } else {
      this.isPruneActive = false;
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
