import { BatteryFeature } from '../../src/features/BatteryFeature';
import { IZWaveNode } from '../../src/zwave/interfaces';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { PlatformAccessory } from 'homebridge';

describe('BatteryFeature', () => {
  let platform: jest.Mocked<ZWaveUsbPlatform>;
  let accessory: jest.Mocked<PlatformAccessory>;
  let node: jest.Mocked<IZWaveNode>;
  let endpoint: any;
  let batteryFeature: BatteryFeature;
  let batteryService: any;

  beforeEach(() => {
    batteryService = {
      getCharacteristic: jest.fn().mockReturnThis(),
      onGet: jest.fn().mockReturnThis(),
      updateCharacteristic: jest.fn().mockReturnThis(),
    };

    // Mock Service constructor
    const MockService = jest.fn().mockImplementation(() => batteryService);
    
    // Mock Characteristic as a string object with properties
    const StatusLowBattery = new String('StatusLowBattery') as any;
    StatusLowBattery.BATTERY_LEVEL_LOW = 1;
    StatusLowBattery.BATTERY_LEVEL_NORMAL = 0;

    platform = {
      Service: {
        Battery: MockService,
      },
      Characteristic: {
        BatteryLevel: 'BatteryLevel',
        StatusLowBattery: StatusLowBattery,
      },
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    } as any;

    accessory = {
      getService: jest.fn().mockReturnValue(undefined),
      addService: jest.fn().mockReturnValue(batteryService),
      getServiceById: jest.fn().mockReturnValue(undefined),
    } as any;

    node = {
      nodeId: 1,
      getValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;

    batteryFeature = new BatteryFeature(platform, accessory, endpoint);
  });

  test('should initialize with Battery service and characteristics', () => {
    batteryFeature.init();
    expect(accessory.addService).toHaveBeenCalled();
    expect(batteryService.getCharacteristic).toHaveBeenCalledWith('BatteryLevel');
    expect(batteryService.getCharacteristic).toHaveBeenCalledWith(expect.stringContaining('StatusLowBattery'));
  });

  test('should report battery level correctly', () => {
    node.getValue = jest.fn().mockReturnValue(85);
    batteryFeature.init();
    
    batteryFeature.update();
    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith('BatteryLevel', 85);
  });

  test('should report low battery status based on isLow property', () => {
    node.getValue = jest.fn().mockImplementation((id) => {
      if (id.property === 'isLow') return true;
      if (id.property === 'level') return 20;
      return null;
    });
    
    batteryFeature.init();
    batteryFeature.update();
    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(expect.stringContaining('StatusLowBattery'), 1);
  });

  test('should report low battery status based on level if isLow is missing', () => {
    node.getValue = jest.fn().mockImplementation((id) => {
      if (id.property === 'isLow') return undefined;
      if (id.property === 'level') return 10;
      return null;
    });
    
    batteryFeature.init();
    batteryFeature.update();
    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(expect.stringContaining('StatusLowBattery'), 1);
  });
});
