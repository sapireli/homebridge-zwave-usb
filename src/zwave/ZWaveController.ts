import { Logger } from 'homebridge';
import { Driver, ZWaveNode, InclusionStrategy, RebuildRoutesStatus } from 'zwave-js';
import { CommandClasses, NodeStatus, isRssiError, rssiToString } from '@zwave-js/core';
import { EventEmitter } from 'events';
import {
  FailedNodeRemovalAssessment,
  HealStartResult,
  IZWaveController,
  NodeRouteDiagnostics,
  ZWaveValueEvent,
} from './interfaces';
import { formatRebuildRoutesSummary, summarizeRebuildRoutes } from './rebuildRoutes';
import path from 'path';
import fs from 'fs';

const MANUFACTURER_SPECIFIC_SERIAL_NUMBER_TYPE = 1;

/**
 * How long a route rebuild may go without reporting progress before it is treated as wedged.
 * This is an inactivity timeout rather than a total-runtime cap: a large network can legitimately
 * take much longer than any fixed budget, and cancelling a rebuild that is still working would
 * leave nodes with stale routes.
 */
const REBUILD_ROUTES_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** How long the status characteristic keeps showing how a heal ended before going back to idle. */
const HEAL_STATUS_LINGER_MS = 5000;

type HealState = 'idle' | 'starting' | 'active';

export interface ZWaveControllerOptions {
  debug?: boolean;
  storagePath?: string;
  /**
   * Include sleeping devices in a Heal Network run. Off by default: a sleeping node's rebuild
   * waits on `waitForWakeup()` before doing any work, so one of them holds the rebuild open
   * until it happens to wake, and the operation stops looking finite to the user. Turning it on
   * also disables the inactivity watchdog, because the driver reports no progress at all while
   * it waits for a device to wake.
   */
  healIncludesSleepingDevices?: boolean;
  securityKeys?: {
    S0_Legacy?: string;
    S2_Unauthenticated?: string;
    S2_Authenticated?: string;
    S2_AccessControl?: string;
    S2_Authenticated_LR?: string;
    S2_AccessControl_LR?: string;
  };
}

/**
 * ZWaveController wraps the Z-Wave JS Driver and implements high-level
 * automation logic for inclusion, exclusion, and security PIN management.
 */
export class ZWaveController extends EventEmitter implements IZWaveController {
  private driver: Driver | undefined;
  public readonly nodes = new Map<number, ZWaveNode>();
  private pendingS2Pin: string | undefined;
  private healState: HealState = 'idle';
  private healWatchdog: NodeJS.Timeout | undefined;
  private healStatusLinger: NodeJS.Timeout | undefined;

  private nodeListeners = new Map<
    number,
    {
      ready: () => void;
      value: (node: ZWaveNode, args: ZWaveValueEvent) => void;
      notification: (node: ZWaveNode, args: ZWaveValueEvent) => void;
      metadata: (node: ZWaveNode, args: ZWaveValueEvent) => void;
      interviewStageCompleted?: (node: ZWaveNode, stageName: string) => void;
      interviewFailed?: (node: ZWaveNode, args: { errorMessage: string }) => void;
      onWakeUp?: (node: ZWaveNode) => void;
      onSleep?: (node: ZWaveNode) => void;
      onDead?: (node: ZWaveNode) => void;
      onAlive?: (node: ZWaveNode) => void;
    }
  >();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private controllerListeners: Record<string, (...args: any[]) => void> = {};

  constructor(
    private readonly log: Logger,
    private readonly serialPort: string,
    private readonly options: ZWaveControllerOptions = {},
  ) {
    super();
  }

  /**
   * Externally called when the 'S2 PIN Entry' HomeKit characteristic is written to.
   */
  public setS2Pin(pin: string): void {
    /**
     * The PIN is an inclusion credential printed on the device, and the Homebridge log is a file
     * people paste into bug reports. That one arrived is worth saying; what it was is not.
     */
    this.log.info('[S2] PIN input received.');
    this.pendingS2Pin = pin.trim();
    this.emit('pin-received');
  }

