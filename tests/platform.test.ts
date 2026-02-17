import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveUsbPlatform } from '../src/platform/ZWaveUsbPlatform';
import { PLATFORM_NAME } from '../src/platform/settings';
import http from 'http';
import fs from 'fs';
import path from 'path';

// Mock ZWaveController to avoid starting the actual driver
jest.mock('../src/zwave/ZWaveController', () => {
  return {
    ZWaveController: jest.fn().mockImplementation(() => {
      const { EventEmitter } = require('events');
      const emitter = new EventEmitter();
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

  beforeEach(() => {
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath);
    }

    hap = {
      Service: jest.fn(),
      Characteristic: jest.fn(),
      uuid: {
        generate: jest.fn().mockReturnValue('test-uuid'),
      },
    } as any;
    api = {
      hap,
      registerPlatform: jest.fn(),
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

  it('should start IPC server and handle requests', async () => {
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

    // Simulate didFinishLaunching
    const launchListener = (api.on as jest.Mock).mock.calls.find(
      (call) => call[0] === 'didFinishLaunching',
    )[1];
    await launchListener();

    const portFile = path.join(storagePath, 'homebridge-zwave-usb.port');

    // Wait for port file to be created
    let retries = 0;
    while (!fs.existsSync(portFile) && retries < 10) {
      await new Promise((res) => setTimeout(res, 100));
      retries++;
    }

    expect(fs.existsSync(portFile)).toBe(true);
    const port = parseInt(fs.readFileSync(portFile, 'utf8'), 10);

    // Make a request to the IPC server
    const response = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/nodes`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(JSON.parse(data)));
      });
    });

    expect(Array.isArray(response)).toBe(true);
  });

  it('should handle rename request via IPC', async () => {
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

    // Simulate didFinishLaunching
    const launchListener = (api.on as jest.Mock).mock.calls.find(
      (call) => call[0] === 'didFinishLaunching',
    )[1];
    await launchListener();

    const portFile = path.join(storagePath, 'homebridge-zwave-usb.port');
    let retries = 0;
    while (!fs.existsSync(portFile) && retries < 10) {
      await new Promise((res) => setTimeout(res, 100));
      retries++;
    }
    const port = parseInt(fs.readFileSync(portFile, 'utf8'), 10);

    // Setup controller mock
    const controller = (platform as any).zwaveController;
    controller.setNodeName = jest.fn();

    // Make a POST request to rename node 2
    const postData = JSON.stringify({ name: 'New Node Name' });
    const response = await new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: '/nodes/2/name',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': postData.length,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(JSON.parse(data)));
        },
      );
      req.write(postData);
      req.end();
    });

    expect(response).toEqual({ success: true });
    expect(controller.setNodeName).toHaveBeenCalledWith(2, 'New Node Name');
  });
});
