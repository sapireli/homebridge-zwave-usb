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
  private ipcServer?: http.Server;

  /**
   * RACE CONDITION FIX: Track which nodes are currently being created
   * to prevent duplicate accessories if multiple events fire rapidly.
   */
  private discoveryInFlight = new Set<number>();
  private firmwareProgress = new Map<number, { sent: number; total: number; status?: number }>();
  private refreshStates = new Map<number, 'waiting-wakeup' | 'refreshing'>();

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
      this.zwaveController.on('node updated', (node) => this.handleNodeUpdated(node));
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
            label: node.label || node.deviceConfig?.label,
            manufacturer: node.manufacturer || node.deviceConfig?.manufacturer,
            status: node.status,
            ready: node.ready,
            firmwareVersion: node.firmwareVersion,
            isListening: node.isListening,
            isFrequentListening: node.isFrequentListening,
            firmwareProgress: this.firmwareProgress.get(node.nodeId),
            refreshState: this.refreshStates.get(node.nodeId),
            homekitState: this.getHomeKitPublicationState(node),
          }));
          return sendJson(nodes);
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/name') &&
          method === 'POST'
        ) {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const parts = normalizedUrl.split('/');
              const nodeId = parseInt(parts[2], 10);
              const { name } = JSON.parse(body);

              if (!this.zwaveController) {
                throw new Error('Controller not initialized');
              }

              await this.zwaveController.setNodeName(nodeId, name);

              const node = this.zwaveController.nodes.get(nodeId);
              if (node) {
                const accessory = this.zwaveAccessories.get(nodeId);
                if (accessory) {
                  accessory.rename(name);
                }
              }

              return sendJson({ success: true });
            } catch (err) {
              this.log.error(`Failed to rename node: ${err}`);
              return sendJson({ error: err instanceof Error ? err.message : String(err) }, 500);
            }
          });
          return;
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/refresh-info') &&
          method === 'POST'
        ) {
          const parts = normalizedUrl.split('/');
          const nodeId = parseInt(parts[2], 10);
          this.zwaveController
            ?.refreshNodeInfo(nodeId)
            .then((result) => {
              this.refreshStates.set(
                nodeId,
                result.requiresWakeUp ? 'waiting-wakeup' : 'refreshing',
              );
              sendJson({
                success: true,
                refreshState: this.refreshStates.get(nodeId),
                ...result,
              });
            })
            .catch((err) => sendJson({ error: err.message }, 500));
          return;
        }

        if (normalizedUrl === '/accessories/prune-stale' && method === 'POST') {
          try {
            const removed = this.pruneStaleAccessories();
            return sendJson({ success: true, removed });
          } catch (err) {
            this.log.error(`Failed to prune stale accessories: ${err}`);
            return sendJson({ error: err instanceof Error ? err.message : String(err) }, 500);
          }
        }

        if (normalizedUrl.startsWith('/firmware/updates/') && method === 'GET') {
          const nodeId = parseInt(normalizedUrl.split('/').pop() || '0', 10);
          this.zwaveController
            ?.getAvailableFirmwareUpdates(nodeId)
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
            this.zwaveController
              ?.beginFirmwareUpdate(nodeId, update)
              .then(() => sendJson({ success: true }))
              .catch((err) => sendJson({ error: err.message }, 500));
          });
          return;
        }

        if (normalizedUrl.startsWith('/firmware/abort/') && method === 'POST') {
          const nodeId = parseInt(normalizedUrl.split('/').pop() || '0', 10);
          this.zwaveController
            ?.abortFirmwareUpdate(nodeId)
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
        try {
          const storagePath = this.api.user.storagePath();
          if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath, { recursive: true });
          }
          const portFile = path.join(storagePath, 'homebridge-zwave-usb.port');
          fs.writeFileSync(portFile, address.port.toString());
          this.log.debug(`IPC Server listening on port ${address.port}`);
        } catch (err) {
          this.log.error(`Failed to write IPC port file: ${err}`);
        }
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
    this.syncNodeAccessory(node);
  }

  private handleNodeReady(node: IZWaveNode) {
    this.refreshStates.delete(node.nodeId);
    const nodeName = node.name || node.label || node.deviceConfig?.label || `Node ${node.nodeId}`;
    this.log.info(`Node ${node.nodeId} (${nodeName}) ready`);
    this.syncNodeAccessory(node);
  }

  private handleNodeUpdated(node: IZWaveNode) {
    const refreshState = this.refreshStates.get(node.nodeId);
    if (refreshState) {
      if (node.ready) {
        this.refreshStates.delete(node.nodeId);
      } else if (node.status !== 1) {
        this.refreshStates.set(node.nodeId, 'refreshing');
      }
    }
    this.syncNodeAccessory(node);
  }

  private syncNodeAccessory(node: IZWaveNode) {
    // Skip Node 1 (the controller itself) as it's handled by ControllerAccessory
    if (Number(node.nodeId) === 1) {
      this.log.info(
        'System: Controller node (Node 1) identified. Skipping generic accessory creation.',
      );
      return;
    }

    const homeId = this.zwaveController?.homeId;
    if (!homeId) {
      this.log.error(`Cannot create accessory for Node ${node.nodeId} - Home ID not available`);
      return;
    }

    const graphSignature = node.ready ? AccessoryFactory.getGraphSignature(node) : undefined;

    const existing = this.zwaveAccessories.get(node.nodeId);
    if (existing || this.discoveryInFlight.has(node.nodeId)) {
      if (existing) {
        if (node.ready && !existing.isInitialized()) {
          existing.stop();
          const hydratedAccessory = AccessoryFactory.create(this, node, homeId);
          this.zwaveAccessories.set(node.nodeId, hydratedAccessory);
          hydratedAccessory.initialize();
          return;
        }

        if (
          node.ready &&
          existing.isInitialized() &&
          graphSignature !== undefined &&
          existing.getGraphSignature() !== graphSignature
        ) {
          this.log.info(
            `Rebuilding accessory graph for Node ${node.nodeId} after capability change was detected.`,
          );
          existing.stop();
          const reconciledAccessory = AccessoryFactory.create(this, node, homeId);
          this.zwaveAccessories.set(node.nodeId, reconciledAccessory);
          reconciledAccessory.initialize({ pruneUnmanagedServices: true });
          return;
        }

        existing.updateNode(node);
        existing.refresh();
      }
      return;
    }

    const cachedAccessory = this.accessories.find((accessory) => {
      const context = accessory.context as { nodeId?: number; homeId?: number } | undefined;
      return context?.nodeId === node.nodeId && context?.homeId === homeId;
    });

    this.discoveryInFlight.add(node.nodeId);
    try {
      if (!node.ready) {
        if (!this.shouldCreateAccessoryForUnreadyNode(cachedAccessory)) {
          this.log.info(
            `Deferring brand-new accessory creation for unready Node ${node.nodeId} until interview metadata is available.`,
          );
          return;
        }

        this.log.info(
          `Refreshing cached accessory for Node ${node.nodeId} before interview completion so HomeKit can surface fault state.`,
        );
      }
      const accessory = AccessoryFactory.create(this, node, homeId);
      this.zwaveAccessories.set(node.nodeId, accessory);

      if (node.ready) {
        accessory.initialize(); // Initialize first to create functional services
      } else {
        accessory.refresh();
      }
    } finally {
      this.discoveryInFlight.delete(node.nodeId);
    }
  }

  private shouldCreateAccessoryForUnreadyNode(cachedAccessory: PlatformAccessory | undefined): boolean {
    // Intentionally only materialize unready nodes if HomeKit already knows about them.
    // Brand-new unready nodes are deferred until feature metadata is complete, which keeps
    // the service graph stable and avoids publishing half-built accessories.
    return Boolean(cachedAccessory);
  }

  private getHomeKitPublicationState(node: IZWaveNode): 'controller' | 'published' | 'cached-pending' | 'pending-interview' {
    if (Number(node.nodeId) === 1) {
      return 'controller';
    }

    const homeId = this.zwaveController?.homeId;
    const hasLiveAccessory = this.zwaveAccessories.has(node.nodeId);
    const hasCachedAccessory = this.accessories.some((accessory) => {
      const context = accessory.context as { nodeId?: number; homeId?: number } | undefined;
      return context?.nodeId === node.nodeId && context?.homeId === homeId;
    });

    if (node.ready) {
      return 'published';
    }

    if (hasCachedAccessory) {
      return 'cached-pending';
    }

    if (hasLiveAccessory) {
      return 'published';
    }

    return 'pending-interview';
  }

  private pruneStaleAccessories(): number {
    const currentNodeIds = new Set(Array.from(this.zwaveController?.nodes.keys() || []));
    const staleAccessories = this.accessories.filter((acc) => {
      const context = acc.context as { nodeId?: number; homeId?: number } | undefined;
      return (
        context?.homeId === this.zwaveController?.homeId &&
        context?.nodeId != null &&
        !currentNodeIds.has(context.nodeId)
      );
    });

    if (staleAccessories.length === 0) {
      return 0;
    }

    this.api.unregisterPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', staleAccessories);

    const staleUuids = new Set(staleAccessories.map((accessory) => accessory.UUID));
    const staleNodeIds = new Set(
      staleAccessories
        .map((accessory) => {
          const context = accessory.context as { nodeId?: number } | undefined;
          return context?.nodeId;
        })
        .filter((nodeId): nodeId is number => nodeId != null),
    );
    const remaining = this.accessories.filter((accessory) => !staleUuids.has(accessory.UUID));
    this.accessories.length = 0;
    this.accessories.push(...remaining);
    staleNodeIds.forEach((nodeId) => this.zwaveAccessories.delete(nodeId));

    return staleAccessories.length;
  }

  private handleNodeRemoved(node: IZWaveNode) {
    this.refreshStates.delete(node.nodeId);
    this.log.info(`Node ${node.nodeId} removed`);

    const homeId = this.zwaveController?.homeId;
    const liveAccessory = this.zwaveAccessories.get(node.nodeId);
    const cachedAccessories = this.accessories.filter((accessory) => {
      const context = accessory.context as { nodeId?: number; homeId?: number } | undefined;
      return context?.nodeId === node.nodeId && context?.homeId === homeId;
    });

    if (liveAccessory) {
      liveAccessory.stop();
      this.zwaveAccessories.delete(node.nodeId);
    }

    const accessoriesToRemove = liveAccessory
      ? Array.from(new Set([liveAccessory.platformAccessory, ...cachedAccessories]))
      : cachedAccessories;

    if (accessoriesToRemove.length > 0) {
      this.api.unregisterPlatformAccessories(
        'homebridge-zwave-usb',
        'ZWaveUSB',
        accessoriesToRemove,
      );

      const removedUuids = new Set(accessoriesToRemove.map((accessory) => accessory.UUID));
      const remainingAccessories = this.accessories.filter(
        (accessory) => !removedUuids.has(accessory.UUID),
      );
      this.accessories.length = 0;
      this.accessories.push(...remainingAccessories);
    }
  }

  /**
   * Event-Driven Updates:
   * Instead of refreshing every accessory on every change, we route the specific
   * Z-Wave change (args) to the corresponding accessory for granular updates.
   */
  private handleValueUpdated(node: IZWaveNode, args: ZWaveValueEvent) {
    this.log.debug(`Node ${node.nodeId} value updated`);
    this.logValueEventDetails(node, 'value updated', args);
    const accessory = this.zwaveAccessories.get(node.nodeId);
    if (accessory) {
      accessory.refresh(args);
    }
  }

  private handleValueNotification(node: IZWaveNode, args: ZWaveValueEvent) {
    this.log.debug(`Node ${node.nodeId} value notification`);
    this.logValueEventDetails(node, 'value notification', args);
    const accessory = this.zwaveAccessories.get(node.nodeId);
    if (accessory) {
      accessory.refresh(args);
    }
  }

  private logValueEventDetails(
    node: IZWaveNode,
    eventType: 'value updated' | 'value notification',
    args: ZWaveValueEvent,
  ): void {
    if (!this.config.debug) {
      return;
    }

    const payload = {
      commandClass: args.commandClass,
      endpoint: args.endpoint ?? 0,
      property: args.property,
      propertyKey: args.propertyKey,
      newValue: this.serializeLogValue(args.newValue),
      prevValue: this.serializeLogValue(args.prevValue),
    };

    this.log.debug(`Node ${node.nodeId} ${eventType} payload: ${JSON.stringify(payload)}`);
  }

  private serializeLogValue(value: unknown): unknown {
    if (value === undefined || value === null) {
      return value;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (value instanceof Buffer) {
      return value.toString('hex');
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.serializeLogValue(entry));
    }

    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          this.serializeLogValue(entry),
        ]),
      );
    }

    return value;
  }
}
