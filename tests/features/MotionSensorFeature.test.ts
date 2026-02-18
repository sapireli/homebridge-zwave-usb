import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
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
        setProps: jest.fn().mockReturnThis(),
      }),
      updateCharacteristic: jest.fn(),
      testCharacteristic: jest.fn().mockReturnValue(true), updateCharacteristic: jest.fn().mockReturnThis(), setPrimaryService: jest.fn(),
      addOptionalCharacteristic: jest.fn(),
      setCharacteristic: jest.fn().mockReturnThis(),
    };

    hap = {
      Service: {
        MotionSensor: jest.fn(),
      } as any,
      Characteristic: {
        MotionDetected: 'MotionDetected',
        Name: 'Name',
        ConfiguredName: 'ConfiguredName',
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
      on: jest.fn(),
      user: { storagePath: jest.fn().mockReturnValue('/tmp') },
      user: {
        storagePath: jest.fn().mockReturnValue('/tmp'),
      },
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
      nodeId: 5,
      supportsCC: jest.fn(),
      getValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;

    feature = new MotionSensorFeature(platform, accessory, endpoint, node);
  });

  it('should initialize MotionSensor service', () => {
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.MotionSensor, '0');
  });

  it('should detect motion via Notification CC (Home Security - 8)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === CommandClasses.Notification);
    node.getValue.mockReturnValue(8);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.MotionDetected,
      true,
    );
    expect(node.getValue).toHaveBeenCalledWith({
      commandClass: CommandClasses.Notification,
      property: 'Home Security',
      propertyKey: 'Motion sensor status',
      endpoint: 0,
    });
  });

  it('should detect NO motion via Notification CC', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === CommandClasses.Notification);
    node.getValue.mockReturnValue(0);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.MotionDetected,
      false,
    );
  });

  it('should fallback to Binary Sensor CC (48) - True (Motion)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === CommandClasses['Binary Sensor']);
    node.getValue.mockReturnValue(true);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.MotionDetected,
      true,
    );
    expect(node.getValue).toHaveBeenCalledWith({
      commandClass: CommandClasses['Binary Sensor'],
      property: 'Motion',
      endpoint: 0,
    });
  });
});