  private setupControllerListeners() {
    if (!this.driver) {
      return;
    }

    this.driver.once('driver ready', () => {
      try {
        if (!this.driver) {
          return;
        }
        this.log.info(`Controller Home ID: ${this.driver.controller.homeId}`);

        this.controllerListeners = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          'inclusion started': (secure: any) => {
            this.log.info(`Inclusion started (secure: ${secure})`);
            this.emit('status updated', `Inclusion Started (Secure: ${secure})`);
            this.emit('inclusion started', secure);
          },
          'inclusion stopped': () => {
            this.log.info('Inclusion stopped');
            this.emit('status updated', 'Driver Ready');
            this.emit('inclusion stopped');
          },
          'exclusion started': () => {
            this.log.info('Exclusion started');
            this.emit('status updated', 'Exclusion Mode Active');
            this.emit('exclusion started');
          },
          'exclusion stopped': () => {
            this.log.info('Exclusion stopped');
            this.emit('status updated', 'Driver Ready');
            this.emit('exclusion stopped');
          },
          'rebuild routes progress': (progress: ReadonlyMap<number, RebuildRoutesStatus>) => {
            /**
             * Only a heal this plugin started counts. Cancelling one leaves the library's task
             * briefly alive, and it emits a last progress event on its way out; treating that as
             * evidence of a running rebuild would revive a heal the user had just stopped.
             */
            if (this.healState === 'idle') {
              return;
            }

            // Progress is the evidence that the rebuild is still working, so it restarts the clock.
            this.startHealWatchdog();

            const summary = summarizeRebuildRoutes(progress);
            this.log.info(`Heal Network Progress: ${formatRebuildRoutesSummary(summary)}`);
            this.emit('status updated', `Heal: ${summary.completed}/${summary.total}`);
            this.emit('heal network progress', progress);
          },
          'rebuild routes done': (result: ReadonlyMap<number, RebuildRoutesStatus>) => {
            /**
             * A cancelled rebuild can outlive the stop that was supposed to end it, and it
             * finishes against a progress map the driver already cleared. Reporting that as a
             * completion would announce a fabricated 100%, which is what this handler exists
             * to stop doing.
             */
            if (this.healState === 'idle') {
              return;
            }

            this.clearHealWatchdog();
            this.healState = 'idle';

            const summary = summarizeRebuildRoutes(result);
            this.log.info(`Heal Network Complete: ${formatRebuildRoutesSummary(summary)}`);
            this.announceHealEnded('Heal Network Done');
            this.emit('heal network done', result);
          },
          'node added': (node: ZWaveNode) => {
            this.log.info(`Node ${node.nodeId} added to controller`);
            this.emit('status updated', `Node ${node.nodeId} Added`);
            this.addNode(node);
            this.emit('node added', node);
          },
          'node removed': (node: ZWaveNode) => {
            this.log.info(`Node ${node.nodeId} removed from controller`);
            this.emit('status updated', `Node ${node.nodeId} Removed`);
            this.removeNode(node);
          },
        };

        // Attach controller listeners
        this.driver.controller.on(
          'inclusion started',
          this.controllerListeners['inclusion started'],
        );
        this.driver.controller.on(
          'inclusion stopped',
          this.controllerListeners['inclusion stopped'],
        );
        this.driver.controller.on(
          'exclusion started',
          this.controllerListeners['exclusion started'],
        );
        this.driver.controller.on(
          'exclusion stopped',
          this.controllerListeners['exclusion stopped'],
        );
        this.driver.controller.on(
          'rebuild routes progress',
          this.controllerListeners['rebuild routes progress'],
        );
        this.driver.controller.on(
          'rebuild routes done',
          this.controllerListeners['rebuild routes done'],
        );
        this.driver.controller.on('node added', this.controllerListeners['node added']);
        this.driver.controller.on('node removed', this.controllerListeners['node removed']);

        // Initial node discovery
        this.driver.controller.nodes.forEach((node) => {
          this.addNode(node);
        });
      } catch (_err) {
        this.log.error('Error during Z-Wave driver initialization:', _err);
      }
    });
  }

  public get homeId(): number | undefined {
    try {
      return this.driver?.controller.homeId;
    } catch {
      return undefined;
    }
  }

  private addNode(node: ZWaveNode) {
    if (this.nodes.has(node.nodeId)) {
      this.log.warn(`Node ${node.nodeId} already exists in nodes map, skipping`);
      return;
    }
    this.nodes.set(node.nodeId, node);

    /**
     * NodeStatus Enum (zwave-js):
     * 0: Unknown
     * 1: Asleep
     * 2: Awake
     * 3: Dead
     * 4: Alive
     */
    const statusMap = ['Unknown', 'Asleep', 'Awake', 'Dead', 'Alive'];
    const status = statusMap[node.status] || node.status.toString();
    const nodeName = node.name || node.label || node.deviceConfig?.label || `Node ${node.nodeId}`;
    this.log.info(
      `Node ${node.nodeId} (${nodeName}) added to controller (Status: ${status}, Interview Stage: ${node.interviewStage})`,
    );

    const onReady = () => {
      this.log.info(`Node ${node.nodeId} is ready (Interview Stage: ${node.interviewStage})`);
      this.emit('status updated', `Node ${node.nodeId} Ready`);
      this.emit('node ready', node);
      void this.refreshNodeDeviceSerialNumber(node);
    };

    const onValueUpdated = (n: ZWaveNode, args: ZWaveValueEvent) => {
      this.log.debug(`Node ${n.nodeId} value updated`);
      this.emit('value updated', n, args);
    };

    const onValueNotification = (n: ZWaveNode, args: ZWaveValueEvent) => {
      this.log.debug(`Node ${n.nodeId} value notification`);
      this.emit('value notification', n, args);
    };

    const onMetadataUpdated = (n: ZWaveNode, args: ZWaveValueEvent) => {
      this.log.debug(`Node ${n.nodeId} metadata updated`);
      this.emit('value updated', n, args); // Treat as update
    };

    const onInterviewStageCompleted = (_n: ZWaveNode, stage: string) => {
      this.log.info(`Node ${node.nodeId} interview stage completed: ${stage}`);
      this.emit('status updated', `Node ${node.nodeId}: ${stage}`);
      this.emit('node updated', node);
    };

    const onInterviewFailed = (_n: ZWaveNode, args: { errorMessage: string }) => {
      this.log.error(`Node ${node.nodeId} interview failed: ${args.errorMessage}`);
      this.emit('node updated', node);
    };

    const onWakeUp = () => {
      this.log.info(`Node ${node.nodeId} has woken up. Interview will resume.`);
      this.emit('status updated', `Node ${node.nodeId} Awake`);
      this.emit('node updated', node);
      void this.refreshNodeDeviceSerialNumber(node);
    };

    const onSleep = () => {
      this.log.info(`Node ${node.nodeId} has gone to sleep. Interview is paused.`);
      this.emit('status updated', `Node ${node.nodeId} Asleep`);
      this.emit('node updated', node);
    };

    const onDead = () => {
      this.log.info(`Node ${node.nodeId} is dead.`);
      this.emit('node updated', node);
    };

    const onAlive = () => {
      this.log.info(`Node ${node.nodeId} is alive.`);
      this.emit('node updated', node);
    };

    const onFirmwareUpdateProgress = (_n: ZWaveNode, progress: { progress?: number }) => {
      this.emit('firmware update progress', node.nodeId, progress?.progress ?? 0);
    };

    const onFirmwareUpdateFinished = (
      _n: ZWaveNode,
      result: { success?: boolean; waitTime?: number },
    ) => {
      this.emit(
        'firmware update finished',
        node.nodeId,
        result?.success === true,
        result?.waitTime,
      );
    };

    this.nodeListeners.set(node.nodeId, {
      ready: onReady,
      value: onValueUpdated,
      notification: onValueNotification,
      metadata: onMetadataUpdated,
      interviewStageCompleted: onInterviewStageCompleted,
      interviewFailed: onInterviewFailed,
      onWakeUp,
      onSleep,
      onDead,
      onAlive,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    node.on('ready', onReady);
    node.on('value updated', onValueUpdated);
    node.on('value added', onValueUpdated);
    node.on('metadata updated', onMetadataUpdated);
    node.on('value notification', onValueNotification);
    node.on('interview stage completed', onInterviewStageCompleted);
    node.on('interview failed', onInterviewFailed);
    node.on('wake up', onWakeUp);
    node.on('sleep', onSleep);
    node.on('dead', onDead);
    node.on('alive', onAlive);
    node.on('firmware update progress', onFirmwareUpdateProgress);
    node.on('firmware update finished', onFirmwareUpdateFinished);

    this.log.info(`Node ${node.nodeId} registered with event listeners (ready: ${node.ready})`);

    if (node.ready) {
      this.log.info(`Node ${node.nodeId} is already ready, emitting node ready immediately`);
      this.emit('node ready', node);
      void this.refreshNodeDeviceSerialNumber(node);
    }
  }

  private async refreshNodeDeviceSerialNumber(node: ZWaveNode): Promise<void> {
    if ((node as ZWaveNode & { deviceSerialNumber?: string }).deviceSerialNumber) {
      return;
    }

    if (
      typeof node.supportsCC !== 'function' ||
      !node.supportsCC(CommandClasses['Manufacturer Specific'])
    ) {
      return;
    }

    const manufacturerSpecificApi = (
      node as ZWaveNode & {
        commandClasses?: {
          [key: string]: {
            deviceSpecificGet?: (deviceIdType: number) => Promise<unknown>;
          };
        };
      }
    ).commandClasses?.['Manufacturer Specific'];

    if (typeof manufacturerSpecificApi?.deviceSpecificGet !== 'function') {
      return;
    }

    try {
      const deviceSerialNumber = await manufacturerSpecificApi.deviceSpecificGet(
        MANUFACTURER_SPECIFIC_SERIAL_NUMBER_TYPE,
      );

      if (typeof deviceSerialNumber !== 'string' || deviceSerialNumber.length === 0) {
        return;
      }

      if (
        (node as ZWaveNode & { deviceSerialNumber?: string }).deviceSerialNumber ===
        deviceSerialNumber
      ) {
        return;
      }

      (node as ZWaveNode & { deviceSerialNumber?: string }).deviceSerialNumber = deviceSerialNumber;
      this.log.info(`Node ${node.nodeId} reported device serial number: ${deviceSerialNumber}`);
      this.emit('node updated', node);
    } catch (err) {
      this.log.debug(`Node ${node.nodeId} did not provide a device serial number yet: ${err}`);
    }
  }

  private removeNode(node: ZWaveNode) {
    const listeners = this.nodeListeners.get(node.nodeId);
    if (listeners) {
      node.off('ready', listeners.ready);
      node.off('value updated', listeners.value);
      node.off('value added', listeners.value);
      node.off('metadata updated', listeners.metadata);
      node.off('value notification', listeners.notification);
      if (listeners.interviewStageCompleted) {
        node.off('interview stage completed', listeners.interviewStageCompleted);
      }
      if (listeners.interviewFailed) {
        node.off('interview failed', listeners.interviewFailed);
      }
      if (listeners.onWakeUp) {
        node.off('wake up', listeners.onWakeUp);
      }
      if (listeners.onSleep) {
        node.off('sleep', listeners.onSleep);
      }
      if (listeners.onDead) {
        node.off('dead', listeners.onDead);
      }
      if (listeners.onAlive) {
        node.off('alive', listeners.onAlive);
      }
      this.nodeListeners.delete(node.nodeId);
    }
    this.nodes.delete(node.nodeId);
    this.emit('node removed', node);
  }

  /**
   * Parses security keys from options into Buffer format for Z-Wave JS.
   */
  private parseSecurityKeys() {
    const securityKeys: Record<string, Buffer> = {};
    const securityKeysLongRange: Record<string, Buffer> = {};

    if (!this.options.securityKeys) {
      return { securityKeys: undefined, securityKeysLongRange: undefined };
    }

    const keys = this.options.securityKeys;
    const parse = (val: string | undefined) => {
      if (val && val.length === 32 && /^[0-9a-fA-F]+$/.test(val)) {
        return Buffer.from(val, 'hex');
      }
      return undefined;
    };

    const s0 = parse(keys.S0_Legacy);
    if (s0) {
      securityKeys.S0_Legacy = s0;
    }
    const s2u = parse(keys.S2_Unauthenticated);
    if (s2u) {
      securityKeys.S2_Unauthenticated = s2u;
    }
    const s2a = parse(keys.S2_Authenticated);
    if (s2a) {
      securityKeys.S2_Authenticated = s2a;
    }
    const s2c = parse(keys.S2_AccessControl);
    if (s2c) {
      securityKeys.S2_AccessControl = s2c;
    }
    const s2a_lr = parse(keys.S2_Authenticated_LR) || s2a;
    if (s2a_lr) {
      securityKeysLongRange.S2_Authenticated = s2a_lr;
    }
    const s2c_lr = parse(keys.S2_AccessControl_LR) || s2c;
    if (s2c_lr) {
      securityKeysLongRange.S2_AccessControl = s2c_lr;
    }

    return {
      securityKeys: Object.keys(securityKeys).length > 0 ? securityKeys : undefined,
      securityKeysLongRange:
        Object.keys(securityKeysLongRange).length > 0 ? securityKeysLongRange : undefined,
    };
  }

  public async start(): Promise<void> {
    // RACE FIX: explicitly stop and nullify any previous driver before re-starting
    if (this.driver) {
      try {
        await this.stop();
      } catch {
        /* ignore */
      }
    }

    const { securityKeys, securityKeysLongRange } = this.parseSecurityKeys();
    const storagePath = this.options.storagePath || process.cwd();

    const logLevel = this.options.debug ? 'debug' : 'info';

    // Re-create driver instance to support hot-recovery
    this.driver = new Driver(this.serialPort, {
      securityKeys,
      securityKeysLongRange,
      logConfig: {
        enabled: !!this.options.debug,
        level: logLevel,
        forceConsole: !!this.options.debug,
        showLogo: false,
      },
      storage: {
        cacheDir: path.join(storagePath, 'zwave-js-cache'),
        deviceConfigPriorityDir: path.join(storagePath, 'zwave-js-config'),
      },
      features: { softReset: false },
      emitValueUpdateAfterSetValue: true,
      inclusionUserCallbacks: {
        grantSecurityClasses: async (req) => {
          this.log.info(`[S2] Granting security classes: ${req.securityClasses.join(', ')}`);
          return req;
        },
        validateDSKAndEnterPIN: async (dsk) => {
          this.pendingS2Pin = undefined;
          this.emit('status updated', 'S2 PIN REQUIRED');
          this.log.warn('**********************************************************');
          this.log.warn('[S2] SECURITY PIN REQUIRED FOR INCLUSION');
          this.log.warn(`[S2] DEVICE DSK: ${dsk}`);
          this.log.warn('[S2] Please enter the 5-digit PIN from the device label.');
          this.log.warn(' ');
          this.log.warn('[S2] OPTION 1: Enter PIN in HomeKit App (Controller/Eve)');
          this.log.warn('[S2] OPTION 2: Terminal Instruction:');
          this.log.warn(`     echo "12345" > ${path.join(storagePath, 's2_pin.txt')}`);
          this.log.warn(' ');
          this.log.warn('[S2] Waiting 3 minutes for PIN...');
          this.log.warn('**********************************************************');

          return new Promise<string | false>((resolve) => {
            const pinFilePath = path.join(storagePath, 's2_pin.txt');
            let resolved = false;
            let watcher: fs.FSWatcher | undefined;
            const cleanup = () => {
              if (watcher) {
                watcher.close();
              }
              this.off('pin-received', checkPinRef);
              if (timer) {
                clearTimeout(timer);
              }
            };
            function checkPin(this: ZWaveController) {
              if (resolved) {
                return;
              }
              if (this.pendingS2Pin && /^\d{5}$/.test(this.pendingS2Pin)) {
                resolved = true;
                cleanup();
                resolve(this.pendingS2Pin);
                this.pendingS2Pin = undefined;
                return;
              }
              if (fs.existsSync(pinFilePath)) {
                let pin: string;
                try {
                  pin = fs.readFileSync(pinFilePath, 'utf8').trim();
                } catch (err) {
                  this.log.warn(
                    `Failed to read S2 PIN file ${pinFilePath}: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                  return;
                }

                try {
                  fs.unlinkSync(pinFilePath);
                } catch (err) {
                  this.log.debug(
                    `Failed to delete S2 PIN file ${pinFilePath}: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                }

                if (/^\d{5}$/.test(pin)) {
                  resolved = true;
                  cleanup();
                  resolve(pin);
                  return;
                }
              }
            }
            const checkPinRef = checkPin.bind(this);
            try {
              watcher = fs.watch(storagePath, (et, fn) => {
                if (fn === 's2_pin.txt') {
                  try {
                    checkPin.call(this);
                  } catch (err) {
                    this.log.warn(
                      `Error while processing S2 PIN file event: ${
                        err instanceof Error ? err.message : String(err)
                      }`,
                    );
                  }
                }
              });
            } catch {
              /* ignore */
            }
            this.on('pin-received', checkPinRef);
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            const timer = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                cleanup();
                resolve(false);
              }
            }, 180000);
            checkPin.call(this);
          }) as Promise<string | false>;
        },
        abort: () => {
          this.log.warn('[S2] Inclusion aborted.');
          this.emit('status updated', 'Inclusion Aborted');
        },
      },
    });

    /**
     * Explicit log piping for Homebridge Child Bridge visibility.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.driver as any).on('logging', (message: any) => {
      const prefix = `[Z-Wave JS] [${message.label || 'Driver'}]`;
      if (this.options.debug) {
        this.log.info(`${prefix} ${message.message}`);
      }
    });

    this.driver.on('error', (err: Error) => {
      this.log.error('Z-Wave driver error:', err);
      this.emit('status updated', 'Hardware Error');
    });

    this.driver.on('driver ready', () => {
      this.emit('status updated', 'Driver Ready');
    });

    this.setupControllerListeners();

    /**
     * DEADLOCK FIX: ensure the start() promise rejects if the driver fails
     * to start or times out, allowing the platform to retry.
     */
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.log.error('Z-Wave driver start timed out.');
        reject(new Error('Driver startup timeout'));
      }, 30000);

      this.driver!.once('driver ready', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    try {
      await this.driver.start();
      await readyPromise;
    } catch (err) {
      // Cleanup on failure to allow retry with fresh state
      await this.stop();
      throw err;
    }

    let retries = 0;
    while (!this.homeId && retries < 10) {
      await new Promise((res) => setTimeout(res, 500));
      retries++;
    }
    if (!this.homeId) {
      throw new Error('homeId not available');
    }
  }

  public async stop(): Promise<void> {
    this.log.debug('Stopping Z-Wave controller and cleaning up listeners...');
    this.clearHealWatchdog();
    this.healState = 'idle';
    for (const [nodeId, node] of this.nodes) {
      const listeners = this.nodeListeners.get(nodeId);
      if (listeners) {
        node.off('ready', listeners.ready);
        node.off('value updated', listeners.value);
        node.off('value added', listeners.value);
        node.off('metadata updated', listeners.metadata);
        node.off('value notification', listeners.notification);
        if (listeners.interviewStageCompleted) {
          node.off('interview stage completed', listeners.interviewStageCompleted);
        }
        if (listeners.interviewFailed) {
          node.off('interview failed', listeners.interviewFailed);
        }
        if (listeners.onWakeUp) {
          node.off('wake up', listeners.onWakeUp);
        }
        if (listeners.onSleep) {
          node.off('sleep', listeners.onSleep);
        }
        if (listeners.onDead) {
          node.off('dead', listeners.onDead);
        }
        if (listeners.onAlive) {
          node.off('alive', listeners.onAlive);
        }
      }
    }
    this.nodeListeners.clear();

    if (this.driver) {
      /**
       * LISTENER LEAK FIX: Always remove all listeners from the driver and controller
       * BEFORE attempting destroy(), ensuring that even if destroy() hangs or times out,
       * no further events will be processed by this instance.
       */
      this.driver.removeAllListeners();
      try {
        if (this.driver.controller) {
          for (const [event, listener] of Object.entries(this.controllerListeners)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.driver.controller.off(event as any, listener);
          }
        }
      } catch {
        /* ignore */
      }

      try {
        /**
         * ZOMBIE DRIVER FIX: Ensure destroy() doesn't hang the whole process.
         * If it times out, we log a warning but still nullify the reference so
         * a new driver can be attempted (though serial port may be locked).
         */
        await Promise.race([
          this.driver.destroy(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Driver destroy timeout (Serial port may be locked)')),
              3000,
            ).unref(),
          ),
        ]);
        this.log.info('Z-Wave driver stopped.');
      } catch (err) {
        this.log.error(
          'CRITICAL: Z-Wave driver did not stop cleanly. Serial port might remain busy:',
          err instanceof Error ? err.message : err,
        );
      } finally {
        this.driver = undefined;
      }
    }

    this.nodes.clear();
    // CRITICAL REGRESSION FIX: DO NOT call removeAllListeners() here.
    // This instance of ZWaveController persists across driver restarts,
    // and its listeners (from Platform and ControllerAccessory) must remain intact.
  }

  public async startInclusion(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }
    try {
      return await this.driver.controller.beginInclusion({ strategy: InclusionStrategy.Default });
    } catch (err) {
      this.log.error('Failed to start inclusion:', err);
      return false;
    }
  }

  public async stopInclusion(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }
    try {
      return await this.driver.controller.stopInclusion();
    } catch (err) {
      this.log.error('Failed to stop inclusion:', err);
      return false;
    }
  }

  public async startExclusion(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }
    try {
      return await this.driver.controller.beginExclusion();
    } catch (err) {
      this.log.error('Failed to start exclusion:', err);
      return false;
    }
  }

  public async stopExclusion(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }
    try {
      return await this.driver.controller.stopExclusion();
    } catch (err) {
      this.log.error('Failed to stop exclusion:', err);
      return false;
    }
  }

  /**
   * Whether a route rebuild this plugin started is still in progress. This is the plugin's own
   * view of the lifecycle, which can differ from the driver's: see `startHealing` for why.
   */
  public isRebuildingRoutes(): boolean {
    return this.driver?.controller.isRebuildingRoutes === true;
  }

  public isHealing(): boolean {
    return this.healState !== 'idle';
  }

  /**
   * Starts a route rebuild. `started` covers a rebuild this plugin owns, including one already
   * running from an earlier request here. `busy` means the driver is still rebuilding from a
   * request this plugin no longer tracks, which is a different situation for the caller: work
   * is happening, it just is not this one. A second request never starts a second rebuild.
   */
  public async startHealing(): Promise<HealStartResult> {
    if (!this.driver) {
      return 'refused';
    }

    if (this.healState !== 'idle') {
      this.log.info(
        `Z-Wave Controller: Heal already ${this.healState}; ignoring duplicate start request.`,
      );
      return 'started';
    }

    /**
     * The driver is the authority on whether a rebuild is running, and it can disagree with this
     * plugin. `stopRebuildingRoutes` removes the task asynchronously, and when the parent task is
     * waiting on a node it is not in the scheduler's queue to be removed, so it resumes and keeps
     * rebuilding the nodes that are left. Starting another rebuild on top of that one would run
     * two in parallel over the same mesh.
     */
    if (this.driver.controller.isRebuildingRoutes === true) {
      this.log.warn(
        'Z-Wave Controller: The driver is still rebuilding routes from an earlier request, so ' +
          'this one was not started. Try again once it has finished.',
      );
      return 'busy';
    }

    this.healState = 'starting';
    this.log.info('Z-Wave Controller: Requesting rebuild of all routes (Network Heal)...');

    try {
      /**
       * Sleeping nodes are skipped: zwave-js would otherwise hold the rebuild open until every
       * sleepy device happens to wake up, which can take days and never reports completion.
       */
      const started = this.driver.controller.beginRebuildingRoutes({
        includeSleeping: this.options.healIncludesSleepingDevices === true,
      });

      if (!started) {
        // An already-running rebuild was handled above, so this is a genuine refusal.
        this.healState = 'idle';
        this.clearHealWatchdog();
        this.log.warn('Z-Wave Controller: The controller refused to start a route rebuild.');
        return 'refused';
      }

      this.healState = 'active';
      this.startHealWatchdog();
      this.log.info('Z-Wave Controller: Heal started.');
      return 'started';
    } catch (err) {
      this.healState = 'idle';
      this.clearHealWatchdog();
      this.log.error('Failed to start network heal:', err);
      return 'refused';
    }
  }

  public async stopHealing(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }
    this.log.info('Z-Wave Controller: Requesting to stop network heal...');
    this.clearHealWatchdog();

    try {
      const stopped = this.driver.controller.stopRebuildingRoutes();
      this.log.info(`Z-Wave Controller: Heal stopped: ${stopped}`);
      return stopped;
    } catch (err) {
      this.log.error('Failed to stop network heal:', err);
      return false;
    } finally {
      /**
       * The library reports nothing when a rebuild is cancelled, so the lifecycle is closed
       * optimistically here. Only announce it if one was actually running: an OFF write against
       * an idle switch, or a mutex path, must not look like a cancellation.
       */
      const wasRunning = this.healState !== 'idle';
      this.healState = 'idle';
      if (wasRunning) {
        this.announceHealEnded('Heal Network Stopped');
        this.emit('heal network stopped', 'cancelled');
      }
    }
  }

  /**
   * Reports how a heal ended and then returns the status to idle, so a cancelled or timed-out
   * heal does not leave its last progress count on the characteristic indefinitely.
   *
   * The pending reset belongs to the heal that ended. A new heal started inside the window
   * cancels it, and the callback checks again on the way out, so one heal's epilogue can never
   * overwrite the next one's progress.
   */
  private announceHealEnded(status: string): void {
    this.clearHealStatusLinger();
    this.emit('status updated', status);
    this.healStatusLinger = setTimeout(() => {
      this.healStatusLinger = undefined;
      if (this.healState !== 'idle') {
        return;
      }
      this.emit('status updated', 'Driver Ready');
    }, HEAL_STATUS_LINGER_MS);
    this.healStatusLinger.unref();
  }

  private clearHealStatusLinger(): void {
    if (this.healStatusLinger) {
      clearTimeout(this.healStatusLinger);
      this.healStatusLinger = undefined;
    }
  }

  private startHealWatchdog(): void {
    this.clearHealWatchdog();

    /**
     * With sleeping devices included the driver emits nothing at all while it waits for one to
     * wake, so an inactivity watchdog would cancel a rebuild that is working exactly as asked.
     * The heal switch remains the way out of a run that is taking too long.
     */
    if (this.options.healIncludesSleepingDevices === true) {
      return;
    }
    this.healWatchdog = setTimeout(() => {
      void this.handleHealTimeout().catch((err) => {
        this.log.error(
          `Network heal timeout handling failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, REBUILD_ROUTES_IDLE_TIMEOUT_MS);
    this.healWatchdog.unref();
  }

  /**
   * Ends a heal that never reported completion. Stopping the rebuild can itself fail, and the
   * lifecycle has to close either way, so the failure is logged and the timeout is still
   * reported rather than being left to surface as an unhandled rejection.
   */
  private async handleHealTimeout(): Promise<void> {
    this.healWatchdog = undefined;
    if (this.healState === 'idle') {
      return;
    }

    this.log.error(
      `Network heal reported no progress for ${Math.round(
        REBUILD_ROUTES_IDLE_TIMEOUT_MS / 60000,
      )} minutes. Stopping it and reporting a timeout.`,
    );
    this.healState = 'idle';

    try {
      this.driver?.controller.stopRebuildingRoutes();
    } catch (err) {
      this.log.error(
        `Failed to stop the timed-out heal: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.announceHealEnded('Heal Network Timed Out');
    this.emit('heal network stopped', 'timeout');
  }

  private clearHealWatchdog(): void {
    if (this.healWatchdog) {
      clearTimeout(this.healWatchdog);
      this.healWatchdog = undefined;
    }
  }

  /**
   * Reports whether a node may be removed, and why. A node that is merely unreachable is not
   * eligible: an unpowered but otherwise healthy device looks exactly the same from here.
   */
  public async assessFailedNodeRemoval(nodeId: number): Promise<FailedNodeRemovalAssessment> {
    const node = this.nodes.get(nodeId);
    const name = node
      ? node.name || node.label || node.deviceConfig?.label || `Node ${nodeId}`
      : `Node ${nodeId}`;
    const status = node?.status ?? NodeStatus.Unknown;
    const base = { nodeId, name, status };

    if (!this.driver) {
      return { ...base, eligible: false, reason: 'The Z-Wave driver is not running.' };
    }

    if (nodeId === (this.driver.controller.ownNodeId ?? 1)) {
      return {
        ...base,
        eligible: false,
        reason: `Node ${nodeId} is the controller and cannot be removed.`,
      };
    }

    if (!node) {
      return { ...base, eligible: false, reason: `Node ${nodeId} is not part of this network.` };
    }

    /**
     * Keyed on what the device IS, not on what it is doing right now. A battery device moves
     * between Asleep, Awake and Unknown, and Unknown is exactly the state a node sits in while
     * it waits for its first wake-up after a restart, which is when a user is most likely to
     * reach for Remove.
     */
    if (!node.isListening && !node.isFrequentListening) {
      return {
        ...base,
        eligible: false,
        reason:
          `Node ${nodeId} is a battery device that sleeps between wake-ups. This plugin does ` +
          'not remove sleeping devices, because one that is merely out of battery looks the ' +
          'same as one that is gone. Remove it by excluding it from the network instead.',
      };
    }

    let isFailed: boolean;
    try {
      isFailed = await this.driver.controller.isFailedNode(nodeId);
    } catch (err) {
      return {
        ...base,
        eligible: false,
        reason: `The controller could not check Node ${nodeId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (!isFailed) {
      return {
        ...base,
        eligible: false,
        reason: `The controller does not consider Node ${nodeId} failed.`,
      };
    }

    return {
      ...base,
      eligible: true,
      reason:
        `The controller reports Node ${nodeId} as failed. Confirm the device is gone for good ` +
        'before removing it, because an unpowered device also reports as failed.',
    };
  }

  /**
   * Removes a single node the caller has explicitly identified. `confirmNodeId` must repeat the
   * node ID so a mis-routed request cannot delete the wrong device, and eligibility is checked
   * again immediately before the removal.
   */
  public async removeFailedNode(nodeId: number, confirmNodeId: number): Promise<void> {
    if (!this.driver) {
      throw new Error('Driver not started');
    }

    if (confirmNodeId !== nodeId) {
      throw new Error(
        `Refusing to remove Node ${nodeId}: the confirmation did not match the node ID.`,
      );
    }

    const assessment = await this.assessFailedNodeRemoval(nodeId);
    this.log.info(
      `Failed-node removal check for Node ${nodeId} (${assessment.name}): ` +
        `${assessment.eligible ? 'eligible' : 'not eligible'} - ${assessment.reason}`,
    );

    if (!assessment.eligible) {
      throw new Error(assessment.reason);
    }

    try {
      await this.driver.controller.removeFailedNode(nodeId);
      this.log.info(`Node ${nodeId} (${assessment.name}) removed successfully.`);
      this.emit('status updated', `Node ${nodeId} Removed`);
    } catch (err) {
      this.log.error(`Failed to remove failed node ${nodeId}:`, err);
      throw err;
    }
  }

  /**
   * An RSSI is a dBm measurement or one of three error states that zwave-js encodes as numbers
   * above the measurable range (125 no signal, 126 receiver saturated, 127 not available).
   * Passed on as numbers they read as a very strong signal, so a measurement stays a number and
   * an error state becomes the words zwave-js uses for it.
   */
  private describeRssi(rssi: number | undefined): number | string | undefined {
    if (rssi === undefined) {
      return undefined;
    }

    return isRssiError(rssi) ? rssiToString(rssi) : rssi;
  }

  /**
   * Collects what the controller knows about how it reaches a node. Routes are chosen per
   * transmission, so these values describe the last observed route rather than a fixed path.
   */
  public async getNodeRouteDiagnostics(nodeId: number): Promise<NodeRouteDiagnostics> {
    if (!this.driver) {
      throw new Error('Driver not started');
    }

    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    const controller = this.driver.controller;
    const statistics = node.statistics;
    const lifeline = controller.getKnownLifelineRoutes().get(nodeId);

    let neighbors: number[] | undefined;
    try {
      neighbors = [...(await controller.getNodeNeighbors(nodeId))].sort((a, b) => a - b);
    } catch (err) {
      this.log.debug(`Could not read neighbors for Node ${nodeId}: ${err}`);
    }

    let backgroundRSSI: Record<string, number | string> | undefined;
    try {
      const rssi = await controller.getBackgroundRSSI();
      backgroundRSSI = Object.fromEntries(
        Object.entries(rssi)
          .filter(([, value]) => value !== undefined)
          .map(([channel, value]) => [channel, this.describeRssi(value as number)]),
      ) as Record<string, number | string>;
    } catch (err) {
      this.log.debug(`Could not read background RSSI: ${err}`);
    }

    const describeRoute = (route?: {
      repeaters: number[];
      rssi?: number;
      protocolDataRate?: number;
      routeFailedBetween?: [number, number];
    }) =>
      route
        ? {
            repeaters: [...route.repeaters],
            direct: route.repeaters.length === 0,
            ackRSSI: this.describeRssi(route.rssi),
            protocolDataRate: route.protocolDataRate,
            routeFailedBetween: route.routeFailedBetween,
          }
        : undefined;

    return {
      nodeId,
      name: node.name || node.label || node.deviceConfig?.label || `Node ${nodeId}`,
      status: node.status,
      neighbors,
      lastWorkingRoute: describeRoute(statistics?.lwr ?? lifeline?.lwr),
      nextToLastWorkingRoute: describeRoute(statistics?.nlwr ?? lifeline?.nlwr),
      averageAckRSSI: this.describeRssi(statistics?.rssi),
      roundTripTimeMs: statistics?.rtt,
      commandsTX: statistics?.commandsTX,
      commandsRX: statistics?.commandsRX,
      commandsDroppedTX: statistics?.commandsDroppedTX,
      commandsDroppedRX: statistics?.commandsDroppedRX,
      lastSeen: statistics?.lastSeen?.toISOString(),
      backgroundRSSI,
    };
  }

  /**
   * Updates the user-defined name for a node in the Z-Wave network.
   * This uses the Node Naming and Location CC to send the name to the device.
   * If the device doesn't support this CC, falls back to local-only storage.
   */
  public async setNodeName(nodeId: number, name: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }
    this.log.info(`Updating name for Node ${nodeId} to: "${name}"`);

    // Check if the device supports Node Naming and Location CC (0x77)
    const supportsNamingCC =
      typeof node.supportsCC === 'function' &&
      node.supportsCC(CommandClasses['Node Naming and Location']);

    if (supportsNamingCC) {
      await node.commandClasses['Node Naming and Location'].setName(name);
    } else {
      // Fall back to local-only storage if CC is not supported
      this.log.warn(
        `Node ${nodeId} does not support Node Naming and Location CC, storing name locally only`,
      );
      node.name = name;
    }
  }

  public async getAvailableFirmwareUpdates(nodeId: number): Promise<unknown[]> {
    if (nodeId === 1) {
      this.log.debug('Node 1 is the controller; skipping firmware update check.');
      return [];
    }
    const node = this.nodes.get(nodeId);
    if (!node) {
      this.log.error(`Node ${nodeId} not found in controller node map.`);
      throw new Error(`Node ${nodeId} not found`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (node as any).getAvailableFirmwareUpdates !== 'function') {
      this.log.warn(`Node ${nodeId} does not support firmware update discovery via Z-Wave JS.`);
      return [];
    }

    this.log.info(`Checking for firmware updates for Node ${nodeId}...`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updates = await (node as any).getAvailableFirmwareUpdates();
      this.log.info(`Found ${updates.length} available updates for Node ${nodeId}`);
      return updates;
    } catch (err) {
      /**
       * Rethrown rather than reported as an empty list. An empty list means the service has
       * nothing for this device, which the UI says plainly; a failed check means it does not
       * know, and the two must not look the same to someone deciding whether to wait.
       */
      this.log.error(`Failed to check for updates for Node ${nodeId}:`, err);
      throw err;
    }
  }

  public async refreshNodeInfo(
    nodeId: number,
  ): Promise<{ nodeId: number; requiresWakeUp: boolean }> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }

    const requiresWakeUp = !node.isListening && !node.isFrequentListening;
    this.log.info(
      `Refreshing interview information for Node ${nodeId}${requiresWakeUp ? ' (manual wake-up likely required)' : ''}...`,
    );

    // Do not await refreshInfo() here. For sleepy nodes zwave-js may wait until
    // the next wake-up before it begins the fresh interview, and the UI should be
    // able to show "queued" state immediately instead of blocking on that wake-up.
    void node.refreshInfo().catch((err) => {
      this.log.error(`Failed to refresh node info for Node ${nodeId}:`, err);
    });

    return { nodeId, requiresWakeUp };
  }

  public async beginFirmwareUpdate(nodeId: number, update: unknown): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }
    this.log.info(`Starting firmware update for Node ${nodeId}...`);
    let result: { success?: boolean; status?: number } | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await (node as any).updateFirmware([update]);
    } catch (err) {
      this.log.error(`Failed to start firmware update for Node ${nodeId}:`, err);
      throw err;
    }

    /**
     * Resolving is not succeeding. The driver reports a refused or failed transfer in the
     * result, so a caller that only watches for a thrown error would call a failed update done.
     */
    if (result?.success !== true) {
      const detail = result?.status === undefined ? '' : ` (status ${result.status})`;
      this.log.error(`Firmware update for Node ${nodeId} did not succeed${detail}.`);
      throw new Error(`Firmware update for Node ${nodeId} did not succeed${detail}.`);
    }
  }

  public async abortFirmwareUpdate(nodeId: number): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }
    this.log.info(`Aborting firmware update for Node ${nodeId}...`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (node as any).abortFirmwareUpdate();
    } catch (err) {
      this.log.error(`Failed to abort firmware update for Node ${nodeId}:`, err);
      throw err;
    }
  }
}
