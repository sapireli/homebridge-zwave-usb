import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { CentralSceneFeature } from '../../src/features/CentralSceneFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('CentralSceneFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: CentralSceneFeature;
  let accessory: any;
  let service: any;
  let characteristic: any;

  beforeEach(() => {
    characteristic = {
      updateValue: jest.fn(),
      setProps: jest.fn().mockReturnThis(),
    };
    service = {
      getCharacteristic: jest.fn().mockReturnValue(characteristic),
      setCharacteristic: jest.fn().mockReturnThis(),
      testCharacteristic: jest.fn().mockReturnValue(true), updateCharacteristic: jest.fn().mockReturnThis(), setPrimaryService: jest.fn(),
      addOptionalCharacteristic: jest.fn(),
      updateCharacteristic: jest.fn().mockReturnThis(),
      setPrimaryService: jest.fn(),
    };

    hap = {
      Service: {
        StatelessProgrammableSwitch: jest.fn(),
      } as any,
      Characteristic: {
        ProgrammableSwitchEvent: {
          SINGLE_PRESS: 0,
          DOUBLE_PRESS: 1,
          LONG_PRESS: 2,
        },
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
      displayName: 'Test Node',
      services: [],
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
      nodeId: 8,
      getValue: jest.fn(),
      getDefinedValueIDs: jest.fn(),
      getValueMetadata: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;

    feature = new CentralSceneFeature(platform, accessory, endpoint, node);
  });

  it('should initialize StatelessProgrammableSwitch services if metadata exists', () => {
    node.getValueMetadata.mockReturnValue({ states: { '1': 'Button 1', '2': 'Button 2' } });
    feature.init();
    // It should create 2 services: "0-1" and "0-2"
    expect(accessory.getServiceById).toHaveBeenCalledWith(
      platform.Service.StatelessProgrammableSwitch,
      '0-1',
    );
    expect(accessory.getServiceById).toHaveBeenCalledWith(
      platform.Service.StatelessProgrammableSwitch,
      '0-2',
    );
  });

  it('should trigger SINGLE_PRESS on Key Pressed (0) for correct button', () => {
    node.getValueMetadata.mockReturnValue({ states: { '1': 'Button 1' } });
    feature.init();

    node.getValue.mockImplementation((vid) => {
      if (vid.property === 'keyAttribute') return 0;
      return undefined;
    });

    feature.update({
      commandClass: CommandClasses['Central Scene'],
      endpoint: 0,
      property: 'scene',
      newValue: 1,
    });

    expect(characteristic.updateValue).toHaveBeenCalledWith(
      platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    );
    expect(accessory.getServiceById).toHaveBeenCalledWith(
      platform.Service.StatelessProgrammableSwitch,
      '0-1',
    );
  });

  it('should trigger DOUBLE_PRESS on Key Double Pressed (3)', () => {
    node.getValueMetadata.mockReturnValue({ states: { '1': 'Button 1' } });
    feature.init();

    node.getValue.mockImplementation((vid) => {
      if (vid.property === 'keyAttribute') return 3;
      return undefined;
    });

    feature.update({
      commandClass: CommandClasses['Central Scene'],
      endpoint: 0,
      property: 'scene',
      newValue: 1,
    });

    expect(characteristic.updateValue).toHaveBeenCalledWith(
      platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
    );
  });

  it('should trigger LONG_PRESS on Key Held (2)', () => {
    node.getValueMetadata.mockReturnValue({ states: { '1': 'Button 1' } });
    feature.init();

    node.getValue.mockImplementation((vid) => {
      if (vid.property === 'keyAttribute') return 2;
      return undefined;
    });

    feature.update({
      commandClass: CommandClasses['Central Scene'],
      endpoint: 0,
      property: 'scene',
      newValue: 1,
    });

    expect(characteristic.updateValue).toHaveBeenCalledWith(
      platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS,
    );
  });
});
