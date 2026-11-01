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
import { randomUUID } from 'crypto';
import { buildNodeParametersPayload, type NodeParametersPayload } from './NodeParametersPayload';
import {
  baselinesFor,
  canRefresh,
  isComplete,
  reconcilePending,
  refreshStatus,
  shouldDispatch,
  type RefreshStatus,
  type RefreshToken,
} from './NodeParametersRefresh';
import { ZWaveController } from '../zwave/ZWaveController';
import { IZWaveController, IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveAccessory } from '../accessories/ZWaveAccessory';
import { BatterySnapshot } from '../features/ZWaveFeature';
import { AccessoryFactory, EndpointPlan, PrimaryKind } from '../accessories/AccessoryFactory';
import { ControllerAccessory } from '../accessories/ControllerAccessory';
import { readCoveringPosition } from '../zwave/coveringTravel';
import { HAP_COMMUNICATION_FAILURE } from '../features/ZWaveFeature';
import {
  POSITION_TOLERANCE as COVERING_POSITION_TOLERANCE,
  STABILITY_TOLERANCE as COVERING_STABILITY_TOLERANCE,
  STALL_WINDOW_MS as COVERING_STALL_WINDOW_MS,
} from '../zwave/coveringController';
import { MatterAccessories } from '../matter/MatterAccessories';
import { TypeOverrideResolver, WriteResult } from './TypeOverrideResolver';
import {
  DeviceFingerprint,
  TypeOverrideStore,
  describeError,
  fingerprintKey,
} from './TypeOverrideStore';
import {
  NodeTypePayload,
  NodeTypeSummary,
  buildNodeTypePayload,
  summarizeNodeType,
} from './NodeTypePayload';
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

/**
 * The body of a type write, as it arrived over IPC.
 *
 * Its fields are declared as the write expects them rather than as optional, because the write
 * is what validates them: it states which guards it requires and refuses a request missing one
 * with no change. Checking them here as well would be a second rule to keep in step with it.
 */
interface TypeWriteBody {
  primaryKind: PrimaryKind;
  expectedFingerprint: DeviceFingerprint;
  expectedRevision: string;
  observationId: string;
}

/**
 * A parameters payload as the page receives it.
 *
 * It carries the name of the node it was built from, so that a page holding it can tell that the
 * number it read under now belongs to a different device.
 */
export type NodeParametersView = NodeParametersPayload & {
  identity: string;
  refresh: RefreshStatus;
};

/** What a type write did, which the panels redraw from. */
export interface TypeWriteOutcome {
  payload: NodeTypePayload | null;
  rebuilt: number[];
  failed: { nodeId: number; error: string }[];
  refusal?: string;
}

