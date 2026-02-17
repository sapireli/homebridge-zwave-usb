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

  // Track listeners for cleanup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers: Record<string, (...args: any[]) => void> = {};

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

    /**
     * Homebridge Config UI X can show stale state if legacy/duplicate Switch services
     * exist for the same logical controller action. Keep only canonical subtyped services.
     */
    const canonicalSwitchSubtypes = new Set(['Inclusion', 'Exclusion', 'Heal', 'Prune']);
    const seenCanonicalSwitchSubtypes = new Set<string>();
    this.platformAccessory.services.slice().forEach((service) => {
      if (service.UUID !== this.platform.Service.Switch.UUID) {
        return;
      }

      const subtype = (service as unknown as { subtype?: string }).subtype;
      if (!subtype || !canonicalSwitchSubtypes.has(subtype)) {
        this.platform.log.info(
          `Pruning legacy controller switch service: ${service.displayName} (${service.UUID})`,
        );
        this.platformAccessory.removeService(service);
        return;
      }

      if (seenCanonicalSwitchSubtypes.has(subtype)) {
        this.platform.log.info(
          `Pruning duplicate controller switch service (${subtype}): ${service.displayName}`,
        );
        this.platformAccessory.removeService(service);
        return;
      }

      seenCanonicalSwitchSubtypes.add(subtype);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const managerServiceType = (this.platform.Service as any).ZWaveManager;
    this.statusService =
      this.platformAccessory.getService(MANAGER_SERVICE_UUID) ||
      this.platformAccessory.addService(new managerServiceType('System Status', 'Status'));
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
      .onSet((value: CharacteristicValue) => {
        void this.handleSetInclusion(value);
      });

    this.exclusionService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet((value: CharacteristicValue) => {
        void this.handleSetExclusion(value);
      });

    this.healService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet((value: CharacteristicValue) => {
        void this.handleSetHeal(value);
      });

    this.pruneService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet((value: CharacteristicValue) => {
        void this.handleSetPrune(value);
      });

    // Initialize all control switches to OFF in the cached characteristic state.
    this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    this.healService.updateCharacteristic(this.platform.Characteristic.On, false);
    this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);

    // --- Listen for controller events to sync state ---
    this.setupControllerHandlers();
  }

  private setupControllerHandlers() {
    this.handlers = {
      'status updated': (status: string) => {
        this.statusChar.updateValue(status);
      },
      'inclusion started': () => {
        this.platform.log.info('Controller event: Inclusion Started');
        this.isInclusionActive = true;
        this.isExclusionActive = false;
        this.isPruneActive = false;
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
      },
      'inclusion stopped': () => {
        this.platform.log.info('Controller event: Inclusion Stopped');
        this.isInclusionActive = false;
        if (this.inclusionTimer) {
          clearTimeout(this.inclusionTimer);
          this.inclusionTimer = undefined;
        }
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
      },
      'exclusion started': () => {
        this.platform.log.info('Controller event: Exclusion Started');
        this.isExclusionActive = true;
        this.isInclusionActive = false;
        this.isPruneActive = false;
        if (this.inclusionTimer) {
          clearTimeout(this.inclusionTimer);
          this.inclusionTimer = undefined;
        }
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
      },
      'exclusion stopped': () => {
        this.platform.log.info('Controller event: Exclusion Stopped');
        this.isExclusionActive = false;
        if (this.exclusionTimer) {
          clearTimeout(this.exclusionTimer);
          this.exclusionTimer = undefined;
        }
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
      },
      'heal network progress': (progress: Map<number, unknown>) => {
        const done = Array.from(progress.values()).filter((v) => v !== 0).length;
        const total = progress.size;
        this.statusChar.updateValue(`Heal: ${done}/${total}`);
      },
      'heal network done': () => {
        this.platform.log.info('Controller event: Heal Network Done. Resetting UI switch.');
        this.isHealActive = false;
        // Use a slight delay to ensure HomeKit UI catches the state change correctly
        setTimeout(() => {
          this.healService.updateCharacteristic(this.platform.Characteristic.On, false);
          this.platform.log.debug('Heal Network switch set to OFF');
        }, 500);
      },
    };

    for (const [event, handler] of Object.entries(this.handlers)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.controller.on(event as any, handler);
    }
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

    try {
      if (value) {
        const wasExclusionActive = this.isExclusionActive;
        const wasHealActive = this.isHealActive;

        this.isInclusionActive = true;
        this.isExclusionActive = false;
        this.isHealActive = false;
        this.isPruneActive = false;
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.healService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);

        // MUTEX: Turn off others
        if (wasExclusionActive) {
          await this.controller.stopExclusion();
        }
        if (wasHealActive) {
          await this.controller.stopHealing();
        }

        const timeoutSeconds = this.platform.config.inclusionTimeoutSeconds || 60;
        this.platform.log.info(`Requesting Inclusion Mode ON (Timeout: ${timeoutSeconds}s)`);

        const started = await this.controller.startInclusion();
        if (!started) {
          /**
           * Z-Wave JS returns false when inclusion is already active.
           * Keep switch ON and let controller events/timeout converge the final state.
           */
          this.platform.log.warn(
            'Inclusion start request returned false (possibly already active). Keeping UI state ON.',
          );
        }
        this.isInclusionActive = true;
        this.inclusionTimer = setTimeout(async () => {
          this.platform.log.info('Inclusion Mode timed out');
          await this.controller.stopInclusion();
          this.isInclusionActive = false;
          this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        }, timeoutSeconds * 1000);
      } else {
        this.platform.log.info('Requesting Inclusion Mode OFF');
        this.isInclusionActive = false;
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        await this.controller.stopInclusion();
      }
    } catch (err) {
      this.platform.log.error('Failed to set inclusion mode:', err);
      this.isInclusionActive = false;
      this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    }
  }

  private async handleSetExclusion(value: CharacteristicValue) {
    if (this.exclusionTimer) {
      clearTimeout(this.exclusionTimer);
      this.exclusionTimer = undefined;
    }

    try {
      if (value) {
        const wasInclusionActive = this.isInclusionActive;
        const wasHealActive = this.isHealActive;

        this.isExclusionActive = true;
        this.isInclusionActive = false;
        this.isHealActive = false;
        this.isPruneActive = false;
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, true);
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.healService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);

        // MUTEX: Turn off others
        if (wasInclusionActive) {
          await this.controller.stopInclusion();
        }
        if (wasHealActive) {
          await this.controller.stopHealing();
        }

        const timeoutSeconds = this.platform.config.inclusionTimeoutSeconds || 60;
        this.platform.log.info(`Requesting Exclusion Mode ON (Timeout: ${timeoutSeconds}s)`);

        const started = await this.controller.startExclusion();
        if (!started) {
          this.platform.log.warn(
            'Exclusion start request returned false (possibly already active). Keeping UI state ON.',
          );
        }
        this.isExclusionActive = true;
        this.exclusionTimer = setTimeout(async () => {
          this.platform.log.info('Exclusion Mode timed out');
          await this.controller.stopExclusion();
          this.isExclusionActive = false;
          this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        }, timeoutSeconds * 1000);
      } else {
        this.platform.log.info('Requesting Exclusion Mode OFF');
        this.isExclusionActive = false;
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        await this.controller.stopExclusion();
      }
    } catch (err) {
      this.platform.log.error('Failed to set exclusion mode:', err);
      this.isExclusionActive = false;
      this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
    }
  }

  private async handleSetHeal(value: CharacteristicValue) {
    try {
      if (value) {
        const wasInclusionActive = this.isInclusionActive;
        const wasExclusionActive = this.isExclusionActive;

        this.isHealActive = true;
        this.isInclusionActive = false;
        this.isExclusionActive = false;
        this.isPruneActive = false;
        this.healService.updateCharacteristic(this.platform.Characteristic.On, true);
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);

        // MUTEX
        if (wasInclusionActive) {
          await this.controller.stopInclusion();
        }
        if (wasExclusionActive) {
          await this.controller.stopExclusion();
        }

        this.platform.log.info('Requesting Heal Network ON');
        const started = await this.controller.startHealing();
        if (!started) {
          this.platform.log.warn(
            'Heal start request returned false (possibly already active). Keeping UI state ON.',
          );
        }
        this.isHealActive = true;
      } else {
        this.platform.log.info('Requesting Heal Network OFF');
        this.isHealActive = false;
        this.healService.updateCharacteristic(this.platform.Characteristic.On, false);
        await this.controller.stopHealing();
      }
    } catch (err) {
      this.platform.log.error('Failed to set heal state:', err);
      this.isHealActive = false;
      this.healService.updateCharacteristic(this.platform.Characteristic.On, false);
    }
  }

  private async handleSetPrune(value: CharacteristicValue) {
    try {
      if (value) {
        const wasInclusionActive = this.isInclusionActive;
        const wasExclusionActive = this.isExclusionActive;
        const wasHealActive = this.isHealActive;

        this.isPruneActive = true;
        this.isInclusionActive = false;
        this.isExclusionActive = false;
        this.isHealActive = false;
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, true);
        this.inclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.exclusionService.updateCharacteristic(this.platform.Characteristic.On, false);
        this.healService.updateCharacteristic(this.platform.Characteristic.On, false);

        /**
         * MUTEX FIX: Ensure only one management task is active.
         */
        try {
          if (wasInclusionActive) {
            await this.controller.stopInclusion();
          }
          if (wasExclusionActive) {
            await this.controller.stopExclusion();
          }
          if (wasHealActive) {
            await this.controller.stopHealing();
          }
        } catch { /* ignore */ }

        this.platform.log.info('Requesting Prune Dead Nodes...');

        // Find all Dead nodes
        const deadNodeIds: number[] = [];
        for (const [nodeId, node] of this.controller.nodes) {
          /**
           * PRUNE FIX: Check for correct Dead status (3).
           * NodeStatus Enum (zwave-js):
           * 0: Unknown
           * 1: Asleep
           * 2: Awake
           * 3: Dead
           * 4: Alive
           */
          if (nodeId !== 1 && node.status === 3) {
            deadNodeIds.push(nodeId);
          } else if (node.status === 1) {
            this.platform.log.debug(`Prune: Node ${nodeId} is ASLEEP (Battery). Skipping.`);
          }
        }

        if (deadNodeIds.length === 0) {
          this.platform.log.info('No Dead nodes found to prune.');
          this.isPruneActive = false;
          setTimeout(() => {
            this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
          }, 100);
          return;
        }

        this.platform.log.info(`Found ${deadNodeIds.length} dead nodes: ${deadNodeIds.join(', ')}`);

        for (const nodeId of deadNodeIds) {
          if (!this.isPruneActive) {
            this.platform.log.info('Pruning interrupted by user.');
            break;
          }
          try {
            await this.controller.removeFailedNode(nodeId);
          } catch (err) {
            this.platform.log.error(`Failed to prune node ${nodeId}:`, err);
          }
        }

        this.platform.log.info('Pruning complete.');
        this.isPruneActive = false;
        setTimeout(() => {
          this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
        }, 500);
      } else {
        this.isPruneActive = false;
        this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
      }
    } catch (err) {
      this.platform.log.error('Failed to set prune state:', err);
      this.isPruneActive = false;
      this.pruneService.updateCharacteristic(this.platform.Characteristic.On, false);
    }
  }

  public stop() {
    this.isPruneActive = false;
    if (this.inclusionTimer) {
      clearTimeout(this.inclusionTimer);
    }
    if (this.exclusionTimer) {
      clearTimeout(this.exclusionTimer);
    }

    // Cleanup listeners
    for (const [event, handler] of Object.entries(this.handlers)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.controller.off(event as any, handler);
    }
    this.handlers = {};
  }
}
