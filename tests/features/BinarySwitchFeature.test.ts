import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
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
            setProps: jest.fn().mockReturnThis(),
          }),
          testCharacteristic: jest.fn().mockReturnValue(true), updateCharacteristic: jest.fn().mockReturnThis(), setPrimaryService: jest.fn(),
          addOptionalCharacteristic: jest.fn(),
          setCharacteristic: jest.fn().mockReturnThis(),
          setPrimaryService: jest.fn(),
        }),
      } as any,
      Characteristic: {
        On: jest.fn(),
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
      addService: jest.fn().mockImplementation((service) => {
        if (typeof service === 'function') {
          // Handle constructor case if needed
          return {
            getCharacteristic: jest.fn().mockReturnValue({
              on: jest.fn().mockReturnThis(),
              onGet: jest.fn().mockReturnThis(),
              onSet: jest.fn().mockReturnThis(),
              updateValue: jest.fn(),
              setProps: jest.fn().mockReturnThis(),
            }),
            testCharacteristic: jest.fn().mockReturnValue(true), updateCharacteristic: jest.fn().mockReturnThis(), setPrimaryService: jest.fn(),
            addOptionalCharacteristic: jest.fn(),
            setCharacteristic: jest.fn().mockReturnThis(),
            updateCharacteristic: jest.fn().mockReturnThis(),
            setPrimaryService: jest.fn(),
          };
        }
        // Handle instance case
        service.setCharacteristic = jest.fn().mockReturnThis();
        service.getCharacteristic = jest.fn().mockReturnValue({
          on: jest.fn().mockReturnThis(),
          onGet: jest.fn().mockReturnThis(),
          onSet: jest.fn().mockReturnThis(),
          updateValue: jest.fn(),
          setProps: jest.fn().mockReturnThis(),
        });
        service.testCharacteristic = jest.fn().mockReturnValue(true);
        service.addOptionalCharacteristic = jest.fn();
        service.updateCharacteristic = jest.fn().mockReturnThis();
        return service;
      }),
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

    feature = new BinarySwitchFeature(platform, accessory, endpoint, node);
  });

  it('should initialize service', () => {
    feature.init();
    // Since index is 0, subtype is "0".
    // The BaseFeature.getService logic calls getServiceById if subType is present.
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.Switch, '0');
  });

  it('should update value', () => {
    feature.init();
    feature.update();
    expect(node.getValue).toHaveBeenCalledWith({
      commandClass: CommandClasses['Binary Switch'],
      property: 'currentValue',
      endpoint: 0,
    });
  });

  it('should ignore update if args command class does not match', () => {
    feature.init();
    // Access the service created in init
    // Since 'service' is private, and our mock returns the service object which is also 'accessory.addService' return value.
    // We can spy on the mock service returned by addService.
    const service = accessory.addService.mock.results[0].value;

    // updateCharacteristic is called during init (for Name and ConfiguredName)
    // Clear the mock so we can check for new calls
    service.updateCharacteristic.mockClear();

    // 1. Irrelevant Update
    feature.update({
      commandClass: CommandClasses.Battery, // Not Binary Switch
      endpoint: 0,
      property: 'level',
    });

    expect(service.updateCharacteristic).not.toHaveBeenCalled();

    // 2. Relevant Update
    feature.update({
      commandClass: CommandClasses['Binary Switch'],
      endpoint: 0,
      property: 'currentValue',
    });

    expect(service.updateCharacteristic).toHaveBeenCalled();
  });
});
