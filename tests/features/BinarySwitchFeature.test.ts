import { API, HAP, PlatformConfig, Service, Characteristic } from 'homebridge';
import { ZWaveNode, ValueID, Endpoint } from 'zwave-js';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { BinarySwitchFeature } from '../../src/features/BinarySwitchFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('BinarySwitchFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: BinarySwitchFeature;
  let accessory: any;

  beforeEach(() => {
    hap = {
      Service: {
        Switch: jest.fn().mockReturnValue({
          getCharacteristic: jest.fn().mockReturnValue({
            on: jest.fn().mockReturnThis(),
            updateValue: jest.fn(),
          }),
        }),
      } as any,
      Characteristic: {
        On: jest.fn(),
      } as any,
      uuid: {
        generate: jest.fn().mockReturnValue('test-uuid'),
      },
    } as any;
    
    accessory = {
      getService: jest.fn(),
      getServiceById: jest.fn(),
      addService: jest.fn().mockReturnValue({
        getCharacteristic: jest.fn().mockReturnValue({
          on: jest.fn().mockReturnThis(),
          onGet: jest.fn().mockReturnThis(),
          onSet: jest.fn().mockReturnThis(),
          updateValue: jest.fn(),
        }),
        updateCharacteristic: jest.fn(),
      }),
    };

    api = {
      hap,
      registerPlatform: jest.fn(),
      registerPlatformAccessories: jest.fn(),
      on: jest.fn(), user: { storagePath: jest.fn().mockReturnValue("/tmp") },
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
      nodeId: 1,
      supportsCC: jest.fn().mockReturnValue(true),
      getValue: jest.fn().mockReturnValue(true),
      setValue: jest.fn().mockResolvedValue(undefined),
    } as any;

    endpoint = {
      index: 0,
      supportsCC: jest.fn().mockReturnValue(true),
      getValue: jest.fn().mockReturnValue(true),
      setValue: jest.fn().mockResolvedValue(undefined),
      node: node,
    } as any;
    
    // Fix: make sure node returns the endpoint if asked (though not strictly needed if we pass endpoint directly)
    (node as any).getAllEndpoints = jest.fn().mockReturnValue([endpoint]);

    feature = new BinarySwitchFeature(platform, accessory, endpoint);
  });

  it('should initialize service', () => {
    feature.init();
    // Since index is 0, subtype is "0". 
    // The BaseFeature.getService logic calls getServiceById if subType is present.
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.Switch, "0");
  });

  it('should update value', () => {
    feature.init();
    feature.update();
    expect(node.getValue).toHaveBeenCalledWith({
      commandClass: 37,
      property: 'currentValue',
      endpoint: 0,
    });
  });
});