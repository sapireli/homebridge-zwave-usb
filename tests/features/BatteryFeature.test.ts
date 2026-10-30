import { API, HAP, PlatformConfig } from 'homebridge';
import { ZWaveNode, Endpoint } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { BatteryFeature } from '../../src/features/BatteryFeature';
import { PLATFORM_NAME } from '../../src/platform/settings';

describe('BatteryFeature', () => {
  let api: jest.Mocked<API>;
  let hap: HAP;
  let platform: ZWaveUsbPlatform;
  let node: jest.Mocked<ZWaveNode>;
  let endpoint: jest.Mocked<Endpoint>;
  let feature: BatteryFeature;
  let batteryService: any;

  beforeEach(() => {
    batteryService = {
      getCharacteristic: jest.fn().mockReturnValue({
        on: jest.fn().mockReturnThis(),
        onGet: jest.fn().mockReturnThis(),
        updateValue: jest.fn(),
        setProps: jest.fn().mockReturnThis(),
      }),
      updateCharacteristic: jest.fn(),
      testCharacteristic: jest.fn().mockReturnValue(true),
      updateCharacteristic: jest.fn().mockReturnThis(),
      setPrimaryService: jest.fn(),
      addOptionalCharacteristic: jest.fn(),
      setCharacteristic: jest.fn().mockReturnThis(),
    };

    hap = {
      Service: {
        Battery: jest.fn(),
      } as any,
      Characteristic: {
        BatteryLevel: 'BatteryLevel',
        StatusLowBattery: {
          BATTERY_LEVEL_NORMAL: 0,
          BATTERY_LEVEL_LOW: 1,
        },
        Name: 'Name',
        ConfiguredName: 'ConfiguredName',
      } as any,
      uuid: {
        generate: jest.fn().mockReturnValue('test-uuid'),
      },
    } as any;

    api = {
      hap,
      registerPlatform: jest.fn(),
      registerPlatformAccessories: jest.fn(),
      on: jest.fn(),
      user: { storagePath: jest.fn().mockReturnValue('/tmp') },
      user: {
        storagePath: jest.fn().mockReturnValue('/tmp'),
      },
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
      nodeId: 1,
      getValue: jest.fn(),
    } as any;

    endpoint = {
      index: 0,
      node: node,
    } as any;

    const accessory = {
      getService: jest.fn(),
      getServiceById: jest.fn(),
      addService: jest.fn().mockReturnValue(batteryService),
    } as any;

    feature = new BatteryFeature(platform, accessory, endpoint, node);
  });

  it('should report battery level correctly', () => {
    feature.init();
    node.getValue.mockReturnValue(85);
    feature.update();
    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.BatteryLevel,
      85,
    );
    expect(node.getValue).toHaveBeenCalledWith({
      commandClass: CommandClasses.Battery,
      property: 'level',
      endpoint: 0,
    });
  });

  it('should report low battery status based on isLow property', () => {
    feature.init();
    node.getValue.mockImplementation((vid) => {
      if (vid.property === 'isLow') return true;
      if (vid.property === 'level') return 10;
      return undefined;
    });
    feature.update();
    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
  });

  it('should report low battery status based on level if isLow is missing', () => {
    feature.init();
    node.getValue.mockImplementation((vid) => {
      if (vid.property === 'isLow') return undefined;
      if (vid.property === 'level') return 5;
      return undefined;
    });
    feature.update();
    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
  });

  it('should prioritize explicit Power Management normal alarm over low percentage', () => {
    feature.init();
    node.getValue.mockImplementation((vid) => {
      if (vid.commandClass === CommandClasses.Notification && vid.property === 'Power Management') {
        if (vid.propertyKey === 'Replace battery soon status') return 0;
        return undefined;
      }
      if (vid.commandClass === CommandClasses.Battery && vid.property === 'isLow') return undefined;
      if (vid.commandClass === CommandClasses.Battery && vid.property === 'level') return 5;
      return undefined;
    });

    feature.update();

    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  });

  it('should set low battery from Power Management notification event', () => {
    feature.init();
    feature.update({
      commandClass: CommandClasses.Notification,
      property: 'Power Management',
      newValue: 11,
      endpoint: 0,
    });

    expect(batteryService.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
  });
});

