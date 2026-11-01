import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveUsbPlatform } from '../src/platform/ZWaveUsbPlatform';
import { PLATFORM_NAME } from '../src/platform/settings';
import { AccessoryFactory } from '../src/accessories/AccessoryFactory';
import { ZWaveController } from '../src/zwave/ZWaveController';
import { TypeOverrideResolver } from '../src/platform/TypeOverrideResolver';
import { REALISTIC_DEVICES, buildNode } from './fixtures/realisticDevices';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { EventEmitter } from 'events';
import { CommandClasses, MessagePriority } from '@zwave-js/core';
import { SetValueStatus } from 'zwave-js';
import { STALL_WINDOW_MS as COVERING_STALL_WINDOW_MS } from '../src/zwave/coveringController';

/** Mirrors the platform's own grace period before the stall clock starts. */
const COVERING_REPORT_GRACE_MS = 8000;

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
      static TargetPosition = 'TargetPosition';
      static CurrentPosition = 'CurrentPosition';
      static HoldPosition = 'HoldPosition';
      static StatusFault = {
        GENERAL_FAULT: 1,
        NO_FAULT: 0,
      };
      constructor() {}
    }

    class MockService {
      static AccessoryInformation = 'AccessoryInformation';
      static Switch = 'Switch';
      static WindowCovering = { UUID: 'service-WindowCovering' };
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

  it('builds a node from the type saved for its hardware', () => {
    // The override is read from the file for this network before the node is first planned, so
    // the accessory is built as the saved type rather than published as detected and rebuilt.
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };
    const fingerprint = { manufacturerId: 2748, productType: 2, productId: 16 };
    const device = REALISTIC_DEVICES.find(
      (candidate) => candidate.name === 'covering (Multilevel Switch only)',
    )!;
    const shade = buildNode(device, { nodeId: 10, ...fingerprint });

    fs.writeFileSync(
      path.join(storagePath, 'homebridge-zwave-usb-overrides-00000064.json'),
      JSON.stringify({
        version: 1,
        homeId: '00000064',
        overrides: [
          { fingerprint, primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
        ],
        observations: [],
      }),
    );

    const platform = new ZWaveUsbPlatform(log, config, api);
    (platform as any).zwaveController.homeId = 0x64;
    (platform as any).zwaveController.nodes = new Map([[10, shade]]);

    const observed = jest
      .spyOn(TypeOverrideResolver.prototype, 'observe')
      .mockResolvedValue(undefined);
    const created = jest.spyOn(AccessoryFactory, 'create').mockReturnValue({
      initialize: jest.fn(),
      isInitialized: () => true,
      getGraphSignature: () => undefined,
      stop: jest.fn(),
      refresh: jest.fn(),
    } as never);
    jest.spyOn((platform as any).matterAccessories, 'add').mockImplementation(() => undefined);

    try {
      (platform as any).syncNodeAccessory(shade);

      expect(AccessoryFactory.planFeatures(shade)[0].effectiveKinds).toEqual(['multilevel-switch']);
      expect((created.mock.calls[0][3] as any[])[0].effectiveKinds).toEqual(['window-covering']);
      expect(observed).toHaveBeenCalledWith(shade);
    } finally {
      created.mockRestore();
      observed.mockRestore();
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
      manufacturer: 'Resolved Maker',
      label: 'Resolved Label',
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

  it('should forward refresh-info IPC requests to the controller', async () => {
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
    const controller = (platform as any).zwaveController;
    controller.refreshNodeInfo = jest.fn().mockResolvedValue({ nodeId: 2, requiresWakeUp: true });

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
    req.url = '/nodes/2/refresh-info';
    req.method = 'POST';

    try {
      (platform as any).startIpcServer();
      const handler = createServerSpy.mock.calls.at(-1)?.[0];
      await new Promise<void>((resolve) => {
        res.end = jest.fn().mockImplementation(() => resolve());
        handler(req, res);
      });

      expect(controller.refreshNodeInfo).toHaveBeenCalledWith(2);
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(JSON.parse((res.end as jest.Mock).mock.calls[0][0])).toEqual({
        success: true,
        nodeId: 2,
        requiresWakeUp: true,
        refreshState: 'waiting-wakeup',
      });
      expect((platform as any).refreshStates.get(2)).toBe('waiting-wakeup');
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
    (platform as any).zwaveAccessories.set(2, { platformAccessory: { UUID: 'ready-uuid' }, stop: jest.fn(), batteryState: () => undefined });
    (platform as any).zwaveAccessories.set(4, { platformAccessory: { UUID: 'cached-live-uuid' }, stop: jest.fn(), batteryState: () => undefined });
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
      expect(payload.find((node: any) => node.nodeId === 2).refreshState).toBeUndefined();
    } finally {
      createServerSpy.mockRestore();
    }
  });

  it('reports firmware progress and outcome to the management page', () => {
    // The page draws the bar from `percent` and tells completed from failed using
    // `outcome`, so the platform has to store the driver's own total percentage rather
    // than a fragment count, and take the outcome from `success`.
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    const controller = (platform as any).zwaveController;
    controller.homeId = 100;
    controller.nodes = new Map([
      [2, { nodeId: 2, name: 'Updating', ready: true, status: 4 }],
      [3, { nodeId: 3, name: 'Done', ready: true, status: 4 }],
      [4, { nodeId: 4, name: 'Broken', ready: true, status: 4 }],
    ]);

    jest.useFakeTimers();
    try {
      controller.emit('firmware update progress', 2, 37.5);
      controller.emit('firmware update finished', 3, true);
      controller.emit('firmware update finished', 4, false);

      const fakeServer = new EventEmitter() as EventEmitter & {
        listen: jest.Mock;
        close: jest.Mock;
        address: jest.Mock;
      };
      fakeServer.listen = jest.fn().mockImplementation((_port, _host, cb) => cb());
      fakeServer.close = jest.fn();
      fakeServer.address = jest.fn().mockReturnValue({ port: 12345, address: '127.0.0.1' });
      const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer as never);

      const req = { url: '/nodes', method: 'GET' } as EventEmitter & {
        url?: string;
        method?: string;
      };
      const res = { writeHead: jest.fn(), end: jest.fn() };

      try {
        (platform as any).startIpcServer();
        const handler = createServerSpy.mock.calls.at(-1)?.[0];
        handler(req, res);

        const payload = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
        const of = (id: number) => payload.find((node: any) => node.nodeId === id).firmwareProgress;
        expect(of(2)).toEqual({ percent: 37.5 });
        expect(of(3)).toEqual({ percent: 100, outcome: 'success' });
        expect(of(4)).toEqual({ percent: 100, outcome: 'failure' });
      } finally {
        createServerSpy.mockRestore();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports the battery the accessory publishes, not one rebuilt from the value cache', () => {
    /**
     * The page used to read Battery CC out of the driver's values itself, which cannot see the
     * low-battery warning at all: Battery CC replaces the 0xFF sentinel before the report is
     * persisted, so the cache holds the last percentage and records no warning. The feature
     * driving the Battery service is the only thing that remembers it, so the page asks that.
     */
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    const controller = (platform as any).zwaveController;
    controller.homeId = 100;
    controller.nodes = new Map<number, any>([
      [2, { nodeId: 2, name: 'Warned', ready: true, status: 4 }],
      [3, { nodeId: 3, name: 'Healthy', ready: true, status: 4 }],
      [4, { nodeId: 4, name: 'Mains', ready: true, status: 4 }],
      [5, { nodeId: 5, name: 'Unpublished', ready: true, status: 4 }],
    ]);

    const accessoryWith = (state: unknown) => ({ batteryState: () => state, stop: jest.fn() });
    const accessories = (platform as any).zwaveAccessories as Map<number, any>;
    // The warning with the last percentage intact: what the value cache cannot express.
    accessories.set(2, accessoryWith({ level: 42, low: true }));
    accessories.set(3, accessoryWith({ level: 80, low: false }));
    accessories.set(4, accessoryWith(undefined));
    // Node 5 has no accessory at all, so there is nothing to publish for it.

    const fakeServer = new EventEmitter() as EventEmitter & {
      listen: jest.Mock;
      close: jest.Mock;
      address: jest.Mock;
    };
    fakeServer.listen = jest.fn().mockImplementation((_port, _host, cb) => cb());
    fakeServer.close = jest.fn();
    fakeServer.address = jest.fn().mockReturnValue({ port: 12345, address: '127.0.0.1' });
    const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer as never);

    try {
      (platform as any).startIpcServer();
      const handler = createServerSpy.mock.calls.at(-1)?.[0];
      const res = { writeHead: jest.fn(), end: jest.fn() };
      handler({ url: '/nodes', method: 'GET' }, res);

      const payload = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
      const of = (id: number) => payload.find((n: any) => n.nodeId === id).battery;

      expect(of(2)).toEqual({ level: 42, low: true });
      expect(of(3)).toEqual({ level: 80, low: false });
      expect(of(4)).toBeUndefined();
      expect(of(5)).toBeUndefined();
    } finally {
      createServerSpy.mockRestore();
    }
  });

  it('keeps listing nodes when one accessory cannot report its battery', () => {
    /**
     * Reading a battery reaches into the driver's values and can write the accessory cache, so
     * it can throw. The read happens per node while the list is built, and without a boundary
     * one bad accessory answered the whole page with a 500 and the table showed nothing.
     */
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    const controller = (platform as any).zwaveController;
    controller.homeId = 100;
    controller.nodes = new Map<number, any>([
      [2, { nodeId: 2, name: 'Broken', ready: true, status: 4 }],
      [3, { nodeId: 3, name: 'Fine', ready: true, status: 4 }],
    ]);

    const accessories = (platform as any).zwaveAccessories as Map<number, any>;
    accessories.set(2, {
      stop: jest.fn(),
      batteryState: () => {
        throw new Error('the driver is not answering');
      },
    });
    accessories.set(3, { stop: jest.fn(), batteryState: () => ({ level: 70, low: false }) });

    const fakeServer = new EventEmitter() as EventEmitter & {
      listen: jest.Mock;
      close: jest.Mock;
      address: jest.Mock;
    };
    fakeServer.listen = jest.fn().mockImplementation((_port, _host, cb) => cb());
    fakeServer.close = jest.fn();
    fakeServer.address = jest.fn().mockReturnValue({ port: 12345, address: '127.0.0.1' });
    const createServerSpy = jest.spyOn(http, 'createServer').mockReturnValue(fakeServer as never);

    try {
      (platform as any).startIpcServer();
      const handler = createServerSpy.mock.calls.at(-1)?.[0];
      const res = { writeHead: jest.fn(), end: jest.fn() };
      handler({ url: '/nodes', method: 'GET' }, res);

      const payload = JSON.parse((res.end as jest.Mock).mock.calls[0][0]);
      expect(Array.isArray(payload)).toBe(true);
      expect(payload).toHaveLength(2);

      // The broken node loses only its battery; every other column still arrives.
      const broken = payload.find((n: any) => n.nodeId === 2);
      expect(broken.battery).toBeUndefined();
      expect(broken.name).toBe('Broken');
      expect(payload.find((n: any) => n.nodeId === 3).battery).toEqual({ level: 70, low: false });

      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
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

  it('should republish accessory metadata when firmware version values update', () => {
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
    const syncNodeAccessorySpy = jest.spyOn(platform as any, 'syncNodeAccessory');
    const refresh = jest.fn();
    const updateNode = jest.fn();
    const stop = jest.fn();
    (platform as any).zwaveAccessories.set(2, {
      refresh,
      updateNode,
      stop,
    });

    const node = {
      nodeId: 2,
      firmwareVersion: '2.134.0',
    };

    (platform as any).handleValueUpdated(node, {
      commandClass: CommandClasses.Version,
      property: 'firmwareVersions',
      newValue: ['2.134.0'],
    });

    expect(syncNodeAccessorySpy).toHaveBeenCalledWith(node);
    expect(updateNode).toHaveBeenCalledWith(node);
    expect(refresh).toHaveBeenCalledWith({
      commandClass: CommandClasses.Version,
      property: 'firmwareVersions',
      newValue: ['2.134.0'],
    });
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
    // A question put to each node, so pruning is shown to drop the departed node's and keep the
    // other one's rather than simply emptying the map.
    (platform as any).parameterRefreshes.set(99, { nodeId: 99, owner: {}, dispatching: false });
    (platform as any).parameterRefreshes.set(2, { nodeId: 2, owner: {}, dispatching: false });

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
      expect((platform as any).parameterRefreshes.has(99)).toBe(false);
      expect((platform as any).parameterRefreshes.has(2)).toBe(true);
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
    const matterAdd = jest.fn();
    (platform as any).matterAccessories.add = matterAdd;

    const graphSpy = jest
      .spyOn(AccessoryFactory, 'signatureOfPlans')
      .mockReturnValue('new-graph');
    const createSpy = jest.spyOn(AccessoryFactory, 'create').mockReturnValue(reconciled as any);

    try {
      (platform as any).handleNodeUpdated(node);

      expect(existing.stop).toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledWith(platform, node, 100, expect.any(Array));
      expect(reconciled.initialize).toHaveBeenCalledWith({ pruneUnmanagedServices: true });
      expect(existing.updateNode).not.toHaveBeenCalled();
      expect(existing.refresh).not.toHaveBeenCalled();
      /**
       * The Matter layer has to be told, and told about the new object. It is the only thing
       * that repoints the endpoint's handlers at the rebuilt wrapper; without this call the
       * covering keeps answering Matter commands through the object that was just stopped.
       */
      expect(matterAdd).toHaveBeenCalledWith(reconciled);
    } finally {
      graphSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it('plans a node once per pass and builds from that same plan', () => {
    /**
     * The platform takes a node's signature to decide whether to rebuild, then builds. Those
     * were two separate readings of the node, and a node that is still interviewing answers
     * differently as it goes, so an accessory could be built from the second reading and
     * labelled with the first. Its stored signature would then describe services it does not
     * have, and the next comparison would rebuild it again.
     */
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    (platform as any).zwaveController.homeId = 100;

    const node = {
      nodeId: 2,
      name: 'Interviewing Node',
      ready: true,
      status: 4,
      deviceConfig: { label: 'Interviewing Node', manufacturer: 'Maker' },
      getAllEndpoints: jest
        .fn()
        .mockReturnValue([{ index: 0, supportsCC: jest.fn().mockReturnValue(false) }]),
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
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
    (platform as any).zwaveAccessories.set(2, existing);
    (platform as any).matterAccessories.add = jest.fn();

    const planSpy = jest.spyOn(AccessoryFactory, 'planFeatures');
    const createSpy = jest
      .spyOn(AccessoryFactory, 'create')
      .mockReturnValue({ initialize: jest.fn(), stop: jest.fn() } as any);

    try {
      (platform as any).handleNodeUpdated(node);

      // One reading, and the build was handed exactly the plan that reading produced.
      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0][3]).toBe(planSpy.mock.results[0].value);
    } finally {
      planSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it('should not republish the Matter accessory when the graph signature is unchanged', () => {
    // An ordinary re-interview ends here, not in the rebuild above: the signature comes back the
    // same and the existing wrapper is updated in place. The Matter accessory is neither
    // republished nor repointed, so the endpoint keeps the handlers it already has.
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
      name: 'Unchanged Node',
      deviceConfig: { label: 'Unchanged Node', manufacturer: 'Maker' },
      ready: true,
      status: 4,
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getAllEndpoints: jest
        .fn()
        .mockReturnValue([{ index: 0, supportsCC: jest.fn().mockReturnValue(false) }]),
      getValueMetadata: jest.fn(),
      getValue: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(false),
    };

    const existing = {
      isInitialized: jest.fn().mockReturnValue(true),
      getGraphSignature: jest.fn().mockReturnValue('same-graph'),
      stop: jest.fn(),
      updateNode: jest.fn(),
      refresh: jest.fn(),
    };

    (platform as any).zwaveController.homeId = 100;
    (platform as any).zwaveAccessories.set(2, existing);
    const matterAdd = jest.fn();
    (platform as any).matterAccessories.add = matterAdd;

    const graphSpy = jest
      .spyOn(AccessoryFactory, 'signatureOfPlans')
      .mockReturnValue('same-graph');
    const createSpy = jest.spyOn(AccessoryFactory, 'create');

    try {
      (platform as any).handleNodeUpdated(node);

      expect(existing.updateNode).toHaveBeenCalledWith(node);
      expect(existing.refresh).toHaveBeenCalled();
      expect(existing.stop).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
      expect(matterAdd).not.toHaveBeenCalled();
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
  it('should forward the sleeping-device heal policy to the controller', () => {
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const constructorMock = ZWaveController as unknown as jest.Mock;
    const lastOptions = () => constructorMock.mock.calls[constructorMock.mock.calls.length - 1][2];

    // PlatformConfig has an index signature, so a misspelled key would compile and read undefined.
    new ZWaveUsbPlatform(
      log,
      {
        platform: PLATFORM_NAME,
        name: 'Z-Wave USB',
        serialPort: '/dev/null',
        healIncludesSleepingDevices: true,
      } as PlatformConfig,
      api,
    );
    expect(lastOptions()).toMatchObject({ healIncludesSleepingDevices: true });

    new ZWaveUsbPlatform(
      log,
      {
        platform: PLATFORM_NAME,
        name: 'Z-Wave USB',
        serialPort: '/dev/null',
      } as PlatformConfig,
      api,
    );
    expect(lastOptions().healIncludesSleepingDevices).toBeUndefined();
  });
  it('should reconcile the service graph when hydrating a cached accessory that becomes ready', () => {
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
      nodeId: 5,
      name: "Nico's Shade",
      deviceConfig: { label: 'RSZ1', manufacturer: 'Springs Window Fashions' },
      ready: true,
      status: 4,
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getAllEndpoints: jest
        .fn()
        .mockReturnValue([{ index: 0, supportsCC: jest.fn().mockReturnValue(false) }]),
      getValueMetadata: jest.fn(),
      getValue: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(false),
    };

    // The accessory was materialised from the cache while the node was still interviewing.
    const existing = {
      isInitialized: jest.fn().mockReturnValue(false),
      getGraphSignature: jest.fn().mockReturnValue('cached-graph'),
      stop: jest.fn(),
      updateNode: jest.fn(),
      refresh: jest.fn(),
    };
    const hydrated = { initialize: jest.fn(), stop: jest.fn() };

    (platform as any).zwaveController.homeId = 100;
    (platform as any).zwaveAccessories.set(5, existing);

    const createSpy = jest.spyOn(AccessoryFactory, 'create').mockReturnValue(hydrated as any);

    try {
      (platform as any).handleNodeReady(node);

      expect(existing.stop).toHaveBeenCalled();
      expect(hydrated.initialize).toHaveBeenCalledWith({ removeSupersededServices: true });
    } finally {
      createSpy.mockRestore();
    }
  });

  it('should reconcile the service graph when first building a ready node from cache', () => {
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
      nodeId: 5,
      name: "Nico's Shade",
      deviceConfig: { label: 'RSZ1', manufacturer: 'Springs Window Fashions' },
      ready: true,
      status: 4,
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getAllEndpoints: jest
        .fn()
        .mockReturnValue([{ index: 0, supportsCC: jest.fn().mockReturnValue(false) }]),
      getValueMetadata: jest.fn(),
      getValue: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(false),
    };

    const created = { initialize: jest.fn(), stop: jest.fn(), refresh: jest.fn() };
    (platform as any).zwaveController.homeId = 100;

    const createSpy = jest.spyOn(AccessoryFactory, 'create').mockReturnValue(created as any);

    try {
      (platform as any).handleNodeReady(node);

      expect(created.initialize).toHaveBeenCalledWith({ removeSupersededServices: true });
    } finally {
      createSpy.mockRestore();
    }
  });

  it('should report route diagnostics for a node', async () => {
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
    const controller = (platform as any).zwaveController;
    const diagnostics = {
      nodeId: 5,
      name: "Nico's Shade",
      status: 4,
      neighbors: [4],
      lastWorkingRoute: { repeaters: [], direct: true, ackRSSI: -90 },
    };
    controller.getNodeRouteDiagnostics = jest.fn().mockResolvedValue(diagnostics);

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
    const res = { writeHead: jest.fn(), end: jest.fn() };
    req.url = '/nodes/5/diagnostics';
    req.method = 'GET';

    try {
      (platform as any).startIpcServer();
      const handler = createServerSpy.mock.calls.at(-1)?.[0];
      await new Promise<void>((resolve) => {
        res.end = jest.fn().mockImplementation(() => resolve());
        handler(req, res);
      });

      expect(controller.getNodeRouteDiagnostics).toHaveBeenCalledWith(5);
      expect(JSON.parse((res.end as jest.Mock).mock.calls[0][0])).toEqual({
        ...diagnostics,
        isWindowCovering: false,
      });
    } finally {
      createServerSpy.mockRestore();
    }
  });

  it('should answer a diagnostics request for an unknown node with an error', async () => {
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
    const controller = (platform as any).zwaveController;
    const diagnostics = {
      nodeId: 5,
      name: "Nico's Shade",
      status: 4,
      neighbors: [4],
      lastWorkingRoute: { repeaters: [], direct: true, ackRSSI: -90 },
    };
    controller.getNodeRouteDiagnostics = jest.fn().mockRejectedValue(new Error('Node 99 not found'));

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
    const res = { writeHead: jest.fn(), end: jest.fn() };
    req.url = '/nodes/99/diagnostics';
    req.method = 'GET';

    try {
      (platform as any).startIpcServer();
      const handler = createServerSpy.mock.calls.at(-1)?.[0];
      await new Promise<void>((resolve) => {
        res.end = jest.fn().mockImplementation(() => resolve());
        handler(req, res);
      });

      expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
      expect(JSON.parse((res.end as jest.Mock).mock.calls[0][0])).toEqual({
        error: 'Node 99 not found',
      });
    } finally {
      createServerSpy.mockRestore();
    }
  });
  const createCoveringHarness = (
    platform: any,
    device: { current: number; duration: unknown; hapCurrent?: number; hapTarget?: number },
    subtype = '0',
  ) => {
    // One stable setter, so a test can assert what was actually written to the covering.
    const targetSetter = { handleSetRequest: jest.fn().mockResolvedValue(undefined) };
    const holdSetter = { handleSetRequest: jest.fn().mockResolvedValue(undefined) };
    const service = {
      UUID: platform.Service.WindowCovering.UUID,
      subtype: subtype,
      getCharacteristic: jest.fn().mockImplementation((type) => {
        if (type === platform.Characteristic.TargetPosition) {
          return {
            ...targetSetter,
            get value() {
              return device.hapTarget;
            },
          };
        }
        if (type === platform.Characteristic.HoldPosition) {
          return holdSetter;
        }
        return {
          /**
           * HomeKit's own cache, deliberately distinct from what the device reports. A test that
           * let these be the same number could not tell a device read from a cached one, which
           * is what hid the endpoint handling.
           */
          get value() {
            return device.hapCurrent ?? device.current;
          },
        };
      }),
    };

    platform.zwaveAccessories.set(5, {
      stop: jest.fn(),
      platformAccessory: { services: [service] },
    });
    platform.zwaveController.nodes.set(5, {
      nodeId: 5,
      getValue: jest.fn().mockImplementation((vid: any) => {
        if (vid.commandClass !== CommandClasses['Multilevel Switch']) return undefined;
        if (vid.endpoint !== Number(subtype)) return undefined;
        if (vid.property === 'duration') return device.duration;
        return device.current;
      }),
    });

    return { service, targetSetter, holdSetter };
  };

  it('should wait for a traveling covering before reporting its position', async () => {
    jest.useFakeTimers();
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
    // The covering reports an unknown remaining duration while it travels.
    const device = { current: 81, duration: { value: 0, unit: 'unknown' } };
    const { targetSetter } = createCoveringHarness(platform as any, device);

    try {
      const pending = (platform as any).testCoveringPosition(5, 25);
      await Promise.resolve();

      // Still at 81 through the grace period: the covering has not begun to move yet, and that
      // must not be read as having arrived.
      await jest.advanceTimersByTimeAsync(8000);
      device.current = 56;
      await jest.advanceTimersByTimeAsync(4000);

      device.current = 25;
      device.duration = { value: 0, unit: 'seconds' };
      // Only a full stall window of standing still ends the wait.
      await jest.advanceTimersByTimeAsync(4000);
      await jest.advanceTimersByTimeAsync(COVERING_STALL_WINDOW_MS);

      await expect(pending).resolves.toEqual({
        nodeId: 5,
        requested: 25,
        before: 81,
        after: 25,
        reached: true,
        startedAtTarget: false,
        timedOut: false,
      });
      // The test tool has to actually drive the covering, not just read it back.
      expect(targetSetter.handleSetRequest).toHaveBeenCalledWith(25);
    } finally {
      jest.useRealTimers();
    }
  });

  it('should report a covering that accepted the command without moving', async () => {
    jest.useFakeTimers();
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
    // The covering answers straight away that it has stopped, right where it already was.
    const device = { current: 81, duration: { value: 0, unit: 'seconds' } };
    const { targetSetter } = createCoveringHarness(platform as any, device);

    try {
      const pending = (platform as any).testCoveringPosition(5, 25);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(COVERING_REPORT_GRACE_MS + COVERING_STALL_WINDOW_MS);

      await expect(pending).resolves.toMatchObject({ after: 81, reached: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it('should read a covering published from a non-root endpoint', async () => {
    jest.useFakeTimers();
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    // HomeKit's cache holds a stale 99: reading the wrong endpoint falls back to it, so the
    // test can tell the difference between reading the device and reading the cache.
    const device = { current: 81, duration: { value: 0, unit: 'seconds' }, hapCurrent: 99 };
    // The covering lives on endpoint 2, so endpoint 0 reports nothing about it.
    createCoveringHarness(platform as any, device, '2');

    try {
      const pending = (platform as any).testCoveringPosition(5, 25);
      await Promise.resolve();

      device.current = 25;
      await jest.advanceTimersByTimeAsync(COVERING_REPORT_GRACE_MS + COVERING_STALL_WINDOW_MS);

      await expect(pending).resolves.toMatchObject({ after: 25, reached: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('should send the stop and report it against the target', async () => {
    jest.useFakeTimers();
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    // Traveling towards 100 and halted at 76. Movement has to be observed after the stop as
    // well as a rest short of the target, or a stationary covering with a stale target would
    // be credited with obeying a stop it never received.
    const device = { current: 60, duration: { value: 0, unit: 'seconds' }, hapTarget: 100 };
    const { holdSetter } = createCoveringHarness(platform as any, device);

    try {
      const pending = (platform as any).stopCovering(5);
      // It coasts a little further, then stands still.
      await jest.advanceTimersByTimeAsync(4000);
      device.current = 76;
      await jest.advanceTimersByTimeAsync(COVERING_REPORT_GRACE_MS + COVERING_STALL_WINDOW_MS);

      await expect(pending).resolves.toMatchObject({
        after: 76,
        target: 100,
        moved: true,
        shortOfTarget: true,
      });
      // The stop has to actually be sent, not merely reported.
      expect(holdSetter.handleSetRequest).toHaveBeenCalledWith(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('should not credit a stop that ended on the target', async () => {
    jest.useFakeTimers();
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    // The covering ignored the stop and finished its travel.
    const device = { current: 100, duration: { value: 0, unit: 'seconds' }, hapTarget: 100 };
    createCoveringHarness(platform as any, device);

    try {
      const pending = (platform as any).stopCovering(5);
      await jest.advanceTimersByTimeAsync(COVERING_REPORT_GRACE_MS + COVERING_STALL_WINDOW_MS);

      await expect(pending).resolves.toMatchObject({ after: 100, shortOfTarget: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it('should not call a covering stopped while it is still reporting movement', async () => {
    jest.useFakeTimers();
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    const device = { current: 81, duration: { value: 0, unit: 'unknown' } };
    createCoveringHarness(platform as any, device);

    try {
      const pending = (platform as any).stopCovering(5);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      // Still still at 81 well past the grace period and the stall window. A covering that has
      // not begun to move must not be read as one that has finished.
      await jest.advanceTimersByTimeAsync(COVERING_REPORT_GRACE_MS - 2000);
      device.current = 70;
      await jest.advanceTimersByTimeAsync(COVERING_STALL_WINDOW_MS - 2000);
      device.current = 60;
      await jest.advanceTimersByTimeAsync(COVERING_STALL_WINDOW_MS - 2000);
      expect(settled).toBe(false);

      // Now it stands still for a full stall window.
      await jest.advanceTimersByTimeAsync(COVERING_STALL_WINDOW_MS + 2000);
      await expect(pending).resolves.toMatchObject({ after: 60 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('should not judge a covering that is slow to start as already stopped', async () => {
    jest.useFakeTimers();
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    const device = { current: 81, duration: { value: 0, unit: 'unknown' } };
    createCoveringHarness(platform as any, device);

    try {
      const pending = (platform as any).testCoveringPosition(5, 25);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      // Still at 81 for longer than the whole stall window before it begins to move. Without
      // the grace period the stall clock would already have expired and reported 81%.
      await jest.advanceTimersByTimeAsync(COVERING_STALL_WINDOW_MS + 2000);
      expect(settled).toBe(false);

      device.current = 25;
      await jest.advanceTimersByTimeAsync(COVERING_STALL_WINDOW_MS + 2000);

      await expect(pending).resolves.toMatchObject({ after: 25, reached: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['a second move', (platform: any) => platform.driveCovering(5, 100)],
    ['a stop', (platform: any) => platform.driveCoveringStop(5)],
  ])('should refuse %s while a covering test is already running', async (_name, second) => {
    jest.useFakeTimers();
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api) as any;
    const device = { current: 81, duration: { value: 0, unit: 'unknown' } };
    const { targetSetter, holdSetter } = createCoveringHarness(platform, device);

    try {
      const first = platform.driveCovering(5, 25);
      await Promise.resolve();

      // The guard lives in the platform, not the page, so another tab or a direct call to the
      // local interface cannot drive the same motor while this one is in flight.
      await expect(second(platform)).rejects.toThrow(/already running/);

      // Nothing beyond the first command reached the covering.
      expect(targetSetter.handleSetRequest).toHaveBeenCalledTimes(1);
      expect(holdSetter.handleSetRequest).not.toHaveBeenCalled();

      device.current = 25;
      await jest.advanceTimersByTimeAsync(
        COVERING_REPORT_GRACE_MS + COVERING_STALL_WINDOW_MS + 2000,
      );
      await first;

      // Once it finishes the node is free again.
      const afterwards = platform.driveCoveringStop(5);
      await jest.advanceTimersByTimeAsync(
        COVERING_REPORT_GRACE_MS + COVERING_STALL_WINDOW_MS + 2000,
      );
      await expect(afterwards).resolves.toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('should not credit a stop to a covering that never moved', async () => {
    jest.useFakeTimers();
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    // Stationary at 76 with a stale target of 100: resting short of the target without ever
    // moving is not evidence that a stop was obeyed.
    const device = { current: 76, duration: { value: 0, unit: 'seconds' }, hapTarget: 100 };
    createCoveringHarness(platform as any, device);

    try {
      const pending = (platform as any).stopCovering(5);
      await jest.advanceTimersByTimeAsync(COVERING_REPORT_GRACE_MS + COVERING_STALL_WINDOW_MS);

      await expect(pending).resolves.toMatchObject({
        after: 76,
        moved: false,
        shortOfTarget: false,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('should not report a move as reached when the test timed out', async () => {
    jest.useFakeTimers();
    const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    const config: PlatformConfig = {
      platform: PLATFORM_NAME,
      name: 'Z-Wave USB',
      serialPort: '/dev/null',
    };

    const platform = new ZWaveUsbPlatform(log, config, api);
    const device = { current: 81, duration: { value: 0, unit: 'unknown' } };
    createCoveringHarness(platform as any, device);

    try {
      const pending = (platform as any).testCoveringPosition(5, 25);
      // Keeps reporting new positions right up to the deadline, landing on the target by
      // coincidence at the moment time runs out.
      for (let elapsed = 0; elapsed < 72000; elapsed += 2000) {
        device.current = device.current === 25 ? 26 : 25;
        await jest.advanceTimersByTimeAsync(2000);
      }

      await expect(pending).resolves.toMatchObject({ reached: false, timedOut: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('should refuse a position test for a node that is not a covering', async () => {
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
    (platform as any).zwaveAccessories.set(7, {
      stop: jest.fn(),
      platformAccessory: { services: [{ UUID: 'something-else' }] },
    });
    (platform as any).zwaveController.nodes.set(7, { nodeId: 7, getValue: jest.fn() });

    await expect((platform as any).testCoveringPosition(7, 25)).rejects.toThrow(
      /not published as a window covering/,
    );
    await expect((platform as any).testCoveringPosition(99, 25)).rejects.toThrow(
      /no HomeKit accessory/,
    );
    await expect((platform as any).testCoveringPosition(7, 150)).rejects.toThrow(
      /between 0 and 100/,
    );
  });

  describe('the live set a Matter cache sweep is keyed on', () => {
    const newPlatform = () => {
      const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
      const config: PlatformConfig = {
        platform: PLATFORM_NAME,
        name: 'Z-Wave USB',
        serialPort: '/dev/null',
      };
      const platform = new ZWaveUsbPlatform(log, config, api) as any;
      platform.zwaveController.nodes = new Map([[5, { nodeId: 5 }]]);
      Object.defineProperty(platform.zwaveController, 'homeId', { value: 0xabc, writable: true });
      return platform;
    };

    const cached = (uuid: string, nodeId: number, homeId: number) =>
      ({ UUID: uuid, context: { nodeId, homeId }, services: [] }) as never;

    it('excludes an accessory cached from a different Z-Wave network', () => {
      // Node numbers are reused across networks, so the node id alone proves nothing.
      const platform = newPlatform();
      platform.accessories.push(cached('other-network', 5, 0x999));

      expect(platform.liveAccessoryUuids().has('other-network')).toBe(false);
    });

    it('keeps a node that has not been built yet, whatever it turns out to be', () => {
      // Asleep, dead or still interviewing. What it will publish as is not knowable, so
      // unregistering it from Matter would be a guess against a shade with a flat battery.
      const platform = newPlatform();
      platform.accessories.push(cached('not-ready', 5, 0xabc));

      expect(platform.liveAccessoryUuids().has('not-ready')).toBe(true);
    });

    it('drops a ready accessory with no supported Matter service', () => {
      // A rebuilt node with no supported services must leave the Matter cache sweep.
      const platform = newPlatform();
      platform.accessories.push(cached('reclassified', 5, 0xabc));
      platform.zwaveAccessories.set(5, {
        stop: jest.fn(),
        platformAccessory: { UUID: 'reclassified', services: [{ UUID: 'unsupported-service' }] },
      });

      expect(platform.liveAccessoryUuids().has('reclassified')).toBe(false);
    });

    it('keeps a ready accessory that is still a covering', () => {
      const platform = newPlatform();
      platform.accessories.push(cached('still-a-covering', 5, 0xabc));
      platform.zwaveAccessories.set(5, {
        stop: jest.fn(),
        platformAccessory: {
          UUID: 'still-a-covering',
          services: [{ UUID: platform.Service.WindowCovering.UUID }],
        },
      });

      expect(platform.liveAccessoryUuids().has('still-a-covering')).toBe(true);
    });
  });


  describe('the Matter cache sweep and controller startup', () => {
    const newPlatform = () => {
      const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
      const config: PlatformConfig = {
        platform: PLATFORM_NAME,
        name: 'Z-Wave USB',
        serialPort: '/dev/null',
      };
      const platform = new ZWaveUsbPlatform(log, config, api) as any;
      // The controller accessory needs a fuller HAP mock than these tests care about, and none
      // of them is about it.
      platform.buildControllerAccessory = jest.fn(() => {
        platform.controllerAccessory = { stop: jest.fn() };
      });
      return platform;
    };

    it('does not sweep when the controller could not be started', async () => {
      // An empty node list after a failed start means the stick could not be read, not that
      // every node was removed. Sweeping on it would unregister every restored covering.
      jest.useFakeTimers();
      const platform = newPlatform();
      const reconcile = jest.fn().mockResolvedValue(undefined);
      platform.matterAccessories.reconcileCached = reconcile;
      platform.zwaveController.start = jest.fn().mockRejectedValue(new Error('stick unplugged'));

      try {
        await platform.connectToZWaveController();

        expect(reconcile).not.toHaveBeenCalled();
      } finally {
        clearTimeout(platform.retryTimeout);
        jest.useRealTimers();
      }
    });

    it('sweeps once on the retry that finally connects', async () => {
      // didFinishLaunching has long since returned by then, so nothing else would run it.
      jest.useFakeTimers();
      const platform = newPlatform();
      const reconcile = jest.fn().mockResolvedValue(undefined);
      platform.matterAccessories.reconcileCached = reconcile;
      platform.zwaveController.start = jest
        .fn()
        .mockRejectedValueOnce(new Error('stick unplugged'))
        .mockResolvedValue(undefined);

      try {
        await platform.connectToZWaveController();
        expect(reconcile).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(31000);

        expect(reconcile).toHaveBeenCalledTimes(1);
      } finally {
        clearTimeout(platform.retryTimeout);
        jest.useRealTimers();
      }
    });

    it('does not report a Matter sweep failure as a Z-Wave connection failure', async () => {
      // Matter is optional. Treating its failure as the stick failing schedules another connect,
      // and that stops a driver that is working perfectly well.
      jest.useFakeTimers();
      const platform = newPlatform();
      platform.matterAccessories.reconcileCached = jest
        .fn()
        .mockRejectedValue(new Error('matter is unwell'));
      const start = jest.fn().mockResolvedValue(undefined);
      platform.zwaveController.start = start;

      try {
        await platform.connectToZWaveController();

        // The connection stands: no retry was scheduled and the controller accessory was built.
        expect(platform.retryTimeout).toBeUndefined();
        expect(platform.controllerAccessory).toBeDefined();

        await jest.advanceTimersByTimeAsync(31000);
        expect(start).toHaveBeenCalledTimes(1);
      } finally {
        clearTimeout(platform.matterSweepTimeout);
        jest.useRealTimers();
      }
    });

    it('retries only the sweep after it fails, without touching Z-Wave', async () => {
      jest.useFakeTimers();
      const platform = newPlatform();
      const reconcile = jest
        .fn()
        .mockRejectedValueOnce(new Error('matter is unwell'))
        .mockResolvedValue(undefined);
      platform.matterAccessories.reconcileCached = reconcile;
      const start = jest.fn().mockResolvedValue(undefined);
      platform.zwaveController.start = start;

      try {
        await platform.connectToZWaveController();
        expect(reconcile).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(31000);

        expect(reconcile).toHaveBeenCalledTimes(2);
        // The driver was never restarted to get there.
        expect(start).toHaveBeenCalledTimes(1);

        // And once it succeeds it does not keep going.
        await jest.advanceTimersByTimeAsync(31000);
        expect(reconcile).toHaveBeenCalledTimes(2);
      } finally {
        clearTimeout(platform.matterSweepTimeout);
        jest.useRealTimers();
      }
    });

    it('sweeps only once across repeated connections', async () => {
      jest.useFakeTimers();
      const platform = newPlatform();
      const reconcile = jest.fn().mockResolvedValue(undefined);
      platform.matterAccessories.reconcileCached = reconcile;
      platform.zwaveController.start = jest.fn().mockResolvedValue(undefined);

      try {
        await platform.connectToZWaveController();
        await platform.connectToZWaveController();

        expect(reconcile).toHaveBeenCalledTimes(1);
      } finally {
        clearTimeout(platform.retryTimeout);
        jest.useRealTimers();
      }
    });
  });

  it('should refuse a failed-node removal whose confirmation does not match', async () => {
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
    const controller = (platform as any).zwaveController;
    controller.removeFailedNode = jest
      .fn()
      .mockRejectedValue(new Error('Refusing to remove Node 8: the confirmation did not match'));

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
    const res = { writeHead: jest.fn(), end: jest.fn() };
    req.url = '/nodes/8/remove-failed';
    req.method = 'POST';

    try {
      (platform as any).startIpcServer();
      const handler = createServerSpy.mock.calls.at(-1)?.[0];
      await new Promise<void>((resolve) => {
        res.end = jest.fn().mockImplementation(() => resolve());
        handler(req, res);
        req.emit('data', JSON.stringify({ confirmNodeId: 5 }));
        req.emit('end');
      });

      expect(controller.removeFailedNode).toHaveBeenCalledWith(8, 5);
      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    } finally {
      createServerSpy.mockRestore();
    }
  });

  describe('failed-node removal check route', () => {
    const driveGet = async (platform: any, url: string) => {
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
      const res = { writeHead: jest.fn(), end: jest.fn() };
      req.url = url;
      req.method = 'GET';

      try {
        platform.startIpcServer();
        const handler = createServerSpy.mock.calls.at(-1)?.[0];
        await new Promise<void>((resolve) => {
          res.end = jest.fn().mockImplementation(() => resolve());
          handler(req, res);
        });
        return {
          status: (res.writeHead as jest.Mock).mock.calls[0]?.[0],
          body: JSON.parse((res.end as jest.Mock).mock.calls[0][0]),
        };
      } finally {
        createServerSpy.mockRestore();
      }
    };

    const newPlatform = () => {
      const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
      const config: PlatformConfig = {
        platform: PLATFORM_NAME,
        name: 'Z-Wave USB',
        serialPort: '/dev/null',
      };
      return new ZWaveUsbPlatform(log, config, api) as any;
    };

    it('returns the controller assessment for the node', async () => {
      // The URL the UI server builds and the matcher the platform uses are independent strings.
      // Without this, changing either one alone keeps the suite green and breaks the button.
      const platform = newPlatform();
      const assessment = {
        nodeId: 8,
        name: "Lia's Shade",
        status: 3,
        eligible: true,
        reason: 'The controller reports Node 8 as failed.',
      };
      platform.zwaveController.assessFailedNodeRemoval = jest.fn().mockResolvedValue(assessment);

      const { body } = await driveGet(platform, '/nodes/8/removal-check');

      expect(platform.zwaveController.assessFailedNodeRemoval).toHaveBeenCalledWith(8);
      expect(body).toEqual(assessment);
    });

    it('answers with an error when the assessment fails', async () => {
      const platform = newPlatform();
      platform.zwaveController.assessFailedNodeRemoval = jest
        .fn()
        .mockRejectedValue(new Error('Driver not started'));

      const { status, body } = await driveGet(platform, '/nodes/8/removal-check');

      expect(status).toBe(500);
      expect(body.error).toBe('Driver not started');
    });

    it('answers rather than hanging when there is no controller', async () => {
      // The dialog awaits this with no timeout, so a route that returns without writing leaves
      // the Remove button disabled with nothing on screen to explain it.
      const platform = newPlatform();
      platform.zwaveController = undefined;

      const { status, body } = await driveGet(platform, '/nodes/8/removal-check');

      expect(status).toBe(500);
      expect(body.error).toContain('Controller');
    });
  });

  describe('route rebuild IPC routes', () => {
    const driveRoute = async (
      platform: any,
      url: string,
      method: string,
    ): Promise<{ status: number | undefined; body: any }> => {
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
      const res = { writeHead: jest.fn(), end: jest.fn() };
      req.url = url;
      req.method = method;

      try {
        platform.startIpcServer();
        const handler = createServerSpy.mock.calls.at(-1)?.[0];
        await new Promise<void>((resolve) => {
          res.end = jest.fn().mockImplementation(() => resolve());
          handler(req, res);
        });
        return {
          status: (res.writeHead as jest.Mock).mock.calls[0]?.[0],
          body: JSON.parse((res.end as jest.Mock).mock.calls[0][0]),
        };
      } finally {
        createServerSpy.mockRestore();
      }
    };

    const newPlatform = () => {
      const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
      const config: PlatformConfig = {
        platform: PLATFORM_NAME,
        name: 'Z-Wave USB',
        serialPort: '/dev/null',
      };
      return new ZWaveUsbPlatform(log, config, api) as any;
    };

    it.each([
      ['started', 'started'],
      ['busy', 'busy'],
      ['refused', 'refused'],
    ])('passes the controller result %s through unchanged', async (_name, result) => {
      // The three outcomes are not interchangeable: busy means a rebuild this plugin did not
      // start is running, so the UI still has something to wait for, and refused means nothing
      // is running at all. Collapsing them to a boolean loses that.
      const platform = newPlatform();
      platform.zwaveController.startHealing = jest.fn().mockResolvedValue(result);
      // isHealing tracks only rebuilds this plugin started, so it is false for busy. That is
      // exactly why the status route also reports the driver's own view.
      platform.zwaveController.isHealing = jest.fn().mockReturnValue(result === 'started');

      const { body } = await driveRoute(platform, '/network/heal', 'POST');

      expect(body).toEqual({ result, healing: result === 'started' });
    });

    it.each([
      [true, false],
      [false, true],
      [false, false],
    ])('reports healing=%p and rebuilding=%p', async (healing, rebuilding) => {
      // Both are needed. A rebuild started before this plugin began tracking one is invisible to
      // isHealing, so reporting only that would tell the UI it had finished immediately.
      const platform = newPlatform();
      platform.zwaveController.isHealing = jest.fn().mockReturnValue(healing);
      platform.zwaveController.isRebuildingRoutes = jest.fn().mockReturnValue(rebuilding);

      const { body } = await driveRoute(platform, '/network/heal/status', 'GET');

      expect(body).toEqual({ healing, rebuilding });
    });

    it('answers the status route with an error when there is no controller', async () => {
      // Answering healing:false here would be read as "the rebuild finished".
      const platform = newPlatform();
      platform.zwaveController = undefined;

      const { status, body } = await driveRoute(platform, '/network/heal/status', 'GET');

      expect(status).toBe(500);
      expect(body.error).toContain('Controller');
    });

    it('answers with an error when the controller refuses to start a rebuild', async () => {
      const platform = newPlatform();
      platform.zwaveController.startHealing = jest
        .fn()
        .mockRejectedValue(new Error('Driver not started'));

      const { status, body } = await driveRoute(platform, '/network/heal', 'POST');

      expect(status).toBe(500);
      expect(body.error).toBe('Driver not started');
    });

    it('answers rather than hanging when there is no controller', async () => {
      // The management UI awaits this request with no timeout, so a route that returns without
      // writing leaves its button disabled for good.
      const platform = newPlatform();
      platform.zwaveController = undefined;

      const { status, body } = await driveRoute(platform, '/network/heal', 'POST');

      expect(status).toBe(500);
      expect(body.error).toContain('Controller');
    });
  });

  describe('device type IPC routes', () => {
    const FINGERPRINT = { manufacturerId: 2748, productType: 2, productId: 16 };
    const OVERRIDES_FILE = 'homebridge-zwave-usb-overrides-00000064.json';

    const driveRoute = async (
      platform: any,
      url: string,
      method: string,
      body?: unknown,
    ): Promise<{ status: number | undefined; body: any }> => {
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
      const res = { writeHead: jest.fn(), end: jest.fn() };
      req.url = url;
      req.method = method;

      try {
        platform.startIpcServer();
        const handler = createServerSpy.mock.calls.at(-1)?.[0];
        await new Promise<void>((resolve) => {
          res.end = jest.fn().mockImplementation(() => resolve());
          handler(req, res);
          if (body !== undefined) {
            req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
            req.emit('end');
          }
        });
        return {
          status: (res.writeHead as jest.Mock).mock.calls[0]?.[0],
          body: JSON.parse((res.end as jest.Mock).mock.calls[0][0]),
        };
      } finally {
        createServerSpy.mockRestore();
      }
    };

    /** An accessory already published, so a write exercises the rebuild rather than discovery. */
    const published = (nodeId: number, signature: string) => ({
      platformAccessory: { UUID: `uuid-${nodeId}` },
      initialize: jest.fn(),
      isInitialized: () => true,
      getGraphSignature: () => signature,
      stop: jest.fn(),
      refresh: jest.fn(),
      updateNode: jest.fn(),
    });

    const shadeNode = (nodeId: number) =>
      buildNode(
        REALISTIC_DEVICES.find((c) => c.name === 'covering (Multilevel Switch only)')!,
        { nodeId, ...FINGERPRINT },
      );

    const saved = (overrides: unknown[] = [], observations: unknown[] = []) =>
      fs.writeFileSync(
        path.join(storagePath, OVERRIDES_FILE),
        JSON.stringify({ version: 1, homeId: '00000064', overrides, observations }),
      );

    const onDisk = () =>
      JSON.parse(fs.readFileSync(path.join(storagePath, OVERRIDES_FILE), 'utf8'));

    const newPlatform = (nodes: Map<number, any>) => {
      const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
      const config: PlatformConfig = {
        platform: PLATFORM_NAME,
        name: 'Z-Wave USB',
        serialPort: '/dev/null',
      };
      const platform = new ZWaveUsbPlatform(log, config, api) as any;
      platform.zwaveController.homeId = 0x64;
      platform.zwaveController.nodes = nodes;
      jest.spyOn(platform.matterAccessories, 'add').mockImplementation(() => undefined);
      jest.spyOn(AccessoryFactory, 'create').mockImplementation(((
        _platform: unknown,
        node: any,
        _homeId: unknown,
        plans: any,
      ) => ({
        ...published(node.nodeId, AccessoryFactory.signatureOfPlans(plans)),
      })) as never);
      return platform;
    };

    const buildsButCannotPublish = () =>
      (AccessoryFactory.create as jest.Mock).mockImplementation(((
        _platform: unknown,
        node: any,
        _homeId: unknown,
        plans: any,
      ) => ({
        ...published(node.nodeId, AccessoryFactory.signatureOfPlans(plans)),
        isInitialized: () => false,
        initialize: () => {
          throw new Error('HomeKit refused the service');
        },
      })) as never);

    afterEach(() => jest.restoreAllMocks());

    it('answers with everything the type panel draws', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));

      const { status, body } = await driveRoute(platform, '/nodes/10/type', 'GET');

      expect(status).toBe(200);
      expect(body).toMatchObject({
        nodeId: 10,
        fingerprint: FINGERPRINT,
        primaryKind: 'multilevel-switch',
        source: 'detected',
        options: ['window-covering', 'multilevel-switch'],
        cohortRevision: expect.any(String),
      });
    });

    it('answers that a node it does not have is not in the network', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));

      const { status, body } = await driveRoute(platform, '/nodes/99/type', 'GET');

      expect(status).toBe(404);
      expect(body.error).toContain('99');
    });

    it('saves a decision and rebuilds every accessory it changed', async () => {
      saved();
      const nodes = new Map([
        [10, shadeNode(10)],
        [11, shadeNode(11)],
      ]);
      const platform = newPlatform(nodes);
      platform.zwaveAccessories = new Map([
        [10, published(10, 'before')],
        [11, published(11, 'before')],
      ]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;

      const { body } = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      expect(body.rebuilt).toEqual([10, 11]);
      expect(body.failed).toEqual([]);
      expect(body.payload).toMatchObject({ primaryKind: 'window-covering', source: 'override' });
      expect(onDisk().overrides[0]).toMatchObject({ primaryKind: 'window-covering' });
    });

    it('refuses a decision composed against a cohort that has moved, and changes nothing', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));

      const { status, body } = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'stale123',
      });

      // The refusal is an answer, not a transport failure: the panel redraws from the payload
      // and tells the user what moved, which an error status would turn into a bare message.
      expect(status).toBe(200);
      expect(body.refusal).toBe('cohort-changed');
      expect(body.rebuilt).toEqual([]);
      expect(body.payload).toMatchObject({ source: 'detected' });
      expect(onDisk().overrides).toEqual([]);
    });

    it('reports a request missing the guards it needs rather than acting on it', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));

      const { body } = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
      });

      expect(body.refusal).toBe('incomplete-request');
      expect(onDisk().overrides).toEqual([]);
    });

    it('answers a body that is not JSON without reaching the write', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));

      const { status, body } = await driveRoute(platform, '/nodes/10/type', 'POST', '{ not json');

      expect(status).toBe(400);
      expect(body.error).toEqual(expect.any(String));
      expect(onDisk().overrides).toEqual([]);
    });

    it('clears a decision and returns the node to its own type', async () => {
      saved([
        { fingerprint: FINGERPRINT, primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
      ]);
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;

      const { body } = await driveRoute(platform, '/nodes/10/type/clear', 'POST', {
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      expect(body.rebuilt).toEqual([10]);
      expect(body.payload).toMatchObject({ primaryKind: 'multilevel-switch', source: 'detected' });
      expect(onDisk().overrides).toEqual([]);
    });

    it('removes a decision that reaches no device', async () => {
      saved([
        { fingerprint: FINGERPRINT, primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
      ]);
      // The relay reports the same hardware identifiers but cannot be a covering, so the saved
      // decision reaches nothing and removing it changes what no device publishes.
      const relay = buildNode(
        REALISTIC_DEVICES.find((c) => c.name === 'relay')!,
        { nodeId: 10, ...FINGERPRINT },
      );
      const platform = newPlatform(new Map([[10, relay]]));
      const before = (await driveRoute(platform, '/nodes/10/type', 'GET')).body;

      const { body } = await driveRoute(platform, '/nodes/10/type/remove', 'POST', {
        expectedRevision: before.cohortRevision,
      });

      expect(before.invalid).toMatchObject({ primaryKind: 'window-covering', appliedTo: [] });
      expect(body.refusal).toBeUndefined();
      expect(body.payload.invalid).toBeNull();
      expect(onDisk().overrides).toEqual([]);
    });

    it('refuses to remove a decision that is still in force on a device', async () => {
      saved([
        { fingerprint: FINGERPRINT, primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
      ]);
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      const before = (await driveRoute(platform, '/nodes/10/type', 'GET')).body;

      const { body } = await driveRoute(platform, '/nodes/10/type/remove', 'POST', {
        expectedRevision: before.cohortRevision,
      });

      expect(body.refusal).toBe('override-in-use');
      expect(onDisk().overrides).toHaveLength(1);
    });

    it('refuses a write naming a node that is not in the network', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));

      const { body } = await driveRoute(platform, '/nodes/99/type/clear', 'POST', {
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'unused',
      });

      expect(body.refusal).toBe('unknown-node');
      expect(body.payload).toBeNull();
    });

    it('accepts a change of hardware on one node number', async () => {
      const orphanFingerprint = { manufacturerId: 1, productType: 2, productId: 3 };
      saved(
        [
          { fingerprint: orphanFingerprint, primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
        ],
        [
          {
            id: 'ob-1',
            nodeId: 10,
            fingerprint: orphanFingerprint,
            appliedAt: '2026-09-30T17:02:00Z',
            orphanedAt: '2026-10-05T00:00:00Z',
          },
        ],
      );
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));

      const before = (await driveRoute(platform, '/nodes/10/type', 'GET')).body;
      const { body } = await driveRoute(platform, '/nodes/10/type/acknowledge', 'POST', {
        observationId: 'ob-1',
        expectedFingerprint: FINGERPRINT,
      });

      expect(before.orphans).toHaveLength(1);
      expect(body.refusal).toBeUndefined();
      expect(body.payload.orphans).toEqual([]);
      // Accepting a change of hardware says nothing about the decision itself.
      expect(onDisk().overrides).toHaveLength(1);
      expect(onDisk().observations).toEqual([]);
    });

    it('keeps a saved decision when one node cannot be rebuilt, and rebuilds the rest', async () => {
      saved();
      const platform = newPlatform(
        new Map([
          [10, shadeNode(10)],
          [11, shadeNode(11)],
        ]),
      );
      platform.zwaveAccessories = new Map([
        [10, published(10, 'before')],
        [11, published(11, 'before')],
      ]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const real = platform.syncNodeAccessory.bind(platform);
      platform.syncNodeAccessory = (node: any) => {
        if (node.nodeId === 10) {
          throw new Error('HomeKit refused the service');
        }
        return real(node);
      };

      const { body } = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      expect(body.failed).toEqual([{ nodeId: 10, error: 'HomeKit refused the service.' }]);
      expect(body.rebuilt).toEqual([11]);
      expect(onDisk().overrides[0]).toMatchObject({ primaryKind: 'window-covering' });
    });

    it('does not claim a node was rebuilt when the decision did not change it', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      // The accessory already carries the graph the decision produces, so nothing is replaced.
      const unchanged = AccessoryFactory.signatureOfPlans(
        AccessoryFactory.planFeatures(shadeNode(10), { primaryOverride: 'window-covering' }),
      );
      platform.zwaveAccessories = new Map([[10, published(10, unchanged)]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;

      const { body } = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      expect(body.rebuilt).toEqual([]);
      expect(body.failed).toEqual([]);
    });

    it('rebuilds nothing for a refused write, whatever the refusal reports', async () => {
      // The platform does not reason about which refusals could carry nodes. A refusal means
      // nothing was saved, so nothing is rebuilt on the strength of it.
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      jest
        .spyOn(TypeOverrideResolver.prototype, 'setNodeType')
        .mockResolvedValue({ refusal: 'cohort-changed', rebuild: [10] });

      const { body } = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'anything',
      });

      expect(body.refusal).toBe('cohort-changed');
      expect(body.rebuilt).toEqual([]);
    });

    /**
     * An accessory whose stop() has an effect. Once stopped it answers nothing, which is what a
     * torn-down covering controller does: a stub whose stop() changes nothing cannot show the
     * defect these two cover, because using the stopped accessory would look like success.
     */
    const stoppable = (nodeId: number, signature: string) => {
      const refuseWhenStopped = (what: string) =>
        jest.fn(() => {
          if (accessory.stopped) {
            throw new Error(`${what} reached a stopped accessory for Node ${nodeId}`);
          }
        });

      const accessory = {
        platformAccessory: { UUID: `uuid-${nodeId}` },
        stopped: false,
        initialize: jest.fn(),
        isInitialized: () => true,
        getGraphSignature: () => signature,
        stop: jest.fn(() => {
          accessory.stopped = true;
        }),
        refresh: refuseWhenStopped('refresh'),
        updateNode: refuseWhenStopped('updateNode'),
      };

      return accessory;
    };

    it('keeps no accessory it stopped when the replacement cannot be built', async () => {
      /**
       * The old accessory is stopped before the new one is built. Left in place after a failed
       * build it answers nothing, while the signature it still reports says the node is up to
       * date, so the next pass settles the warning, skips the rebuild, and leaves HomeKit bound
       * to it until Homebridge restarts.
       */
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      const original = stoppable(10, 'before');
      platform.zwaveAccessories = new Map([[10, original]]);
      jest
        .spyOn(TypeOverrideResolver.prototype, 'setNodeType')
        .mockResolvedValue({ rebuild: [10] });
      jest.spyOn(AccessoryFactory, 'create').mockImplementation(() => {
        throw new Error('HAP refused the service change');
      });

      const { body } = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'anything',
      });

      expect(original.stopped).toBe(true);
      expect(body.failed).toEqual([
        { nodeId: 10, error: expect.stringContaining('HAP refused the service change') },
      ]);
      expect(platform.zwaveAccessories.get(10)).toBeUndefined();
    });

    it('rebuilds after a failed rebuild rather than settling against what it stopped', async () => {
      /**
       * The sequence that made the first finding matter: an apply fails, and the revert that
       * follows finds the signature it expects on the accessory the failure stopped. With that
       * accessory gone, there is nothing to match and the node is built again.
       */
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, stoppable(10, 'before')]]);
      jest
        .spyOn(TypeOverrideResolver.prototype, 'setNodeType')
        .mockResolvedValue({ rebuild: [10] });
      jest
        .spyOn(TypeOverrideResolver.prototype, 'clearNodeType')
        .mockResolvedValue({ rebuild: [10] });

      const create = jest.spyOn(AccessoryFactory, 'create').mockImplementation(() => {
        throw new Error('HAP refused the service change');
      });

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'anything',
      });

      const rebuilt = {
        platformAccessory: { UUID: 'uuid-10' },
        initialize: jest.fn(),
        isInitialized: () => true,
        getGraphSignature: () => 'after',
        stop: jest.fn(),
        refresh: jest.fn(),
        updateNode: jest.fn(),
      };
      create.mockReturnValue(rebuilt as never);

      const { body } = await driveRoute(platform, '/nodes/10/type/clear', 'POST', {
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'anything',
      });

      expect(body.rebuilt).toEqual([10]);
      expect(platform.zwaveAccessories.get(10)).toBe(rebuilt);
    });

    /**
     * A node whose configuration values answer on command, so the routes can be driven through
     * the states a real device moves between: nothing asked, asking, answered, and asked again
     * after an attempt that fell short.
     */
    const paramNode = (over: Record<string, unknown> = {}) => {
      const reported = new Map<string, number>([['1', 1_000]]);
      let settle: () => void = () => undefined;
      const dispatches: number[] = [];

      const node: Record<string, unknown> = {
        nodeId: 10,
        ready: true,
        isListening: true,
        status: 4,
        manufacturerId: 0x026e,
        productType: 2,
        productId: 16,
        setValue: jest.fn(),
        supportsCC: (cc: number) => cc === CommandClasses.Configuration,
        getAllEndpoints: () => [{ index: 0, supportsCC: () => true }],
        getDefinedValueIDs: () => [
          { commandClass: CommandClasses.Configuration, endpoint: 0, property: 1 },
        ],
        getValue: () => 5,
        getValueTimestamp: (valueId: { property: unknown }) => reported.get(String(valueId.property)),
        getValueMetadata: () => ({ type: 'number', readable: true, writeable: true, label: 'Hold' }),
        refreshCCValues: jest.fn().mockImplementation(() => {
          dispatches.push(1);
          return new Promise<void>((resolve) => {
            settle = resolve;
          });
        }),
        on: () => node,
        off: () => node,
        ...over,
      };

      return {
        node,
        dispatches,
        /** Lets the attempt finish, which says only that zwave-js stopped trying. */
        settleAttempt: async () => {
          settle();
          await Promise.resolve();
          await Promise.resolve();
        },
        /** Lets the device answer, which is the only thing that confirms a value. */
        answer: (at: number) => reported.set('1', at),
      };
    };

    /**
     * A re-read as the page makes it, naming the device that holds the number. The route
     * requires that name, so a test that left it out would be testing the refusal.
     */
    const askRefresh = (platform: any, nodeId = 10) => {
      const node = platform.zwaveController.nodes.get(nodeId);

      return driveRoute(platform, `/nodes/${nodeId}/parameters/refresh`, 'POST', {
        identity: node ? platform.nodeIdentity(node) : 'a device that is not in the network',
      });
    };

    it('reads the parameters without asking the device anything', async () => {
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.state).toBe('parameters');
      expect(body.groups[0]).toMatchObject({ parameter: 1 });
      expect(node.refreshCCValues).not.toHaveBeenCalled();
      expect(node.setValue).not.toHaveBeenCalled();
      expect(body.refresh).toMatchObject({ state: 'idle', canRequest: true });
    });

    it('never writes to the device, whichever parameter route is called', async () => {
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      await driveRoute(platform, '/nodes/10/parameters', 'GET');
      await askRefresh(platform);

      expect(node.setValue).not.toHaveBeenCalled();
    });

    it('answers with nothing for a node that is not in the network', async () => {
      const platform = newPlatform(new Map([[10, paramNode().node]]));

      expect((await driveRoute(platform, '/nodes/99/parameters', 'GET')).status).toBe(404);
      expect(
        (await askRefresh(platform, 99)).status,
      ).toBe(404);
    });

    it('returns before the attempt it started has settled', async () => {
      /**
       * zwave-js says not to await the refresh, and the route must not: a sleeping device would
       * hold the request open for as long as it sleeps.
       */
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      const { body } = await askRefresh(platform);

      expect(node.refreshCCValues).toHaveBeenCalledWith(CommandClasses.Configuration);
      expect(body.refresh).toMatchObject({
        state: 'dispatching',
        asked: 1,
        waiting: [{ endpoint: 0, parameter: 1, bitMask: null }],
      });
    });

    it('treats a request made while one is running as that same request', async () => {
      const { node, dispatches } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      const first = await askRefresh(platform);
      const second = await askRefresh(platform);

      expect(dispatches).toHaveLength(1);
      expect(second.body.refresh.requestedAt).toBe(first.body.refresh.requestedAt);
      expect(second.body.refresh.state).toBe('dispatching');
    });

    it('does not confirm a value because the attempt finished', async () => {
      /**
       * `refreshCCValues` resolves even where every endpoint failed, because it catches and logs
       * each one. Its settling says the attempt stopped, never that the device answered.
       */
      const { node, settleAttempt } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      await askRefresh(platform);
      await settleAttempt();

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh).toMatchObject({ state: 'incomplete', waiting: [expect.anything()] });
    });

    it('reports completion when the device answers', async () => {
      const { node, settleAttempt, answer } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      await askRefresh(platform);
      answer(2_000);
      await settleAttempt();

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh).toMatchObject({ state: 'complete', waiting: [] });
    });

    it('lets an attempt that fell short be tried again, and that one dispatches', async () => {
      const { node, dispatches, settleAttempt } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      await askRefresh(platform);
      await settleAttempt();
      const { body } = await askRefresh(platform);

      expect(dispatches).toHaveLength(2);
      expect(body.refresh.state).toBe('dispatching');
    });

    it('holds the request so returning to the page finds it rather than starting another', async () => {
      const { node, dispatches } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      await askRefresh(platform);
      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(dispatches).toHaveLength(1);
      expect(body.refresh.state).toBe('dispatching');
    });

    it('discards a request made of hardware the node no longer reports', async () => {
      // Z-Wave gives a node number away again, and the old question answers for nothing.
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      await askRefresh(platform);
      node.productId = 0x99;

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh.state).toBe('idle');
    });

    it('does not pass a request to a replacement that reports the same hardware', async () => {
      /**
       * Matching on number and fingerprint alone hands the new device the question put to the
       * old one, and an attempt whose promise never settles would suppress a real request for
       * as long as the page stayed open.
       */
      const first = paramNode();
      const platform = newPlatform(new Map([[10, first.node]]));

      await askRefresh(platform);
      expect(first.dispatches).toHaveLength(1);

      const second = paramNode();
      platform.zwaveController.nodes = new Map([[10, second.node]]);

      const read = await driveRoute(platform, '/nodes/10/parameters', 'GET');
      expect(read.body.refresh.state).toBe('idle');

      await askRefresh(platform);
      expect(second.dispatches).toHaveLength(1);
    });

    it('does not pass a request to a replacement when neither reports hardware', async () => {
      // Two unknown devices are not the same device, and nothing about them says otherwise.
      const unknown = { manufacturerId: undefined, productType: undefined, productId: undefined };
      const first = paramNode(unknown);
      const platform = newPlatform(new Map([[10, first.node]]));

      await askRefresh(platform);

      const second = paramNode(unknown);
      platform.zwaveController.nodes = new Map([[10, second.node]]);

      await askRefresh(platform);

      expect(second.dispatches).toHaveLength(1);
    });

    it('forgets a request when the node is removed', async () => {
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      await askRefresh(platform);
      expect(platform.parameterRefreshes.has(10)).toBe(true);

      platform.handleNodeRemoved(node);

      expect(platform.parameterRefreshes.has(10)).toBe(false);
    });

    it('does not offer a refresh where nothing could answer', async () => {
      const { node } = paramNode({
        getValueMetadata: () => ({ type: 'number', readable: false, writeable: true }),
      });
      const platform = newPlatform(new Map([[10, node]]));

      const { body } = await askRefresh(platform);

      expect(node.refreshCCValues).not.toHaveBeenCalled();
      expect(body.refresh).toMatchObject({ state: 'idle', canRequest: false });
    });

    it('does not call a re-read successful when the values it asked about went', async () => {
      /**
       * A value that is no longer there did not answer. Reading the empty waiting list as a
       * success would tell a reader the device had just confirmed settings it no longer has.
       */
      const ids = [
        { commandClass: CommandClasses.Configuration, endpoint: 0, property: 1 },
        { commandClass: CommandClasses.Configuration, endpoint: 0, property: 2 },
      ];
      const { node, settleAttempt, answer } = paramNode({ getDefinedValueIDs: () => ids });
      const platform = newPlatform(new Map([[10, node]]));

      await askRefresh(platform);
      answer(2_000);
      ids.splice(1, 1);
      await settleAttempt();

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh).toMatchObject({
        state: 'unavailable',
        waiting: [],
        asked: 2,
        completedAt: null,
      });
    });

    it('does not call a re-read successful when a value stopped being readable', async () => {
      const ids = [
        { commandClass: CommandClasses.Configuration, endpoint: 0, property: 1 },
        { commandClass: CommandClasses.Configuration, endpoint: 0, property: 2 },
      ];
      let readable = true;
      const { node, settleAttempt, answer } = paramNode({
        getDefinedValueIDs: () => ids,
        getValueMetadata: (valueId: { property: unknown }) => ({
          type: 'number',
          readable: valueId.property === 2 ? readable : true,
          writeable: true,
          label: 'Hold',
        }),
      });
      const platform = newPlatform(new Map([[10, node]]));

      await askRefresh(platform);
      answer(2_000);
      readable = false;
      await settleAttempt();

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh).toMatchObject({ state: 'unavailable', completedAt: null });
    });

    it('refuses a re-read that does not name the device it is for', async () => {
      /**
       * A re-read puts commands on the network. A caller that does not say which device it
       * means cannot be answered about whichever device holds the number now, and a name that
       * is not a name is not one.
       */
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      const missing = await driveRoute(platform, '/nodes/10/parameters/refresh', 'POST', {});
      const notAName = await driveRoute(platform, '/nodes/10/parameters/refresh', 'POST', {
        identity: 7,
      });
      const empty = await driveRoute(platform, '/nodes/10/parameters/refresh', 'POST', {
        identity: '',
      });

      expect([missing.status, notAName.status, empty.status]).toEqual([400, 400, 400]);
      expect(node.refreshCCValues).not.toHaveBeenCalled();
    });

    it('does not ask a device the page did not mean to ask', async () => {
      /**
       * A re-read puts commands on the network. A node number can change hands between the list
       * the page read and the request it made from it, and the reader asked for the device they
       * were looking at.
       */
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      const { body } = await driveRoute(platform, '/nodes/10/parameters/refresh', 'POST', {
        identity: 'the-device-that-had-the-number',
      });

      expect(node.refreshCCValues).not.toHaveBeenCalled();
      expect(body.refresh.state).toBe('idle');
      expect(body.identity).not.toBe('the-device-that-had-the-number');
    });

    it('asks when the page named the device that holds the number now', async () => {
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));
      const read = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      const { body } = await driveRoute(platform, '/nodes/10/parameters/refresh', 'POST', {
        identity: read.body.identity,
      });

      expect(node.refreshCCValues).toHaveBeenCalledWith(CommandClasses.Configuration);
      expect(body.refresh.state).toBe('dispatching');
    });

    it('names the node a payload was built from, the same name the list gives it', async () => {
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      const listed = await driveRoute(platform, '/nodes', 'GET');
      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(typeof body.identity).toBe('string');
      expect(body.identity).toBe(listed.body[0].identity);
    });

    it('keeps that name for as long as the node holds the number', async () => {
      const { node } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      const first = await driveRoute(platform, '/nodes/10/parameters', 'GET');
      const second = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(second.body.identity).toBe(first.body.identity);
    });

    it('names a replacement differently, though the number never went missing', async () => {
      /**
       * Nothing announces that a node was replaced: the number is the same, the hardware can be
       * the same, and a page that never saw the number absent would go on drawing what it read
       * for the device that had it before.
       */
      const platform = newPlatform(new Map([[10, paramNode().node]]));
      const before = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      platform.zwaveController.nodes = new Map([[10, paramNode().node]]);
      const after = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(after.body.nodeId).toBe(10);
      expect(after.body.identity).not.toBe(before.body.identity);
    });

    it('names a replacement differently where neither reports any hardware', async () => {
      // Two unknown devices are not one device, and the fingerprint cannot tell them apart.
      const unknown = { manufacturerId: undefined, productType: undefined, productId: undefined };
      const platform = newPlatform(new Map([[10, paramNode(unknown).node]]));
      const before = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      platform.zwaveController.nodes = new Map([[10, paramNode(unknown).node]]);
      const after = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(after.body.identity).not.toBe(before.body.identity);
    });

    it('records the completion where it happened, not where it was next read', async () => {
      /**
       * A page that was closed while the device answered must not have its reopening dated as
       * the moment the values were confirmed, and the request is no better a stand-in: a
       * sleeping device can answer hours after it was asked.
       */
      const { node, settleAttempt, answer } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));
      const clock = jest.spyOn(Date, 'now');

      clock.mockReturnValue(1_000);
      await askRefresh(platform);
      answer(2_000);
      clock.mockReturnValue(5_000);
      await settleAttempt();
      clock.mockReturnValue(9_000);

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh).toMatchObject({
        state: 'complete',
        requestedAt: 1_000,
        completedAt: 5_000,
      });
    });

    it('dates no completion while the attempt is still running', async () => {
      // A value can answer before the attempt stops, and what finishes is the attempt.
      const { node, settleAttempt, answer } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));
      const clock = jest.spyOn(Date, 'now');

      clock.mockReturnValue(1_000);
      await askRefresh(platform);
      answer(2_000);
      clock.mockReturnValue(3_000);
      const mid = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(mid.body.refresh).toMatchObject({ state: 'dispatching', completedAt: null });

      clock.mockReturnValue(6_000);
      await settleAttempt();
      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh).toMatchObject({ state: 'complete', completedAt: 6_000 });
    });

    it('dates a completion that only a later reading could see', async () => {
      // A value the device reports of its own accord answers the question the refresh asked.
      const { node, settleAttempt, answer } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));
      const clock = jest.spyOn(Date, 'now');

      clock.mockReturnValue(1_000);
      await askRefresh(platform);
      await settleAttempt();
      answer(3_000);
      clock.mockReturnValue(8_000);

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh).toMatchObject({ state: 'complete', completedAt: 8_000 });
    });

    it('records no completion for an attempt that finished with values unanswered', async () => {
      const { node, settleAttempt } = paramNode();
      const platform = newPlatform(new Map([[10, node]]));

      await askRefresh(platform);
      await settleAttempt();

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh).toMatchObject({ state: 'incomplete', completedAt: null });
    });

    /**
     * A device that can be written to, with the Set and the Get held open so a test can decide
     * when each answers and what it says.
     */
    const writable = (over: Record<string, unknown> = {}) => {
      const sets: { valueId: Record<string, unknown>; value: unknown }[] = [];
      const polls: { valueId: Record<string, unknown>; options: unknown }[] = [];
      let settleSet: (result: unknown) => void = () => undefined;
      let answerPoll: (value: unknown) => void = () => undefined;
      let failPoll: (err: unknown) => void = () => undefined;

      const made = paramNode({
        setValue: jest.fn().mockImplementation((valueId: Record<string, unknown>, value: unknown) => {
          sets.push({ valueId, value });
          return new Promise((resolve) => {
            settleSet = resolve;
          });
        }),
        pollValue: jest.fn().mockImplementation(
          (valueId: Record<string, unknown>, options: unknown) => {
            polls.push({ valueId, options });
            return new Promise((resolve, reject) => {
              answerPoll = resolve;
              failPoll = reject;
            });
          },
        ),
        ...over,
      });

      return {
        ...made,
        sets,
        polls,
        accept: (result: unknown = { status: SetValueStatus.SuccessUnsupervised }) => settleSet(result),
        /** Answers the Get. `answer` stays the fixture's own, which moves a value's timestamp. */
        reply: (value: unknown) => answerPoll(value),
        failPoll: (err: unknown) => failPoll(err),
      };
    };

    /** Lets every pending microtask run, which is all the lifecycle ever waits on here. */
    const settled = async () => {
      for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve();
      }
    };

    const change = (platform: any, node: any, over: Record<string, unknown> = {}) =>
      driveRoute(platform, '/nodes/10/parameters/value', 'POST', {
        identity: platform.nodeIdentity(node),
        endpoint: 0,
        parameter: 1,
        bitMask: null,
        value: 7,
        expectedValueSize: null,
        expectedFormat: null,
        acknowledgeDestructive: false,
        acknowledgeRequiresReInclusion: false,
        ...over,
      });

    /** A platform whose waits pass at once, so a duration does not hold a test up. */
    const writingPlatform = (node: any) => {
      const platform = newPlatform(new Map([[10, node]]));
      platform.pause = jest.fn().mockResolvedValue(undefined);

      return platform;
    };

    it('answers before the device has, and never waits for the Set', async () => {
      /**
       * A sleeping node can leave the Set in its wakeup queue for hours. The request says what is
       * happening and returns; nothing about it waits for the device.
       */
      const device = writable();
      const platform = writingPlatform(device.node);

      const { status, body } = await change(platform, device.node);

      expect(status).toBe(200);
      expect(body.write).toMatchObject({ state: 'sending', wrote: 7, parameter: 1 });
      expect(device.sets).toHaveLength(1);
      expect(device.sets[0].value).toBe(7);
      expect(device.polls).toHaveLength(0);
    });

    it('asks the device what it holds now, as a query rather than a background poll', async () => {
      const device = writable();
      const platform = writingPlatform(device.node);

      await change(platform, device.node);
      device.accept();
      await settled();

      expect(device.polls).toHaveLength(1);
      expect(device.polls[0].valueId).toMatchObject({
        commandClass: CommandClasses.Configuration,
        endpoint: 0,
        property: 1,
      });
      expect(device.polls[0].options).toEqual({
        priority: MessagePriority.NodeQuery,
        maxSendAttempts: 3,
      });
    });

    it('is not confirmed by the driver writing its own answer into the cache', async () => {
      /**
       * zwave-js writes the caller's own value into the value DB once a Set is accepted, and
       * moves that value's timestamp with it. Nothing in that exchange came from the device, so
       * no reading of the cache and no timestamp can confirm a change: only the number a Get
       * returns can. A driver that updates its cache and never answers the Get must leave the
       * change waiting rather than call it applied.
       */
      let cached = 5;
      let stamp = 1_000;
      const device = writable({
        getValue: () => cached,
        getValueTimestamp: () => stamp,
      });
      const platform = writingPlatform(device.node);

      await change(platform, device.node);
      // The driver's optimistic write, which is what the page would be reading from here on.
      cached = 7;
      stamp = 2_000;
      device.accept();
      await settled();

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(device.polls).toHaveLength(1);
      expect(body.groups[0].values[0]).toMatchObject({ value: 7, reportedAt: 2_000 });
      expect(body.write).toMatchObject({ state: 'confirming', wrote: 7, reported: null });
    });

    it('reads the four answers a device can give as four different outcomes', async () => {
      const outcomes: Record<string, unknown> = {};

      for (const [name, answer] of [
        ['confirmed', 7],
        ['different', 5],
        ['missing', undefined],
        ['thrown', 'throw'],
      ] as [string, unknown][]) {
        const device = writable();
        const platform = writingPlatform(device.node);

        await change(platform, device.node);
        device.accept();
        await settled();

        if (answer === 'throw') {
          device.failPoll(new Error('no answer'));
        } else {
          device.reply(answer);
        }
        await settled();

        outcomes[name] = (await driveRoute(platform, '/nodes/10/parameters', 'GET')).body.write;
      }

      expect(outcomes.confirmed).toMatchObject({ state: 'confirmed', reported: 7 });
      expect(outcomes.different).toMatchObject({ state: 'different', reported: 5 });
      expect(outcomes.missing).toMatchObject({ state: 'unconfirmed', reported: null });
      expect(outcomes.thrown).toMatchObject({ state: 'unconfirmed', reported: null });
    });

    it('waits out a device that says it is still applying the change', async () => {
      const device = writable();
      const platform = writingPlatform(device.node);

      await change(platform, device.node);
      device.accept({
        status: SetValueStatus.Working,
        remainingDuration: { toMilliseconds: () => 4_000 },
      });
      await settled();

      // The token itself, so the wait can be given up on when the change is let go of.
      expect(platform.pause).toHaveBeenCalledWith(4_000, platform.parameterWrites.get(10));
      expect(device.polls).toHaveLength(1);
    });

    it('says what the driver said about a refusal in the log, and a code to the page', async () => {
      const device = writable();
      const platform = writingPlatform(device.node);

      await change(platform, device.node);
      device.accept({ status: SetValueStatus.Fail });
      await settled();

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.write).toMatchObject({ state: 'refused', code: 'device-rejected' });
      expect(device.polls).toHaveLength(0);
      expect(platform.log.error).toHaveBeenCalledWith(
        expect.stringContaining('parameter 1 was not set: Fail'),
      );
    });

    it('refuses a change it will not begin without touching the change it is making', async () => {
      /**
       * A second change is refused because the first is still running. Reporting that by calling
       * the first refused would tell the page it had finished and let it offer the controls
       * again.
       */
      const device = writable();
      const platform = writingPlatform(device.node);

      await change(platform, device.node);
      const second = await change(platform, device.node, { value: 9 });

      expect(second.status).toBe(200);
      expect(second.body.refusal).toBe('busy');
      expect(second.body.write).toMatchObject({ state: 'sending', wrote: 7 });
      expect(device.sets).toHaveLength(1);
    });

    it('tells a change refused for a re-read apart from one refused for a change', async () => {
      const device = writable();
      const platform = writingPlatform(device.node);

      await askRefresh(platform);
      const refused = await change(platform, device.node);

      expect(refused.body.refusal).toBe('busy-rereading');
      expect(device.sets).toHaveLength(0);
    });

    it('refuses a change that names no device, or another one, and sends nothing', async () => {
      const device = writable();
      const platform = writingPlatform(device.node);

      const nameless = await change(platform, device.node, { identity: undefined });
      const other = await change(platform, device.node, { identity: 'someone else' });

      expect(nameless.body.refusal).toBe('no-identity');
      expect(other.body.refusal).toBe('wrong-device');
      expect(device.sets).toHaveLength(0);
    });

    it('refuses a value the device would not take, and sends nothing', async () => {
      const device = writable({
        getValueMetadata: () => ({
          type: 'number',
          readable: true,
          writeable: true,
          label: 'Hold',
          min: 0,
          max: 5,
        }),
      });
      const platform = writingPlatform(device.node);

      const { body } = await change(platform, device.node, { value: 9 });

      expect(body.refusal).toBe('out-of-range');
      expect(device.sets).toHaveLength(0);
    });

    it('refuses a body that is not an object, once, and sends nothing', async () => {
      const device = writable();
      const platform = writingPlatform(device.node);

      const bare = await driveRoute(platform, '/nodes/10/parameters/value', 'POST', null);
      const listed = await driveRoute(platform, '/nodes/10/parameters/value', 'POST', [1, 2]);
      const counted = await driveRoute(platform, '/nodes/10/parameters/value', 'POST', 7);
      const worded = await driveRoute(platform, '/nodes/10/parameters/value', 'POST', '"a change"');

      expect([bare.status, listed.status, counted.status, worded.status]).toEqual([
        400, 400, 400, 400,
      ]);
      expect(bare.body.code).toBe('malformed');
      expect(device.sets).toHaveLength(0);
    });

    it('leaves no refusal behind on the readings that follow', async () => {
      const device = writable();
      const platform = writingPlatform(device.node);

      await change(platform, device.node, { identity: 'someone else' });
      const later = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(later.body.refusal).toBeUndefined();
    });

    it('does not read the device while a change is on its way to it', async () => {
      /**
       * Gets interleaved with the Set would be read against baselines the driver's own optimistic
       * cache write can satisfy. Once the change is being confirmed the Set is out, and more Gets
       * can only help.
       */
      const counts: Record<string, number> = {};
      const stages: [string, (d: ReturnType<typeof writable>) => Promise<void>][] = [
        ['queued', async () => undefined],
        ['sending', async () => undefined],
        [
          'working',
          async (d) => {
            d.accept({
              status: SetValueStatus.Working,
              remainingDuration: { toMilliseconds: () => 4_000 },
            });
            await settled();
          },
        ],
        [
          'confirming',
          async (d) => {
            d.accept();
            await settled();
          },
        ],
        [
          'settled',
          async (d) => {
            d.accept();
            await settled();
            d.reply(7);
            await settled();
          },
        ],
      ];

      for (const [name, reach] of stages) {
        const device = writable(
          name === 'queued' ? { isListening: false, isFrequentListening: false } : {},
        );
        const platform = newPlatform(new Map([[10, device.node]]));
        platform.pause = jest.fn().mockImplementation(() => new Promise(() => undefined));

        await change(platform, device.node);
        await reach(device);
        await askRefresh(platform);

        counts[name] = device.node.refreshCCValues.mock.calls.length;
      }

      expect(counts).toEqual({ queued: 0, sending: 0, working: 0, confirming: 1, settled: 1 });
    });

    it('asks nothing of a device that was replaced while it was applying a change', async () => {
      /**
       * The wait is a timer, and the node can be given away while it runs. A timer that fires for
       * a change the node no longer has must not put a Get on the network, nor write its answer
       * into the change that replaced it.
       */
      const first = writable();
      const platform = newPlatform(new Map([[10, first.node]]));
      let release: () => void = () => undefined;
      platform.pause = jest
        .fn()
        .mockImplementation(() => new Promise<void>((resolve) => {
          release = resolve;
        }));

      await change(platform, first.node);
      first.accept({
        status: SetValueStatus.Working,
        remainingDuration: { toMilliseconds: () => 4_000 },
      });
      await settled();

      const second = writable();
      platform.zwaveController.nodes = new Map([[10, second.node]]);
      await change(platform, second.node);

      release();
      await settled();

      expect(first.polls).toHaveLength(0);
      expect(second.polls).toHaveLength(0);
      expect((await driveRoute(platform, '/nodes/10/parameters', 'GET')).body.write).toMatchObject({
        state: 'sending',
        wrote: 7,
      });
    });

    it('records nothing for a device that was replaced while the Set was in flight', async () => {
      /**
       * The runner spans a send, a wait and a question, and the node can be given away inside any
       * of them. A Set that settles for the device that has gone must not advance the change, nor
       * put a Get on the network for the device that is there now.
       */
      const first = writable();
      const platform = writingPlatform(first.node);

      await change(platform, first.node);
      const stale = platform.parameterWrites.get(10);
      expect(stale.state).toBe('sending');

      platform.zwaveController.nodes = new Map([[10, writable().node]]);
      first.accept();
      await settled();

      expect(stale.state).toBe('sending');
      expect(first.polls).toHaveLength(0);
    });

    it('keeps a late answer out of a change the node no longer has', async () => {
      const first = writable();
      const platform = writingPlatform(first.node);

      await change(platform, first.node);
      first.accept();
      await settled();

      const stale = platform.parameterWrites.get(10);
      expect(stale.state).toBe('confirming');

      platform.zwaveController.nodes = new Map([[10, writable().node]]);
      first.reply(7);
      await settled();

      expect(stale.state).toBe('confirming');
      expect(stale.reported).toBeNull();
    });

    it('cannot finish an old re-read by writing to the value it was waiting for', async () => {
      /**
       * A re-read that settled short keeps a baseline for the value that never answered. The
       * driver writes its own optimistic answer into the cache when a Set is accepted, which
       * advances that value's timestamp, and the next reading would read the move as the device
       * finally answering: a re-read reported complete on the strength of the plugin's own write.
       */
      const device = writable();
      const platform = writingPlatform(device.node);

      await askRefresh(platform);
      await device.settleAttempt();
      expect((await driveRoute(platform, '/nodes/10/parameters', 'GET')).body.refresh).toMatchObject(
        { state: 'incomplete' },
      );

      await change(platform, device.node);
      device.answer(5_000);

      const { body } = await driveRoute(platform, '/nodes/10/parameters', 'GET');

      expect(body.refresh.state).not.toBe('complete');
      expect(body.refresh.completedAt).toBeNull();
    });

    it('forgets a change when the node is removed', async () => {
      const device = writable();
      const platform = writingPlatform(device.node);

      await change(platform, device.node);
      expect(platform.parameterWrites.has(10)).toBe(true);

      platform.handleNodeRemoved(device.node);

      expect(platform.parameterWrites.has(10)).toBe(false);
    });

    it('lets go of a wait when it lets go of the change', async () => {
      /**
       * A device may ask for as much as two hours of applying time. A change whose node has gone
       * must not leave a timer holding that node and its token until the time runs out.
       */
      const device = writable();
      const platform = newPlatform(new Map([[10, device.node]]));

      await change(platform, device.node);
      device.accept({
        status: SetValueStatus.Working,
        remainingDuration: { toMilliseconds: () => 7_200_000 },
      });
      await settled();

      expect(platform.pendingWaits.size).toBe(1);

      /**
       * Unreferenced, so even an uncanceled wait could never be why a bridge stays up. The timer
       * goes whatever the assertion does: a referenced two-hour timer left behind by a failure
       * would keep this process alive and hang the run rather than fail it.
       */
      const [waiting] = [...platform.pendingWaits.values()];

      try {
        expect(waiting.timer.hasRef()).toBe(false);
      } finally {
        clearTimeout(waiting.timer);
      }

      platform.handleNodeRemoved(device.node);
      await settled();

      expect(platform.pendingWaits.size).toBe(0);
      expect(device.polls).toHaveLength(0);
    });

    it('refuses a type saved for the controller, however the request arrives', async () => {
      /**
       * The sync never builds a generic accessory for Node 1, so a decision saved for it would
       * be kept and applied to nothing. The UI does not offer it, and that is not the same as
       * refusing it: this route can be called directly, with a node that otherwise qualifies.
       */
      saved();
      const controller = shadeNode(1);
      const platform = newPlatform(new Map([[1, controller]]));
      platform.zwaveAccessories = new Map();

      const { status, body } = await driveRoute(platform, '/nodes/1/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'anything',
      });

      expect(status).toBe(200);
      expect(body.refusal).toBe('not-overridable');
      expect(body.rebuilt).toEqual([]);
      expect(JSON.parse(fs.readFileSync(path.join(storagePath, OVERRIDES_FILE), 'utf8')).overrides)
        .toEqual([]);
    });

    it('keeps the controller out of a cohort that shares its hardware', async () => {
      // The cohort answers the same question the write does, so it cannot hold a node a write
      // would refuse and then count it among those a decision would reach.
      saved();
      const platform = newPlatform(
        new Map([
          [1, shadeNode(1)],
          [10, shadeNode(10)],
        ]),
      );
      platform.zwaveAccessories = new Map();

      const { body } = await driveRoute(platform, '/nodes/10/type', 'GET');

      expect(body.cohort.map((member: { nodeId: number }) => member.nodeId)).toEqual([10]);
    });

    it('writes the refusal code to the log and not to the reader', async () => {
      /**
       * The panel says the write did not happen and sends the reader to what it now reports,
       * which is the condition the code names. The code itself is only of use to someone
       * reading the log, so that is where it has to arrive.
       */
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      jest
        .spyOn(TypeOverrideResolver.prototype, 'setNodeType')
        .mockResolvedValue({ refusal: 'not-overridable', rebuild: [] });

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'anything',
      });

      expect(platform.log.debug).toHaveBeenCalledWith(
        'Type change for Node 10 was refused: not-overridable',
      );
    });

    it('says nothing to the log about a write it accepted', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      jest
        .spyOn(TypeOverrideResolver.prototype, 'setNodeType')
        .mockResolvedValue({ rebuild: [] });

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'anything',
      });

      expect(platform.log.debug).not.toHaveBeenCalledWith(
        expect.stringContaining('was refused'),
      );
    });

    it('passes over a node that left the network before the rebuild reached it', async () => {
      // Node numbers go away when a device is excluded. One that is gone was not rebuilt and
      // did not fail to rebuild: there is nothing there to report either way.
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      jest
        .spyOn(TypeOverrideResolver.prototype, 'setNodeType')
        .mockResolvedValue({ rebuild: [10, 404] });

      const { body } = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'anything',
      });

      expect(body.rebuilt).toEqual([10]);
      expect(body.failed).toEqual([]);
    });

    it('treats a body that is not an object as one that is missing every field', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));

      const { body } = await driveRoute(platform, '/nodes/10/type', 'POST', 'null');

      expect(body.refusal).toBe('incomplete-request');
      expect(onDisk().overrides).toEqual([]);
    });

    it('discloses the Matter restart only for a device Matter is publishing', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));

      // Nothing is published yet, so there is no live endpoint holding an old device type.
      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.matterActive).toBe(false);

      platform.zwaveAccessories = new Map([[10, published(10, 'current')]]);
      jest.spyOn(platform.matterAccessories, 'publishes').mockReturnValue(true);

      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.matterActive).toBe(true);
    });

    it('still reports Matter after a rebuild that failed and took the wrapper with it', async () => {
      /**
       * A failed rebuild leaves the node with no wrapper, while Matter goes on publishing the
       * endpoint it already has. Reading the identity only from the wrapper reported the node
       * as absent from Matter, so the next type change would have been confirmed without the
       * restart that published endpoint needs, and stayed on the old type in Alexa.
       */
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      const cached = {
        UUID: 'uuid-10',
        context: { nodeId: 10, homeId: platform.zwaveController.homeId },
      };
      platform.accessories.push(cached as never);
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      jest.spyOn(platform.matterAccessories, 'publishes').mockReturnValue(true);
      jest
        .spyOn(TypeOverrideResolver.prototype, 'setNodeType')
        .mockResolvedValue({ rebuild: [10] });
      jest.spyOn(AccessoryFactory, 'create').mockImplementation(() => {
        throw new Error('HAP refused the service change');
      });

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: 'anything',
      });

      expect(platform.zwaveAccessories.get(10)).toBeUndefined();

      // The reader now picks a third type. The endpoint Matter holds is still the old one.
      const { body } = await driveRoute(platform, '/nodes/10/type', 'GET');

      expect(body.matterActive).toBe(true);
      expect(body.cohort.find((member: { nodeId: number }) => member.nodeId === 10).matterActive)
        .toBe(true);
    });

    it('tells the node table which devices a decision reaches', async () => {
      saved([
        { fingerprint: FINGERPRINT, primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
      ]);
      const platform = newPlatform(
        new Map([
          [10, shadeNode(10)],
          [11, shadeNode(11)],
        ]),
      );

      const { body } = await driveRoute(platform, '/nodes', 'GET');

      expect(body[0]).toMatchObject({
        nodeId: 10,
        typeOverride: { primaryKind: 'window-covering', sharedWith: [11] },
        typeInvalid: false,
        typeOrphans: 0,
      });
    });

    it('leaves an unchanged node alone rather than syncing it and comparing afterwards', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      const unchanged = AccessoryFactory.signatureOfPlans(
        AccessoryFactory.planFeatures(shadeNode(10), { primaryOverride: 'window-covering' }),
      );
      const accessory = published(10, unchanged);
      accessory.refresh = jest.fn(() => {
        throw new Error('the device stopped answering');
      });
      platform.zwaveAccessories = new Map([[10, accessory]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;

      const { body } = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      // The sync reaches these on its way past an accessory it will not replace.
      expect(accessory.refresh).not.toHaveBeenCalled();
      expect(accessory.updateNode).not.toHaveBeenCalled();
      expect(body.rebuilt).toEqual([]);
      expect(body.failed).toEqual([]);
    });

    it('answers only once the records the rebuild started have been written', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      // The sync starts the record and does not wait for it, so the reply has to.
      expect(onDisk().observations).toEqual([
        expect.objectContaining({ nodeId: 10, fingerprint: FINGERPRINT, orphanedAt: null }),
      ]);
    });

    it('keeps the node list whole when one node cannot be summarized', async () => {
      saved();
      const unreadable = shadeNode(11);
      unreadable.getAllEndpoints = () => {
        throw new Error('the node is still being interviewed');
      };
      const platform = newPlatform(
        new Map([
          [10, shadeNode(10)],
          [11, unreadable],
        ]),
      );

      const { status, body } = await driveRoute(platform, '/nodes', 'GET');

      expect(status).toBe(200);
      expect(body.map((row: { nodeId: number }) => row.nodeId)).toEqual([10, 11]);
      expect(body[1]).toMatchObject({ typeOverride: null, typeInvalid: false, typeOrphans: 0 });
      expect(platform.log.debug).toHaveBeenCalledWith(
        expect.stringContaining('no summary for the node list'),
      );
    });

    it.each(['/type/clear', '/type/remove', '/type/acknowledge'])(
      'does not let a GET reach the write behind %s',
      async (suffix) => {
        saved([
          {
            fingerprint: FINGERPRINT,
            primaryKind: 'window-covering',
            savedAt: '2026-10-12T18:20:00Z',
          },
        ]);
        const platform = newPlatform(new Map([[10, shadeNode(10)]]));

        const { status, body } = await driveRoute(platform, `/nodes/10${suffix}`, 'GET');

        expect(status).toBe(404);
        expect(body.error).toContain('Path not found');
        expect(onDisk().overrides).toHaveLength(1);
      },
    );

    it('keeps reporting a node that could not be rebuilt until one succeeds', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const real = platform.syncNodeAccessory.bind(platform);
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      const write = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });
      expect(write.body.failed).toEqual([{ nodeId: 10, error: 'HomeKit refused the service.' }]);

      /**
       * Every other field is read from the saved decision, which is the one thing this node is
       * not publishing, so without the mismatch the next refresh would quietly contradict the
       * message the write just returned.
       */
      const stale = await driveRoute(platform, '/nodes/10/type', 'GET');
      expect(stale.body.primaryKind).toBe('window-covering');
      expect(stale.body.rebuildFailure).toEqual({ error: 'HomeKit refused the service.' });
      expect((await driveRoute(platform, '/nodes', 'GET')).body[0].typeRebuildFailed).toBe(true);

      platform.syncNodeAccessory = real;
      await driveRoute(platform, '/nodes/10/type/clear', 'POST', {
        expectedFingerprint: FINGERPRINT,
        expectedRevision: (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision,
      });

      const healed = await driveRoute(platform, '/nodes/10/type', 'GET');
      expect(healed.body.rebuildFailure).toBeNull();
      expect((await driveRoute(platform, '/nodes', 'GET')).body[0].typeRebuildFailed).toBe(false);
    });

    it('builds a changed node from the plan it was compared against', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const handed: unknown[] = [];
      const real = platform.syncNodeAccessory.bind(platform);
      platform.syncNodeAccessory = (node: any, plans: any) => {
        handed.push(plans);
        return real(node, plans);
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      /**
       * Planning answers with a new array every time, so the accessory can only hold the object
       * the comparison used if that one object was carried through rather than read again.
       */
      expect(handed[0]).toBeDefined();
      expect((AccessoryFactory.create as jest.Mock).mock.calls.at(-1)?.[3]).toBe(handed[0]);
    });

    it('settles the warning when an ordinary sync brings the node up to date', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const real = platform.syncNodeAccessory.bind(platform);
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });
      expect(
        (await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure,
      ).not.toBeNull();

      // Nothing about the type is written here. The node simply catches up on its own.
      platform.syncNodeAccessory = real;
      platform.syncNodeAccessory(platform.zwaveController.nodes.get(10));
      // The sync starts a record and does not wait for it; nothing else here will either.
      await platform.typeOverridesFor(platform.zwaveController.homeId).settled();

      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure).toBeNull();
    });

    it('does not hand a node number the warning left by the device before it', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      // Z-Wave hands a freed number to the next device to join, and that device failed at nothing.
      const successor = buildNode(
        REALISTIC_DEVICES.find((c) => c.name === 'covering (Multilevel Switch only)')!,
        { nodeId: 10, manufacturerId: 99, productType: 7, productId: 3 },
      );
      platform.zwaveController.nodes = new Map([[10, successor]]);

      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure).toBeNull();
      expect((await driveRoute(platform, '/nodes', 'GET')).body[0].typeRebuildFailed).toBe(false);
    });

    it('still flags a node behind its saved type when it cannot be summarized', async () => {
      saved();
      const node = shadeNode(10);
      const platform = newPlatform(new Map([[10, node]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      // The flag is the platform's own record, so classifying the node has no part in it.
      node.getAllEndpoints = () => {
        throw new Error('the node is still being interviewed');
      };
      const { body } = await driveRoute(platform, '/nodes', 'GET');

      expect(body[0]).toMatchObject({ typeOverride: null, typeRebuildFailed: true });
    });

    it('clears the warning when the node leaves the network', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      platform.handleNodeRemoved(platform.zwaveController.nodes.get(10));

      // The same device rejoining starts clean rather than inheriting a failure it has outlived.
      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure).toBeNull();
    });

    it('settles the warning when a sync finds the node already publishing it', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const real = platform.syncNodeAccessory.bind(platform);
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      /**
       * The accessory caught up by some other route, so this sync replaces nothing. Reaching a
       * node that is already right is still the moment the warning stops being true.
       */
      const current = AccessoryFactory.signatureOfPlans(
        AccessoryFactory.planFeatures(shadeNode(10), { primaryOverride: 'window-covering' }),
      );
      platform.zwaveAccessories = new Map([[10, published(10, current)]]);
      platform.syncNodeAccessory = real;
      platform.syncNodeAccessory(platform.zwaveController.nodes.get(10));
      // The sync starts a record and does not wait for it; nothing else here will either.
      await platform.typeOverridesFor(platform.zwaveController.homeId).settled();

      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure).toBeNull();
    });

    it('settles the warning when reverting leaves the node as it already is', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      const asDefault = AccessoryFactory.signatureOfPlans(
        AccessoryFactory.planFeatures(shadeNode(10)),
      );
      platform.zwaveAccessories = new Map([[10, published(10, asDefault)]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });
      expect(
        (await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure,
      ).not.toBeNull();

      /**
       * The rebuild failed, so the node is still publishing its default, and reverting to that
       * default asks nothing of it. Nothing is rebuilt, and the warning is no longer true.
       */
      await driveRoute(platform, '/nodes/10/type/clear', 'POST', {
        expectedFingerprint: FINGERPRINT,
        expectedRevision: (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision,
      });

      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure).toBeNull();
    });

    it('keeps the warning when the rebuild it is waiting for fails to publish', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const real = platform.syncNodeAccessory.bind(platform);
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      /**
       * A background reconcile replaces the accessory, and the replacement is in the map before
       * its services exist. Settling the warning there would settle it on the way into the
       * rebuild that fails, and nothing outside a write would set it again.
       */
      buildsButCannotPublish();
      platform.syncNodeAccessory = real;
      expect(() => platform.syncNodeAccessory(platform.zwaveController.nodes.get(10))).toThrow();
      // The sync starts a record and does not wait for it; nothing else here will either.
      await platform.typeOverridesFor(platform.zwaveController.homeId).settled();

      expect(
        (await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure,
      ).not.toBeNull();
    });

    it('keeps the warning when a cached accessory only names the plan it has yet to build', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const real = platform.syncNodeAccessory.bind(platform);
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      /**
       * A restart hands the node back the signature the last run stored for it, which is the
       * saved type, while the services behind it have yet to be built in this one. The node is
       * named as current by that signature and rebuilt in the same pass, so reading it alone
       * would settle the warning for a rebuild that has not happened.
       */
      const current = AccessoryFactory.signatureOfPlans(
        AccessoryFactory.planFeatures(shadeNode(10), { primaryOverride: 'window-covering' }),
      );
      platform.zwaveAccessories = new Map([
        [10, { ...published(10, current), isInitialized: () => false }],
      ]);
      buildsButCannotPublish();
      platform.syncNodeAccessory = real;
      expect(() => platform.syncNodeAccessory(platform.zwaveController.nodes.get(10))).toThrow();
      // The sync starts a record and does not wait for it; nothing else here will either.
      await platform.typeOverridesFor(platform.zwaveController.homeId).settled();

      expect(
        (await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure,
      ).not.toBeNull();
    });

    it('settles the warning when a node with no accessory at all is finally built', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map();
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const factory = (AccessoryFactory.create as jest.Mock).getMockImplementation()!;
      (AccessoryFactory.create as jest.Mock).mockImplementation((() => {
        throw new Error('HomeKit refused the service');
      }) as never);

      /**
       * The first build of this node threw, so it has a warning and no accessory to its name.
       * Discovery is the path that reaches it next, and it is the path that answers the warning.
       */
      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });
      expect(platform.zwaveAccessories.has(10)).toBe(false);
      expect(
        (await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure,
      ).not.toBeNull();

      (AccessoryFactory.create as jest.Mock).mockImplementation(factory as never);
      platform.syncNodeAccessory(platform.zwaveController.nodes.get(10));
      // The sync starts a record and does not wait for it; nothing else here will either.
      await platform.typeOverridesFor(platform.zwaveController.homeId).settled();

      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure).toBeNull();
    });

    it('keeps the warning when a first build reaches the map and fails to publish', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map();
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      (AccessoryFactory.create as jest.Mock).mockImplementation((() => {
        throw new Error('HomeKit refused the service');
      }) as never);

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      // Discovery puts the accessory in the map before building its services, as the other two
      // paths do, so the warning it answers has to wait for the same call to return.
      buildsButCannotPublish();
      expect(() => platform.syncNodeAccessory(platform.zwaveController.nodes.get(10))).toThrow();
      await platform.typeOverridesFor(platform.zwaveController.homeId).settled();

      expect(
        (await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure,
      ).not.toBeNull();
    });

    it('keeps the warning when neither the node nor its accessory names a plan', async () => {
      saved();
      const node = shadeNode(10);
      const platform = newPlatform(new Map([[10, node]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const real = platform.syncNodeAccessory.bind(platform);
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      /**
       * An accessory cached by a version that stored no signature, on a node too early in its
       * interview to be planned. Neither side names anything, and two unknowns matching is not
       * the node having caught up.
       */
      platform.zwaveAccessories = new Map([
        [10, { ...published(10, 'before'), getGraphSignature: () => undefined }],
      ]);
      node.ready = false;
      platform.syncNodeAccessory = real;
      platform.syncNodeAccessory(node);
      await platform.typeOverridesFor(platform.zwaveController.homeId).settled();

      expect(
        (await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure,
      ).not.toBeNull();
    });

    it('settles the warning when a later pass builds the accessory the failure left', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const factory = (AccessoryFactory.create as jest.Mock).getMockImplementation()!;
      buildsButCannotPublish();

      /**
       * The rebuild got as far as HomeKit and failed there, so the node is left holding an
       * accessory whose services were never built. The next sync finds it and builds it, which
       * is the path a cached accessory takes rather than a rebuild, and the warning is answered
       * there too.
       */
      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });
      expect(
        (await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure,
      ).not.toBeNull();

      (AccessoryFactory.create as jest.Mock).mockImplementation(factory as never);
      platform.syncNodeAccessory(platform.zwaveController.nodes.get(10));
      // The sync starts a record and does not wait for it; nothing else here will either.
      await platform.typeOverridesFor(platform.zwaveController.homeId).settled();

      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure).toBeNull();
    });

    /**
     * Whichever path reaches it, HomeKit holds the new service the moment `initialize` returns.
     * Offering the accessory to Matter comes after that and answers for itself: the fault is
     * logged, the sync finishes, and the warning about what HomeKit publishes is settled.
     */
    it.each([
      ['a rebuild', () => new Map([[10, published(10, 'before')]])],
      [
        'a cached accessory',
        () =>
          new Map([
            [
              10,
              {
                ...published(
                  10,
                  AccessoryFactory.signatureOfPlans(
                    AccessoryFactory.planFeatures(shadeNode(10), {
                      primaryOverride: 'window-covering',
                    }),
                  ),
                ),
                isInitialized: () => false,
              },
            ],
          ]),
      ],
      ['a first build', () => new Map()],
    ])('finishes a sync when %s publishes and Matter then fails', async (_path, accessories) => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      const real = platform.syncNodeAccessory.bind(platform);
      platform.syncNodeAccessory = () => {
        throw new Error('HomeKit refused the service');
      };

      await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      platform.zwaveAccessories = accessories();
      (platform.matterAccessories.add as jest.Mock).mockImplementation(() => {
        throw new Error('the Matter server is not running');
      });
      platform.syncNodeAccessory = real;
      platform.syncNodeAccessory(platform.zwaveController.nodes.get(10));
      // The sync starts a record and does not wait for it; nothing else here will either.
      await platform.typeOverridesFor(platform.zwaveController.homeId).settled();

      expect(platform.log.error).toHaveBeenCalledWith(expect.stringContaining('Matter'));
      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure).toBeNull();
    });

    it('reports a write that HomeKit took and Matter did not as the success it is', async () => {
      saved();
      const platform = newPlatform(new Map([[10, shadeNode(10)]]));
      platform.zwaveAccessories = new Map([[10, published(10, 'before')]]);
      const revision = (await driveRoute(platform, '/nodes/10/type', 'GET')).body.cohortRevision;
      (platform.matterAccessories.add as jest.Mock).mockImplementation(() => {
        throw new Error('the Matter server is not running');
      });

      const write = await driveRoute(platform, '/nodes/10/type', 'POST', {
        primaryKind: 'window-covering',
        expectedFingerprint: FINGERPRINT,
        expectedRevision: revision,
      });

      /**
       * The device publishes the type that was asked for. Reporting the Matter fault here would
       * tell the user their rebuild failed, and leave a warning saying so, about a device that
       * was rebuilt.
       */
      expect(write.body.rebuilt).toEqual([10]);
      expect(write.body.failed).toEqual([]);
      expect(write.body.payload.rebuildFailure).toBeNull();
      expect(platform.log.error).toHaveBeenCalledWith(expect.stringContaining('Matter'));

      expect((await driveRoute(platform, '/nodes/10/type', 'GET')).body.rebuildFailure).toBeNull();
    });
  });
});
