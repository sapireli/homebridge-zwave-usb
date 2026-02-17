import { Characteristic, PlatformAccessory, Service } from 'homebridge';
import { ControllerAccessory } from '../../src/accessories/ControllerAccessory';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { IZWaveController } from '../../src/zwave/interfaces';
import { EventEmitter } from 'events';

// Mock dependencies
const mockPlatform = {
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  config: {
    inclusionTimeoutSeconds: 60,
  },
  api: {
    hap: {
      uuid: {
        generate: jest.fn().mockImplementation((id) => id),
      },
      Service: class MockService {
        UUID: string;
        subtype?: string;
        displayName: string;
        characteristics: any[] = [];
        constructor(displayName: string, uuid: string, subtype?: string) {
          this.displayName = displayName;
          this.UUID = uuid;
          this.subtype = subtype;
        }
        getCharacteristic = jest.fn().mockImplementation(() => {
          const charMock = {
            onSet: jest.fn().mockReturnThis(),
            updateValue: jest.fn().mockReturnThis(),
            setProps: jest.fn().mockReturnThis(),
            props: {},
          };
          return charMock;
        });
        setCharacteristic = jest.fn().mockReturnThis();
        testCharacteristic = jest.fn().mockReturnValue(true);
        addOptionalCharacteristic = jest.fn();
        removeCharacteristic = jest.fn();
        updateCharacteristic = jest.fn();
      },
      Characteristic: class MockCharacteristic {
        static Manufacturer = 'Manufacturer';
        static Model = 'Model';
        static SerialNumber = 'SerialNumber';
        static ServiceLabelNamespace = 'ServiceLabelNamespace';
        static ServiceLabelIndex = 'ServiceLabelIndex';
        static Name = 'Name';
        static On = 'On';
        static ConfiguredName = 'ConfiguredName';
        static ZWaveStatus = 'ZWaveStatus';
        static S2PinEntry = 'S2PinEntry';
        constructor() {}
      },
    },
    platformAccessory: class MockAccessory {
      services: any[] = [];
      
      // Shared mocks for characteristics to allow verification
      _sharedCharMock = {
        onSet: jest.fn().mockReturnThis(),
        updateValue: jest.fn().mockReturnThis(),
        setProps: jest.fn().mockReturnThis(),
        props: {},
      };

      _createServiceMock = () => ({
        setCharacteristic: jest.fn().mockReturnThis(),
        getCharacteristic: jest.fn().mockReturnValue(this._sharedCharMock),
        testCharacteristic: jest.fn().mockReturnValue(true),
        addOptionalCharacteristic: jest.fn(),
        removeCharacteristic: jest.fn(),
        updateCharacteristic: jest.fn(),
      });

      getService = jest.fn().mockImplementation(() => this._createServiceMock());
      getServiceById = jest.fn();
      addService = jest.fn().mockImplementation(() => this._createServiceMock());
      removeService = jest.fn();
    },
    registerPlatformAccessories: jest.fn(),
  },
  accessories: [],
  Service: {
    AccessoryInformation: 'AccessoryInformation',
    Switch: 'Switch',
    ZWaveManager: class {},
  },
  Characteristic: {
    Manufacturer: 'Manufacturer',
    Model: 'Model',
    SerialNumber: 'SerialNumber',
    ServiceLabelNamespace: 'ServiceLabelNamespace',
    ServiceLabelIndex: 'ServiceLabelIndex',
    Name: 'Name',
    On: 'On',
    ConfiguredName: 'ConfiguredName',
    ZWaveStatus: class {},
    S2PinEntry: class {},
  },
} as any;

