import {
  ACCESSORY_CACHE_REPAIR_VERSION,
  ZWaveAccessory,
} from '../../src/accessories/ZWaveAccessory';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { IZWaveNode } from '../../src/zwave/interfaces';

describe('ZWaveAccessory', () => {
  let platform: any;
  let node: any;
  let accessory: ZWaveAccessory;
  let mockService: any;
  let platformAccessoryFactory: jest.Mock;

  beforeEach(() => {
    mockService = {
      getCharacteristic: jest.fn().mockReturnValue({
        value: '',
        updateValue: jest.fn(),
        onSet: jest.fn(),
        setProps: jest.fn().mockReturnThis(),
        props: { perms: ['pr', 'pw', 'ev'] },
      }),
      removeCharacteristic: jest.fn(),
      setProps: jest.fn().mockReturnThis(),
      updateValue: jest.fn().mockReturnThis(),
      updateCharacteristic: jest.fn().mockReturnThis(),
      setCharacteristic: jest.fn().mockReturnThis(),
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      setPrimaryService: jest.fn(),
      characteristics: [],
      displayName: 'Service Name',
      UUID: 'service-uuid',
    };

    platformAccessoryFactory = jest.fn().mockImplementation(() => ({
      getService: jest.fn().mockReturnValue(mockService),
      getServiceById: jest.fn().mockReturnValue(mockService),
      addService: jest.fn().mockReturnValue(mockService),
      removeService: jest.fn(),
      services: [mockService],
      displayName: 'Initial Name',
      UUID: 'test-uuid',
      context: {},
    }));

    platform = {
      log: {
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
      },
      api: {
        hap: {
          uuid: {
            generate: jest.fn().mockReturnValue('test-uuid'),
          },
        },
        platformAccessory: platformAccessoryFactory,
        updatePlatformAccessories: jest.fn(),
        registerPlatformAccessories: jest.fn(),
      },
      Service: {
        AccessoryInformation: '0000003E-0000-1000-8000-0026BB765291',
      },
      Characteristic: {
        Manufacturer: '00000020-0000-1000-8000-0026BB765291',
        Model: '00000021-0000-1000-8000-0026BB765291',
        SerialNumber: '00000030-0000-1000-8000-0026BB765291',
        Name: '00000023-0000-1000-8000-0026BB765291',
        ConfiguredName: '000000E3-0000-1000-8000-0026BB765291',
        FirmwareRevision: '00000052-0000-1000-8000-0026BB765291',
        ServiceLabelIndex: 'ServiceLabelIndex',
        StatusTampered: {
          NOT_TAMPERED: 0,
          TAMPERED: 1,
        },
        StatusFault: {
          GENERAL_FAULT: 1,
          NO_FAULT: 0,
        },
      },
      accessories: [],
    };

    node = {
      nodeId: 2,
      deviceConfig: {
        manufacturer: 'Test Man',
        label: 'Test Model',
      },
      status: 4, // Alive
      ready: true,
      supportsCC: jest.fn().mockReturnValue(false),
      getDefinedValueIDs: jest.fn().mockReturnValue([]),
      getValueMetadata: jest.fn(),
      getValue: jest.fn(),
    };

    accessory = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );
  });

  it('should update accessory and service names when renamed', () => {
    accessory.rename('New Friendly Name');

    expect(accessory.platformAccessory.displayName).toBe('New Friendly Name');
    expect(mockService.setCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.Name,
      'New Friendly Name',
    );
    expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([
      accessory.platformAccessory,
    ]);
  });

  it('should preserve cached HomeKit names on existing accessories', () => {
    const cachedAccessory = {
      getService: jest.fn().mockReturnValue(mockService),
      getServiceById: jest.fn().mockReturnValue(mockService),
      addService: jest.fn().mockReturnValue(mockService),
      removeService: jest.fn(),
      services: [mockService],
      displayName: 'HomeKit Custom Name',
      UUID: 'test-uuid',
      context: { nodeId: 2, homeId: 12345 },
    };
    platform.accessories = [cachedAccessory];

    const existing = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );

    expect(existing.platformAccessory).toBe(cachedAccessory);
    expect(existing.platformAccessory.displayName).toBe('HomeKit Custom Name');
    expect(mockService.setCharacteristic).not.toHaveBeenCalledWith(
      platform.Characteristic.Name,
      'HomeKit Custom Name',
    );
  });

  it('should advertise the node firmware revision without synthetic metadata suffixes', () => {
    expect(mockService.setCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.FirmwareRevision,
      '1.0.0',
    );
  });

  it('should preserve cached names when node metadata changes', () => {
    accessory.addFeature({
      init: jest.fn(),
      update: jest.fn(),
      getServices: () => [mockService],
      getEndpointIndex: () => 0,
      stop: jest.fn(),
      updateNode: jest.fn(),
      rename: jest.fn(),
    });
    accessory.initialize();

    const updatedNode = {
      ...node,
      name: 'Updated Name',
      getAllEndpoints: jest.fn().mockReturnValue([{ index: 0 }]),
    };

    mockService.setCharacteristic.mockClear();
    accessory.updateNode(updatedNode as IZWaveNode);

    expect(accessory.platformAccessory.displayName).toBe('Initial Name');
    expect(mockService.setCharacteristic).not.toHaveBeenCalledWith(
      platform.Characteristic.Name,
      expect.anything(),
    );
  });

  it('should not keep reapplying a plugin rename after later node updates', () => {
    accessory.addFeature({
      init: jest.fn(),
      update: jest.fn(),
      getServices: () => [mockService],
      getEndpointIndex: () => 0,
      stop: jest.fn(),
      updateNode: jest.fn(),
      rename: jest.fn(),
    });
    accessory.initialize();
    accessory.rename('Override Name');
    mockService.setCharacteristic.mockClear();

    const updatedNode = {
      ...node,
      name: 'Updated Name',
      getAllEndpoints: jest.fn().mockReturnValue([{ index: 0 }]),
    };

    accessory.updateNode(updatedNode as IZWaveNode);

    expect(accessory.platformAccessory.displayName).toBe('Override Name');
    expect(mockService.setCharacteristic).not.toHaveBeenCalledWith(
      platform.Characteristic.Name,
      'Override Name',
    );
  });

  it('should persist the accessory when node metadata changes', () => {
    accessory.addFeature({
      init: jest.fn(),
      update: jest.fn(),
      getServices: () => [mockService],
      getEndpointIndex: () => 0,
      stop: jest.fn(),
      updateNode: jest.fn(),
      rename: jest.fn(),
    });
    accessory.initialize();
    platform.api.updatePlatformAccessories.mockClear();

    const updatedNode = {
      ...node,
      firmwareVersion: '2.0.0',
      getAllEndpoints: jest.fn().mockReturnValue([{ index: 0 }]),
    };

    accessory.updateNode(updatedNode as IZWaveNode);

    expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([
      accessory.platformAccessory,
    ]);
  });

  it('should prune cached ConfiguredName from unsupported services', () => {
    const configuredNameChar = {
      UUID: platform.Characteristic.ConfiguredName,
      value: 'Cached Name',
      updateValue: jest.fn(),
    };
    const cachedBatteryService = {
      ...mockService,
      UUID: '00000096-0000-1000-8000-0026BB765291',
      testCharacteristic: jest.fn().mockImplementation(
        (char) => char === platform.Characteristic.ConfiguredName,
      ),
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.ConfiguredName) {
          return configuredNameChar;
        }
        return mockService.getCharacteristic();
      }),
      removeCharacteristic: jest.fn(),
    };

    const cachedAccessory = {
      getService: jest
        .fn()
        .mockImplementation((serviceType: string) =>
          serviceType === platform.Service.AccessoryInformation ? mockService : undefined,
        ),
      getServiceById: jest.fn().mockReturnValue(cachedBatteryService),
      addService: jest.fn().mockReturnValue(cachedBatteryService),
      removeService: jest.fn(),
      services: [mockService, cachedBatteryService],
      displayName: 'HomeKit Custom Name',
      UUID: 'test-uuid',
      context: { nodeId: 2, homeId: 12345 },
    };
    platform.accessories = [cachedAccessory];

    accessory = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );

    expect(cachedBatteryService.removeCharacteristic).toHaveBeenCalledWith(configuredNameChar);
    expect(cachedAccessory.context.cacheRepairVersion).toBe(ACCESSORY_CACHE_REPAIR_VERSION);
    expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([cachedAccessory]);
  });

  it('should prune unsupported cached health characteristics from actuator services', () => {
    const statusFaultChar = { UUID: 'StatusFault' };
    const statusTamperedChar = { UUID: 'StatusTampered' };
    const cachedSwitchService = {
      ...mockService,
      UUID: '00000049-0000-1000-8000-0026BB765291',
      testCharacteristic: jest.fn().mockImplementation(
        (char) =>
          char === platform.Characteristic.StatusFault ||
          char === platform.Characteristic.StatusTampered,
      ),
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.StatusFault) {
          return statusFaultChar;
        }
        if (char === platform.Characteristic.StatusTampered) {
          return statusTamperedChar;
        }
        return mockService.getCharacteristic();
      }),
      removeCharacteristic: jest.fn(),
    };

    const cachedAccessory = {
      getService: jest
        .fn()
        .mockImplementation((serviceType: string) =>
          serviceType === platform.Service.AccessoryInformation ? mockService : undefined,
        ),
      getServiceById: jest.fn().mockReturnValue(cachedSwitchService),
      addService: jest.fn().mockReturnValue(cachedSwitchService),
      removeService: jest.fn(),
      services: [mockService, cachedSwitchService],
      displayName: 'HomeKit Custom Name',
      UUID: 'test-uuid',
      context: { nodeId: 2, homeId: 12345 },
    };
    platform.accessories = [cachedAccessory];

    accessory = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );

    expect(cachedSwitchService.removeCharacteristic).toHaveBeenCalledWith(statusFaultChar);
    expect(cachedSwitchService.removeCharacteristic).toHaveBeenCalledWith(statusTamperedChar);
    expect(cachedAccessory.context.cacheRepairVersion).toBe(ACCESSORY_CACHE_REPAIR_VERSION);
    expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([cachedAccessory]);
  });

  it('should prune unsupported cached ServiceLabelIndex from actuator services', () => {
    const serviceLabelIndexChar = { UUID: 'ServiceLabelIndex' };
    const cachedSwitchService = {
      ...mockService,
      UUID: '00000049-0000-1000-8000-0026BB765291',
      testCharacteristic: jest.fn().mockImplementation(
        (char) => char === platform.Characteristic.ServiceLabelIndex,
      ),
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.ServiceLabelIndex) {
          return serviceLabelIndexChar;
        }
        return mockService.getCharacteristic();
      }),
      removeCharacteristic: jest.fn(),
    };

    const cachedAccessory = {
      getService: jest
        .fn()
        .mockImplementation((serviceType: string) =>
          serviceType === platform.Service.AccessoryInformation ? mockService : undefined,
        ),
      getServiceById: jest.fn().mockReturnValue(cachedSwitchService),
      addService: jest.fn().mockReturnValue(cachedSwitchService),
      removeService: jest.fn(),
      services: [mockService, cachedSwitchService],
      displayName: 'HomeKit Custom Name',
      UUID: 'test-uuid',
      context: { nodeId: 2, homeId: 12345 },
    };
    platform.accessories = [cachedAccessory];

    accessory = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );

    expect(cachedSwitchService.removeCharacteristic).toHaveBeenCalledWith(serviceLabelIndexChar);
    expect(cachedAccessory.context.cacheRepairVersion).toBe(ACCESSORY_CACHE_REPAIR_VERSION);
    expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([cachedAccessory]);
  });

  it('should skip cache repair once the accessory has already been migrated', () => {
    const configuredNameChar = { UUID: platform.Characteristic.ConfiguredName };
    const cachedSwitchService = {
      ...mockService,
      UUID: '00000049-0000-1000-8000-0026BB765291',
      testCharacteristic: jest.fn().mockImplementation(
        (char) => char === platform.Characteristic.ConfiguredName,
      ),
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.ConfiguredName) {
          return configuredNameChar;
        }
        return mockService.getCharacteristic();
      }),
      removeCharacteristic: jest.fn(),
    };

    const cachedAccessory = {
      getService: jest
        .fn()
        .mockImplementation((serviceType: string) =>
          serviceType === platform.Service.AccessoryInformation ? mockService : undefined,
        ),
      getServiceById: jest.fn().mockReturnValue(cachedSwitchService),
      addService: jest.fn().mockReturnValue(cachedSwitchService),
      removeService: jest.fn(),
      services: [mockService, cachedSwitchService],
      displayName: 'HomeKit Custom Name',
      UUID: 'test-uuid',
      context: {
        nodeId: 2,
        homeId: 12345,
        cacheRepairVersion: ACCESSORY_CACHE_REPAIR_VERSION,
      },
    };
    platform.accessories = [cachedAccessory];

    accessory = new ZWaveAccessory(
      platform as unknown as ZWaveUsbPlatform,
      node as IZWaveNode,
      12345,
    );

    expect(cachedSwitchService.removeCharacteristic).not.toHaveBeenCalled();
  });

  it('should not prune cached services during initialize', () => {
    const extraCachedService = {
      ...mockService,
      UUID: 'extra-service-uuid',
      displayName: 'Extra Cached Service',
    };
    accessory.platformAccessory.services = [mockService, extraCachedService];
    accessory.addFeature({
      init: jest.fn(),
      update: jest.fn(),
      getServices: () => [mockService],
      getEndpointIndex: () => 0,
      stop: jest.fn(),
      updateNode: jest.fn(),
      rename: jest.fn(),
    });

    accessory.initialize();

    expect(accessory.platformAccessory.removeService).not.toHaveBeenCalled();
  });

  it('should mark the first managed functional service as primary during initialize', () => {
    const featureService = {
      ...mockService,
      setPrimaryService: jest.fn(),
    };

    accessory.addFeature({
      init: jest.fn(),
      update: jest.fn(),
      getServices: () => [featureService],
      getEndpointIndex: () => 0,
      stop: jest.fn(),
      updateNode: jest.fn(),
      rename: jest.fn(),
    });

    accessory.initialize();

    expect(featureService.setPrimaryService).toHaveBeenCalledWith(true);
  });

  it('should prune stale cached services during explicit graph reconcile only', () => {
    const extraCachedService = {
      ...mockService,
      UUID: 'extra-service-uuid',
      displayName: 'Extra Cached Service',
    };
    accessory.platformAccessory.services = [mockService, extraCachedService];
    accessory.addFeature({
      init: jest.fn(),
      update: jest.fn(),
      getServices: () => [mockService],
      getEndpointIndex: () => 0,
      stop: jest.fn(),
      updateNode: jest.fn(),
      rename: jest.fn(),
    });

    accessory.initialize({ pruneUnmanagedServices: true });

    expect(accessory.platformAccessory.removeService).toHaveBeenCalledWith(extraCachedService);
  });

  it('should retry initialization after a feature init failure instead of staying wedged', () => {
    let shouldFail = true;
    const failingFeature = {
      init: jest.fn().mockImplementation(() => {
        if (shouldFail) {
          throw new Error('boom');
        }
      }),
      update: jest.fn(),
      getServices: () => [mockService],
      getEndpointIndex: () => 0,
      stop: jest.fn(),
      updateNode: jest.fn(),
      rename: jest.fn(),
    };
    const healthyFeature = {
      init: jest.fn(),
      update: jest.fn(),
      getServices: () => [mockService],
      getEndpointIndex: () => 0,
      stop: jest.fn(),
      updateNode: jest.fn(),
      rename: jest.fn(),
    };

    accessory.addFeature(failingFeature as any);
    accessory.addFeature(healthyFeature as any);

    expect(() => accessory.initialize()).toThrow('boom');
    expect(accessory.isInitialized()).toBe(false);
    expect(platform.api.updatePlatformAccessories).not.toHaveBeenCalledWith([
      accessory.platformAccessory,
    ]);
    expect(healthyFeature.stop).not.toHaveBeenCalled();

    shouldFail = false;

    expect(() => accessory.initialize()).not.toThrow();
    expect(accessory.isInitialized()).toBe(true);
    expect(failingFeature.init).toHaveBeenCalledTimes(2);
    expect(healthyFeature.init).toHaveBeenCalledTimes(1);
  });

  it('should update StatusTampered from Home Security tamper notifications on sensor services', () => {
    const tamperedChar = { updateValue: jest.fn() };
    const sensorService = {
      ...mockService,
      subtype: '0',
      UUID: '00000085-0000-1000-8000-0026BB765291',
      testCharacteristic: jest.fn().mockImplementation(
        (char) =>
          char === platform.Characteristic.StatusFault || char === platform.Characteristic.StatusTampered,
      ),
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.StatusTampered) {
          return tamperedChar;
        }
        return mockService.getCharacteristic();
      }),
    };

    accessory.platformAccessory.services = [mockService, sensorService];
    node.supportsCC = jest.fn().mockImplementation((cc) => cc === 113);
    node.getDefinedValueIDs = jest.fn().mockReturnValue([
      {
        commandClass: 113,
        endpoint: 0,
        property: 'Home Security',
        propertyKey: 'Cover status',
      },
    ]);
    node.getValueMetadata = jest.fn().mockReturnValue({
      states: {
        '0': 'idle',
        '3': 'Tampering, product cover removed',
      },
    });
    node.getValue = jest.fn().mockReturnValue(3);

    accessory.refresh();

    expect(sensorService.getCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusTampered,
    );
    expect(tamperedChar.updateValue).toHaveBeenCalledWith(
      platform.Characteristic.StatusTampered.TAMPERED,
    );
  });

  it('should update StatusTampered from Binary Sensor tamper values', () => {
    const tamperedChar = { updateValue: jest.fn() };
    const sensorService = {
      ...mockService,
      subtype: '2',
      UUID: '00000085-0000-1000-8000-0026BB765291',
      testCharacteristic: jest.fn().mockImplementation(
        (char) =>
          char === platform.Characteristic.StatusFault || char === platform.Characteristic.StatusTampered,
      ),
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.StatusTampered) {
          return tamperedChar;
        }
        return mockService.getCharacteristic();
      }),
    };

    accessory.platformAccessory.services = [mockService, sensorService];
    node.supportsCC = jest.fn().mockImplementation((cc) => cc === 48);
    node.getValue = jest.fn().mockImplementation((valueId) => {
      if (valueId.commandClass === 48 && valueId.property === 'Tamper' && valueId.endpoint === 2) {
        return true;
      }
      return undefined;
    });

    accessory.refresh();

    expect(sensorService.getCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusTampered,
    );
    expect(tamperedChar.updateValue).toHaveBeenCalledWith(
      platform.Characteristic.StatusTampered.TAMPERED,
    );
  });

  it('should read tamper state from endpoint-specific CC support even when the node root does not advertise it', () => {
    const tamperedChar = { updateValue: jest.fn() };
    const sensorService = {
      ...mockService,
      subtype: '2',
      UUID: '00000085-0000-1000-8000-0026BB765291',
      getCharacteristic: jest.fn().mockImplementation((char) => {
        if (char === platform.Characteristic.StatusTampered) {
          return tamperedChar;
        }
        return mockService.getCharacteristic();
      }),
    };

    accessory.platformAccessory.services = [mockService, sensorService];
    node.supportsCC = jest.fn().mockReturnValue(false);
    node.getAllEndpoints = jest.fn().mockReturnValue([
      { index: 0, supportsCC: jest.fn().mockReturnValue(false) },
      {
        index: 2,
        supportsCC: jest.fn().mockImplementation((cc) => cc === 48),
      },
    ]);
    node.getValue = jest.fn().mockImplementation((valueId) => {
      if (valueId.commandClass === 48 && valueId.property === 'Tamper' && valueId.endpoint === 2) {
        return true;
      }
      return undefined;
    });

    accessory.refresh();

    expect(tamperedChar.updateValue).toHaveBeenCalledWith(
      platform.Characteristic.StatusTampered.TAMPERED,
    );
  });
});
