import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { ZWaveController } from '../zwave/ZWaveController';
import { IZWaveController, IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveAccessory } from '../accessories/ZWaveAccessory';
import { BatterySnapshot } from '../features/ZWaveFeature';
import { AccessoryFactory } from '../accessories/AccessoryFactory';
import { ControllerAccessory } from '../accessories/ControllerAccessory';
import { readCoveringPosition } from '../zwave/coveringTravel';
import { isSecretValue, REDACTED_LOG_VALUE } from '../zwave/secretValues';
import { HAP_COMMUNICATION_FAILURE } from '../features/ZWaveFeature';
import {
  POSITION_TOLERANCE as COVERING_POSITION_TOLERANCE,
  STABILITY_TOLERANCE as COVERING_STABILITY_TOLERANCE,
  STALL_WINDOW_MS as COVERING_STALL_WINDOW_MS,
} from '../zwave/coveringController';
import { MatterAccessories } from '../matter/MatterAccessories';
import {
  STATUS_CHAR_UUID,
  PIN_CHAR_UUID,
  UV_INDEX_CHAR_UUID,
  MANAGER_SERVICE_UUID,
  HAPFormat,
  HAPPerm,
} from './settings';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../package.json');

/** How often a covering's reported position is sampled while it travels. */
const COVERING_POLL_MS = 2000;
/**
 * How long to let the device answer a command before its reported state is trusted. Until the
 * device reports, the cached position and duration still describe the previous move.
 */
const COVERING_REPORT_GRACE_MS = 8000;
/** Upper bound on a covering's travel time. */
const COVERING_TRAVEL_TIMEOUT_MS = 70000;

/**
 * Turns whatever a HomeKit characteristic write rejected with into something a person can read.
 * hap-nodejs rethrows a refused write as a bare HAP status number, not an Error, so reading
 * `.message` off it yields undefined and the panel shows an empty object.
 */
function describeRequestFailure(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  if (err === HAP_COMMUNICATION_FAILURE) {
    return 'The plugin refused the command. The Homebridge log says why.';
  }

  return `The command failed with HomeKit status ${String(err)}.`;
}

