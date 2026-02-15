import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { ZWaveController } from '../zwave/ZWaveController';
import { IZWaveController, IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveAccessory } from '../accessories/ZWaveAccessory';
import { AccessoryFactory } from '../accessories/AccessoryFactory';
import { ControllerAccessory } from '../accessories/ControllerAccessory';
import {
  STATUS_CHAR_UUID,
  PIN_CHAR_UUID,
  MANAGER_SERVICE_UUID,
  HAPFormat,
  HAPPerm,
} from './settings';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../package.json');

export class ZWaveUsbPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  private zwaveController: IZWaveController | undefined;
  private readonly zwaveAccessories = new Map<number, ZWaveAccessory>();
  private controllerAccessory: ControllerAccessory | undefined;
  private retryTimeout?: NodeJS.Timeout;
  private reconciliationTimeout?: NodeJS.Timeout;

  /**
   * RACE CONDITION FIX: Track which nodes are currently being created
   * to prevent duplicate accessories if multiple events fire rapidly.
   */
  private discoveryInFlight = new Set<number>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    try {
      // Register Custom Characteristics for S2 PIN and Status
      this.registerCustomCharacteristics();

      this.log.info(`Initializing Homebridge Z-Wave USB v${packageJson.version}`);
      this.log.debug('Finished initializing platform:', this.config.name);

      if (
        !this.config.serialPort ||
        typeof this.config.serialPort !== 'string' ||
        this.config.serialPort.trim() === ''
      ) {
        this.log.error('Invalid or missing "serialPort" configuration. Plugin will not start.');
        return;
      }

      this.log.info(`Initializing Z-Wave Local Driver on ${this.config.serialPort}`);
      this.zwaveController = new ZWaveController(this.log, this.config.serialPort, {
        securityKeys: this.config.securityKeys,
        debug: this.config.debug,
        storagePath: this.api.user.storagePath(),
      });

      // Setup listeners
      this.zwaveController.on('node added', (node) => this.handleNodeAdded(node));
      this.zwaveController.on('node ready', (node) => this.handleNodeReady(node));
      this.zwaveController.on('node removed', (node) => this.handleNodeRemoved(node));
      this.zwaveController.on('value notification', (node, args) =>
        this.handleValueNotification(node, args),
      );
      this.zwaveController.on('value updated', (node, args) => this.handleValueUpdated(node, args));

      this.api.on('didFinishLaunching', async () => {
        try {
          this.log.debug('Executed didFinishLaunching callback');
          await this.connectToZWaveController();
        } catch (err) {
          this.log.error('Error during didFinishLaunching:', err);
        }
      });

      this.api.on('shutdown', async () => {
        this.log.info('Shutting down Z-Wave controller...');
        if (this.retryTimeout) {
          clearTimeout(this.retryTimeout);
        }
        if (this.reconciliationTimeout) {
          clearTimeout(this.reconciliationTimeout);
        }
        for (const acc of this.zwaveAccessories.values()) {
          acc.stop();
        }
        this.controllerAccessory?.stop();
        await this.zwaveController?.stop();
      });
    } catch (err) {
      this.log.error('Critical error during plugin initialization. Plugin will be disabled.');
      this.log.error(err instanceof Error ? err.message : String(err));
    }
  }

  private registerCustomCharacteristics() {
    const { Characteristic, Service } = this.api.hap;
    this.log.debug('Registering custom HomeKit characteristics...');

    // 1. Z-Wave Status Characteristic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Characteristic as any).ZWaveStatus = class extends Characteristic {
      static readonly UUID = STATUS_CHAR_UUID;
      constructor() {
        super('System Status', STATUS_CHAR_UUID, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          format: HAPFormat.STRING as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          perms: [HAPPerm.PAIRED_READ as any, HAPPerm.NOTIFY as any],
        });
        this.value = 'Initializing...';
      }
    };

    // 2. S2 PIN Entry Characteristic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Characteristic as any).S2PinEntry = class extends Characteristic {
      static readonly UUID = PIN_CHAR_UUID;
      constructor() {
        super('S2 PIN Entry', PIN_CHAR_UUID, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          format: HAPFormat.UINT32 as any,
          minValue: 0,
          maxValue: 99999,
          minStep: 1,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          perms: [HAPPerm.PAIRED_READ as any, HAPPerm.NOTIFY as any, HAPPerm.PAIRED_WRITE as any],
        });
        this.value = 0;
      }
    };

    // 3. Z-Wave Manager Service
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Service as any).ZWaveManager = class extends Service {
      static readonly UUID = MANAGER_SERVICE_UUID;
      constructor(displayName: string, subtype?: string) {
        super(displayName, MANAGER_SERVICE_UUID, subtype);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.addOptionalCharacteristic((Characteristic as any).ZWaveStatus);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.addOptionalCharacteristic((Characteristic as any).S2PinEntry);
        this.addOptionalCharacteristic(Characteristic.ServiceLabelIndex);
      }
    };
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private async connectToZWaveController() {
    if (!this.zwaveController) {
      return;
    }
    this.log.info('Connecting to Z-Wave controller...');

    try {
      await this.zwaveController.start();
      this.log.info('Z-Wave controller connected successfully.');

      // RESOURCE LEAK FIX: Stop previous accessory instances before re-creating
      if (this.controllerAccessory) {
        this.controllerAccessory.stop();
      }
      this.controllerAccessory = new ControllerAccessory(this, this.zwaveController);

      /**
       * Startup Reconciliation:
       * 60 seconds after startup, we compare the accessories found in the cache
       * against the nodes actually present in the Z-Wave network.
       */
      if (this.reconciliationTimeout) {
        clearTimeout(this.reconciliationTimeout);
      }
      this.reconciliationTimeout = setTimeout(() => {
        const managedUuids = new Set<string>();
        if (this.controllerAccessory) {
          managedUuids.add(this.controllerAccessory.platformAccessory.UUID);
        }
        for (const acc of this.zwaveAccessories.values()) {
          managedUuids.add(acc.platformAccessory.UUID);
        }

        this.log.debug(
          `Reconciliation: ${managedUuids.size} managed accessories, ${this.accessories.length} in cache.`,
        );

        const orphaned = this.accessories.filter((acc) => {
          const isOrphaned = !managedUuids.has(acc.UUID);
          if (isOrphaned) {
            this.log.info(`Found orphaned accessory in cache: ${acc.displayName} (${acc.UUID})`);
          }
          return isOrphaned;
        });

        if (orphaned.length > 0) {
          this.log.info(`Removing ${orphaned.length} orphaned accessories from cache...`);
          try {
            this.api.unregisterPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', orphaned);

            // Correctly update the local accessories list without dangerous splice during iteration
            const orphanedUuids = new Set(orphaned.map((o) => o.UUID));
            const remaining = this.accessories.filter((a) => !orphanedUuids.has(a.UUID));
            this.accessories.length = 0;
            this.accessories.push(...remaining);

            this.log.info('Successfully removed orphaned accessories.');
          } catch (err) {
            this.log.error('Failed to unregister orphaned accessories:', err);
          }
        }
      }, 60000);
    } catch (err) {
      this.log.error(
        `Failed to connect to Z-Wave controller: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.log.warn('Z-Wave stick may be unplugged or busy. Retrying in 30 seconds...');

      this.retryTimeout = setTimeout(() => {
        this.connectToZWaveController();
      }, 30000);
    }
  }

  private handleNodeAdded(node: IZWaveNode) {
    this.log.info(`Node ${node.nodeId} added to the network. Waiting for interview to complete...`);
  }

  private handleNodeReady(node: IZWaveNode) {
    this.log.info(`Node ${node.nodeId} ready`);

    // Skip Node 1 (the controller itself) as it's handled by ControllerAccessory
    if (Number(node.nodeId) === 1) {
      this.log.info(
        'System: Controller node (Node 1) identified. Skipping generic accessory creation.',
      );
      return;
    }

    if (!node.ready) {
      this.log.warn(`Node ${node.nodeId} reported ready but node.ready is false, skipping...`);
      return;
    }

    const homeId = this.zwaveController?.homeId;
    if (!homeId) {
      this.log.error(`Cannot create accessory for Node ${node.nodeId} - Home ID not available`);
      return;
    }

    const existing = this.zwaveAccessories.get(node.nodeId);
    if (existing || this.discoveryInFlight.has(node.nodeId)) {
      if (existing) {
        existing.updateNode(node);
        existing.refresh();
      }
      return;
    }

    this.discoveryInFlight.add(node.nodeId);
    try {
      const accessory = AccessoryFactory.create(this, node, homeId);
      this.zwaveAccessories.set(node.nodeId, accessory);

      const nodeName = node.name || node.deviceConfig?.label || `Node ${node.nodeId}`;
      if (accessory.platformAccessory.displayName !== nodeName) {
        this.log.info(`Renaming accessory ${accessory.platformAccessory.displayName} -> ${nodeName}`);
        accessory.platformAccessory.displayName = nodeName;
        this.api.updatePlatformAccessories([accessory.platformAccessory]);
      }

      accessory.initialize();
    } finally {
      this.discoveryInFlight.delete(node.nodeId);
    }
  }

  private handleNodeRemoved(node: IZWaveNode) {
    this.log.info(`Node ${node.nodeId} removed`);

    const accessory = this.zwaveAccessories.get(node.nodeId);
    if (accessory) {
      accessory.stop();
      this.api.unregisterPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        accessory.platformAccessory,
      ]);
      this.zwaveAccessories.delete(node.nodeId);

      /**
       * CACHE LEAK FIX: Also remove from the primary accessories array
       * to prevent memory leaks and reconciliation ghosts.
       */
      const index = this.accessories.indexOf(accessory.platformAccessory);
      if (index !== -1) {
        this.accessories.splice(index, 1);
      }
    }
  }

  /**
   * Event-Driven Updates:
   * Instead of refreshing every accessory on every change, we route the specific
   * Z-Wave change (args) to the corresponding accessory for granular updates.
   */
  private handleValueUpdated(node: IZWaveNode, args: ZWaveValueEvent) {
    this.log.debug(`Node ${node.nodeId} value updated`);
    const accessory = this.zwaveAccessories.get(node.nodeId);
    if (accessory) {
      accessory.refresh(args);
    }
  }

  private handleValueNotification(node: IZWaveNode, args: ZWaveValueEvent) {
    this.log.debug(`Node ${node.nodeId} value notification`);
    const accessory = this.zwaveAccessories.get(node.nodeId);
    if (accessory) {
      accessory.refresh(args);
    }
  }
}
