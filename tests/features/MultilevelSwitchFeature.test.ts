import { API, HAP, PlatformConfig, Service, CharacteristicValue } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { MultilevelSwitchFeature } from '../../src/features/MultilevelSwitchFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('MultilevelSwitchFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: MultilevelSwitchFeature;
  let accessory: any;
  let service: any;

  beforeEach(() => {
    service = {
      getCharacteristic: jest.fn().mockReturnValue({
        on: jest.fn().mockReturnThis(),
        onGet: jest.fn().mockReturnThis(),
        onSet: jest.fn().mockReturnThis(),
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
        Lightbulb: jest.fn(),
      } as any,
      Characteristic: {
        On: 'On',
        Brightness: 'Brightness',
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
      nodeId: 7,
      supportsCC: jest.fn(),
      getValue: jest.fn(),
      setValue: jest.fn().mockResolvedValue({ status: 255 }), // Mock successful setValue response
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;

    feature = new MultilevelSwitchFeature(platform, accessory, endpoint, node);
  });

  it('should initialize Lightbulb service', () => {
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.Lightbulb, '0');
  });

  it('should update On state (Value > 0)', () => {
    feature.init();
    node.getValue.mockReturnValue(50); // 50% brightness
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(platform.Characteristic.On, true);
  });

  it('should update Off state (Value = 0)', () => {
    feature.init();
    node.getValue.mockReturnValue(0);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(platform.Characteristic.On, false);
  });

  it('should update Brightness', () => {
    feature.init();
    node.getValue.mockReturnValue(75);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.Brightness,
      75,
    );
  });

  it('should set Target Value to 255 when turning On', async () => {
    feature.init();

    await (feature as any).handleSetOn(true);

    expect(node.setValue).toHaveBeenCalledWith(
      {
        commandClass: CommandClasses['Multilevel Switch'],
        property: 'targetValue',
        endpoint: 0,
      },
      255,
    );
  });

  it('should set Target Value to 0 when turning Off', async () => {
    feature.init();
    await (feature as any).handleSetOn(false);

    expect(node.setValue).toHaveBeenCalledWith(
      {
        commandClass: CommandClasses['Multilevel Switch'],
        property: 'targetValue',
        endpoint: 0,
      },
      0,
    );
  });
});
