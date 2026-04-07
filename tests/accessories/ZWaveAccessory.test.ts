import { ZWaveAccessory } from '../../src/accessories/ZWaveAccessory';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { IZWaveNode } from '../../src/zwave/interfaces';

describe('ZWaveAccessory', () => {
  let platform: any;
  let node: any;
  let accessory: ZWaveAccessory;
  let mockService: any;
  let platformAccessoryFactory: jest.Mock;

  beforeEach(() => {
    mockService = {
      getCharacteristic: jest.fn().mockReturnValue({
        value: '',
        updateValue: jest.fn(),
        onSet: jest.fn(),
        setProps: jest.fn().mockReturnThis(),
        props: { perms: ['pr', 'pw', 'ev'] },
      }),
      removeCharacteristic: jest.fn(),
      setProps: jest.fn().mockReturnThis(),
      updateValue: jest.fn().mockReturnThis(),
      updateCharacteristic: jest.fn().mockReturnThis(),
      setCharacteristic: jest.fn().mockReturnThis(),
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      setPrimaryService: jest.fn(),
      characteristics: [],
      displayName: 'Service Name',
      UUID: 'service-uuid',
    };

    platformAccessoryFactory = jest.fn().mockImplementation(() => ({
      getService: jest.fn().mockReturnValue(mockService),
      getServiceById: jest.fn().mockReturnValue(mockService),
      addService: jest.fn().mockReturnValue(mockService),
      removeService: jest.fn(),
      services: [mockService],
      displayName: 'Initial Name',
      UUID: 'test-uuid',
      context: {},
    }));

    platform = {
      log: {
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
      },
      api: {
        hap: {
          uuid: {
            generate: jest.fn().mockReturnValue('test-uuid'),
          },
        },
        platformAccessory: platformAccessoryFactory,
        updatePlatformAccessories: jest.fn(),
        registerPlatformAccessories: jest.fn(),
      },
      Service: {
        AccessoryInformation: '0000003E-0000-1000-8000-0026BB765291',
      },
      Characteristic: {
        Manufacturer: '00000020-0000-1000-8000-0026BB765291',
        Model: '00000021-0000-1000-8000-0026BB765291',
        SerialNumber: '00000030-0000-1000-8000-0026BB765291',
        Name: '00000023-0000-1000-8000-0026BB765291',
        ConfiguredName: '000000E3-0000-1000-8000-0026BB765291',
        FirmwareRevision: '00000052-0000-1000-8000-0026BB765291',
        ServiceLabelIndex: 'ServiceLabelIndex',
        StatusTampered: {
          NOT_TAMPERED: 0,
          TAMPERED: 1,
        },
        StatusFault: {
          GENERAL_FAULT: 1,
          NO_FAULT: 0,
        },
      },
      accessories: [],
    };

    node = {
      nodeId: 2,
      deviceConfig: {
        manufacturer: 'Test Man',
        label: 'Test Model',
      },
      status: 4, // Alive
      ready: true,
      supportsCC: jest.fn().mockReturnValue(false),
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getValueMetadata: jest.fn(),
      getValue: jest.fn(),
    };

    accessory = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );
  });

  it('should update accessory and service names when renamed', () => {
    accessory.rename('New Friendly Name');

    expect(accessory.platformAccessory.displayName).toBe('New Friendly Name');
    expect(mockService.setCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.Name,
      'New Friendly Name',
    );
    expect(platform.api.updatePlatformAccessories).not.toHaveBeenCalled();
  });

  it('should preserve cached HomeKit names on existing accessories', () => {
    const cachedAccessory = {
      getService: jest.fn().mockReturnValue(mockService),
      getServiceById: jest.fn().mockReturnValue(mockService),
      addService: jest.fn().mockReturnValue(mockService),
      removeService: jest.fn(),
      services: [mockService],
      displayName: 'HomeKit Custom Name',
      UUID: 'test-uuid',
      context: { nodeId: 2, homeId: 12345 },
    };
    platform.accessories = [cachedAccessory];
    mockService.setCharacteristic.mockClear();

    const existing = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );

    expect(existing.platformAccessory).toBe(cachedAccessory);
    expect(existing.platformAccessory.displayName).toBe('HomeKit Custom Name');
    expect(mockService.setCharacteristic).not.toHaveBeenCalledWith(
      platform.Characteristic.Name,
      expect.any(String),
    );
  });

  it('should advertise a bumped firmware revision to force HomeKit metadata refresh', () => {
    expect(mockService.setCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.FirmwareRevision,
      '1.0.0-hkmeta2',
    );
  });

  it('should create a new accessory UUID when forced for explicit rename recreation', () => {
    platform.accessories = [];
    platform.api.hap.uuid.generate = jest
      .fn()
      .mockImplementation((value: string) => `uuid:${value}`);

    const recreated = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
      { forceUuidSeed: 'rename-1' },
    );

    expect(platformAccessoryFactory).toHaveBeenLastCalledWith(
      'Test Model',
      'uuid:homebridge-zwave-usb-12345-2-rename-rename-1',
    );
    expect(recreated.platformAccessory.context.renameGeneration).toBe('rename-1');
  });

  it('should prune unsupported cached ConfiguredName from functional services', () => {
    const configuredNameChar = { UUID: platform.Characteristic.ConfiguredName };
    const cachedSwitchService = {
      ...mockService,
      UUID: '00000049-0000-1000-8000-0026BB765291',
      testCharacteristic: jest.fn().mockImplementation(
        (char) => char === platform.Characteristic.ConfiguredName,
      ),
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.ConfiguredName) {
          return configuredNameChar;
        }
        return mockService.getCharacteristic();
      }),
      removeCharacteristic: jest.fn(),
    };

    const cachedAccessory = {
      getService: jest
        .fn()
        .mockImplementation((serviceType: string) =>
          serviceType === platform.Service.AccessoryInformation ? mockService : undefined,
        ),
      getServiceById: jest.fn().mockReturnValue(cachedSwitchService),
      addService: jest.fn().mockReturnValue(cachedSwitchService),
      removeService: jest.fn(),
      services: [mockService, cachedSwitchService],
      displayName: 'HomeKit Custom Name',
      UUID: 'test-uuid',
      context: { nodeId: 2, homeId: 12345 },
    };
    platform.accessories = [cachedAccessory];

    accessory = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );

    expect(cachedSwitchService.removeCharacteristic).toHaveBeenCalledWith(configuredNameChar);
  });

  it('should prune unsupported cached health characteristics from actuator services', () => {
    const statusFaultChar = { UUID: 'StatusFault' };
    const statusTamperedChar = { UUID: 'StatusTampered' };
    const cachedSwitchService = {
      ...mockService,
      UUID: '00000049-0000-1000-8000-0026BB765291',
      testCharacteristic: jest.fn().mockImplementation(
        (char) =>
          char === platform.Characteristic.StatusFault ||
          char === platform.Characteristic.StatusTampered,
      ),
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.StatusFault) {
          return statusFaultChar;
        }
        if (char === platform.Characteristic.StatusTampered) {
          return statusTamperedChar;
        }
        return mockService.getCharacteristic();
      }),
      removeCharacteristic: jest.fn(),
    };

    const cachedAccessory = {
      getService: jest
        .fn()
        .mockImplementation((serviceType: string) =>
          serviceType === platform.Service.AccessoryInformation ? mockService : undefined,
        ),
      getServiceById: jest.fn().mockReturnValue(cachedSwitchService),
      addService: jest.fn().mockReturnValue(cachedSwitchService),
      removeService: jest.fn(),
      services: [mockService, cachedSwitchService],
      displayName: 'HomeKit Custom Name',
      UUID: 'test-uuid',
      context: { nodeId: 2, homeId: 12345 },
    };
    platform.accessories = [cachedAccessory];

    accessory = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );

    expect(cachedSwitchService.removeCharacteristic).toHaveBeenCalledWith(statusFaultChar);
    expect(cachedSwitchService.removeCharacteristic).toHaveBeenCalledWith(statusTamperedChar);
  });

  it('should prune unsupported cached ServiceLabelIndex from actuator services', () => {
    const serviceLabelIndexChar = { UUID: 'ServiceLabelIndex' };
    const cachedSwitchService = {
      ...mockService,
      UUID: '00000049-0000-1000-8000-0026BB765291',
      testCharacteristic: jest.fn().mockImplementation(
        (char) => char === platform.Characteristic.ServiceLabelIndex,
      ),
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.ServiceLabelIndex) {
          return serviceLabelIndexChar;
        }
        return mockService.getCharacteristic();
      }),
      removeCharacteristic: jest.fn(),
    };

    const cachedAccessory = {
      getService: jest
        .fn()
        .mockImplementation((serviceType: string) =>
          serviceType === platform.Service.AccessoryInformation ? mockService : undefined,
        ),
      getServiceById: jest.fn().mockReturnValue(cachedSwitchService),
      addService: jest.fn().mockReturnValue(cachedSwitchService),
      removeService: jest.fn(),
      services: [mockService, cachedSwitchService],
      displayName: 'HomeKit Custom Name',
      UUID: 'test-uuid',
      context: { nodeId: 2, homeId: 12345 },
    };
    platform.accessories = [cachedAccessory];

    accessory = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );

    expect(cachedSwitchService.removeCharacteristic).toHaveBeenCalledWith(serviceLabelIndexChar);
  });

  it('should update StatusTampered from Home Security tamper notifications on sensor services', () => {
    const sensorService = {
      ...mockService,
      subtype: '0',
      testCharacteristic: jest.fn().mockImplementation(
        (char) =>
          char === platform.Characteristic.StatusFault || char === platform.Characteristic.StatusTampered,
      ),
      updateCharacteristic: jest.fn().mockReturnThis(),
    };

    accessory.platformAccessory.services = [mockService, sensorService];
    node.supportsCC = jest.fn().mockImplementation((cc) => cc === 113);
    node.getDefinedValueIDs = jest.fn().mockReturnValue([
      {
        commandClass: 113,
        endpoint: 0,
        property: 'Home Security',
        propertyKey: 'Cover status',
      },
    ]);
    node.getValueMetadata = jest.fn().mockReturnValue({
      states: {
        '0': 'idle',
        '3': 'Tampering, product cover removed',
      },
    });
    node.getValue = jest.fn().mockReturnValue(3);

    accessory.refresh();

    expect(sensorService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusTampered,
      platform.Characteristic.StatusTampered.TAMPERED,
    );
  });

  it('should update StatusTampered from Binary Sensor tamper values', () => {
    const sensorService = {
      ...mockService,
      subtype: '2',
      testCharacteristic: jest.fn().mockImplementation(
        (char) =>
          char === platform.Characteristic.StatusFault || char === platform.Characteristic.StatusTampered,
      ),
      updateCharacteristic: jest.fn().mockReturnThis(),
    };

    accessory.platformAccessory.services = [mockService, sensorService];
    node.supportsCC = jest.fn().mockImplementation((cc) => cc === 48);
    node.getValue = jest.fn().mockImplementation((valueId) => {
      if (valueId.commandClass === 48 && valueId.property === 'Tamper' && valueId.endpoint === 2) {
        return true;
      }
      return undefined;
    });

    accessory.refresh();

    expect(sensorService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusTampered,
      platform.Characteristic.StatusTampered.TAMPERED,
    );
  });
});
