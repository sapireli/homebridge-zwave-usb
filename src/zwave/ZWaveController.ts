import { Logger } from 'homebridge';
import { Driver, ZWaveNode, InclusionStrategy } from 'zwave-js';
import { EventEmitter } from 'events';
import { IZWaveController } from './interfaces';
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

export class ZWaveController extends EventEmitter implements IZWaveController {
  private driver: Driver;
  public readonly nodes = new Map<number, ZWaveNode>();
  private pendingS2Pin: string | undefined;
  
  private nodeListeners = new Map<number, { 
    ready: () => void;
    value: () => void;
    interviewStageCompleted?: (node: ZWaveNode, stageName: string) => void;
    interviewFailed?: (node: ZWaveNode, args: { errorMessage: string }) => void;
    onWakeUp?: (node: ZWaveNode) => void;
    onSleep?: (node: ZWaveNode) => void;
  }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private controllerListeners: Record<string, (...args: any[]) => void> = {};

  constructor(
    private readonly log: Logger,
    private readonly serialPort: string,
    private readonly options: ZWaveControllerOptions = {},
  ) {
    super();
    
    const securityKeys: Record<string, Buffer> = {};
    const securityKeysLongRange: Record<string, Buffer> = {};

    if (this.options.securityKeys) {
      const keys = this.options.securityKeys;
      
      // Helper to parse key - must be 32 hex characters
      const parse = (val: string | undefined) => {
          if (val && val.length === 32 && /^[0-9a-fA-F]+$/.test(val)) {
              return Buffer.from(val, 'hex');
          }
          if (val && val.length > 0) {
              this.log.warn(`Security key "${val.substring(0, 5)}..." is invalid (must be 32 hex characters). Skipping.`);
          }
          return undefined;
      };

      // Classic Keys
      const s0 = parse(keys.S0_Legacy);
      if (s0) securityKeys.S0_Legacy = s0;
      
      const s2u = parse(keys.S2_Unauthenticated);
      if (s2u) securityKeys.S2_Unauthenticated = s2u;
      
      const s2a = parse(keys.S2_Authenticated);
      if (s2a) securityKeys.S2_Authenticated = s2a;
      
      const s2c = parse(keys.S2_AccessControl);
      if (s2c) securityKeys.S2_AccessControl = s2c;

      // Long Range Keys (Explicit or Fallback)
      const s2a_lr = parse(keys.S2_Authenticated_LR) || s2a;
      if (s2a_lr) securityKeysLongRange.S2_Authenticated = s2a_lr;

      const s2c_lr = parse(keys.S2_AccessControl_LR) || s2c;
      if (s2c_lr) securityKeysLongRange.S2_AccessControl = s2c_lr;
    }

    // Z-Wave JS logging configuration
    const logConfig = {
        enabled: true,
        level: this.options.debug ? 'debug' : 'warn',
        forceConsole: true,
        showLogo: false,
    };

    const storagePath = this.options.storagePath || process.cwd();

    try {
        this.driver = new Driver(this.serialPort, {
          securityKeys: Object.keys(securityKeys).length > 0 ? securityKeys : undefined,
          securityKeysLongRange: Object.keys(securityKeysLongRange).length > 0 ? securityKeysLongRange : undefined,
          logConfig,
          storage: {
              cacheDir: path.join(storagePath, 'zwave-js-cache'),
              deviceConfigPriorityDir: path.join(storagePath, 'zwave-js-config'),
          },
          features: {
            softReset: false,
          },
          emitValueUpdateAfterSetValue: true,
          inclusionUserCallbacks: {
            grantSecurityClasses: async (request) => {
              this.log.info(`[S2] Granting security classes: ${request.securityClasses.join(', ')}`);
              return request;
            },
            validateDSKAndEnterPIN: async (dsk) => {
              this.pendingS2Pin = undefined; // Reset
              this.emit('status updated', 'S2 PIN REQUIRED - Check App or Logs');
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

              const pinFilePath = path.join(storagePath, 's2_pin.txt');
              const startTime = Date.now();
              const timeout = 180000; // 3 minutes

              while (Date.now() - startTime < timeout) {
                  // Check for terminal file
                  if (fs.existsSync(pinFilePath)) {
                      try {
                          const pin = fs.readFileSync(pinFilePath, 'utf8').trim();
                          fs.unlinkSync(pinFilePath); 
                          if (/^\d{5}$/.test(pin)) {
                              this.log.info('[S2] PIN received from terminal! Proceeding...');
                              this.emit('status updated', 'PIN Received - Pairing...');
                              return pin;
                          }
                      } catch (err) {
                          this.log.error('[S2] Error reading PIN file:', err);
                      }
                  }

                  // Check for characteristic input
                  if (this.pendingS2Pin && /^\d{5}$/.test(this.pendingS2Pin)) {
                      const pin = this.pendingS2Pin;
                      this.pendingS2Pin = undefined;
                      this.log.info('[S2] PIN received from HomeKit! Proceeding...');
                      this.emit('status updated', 'PIN Received - Pairing...');
                      return pin;
                  }

                  await new Promise(resolve => setTimeout(resolve, 1000));
              }

              this.log.error('[S2] PIN entry timed out. Inclusion aborted.');
              this.emit('status updated', 'PIN Entry Timed Out');
              return false;
            },
            abort: () => {
              this.log.warn('[S2] Inclusion aborted.');
            },
          },
        });

        this.driver.on('error', (err: Error) => {
          this.log.error('Z-Wave driver error:', err);
        });

        this.setupControllerListeners();
    } catch (err) {
        this.log.error('Failed to initialize Z-Wave Driver:', err);
        throw err;
    }
  }

