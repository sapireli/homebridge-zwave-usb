import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { SmokeSensorFeature } from '../../src/features/SmokeSensorFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('SmokeSensorFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: SmokeSensorFeature;
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
        SmokeSensor: jest.fn(),
      } as any,
      Characteristic: {
        SmokeDetected: {
            SMOKE_DETECTED: 1,
            SMOKE_NOT_DETECTED: 0,
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
      nodeId: 8,
      supportsCC: jest.fn(),
      getValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;
    
    feature = new SmokeSensorFeature(platform, accessory, endpoint);
  });

  it('should initialize SmokeSensor service', () => {
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.SmokeSensor, '0');
  });

  it('should detect smoke via Notification CC (Smoke Alarm - 1)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 113);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 113 && args.property === 'Smoke Alarm') {
            return 1; // Smoke detected
        }
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.SmokeDetected,
        platform.Characteristic.SmokeDetected.SMOKE_DETECTED
    );
  });

  it('should fallback to Binary Sensor CC (48) - True (Smoke)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === 48);
    node.getValue.mockImplementation((args) => {
        if (args.commandClass === 48 && args.property === 'Smoke') return true;
        return undefined;
    });

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.SmokeDetected,
        platform.Characteristic.SmokeDetected.SMOKE_DETECTED
    );
  });
});
