import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { LockFeature } from '../../src/features/LockFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('LockFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: LockFeature;
  let accessory: any;
  let service: any;

  beforeEach(() => {
    service = {
      getCharacteristic: jest.fn().mockReturnValue({
        on: jest.fn().mockReturnThis(),
        onGet: jest.fn().mockReturnThis(),
        onSet: jest.fn().mockReturnThis(),
        updateValue: jest.fn(),
      }),
      updateCharacteristic: jest.fn(),
    };

    hap = {
      Service: {
        LockMechanism: jest.fn(),
      } as any,
      Characteristic: {
        LockCurrentState: {
            SECURED: 1,
            UNSECURED: 0,
            UNKNOWN: 255,
        },
        LockTargetState: {
            SECURED: 1,
            UNSECURED: 0,
        },
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
      nodeId: 5,
      supportsCC: jest.fn(),
      getValue: jest.fn(),
      setValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;
    
    feature = new LockFeature(platform, accessory, endpoint);
  });

  it('should initialize LockMechanism service', () => {
    feature.init();
    expect(accessory.getServiceById).toHaveBeenCalledWith(platform.Service.LockMechanism, '0');
  });

  it('should update Lock Current State (Secured -> 255)', () => {
    feature.init();
    node.getValue.mockReturnValue(255); // Secured in Z-Wave

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.LockCurrentState,
        platform.Characteristic.LockCurrentState.SECURED
    );
  });

  it('should update Lock Current State (Unsecured -> 0)', () => {
    feature.init();
    node.getValue.mockReturnValue(0); // Unsecured

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.LockCurrentState,
        platform.Characteristic.LockCurrentState.UNSECURED
    );
  });

  it('should update Lock Target State to match Current State', () => {
    feature.init();
    node.getValue.mockReturnValue(255); // Secured

    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.LockTargetState,
        platform.Characteristic.LockTargetState.SECURED
    );
  });
});
