import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveUsbPlatform } from '../src/platform/ZWaveUsbPlatform';
import { PLATFORM_NAME } from '../src/platform/settings';
import { AccessoryFactory } from '../src/accessories/AccessoryFactory';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { EventEmitter } from 'events';

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
      fs.mkdirSync(storagePath, { recursive: true });
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
    const fakeServer = new EventEmitter() as EventEmitter & {
      listen: jest.Mock;
      close: jest.Mock;
      address: jest.Mock;
    };
    fakeServer.listen = jest.fn().mockImplementation((_port, _host, cb) => {
      cb();
      fakeServer.emit('listening');
    });
    fakeServer.close = jest.fn();
    fakeServer.address = jest.fn().mockReturnValue({ port: 12345, address: '127.0.0.1' });

    const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer as never);

    try {
      (platform as any).startIpcServer();
      expect((platform as any).ipcServer).toBe(fakeServer);
      expect(fakeServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
      (platform as any).stopIpcServer();
      expect(fakeServer.close).toHaveBeenCalled();
      done();
    } finally {
      createServerSpy.mockRestore();
    }
  });

  it('should update an accessory in place after an explicit rename', async () => {
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
    const rename = jest.fn();
    (platform as any).zwaveAccessories.set(2, {
      platformAccessory: existingAccessory,
      stop: jest.fn(),
      rename,
    });

    const fakeServer = new EventEmitter() as EventEmitter & {
      listen: jest.Mock;
      close: jest.Mock;
      address: jest.Mock;
    };
    fakeServer.listen = jest.fn().mockImplementation((_port, _host, cb) => cb());
    fakeServer.close = jest.fn();
    fakeServer.address = jest.fn().mockReturnValue({ port: 12345, address: '127.0.0.1' });
    const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer as never);

    const req = new EventEmitter() as EventEmitter & { url?: string; method?: string };
    const res = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };
    req.url = '/nodes/2/name';
    req.method = 'POST';

    try {
      (platform as any).startIpcServer();
      const handler = createServerSpy.mock.calls.at(-1)?.[0];
      handler(req, res);
      req.emit('data', JSON.stringify({ name: 'New Node Name' }));
      await new Promise<void>((resolve) => {
        req.on('handled', resolve);
        const originalEnd = res.end;
        res.end = jest.fn().mockImplementation((...args) => {
          originalEnd(...args);
          req.emit('handled');
        });
        req.emit('end');
      });

      expect(controller.setNodeName).toHaveBeenCalledWith(2, 'New Node Name');
      expect(rename).toHaveBeenCalledWith('New Node Name');
      expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    } finally {
      createServerSpy.mockRestore();
    }
  });

  it('should include HomeKit publication state in the node list payload', async () => {
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
    (platform as any).zwaveController.homeId = 100;
    (platform as any).zwaveController.nodes = new Map([
      [2, { nodeId: 2, name: 'Ready Node', ready: true, status: 4, deviceConfig: { label: 'Ready', manufacturer: 'Maker' } }],
      [3, { nodeId: 3, name: 'Pending Node', ready: false, status: 1, deviceConfig: { label: 'Pending', manufacturer: 'Maker' } }],
      [4, { nodeId: 4, name: 'Cached Pending Node', ready: false, status: 1, deviceConfig: { label: 'Cached', manufacturer: 'Maker' } }],
    ]);
    (platform as any).zwaveAccessories.set(2, { platformAccessory: { UUID: 'ready-uuid' }, stop: jest.fn() });
    (platform as any).zwaveAccessories.set(4, { platformAccessory: { UUID: 'cached-live-uuid' }, stop: jest.fn() });
    (platform as any).accessories.push({
      UUID: 'cached-uuid',
      displayName: 'Cached Pending Node',
      context: { nodeId: 4, homeId: 100 },
      services: [],
      getService: jest.fn(),
      getServiceById: jest.fn(),
      addService: jest.fn(),
      removeService: jest.fn(),
    });

    const fakeServer = new EventEmitter() as EventEmitter & {
      listen: jest.Mock;
      close: jest.Mock;
      address: jest.Mock;
    };
    fakeServer.listen = jest.fn().mockImplementation((_port, _host, cb) => cb());
    fakeServer.close = jest.fn();
    fakeServer.address = jest.fn().mockReturnValue({ port: 12345, address: '127.0.0.1' });
    const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer as never);

    const req = { url: '/nodes', method: 'GET' } as EventEmitter & { url?: string; method?: string };
    const res = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };

    try {
      (platform as any).startIpcServer();
      const handler = createServerSpy.mock.calls.at(-1)?.[0];
      handler(req, res);

      const payload = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
      expect(payload.find((node: any) => node.nodeId === 2).homekitState).toBe('published');
      expect(payload.find((node: any) => node.nodeId === 3).homekitState).toBe('pending-interview');
      expect(payload.find((node: any) => node.nodeId === 4).homekitState).toBe('cached-pending');
    } finally {
      createServerSpy.mockRestore();
    }
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

  it('should prune stale accessories only when explicitly requested', async () => {
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
    (platform as any).zwaveController.homeId = 100;
    (platform as any).zwaveController.nodes = new Map([[2, { nodeId: 2 }]]);

    const staleAccessory = {
      UUID: 'stale-uuid',
      displayName: 'Stale Node',
      context: { nodeId: 99, homeId: 100 },
      services: [],
      getService: jest.fn(),
      getServiceById: jest.fn(),
      addService: jest.fn(),
      removeService: jest.fn(),
    };
    const liveAccessory = {
      UUID: 'live-uuid',
      displayName: 'Live Node',
      context: { nodeId: 2, homeId: 100 },
      services: [],
      getService: jest.fn(),
      getServiceById: jest.fn(),
      addService: jest.fn(),
      removeService: jest.fn(),
    };
    (platform as any).accessories.push(staleAccessory, liveAccessory);
    (platform as any).zwaveAccessories.set(99, { platformAccessory: staleAccessory });

    const fakeServer = new EventEmitter() as EventEmitter & {
      listen: jest.Mock;
      close: jest.Mock;
      address: jest.Mock;
    };
    fakeServer.listen = jest.fn().mockImplementation((_port, _host, cb) => cb());
    fakeServer.close = jest.fn();
    fakeServer.address = jest.fn().mockReturnValue({ port: 12345, address: '127.0.0.1' });
    const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer as never);

    const req = new EventEmitter() as EventEmitter & { url?: string; method?: string };
    const res = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };
    req.url = '/accessories/prune-stale';
    req.method = 'POST';

    try {
      (platform as any).startIpcServer();
      const handler = createServerSpy.mock.calls.at(-1)?.[0];
      await new Promise<void>((resolve) => {
        res.end = jest.fn().mockImplementation(() => resolve());
        handler(req, res);
      });

      expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
        'homebridge-zwave-usb',
        'ZWaveUSB',
        [staleAccessory],
      );
      expect((platform as any).accessories).toEqual([liveAccessory]);
      expect((platform as any).zwaveAccessories.has(99)).toBe(false);
    } finally {
      createServerSpy.mockRestore();
    }
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

  it('should explicitly rebuild an initialized accessory when the graph signature changes', () => {
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
      nodeId: 2,
      name: 'Capability Change Node',
      deviceConfig: {
        label: 'Capability Change Node',
        manufacturer: 'Maker',
      },
      ready: true,
      status: 4,
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getAllEndpoints: jest.fn().mockReturnValue([{ index: 0, supportsCC: jest.fn().mockReturnValue(false) }]),
      getValueMetadata: jest.fn(),
      getValue: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(false),
    };

    const existing = {
      isInitialized: jest.fn().mockReturnValue(true),
      getGraphSignature: jest.fn().mockReturnValue('old-graph'),
      stop: jest.fn(),
      updateNode: jest.fn(),
      refresh: jest.fn(),
    };
    const reconciled = {
      initialize: jest.fn(),
      stop: jest.fn(),
    };

    (platform as any).zwaveController.homeId = 100;
    (platform as any).zwaveAccessories.set(2, existing);

    const graphSpy = jest.spyOn(AccessoryFactory, 'getGraphSignature').mockReturnValue('new-graph');
    const createSpy = jest.spyOn(AccessoryFactory, 'create').mockReturnValue(reconciled as any);

    try {
      (platform as any).handleNodeUpdated(node);

      expect(existing.stop).toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledWith(platform, node, 100);
      expect(reconciled.initialize).toHaveBeenCalledWith({ pruneUnmanagedServices: true });
      expect(existing.updateNode).not.toHaveBeenCalled();
      expect(existing.refresh).not.toHaveBeenCalled();
    } finally {
      graphSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it('should unregister a cached-only accessory when the node removed event arrives', () => {
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
    (platform as any).zwaveController.homeId = 100;
    const cachedAccessory = {
      UUID: 'cached-uuid',
      displayName: 'Removed Node',
      context: { nodeId: 7, homeId: 100 },
      services: [],
      getService: jest.fn(),
      getServiceById: jest.fn(),
      addService: jest.fn(),
      removeService: jest.fn(),
    };
    (platform as any).accessories.push(cachedAccessory);

    (platform as any).handleNodeRemoved({ nodeId: 7 });

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      'homebridge-zwave-usb',
      'ZWaveUSB',
      [cachedAccessory],
    );
    expect((platform as any).accessories).toEqual([]);
  });
});
