import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
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
        setProps: jest.fn().mockReturnThis(),
      }),
      updateCharacteristic: jest.fn(),
      testCharacteristic: jest.fn().mockReturnValue(true), updateCharacteristic: jest.fn().mockReturnThis(), setPrimaryService: jest.fn(),
      addOptionalCharacteristic: jest.fn(),
      setCharacteristic: jest.fn().mockReturnThis(),
    };

    hap = {
      Service: {
        TemperatureSensor: jest.fn(),
        HumiditySensor: jest.fn(),
        LightSensor: jest.fn(),
        AirQualitySensor: jest.fn(),
        CarbonDioxideSensor: jest.fn(),
      } as any,
      Characteristic: {
        CurrentTemperature: 'CurrentTemperature',
        CurrentRelativeHumidity: 'CurrentRelativeHumidity',
        CurrentAmbientLightLevel: 'CurrentAmbientLightLevel',
        AirQuality: {
          UNKNOWN: 0,
          EXCELLENT: 1,
          POOR: 5,
        },
        CarbonDioxideLevel: 'CarbonDioxideLevel',
        CarbonDioxideDetected: {
          CO2_LEVELS_NORMAL: 0,
          CO2_LEVELS_ABNORMAL: 1,
        },
        VOCDensity: 'VOCDensity',
        PM2_5Density: 'PM2_5Density',
        Name: 'Name',
        ConfiguredName: 'ConfiguredName',
        ServiceLabelIndex: 'ServiceLabelIndex',
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
      nodeId: 6,
      supportsCC: jest.fn(),
      getValue: jest.fn(),
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getValueMetadata: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;

    feature = new MultilevelSensorFeature(platform, accessory, endpoint, node);
  });

  it('should initialize Temperature Sensor', () => {
    node.getDefinedValueIDs.mockReturnValue([
      {
        commandClass: CommandClasses['Multilevel Sensor'],
        property: 'Air temperature',
        endpoint: 0,
      },
    ]);
    feature.init();
    expect(accessory.getService).toHaveBeenCalledWith(platform.Service.TemperatureSensor);
  });

  it('should convert Fahrenheit to Celsius', () => {
    node.getDefinedValueIDs.mockReturnValue([
      {
        commandClass: CommandClasses['Multilevel Sensor'],
        property: 'Air temperature',
        endpoint: 0,
      },
    ]);
    node.getValueMetadata.mockReturnValue({ unit: '°F' });
    node.getValue.mockReturnValue(68); // 68F = 20C

    feature.init();
    feature.update();

    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.CurrentTemperature,
      20,
    );
    expect(node.getValue).toHaveBeenCalledWith({
      commandClass: CommandClasses['Multilevel Sensor'],
      property: 'Air temperature',
      endpoint: 0,
    });
  });

  it('should pass Celsius through', () => {
    node.getDefinedValueIDs.mockReturnValue([
      {
        commandClass: CommandClasses['Multilevel Sensor'],
        property: 'Air temperature',
        endpoint: 0,
      },
    ]);
    node.getValueMetadata.mockReturnValue({ unit: '°C' });
    node.getValue.mockReturnValue(22);

    feature.init();
    feature.update();

    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.CurrentTemperature,
      22,
    );
  });

  it('should initialize Humidity Sensor', () => {
    node.getDefinedValueIDs.mockReturnValue([
      {
        commandClass: CommandClasses['Multilevel Sensor'],
        property: 'Humidity',
        endpoint: 0,
      },
    ]);
    feature.init();
    expect(accessory.getService).toHaveBeenCalledWith(platform.Service.HumiditySensor);
  });

  it('should update Humidity', () => {
    node.getDefinedValueIDs.mockReturnValue([
      {
        commandClass: CommandClasses['Multilevel Sensor'],
        property: 'Humidity',
        endpoint: 0,
      },
    ]);
    node.getValue.mockReturnValue(45);

    feature.init();
    feature.update();

    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.CurrentRelativeHumidity,
      45,
    );
  });

  it('should return UNKNOWN air quality when data is missing but the node is alive and sleeping', () => {
    node.getValue.mockReturnValue(undefined);
    node.ready = false as any;
    node.status = 1 as any;
    const value = (feature as any).handleGetAirQuality();
    expect(value).toBe(platform.Characteristic.AirQuality.UNKNOWN);
  });

  it('should initialize Carbon Dioxide Sensor when CO2 data is available', () => {
    node.getDefinedValueIDs.mockReturnValue([
      {
        commandClass: CommandClasses['Multilevel Sensor'],
        property: 'Carbon dioxide (CO2) level',
        endpoint: 0,
      },
    ]);

    feature.init();

    expect(accessory.getService).toHaveBeenCalledWith(platform.Service.CarbonDioxideSensor);
  });

  it('should map intermediate and poor air quality thresholds correctly', () => {
    node.getValue.mockImplementation((args) => {
      if (args.commandClass === CommandClasses['Binary Sensor'] && args.property === 'CO2') {
        return undefined;
      }
      if (args.property === 'Carbon dioxide (CO2) level') {
        return 820;
      }
      if (args.property === 'Particulate Matter 2.5') {
        return 24;
      }
      if (args.property === 'Volatile Organic Compound level') {
        return 1200;
      }
      return undefined;
    });

    expect((feature as any).handleGetAirQuality()).toBe(platform.Characteristic.AirQuality.FAIR);

    node.getValue.mockImplementation((args) => {
      if (args.commandClass === CommandClasses['Binary Sensor'] && args.property === 'CO2') {
        return undefined;
      }
      if (args.property === 'Carbon dioxide (CO2) level') {
        return 1600;
      }
      if (args.property === 'Particulate Matter 2.5') {
        return 60;
      }
      if (args.property === 'Volatile Organic Compound level') {
        return 9000;
      }
      return undefined;
    });

    expect((feature as any).handleGetAirQuality()).toBe(platform.Characteristic.AirQuality.POOR);
  });
});
