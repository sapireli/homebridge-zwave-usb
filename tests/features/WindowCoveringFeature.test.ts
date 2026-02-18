import { WindowCoveringFeature } from '../../src/features/WindowCoveringFeature';

describe('WindowCoveringFeature', () => {
  let feature: WindowCoveringFeature;
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
      UUID: 'WindowCovering',
    };

    accessory = {
      displayName: 'Test Blinds',
      platformAccessory: {
        displayName: 'Test Blinds',
        getService: jest.fn().mockReturnValue(service),
        getServiceById: jest.fn().mockReturnValue(service),
        addService: jest.fn().mockReturnValue(service),
      },
      accessoryService: service,
    };

    platform = {
      Service: {
        WindowCovering: 'WindowCovering',
      },
      Characteristic: {
        CurrentPosition: 'CurrentPosition',
        TargetPosition: 'TargetPosition',
        PositionState: {
          DECREASING: 0,
          INCREASING: 1,
          STOPPED: 2,
        },
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
      id: 11,
      getValue: jest.fn(),
      setValue: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(true),
    };

    endpoint = { 
        index: 0,
        supportsCC: jest.fn().mockReturnValue(true) 
    };

    feature = new WindowCoveringFeature(platform, accessory.platformAccessory, endpoint, node);
    feature.init();
  });

  it('should initialize window covering service', () => {
    expect(accessory.platformAccessory.getServiceById).toHaveBeenCalledWith('WindowCovering', '0');
  });

  it('should update current position from Multilevel Switch report', () => {
    // Mock return values for update cycle
    node.getValue.mockImplementation((args: any) => {
        if (args.property === 'currentValue') return 99; // 99 maps to 100%
        if (args.property === 'targetValue') return 99;
        return 0;
    });

    // CC 38 = Multilevel Switch
    const event = {
      commandClass: 38,
      property: 'currentValue',
      newValue: 99, 
      endpoint: 0,
    };
    
    feature.update(event);
    expect(service.updateCharacteristic).toHaveBeenCalledWith('CurrentPosition', 100);
  });

  it('should set target position', async () => {
    // Identify the onSet handler for TargetPosition
    // In init():
    // 1. CurrentPosition -> onGet
    // 2. TargetPosition -> onGet, onSet
    // 3. PositionState -> onGet
    
    // We assume TargetPosition.onSet is the first call to onSet because CurrentPosition/PositionState likely don't use onSet
    const targetChar = service.getCharacteristic(); 
    const handler = targetChar.onSet.mock.calls[0][0];
    
    // Mock node.getValue to avoid errors inside handleSetTargetPosition -> handleGetCurrentPosition
    node.getValue.mockReturnValue(50);

    await handler(50);
    
    // Should call node.setValue with 50
    expect(node.setValue).toHaveBeenCalledWith(
      expect.objectContaining({
        property: 'targetValue',
      }),
      50
    );
  });
});
