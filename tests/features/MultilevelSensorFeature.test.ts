import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { MultilevelSensorFeature } from '../../src/features/MultilevelSensorFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('MultilevelSensorFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: MultilevelSensorFeature;
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
        TemperatureSensor: jest.fn(),
        HumiditySensor: jest.fn(),
        LightSensor: jest.fn(),
      } as any,
      Characteristic: {
        CurrentTemperature: 'CurrentTemperature',
        CurrentRelativeHumidity: 'CurrentRelativeHumidity',
        CurrentAmbientLightLevel: 'CurrentAmbientLightLevel',
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
      nodeId: 6,
      getDefinedValueIDs: jest.fn(),
      getValue: jest.fn(),
      getValueMetadata: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;
    
    feature = new MultilevelSensorFeature(platform, accessory, endpoint);
  });

  afterEach(async () => {
    // Trigger shutdown to clean up any listeners/handles
    const shutdownListeners = (api.on as jest.Mock).mock.calls
      .filter(call => call[0] === 'shutdown')
      .map(call => call[1]);
    
    for (const listener of shutdownListeners) {
      await listener();
    }
  });

  it('should initialize Temperature Sensor', () => {
    node.getDefinedValueIDs.mockReturnValue([
        { commandClass: 49, property: 'Air temperature', endpoint: 0 }
    ] as any);
    
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.TemperatureSensor, '0');
  });

  it('should convert Fahrenheit to Celsius', () => {
    node.getDefinedValueIDs.mockReturnValue([
        { commandClass: 49, property: 'Air temperature', endpoint: 0 }
    ] as any);
    
    feature.init();
    
    node.getValue.mockReturnValue(72);
    node.getValueMetadata.mockReturnValue({ unit: '°F' } as any);

    feature.update();
    
    // (72 - 32) * 5/9 = 22.222...
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.CurrentTemperature,
        expect.closeTo(22.22, 2)
    );
  });

  it('should pass Celsius through', () => {
    node.getDefinedValueIDs.mockReturnValue([
        { commandClass: 49, property: 'Air temperature', endpoint: 0 }
    ] as any);
    
    feature.init();
    
    node.getValue.mockReturnValue(25);
    node.getValueMetadata.mockReturnValue({ unit: '°C' } as any);

    feature.update();
    
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.CurrentTemperature,
        25
    );
  });

  it('should initialize Humidity Sensor', () => {
    node.getDefinedValueIDs.mockReturnValue([
        { commandClass: 49, property: 'Humidity', endpoint: 0 }
    ] as any);
    
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.HumiditySensor, '0');
  });

  it('should update Humidity', () => {
     node.getDefinedValueIDs.mockReturnValue([
        { commandClass: 49, property: 'Humidity', endpoint: 0 }
    ] as any);
    
    feature.init();
    node.getValue.mockReturnValue(45); // 45%
    
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.CurrentRelativeHumidity,
        45
    );
  });
});
