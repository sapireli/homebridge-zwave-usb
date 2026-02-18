import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { ContactSensorFeature } from '../../src/features/ContactSensorFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('ContactSensorFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: ContactSensorFeature;
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
        ContactSensor: jest.fn(),
      } as any,
      Characteristic: {
        ContactSensorState: {
          CONTACT_DETECTED: 0,
          CONTACT_NOT_DETECTED: 1,
        },
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
      nodeId: 2,
      supportsCC: jest.fn(),
      getValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;

    feature = new ContactSensorFeature(platform, accessory, endpoint, node);
  });

  it('should initialize ContactSensor service', () => {
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.ContactSensor, '0');
  });

  it('should read Notification CC (Access Control) - Closed (23)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === CommandClasses.Notification);
    node.getValue.mockReturnValue(23);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.ContactSensorState,
      platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    expect(node.getValue).toHaveBeenCalledWith({
      commandClass: CommandClasses.Notification,
      property: 'Access Control',
      propertyKey: 'Door status',
      endpoint: 0,
    });
  });

  it('should read Notification CC (Access Control) - Open (22)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === CommandClasses.Notification);
    node.getValue.mockReturnValue(22);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.ContactSensorState,
      platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
  });

  it('should fallback to Binary Sensor CC (48) - True (Open)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === CommandClasses['Binary Sensor']);
    node.getValue.mockReturnValue(true);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.ContactSensorState,
      platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    expect(node.getValue).toHaveBeenCalledWith({
      commandClass: CommandClasses['Binary Sensor'],
      property: 'Door/Window',
      endpoint: 0,
    });
  });

  it('should fallback to Binary Sensor CC (48) - False (Closed)', () => {
    feature.init();
    node.supportsCC.mockImplementation((cc) => cc === CommandClasses['Binary Sensor']);
    node.getValue.mockReturnValue(false);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.ContactSensorState,
      platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
  });
});