describe('BatteryFeature unknown and last-known levels', () => {
  const RSZ1 = { manufacturerId: 0x026e, productType: 0x5253, productId: 0x5a31 };
  const UNKNOWN_DEVICE = { manufacturerId: 0x1234, productType: 0x0001, productId: 0x0001 };

  class HapStatusError extends Error {
    constructor(public readonly hapStatus: number) {
      super(`HapStatusError ${hapStatus}`);
    }
  }

  let service: any;
  let platform: any;
  let accessory: any;
  let node: any;
  let servedEndpoint: any;

  const createFeature = (
    fingerprint: Record<string, number>,
    batteryGet?: jest.Mock,
    endpointIndex = 0,
  ): BatteryFeature => {
    node = {
      nodeId: 5,
      ...fingerprint,
      getValue: jest.fn().mockReturnValue(undefined),
      // The node also exposes endpoint 0's APIs. The feature must not read from here.
      commandClasses: { Battery: { get: jest.fn() } },
    };

    servedEndpoint = {
      index: endpointIndex,
      commandClasses: batteryGet ? { Battery: { get: batteryGet } } : undefined,
    };

    return new BatteryFeature(platform, accessory, servedEndpoint as any, node);
  };

  beforeEach(() => {
    service = {
      getCharacteristic: jest.fn().mockReturnValue({
        onGet: jest.fn().mockReturnThis(),
        updateValue: jest.fn().mockReturnThis(),
        setProps: jest.fn().mockReturnThis(),
        value: undefined,
      }),
      updateCharacteristic: jest.fn().mockReturnThis(),
      testCharacteristic: jest.fn().mockReturnValue(true),
      addOptionalCharacteristic: jest.fn(),
      addCharacteristic: jest.fn(),
      setCharacteristic: jest.fn().mockReturnThis(),
      UUID: '00000096-0000-1000-8000-0026BB765291',
      displayName: 'Battery',
    };

    accessory = {
      displayName: "Nico's Shade",
      context: {},
      getService: jest.fn().mockReturnValue(service),
      getServiceById: jest.fn().mockReturnValue(service),
      addService: jest.fn().mockReturnValue(service),
    };

    platform = {
      log: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
      api: {
        hap: { HapStatusError },
        updatePlatformAccessories: jest.fn(),
      },
      Service: { Battery: class {} },
      Characteristic: {
        BatteryLevel: 'BatteryLevel',
        StatusLowBattery: { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 },
        Name: 'Name',
        ConfiguredName: 'ConfiguredName',
        ServiceLabelIndex: 'ServiceLabelIndex',
      },
    };
  });

  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('reports the low-battery warning to the management page, keeping the last percentage', async () => {
    /**
     * The exact case the page could not see when it read the driver's values itself. Battery CC
     * replaces the 0xFF sentinel before the report is persisted, so the value database still
     * holds 42 and nothing in it records that the warning arrived. Only this feature remembers.
     */
    const batteryGet = jest
      .fn()
      .mockResolvedValueOnce({ level: 42 })
      .mockResolvedValue({ level: 0xff });
    const feature = createFeature(RSZ1, batteryGet);

    feature.init();
    await flush();
    expect(feature.batterySnapshot()).toEqual({ level: 42, low: false });

    // Past the guard that keeps the refresh from turning into a poll, as the sibling tests do.
    (feature as any).lastRefreshAt = 0;
    await (feature as any).refreshBatteryLevel('test');
    await flush();

    expect(feature.batterySnapshot()).toEqual({ level: 42, low: true });
  });

  it('reports nothing for a battery that has never been heard from', async () => {
    // The page needs this to tell a device with no battery from a battery reading empty.
    const feature = createFeature(UNKNOWN_DEVICE);

    feature.init();
    await flush();

    expect(feature.batterySnapshot()).toEqual({ level: undefined, low: false });
  });

  it('never polls the device to answer the management page', async () => {
    /**
     * The page lists every node every few seconds, so this must not turn into a poll the way
     * the HomeKit getter can, and it raises no HAP error of its own. An ordinary failure
     * reading the driver is still possible, and the caller contains that per node.
     */
    const batteryGet = jest.fn().mockResolvedValue({ level: 55 });
    const feature = createFeature(RSZ1, batteryGet);

    feature.init();
    await flush();
    const callsAfterInit = batteryGet.mock.calls.length;

    for (let i = 0; i < 5; i += 1) {
      expect(() => feature.batterySnapshot()).not.toThrow();
    }

    expect(batteryGet.mock.calls.length).toBe(callsAfterInit);
  });

  it('never reports an unknown battery as 0%', async () => {
    const feature = createFeature(UNKNOWN_DEVICE);
    feature.init();
    await flush();

    expect(() => (feature as any).handleGetBatteryLevel()).toThrow(HapStatusError);
    expect(service.updateCharacteristic).not.toHaveBeenCalledWith('BatteryLevel', 0);
  });

  it('reports a genuine 0% reading from the device', () => {
    const feature = createFeature(UNKNOWN_DEVICE);
    feature.init();
    node.getValue.mockImplementation((vid: any) => (vid.property === 'level' ? 0 : undefined));

    expect((feature as any).handleGetBatteryLevel()).toBe(0);
    expect((feature as any).handleGetStatusLowBattery()).toBe(1);
  });

  it('retains the last known level when the device stops reporting one', async () => {
    const feature = createFeature(UNKNOWN_DEVICE);
    feature.init();

    node.getValue.mockImplementation((vid: any) => (vid.property === 'level' ? 94 : undefined));
    feature.update();
    expect(service.updateCharacteristic).toHaveBeenCalledWith('BatteryLevel', 94);

    node.getValue.mockReturnValue(undefined);
    service.updateCharacteristic.mockClear();
    feature.update();
    await flush();

    expect((feature as any).handleGetBatteryLevel()).toBe(94);
    expect(service.updateCharacteristic).toHaveBeenCalledWith('BatteryLevel', 94);
    expect(service.updateCharacteristic).not.toHaveBeenCalledWith('BatteryLevel', 0);
  });

  it('restores the last known level from the accessory cache after a restart', () => {
    accessory.context = { batteryLevels: { '0': 88 } };
    const feature = createFeature(UNKNOWN_DEVICE);
    feature.init();

    expect((feature as any).handleGetBatteryLevel()).toBe(88);
  });

  it('persists a newly received level into the accessory context', () => {
    const feature = createFeature(UNKNOWN_DEVICE);
    feature.init();
    node.getValue.mockImplementation((vid: any) => (vid.property === 'level' ? 73 : undefined));

    feature.update();

    expect(accessory.context.batteryLevels).toEqual({ '0': 73 });
    expect(platform.api.updatePlatformAccessories).toHaveBeenCalledWith([accessory]);
  });

  it('logs a battery report that carries no numeric level', async () => {
    const feature = createFeature(UNKNOWN_DEVICE);
    feature.init();
    platform.log.debug.mockClear();

    feature.update({ commandClass: CommandClasses.Battery, property: 'level', endpoint: 0 });
    await flush();

    expect(platform.log.debug).toHaveBeenCalledWith(
      expect.stringContaining('report without a numeric level'),
    );
  });

  it('never publishes the low-battery sentinel as a percentage', async () => {
    // 0xFF is Battery CC's "low battery warning", not 255 percent.
    const batteryGet = jest.fn().mockResolvedValue({ level: 0xff });
    const feature = createFeature(RSZ1, batteryGet);

    feature.init();
    await flush();

    expect(service.updateCharacteristic).not.toHaveBeenCalledWith('BatteryLevel', 100);
    expect(service.updateCharacteristic).not.toHaveBeenCalledWith('BatteryLevel', 255);
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    expect(accessory.context.batteryLevels ?? {}).toEqual({});
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('battery is low without giving a level'),
    );
  });

  it('keeps the last known percentage when the low-battery sentinel arrives', async () => {
    const batteryGet = jest
      .fn()
      .mockResolvedValueOnce({ level: 42 })
      .mockResolvedValue({ level: 0xff });
    const feature = createFeature(RSZ1, batteryGet);

    feature.init();
    await flush();
    expect(service.updateCharacteristic).toHaveBeenCalledWith('BatteryLevel', 42);

    (feature as any).lastRefreshAt = 0;
    await (feature as any).refreshBatteryLevel('test');
    await flush();

    const levelWrites = service.updateCharacteristic.mock.calls.filter(
      ([type]: [unknown]) => type === 'BatteryLevel',
    );
    expect(levelWrites.map(([, value]: [unknown, unknown]) => value)).toEqual([42, 42]);
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
  });

  it('reads the level with an explicit Battery Get when the cached value is missing', async () => {
    const batteryGet = jest.fn().mockResolvedValue({ level: 95, disconnected: true });
    const feature = createFeature(RSZ1, batteryGet);

    feature.init();
    await flush();

    expect(batteryGet).toHaveBeenCalled();
    expect(service.updateCharacteristic).toHaveBeenCalledWith('BatteryLevel', 95);
    expect(platform.log.debug).toHaveBeenCalledWith(
      expect.stringContaining('report received with numeric level 95%'),
    );
  });

  it('publishes the level from a disconnected report like any other', async () => {
    const batteryGet = jest.fn().mockResolvedValue({ level: 95, disconnected: true });
    const feature = createFeature(UNKNOWN_DEVICE, batteryGet);

    feature.init();
    await flush();

    expect(batteryGet).toHaveBeenCalled();
    expect(service.updateCharacteristic).toHaveBeenCalledWith('BatteryLevel', 95);
  });

  /** Drives the feature to a remembered low-battery warning whose levelAtWarning is 42. */
  const rememberWarningAt42 = async (): Promise<BatteryFeature> => {
    const batteryGet = jest
      .fn()
      .mockResolvedValueOnce({ level: 42 })
      .mockResolvedValueOnce({ level: 0xff });
    const feature = createFeature(UNKNOWN_DEVICE, batteryGet);

    feature.init();
    await flush();
    (feature as any).lastRefreshAt = 0; // let the next refresh through the interval guard
    feature.updateNode(node, servedEndpoint);
    await flush();
    expect((feature as any).lowBatteryWarning).toBe(true);

    return feature;
  };

  it('keeps a remembered warning when a passive resync re-reads the same percentage', async () => {
    const feature = await rememberWarningAt42();

    // A passive resync re-reads the same 42%. zwave-js keeps its cached percentage when a
    // report carries 0xFF, so this is not evidence the battery recovered.
    node.getValue = jest.fn().mockReturnValue(42);
    feature.update({ commandClass: CommandClasses.Battery, property: 'level', endpoint: 0 });
    expect((feature as any).lowBatteryWarning).toBe(true);

    // The battery is replaced and the device reports something different.
    node.getValue = jest.fn().mockReturnValue(95);
    feature.update({ commandClass: CommandClasses.Battery, property: 'level', endpoint: 0 });
    expect((feature as any).lowBatteryWarning).toBe(false);
  });

  it('keeps the pushed notification value and a later read in agreement', async () => {
    const batteryGet = jest.fn().mockResolvedValue({ level: 0xff });
    const feature = createFeature(UNKNOWN_DEVICE, batteryGet);

    feature.init();
    await flush();
    expect((feature as any).lowBatteryWarning).toBe(true);

    jest.spyOn(feature as any, 'getLowBatteryAlarmStateFromEvent').mockReturnValue(false);
    feature.update({ commandClass: CommandClasses.Notification, property: 'alarmLevel' } as any);

    expect(service.updateCharacteristic).toHaveBeenLastCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    // The sentinel used to outrank the notification on every later read, so the pushed
    // value and the characteristic's own getter disagreed indefinitely.
    expect((feature as any).resolveStatusLowBattery(80)).toBe(
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
  });

  it('issues an explicit Get even when zwave-js already holds a percentage', async () => {
    const batteryGet = jest.fn().mockResolvedValue({ level: 0xff });
    const feature = createFeature(UNKNOWN_DEVICE, batteryGet);
    node.getValue = jest.fn().mockReturnValue(80);

    feature.init();
    await flush();

    expect(batteryGet).toHaveBeenCalled();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(
      platform.Characteristic.StatusLowBattery,
      platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
  });

  it('clears the warning on a fresh report at the same percentage', async () => {
    const feature = await rememberWarningAt42();

    node.getValue = jest.fn().mockReturnValue(42);
    feature.update({
      commandClass: CommandClasses.Battery,
      property: 'level',
      endpoint: 0,
      newValue: 42,
    });

    expect((feature as any).lowBatteryWarning).toBe(false);
  });

  it('does not let another numeric Battery value clear the warning', async () => {
    const feature = await rememberWarningAt42();

    // Battery CC also carries numeric values that say nothing about charge, such as the
    // temperature and maximum capacity of a Health Report.
    node.getValue = jest.fn().mockReturnValue(42);
    feature.update({
      commandClass: CommandClasses.Battery,
      property: 'temperature',
      endpoint: 0,
      newValue: 21,
    });

    expect((feature as any).lowBatteryWarning).toBe(true);
  });

  it('does not let a sentinel-valued report clear the warning it raises', async () => {
    const feature = await rememberWarningAt42();

    // zwave-js 15.20.1 replaces 0xFF before persisting, so this event does not arrive from
    // the driver today, but the dependency is declared with a caret range. The cached level
    // deliberately differs from the one the sentinel interrupted, so a guard that falls
    // through to comparing them does not pass this.
    node.getValue = jest.fn().mockReturnValue(95);
    feature.update({
      commandClass: CommandClasses.Battery,
      property: 'level',
      endpoint: 0,
      newValue: 0xff,
    });

    expect((feature as any).lowBatteryWarning).toBe(true);
  });

  it('reads the Battery API of the endpoint it serves, not the node', async () => {
    const batteryGet = jest.fn().mockResolvedValue({ level: 77 });
    const feature = createFeature(UNKNOWN_DEVICE, batteryGet, 2);

    feature.init();
    await flush();

    expect(batteryGet).toHaveBeenCalled();
    expect(node.commandClasses.Battery.get).not.toHaveBeenCalled();
    expect(accessory.context.batteryLevels).toEqual({ '2': 77 });
  });

  it('logs when no report is received at all', async () => {
    const batteryGet = jest.fn().mockResolvedValue(undefined);
    const feature = createFeature(RSZ1, batteryGet);

    feature.init();
    await flush();

    expect(platform.log.debug).toHaveBeenCalledWith(expect.stringContaining('no report received'));
  });

  it('logs when a last known value is used instead of a fresh reading', async () => {
    accessory.context = { batteryLevels: { '0': 91 } };
    const batteryGet = jest.fn().mockResolvedValue(undefined);
    const feature = createFeature(RSZ1, batteryGet);

    feature.init();
    await flush();

    expect(platform.log.debug).toHaveBeenCalledWith(
      expect.stringContaining('using last known level 91%'),
    );
  });

  it('does not poll the device repeatedly for back-to-back reports', async () => {
    const batteryGet = jest.fn().mockResolvedValue({ level: 95, disconnected: true });
    const feature = createFeature(RSZ1, batteryGet);

    feature.init();
    await flush();

    for (let i = 0; i < 10; i++) {
      feature.update({ commandClass: CommandClasses.Battery, property: 'level', endpoint: 0 });
      await flush();
    }

    expect(batteryGet).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unknown low-battery status as a HomeKit error rather than "normal"', async () => {
    const feature = createFeature(UNKNOWN_DEVICE);
    feature.init();
    await flush();

    expect(() => (feature as any).handleGetStatusLowBattery()).toThrow(HapStatusError);
  });
});
