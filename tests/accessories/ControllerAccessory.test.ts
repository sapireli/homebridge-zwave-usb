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
    Switch: { UUID: 'Switch' },
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
mockController.startHealing = jest.fn().mockResolvedValue('started');
mockController.stopHealing = jest.fn().mockResolvedValue(true);
mockController.removeFailedNode = jest.fn().mockResolvedValue(undefined);
mockController.getNodeRouteDiagnostics = jest.fn();
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
  });

  it('should not expose a destructive node-removal switch', () => {
    expect((accessory as any).pruneService).toBeUndefined();
    expect((accessory as any).handleSetPrune).toBeUndefined();
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

  it('should start only one heal for duplicate ON writes', async () => {
    await Promise.all([
      (accessory as any).handleSetHeal(true),
      (accessory as any).handleSetHeal(true),
      (accessory as any).handleSetHeal(true),
    ]);

    expect(mockController.startHealing).toHaveBeenCalledTimes(1);
  });

  it('should not start a second heal while one is already active', async () => {
    await (accessory as any).handleSetHeal(true);
    mockController.startHealing.mockClear();

    await (accessory as any).handleSetHeal(true);

    expect(mockController.startHealing).not.toHaveBeenCalled();
    expect((accessory as any).isHealActive).toBe(true);
  });

  it('should not start a heal the user cancelled while inclusion was being stopped', async () => {
    let releaseStopInclusion: () => void = () => undefined;
    mockController.stopInclusion.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseStopInclusion = () => resolve(true);
        }),
    );
    (accessory as any).isInclusionActive = true;

    const on = (accessory as any).handleSetHeal(true);
    await (accessory as any).handleSetHeal(false);
    releaseStopInclusion();
    await on;

    expect(mockController.startHealing).not.toHaveBeenCalled();
    expect((accessory as any).isHealActive).toBe(false);
    expect((accessory as any).healService.updateCharacteristic).toHaveBeenLastCalledWith(
      mockPlatform.Characteristic.On,
      false,
    );
  });

  it('should not start a heal that inclusion cancelled while it was still starting', async () => {
    /**
     * The sibling switches have to see a heal that is still starting, not only one that has
     * already begun. Otherwise turning inclusion on during the mutex round trip lets the heal
     * resume afterwards and rebuild the mesh with inclusion mode open.
     */
    let releaseStopExclusion: () => void = () => undefined;
    mockController.stopExclusion.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseStopExclusion = () => resolve(true);
        }),
    );
    (accessory as any).isExclusionActive = true;

    const healOn = (accessory as any).handleSetHeal(true);
    await (accessory as any).handleSetInclusion(true);
    releaseStopExclusion();
    await healOn;

    expect(mockController.startHealing).not.toHaveBeenCalled();
    expect((accessory as any).isHealActive).toBe(false);
  });

  it('should cancel a starting heal when exclusion is turned on', async () => {
    let releaseStopInclusion: () => void = () => undefined;
    mockController.stopInclusion.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseStopInclusion = () => resolve(true);
        }),
    );
    (accessory as any).isInclusionActive = true;

    const healOn = (accessory as any).handleSetHeal(true);
    await (accessory as any).handleSetExclusion(true);
    releaseStopInclusion();
    await healOn;

    expect(mockController.startHealing).not.toHaveBeenCalled();
    expect((accessory as any).isHealActive).toBe(false);
  });

  it('should stop a running heal when a sibling mode is turned on', async () => {
    // The other half of the mutex: a heal that is genuinely active has to be told to stop.
    await (accessory as any).handleSetHeal(true);
    expect((accessory as any).isHealActive).toBe(true);

    await (accessory as any).handleSetInclusion(true);

    expect(mockController.stopHealing).toHaveBeenCalled();
    expect((accessory as any).isHealActive).toBe(false);
  });

  it('should reset the heal switch when the controller refuses to start', async () => {
    mockController.startHealing.mockResolvedValueOnce('refused');

    await (accessory as any).handleSetHeal(true);

    expect((accessory as any).isHealActive).toBe(false);
    expect((accessory as any).isHealStarting).toBe(false);
    expect((accessory as any).healService.updateCharacteristic).toHaveBeenLastCalledWith(
      mockPlatform.Characteristic.On,
      false,
    );
  });

  it('should say a rebuild is still finishing rather than that none started', async () => {
    mockController.startHealing.mockResolvedValueOnce('busy');

    await (accessory as any).handleSetHeal(true);

    expect(mockPlatform.log.warn).toHaveBeenCalledWith(expect.stringContaining('still finishing'));
    expect(mockPlatform.log.error).not.toHaveBeenCalled();
    expect((accessory as any).isHealActive).toBe(false);
    expect((accessory as any).healService.updateCharacteristic).toHaveBeenLastCalledWith(
      mockPlatform.Characteristic.On,
      false,
    );
  });

  it('should reset the heal switch once on genuine completion', async () => {
    jest.useFakeTimers();
    try {
      await (accessory as any).handleSetHeal(true);
      const healService = (accessory as any).healService;
      healService.updateCharacteristic.mockClear();

      mockController.emit(
        'heal network done',
        new Map([
          [4, 'done'],
          [5, 'done'],
          [6, 'skipped'],
        ]),
      );

      // The accessory stops believing a heal is running straight away.
      expect((accessory as any).isHealActive).toBe(false);

      /**
       * The characteristic write is deferred, which the plugin has done since 2.0.3 so HomeKit
       * and the Homebridge UI register the change to Off.
       */
      expect(healService.updateCharacteristic).not.toHaveBeenCalled();
      jest.advanceTimersByTime(500);

      expect(healService.updateCharacteristic).toHaveBeenCalledTimes(1);
      expect(healService.updateCharacteristic).toHaveBeenCalledWith(
        mockPlatform.Characteristic.On,
        false,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('should not let a finished heal switch off one started inside the reset delay', async () => {
    jest.useFakeTimers();
    try {
      await (accessory as any).handleSetHeal(true);
      mockController.emit('heal network done', new Map([[4, 'done']]));

      // A new heal begins before the deferred switch-off from the previous one has fired.
      jest.advanceTimersByTime(200);
      await (accessory as any).handleSetHeal(true);
      const healService = (accessory as any).healService;
      healService.updateCharacteristic.mockClear();

      jest.advanceTimersByTime(500);

      expect(healService.updateCharacteristic).not.toHaveBeenCalledWith(
        mockPlatform.Characteristic.On,
        false,
      );
      expect((accessory as any).isHealActive).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('should reset the heal switch when the heal is stopped or times out', async () => {
    await (accessory as any).handleSetHeal(true);

    mockController.emit('heal network stopped', 'timeout');

    expect((accessory as any).isHealActive).toBe(false);
    expect((accessory as any).healService.updateCharacteristic).toHaveBeenLastCalledWith(
      mockPlatform.Characteristic.On,
      false,
    );
  });

  it('should allow a new heal after the previous one finished', async () => {
    await (accessory as any).handleSetHeal(true);
    mockController.emit('heal network done', new Map([[4, 'done']]));
    mockController.startHealing.mockClear();

    await (accessory as any).handleSetHeal(true);

    expect(mockController.startHealing).toHaveBeenCalledTimes(1);
  });

  it('follows the controller quietly, since the controller already reported', () => {
    // These handlers move a HomeKit switch to match a transition the Z-Wave controller has
    // already announced. Reporting the same transition a second time says nothing new.
    (mockPlatform.log.info as jest.Mock).mockClear();

    mockController.emit('inclusion started');
    mockController.emit('inclusion stopped');
    mockController.emit('exclusion started');
    mockController.emit('exclusion stopped');
    mockController.emit('heal network stopped', 'cancelled');

    const written = (mockPlatform.log.info as jest.Mock).mock.calls.flat().join('\n');
    expect(written).not.toContain('Controller event:');

    const debugged = (mockPlatform.log.debug as jest.Mock).mock.calls.flat().join('\n');
    expect(debugged).toContain('Controller event: Inclusion Started');
    expect(debugged).toContain('Controller event: Exclusion Started');
    expect(debugged).toContain('Controller event: Heal Network cancelled');
  });

  it('should update status on controller events', () => {
    mockController.emit('status updated', 'Testing Status');
    const statusService = (accessory as any).statusService;
    expect(statusService.getCharacteristic().updateValue).toHaveBeenCalledWith('Testing Status');
  });

  it('should count only terminal statuses as completed heal progress', () => {
    const progress = new Map<number, string>([
      [4, 'done'],
      [5, 'failed'],
      [6, 'skipped'],
      [8, 'pending'],
    ]);

    mockController.emit('heal network progress', progress);

    const statusService = (accessory as any).statusService;
    expect(statusService.getCharacteristic().updateValue).toHaveBeenCalledWith('Heal: 3/4');
  });

  it('should not report progress for a freshly started heal where every node is pending', () => {
    const progress = new Map<number, string>([
      [4, 'pending'],
      [5, 'pending'],
    ]);

    mockController.emit('heal network progress', progress);

    const statusService = (accessory as any).statusService;
    expect(statusService.getCharacteristic().updateValue).toHaveBeenCalledWith('Heal: 0/2');
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

    existingAccessory.services = [
      infoService,
      managerService,
      inclusionService,
      exclusionService,
      healService,
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
      }[subtype as 'Inclusion' | 'Exclusion' | 'Heal'];
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

  it('should remove the Prune Dead Nodes switch from an accessory cached before the bump', () => {
    // The switch removed every Dead node in one sweep. Existing controllers were paired with it,
    // so the cache repair is the only thing that takes it away; without the version bump it never
    // runs and the switch stays in HomeKit.
    const existingAccessory = new mockPlatform.api.platformAccessory();
    existingAccessory.UUID = 'homebridge-zwave-usb-controller-305419896';
    // Pinned to the literal 2, the version shipped in v4.0.0, rather than to the constant: a
    // revert of the bump has to fail this test, and "the constant minus one" would follow it down.
    existingAccessory.context = { cacheRepairVersion: 2 };

    const makeService = (uuid: string, subtype?: string) => ({
      UUID: uuid,
      subtype,
      displayName: subtype || uuid,
      characteristics: [],
      getCharacteristic: jest.fn().mockReturnValue({
        on: jest.fn().mockReturnThis(),
        onSet: jest.fn().mockReturnThis(),
        onGet: jest.fn().mockReturnThis(),
        updateValue: jest.fn().mockReturnThis(),
        setProps: jest.fn().mockReturnThis(),
        props: {},
      }),
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      removeCharacteristic: jest.fn(),
      updateCharacteristic: jest.fn(),
      setCharacteristic: jest.fn().mockReturnThis(),
    });

    const infoService = makeService('AccessoryInformation');
    const managerService = makeService(MANAGER_SERVICE_UUID, 'Status');
    const inclusionService = makeService('Switch', 'Inclusion');
    const exclusionService = makeService('Switch', 'Exclusion');
    const healService = makeService('Switch', 'Heal');
    const pruneService = makeService('Switch', 'Prune');

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
      }[subtype as 'Inclusion' | 'Exclusion' | 'Heal'];
    });
    existingAccessory.addService = jest.fn();
    mockPlatform.accessories = [existingAccessory];

    accessory.stop();
    accessory = new ControllerAccessory(mockPlatform, mockController);

    expect(existingAccessory.removeService).toHaveBeenCalledWith(pruneService);
    // The switches the controller still owns are kept.
    expect(existingAccessory.removeService).not.toHaveBeenCalledWith(inclusionService);
    expect(existingAccessory.removeService).not.toHaveBeenCalledWith(exclusionService);
    expect(existingAccessory.removeService).not.toHaveBeenCalledWith(healService);
    expect(existingAccessory.context.cacheRepairVersion).toBe(CONTROLLER_CACHE_REPAIR_VERSION);
    expect(CONTROLLER_CACHE_REPAIR_VERSION).toBeGreaterThan(2);
  });
});
