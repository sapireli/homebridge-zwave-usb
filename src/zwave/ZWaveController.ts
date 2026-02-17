import { Logger } from 'homebridge';
import { Driver, ZWaveNode, InclusionStrategy } from 'zwave-js';
import { EventEmitter } from 'events';
import { IZWaveController, ZWaveValueEvent } from './interfaces';
import path from 'path';
import fs from 'fs';

export interface ZWaveControllerOptions {
  debug?: boolean;
  storagePath?: string;
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
  private healSafetyTimer: NodeJS.Timeout | undefined;

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
    this.log.info(`[S2] Received PIN input: ${pin}`);
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          'rebuild routes progress': (progress: any) => {
            const done = Array.from(progress.values()).filter((v) => v !== 0).length;
            const total = progress.size;
            this.log.info(`Heal Network Progress: ${done}/${total} nodes completed`);
            this.emit('status updated', `Heal: ${done}/${total}`);
            this.emit('heal network progress', progress);

            // Safety: if we are at 100%, but no 'done' event arrives within 5s, auto-complete
            if (done === total && total > 0) {
              if (this.healSafetyTimer) {
                clearTimeout(this.healSafetyTimer);
              }
              this.healSafetyTimer = setTimeout(() => {
                this.log.info('Heal Network Safety Timeout: Triggering completion.');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this.driver?.controller as any).emit('rebuild routes done', new Map());
              }, 5000);
            }
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          'rebuild routes done': (result: any) => {
            if (this.healSafetyTimer) {
              clearTimeout(this.healSafetyTimer);
              this.healSafetyTimer = undefined;
            }
            this.log.info('Heal Network Complete');
            this.emit('status updated', 'Heal Network Done');
            setTimeout(() => this.emit('status updated', 'Driver Ready'), 5000);
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
        this.driver.controller.on('inclusion started', this.controllerListeners['inclusion started']);
        this.driver.controller.on('inclusion stopped', this.controllerListeners['inclusion stopped']);
        this.driver.controller.on('exclusion started', this.controllerListeners['exclusion started']);
        this.driver.controller.on('exclusion stopped', this.controllerListeners['exclusion stopped']);
        this.driver.controller.on(
          'rebuild routes progress',
          this.controllerListeners['rebuild routes progress'],
        );
        this.driver.controller.on('rebuild routes done', this.controllerListeners['rebuild routes done']);
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
    this.log.info(
      `Node ${node.nodeId} added to controller (Status: ${status}, Interview Stage: ${node.interviewStage})`,
    );

    const onReady = () => {
      this.log.info(`Node ${node.nodeId} is ready (Interview Stage: ${node.interviewStage})`);
      this.emit('status updated', `Node ${node.nodeId} Ready`);
      this.emit('node ready', node);
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
    };

    const onInterviewFailed = (_n: ZWaveNode, args: { errorMessage: string }) => {
      this.log.error(`Node ${node.nodeId} interview failed: ${args.errorMessage}`);
    };

    const onWakeUp = () => {
      this.log.info(`Node ${node.nodeId} has woken up. Interview will resume.`);
      this.emit('status updated', `Node ${node.nodeId} Awake`);
    };

    const onSleep = () => {
      this.log.info(`Node ${node.nodeId} has gone to sleep. Interview is paused.`);
      this.emit('status updated', `Node ${node.nodeId} Asleep`);
    };

    const onDead = () => {
      this.log.info(`Node ${node.nodeId} is dead.`);
      this.emit('node ready', node); // Trigger refresh in platform
    };

    const onAlive = () => {
      this.log.info(`Node ${node.nodeId} is alive.`);
      this.emit('node ready', node); // Trigger refresh in platform
    };

    const onFirmwareUpdateProgress = (_n: ZWaveNode, sent: number, total: number) => {
      this.emit('firmware update progress', node.nodeId, sent, total);
    };

    const onFirmwareUpdateFinished = (_n: ZWaveNode, status: unknown, waitTime?: number) => {
      this.emit('firmware update finished', node.nodeId, status, waitTime);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node.on('firmware update progress', onFirmwareUpdateProgress as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node.on('firmware update finished', onFirmwareUpdateFinished as any);

    this.log.info(`Node ${node.nodeId} registered with event listeners (ready: ${node.ready})`);

    if (node.ready) {
      this.log.info(`Node ${node.nodeId} is already ready, emitting node ready immediately`);
      this.emit('node ready', node);
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
    if (this.healSafetyTimer) {
      clearTimeout(this.healSafetyTimer);
      this.healSafetyTimer = undefined;
    }
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
            setTimeout(() => reject(new Error('Driver destroy timeout (Serial port may be locked)')), 3000),
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

  public async startHealing(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }
    this.log.info('Z-Wave Controller: Requesting rebuild of all routes (Network Heal)...');
    try {
      const started = await this.driver.controller.beginRebuildingRoutes();
      this.log.info(`Z-Wave Controller: Heal started: ${started}`);
      return started;
    } catch (err) {
      this.log.error('Failed to start network heal:', err);
      return false;
    }
  }

  public async stopHealing(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }
    this.log.info('Z-Wave Controller: Requesting to stop network heal...');
    try {
      const stopped = await this.driver.controller.stopRebuildingRoutes();
      this.log.info(`Z-Wave Controller: Heal stopped: ${stopped}`);
      return stopped;
    } catch (err) {
      this.log.error('Failed to stop network heal:', err);
      return false;
    }
  }

  /**
   * REMOVE FAILED NODE FIX: Allows users to prune dead/broken devices
   * that can no longer be physically excluded.
   */
  public async removeFailedNode(nodeId: number): Promise<void> {
    if (!this.driver) {
      throw new Error('Driver not started');
    }
    this.log.info(`Attempting to remove failed node ${nodeId}...`);
    try {
      // 1. Z-Wave JS requires checking if the node is actually failed first
      const isFailed = await this.driver.controller.isFailedNode(nodeId);
      if (!isFailed) {
        throw new Error(`Node ${nodeId} is not marked as failed. Cannot remove.`);
      }

      // 2. Instruct controller to remove it
      await this.driver.controller.removeFailedNode(nodeId);
      this.log.info(`Node ${nodeId} removed successfully.`);
      this.emit('status updated', `Node ${nodeId} Removed`);
        } catch (err) {
          this.log.error(`Failed to remove failed node ${nodeId}:`, err);
          throw err;
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
    
          
    
              if (typeof (node as any).getAvailableFirmwareUpdates !== 'function') {
    
                this.log.warn(`Node ${nodeId} does not support firmware update discovery via Z-Wave JS.`);
    
                return [];
    
              }
    
          
    
              this.log.info(`Checking for firmware updates for Node ${nodeId}...`);
    
              try {
    
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
    
                const updates = await (node as any).getAvailableFirmwareUpdates();          this.log.info(`Found ${updates.length} available updates for Node ${nodeId}`);
          return updates;
        } catch (err) {
          this.log.error(`Failed to check for updates for Node ${nodeId}:`, err);
          return [];
        }
      }
    
        public async beginFirmwareUpdate(nodeId: number, update: unknown): Promise<void> {
          const node = this.nodes.get(nodeId);
          if (!node) {
            throw new Error(`Node ${nodeId} not found`);
          }
          this.log.info(`Starting firmware update for Node ${nodeId}...`);
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (node as any).updateFirmware([update]);        } catch (err) {
          this.log.error(`Failed to start firmware update for Node ${nodeId}:`, err);
          throw err;
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
