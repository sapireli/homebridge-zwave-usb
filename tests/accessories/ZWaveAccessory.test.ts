import { ZWaveAccessory } from '../../src/accessories/ZWaveAccessory';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { IZWaveNode } from '../../src/zwave/interfaces';

describe('ZWaveAccessory', () => {
  let platform: any;
  let node: any;
  let accessory: ZWaveAccessory;
  let mockService: any;

  beforeEach(() => {
    mockService = {
      getCharacteristic: jest.fn().mockReturnThis(),
      setProps: jest.fn().mockReturnThis(),
      updateValue: jest.fn().mockReturnThis(),
      updateCharacteristic: jest.fn().mockReturnThis(),
      setCharacteristic: jest.fn().mockReturnThis(),
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      characteristics: [],
      displayName: 'Service Name',
      UUID: 'service-uuid'
    };

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
        platformAccessory: jest.fn().mockImplementation(() => ({
          getService: jest.fn().mockReturnValue(mockService),
          getServiceById: jest.fn().mockReturnValue(mockService),
          addService: jest.fn().mockReturnValue(mockService),
          removeService: jest.fn(),
          services: [mockService],
          displayName: 'Initial Name',
          UUID: 'test-uuid'
        })),
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

    accessory = new ZWaveAccessory(platform as unknown as ZWaveUsbPlatform, node as IZWaveNode, 12345);
  });

  it('should update accessory and service names when renamed', () => {
    const nameChar = mockService.getCharacteristic(platform.Characteristic.Name);

    accessory.rename('New Friendly Name');

    expect(accessory.platformAccessory.displayName).toBe('New Friendly Name');
    expect(mockService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.Name,
      'New Friendly Name'
    );
    expect(nameChar.setProps).toHaveBeenCalledWith(expect.objectContaining({
      perms: expect.arrayContaining(['ev']) // NOTIFY permission
    }));
    expect(platform.api.updatePlatformAccessories).toHaveBeenCalled();
  });
});
