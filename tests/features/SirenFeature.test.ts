import { SirenFeature } from '../../src/features/SirenFeature';

describe('SirenFeature', () => {
  let feature: SirenFeature;
  let platform: any;
  let accessory: any;
  let service: any;
  let node: any;
  let endpoint: any;

  beforeEach(() => {
    const characteristics = new Map<string, any>();
    
    const createCharMock = (name: string) => {
      const char = {
        onSet: jest.fn().mockReturnThis(),
        onGet: jest.fn().mockReturnThis(),
        updateValue: jest.fn().mockReturnThis(),
        setProps: jest.fn().mockReturnThis(),
        value: 0,
      };
      characteristics.set(name, char);
      return char;
    };

    service = {
      getCharacteristic: jest.fn().mockImplementation((name: string) => {
        return characteristics.get(name) || createCharMock(name);
      }),
      updateCharacteristic: jest.fn(),
      testCharacteristic: jest.fn().mockReturnValue(true), updateCharacteristic: jest.fn().mockReturnThis(), setPrimaryService: jest.fn(),
      addOptionalCharacteristic: jest.fn(),
      UUID: 'Fan',
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
        Fan: 'Fan',
      },
      Characteristic: {
        On: 'On',
        RotationSpeed: 'RotationSpeed',
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

  it('should initialize siren as a Fan service', () => {
    expect(accessory.platformAccessory.getServiceById).toHaveBeenCalledWith('Fan', '0');
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
    const onChar = service.getCharacteristic('On');
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

  it('should fallback to OFF when state values are missing but node is reachable', () => {
    node.ready = true;
    node.status = 1;
    node.getValue.mockReturnValue(undefined);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith('On', false);
  });

  it('should update RotationSpeed from Sound Switch report', () => {
    node.getValue.mockImplementation((params: any) => {
      if (params.property === 'defaultVolume') {
        return 75;
      }
      return 1;
    });

    feature.update();
    
    expect(service.updateCharacteristic).toHaveBeenCalledWith('RotationSpeed', 75);
  });

  it('should set volume using Sound Switch', async () => {
    // We need to trigger the Volume set handler
    // It's the second characteristic initialized if Sound Switch is supported
    const volChar = service.getCharacteristic('RotationSpeed');
    const handler = volChar.onSet.mock.calls[0][0];

    await handler(50);
    
    expect(node.setValue).toHaveBeenCalledWith(
      expect.objectContaining({
        commandClass: 121,
        property: 'defaultVolume',
      }),
      50
    );
  });
});