export class ZWaveUsbPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  /** Whether the one-time Matter cache sweep has run for this session. */
  private matterCacheSwept = false;
  private matterSweepTimeout?: NodeJS.Timeout;
  private zwaveController: IZWaveController | undefined;
  private readonly zwaveAccessories = new Map<number, ZWaveAccessory>();
  private controllerAccessory: ControllerAccessory | undefined;
  private retryTimeout?: NodeJS.Timeout;
  private ipcServer?: http.Server;

  /**
   * RACE CONDITION FIX: Track which nodes are currently being created
   * to prevent duplicate accessories if multiple events fire rapidly.
   */
  private readonly matterAccessories = new MatterAccessories(this);
  private discoveryInFlight = new Set<number>();
  private firmwareProgress = new Map<
    number,
    { percent: number; outcome?: 'success' | 'failure' }
  >();
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
        healIncludesSleepingDevices: this.config.healIncludesSleepingDevices,
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

      this.zwaveController.on('firmware update progress', (nodeId, percent) => {
        this.firmwareProgress.set(nodeId, { percent });
      });

      this.zwaveController.on('firmware update finished', (nodeId, success) => {
        this.firmwareProgress.set(nodeId, {
          percent: 100,
          outcome: success ? 'success' : 'failure',
        });
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
        if (this.matterSweepTimeout) {
          clearTimeout(this.matterSweepTimeout);
          this.matterSweepTimeout = undefined;
        }
        if (this.retryTimeout) {
          clearTimeout(this.retryTimeout);
        }
        this.matterAccessories.stop();
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
            battery: this.readBatteryState(node),
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
          if (!this.zwaveController) {
            sendJson({ error: 'Controller not initialized' }, 500);
            return;
          }
          this.zwaveController
            .refreshNodeInfo(nodeId)
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

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/diagnostics') &&
          method === 'GET'
        ) {
          const nodeId = parseInt(normalizedUrl.split('/')[2], 10);
          if (!this.zwaveController) {
            sendJson({ error: 'Controller not initialized' }, 500);
            return;
          }
          this.zwaveController
            .getNodeRouteDiagnostics(nodeId)
            .then((diagnostics) =>
              sendJson({
                ...diagnostics,
                isWindowCovering: this.isPublishedAsWindowCovering(nodeId),
              }),
            )
            .catch((err) => sendJson({ error: err.message }, 500));
          return;
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/test-position') &&
          method === 'POST'
        ) {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const nodeId = parseInt(normalizedUrl.split('/')[2], 10);
              const { position } = JSON.parse(body || '{}');
              const result = await this.driveCovering(nodeId, Number(position));
              return sendJson(result);
            } catch (err) {
              return sendJson({ error: describeRequestFailure(err) }, 400);
            }
          });
          return;
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/test-stop') &&
          method === 'POST'
        ) {
          const nodeId = parseInt(normalizedUrl.split('/')[2], 10);
          this.driveCoveringStop(nodeId)
            .then((result) => sendJson(result))
            .catch((err) => sendJson({ error: describeRequestFailure(err) }, 400));
          return;
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/removal-check') &&
          method === 'GET'
        ) {
          const nodeId = parseInt(normalizedUrl.split('/')[2], 10);
          if (!this.zwaveController) {
            // Answer rather than fall through. The UI awaits this request with no timeout, so a
            // silent route would leave its Remove button disabled for good.
            sendJson({ error: 'Controller not initialized' }, 500);
            return;
          }
          this.zwaveController
            .assessFailedNodeRemoval(nodeId)
            .then((assessment) => sendJson(assessment))
            .catch((err) => sendJson({ error: err.message }, 500));
          return;
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/remove-failed') &&
          method === 'POST'
        ) {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const nodeId = parseInt(normalizedUrl.split('/')[2], 10);
              const { confirmNodeId } = JSON.parse(body || '{}');

              if (!this.zwaveController) {
                throw new Error('Controller not initialized');
              }

              await this.zwaveController.removeFailedNode(nodeId, Number(confirmNodeId));
              return sendJson({ success: true, nodeId });
            } catch (err) {
              this.log.error(`Failed-node removal rejected: ${err}`);
              return sendJson({ error: err instanceof Error ? err.message : String(err) }, 400);
            }
          });
          return;
        }

        if (normalizedUrl === '/network/heal' && method === 'POST') {
          if (!this.zwaveController) {
            sendJson({ error: 'Controller not initialized' }, 500);
            return;
          }
          this.zwaveController
            .startHealing()
            .then((result) => sendJson({ result, healing: this.zwaveController?.isHealing() }))
            .catch((err) => sendJson({ error: err.message }, 500));
          return;
        }

        if (normalizedUrl === '/network/heal/status' && method === 'GET') {
          if (!this.zwaveController) {
            // A wrong answer is worse than an error here: `healing: false` is what the UI reads
            // as "the rebuild finished".
            sendJson({ error: 'Controller not initialized' }, 500);
            return;
          }
          sendJson({
            healing: this.zwaveController.isHealing(),
            rebuilding: this.zwaveController.isRebuildingRoutes(),
          });
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

    // 3. UV Index Characteristic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Characteristic as any).UVIndex = class extends Characteristic {
      static readonly UUID = UV_INDEX_CHAR_UUID;
      constructor() {
        super('UV Index', UV_INDEX_CHAR_UUID, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          format: HAPFormat.FLOAT as any,
          minValue: 0,
          maxValue: 100,
          minStep: 0.1,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          perms: [HAPPerm.PAIRED_READ as any, HAPPerm.NOTIFY as any],
        });
        this.value = 0;
      }
    };

    // 4. Z-Wave Manager Service
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

  /**
   * Homebridge restores the Matter accessories it has cached before the network is discovered,
   * the same way it restores HomeKit ones. Recording them lets a covering whose node has since
   * been excluded be removed from Matter instead of lingering in the controller.
   */
  configureMatterAccessory(accessory: { UUID: string; displayName: string }) {
    this.matterAccessories.configureCachedAccessory(accessory);
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

      this.buildControllerAccessory();
    } catch (err) {
      this.log.error(
        `Failed to connect to Z-Wave controller: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.log.warn('Z-Wave stick may be unplugged or busy. Retrying in 30 seconds...');

      this.retryTimeout = setTimeout(() => {
        this.connectToZWaveController();
      }, 30000);
      return;
    }

    /**
     * Outside the catch above, and deliberately. Matter is optional, and a failure to reconcile
     * its cache says nothing about the stick: reporting it as a connection failure would schedule
     * another connect, and that restarts a driver that is working perfectly well.
     *
     * Only now is the node list the network's own answer either. On a failed start it is empty
     * because the stick could not be read, not because every node was removed, and sweeping on
     * that would unregister every restored Matter accessory the user has.
     */
    await this.sweepMatterCache();
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
          /**
           * The accessory was materialised from the HomeKit cache before the interview finished,
           * so its services still describe whatever the previous run believed the node to be.
           * Building the graph again replaces the stored signature, which is why the reconcile
           * has to be requested here rather than inferred from a later comparison.
           */
          existing.stop();
          const hydratedAccessory = AccessoryFactory.create(this, node, homeId);
          this.zwaveAccessories.set(node.nodeId, hydratedAccessory);
          hydratedAccessory.initialize({ removeSupersededServices: true });
          this.matterAccessories.add(hydratedAccessory);
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
          this.matterAccessories.add(reconciledAccessory);
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
        /**
         * A cached accessory can still carry services from a previous plugin version whose
         * classification differed, so the graph is reconciled as part of the first build.
         */
        accessory.initialize({ removeSupersededServices: true });
        this.matterAccessories.add(accessory);
      } else {
        accessory.refresh();
      }
    } finally {
      this.discoveryInFlight.delete(node.nodeId);
    }
  }

  /**
   * Waits for the device's own "I have stopped" signal rather than for the HomeKit values to
   * agree, because a covering reports intermediate positions while it travels and the gaps
   * between those reports otherwise look like a settled position.
   */
  private async waitForCoveringToStop(
    node: IZWaveNode,
    endpointIndex: number,
    readPosition: () => number | null,
  ): Promise<{ position: number | null; outcome: 'settled' | 'timed-out'; moved: boolean }> {
    const startedAt = Date.now();
    let moved = false;
    let settled = false;
    const deadline = startedAt + COVERING_TRAVEL_TIMEOUT_MS;
    let lastMoved = startedAt;
    let lastSeen = readCoveringPosition(node, endpointIndex, 'currentValue');

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, COVERING_POLL_MS));

      const sample = readCoveringPosition(node, endpointIndex, 'currentValue');
      if (
        sample !== undefined &&
        (lastSeen === undefined || Math.abs(sample - lastSeen) > COVERING_STABILITY_TOLERANCE)
      ) {
        // Compared against the previous sample, not against a fixed anchor: a covering creeping
        // a percent at a time would otherwise never clear a fixed threshold and would be called
        // stopped while it was still moving.
        lastSeen = sample;
        lastMoved = Date.now();
        moved = true;
        continue;
      }

      // Until the grace period is over the covering may not have begun to move, so a position
      // that has not changed yet says nothing. The stall clock only runs after it.
      if (Date.now() - startedAt < COVERING_REPORT_GRACE_MS) {
        lastMoved = Date.now();
        continue;
      }

      if (Date.now() - lastMoved >= COVERING_STALL_WINDOW_MS) {
        settled = true;
        break;
      }
    }

    /**
     * A covering still reporting new positions when the deadline passes has not stopped, and a
     * sampled position that happens to equal the target at that moment is a coincidence rather
     * than an arrival. The caller needs to know which of the two it got.
     */
    return {
      position: readCoveringPosition(node, endpointIndex, 'currentValue') ?? readPosition(),
      outcome: settled ? 'settled' : 'timed-out',
      moved,
    };
  }

  /** Stops a covering through HomeKit's HoldPosition and reports where it came to rest. */
  /**
   * The node's covering service, when it has exactly one. A node can publish a covering per
   * endpoint, and the panel is per node with one set of controls, so picking the first would
   * move whichever shade HAP happened to restore first with nothing to say which.
   */
  /**
   * One covering operation per node at a time. A move takes tens of seconds, and a second
   * request arriving while the first is in flight would drive the same motor from two places
   * and make both readings meaningless. The guard lives here rather than in the page because
   * another browser tab, or a direct call to the local interface, bypasses the page entirely.
   */
  private readonly coveringOperations = new Set<number>();

  /** The guarded entry points the local interface uses, exposed for tests to drive directly. */
  private driveCovering(nodeId: number, position: number) {
    return this.withCoveringOperation(nodeId, () => this.testCoveringPosition(nodeId, position));
  }

  private driveCoveringStop(nodeId: number) {
    return this.withCoveringOperation(nodeId, () => this.stopCovering(nodeId));
  }

  private async withCoveringOperation<T>(nodeId: number, run: () => Promise<T>): Promise<T> {
    if (this.coveringOperations.has(nodeId)) {
      throw new Error(`A covering test is already running for Node ${nodeId}.`);
    }

    this.coveringOperations.add(nodeId);
    try {
      return await run();
    } finally {
      this.coveringOperations.delete(nodeId);
    }
  }

  private theOnlyCoveringService(accessory: ZWaveAccessory, nodeId: number): Service {
    const services = accessory.platformAccessory.services.filter(
      (candidate) => candidate.UUID === this.Service.WindowCovering.UUID,
    );

    if (services.length === 0) {
      throw new Error(`Node ${nodeId} is not published as a window covering.`);
    }

    if (services.length > 1) {
      throw new Error(
        `Node ${nodeId} publishes ${services.length} coverings, so this control cannot tell ` +
          'which one to move. Drive them from the Home app instead.',
      );
    }

    return services[0];
  }

  private async stopCovering(nodeId: number): Promise<{
    nodeId: number;
    before: number | null;
    after: number | null;
    target: number | null;
    shortOfTarget: boolean;
    moved: boolean;
    timedOut: boolean;
  }> {
    const accessory = this.zwaveAccessories.get(nodeId);
    if (!accessory) {
      throw new Error(`Node ${nodeId} has no HomeKit accessory yet.`);
    }

    const service = this.theOnlyCoveringService(accessory, nodeId);

    const node = this.zwaveController?.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} is not part of the Z-Wave network.`);
    }

    const readPosition = () => {
      const value = service.getCharacteristic(this.Characteristic.CurrentPosition).value;
      return typeof value === 'number' ? value : null;
    };

    const readTarget = () => {
      const value = service.getCharacteristic(this.Characteristic.TargetPosition).value;
      return typeof value === 'number' ? value : null;
    };

    const before = readPosition();
    const target = readTarget();
    this.log.info(`Stop test: Node ${nodeId} asked to stop (at ${before}%, target ${target}%)`);

    await service.getCharacteristic(this.Characteristic.HoldPosition).handleSetRequest(true);
    const travel = await this.waitForCoveringToStop(
      node,
      this.coveringEndpointIndex(service),
      readPosition,
    );
    const after = travel.position;
    /**
     * A covering that ignores the stop carries on and comes to rest at its target, which looks
     * exactly like a successful stop unless the target is part of the answer. Resting short of
     * it is necessary evidence but not sufficient: a covering that was already stationary short
     * of a stale target would otherwise be credited with obeying a stop it never received, so
     * movement has to have been observed after the request too.
     */
    const restedShort =
      after !== null && target !== null && Math.abs(after - target) > COVERING_POSITION_TOLERANCE;
    const shortOfTarget = restedShort && travel.moved && travel.outcome === 'settled';
    this.log.info(
      `Stop test: Node ${nodeId} ended at ${after}% with target ${target}% ` +
        `(${travel.outcome}, movement ${travel.moved ? 'observed' : 'not observed'}, ` +
        `${shortOfTarget ? 'short of target' : 'inconclusive'})`,
    );

    return {
      nodeId,
      before,
      after,
      target,
      shortOfTarget,
      moved: travel.moved,
      timedOut: travel.outcome === 'timed-out',
    };
  }

  /**
   * The endpoint a covering service belongs to. Features name their service after the endpoint
   * index, so a covering published from a non-root endpoint is read from that endpoint rather
   * than from endpoint 0, which would never report a position for it.
   */
  private coveringEndpointIndex(service: Service): number {
    const parsed = Number.parseInt(service.subtype ?? '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private isPublishedAsWindowCovering(nodeId: number): boolean {
    const accessory = this.zwaveAccessories.get(nodeId);

    return Boolean(
      accessory?.platformAccessory.services.some(
        (service) => service.UUID === this.Service.WindowCovering.UUID,
      ),
    );
  }

  /**
   * Drives a covering to a position through the same HomeKit characteristic the Home app writes
   * to, then reports where the device actually ended up. A device can accept a command and stay
   * put, so the reported position is what decides whether the move worked.
   */
  private async testCoveringPosition(
    nodeId: number,
    position: number,
  ): Promise<{
    nodeId: number;
    requested: number;
    before: number | null;
    after: number | null;
    reached: boolean;
    startedAtTarget: boolean;
    timedOut: boolean;
  }> {
    if (!Number.isFinite(position) || position < 0 || position > 100) {
      throw new Error('Position must be between 0 and 100.');
    }

    const accessory = this.zwaveAccessories.get(nodeId);
    if (!accessory) {
      throw new Error(`Node ${nodeId} has no HomeKit accessory yet.`);
    }

    const service = this.theOnlyCoveringService(accessory, nodeId);

    const node = this.zwaveController?.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} is not part of the Z-Wave network.`);
    }

    const readPosition = () => {
      const value = service.getCharacteristic(this.Characteristic.CurrentPosition).value;
      return typeof value === 'number' ? value : null;
    };

    const requested = Math.round(position);
    const before = readPosition();
    this.log.info(`Position test: Node ${nodeId} commanded to ${requested}% (was ${before}%)`);

    await service.getCharacteristic(this.Characteristic.TargetPosition).handleSetRequest(requested);

    /**
     * A covering travels for tens of seconds and reports intermediate positions on the way, so
     * the reading is taken once the reported position has held still rather than after a fixed
     * delay that would sample the shade mid-travel.
     */
    const travel = await this.waitForCoveringToStop(
      node,
      this.coveringEndpointIndex(service),
      readPosition,
    );
    const after = travel.position;
    const atTarget = after !== null && Math.abs(after - requested) <= COVERING_POSITION_TOLERANCE;
    /**
     * A covering that was already at the commanded position ends there whether it moved or not,
     * so the test proves nothing. Saying "reached" would hand a dead covering a pass, which is
     * the condition this tool exists to find.
     */
    const startedAtTarget =
      before !== null && Math.abs(before - requested) <= COVERING_POSITION_TOLERANCE;
    /**
     * A covering still reporting movement when the deadline passed has not arrived, whatever
     * the last sample happened to read.
     */
    const reached = atTarget && !startedAtTarget && travel.outcome === 'settled';
    const outcome = startedAtTarget
      ? 'inconclusive, it was already there'
      : travel.outcome === 'timed-out'
        ? 'still moving when the test timed out'
        : reached
          ? 'reached'
          : 'not reached';
    this.log.info(
      `Position test: Node ${nodeId} reports ${after}% after ${requested}% was commanded ` +
        `(was ${before}%, ${outcome})`,
    );

    return {
      nodeId,
      requested,
      before,
      after,
      reached,
      startedAtTarget,
      timedOut: travel.outcome === 'timed-out',
    };
  }

  private shouldCreateAccessoryForUnreadyNode(
    cachedAccessory: PlatformAccessory | undefined,
  ): boolean {
    // Intentionally only materialize unready nodes if HomeKit already knows about them.
    // Brand-new unready nodes are deferred until feature metadata is complete, which keeps
    // the service graph stable and avoids publishing half-built accessories.
    return Boolean(cachedAccessory);
  }

  /**
   * The battery the accessory publishes for this node, or nothing when it publishes none.
   *
   * Asked of the accessory rather than read back out of the driver's values, because the
   * low-battery warning does not survive there. Battery CC replaces the 0xFF sentinel before
   * the report is persisted, so the value database still holds the last percentage and no flag
   * records that the warning came; the feature that drives the Battery service is the only
   * thing that remembers it. A node with no accessory yet reports nothing, which is the
   * truthful answer rather than an empty battery.
   */
  private readBatteryState(node: IZWaveNode): BatterySnapshot | undefined {
    const accessory = this.zwaveAccessories.get(node.nodeId);
    if (!accessory) {
      return undefined;
    }

    /**
     * Called per node while the list is built, so a failure here is contained to its own row.
     * Reading a battery reaches into the driver's values and can write the accessory cache,
     * and either can throw; without this one bad node would answer the whole page with a 500
     * and the table would show nothing at all. The call is left direct rather than optional,
     * so a method that goes missing still surfaces as a logged failure instead of silence.
     */
    try {
      return accessory.batteryState();
    } catch (err) {
      this.log.debug(`Battery [Node ${node.nodeId}]: could not be read for the node list: ${err}`);
      return undefined;
    }
  }

  private getHomeKitPublicationState(
    node: IZWaveNode,
  ): 'controller' | 'published' | 'cached-pending' | 'pending-interview' {
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

  /** Replaces the controller accessory, stopping the previous instance so it does not leak. */
  private buildControllerAccessory(): void {
    if (this.controllerAccessory) {
      this.controllerAccessory.stop();
    }
    this.controllerAccessory = new ControllerAccessory(this, this.zwaveController!);
  }

  /**
   * Removes Matter registrations Homebridge restored that are not nodes on this network. Runs
   * once, after a connection that actually succeeded, because a retry means didFinishLaunching
   * has long since returned and nothing else would ever run it.
   */
  private async sweepMatterCache(): Promise<void> {
    if (this.matterCacheSwept) {
      return;
    }

    try {
      await this.matterAccessories.reconcileCached(this.liveAccessoryUuids());
      this.matterCacheSwept = true;
    } catch (err) {
      this.log.warn(
        `Could not reconcile the Matter accessory cache: ${
          err instanceof Error ? err.message : String(err)
        }. Retrying in 30 seconds; the Z-Wave connection is unaffected.`,
      );
      if (this.matterSweepTimeout) {
        clearTimeout(this.matterSweepTimeout);
      }
      // The sweep alone, not another connect: the driver is fine and must not be restarted.
      this.matterSweepTimeout = setTimeout(() => void this.sweepMatterCache(), 30000);
      this.matterSweepTimeout.unref();
    }
  }

  /**
   * The accessory UUIDs of every node the controller currently reports, whether or not the node
   * is awake, interviewed or published yet. This is the network's own answer about what exists,
   * which is what a Matter cache sweep has to be keyed on: a shade with its battery out is still
   * a node, and unregistering it because it has not been published would take it out of every
   * Matter controller that can see it.
   */
  private liveAccessoryUuids(): Set<string> {
    const live = new Set<string>();
    const homeId = this.zwaveController?.homeId;

    const built = new Map<string, ZWaveAccessory>();
    for (const accessory of this.zwaveAccessories.values()) {
      built.set(accessory.platformAccessory.UUID, accessory);
    }

    /**
     * Taken from the accessories themselves rather than rebuilt from the node id. A UUID here
     * can be a legacy one this plugin adopted to preserve a user's automations, so regenerating
     * it would miss exactly the devices that have been around longest.
     */
    for (const accessory of this.accessories) {
      const context = accessory.context as { nodeId?: number; homeId?: number } | undefined;
      if (context?.nodeId == null) {
        continue;
      }

      // A different network's accessory, kept in the cache, must not be read as alive merely
      // because this network happens to use the same node number.
      if (context.homeId !== homeId) {
        continue;
      }

      if (!this.zwaveController?.nodes.has(context.nodeId)) {
        continue;
      }

      const ready = built.get(accessory.UUID);
      if (ready) {
        /**
         * This run has built the accessory, so its service graph is known. If it is no longer
         * published with a supported Matter service, its cached registration is stale.
         */
        if (this.matterAccessories.supports(ready)) {
          live.add(accessory.UUID);
        }
        continue;
      }

      /**
       * Not built yet: asleep, dead, or still interviewing. What it will be published as is not
       * knowable, so it is kept rather than unregistered on a guess.
       */
      live.add(accessory.UUID);
    }

    for (const accessory of built.values()) {
      if (this.matterAccessories.supports(accessory)) {
        live.add(accessory.platformAccessory.UUID);
      }
    }

    return live;
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
    staleUuids.forEach((uuid) => void this.matterAccessories.remove(uuid));
    void this.matterAccessories.reconcileCached(this.liveAccessoryUuids());
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
      removedUuids.forEach((uuid) => void this.matterAccessories.remove(uuid));
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
    if (
      args.commandClass === CommandClasses.Version ||
      args.commandClass === CommandClasses['Manufacturer Specific']
    ) {
      this.syncNodeAccessory(node);
    }
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

    /**
     * A device's own credentials travel as ordinary values. A door lock reports its keypad
     * codes through User Code, so the value itself is withheld while the rest of the event
     * still says which code changed and when.
     */
    const secret = isSecretValue(args);

    const payload = {
      commandClass: args.commandClass,
      endpoint: args.endpoint ?? 0,
      property: args.property,
      propertyKey: args.propertyKey,
      newValue: secret ? REDACTED_LOG_VALUE : this.serializeLogValue(args.newValue),
      prevValue: secret ? REDACTED_LOG_VALUE : this.serializeLogValue(args.prevValue),
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