const mockController = new EventEmitter() as any;
mockController.homeId = 0x12345678;
mockController.nodes = new Map();
mockController.startInclusion = jest.fn().mockResolvedValue(true);
mockController.stopInclusion = jest.fn().mockResolvedValue(true);
mockController.startExclusion = jest.fn().mockResolvedValue(true);
mockController.stopExclusion = jest.fn().mockResolvedValue(true);
mockController.startHealing = jest.fn().mockResolvedValue(true);
mockController.stopHealing = jest.fn().mockResolvedValue(true);
mockController.removeFailedNode = jest.fn().mockResolvedValue(undefined);
mockController.setS2Pin = jest.fn();

describe('ControllerAccessory', () => {
  let accessory: ControllerAccessory;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatform.accessories = [];
    // Reset services array in mock accessory
    mockPlatform.api.platformAccessory.prototype.services = [];
    
    accessory = new ControllerAccessory(mockPlatform, mockController);
  });

  afterEach(() => {
    accessory.stop();
  });

  it('should initialize and create services', () => {
    expect(mockPlatform.api.registerPlatformAccessories).toHaveBeenCalled();
    expect(accessory).toBeDefined();
  });

  it('should handle inclusion start request', async () => {
    const inclusionService = (accessory as any).inclusionService;
    // Index 1 because Index 0 is the PIN characteristic handler registered earlier
    const onSetHandler = inclusionService.getCharacteristic().onSet.mock.calls[1][0];

    await onSetHandler(true);
    expect(mockController.startInclusion).toHaveBeenCalled();
  });

  it('should handle inclusion stop request', async () => {
    const inclusionService = (accessory as any).inclusionService;
    // Index 1 for Inclusion
    const onSetHandler = inclusionService.getCharacteristic().onSet.mock.calls[1][0];

    await onSetHandler(false);
    expect(mockController.stopInclusion).toHaveBeenCalled();
  });

  it('should handle exclusion start request', async () => {
    const exclusionService = (accessory as any).exclusionService;
    // Index 2 for Exclusion
    const onSetHandler = exclusionService.getCharacteristic().onSet.mock.calls[2][0];

    await onSetHandler(true);
    expect(mockController.startExclusion).toHaveBeenCalled();
  });

  it('should handle heal network start request', async () => {
    const healService = (accessory as any).healService;
    // Index 3 for Heal
    const onSetHandler = healService.getCharacteristic().onSet.mock.calls[3][0];

    await onSetHandler(true);
    expect(mockController.startHealing).toHaveBeenCalled();
  });

  it('should handle prune dead nodes request', async () => {
    const mockNode = { status: 3, nodeId: 5 }; // Dead node
    mockController.nodes.set(5, mockNode);
    
    const pruneService = (accessory as any).pruneService;
    // Index 4 for Prune
    const onSetHandler = pruneService.getCharacteristic().onSet.mock.calls[4][0];

    await onSetHandler(true);
    expect(mockController.removeFailedNode).toHaveBeenCalledWith(5);
  });

  it('should update status on controller events', () => {
    mockController.emit('status updated', 'Testing Status');
    const statusService = (accessory as any).statusService;
    expect(statusService.getCharacteristic().updateValue).toHaveBeenCalledWith('Testing Status');
  });

  it('should update progress on heal network progress', () => {
    const progressMap = new Map();
    progressMap.set(1, 'pending');
    progressMap.set(2, 'done');
    
    mockController.emit('heal network progress', progressMap);
    const statusService = (accessory as any).statusService;
    // 2 items total, 2 non-zero values (assuming the mock behavior passes map values directly)
    // The implementation counts non-zero values. Let's assume 'pending' and 'done' are treated as truthy/non-zero in this context 
    // or more accurately, the real event sends status codes.
    // If we mock strict behavior:
    const strictMap = new Map();
    strictMap.set(2, 1); // Pending
    strictMap.set(3, 0); // Pending (0 usually means pending/waiting in some contexts, but let's check code)
    // Code: .filter((v) => v !== 0)
    // So 0 is skipped.
    
    mockController.emit('heal network progress', strictMap);
    expect(statusService.getCharacteristic().updateValue).toHaveBeenCalledWith('Heal: 1/2');
  });
});
