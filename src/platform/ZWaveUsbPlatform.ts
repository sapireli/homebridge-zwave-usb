import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { ZWaveController } from '../zwave/ZWaveController';
import { ZWaveRemoteController } from '../zwave/ZWaveRemoteController';
import { IZWaveController, IZWaveNode } from '../zwave/interfaces';
import { ZWaveAccessory } from '../accessories/ZWaveAccessory';
import { AccessoryFactory } from '../accessories/AccessoryFactory';
import { ControllerAccessory } from '../accessories/ControllerAccessory';

export class ZWaveUsbPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  private zwaveController: IZWaveController | undefined;
  private readonly zwaveAccessories = new Map<number, ZWaveAccessory>();
  private controllerAccessory: ControllerAccessory | undefined;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    if (!this.config.serialPort) {
      this.log.error('No serial port or WebSocket URL configured. Please set "serialPort" in your configuration.');
      return;
    }

    // Initialize controller with config
    if (this.config.serialPort.startsWith('ws://') || this.config.serialPort.startsWith('wss://')) {
        this.log.info(`Initializing Remote Controller connecting to ${this.config.serialPort}`);
        if (this.config.securityKeys) {
            this.log.info('Note: Security keys configured in Homebridge are IGNORED in Remote Mode. Ensure keys are set in Z-Wave JS UI.');
        }
        this.zwaveController = new ZWaveRemoteController(this.log, this.config.serialPort, {
            debug: this.config.debug
        });
    } else {
        this.log.info(`Initializing Local Driver on ${this.config.serialPort}`);
        if (!this.config.securityKeys) {
            this.log.warn('WARNING: No security keys configured! Secure devices (Locks, Garage Doors, etc.) will NOT pair securely. Please generate keys in Settings.');
        }
        this.zwaveController = new ZWaveController(this.log, this.config.serialPort, {
          securityKeys: this.config.securityKeys,
          debug: this.config.debug,
          server: {
              enabled: this.config.enableServer,
              port: this.config.serverPort || 3000
          },
        });
    }

    // Setup listeners
    this.zwaveController.on('node added', (node) => this.handleNodeAdded(node));
    this.zwaveController.on('node ready', (node) => this.handleNodeReady(node));
    this.zwaveController.on('node removed', (node) => this.handleNodeRemoved(node));
    this.zwaveController.on('value updated', (node) => this.handleValueUpdated(node));

    this.api.on('didFinishLaunching', async () => {
      this.log.debug('Executed didFinishLaunching callback');
      if (this.config.serialPort) {
        await this.connectToZWaveController();
      }
    });

    this.api.on('shutdown', async () => {
      this.log.info('Shutting down Z-Wave controller...');
      await this.zwaveController?.stop();
    });
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
      this.controllerAccessory = new ControllerAccessory(this, this.zwaveController);
    } catch (err) {
      this.log.error('Failed to connect to Z-Wave controller:', err);
    }
  }

  private handleNodeAdded(node: IZWaveNode) {
    this.log.info(`Node ${node.nodeId} added.`);
  }

  private handleNodeReady(node: IZWaveNode) {
    this.log.info(`Node ${node.nodeId} ready`);

    const homeId = this.zwaveController?.homeId;
    if (!homeId) {
      this.log.error(`Cannot create accessory for Node ${node.nodeId} - Home ID not available`);
      return;
    }

    // Check if accessory already exists
    let accessory = this.zwaveAccessories.get(node.nodeId);
    
    // 2. Check if we already have this accessory wrapper in memory
    if (this.zwaveAccessories.has(node.nodeId)) {
        this.zwaveAccessories.get(node.nodeId)?.refresh();
        return;
    }
    
    accessory = AccessoryFactory.create(this, node, homeId);
    this.zwaveAccessories.set(node.nodeId, accessory);

    // Metadata Sync
    const nodeName = node.name || node.deviceConfig?.label || `Node ${node.nodeId}`;
    if (accessory.platformAccessory.displayName !== nodeName) {
      this.log.info(`Renaming accessory ${accessory.platformAccessory.displayName} -> ${nodeName}`);
      accessory.platformAccessory.displayName = nodeName;
      this.api.updatePlatformAccessories([accessory.platformAccessory]);
    }

    accessory.initialize();
  }

  private handleNodeRemoved(node: IZWaveNode) {
    this.log.info(`Node ${node.nodeId} removed`);
    
    const accessory = this.zwaveAccessories.get(node.nodeId);
    if (accessory) {
        this.api.unregisterPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
          accessory.platformAccessory,
        ]);
        this.zwaveAccessories.delete(node.nodeId);
    }
  }

  private handleValueUpdated(node: IZWaveNode) {
    this.log.debug(`Node ${node.nodeId} value updated`);
    const accessory = this.zwaveAccessories.get(node.nodeId);
    if (accessory) {
      accessory.refresh();
    }
  }
}