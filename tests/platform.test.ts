import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveUsbPlatform } from '../src/platform/ZWaveUsbPlatform';
import { PLATFORM_NAME } from '../src/platform/settings';

describe('ZWaveUsbPlatform', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;

  beforeEach(() => {
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
      on: jest.fn(), user: { storagePath: jest.fn().mockReturnValue("/tmp") },
      user: {
        storagePath: jest.fn().mockReturnValue('/tmp'),
      },
    } as any;
  });

  afterEach(async () => {
    const shutdownListeners = (api.on as jest.Mock).mock.calls
      .filter(call => call[0] === 'shutdown')
      .map(call => call[1]);
    
    for (const listener of shutdownListeners) {
      await listener();
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
});