export class ZWaveUsbPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  /** The refresh each node has running or has lately run, held so returning to the page finds it. */
  private readonly parameterRefreshes = new Map<number, RefreshToken>();

  private readonly nodeIdentities = new WeakMap<IZWaveNode, string>();
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

  /**
   * Nodes whose last rebuild after a type change failed, until one succeeds or the plugin
   * restarts. Held here rather than derived, because the saved decision is what every other
   * answer is read from, and the saved decision is exactly what these nodes do not publish.
   *
   * Each record names the hardware it was written for as well as the node number, because
   * Z-Wave hands a freed number to the next device to join, and that device has not failed
   * at anything.
   */
  private readonly rebuildFailures = new Map<number, { error: string; fingerprint: string | null }>();
  private firmwareProgress = new Map<
    number,
    { percent: number; outcome?: 'success' | 'failure' }
  >();
  private refreshStates = new Map<number, 'waiting-wakeup' | 'refreshing'>();
  private typeOverrides?: TypeOverrideResolver;

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

      /**
       * Hands the parsed request body to a handler that answers for itself.
       *
       * The body is whatever the caller sent. Nothing here decides it is well formed: a write
       * states which fields it needs and refuses a request that is missing one, so a body that
       * is not an object arrives as an empty one and is refused the same way.
       */
      const readBody = (handle: (body: TypeWriteBody) => Promise<unknown>) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          let parsed: unknown;
          try {
            parsed = body ? JSON.parse(body) : {};
          } catch (err) {
            return sendJson({ error: describeError(err) }, 400);
          }
          const fields =
            typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};

          void handle(fields as TypeWriteBody)
            .then((answer) => sendJson(answer))
            .catch((err) => {
              this.log.error(`IPC Management Error: ${err}`);
              sendJson({ error: describeError(err) }, 500);
            });
        });
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
            identity: this.nodeIdentity(node),
            ...this.typeSummaryFor(node),
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

        if (normalizedUrl.startsWith('/nodes/') && normalizedUrl.endsWith('/parameters')) {
          const nodeId = parseInt(normalizedUrl.split('/')[2], 10);
          const payload = this.nodeParametersPayload(nodeId);

          return payload
            ? sendJson(payload)
            : sendJson({ error: `Node ${nodeId} is not in the network` }, 404);
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/parameters/refresh') &&
          method === 'POST'
        ) {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            const nodeId = parseInt(normalizedUrl.split('/')[2], 10);

            try {
              /**
               * The caller says which device it means to ask, and one that does not say is
               * refused rather than answered about whichever device holds the number: a re-read
               * puts commands on the network, and a node number can change hands between the
               * list a caller read and the request it made from it.
               */
              const { identity } = JSON.parse(body || '{}');

              if (typeof identity !== 'string' || identity.length === 0) {
                return sendJson({ error: 'A re-read must name the device it is for.' }, 400);
              }

              const payload = this.requestParameterRefresh(nodeId, identity);

              return payload
                ? sendJson(payload)
                : sendJson({ error: `Node ${nodeId} is not in the network` }, 404);
            } catch (err) {
              this.log.error(`Configuration-value re-read rejected: ${err}`);
              return sendJson({ error: err instanceof Error ? err.message : String(err) }, 400);
            }
          });
          return;
        }

        if (normalizedUrl.startsWith('/nodes/') && normalizedUrl.endsWith('/type')) {
          const nodeId = parseInt(normalizedUrl.split('/')[2], 10);

          if (method === 'GET') {
            const payload = this.nodeTypePayload(nodeId);
            return payload
              ? sendJson(payload)
              : sendJson({ error: `Node ${nodeId} is not in the network` }, 404);
          }

          if (method === 'POST') {
            readBody((body) =>
              this.writeNodeType(nodeId, (resolver) =>
                resolver.setNodeType({
                  nodeId,
                  primaryKind: body.primaryKind,
                  expectedFingerprint: body.expectedFingerprint,
                  expectedRevision: body.expectedRevision,
                }),
              ),
            );
            return;
          }
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/type/clear') &&
          method === 'POST'
        ) {
          const nodeId = parseInt(normalizedUrl.split('/')[2], 10);
          readBody((body) =>
            this.writeNodeType(nodeId, (resolver) =>
              resolver.clearNodeType({
                nodeId,
                expectedFingerprint: body.expectedFingerprint,
                expectedRevision: body.expectedRevision,
              }),
            ),
          );
          return;
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/type/remove') &&
          method === 'POST'
        ) {
          const nodeId = parseInt(normalizedUrl.split('/')[2], 10);
          readBody((body) =>
            this.writeNodeType(nodeId, (resolver) =>
              resolver.removeTypeOverride({ nodeId, expectedRevision: body.expectedRevision }),
            ),
          );
          return;
        }

        if (
          normalizedUrl.startsWith('/nodes/') &&
          normalizedUrl.endsWith('/type/acknowledge') &&
          method === 'POST'
        ) {
          const nodeId = parseInt(normalizedUrl.split('/')[2], 10);
          readBody((body) =>
            this.writeNodeType(nodeId, (resolver) =>
              resolver.acknowledgeTypeOrphan({
                nodeId,
                observationId: body.observationId,
                expectedFingerprint: body.expectedFingerprint,
              }),
            ),
          );
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

  /**
   * The saved type overrides for this network, read on first use.
   *
   * Not read at startup, because the home ID names the file and is not known until the driver
   * has read the controller. Reading it here keeps it ahead of the first plan it affects, so a
   * saved override is never published as the detected type and rebuilt a moment later.
   */
  private typeOverridesFor(homeId: number): TypeOverrideResolver {
    if (!this.typeOverrides) {
      const store = new TypeOverrideStore(this.api.user.storagePath(), homeId, this.log);
      store.load();
      this.typeOverrides = new TypeOverrideResolver(
        store,
        () => Array.from(this.zwaveController?.nodes.values() ?? []),
        this.log,
      );
    }

    return this.typeOverrides;
  }

  /** The resolver for the running network, or none while the controller is still starting. */
  private typeOverridesNow(): TypeOverrideResolver | undefined {
    const homeId = this.zwaveController?.homeId;

    return homeId ? this.typeOverridesFor(homeId) : undefined;
  }

  /** Whether a live Matter endpoint is publishing this node, which only a restart replaces. */
  /**
   * The HomeKit accessory a node has, whether or not the plugin currently holds a wrapper for
   * it.
   *
   * A rebuild that failed leaves the node with no wrapper while Matter goes on publishing the
   * endpoint it already has. Reading the identity only from the wrapper would then report the
   * node as absent from Matter, and the next type change would be confirmed without the
   * restart the published endpoint needs. The cached accessory is found by the node and
   * network it records, which is the identity the accessory is adopted by when one is built.
   */
  private platformAccessoryFor(nodeId: number): PlatformAccessory | undefined {
    const live = this.zwaveAccessories.get(nodeId)?.platformAccessory;
    if (live) {
      return live;
    }

    const homeId = this.zwaveController?.homeId;

    return this.accessories.find((accessory) => {
      const context = accessory.context as { nodeId?: number; homeId?: number } | undefined;

      return context?.nodeId === nodeId && context?.homeId === homeId;
    });
  }

  private matterPublishes(nodeId: number): boolean {
    const accessory = this.platformAccessoryFor(nodeId);

    return accessory ? this.matterAccessories.publishes(accessory.UUID) : false;
  }

  /**
   * A name for this node that is never given to another, which the page reads the way the
   * refresh reads the node itself.
   *
   * Z-Wave gives a node number away again, and a replacement can report the same hardware as the
   * device that had the number before, or report none at all while that one reported none
   * either. Neither the number nor the fingerprint tells those apart, so the name is minted for
   * the node and held against it: the page can then see that what it read describes a device
   * that is no longer there, instead of drawing one device's settings under another's name.
   *
   * Weakly held, so a name lasts exactly as long as the node it names.
   */
  private nodeIdentity(node: IZWaveNode): string {
    const held = this.nodeIdentities.get(node);
    if (held) {
      return held;
    }

    const minted = randomUUID();
    this.nodeIdentities.set(node, minted);

    return minted;
  }

  /** This node's hardware as the records name it, or none when it has not reported any. */
  private fingerprintKeyOf(node: IZWaveNode): string | null {
    const fingerprint = TypeOverrideResolver.fingerprintOf(node);

    return fingerprint ? fingerprintKey(fingerprint) : null;
  }

  /**
   * The error from this node's last failed rebuild, while the record still describes the device
   * that is there now. A node that cannot be read cannot be shown to be a different device, so
   * its record stands rather than being discarded on a reading that failed.
   */
  private rebuildFailureFor(node: IZWaveNode): string | null {
    const failure = this.rebuildFailures.get(node.nodeId);
    if (!failure) {
      return null;
    }

    let current = failure.fingerprint;
    try {
      current = this.fingerprintKeyOf(node);
    } catch (err) {
      this.log.debug(`Node ${node.nodeId}: hardware unreadable for its rebuild record: ${err}`);
    }

    return current === failure.fingerprint ? failure.error : null;
  }

  /** Everything the parameters section draws, or none when the node has left the network. */
  public nodeParametersPayload(nodeId: number): NodeParametersView | undefined {
    const node = this.zwaveController?.nodes.get(nodeId);
    if (!node) {
      return undefined;
    }

    const payload = buildNodeParametersPayload(node);
    const token = this.parameterRefreshFor(node);
    if (token) {
      this.observeParameterRefresh(token, payload);
    }

    return {
      ...payload,
      identity: this.nodeIdentity(node),
      refresh: refreshStatus(token, payload),
    };
  }

  /**
   * Narrows what the attempt is still waiting on, and records when it is first seen to have
   * finished with every value answered.
   *
   * The moment is taken where the completion is seen, which is as close to it as anything here
   * can get: a device answers when it answers, and nothing announces that the last value has
   * arrived. It is not taken from the request, which a sleeping device can answer hours later.
   */
  private observeParameterRefresh(token: RefreshToken, payload: NodeParametersPayload): void {
    reconcilePending(token, payload);

    if (isComplete(token) && token.completedAt === null) {
      token.completedAt = Date.now();
    }
  }

  /**
   * The refresh this node has, discarded where it was not this node that was asked.
   *
   * The node itself is the identity, not its number and not its fingerprint. Z-Wave gives a node
   * number away again, and the replacement can report the same hardware, or report none at all
   * while the one before it also reported none. Either way a question put to the device that has
   * gone would be read as the progress of one put to the device that is here, and would go on
   * suppressing a real request for as long as its promise stayed unsettled.
   */
  private parameterRefreshFor(node: IZWaveNode): RefreshToken | null {
    const token = this.parameterRefreshes.get(node.nodeId);
    if (!token) {
      return null;
    }

    if (token.owner !== node || token.fingerprint !== this.fingerprintKeyOf(node)) {
      this.parameterRefreshes.delete(node.nodeId);
      return null;
    }

    return token;
  }

  /**
   * Asks a device for its current configuration values.
   *
   * A request arriving while an attempt is running is that same attempt: its baselines are not
   * replaced and nothing further is dispatched, because a baseline taken from a timestamp the
   * running refresh has already advanced would wait for a move it will not make again.
   *
   * The caller names the device it means to ask, and a caller naming another one is answered
   * about the device that holds the number now with nothing put on the network for it: the
   * reader asked for the device they were looking at, and a number can have changed hands since
   * they looked.
   */
  public requestParameterRefresh(
    nodeId: number,
    expectedIdentity: string,
  ): NodeParametersView | undefined {
    const node = this.zwaveController?.nodes.get(nodeId);
    if (!node) {
      return undefined;
    }

    const payload = buildNodeParametersPayload(node);
    const identity = this.nodeIdentity(node);
    const fingerprint = this.fingerprintKeyOf(node);
    const existing = this.parameterRefreshFor(node);
    const meant = expectedIdentity === identity;

    if (meant && canRefresh(payload) && shouldDispatch(existing)) {
      const baselines = baselinesFor(payload);
      const token: RefreshToken = {
        nodeId,
        owner: node,
        fingerprint,
        requestedAt: Date.now(),
        dispatching: true,
        asked: baselines.length,
        retired: 0,
        completedAt: null,
        pending: baselines,
      };
      this.parameterRefreshes.set(nodeId, token);
      this.dispatchParameterRefresh(node, token);
    }

    const token = this.parameterRefreshFor(node);
    if (token) {
      this.observeParameterRefresh(token, payload);
    }

    return { ...payload, identity, refresh: refreshStatus(token, payload) };
  }

  /**
   * Sends the refresh and stops waiting on it.
   *
   * zwave-js's own documentation says not to await `refreshCCValues`, and it resolves even where
   * every endpoint failed, because it catches and logs each one. Settling is therefore recorded as
   * the attempt having finished and nothing more: whether any value answered is read from the
   * timestamps. The handlers are here so that not awaiting it cannot leave a rejection unhandled.
   */
  private dispatchParameterRefresh(node: IZWaveNode, token: RefreshToken): void {
    const settle = () => {
      if (this.parameterRefreshes.get(token.nodeId) !== token) {
        return;
      }

      token.dispatching = false;

      /**
       * Read here as well as on the next request, so that an attempt that finishes while nobody
       * is looking is recorded as having finished then. Reading a device that has just left the
       * network can throw, and this is not inside a request that would answer for it.
       */
      try {
        this.observeParameterRefresh(token, buildNodeParametersPayload(node));
      } catch (err) {
        this.log.debug(`Node ${token.nodeId}: configuration values unreadable on settling: ${err}`);
      }
    };

    void node
      .refreshCCValues(CommandClasses.Configuration)
      .then(settle)
      .catch((err) => {
        this.log.debug(`Node ${token.nodeId}: configuration-value refresh failed: ${err}`);
        settle();
      });
  }

  /** Everything the node's type panel draws, or none when the node has left the network. */
  public nodeTypePayload(nodeId: number): NodeTypePayload | undefined {
    const node = this.zwaveController?.nodes.get(nodeId);
    const resolver = this.typeOverridesNow();
    if (!node || !resolver) {
      return undefined;
    }

    return buildNodeTypePayload(resolver, node, {
      matterPublishes: (member) => this.matterPublishes(member),
      rebuildFailure: this.rebuildFailureFor(node),
    });
  }

  /** What the node table shows about a node's type, which is a summary of the same decision. */
  private typeSummaryFor(node: IZWaveNode): NodeTypeSummary {
    /**
     * Read before anything that can fail, because this comes from the platform's own record
     * rather than from classifying the node. A node too broken to summarize is exactly the one
     * whose accessory is most likely to be behind its saved decision.
     */
    const neutral: NodeTypeSummary = {
      typeOverride: null,
      typeInvalid: false,
      typeOrphans: 0,
      typeRebuildFailed: this.rebuildFailureFor(node) !== null,
    };

    const resolver = this.typeOverridesNow();
    if (!resolver) {
      return neutral;
    }

    /**
     * Called per node while the list is built, so a failure here is contained to its own row,
     * as the battery read beside it is. Deciding what a node could be published as reaches the
     * node and each of its endpoints, and one node that answers badly would otherwise answer
     * the whole page with a 500 and leave the table with no rows at all.
     */
    try {
      return summarizeNodeType(resolver, node, neutral.typeRebuildFailed);
    } catch (err) {
      this.log.debug(`Type [Node ${node.nodeId}]: no summary for the node list: ${err}`);
      return neutral;
    }
  }

  /**
   * Runs a type write and rebuilds what it changed.
   *
   * The payload returned describes the network after the write, whether the write was accepted
   * or refused, so a panel that refreshes from it is showing the state a refusal was measured
   * against rather than the stale one the request was composed from.
   */
  private async writeNodeType(
    nodeId: number,
    write: (resolver: TypeOverrideResolver) => Promise<WriteResult>,
  ): Promise<TypeWriteOutcome> {
    const resolver = this.typeOverridesNow();
    if (!resolver) {
      throw new Error('Controller not initialized');
    }

    const result = await write(resolver);

    if (result.refusal) {
      /**
       * The reader is told the write did not happen and is sent to what the panel now reports,
       * which is the condition the refusal names. The code itself is only useful to someone
       * reading the log, and is kept here rather than put in front of them.
       */
      this.log.debug(`Type change for Node ${nodeId} was refused: ${result.refusal}`);
    }

    const { rebuilt, failed } = result.refusal
      ? { rebuilt: [], failed: [] }
      : this.rebuildForTypeChange(result.rebuild);

    // Rebuilding records where the decision landed, and the payload below reports those records.
    await resolver.settled();

    return {
      payload: this.nodeTypePayload(nodeId) ?? null,
      rebuilt,
      failed,
      ...(result.refusal ? { refusal: result.refusal } : {}),
    };
  }

  /**
   * Rebuilds the accessories a saved decision reached.
   *
   * The decision is already on disk, so a node that cannot be rebuilt is reported rather than
   * rolled back: it publishes the saved type from the next restart, and the nodes after it in
   * the list are still rebuilt. Whether a node was rebuilt is read from its graph signature,
   * the same comparison the sync makes, so a cohort node the decision did not change is not
   * claimed as rebuilt.
   */
  private rebuildForTypeChange(nodeIds: readonly number[]): {
    rebuilt: number[];
    failed: { nodeId: number; error: string }[];
  } {
    const rebuilt: number[] = [];
    const failed: { nodeId: number; error: string }[] = [];

    const homeId = this.zwaveController?.homeId;

    for (const nodeId of nodeIds) {
      const node = this.zwaveController?.nodes.get(nodeId);
      if (!node) {
        continue;
      }

      const existing = this.zwaveAccessories.get(nodeId);
      const before = existing?.getGraphSignature();

      /**
       * One reading of the node, which both decides whether anything changes and builds the
       * accessory when it does. Planning here and again inside the sync would compare one
       * reading of a node and build from another, which is the inconsistency the shared plan
       * exists to prevent.
       *
       * A cohort node the decision does not change is then left alone rather than synced and
       * compared afterward. The sync reaches `updateNode` and `refresh` on its way past an
       * accessory it will not replace, and either can throw, which would report a rebuild
       * failure for a node that was never going to be rebuilt. Planning can throw too, and a
       * plan that cannot be read is no reason to skip, so it falls through to the sync and the
       * guard around it.
       */
      let plans: EndpointPlan[] | undefined;
      let planned: string | undefined;
      try {
        if (homeId && node.ready) {
          const overrides = this.typeOverridesFor(homeId);
          plans = AccessoryFactory.planFeatures(node, overrides.planOptionsFor(node));
          planned = existing?.isInitialized()
            ? AccessoryFactory.signatureOfPlans(plans)
            : undefined;
        }
      } catch (err) {
        plans = undefined;
        this.log.debug(`Node ${nodeId}: could not be planned before a rebuild: ${err}`);
      }

      if (planned !== undefined && planned === before) {
        // The decision still reaches this node, and the sync is the only other thing that records it.
        if (homeId) {
          void this.typeOverridesFor(homeId).observe(node);
        }
        this.rebuildFailures.delete(nodeId);
        continue;
      }

      try {
        this.syncNodeAccessory(node, plans);
        if (this.zwaveAccessories.get(nodeId)?.getGraphSignature() !== before) {
          rebuilt.push(nodeId);
        }
      } catch (err) {
        const error = describeError(err);
        this.log.error(`Failed to rebuild Node ${nodeId} after a type change: ${err}`);
        this.rebuildFailures.set(nodeId, { error, fingerprint: this.fingerprintKeyOf(node) });
        failed.push({ nodeId, error });
      }
    }

    return { rebuilt, failed };
  }

  /**
   * Puts a freshly built accessory in place of the one a node has.
   *
   * The old one is stopped first, because two accessories bound to one node would both answer
   * it. It is also taken out of the map first, and that is the part that matters: if the
   * replacement cannot be built, a stopped accessory left in the map answers nothing while its
   * stored signature still says the node is up to date. The next pass, or a revert, would then
   * find the signature it expects, settle the warning, skip the rebuild, and leave HomeKit
   * bound to a thing that does nothing until Homebridge is restarted. With no entry there, the
   * next pass has a node with no accessory and builds one.
   */
  private replaceAccessory(
    node: IZWaveNode,
    homeId: number,
    plans: readonly EndpointPlan[],
    options: { removeSupersededServices?: boolean; pruneUnmanagedServices?: boolean },
  ): void {
    this.zwaveAccessories.get(node.nodeId)?.stop();
    this.zwaveAccessories.delete(node.nodeId);

    const replacement = AccessoryFactory.create(this, node, homeId, plans);
    this.zwaveAccessories.set(node.nodeId, replacement);
    replacement.initialize(options);
    this.settleRebuildWarning(node.nodeId);
    this.offerToMatter(replacement, node.nodeId);
  }

  /**
   * A node publishing the plan made for this pass is no longer behind the type saved for it,
   * whatever brought it up to date.
   *
   * Every call below sits immediately after `initialize`, which is the call that gives the
   * accessory its services. Before it they do not exist, so the warning would be settled on the
   * way into a rebuild that then fails, and nothing outside a write would set it again.
   */
  private settleRebuildWarning(nodeId: number): void {
    this.rebuildFailures.delete(nodeId);
  }

  /**
   * Offers a built accessory to the Matter layer, which publishes it on its own schedule.
   *
   * A failure here is logged and goes no further. HomeKit has the accessory by this point, so
   * letting the fault out would abort a sync that has already done its work: an event handler
   * would lose the rest of its pass, and a type write would record a HomeKit rebuild failure,
   * and warn about one, for a device HomeKit rebuilt.
   */
  private offerToMatter(accessory: ZWaveAccessory, nodeId: number): void {
    try {
      this.matterAccessories.add(accessory);
    } catch (err) {
      this.log.error(
        `Node ${nodeId}: HomeKit was updated, but the accessory could not be offered to ` +
          `the Matter layer: ${err}`,
      );
    }
  }

  private syncNodeAccessory(node: IZWaveNode, plans?: EndpointPlan[]) {
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

    /**
     * One reading of the node for this pass. The signature compared below and every accessory
     * built from it describe the same plan. Planning again inside the build would read a node
     * that is still interviewing a second time, and the two readings can differ, so the
     * accessory would carry a signature describing services it does not have.
     */
    const typeOverrides = this.typeOverridesFor(homeId);
    void typeOverrides.observe(node);

    let planned: EndpointPlan[] | undefined = plans;
    const featurePlans = () =>
      (planned ??= AccessoryFactory.planFeatures(node, typeOverrides.planOptionsFor(node)));
    const graphSignature = node.ready
      ? AccessoryFactory.signatureOfPlans(featurePlans())
      : undefined;

    const existing = this.zwaveAccessories.get(node.nodeId);

    /**
     * However a node came to publish what was planned for it, it is no longer behind the
     * decision saved for it. An ordinary reconcile reaching it in the background settles the
     * warning as well as a rebuild started from the panel does. A cached accessory answers with
     * the signature the last run stored for it while its services have yet to be built in this
     * one, so having been initialized is part of being current.
     */
    if (
      graphSignature !== undefined &&
      existing?.isInitialized() &&
      existing.getGraphSignature() === graphSignature
    ) {
      this.settleRebuildWarning(node.nodeId);
    }
    if (existing || this.discoveryInFlight.has(node.nodeId)) {
      if (existing) {
        if (node.ready && !existing.isInitialized()) {
          /**
           * The accessory was materialized from the HomeKit cache before the interview finished,
           * so its services still describe whatever the previous run believed the node to be.
           * Building the graph again replaces the stored signature, which is why the reconcile
           * has to be requested here rather than inferred from a later comparison.
           */
          this.replaceAccessory(node, homeId, featurePlans(), {
            removeSupersededServices: true,
          });
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
          this.replaceAccessory(node, homeId, featurePlans(), { pruneUnmanagedServices: true });
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
      const accessory = AccessoryFactory.create(this, node, homeId, featurePlans());
      this.zwaveAccessories.set(node.nodeId, accessory);

      if (node.ready) {
        /**
         * A cached accessory can still carry services from a previous plugin version whose
         * classification differed, so the graph is reconciled as part of the first build.
         */
        accessory.initialize({ removeSupersededServices: true });
        this.settleRebuildWarning(node.nodeId);
        this.offerToMatter(accessory, node.nodeId);
      } else {
        // A node partway through its interview publishes nothing to be behind or up to date on.
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
    staleNodeIds.forEach((nodeId) => {
      this.zwaveAccessories.delete(nodeId);
      this.rebuildFailures.delete(nodeId);
      this.parameterRefreshes.delete(nodeId);
    });

    return staleAccessories.length;
  }

  private handleNodeRemoved(node: IZWaveNode) {
    this.refreshStates.delete(node.nodeId);
    this.rebuildFailures.delete(node.nodeId);
    this.parameterRefreshes.delete(node.nodeId);
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
