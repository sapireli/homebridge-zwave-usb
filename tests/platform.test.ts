import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveUsbPlatform } from '../src/platform/ZWaveUsbPlatform';
import { PLATFORM_NAME } from '../src/platform/settings';
import { AccessoryFactory } from '../src/accessories/AccessoryFactory';
import { ZWaveController } from '../src/zwave/ZWaveController';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { EventEmitter } from 'events';
import { CommandClasses } from '@zwave-js/core';
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

  it('says nothing ordinary about skipping the controller node', () => {
    /**
     * Node 1 is the controller and is published by its own accessory, so the generic path always
     * skips it. Two handlers reach that skip during a single startup, so saying it at info
     * reported an internal decision twice, to a reader who can do nothing about it.
     */
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

    (platform as any).syncNodeAccessory({ nodeId: 1 });
    (platform as any).syncNodeAccessory({ nodeId: 1 });

    const said = (level: jest.Mock) =>
      level.mock.calls.flat().map((e: unknown) => String(e)).join('\n');
    expect(said(log.info)).not.toContain('Skipping generic accessory creation');
    expect(said(log.debug)).toContain('Skipping generic accessory creation');
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
    const matterAdd = jest.fn();
    (platform as any).matterAccessories.add = matterAdd;

    const graphSpy = jest.spyOn(AccessoryFactory, 'getGraphSignature').mockReturnValue('new-graph');
    const createSpy = jest.spyOn(AccessoryFactory, 'create').mockReturnValue(reconciled as any);

    try {
      (platform as any).handleNodeUpdated(node);

      expect(existing.stop).toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledWith(platform, node, 100);
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
      .spyOn(AccessoryFactory, 'getGraphSignature')
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

  describe('what the platform keeps out of the ordinary log', () => {
    it('does not repeat a node arriving or leaving', () => {
      // The controller reports both transitions with the node's name and interview stage.
      // The platform following along is bookkeeping.
      const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
      const config: PlatformConfig = {
        platform: PLATFORM_NAME,
        name: 'Z-Wave USB',
        serialPort: '/dev/null',
      };

      const platform = new ZWaveUsbPlatform(log, config, api);
      const controller = (platform as any).zwaveController;
      controller.homeId = 100;

      const node = { nodeId: 9, name: 'Hall', ready: false, status: 1 };
      controller.emit('node added', node);
      controller.emit('node removed', node);

      const written = log.info.mock.calls.flat().map((e: unknown) => String(e)).join('\n');
      expect(written).not.toContain('added');
      expect(written).not.toContain('removed');

      const debugged = log.debug.mock.calls.flat().map((e: unknown) => String(e)).join('\n');
      expect(debugged).toContain('Node 9 added; waiting for the interview to complete');
      expect(debugged).toContain('Node 9 removed');
    });

    it('restores the accessory cache quietly', () => {
      // Homebridge restores every accessory on every restart. One line each says nothing
      // about this run that the accessories themselves do not.
      const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
      const config: PlatformConfig = {
        platform: PLATFORM_NAME,
        name: 'Z-Wave USB',
        serialPort: '/dev/null',
      };

      const platform = new ZWaveUsbPlatform(log, config, api);
      platform.configureAccessory({ displayName: 'Hall Light', UUID: 'u', context: {} } as any);

      const written = log.info.mock.calls.flat().map((e: unknown) => String(e)).join('\n');
      expect(written).not.toContain('Loading accessory from cache');

      const debugged = log.debug.mock.calls.flat().map((e: unknown) => String(e)).join('\n');
      expect(debugged).toContain('Loading accessory from cache');
    });
  });
});
