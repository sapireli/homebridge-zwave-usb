import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { MotionSensorFeature } from '../../src/features/MotionSensorFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('MotionSensorFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: MotionSensorFeature;
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
        MotionSensor: jest.fn(),
      } as any,
      Characteristic: {
        MotionDetected: 'MotionDetected',
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
      nodeId: 3,
      supportsCC: jest.fn(),
      getValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;
    
    feature = new MotionSensorFeature(platform, accessory, endpoint);
  });

  it('should initialize MotionSensor service', () => {
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.MotionSensor, '0');
  });

  it('should detect motion via Notification CC (Home Security - 8)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 113);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 113 && args.propertyKey === 'Motion sensor status') {
            return 8; // Motion
        }
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(platform.Characteristic.MotionDetected, true);
  });

  it('should detect NO motion via Notification CC', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 113);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 113 && args.propertyKey === 'Motion sensor status') {
            return 0; // Idle
        }
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(platform.Characteristic.MotionDetected, false);
  });

  it('should fallback to Binary Sensor CC (48) - True (Motion)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 48);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 48) return true;
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(platform.Characteristic.MotionDetected, true);
  });
});
