import { SirenFeature } from '../../src/features/SirenFeature';

describe('SirenFeature', () => {
  let feature: SirenFeature;
  let platform: any;
  let accessory: any;
  let service: any;
  let node: any;
  let endpoint: any;

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
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      UUID: 'Switch',
    };

    accessory = {
      displayName: 'Test Siren',
      platformAccessory: {
        displayName: 'Test Siren',
        getService: jest.fn().mockReturnValue(service),
        getServiceById: jest.fn().mockReturnValue(service),
        addService: jest.fn().mockReturnValue(service),
      },
      accessoryService: service,
    };

    platform = {
      Service: {
        Switch: 'Switch',
      },
      Characteristic: {
        On: 'On',
        Name: 'Name',
        ServiceLabelIndex: 'ServiceLabelIndex',
        StatusFault: 'StatusFault',
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
      id: 14,
      getValue: jest.fn(),
      setValue: jest.fn(),
      getValueMetadata: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(true),
    };

    endpoint = { 
        index: 0,
        supportsCC: jest.fn().mockReturnValue(true) 
    };

    feature = new SirenFeature(platform, accessory.platformAccessory, endpoint, node);
    feature.init();
  });

  it('should initialize siren as a switch service', () => {
    expect(accessory.platformAccessory.getServiceById).toHaveBeenCalledWith('Switch', '0');
  });

  it('should update state from Sound Switch report', () => {
    // CC 121 = Sound Switch (79 in hex)
    const event = {
      commandClass: 121,
      property: 'toneId',
      newValue: 1, // On
      endpoint: 0,
    };
    
    // Mock Sound Switch Tone ID = 1
    node.getValue.mockReturnValue(1);

    feature.update(event);
    
    expect(service.updateCharacteristic).toHaveBeenCalledWith('On', true);
  });

  it('should set state to ON using Sound Switch', async () => {
    const onChar = service.getCharacteristic();
    const handler = onChar.onSet.mock.calls[0][0];
    
    // Mock metadata to allow Tone 255
    node.getValueMetadata.mockReturnValue({ max: 255 });

    await handler(true);
    
    // Should call setValue with Tone 255
    expect(node.setValue).toHaveBeenCalledWith(
      expect.objectContaining({
        commandClass: 121, // Sound Switch
        property: 'toneId',
      }),
      255
    );
  });
});