  public setS2Pin(pin: string): void {
      this.log.info(`[S2] Received PIN input: ${pin}`);
      this.pendingS2Pin = pin.trim();
  }

  private setupControllerListeners() {
    this.driver.once('driver ready', () => {
      this.log.info('Z-Wave driver is ready.');
      this.emit('status updated', 'Driver Ready');
      try {
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
              this.emit('heal network progress', progress);
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          'rebuild routes done': (result: any) => {
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
        this.driver.controller.on('rebuild routes progress', this.controllerListeners['rebuild routes progress']);
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
      return this.driver.controller.homeId;
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
    
    const statusMap = ['Unknown', 'Alive', 'Awake', 'Asleep', 'Dead'];
    const status = statusMap[node.status] || node.status.toString();
    this.log.info(`Node ${node.nodeId} added to controller (Status: ${status}, Interview Stage: ${node.interviewStage})`);

    const onReady = () => {
      this.log.info(`Node ${node.nodeId} is ready (Interview Stage: ${node.interviewStage})`);
      this.emit('status updated', `Node ${node.nodeId} Ready`);
      this.emit('node ready', node);
    };

    const onValueUpdated = () => {
      this.log.debug(`Node ${node.nodeId} value updated`);
      this.emit('value updated', node);
    };

    const onInterviewStageCompleted = (_node: ZWaveNode, stage: string) => {
      this.log.info(`Node ${node.nodeId} interview stage completed: ${stage}`);
      this.emit('status updated', `Node ${node.nodeId}: ${stage}`);
    };

    const onInterviewFailed = (_node: ZWaveNode, args: { errorMessage: string }) => {
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

    this.nodeListeners.set(node.nodeId, { 
      ready: onReady, 
      value: onValueUpdated,
      interviewStageCompleted: onInterviewStageCompleted,
      interviewFailed: onInterviewFailed,
      onWakeUp,
      onSleep
    });

    node.on('ready', onReady);
    node.on('value updated', onValueUpdated);
    node.on('value added', onValueUpdated);
    node.on('metadata updated', onValueUpdated);
    node.on('interview stage completed', onInterviewStageCompleted);
    node.on('interview failed', onInterviewFailed);
    node.on('wake up', onWakeUp);
    node.on('sleep', onSleep);

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
      node.off('metadata updated', listeners.value);
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
      this.nodeListeners.delete(node.nodeId);
    }
    this.nodes.delete(node.nodeId);
    this.emit('node removed', node);
  }

  public async start(): Promise<void> {
    const readyPromise = new Promise<void>((resolve, _reject) => {
      const timeout = setTimeout(() => {
        this.log.warn('Z-Wave driver start timed out waiting for "driver ready" event. Proceeding anyway...');
        resolve();
      }, 30000);

      this.driver.once('driver ready', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await this.driver.start();
    this.log.info('Z-Wave driver started');
    
    await readyPromise;
  }

  public async stop(): Promise<void> {
    // 1. Remove Node Listeners
    for (const [nodeId, node] of this.nodes) {
      const listeners = this.nodeListeners.get(nodeId);
      if (listeners) {
        node.off('ready', listeners.ready);
        node.off('value updated', listeners.value);
        node.off('value added', listeners.value);
        node.off('metadata updated', listeners.value);
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
      }
    }
    this.nodeListeners.clear();

    // 2. Remove Controller/Driver Listeners
    this.driver.removeAllListeners();
    try {
      if (this.driver.controller) {
        for (const [event, listener] of Object.entries(this.controllerListeners)) {
          this.driver.controller.off(event as any, listener); // eslint-disable-line @typescript-eslint/no-explicit-any
        }
      }
    } catch {
      // Ignore errors if controller is not available
    }

    // 3. Destroy Driver
    await this.driver.destroy();
    this.log.info('Z-Wave driver stopped');

    // 4. Clear Local State
    this.nodes.clear();
    this.removeAllListeners();
  }

  public async startInclusion(): Promise<boolean> {
    this.log.info('Starting inclusion...');
    return await this.driver.controller.beginInclusion({
      strategy: InclusionStrategy.Default,
    });
  }

  public async stopInclusion(): Promise<boolean> {
    this.log.info('Stopping inclusion...');
    return await this.driver.controller.stopInclusion();
  }

  public async startExclusion(): Promise<boolean> {
    this.log.info('Starting exclusion...');
    return await this.driver.controller.beginExclusion();
  }

  public async stopExclusion(): Promise<boolean> {
    this.log.info('Stopping exclusion...');
    return await this.driver.controller.stopExclusion();
  }

  public async startHealing(): Promise<boolean> {
    this.log.info('Starting network heal...');
    return this.driver.controller.beginRebuildingRoutes();
  }

  public async stopHealing(): Promise<boolean> {
    this.log.info('Stopping network heal...');
    return this.driver.controller.stopRebuildingRoutes();
  }
}
