import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { CarbonMonoxideSensorFeature } from '../../src/features/CarbonMonoxideSensorFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('CarbonMonoxideSensorFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: CarbonMonoxideSensorFeature;
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
        CarbonMonoxideSensor: jest.fn(),
      } as any,
      Characteristic: {
        CarbonMonoxideDetected: {
            CO_LEVELS_NORMAL: 0,
            CO_LEVELS_ABNORMAL: 1,
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
      nodeId: 9,
      supportsCC: jest.fn(),
      getValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;
    
    feature = new CarbonMonoxideSensorFeature(platform, accessory, endpoint);
  });

  it('should initialize CarbonMonoxideSensor service', () => {
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.CarbonMonoxideSensor, '0');
  });

  it('should detect CO via Notification CC (CO Alarm - 1)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 113);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 113 && args.property === 'Carbon Monoxide Alarm') {
            return 1; // CO detected
        }
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.CarbonMonoxideDetected,
        platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
    );
  });

  it('should fallback to Binary Sensor CC (48) - True (CO)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 48);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 48 && args.property === 'CO') return true;
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.CarbonMonoxideDetected,
        platform.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
    );
  });
});
