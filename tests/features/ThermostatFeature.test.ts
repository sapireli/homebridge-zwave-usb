import { ThermostatFeature } from '../../src/features/ThermostatFeature';

describe('ThermostatFeature', () => {
  let feature: ThermostatFeature;
  let platform: any;
  let accessory: any;
  let service: any;
  let node: any;

  beforeEach(() => {
    const charMock = {
      onSet: jest.fn().mockReturnThis(),
      onGet: jest.fn().mockReturnThis(),
      updateValue: jest.fn().mockReturnThis(),
      setProps: jest.fn().mockReturnThis(),
      value: 0,
    };

    service = {
      getCharacteristic: jest.fn().mockReturnValue(charMock),
      updateCharacteristic: jest.fn(),
      testCharacteristic: jest.fn().mockReturnValue(true), updateCharacteristic: jest.fn().mockReturnThis(), setPrimaryService: jest.fn(),
      addOptionalCharacteristic: jest.fn(),
      UUID: 'Thermostat',
    };

    accessory = {
      displayName: 'Test Device',
      platformAccessory: {
        displayName: 'Test Device',
        getService: jest.fn().mockReturnValue(service),
        getServiceById: jest.fn().mockReturnValue(service),
        addService: jest.fn().mockReturnValue(service),
      },
      accessoryService: service,
    };

    platform = {
      Service: {
        Thermostat: 'Thermostat',
      },
      Characteristic: {
        CurrentHeatingCoolingState: {
          OFF: 0,
          HEAT: 1,
          COOL: 2,
          toString: () => 'CurrentHeatingCoolingState',
        },
        TargetHeatingCoolingState: {
          OFF: 0,
          HEAT: 1,
          COOL: 2,
          AUTO: 3,
          toString: () => 'TargetHeatingCoolingState',
        },
        CurrentTemperature: 'CurrentTemperature',
        TargetTemperature: 'TargetTemperature',
        TemperatureDisplayUnits: {
          CELSIUS: 0,
          FAHRENHEIT: 1,
          toString: () => 'TemperatureDisplayUnits',
        },
        HeatingThresholdTemperature: 'HeatingThresholdTemperature',
        CoolingThresholdTemperature: 'CoolingThresholdTemperature',
        StatusFault: 'StatusFault',
        Name: 'Name',
        ServiceLabelIndex: 'ServiceLabelIndex',
      },
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      },
      api: {
        hap: {
          HapStatusError: class extends Error {},
        },
      },
    };

    node = {
      id: 10,
      getValue: jest.fn(),
      setValue: jest.fn(),
      getValueMetadata: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(true),
    };

    const endpoint = { index: 0 };

    feature = new ThermostatFeature(platform, accessory.platformAccessory, endpoint, node);
    feature.init();
  });

  it('should initialize thermostat service', () => {
    // Because endpoint index is 0, subtype is '0', so it calls getServiceById
    expect(accessory.platformAccessory.getServiceById).toHaveBeenCalledWith('Thermostat', '0');
  });

  it('should update current temperature', () => {
    // CC 49 = Multilevel Sensor (Air Temperature)
    const event = {
      commandClass: 49,
      property: 'Air temperature',
      newValue: 72.5,
      endpoint: 0,
    };
    
    // Mock return values for update cycle
    node.getValue.mockImplementation((args: any) => {
      if (args.property === 'Air temperature') return 72.5;
      return 0; // Default for state/mode lookups
    });
    
    feature.update(event);
    expect(service.updateCharacteristic).toHaveBeenCalledWith('CurrentTemperature', 72.5);
  });

  it('should handle F to C conversion for current temperature', () => {
    const event = {
      commandClass: 49,
      property: 'Air temperature',
      newValue: 77, // 77F = 25C
      propertyKey: 2, // F scale
      endpoint: 0,
    };
    
    node.getValueMetadata.mockReturnValue({ unit: '°F' });
    node.getValue.mockReturnValue(77); // Mock return value for handleGetCurrentTemp

    feature.update(event);
    expect(service.updateCharacteristic).toHaveBeenCalledWith('CurrentTemperature', 25);
  });
});
