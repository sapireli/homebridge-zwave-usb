import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveUsbPlatform } from '../src/platform/ZWaveUsbPlatform';
import { PLATFORM_NAME } from '../src/platform/settings';
import fs from 'fs';
import path from 'path';

// Mock ZWaveController to avoid starting the actual driver
jest.mock('../src/zwave/ZWaveController', () => {
  return {
    ZWaveController: jest.fn().mockImplementation(() => {
      const { EventEmitter } = require('events');
      const emitter = new EventEmitter();
      (emitter as any).homeId = 1;
      (emitter as any).nodes = new Map();
      (emitter as any).start = jest.fn().mockResolvedValue(undefined);
      (emitter as any).stop = jest.fn().mockResolvedValue(undefined);
      return emitter;
    }),
  };
});

describe('ZWaveUsbPlatform', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  const storagePath = path.join(__dirname, 'test-storage');

  const createMockService = (name = 'Accessory Information') => ({
    setCharacteristic: jest.fn().mockReturnThis(),
    getCharacteristic: jest.fn().mockReturnValue({
      updateValue: jest.fn(),
      onSet: jest.fn().mockReturnThis(),
      setProps: jest.fn().mockReturnThis(),
    }),
    testCharacteristic: jest.fn().mockReturnValue(true),
    addOptionalCharacteristic: jest.fn(),
    removeCharacteristic: jest.fn(),
    characteristics: [],
    UUID: `service-${name}`,
    displayName: name,
    updateCharacteristic: jest.fn().mockReturnThis(),
  });

  beforeEach(() => {
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath);
    }

    class MockCharacteristic {
      static Manufacturer = 'Manufacturer';
      static Model = 'Model';
      static SerialNumber = 'SerialNumber';
      static FirmwareRevision = 'FirmwareRevision';
      static Name = 'Name';
      static On = 'On';
      static ServiceLabelNamespace = 'ServiceLabelNamespace';
      static ServiceLabelIndex = 'ServiceLabelIndex';
      static StatusFault = {
        GENERAL_FAULT: 1,
        NO_FAULT: 0,
      };
      constructor() {}
    }

    class MockService {
      static AccessoryInformation = 'AccessoryInformation';
      static Switch = 'Switch';
    }

    hap = {
      Service: MockService as any,
      Characteristic: MockCharacteristic as any,
      uuid: {
        generate: jest.fn().mockReturnValue('test-uuid'),
      },
    } as any;
    api = {
      hap,
      registerPlatform: jest.fn(),
      registerPlatformAccessories: jest.fn(),
      unregisterPlatformAccessories: jest.fn(),
      updatePlatformAccessories: jest.fn(),
      platformAccessory: jest.fn().mockImplementation((displayName, uuid) => ({
        displayName,
        UUID: uuid,
        context: {},
        services: [createMockService()],
        getService: jest.fn().mockImplementation(() => createMockService()),
        getServiceById: jest.fn(),
        addService: jest.fn().mockImplementation((_type, name = 'Service') => createMockService(name)),
        removeService: jest.fn(),
      })),
      on: jest.fn(),
      user: {
        storagePath: jest.fn().mockReturnValue(storagePath),
      },
    } as any;
  });

  afterEach(async () => {
    const shutdownListeners = (api.on as jest.Mock).mock.calls
      .filter((call) => call[0] === 'shutdown')
      .map((call) => call[1]);

    for (const listener of shutdownListeners) {
      await listener();
    }

    if (fs.existsSync(storagePath)) {
      fs.rmSync(storagePath, { recursive: true, force: true });
    }
  });

  it('should register the platform', () => {
    const log = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };
    const platform = new ZWaveUsbPlatform(log, config, api);
    expect(platform).toBeInstanceOf(ZWaveUsbPlatform);
  });

  it('should initialize the IPC server', (done) => {
    const log = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };
    const platform = new ZWaveUsbPlatform(log, config, api);

    (platform as any).startIpcServer();

    // The server is listening on 0 (random port), wait for 'listening' event
    ((platform as any).ipcServer as any).once('listening', () => {
      expect((platform as any).ipcServer).toBeDefined();
      (platform as any).stopIpcServer();
      done();
    });
  });

  it('should recreate an accessory after an explicit rename', async () => {
    const log = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    // Need access to the platform instance to verify controller calls
    const platform = new ZWaveUsbPlatform(log, config, api);

    // Setup controller mock
    const controller = (platform as any).zwaveController;
    controller.setNodeName = jest.fn().mockResolvedValue(undefined);
    controller.homeId = 100;
    controller.nodes.set(2, {
      nodeId: 2,
      name: 'New Node Name',
      deviceConfig: {
        label: 'Node Label',
        manufacturer: 'Maker',
      },
      ready: true,
      status: 4,
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getAllEndpoints: jest.fn().mockReturnValue([{ index: 0, supportsCC: jest.fn().mockReturnValue(false) }]),
      getValueMetadata: jest.fn(),
      getValue: jest.fn(),
    });

    const existingAccessory = {
      UUID: 'old-uuid',
      displayName: 'Old Name',
      context: { nodeId: 2, homeId: 100 },
      services: [],
      getService: jest.fn(),
      getServiceById: jest.fn(),
      addService: jest.fn(),
      removeService: jest.fn(),
    };
    (platform as any).accessories.push(existingAccessory);
    (platform as any).zwaveAccessories.set(2, {
      platformAccessory: existingAccessory,
      stop: jest.fn(),
    });

    await controller.setNodeName(2, 'New Node Name');
    (platform as any).recreateNodeAccessory(controller.nodes.get(2), 'rename-seed');

    expect(controller.setNodeName).toHaveBeenCalledWith(2, 'New Node Name');
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      'homebridge-zwave-usb',
      'ZWaveUSB',
      [existingAccessory],
    );
    expect(api.registerPlatformAccessories).toHaveBeenCalled();
  });

  it('should refresh a cached accessory for an unready node so fault state can surface', () => {
    const log = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    (platform as any).accessories.push({
      UUID: 'cached-uuid',
      displayName: 'Sleeping Sensor',
      context: { nodeId: 2, homeId: 100 },
      services: [createMockService('Accessory Information'), createMockService('Sensor')],
      getService: jest.fn().mockImplementation(() => createMockService()),
      getServiceById: jest.fn(),
      addService: jest.fn().mockImplementation((_type, name = 'Service') => createMockService(name)),
      removeService: jest.fn(),
    });
    const node = {
      nodeId: 2,
      name: 'Sleeping Sensor',
      deviceConfig: {
        label: 'Sleeping Sensor',
        manufacturer: 'Maker',
      },
      ready: false,
      status: 1,
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getAllEndpoints: jest.fn().mockReturnValue([{ index: 0, supportsCC: jest.fn().mockReturnValue(false) }]),
      getValueMetadata: jest.fn(),
      getValue: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(false),
    };

    (platform as any).zwaveController.homeId = 100;
    (platform as any).handleNodeAdded(node);

    expect((platform as any).zwaveAccessories.has(2)).toBe(true);
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('should defer creating a brand new accessory until the node is ready', () => {
    const log = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    const node = {
      nodeId: 22,
      name: 'New Sleeping Sensor',
      deviceConfig: {
        label: 'New Sleeping Sensor',
        manufacturer: 'Maker',
      },
      ready: false,
      status: 1,
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getAllEndpoints: jest.fn().mockReturnValue([{ index: 0, supportsCC: jest.fn().mockReturnValue(false) }]),
      getValueMetadata: jest.fn(),
      getValue: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(false),
    };

    (platform as any).zwaveController.homeId = 100;
    (platform as any).handleNodeAdded(node);

    expect((platform as any).zwaveAccessories.has(22)).toBe(false);
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
  });
});
