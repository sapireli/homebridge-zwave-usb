import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { LeakSensorFeature } from '../../src/features/LeakSensorFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('LeakSensorFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: LeakSensorFeature;
  let accessory: any;
  let service: any;

  beforeEach(() => {
    service = {
      getCharacteristic: jest.fn().mockReturnValue({
        on: jest.fn().mockReturnThis(),
        onGet: jest.fn().mockReturnThis(),
        updateValue: jest.fn(),
      }),
      updateCharacteristic: jest.fn(),
    };

    hap = {
      Service: {
        LeakSensor: jest.fn(),
      } as any,
      Characteristic: {
        LeakDetected: {
            LEAK_DETECTED: 1,
            LEAK_NOT_DETECTED: 0,
        },
      } as any,
      uuid: {
        generate: jest.fn().mockReturnValue('test-uuid'),
      },
    } as any;
    
    accessory = {
      getService: jest.fn(),
      getServiceById: jest.fn(),
      addService: jest.fn().mockReturnValue(service),
    };

    api = {
      hap,
      registerPlatform: jest.fn(),
      registerPlatformAccessories: jest.fn(),
      on: jest.fn(), user: { storagePath: jest.fn().mockReturnValue("/tmp") },
      platformAccessory: jest.fn().mockImplementation(() => accessory),
    } as any;

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

    platform = new ZWaveUsbPlatform(log, config, api);

    node = {
      nodeId: 4,
      supportsCC: jest.fn(),
      getValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;
    
    feature = new LeakSensorFeature(platform, accessory, endpoint);
  });

  it('should initialize LeakSensor service', () => {
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.LeakSensor, '0');
  });

  it('should detect leak via Notification CC (Water Alarm - 2)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 113);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 113 && args.propertyKey === 'Water leak status') {
            return 2; // Leak
        }
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.LeakDetected,
        platform.Characteristic.LeakDetected.LEAK_DETECTED
    );
  });

  it('should detect NO leak via Notification CC', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 113);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 113) {
            return 0; // Idle
        }
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.LeakDetected,
        platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED
    );
  });

  it('should fallback to Binary Sensor CC (48) - True (Leak)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 48);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 48) return true;
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.LeakDetected,
        platform.Characteristic.LeakDetected.LEAK_DETECTED
    );
  });
});
