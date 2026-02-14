import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { BatteryFeature } from '../../src/features/BatteryFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('BatteryFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: BatteryFeature;
  let batteryService: any;

  beforeEach(() => {
    batteryService = {
      getCharacteristic: jest.fn().mockReturnValue({
        on: jest.fn().mockReturnThis(),
        onGet: jest.fn().mockReturnThis(),
        updateValue: jest.fn(),
        setProps: jest.fn().mockReturnThis(),
      }),
      updateCharacteristic: jest.fn(),
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      setCharacteristic: jest.fn().mockReturnThis(),
    };

    hap = {
      Service: {
        Battery: jest.fn(),
      } as any,
      Characteristic: {
        BatteryLevel: 'BatteryLevel',
        StatusLowBattery: {
          BATTERY_LEVEL_NORMAL: 0,
          BATTERY_LEVEL_LOW: 1,
        },
        Name: 'Name',
        ConfiguredName: 'ConfiguredName',
      } as any,
      uuid: {
        generate: jest.fn().mockReturnValue('test-uuid'),
      },
    } as any;

    api = {
      hap,
      registerPlatform: jest.fn(),
      registerPlatformAccessories: jest.fn(),
      on: jest.fn(),
      user: { storagePath: jest.fn().mockReturnValue('/tmp') },
      user: {
        storagePath: jest.fn().mockReturnValue('/tmp'),
      },
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
      nodeId: 1,
      getValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;

    const accessory = {
      getService: jest.fn(),
      getServiceById: jest.fn(),
      addService: jest.fn().mockReturnValue(batteryService),
    } as any;

    feature = new BatteryFeature(platform, accessory, endpoint, node);
  });

  it('should report battery level correctly', () => {
    feature.init();
    node.getValue.mockReturnValue(85);
    feature.update();
    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.BatteryLevel,
      85,
    );
    expect(node.getValue).toHaveBeenCalledWith({
      commandClass: CommandClasses.Battery,
      property: 'level',
      endpoint: 0,
    });
  });

  it('should report low battery status based on isLow property', () => {
    feature.init();
    node.getValue.mockImplementation((vid) => {
      if (vid.property === 'isLow') return true;
      if (vid.property === 'level') return 10;
      return undefined;
    });
    feature.update();
    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
  });

  it('should report low battery status based on level if isLow is missing', () => {
    feature.init();
    node.getValue.mockImplementation((vid) => {
      if (vid.property === 'isLow') return undefined;
      if (vid.property === 'level') return 5;
      return undefined;
    });
    feature.update();
    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
  });
});
