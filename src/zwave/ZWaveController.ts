import { Logger } from 'homebridge';
import { Driver, ZWaveNode, InclusionStrategy } from 'zwave-js';
import { ZwavejsServer } from '@zwave-js/server';
import { EventEmitter } from 'events';
import { IZWaveController } from './interfaces';

export interface ZWaveControllerOptions {
  debug?: boolean;
  securityKeys?: {
    S0_Legacy?: string;
    S2_Unauthenticated?: string;
    S2_Authenticated?: string;
    S2_AccessControl?: string;
  };
  server?: {
      enabled: boolean;
      port: number;
  };
}

export class ZWaveController extends EventEmitter implements IZWaveController {
  private driver: Driver;
  private server: ZwavejsServer | undefined;
  public readonly nodes = new Map<number, ZWaveNode>();

  constructor(
    private readonly log: Logger,
    private readonly serialPort: string,
    private readonly options: ZWaveControllerOptions = {},
  ) {
    super();
    
    // Transform keys to Buffer as required by zwave-js
    const securityKeys: Record<string, Buffer> = {};
    if (this.options.securityKeys) {
      if (this.options.securityKeys.S0_Legacy) {
        securityKeys.S0_Legacy = Buffer.from(this.options.securityKeys.S0_Legacy, 'hex');
      }
      if (this.options.securityKeys.S2_Unauthenticated) {
        securityKeys.S2_Unauthenticated = Buffer.from(this.options.securityKeys.S2_Unauthenticated, 'hex');
      }
      if (this.options.securityKeys.S2_Authenticated) {
        securityKeys.S2_Authenticated = Buffer.from(this.options.securityKeys.S2_Authenticated, 'hex');
      }
      if (this.options.securityKeys.S2_AccessControl) {
        securityKeys.S2_AccessControl = Buffer.from(this.options.securityKeys.S2_AccessControl, 'hex');
      }
    }

    const logLevel = this.options.debug ? 'debug' : 'info';

    this.driver = new Driver(this.serialPort, {
      securityKeys: Object.keys(securityKeys).length > 0 ? securityKeys : undefined,
      logConfig: {
        level: logLevel,
        logToFile: !!this.options.debug, // Log to file only if debug is on
      },
    });

    this.driver.on('error', (err: Error) => {
      this.log.error('Z-Wave driver error:', err);
    });

    this.driver.on('driver ready', () => {
      this.log.info('Z-Wave driver is ready.');
      this.log.info(`Controller Home ID: ${this.driver.controller.homeId}`);
      
      this.driver.controller.nodes.forEach((node) => {
        this.addNode(node);
      });

      // Forward controller events
      this.driver.controller.on('inclusion started', (secure) => {
        this.emit('inclusion started', secure);
      });
      this.driver.controller.on('inclusion stopped', () => {
        this.emit('inclusion stopped');
      });
      this.driver.controller.on('exclusion started', () => {
        this.emit('exclusion started');
      });
      this.driver.controller.on('exclusion stopped', () => {
        this.emit('exclusion stopped');
      });
      this.driver.controller.on('rebuild routes progress', (progress) => {
        this.emit('heal network progress', progress);
      });
      this.driver.controller.on('rebuild routes done', (result) => {
        this.emit('heal network done', result);
      });
    });

    this.driver.controller.on('node added', (node) => {
      this.addNode(node);
      this.emit('node added', node);
    });

    this.driver.controller.on('node removed', (node) => {
      this.removeNode(node);
    });
  }

  public get homeId(): number | undefined {
    try {
      return this.driver.controller.homeId;
    } catch {
      return undefined;
    }
  }

  // Store listeners to allow proper cleanup
  private nodeListeners = new Map<number, { ready: () => void; value: () => void }>();

  private addNode(node: ZWaveNode) {
    this.nodes.set(node.nodeId, node);

    // Define listeners
    const onReady = () => this.emit('node ready', node);
    const onValueUpdated = () => this.emit('value updated', node);

    // Store them for cleanup
    this.nodeListeners.set(node.nodeId, { ready: onReady, value: onValueUpdated });

    // Attach listeners
    node.on('ready', onReady);
    node.on('value updated', onValueUpdated);

    // CRITICAL FIX: If node is already ready (from cache), emit immediately
    if (node.ready) {
      this.emit('node ready', node);
    }
  }

  private removeNode(node: ZWaveNode) {
    const listeners = this.nodeListeners.get(node.nodeId);
    if (listeners) {
      node.off('ready', listeners.ready);
      node.off('value updated', listeners.value);
      this.nodeListeners.delete(node.nodeId);
    }
    this.nodes.delete(node.nodeId);
    this.emit('node removed', node);
  }

  public async start(): Promise<void> {
    await this.driver.start();
    this.log.info('Z-Wave driver started');

    if (this.options.server?.enabled) {
        try {
            this.log.info(`Starting Z-Wave JS Server (Host Mode) on port ${this.options.server.port}...`);
            this.server = new ZwavejsServer(this.driver, { 
                port: this.options.server.port, 
                logger: this.log 
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any); // cast as any because logger interface might mismatch slightly
            await this.server.start();
            this.log.info('Z-Wave JS Server started successfully.');
        } catch (err) {
            this.log.error('Failed to start Z-Wave JS Server:', err);
        }
    }
  }

  public async stop(): Promise<void> {
    if (this.server) {
        this.log.info('Stopping Z-Wave JS Server...');
        await this.server.destroy();
        this.server = undefined;
    }
    await this.driver.destroy();
    this.log.info('Z-Wave driver stopped');
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
