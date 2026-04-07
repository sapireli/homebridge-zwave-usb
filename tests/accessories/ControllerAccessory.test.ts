import { Characteristic, PlatformAccessory, Service } from 'homebridge';
import {
  ControllerAccessory,
  CONTROLLER_CACHE_REPAIR_VERSION,
} from '../../src/accessories/ControllerAccessory';
import { MANAGER_SERVICE_UUID } from '../../src/platform/settings';
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
    updatePlatformAccessories: jest.fn(),
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
    jest.useRealTimers();
    accessory.stop();
  });

  it('should initialize and create services', () => {
    expect(mockPlatform.api.registerPlatformAccessories).toHaveBeenCalled();
    expect(accessory).toBeDefined();
  });

  it('should restore controller-only ConfiguredName metadata for Home app labels', () => {
    expect((accessory as any).statusService.getCharacteristic).toHaveBeenCalledWith(
      mockPlatform.Characteristic.ConfiguredName,
    );
    expect((accessory as any).inclusionService.getCharacteristic).toHaveBeenCalledWith(
      mockPlatform.Characteristic.ConfiguredName,
    );
    expect((accessory as any).exclusionService.getCharacteristic).toHaveBeenCalledWith(
      mockPlatform.Characteristic.ConfiguredName,
    );
    expect((accessory as any).healService.getCharacteristic).toHaveBeenCalledWith(
      mockPlatform.Characteristic.ConfiguredName,
    );
    expect((accessory as any).pruneService.getCharacteristic).toHaveBeenCalledWith(
      mockPlatform.Characteristic.ConfiguredName,
    );
  });

  it('should handle inclusion start request', async () => {
    await (accessory as any).handleSetInclusion(true);
    expect(mockController.startInclusion).toHaveBeenCalled();
  });

  it('should handle inclusion stop request', async () => {
    await (accessory as any).handleSetInclusion(false);
    expect(mockController.stopInclusion).toHaveBeenCalled();
  });

  it('should handle exclusion start request', async () => {
    await (accessory as any).handleSetExclusion(true);
    expect(mockController.startExclusion).toHaveBeenCalled();
  });

  it('should handle heal network start request', async () => {
    await (accessory as any).handleSetHeal(true);
    expect(mockController.startHealing).toHaveBeenCalled();
  });

  it('should handle prune dead nodes request', async () => {
    const mockNode = { status: 3, nodeId: 5 }; // Dead node
    mockController.nodes.set(5, mockNode);
    
    await (accessory as any).handleSetPrune(true);
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

  it('should register the custom S2 pin characteristic on the status service, not on switch services', () => {
    const statusService = (accessory as any).statusService;
    const inclusionService = (accessory as any).inclusionService;

    expect(statusService.addOptionalCharacteristic).toHaveBeenCalled();
    expect(inclusionService.addOptionalCharacteristic).not.toHaveBeenCalled();
  });

  it('should forward a padded S2 PIN from HomeKit to the controller and reset the characteristic', () => {
    jest.useFakeTimers();
    const pinChar = (accessory as any).pinChar;
    pinChar.updateValue.mockClear();

    const onSetHandler = pinChar.onSet.mock.calls[0][0];
    onSetHandler(123);

    expect(mockController.setS2Pin).toHaveBeenCalledWith('00123');

    jest.advanceTimersByTime(2000);
    expect(pinChar.updateValue).toHaveBeenCalledWith(0);
  });

  it('should ignore invalid S2 PIN values from HomeKit', () => {
    const pinChar = (accessory as any).pinChar;
    const onSetHandler = pinChar.onSet.mock.calls[0][0];

    onSetHandler(100000);

    expect(mockController.setS2Pin).not.toHaveBeenCalled();
    expect(mockPlatform.log.warn).toHaveBeenCalled();
  });

  it('should skip controller cache repair once the migration version is recorded', () => {
    const existingAccessory = new mockPlatform.api.platformAccessory();
    existingAccessory.UUID = 'homebridge-zwave-usb-controller-305419896';
    existingAccessory.context = { cacheRepairVersion: CONTROLLER_CACHE_REPAIR_VERSION };
    existingAccessory.services = [
      {
        UUID: 'legacy-service',
        displayName: 'Legacy',
        characteristics: [{ UUID: 'legacy-char', displayName: 'Legacy Char' }],
        removeCharacteristic: jest.fn(),
      },
    ];
    existingAccessory.removeService = jest.fn();
    mockPlatform.accessories = [existingAccessory];

    accessory.stop();
    accessory = new ControllerAccessory(mockPlatform, mockController);

    expect(existingAccessory.removeService).not.toHaveBeenCalled();
  });

  it('should persist an existing controller accessory after one-time cache repair', () => {
    const existingAccessory = new mockPlatform.api.platformAccessory();
    existingAccessory.UUID = 'homebridge-zwave-usb-controller-305419896';
    existingAccessory.context = {};
    const existingManagerService = {
      getCharacteristic: jest.fn().mockReturnValue(existingAccessory._sharedCharMock),
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      removeCharacteristic: jest.fn(),
      updateCharacteristic: jest.fn(),
      setCharacteristic: jest.fn().mockReturnThis(),
      UUID: MANAGER_SERVICE_UUID,
      subtype: 'Status',
      displayName: 'Legacy',
      characteristics: [{ UUID: 'legacy-char', displayName: 'Legacy Char' }],
    };
    existingAccessory.services = [
      existingManagerService,
    ];
    existingAccessory.removeService = jest.fn();
    existingAccessory.addService = jest.fn().mockImplementation(() => existingAccessory._createServiceMock());
    mockPlatform.accessories = [existingAccessory];

    accessory.stop();
    accessory = new ControllerAccessory(mockPlatform, mockController);

    expect(mockPlatform.api.updatePlatformAccessories).toHaveBeenCalledWith([existingAccessory]);
  });

  it('should reuse an existing cached manager service with subtype Status instead of adding a duplicate', () => {
    const existingAccessory = new mockPlatform.api.platformAccessory();
    existingAccessory.UUID = 'homebridge-zwave-usb-controller-305419896';
    existingAccessory.context = { cacheRepairVersion: CONTROLLER_CACHE_REPAIR_VERSION };
    const infoService = {
      setCharacteristic: jest.fn().mockReturnThis(),
      getCharacteristic: jest.fn().mockReturnValue(existingAccessory._sharedCharMock),
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      removeCharacteristic: jest.fn(),
      updateCharacteristic: jest.fn(),
      UUID: 'AccessoryInformation',
      characteristics: [],
    };

    const existingManagerService = {
      UUID: MANAGER_SERVICE_UUID,
      subtype: 'Status',
      displayName: 'System Status',
      characteristics: [],
      getCharacteristic: jest.fn().mockReturnValue(existingAccessory._sharedCharMock),
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      removeCharacteristic: jest.fn(),
      updateCharacteristic: jest.fn(),
      setCharacteristic: jest.fn().mockReturnThis(),
    };

    existingAccessory.services = [infoService, existingManagerService];
    existingAccessory.getService = jest
      .fn()
      .mockImplementation((serviceType) =>
        serviceType === mockPlatform.Service.AccessoryInformation ? infoService : undefined,
      );
    existingAccessory.getServiceById = jest.fn();
    existingAccessory.addService = jest.fn().mockImplementation(() => existingAccessory._createServiceMock());
    mockPlatform.accessories = [existingAccessory];

    accessory.stop();
    accessory = new ControllerAccessory(mockPlatform, mockController);

    expect(existingAccessory.addService).not.toHaveBeenCalledWith(
      expect.objectContaining({ UUID: MANAGER_SERVICE_UUID, subtype: 'Status' }),
    );
    expect((accessory as any).statusService).toBe(existingManagerService);
  });

  it('should persist restored controller ConfiguredName metadata on an existing accessory', () => {
    const existingAccessory = new mockPlatform.api.platformAccessory();
    existingAccessory.UUID = 'homebridge-zwave-usb-controller-305419896';
    existingAccessory.context = { cacheRepairVersion: CONTROLLER_CACHE_REPAIR_VERSION };

    const sharedChar = {
      value: undefined,
      onSet: jest.fn().mockReturnThis(),
      updateValue: jest.fn().mockReturnThis(),
      setProps: jest.fn().mockReturnThis(),
      props: {},
    };
    const createService = (uuid: string, subtype?: string) => ({
      UUID: uuid,
      subtype,
      displayName: subtype || uuid,
      characteristics: [],
      getCharacteristic: jest.fn().mockReturnValue(sharedChar),
      testCharacteristic: jest.fn().mockImplementation((characteristic) => {
        if (characteristic === mockPlatform.Characteristic.ConfiguredName) {
          return false;
        }
        return true;
      }),
      addOptionalCharacteristic: jest.fn(),
      removeCharacteristic: jest.fn(),
      updateCharacteristic: jest.fn(),
      setCharacteristic: jest.fn().mockReturnThis(),
    });

    const infoService = createService('AccessoryInformation');
    const managerService = createService(MANAGER_SERVICE_UUID, 'Status');
    const inclusionService = createService('Switch', 'Inclusion');
    const exclusionService = createService('Switch', 'Exclusion');
    const healService = createService('Switch', 'Heal');
    const pruneService = createService('Switch', 'Prune');

    existingAccessory.services = [
      infoService,
      managerService,
      inclusionService,
      exclusionService,
      healService,
      pruneService,
    ];
    existingAccessory.getService = jest
      .fn()
      .mockImplementation((serviceType) =>
        serviceType === mockPlatform.Service.AccessoryInformation ? infoService : undefined,
      );
    existingAccessory.getServiceById = jest.fn().mockImplementation((serviceType, subtype) => {
      if (serviceType !== mockPlatform.Service.Switch) {
        return undefined;
      }
      return {
        Inclusion: inclusionService,
        Exclusion: exclusionService,
        Heal: healService,
        Prune: pruneService,
      }[subtype as 'Inclusion' | 'Exclusion' | 'Heal' | 'Prune'];
    });
    existingAccessory.addService = jest.fn();
    mockPlatform.accessories = [existingAccessory];

    accessory.stop();
    accessory = new ControllerAccessory(mockPlatform, mockController);

    expect(inclusionService.addOptionalCharacteristic).toHaveBeenCalledWith(
      mockPlatform.Characteristic.ConfiguredName,
    );
    expect(mockPlatform.api.updatePlatformAccessories).toHaveBeenCalledWith([existingAccessory]);
  });
});
