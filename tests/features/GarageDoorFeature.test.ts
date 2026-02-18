import { GarageDoorFeature } from '../../src/features/GarageDoorFeature';

describe('GarageDoorFeature', () => {
  let feature: GarageDoorFeature;
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
      UUID: 'GarageDoorOpener',
    };

    accessory = {
      displayName: 'Test Garage',
      platformAccessory: {
        displayName: 'Test Garage',
        getService: jest.fn().mockReturnValue(service),
        getServiceById: jest.fn().mockReturnValue(service),
        addService: jest.fn().mockReturnValue(service),
      },
      accessoryService: service,
    };

    platform = {
      Service: {
        GarageDoorOpener: 'GarageDoorOpener',
      },
      Characteristic: {
        CurrentDoorState: {
          OPEN: 0,
          CLOSED: 1,
          OPENING: 2,
          CLOSING: 3,
          STOPPED: 4,
        },
        TargetDoorState: {
          OPEN: 0,
          CLOSED: 1,
        },
        ObstructionDetected: 'ObstructionDetected',
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
      id: 13,
      getValue: jest.fn(),
      setValue: jest.fn(),
      supportsCC: jest.fn().mockReturnValue(true),
    };

    endpoint = { 
        index: 0,
        supportsCC: jest.fn().mockReturnValue(true) 
    };

    feature = new GarageDoorFeature(platform, accessory.platformAccessory, endpoint, node);
    feature.init();
  });

  it('should initialize garage door service', () => {
    expect(accessory.platformAccessory.getServiceById).toHaveBeenCalledWith('GarageDoorOpener', '0');
  });

  it('should update state from Barrier Operator report', () => {
    // CC 102 = Barrier Operator
    // State 255 = Open
    const event = {
      commandClass: 102,
      property: 'state',
      newValue: 255,
      endpoint: 0,
    };
    
    // Mock Barrier State: 255 = Open
    node.getValue.mockReturnValue(255);

    feature.update(event);
    
    // Open = 0
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.CurrentDoorState, 
        0
    );
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
        platform.Characteristic.TargetDoorState, 
        0
    );
  });

  it('should set target state to CLOSED', async () => {
    // In init():
    // 1. CurrentDoorState
    // 2. TargetDoorState -> onGet, onSet
    const targetChar = service.getCharacteristic();
    // Assuming calls[1] is TargetDoorState (CurrentDoorState is call 0)
    // Actually init order:
    // 1. CurrentDoorState
    // 2. TargetDoorState
    // 3. ObstructionDetected
    
    // CurrentDoorState.onGet -> index 0
    // TargetDoorState.onGet -> index 1
    // TargetDoorState.onSet -> index 2
    // ObstructionDetected.onGet -> index 3
    
    const handler = targetChar.onSet.mock.calls[0][0]; // Wait, onSet calls are separate list?
    // In my shared mock, onSet is a jest.fn().
    // calls list is shared for all onSet calls.
    // 1. TargetDoorState.onSet is the ONLY onSet call in init().
    
    await handler(1); // 1 = CLOSED
    
    // Should call setValue with 255 (Close? No, 0=Closed, 255=Open usually)
    // Barrier Operator: 0 = Closed, 255 = Open
    // HomeKit: 0 = Open, 1 = Closed
    
    // If setting CLOSED (1), should send 0 to Barrier Operator.
    expect(node.setValue).toHaveBeenCalledWith(
        expect.objectContaining({
            commandClass: 102,
            property: 'targetState',
        }),
        0
    );
  });

  it('should use fallback current state when value is missing but node is reachable', () => {
    node.ready = true;
    node.status = 1;
    node.getValue.mockReturnValue(undefined);
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.CurrentDoorState,
      platform.Characteristic.CurrentDoorState.OPEN,
    );
  });
});
