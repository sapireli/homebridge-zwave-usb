import { ZWaveAccessory } from '../../src/accessories/ZWaveAccessory';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { IZWaveNode } from '../../src/zwave/interfaces';
import { ZWaveFeature } from '../../src/features/ZWaveFeature';

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

  it('should remove ConfiguredName from functional services during initialization', () => {
    const configuredNameChar = { UUID: platform.Characteristic.ConfiguredName };
    const featureService = {
      ...mockService,
      testCharacteristic: jest.fn().mockImplementation((char) => char === platform.Characteristic.ConfiguredName),
      getCharacteristic: jest.fn().mockReturnValue(configuredNameChar),
      removeCharacteristic: jest.fn(),
      displayName: 'Node Switch',
    };
    const feature: ZWaveFeature = {
      init: jest.fn(),
      update: jest.fn(),
      getServices: jest.fn().mockReturnValue([featureService]),
      getEndpointIndex: jest.fn().mockReturnValue(0),
      stop: jest.fn(),
      updateNode: jest.fn(),
      rename: jest.fn(),
    };

    accessory.addFeature(feature);
    accessory.platformAccessory.services.push(featureService);
    accessory.initialize();

    expect(featureService.removeCharacteristic).toHaveBeenCalledWith(configuredNameChar);
    expect(featureService.addOptionalCharacteristic).not.toHaveBeenCalledWith(
      platform.Characteristic.ConfiguredName,
    );
  });
});
