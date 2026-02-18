import { ColorSwitchFeature } from '../../src/features/ColorSwitchFeature';

describe('ColorSwitchFeature', () => {
  let feature: ColorSwitchFeature;
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
      testCharacteristic: jest.fn().mockReturnValue(true), updateCharacteristic: jest.fn().mockReturnThis(), setPrimaryService: jest.fn(),
      addOptionalCharacteristic: jest.fn(),
      UUID: 'Lightbulb',
    };

    accessory = {
      displayName: 'Test Light',
      platformAccessory: {
        displayName: 'Test Light',
        getService: jest.fn().mockReturnValue(service),
        getServiceById: jest.fn().mockReturnValue(service),
        addService: jest.fn().mockReturnValue(service),
      },
      accessoryService: service,
    };

    platform = {
      Service: {
        Lightbulb: 'Lightbulb',
      },
      Characteristic: {
        On: 'On',
        Brightness: 'Brightness',
        Hue: 'Hue',
        Saturation: 'Saturation',
        ColorTemperature: 'ColorTemperature',
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
      id: 12,
      getValue: jest.fn(),
      setValue: jest.fn(),
      getValueMetadata: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(true),
    };

    endpoint = { 
        index: 0,
        supportsCC: jest.fn().mockReturnValue(true) 
    };

    feature = new ColorSwitchFeature(platform, accessory.platformAccessory, endpoint, node);
    feature.init();
  });

  it('should initialize lightbulb service', () => {
    expect(accessory.platformAccessory.getServiceById).toHaveBeenCalledWith('Lightbulb', '0');
  });

  it('should update state from Z-Wave', () => {
    // CC 51 = Color Switch
    // Component 2 (Red) = 255
    const event = {
      commandClass: 51,
      property: 'currentValue',
      propertyKey: 2, // Red
      newValue: 255,
      endpoint: 0,
    };
    
    // We need to mock all RGB values for the Hue/Sat calculation
    node.getValue.mockImplementation((args: any) => {
        if (args.commandClass === 51 && args.property === 'currentColor') {
            return { red: 255, green: 0, blue: 0, warmWhite: 0, coldWhite: 0 };
        }
        if (args.commandClass === 38 && args.property === 'currentValue') {
            return 99; // Brightness
        }
        return 0;
    });

    feature.update(event);
    
    // Pure Red: Hue = 0, Saturation = 100
    expect(service.updateCharacteristic).toHaveBeenCalledWith('Hue', 0);
    expect(service.updateCharacteristic).toHaveBeenCalledWith('Saturation', 100);
  });

  it('should set hue/saturation', async () => {
    // In init():
    // 1. Hue (onSet) -> Index 0
    // 2. Saturation (onSet) -> Index 1
    // 3. Brightness (onSet) -> Index 2
    
    const hueChar = service.getCharacteristic();
    const hueHandler = hueChar.onSet.mock.calls[0][0];
    const satHandler = hueChar.onSet.mock.calls[1][0];

    // Set Hue to 120 (Green)
    await hueHandler(120);
    // Set Saturation to 100%
    await satHandler(100);

    // Should call setValue with Green component
    // Note: setLinkColor uses hslToRgb(120, 100, 50) -> R=0, G=255, B=0
    expect(node.setValue).toHaveBeenCalledWith(
        expect.objectContaining({
            commandClass: 51,
            property: 'targetColor',
        }),
        expect.objectContaining({ green: 255 })
    );
  });
});
