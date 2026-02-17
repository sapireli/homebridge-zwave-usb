import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import http from 'http';
import path from 'path';
import fs from 'fs';
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
  private ipcServer?: http.Server;

  /**
   * RACE CONDITION FIX: Track which nodes are currently being created
   * to prevent duplicate accessories if multiple events fire rapidly.
   */
  private discoveryInFlight = new Set<number>();
  private firmwareProgress = new Map<number, { sent: number; total: number; status?: number }>();

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

      this.zwaveController.on('firmware update progress', (nodeId, sent, total) => {
        this.firmwareProgress.set(nodeId, { sent, total });
      });

      this.zwaveController.on('firmware update finished', (nodeId, status) => {
        this.firmwareProgress.set(nodeId, { sent: 100, total: 100, status });
        setTimeout(() => this.firmwareProgress.delete(nodeId), 30000); // Clear after 30s
      });

      this.api.on('didFinishLaunching', async () => {
        try {
          this.log.debug('Executed didFinishLaunching callback');
          await this.connectToZWaveController();
          this.startIpcServer();
        } catch (err) {
          this.log.error('Error during didFinishLaunching:', err);
        }
      });

      this.api.on('shutdown', async () => {
        this.log.info('Shutting down Z-Wave controller...');
        this.stopIpcServer();
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

  private startIpcServer() {
    this.ipcServer = http.createServer((req, res) => {
      const { method } = req;
      const url = req.url?.split('?')[0] || ''; // Strip query params
      const normalizedUrl = url.endsWith('/') && url.length > 1 ? url.slice(0, -1) : url;

      this.log.debug(`IPC Management Request: ${method} ${normalizedUrl}`);

      const sendJson = (data: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      try {
        if (normalizedUrl === '/nodes' && method === 'GET') {
          const nodes = Array.from(this.zwaveController?.nodes.values() || []).map((node) => ({
            nodeId: node.nodeId,
            name: node.name,
            label: node.deviceConfig?.label,
            manufacturer: node.deviceConfig?.manufacturer,
            status: node.status,
            ready: node.ready,
            firmwareVersion: node.firmwareVersion,
            isListening: node.isListening,
            isFrequentListening: node.isFrequentListening,
            firmwareProgress: this.firmwareProgress.get(node.nodeId),
          }));
          return sendJson(nodes);
        }

        if (normalizedUrl.startsWith('/nodes/') && normalizedUrl.endsWith('/name') && method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            try {
              const parts = normalizedUrl.split('/');
              const nodeId = parseInt(parts[2], 10);
              const { name } = JSON.parse(body);

              if (!this.zwaveController) {
                throw new Error('Controller not initialized');
              }

              this.zwaveController.setNodeName(nodeId, name);

              // Update Homebridge Accessory Name
              const accessory = this.zwaveAccessories.get(nodeId);
              if (accessory) {
                accessory.rename(name);
              }

              return sendJson({ success: true });
            } catch (err) {
              this.log.error(`Failed to rename node: ${err}`);
              return sendJson({ error: err instanceof Error ? err.message : String(err) }, 500);
            }
          });
          return;
        }

        if (normalizedUrl.startsWith('/firmware/updates/') && method === 'GET') {
          const nodeId = parseInt(normalizedUrl.split('/').pop() || '0', 10);
          this.zwaveController?.getAvailableFirmwareUpdates(nodeId)
            .then((updates) => sendJson(updates))
            .catch((err) => sendJson({ error: err.message }, 500));
          return;
        }

        if (normalizedUrl.startsWith('/firmware/update/') && method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            const nodeId = parseInt(normalizedUrl.split('/').pop() || '0', 10);
            const update = JSON.parse(body);
            this.zwaveController?.beginFirmwareUpdate(nodeId, update)
              .then(() => sendJson({ success: true }))
              .catch((err) => sendJson({ error: err.message }, 500));
          });
          return;
        }

        if (normalizedUrl.startsWith('/firmware/abort/') && method === 'POST') {
          const nodeId = parseInt(normalizedUrl.split('/').pop() || '0', 10);
          this.zwaveController?.abortFirmwareUpdate(nodeId)
            .then(() => sendJson({ success: true }))
            .catch((err) => sendJson({ error: err.message }, 500));
          return;
        }

        this.log.warn(`IPC Management: Path not found: ${normalizedUrl}`);
        sendJson({ error: `Path not found: ${normalizedUrl}` }, 404);
      } catch (err) {
        this.log.error(`IPC Management Error: ${err}`);
        sendJson({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });

    this.ipcServer.listen(0, '127.0.0.1', () => {
      const address = this.ipcServer?.address();
      if (address && typeof address !== 'string') {
        const portFile = path.join(this.api.user.storagePath(), 'homebridge-zwave-usb.port');
        fs.writeFileSync(portFile, address.port.toString());
        this.log.debug(`IPC Server listening on port ${address.port}`);
      }
    });

    this.ipcServer.on('error', (err) => {
      this.log.error('IPC Server error:', err);
    });
  }

  private stopIpcServer() {
    if (this.ipcServer) {
      this.ipcServer.close();
      const portFile = path.join(this.api.user.storagePath(), 'homebridge-zwave-usb.port');
      if (fs.existsSync(portFile)) {
        fs.unlinkSync(portFile);
      }
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
    const nodeName = node.name || node.deviceConfig?.label || `Node ${node.nodeId}`;
    this.log.info(`Node ${node.nodeId} (${nodeName}) ready`);

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
        if (existing.platformAccessory.displayName !== nodeName) {
          existing.rename(nodeName);
        }
        existing.refresh();
      }
      return;
    }

    this.discoveryInFlight.add(node.nodeId);
    try {
      const accessory = AccessoryFactory.create(this, node, homeId);
      this.zwaveAccessories.set(node.nodeId, accessory);

      if (accessory.platformAccessory.displayName !== nodeName) {
        accessory.rename(nodeName);
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
       * CALE LEAK FIX: Also remove from the primary accessories array
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
