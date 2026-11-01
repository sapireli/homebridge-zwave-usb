import { WindowCoveringFeature } from '../../src/features/WindowCoveringFeature';

/** SetValueStatus values, which the driver delivers as numbers. */
const WORKING = 1;
const FAIL = 2;
const UNSUPERVISED = 254;
const SUPERVISED = 255;

const MULTILEVEL_SWITCH = 38;
const WINDOW_COVERING = 106;

const RSZ1 = { manufacturerId: 0x026e, productType: 0x5253, productId: 0x5a31, nodeId: 5 };

/**
 * Whether a promise has settled by now, without waiting for one that never will. Awaiting a
 * request the code should have answered hangs the run under fake timers instead of failing it,
 * which hides the defect behind a stalled suite. Ten microtask turns is far more than any
 * settlement here needs and still bounded.
 */
const settlementOf = async <T>(promise: Promise<T>) => {
  let outcome: { settled: boolean; value?: T; reason?: unknown } = { settled: false };
  void promise.then(
    (value) => {
      outcome = { settled: true, value };
    },
    (reason) => {
      outcome = { settled: true, reason };
    },
  );
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
  return outcome;
};

describe('WindowCoveringFeature', () => {
  let feature: WindowCoveringFeature;
  let platform: any;
  let accessory: any;
  let service: any;
  let node: any;
  let endpoint: any;
  let chars: Map<any, any>;
  /** What the simulated device holds, and what the driver's cache says about it. */
  let device: { position: number | undefined; cache: number | undefined; cachedTarget?: number };

  const charFor = (characteristic: any) => {
    let existing = chars.get(characteristic);
    if (!existing) {
      existing = {
        onSet: jest.fn().mockReturnThis(),
        onGet: jest.fn().mockReturnThis(),
        updateValue: jest.fn().mockReturnThis(),
        setProps: jest.fn().mockReturnThis(),
        value: 0,
      };
      chars.set(characteristic, existing);
    }
    return existing;
  };

  /** The handler most recently registered for a characteristic. */
  const setterFor = (characteristic: any) => {
    const calls = chars.get(characteristic)?.onSet.mock.calls ?? [];
    return calls[calls.length - 1]?.[0];
  };
  const getterFor = (characteristic: any) => {
    const calls = chars.get(characteristic)?.onGet.mock.calls ?? [];
    return calls[calls.length - 1]?.[0];
  };
  const move = (target: number) => setterFor('TargetPosition')(target);
  const hold = () => setterFor('HoldPosition')(true);
  const current = () => getterFor('CurrentPosition')();
  const target = () => getterFor('TargetPosition')();
  const motion = () => getterFor(platform.Characteristic.PositionState)();

  /** Lets queued promise continuations run without moving the clock. */
  const settle = () => jest.advanceTimersByTimeAsync(0);
  const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

  const logged = () =>
    [...platform.log.info.mock.calls, ...platform.log.debug.mock.calls].map((call) =>
      String(call[0]),
    );
  const expectLogged = (pattern: RegExp) =>
    expect(logged().some((line) => pattern.test(line))).toBe(true);
  const expectNotLogged = (pattern: RegExp) =>
    expect(logged().some((line) => pattern.test(line))).toBe(false);
  const warned = (pattern: RegExp) =>
    platform.log.warn.mock.calls.some((call: unknown[]) => pattern.test(String(call[0])));

  /** A device report as the driver emits it. */
  const report = (newValue: number, extra: Record<string, unknown> = {}) =>
    feature.update({
      commandClass: MULTILEVEL_SWITCH,
      property: 'currentValue',
      endpoint: 0,
      newValue,
      ...extra,
    } as any);

  /**
   * Builds the feature and lets its startup probe finish. Everything a test wants true of the
   * node at startup is configured before this is called.
   */
  const start = async (options: { restoredHapValue?: number } = {}) => {
    if (options.restoredHapValue !== undefined) {
      charFor('CurrentPosition').value = options.restoredHapValue;
      accessory.platformAccessory.getService.mockReturnValue(service);
      accessory.platformAccessory.getServiceById.mockReturnValue(service);
    }
    feature = new WindowCoveringFeature(platform, accessory.platformAccessory, endpoint, node);
    feature.init();
    await settle();

    return feature;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    chars = new Map();
    device = { position: 50, cache: 50 };

    service = {
      getCharacteristic: jest.fn((characteristic: any) => charFor(characteristic)),
      // Like HAP, publishing records the value the characteristic now holds.
      updateCharacteristic: jest.fn((characteristic: any, value: any) => {
        charFor(characteristic).value = value;
        return service;
      }),
      testCharacteristic: jest.fn().mockReturnValue(true),
      setPrimaryService: jest.fn(),
      addOptionalCharacteristic: jest.fn(),
      UUID: 'WindowCovering',
    };

    // A service that did not exist before is created, which is what a first run looks like.
    accessory = {
      displayName: 'Test Blinds',
      platformAccessory: {
        displayName: 'Test Blinds',
        getService: jest.fn().mockReturnValue(undefined),
        getServiceById: jest.fn().mockReturnValue(undefined),
        addService: jest.fn().mockReturnValue(service),
      },
      accessoryService: service,
    };

    platform = {
      Service: { WindowCovering: class WindowCovering {} },
      Characteristic: {
        CurrentPosition: 'CurrentPosition',
        TargetPosition: 'TargetPosition',
        PositionState: { DECREASING: 0, INCREASING: 1, STOPPED: 2 },
        HoldPosition: 'HoldPosition',
        Name: 'Name',
        ServiceLabelIndex: 'ServiceLabelIndex',
        StatusFault: 'StatusFault',
      },
      config: { debug: true },
      log: { debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      api: { hap: { HapStatusError: class extends Error {} } },
    };

    node = {
      id: 11,
      nodeId: 11,
      getValue: jest.fn((vid: any) =>
        vid.property === 'currentValue'
          ? device.cache
          : vid.property === 'targetValue'
            ? device.cachedTarget
            : undefined,
      ),
      setValue: jest.fn().mockResolvedValue({ status: UNSUPERVISED }),
      // Asking the device is how it is verified; the answer is wherever it really is.
      pollValue: jest.fn(async () => {
        device.cache = device.position;
        return device.position;
      }),
      supportsCC: jest.fn().mockReturnValue(true),
    };

    endpoint = {
      index: 0,
      supportsCC: jest.fn((cc: number) => cc === MULTILEVEL_SWITCH),
    };
  });

  afterEach(() => {
    feature?.stop();
    jest.useRealTimers();
  });

  describe('startup', () => {
    it('creates the window covering service', async () => {
      await start();

      expect(accessory.platformAccessory.getService).toHaveBeenCalledWith(
        platform.Service.WindowCovering,
      );
    });

    it('registers a getter on CurrentPosition that is actually used', async () => {
      device.position = 62;
      await start();

      expect(current()).toBe(62);
    });

    it('answers a read with a communication failure while the position is unknown', async () => {
      device.cache = undefined;
      device.position = undefined;
      await start();

      expect(() => current()).toThrow(platform.api.hap.HapStatusError);
      expect(() => target()).toThrow(platform.api.hap.HapStatusError);
      expect(() => motion()).toThrow(platform.api.hap.HapStatusError);
      expect(service.updateCharacteristic).not.toHaveBeenCalled();
    });

    it('does not take a newly created service default as a position anyone saw', async () => {
      device.cache = undefined;
      device.position = undefined;
      charFor('CurrentPosition').value = 0;
      await start();

      expect(() => current()).toThrow(platform.api.hap.HapStatusError);
    });

    it('shows the driver cache as a last-known position until the device answers', async () => {
      device.cache = 40;
      node.pollValue.mockImplementation(() => new Promise(() => undefined));
      await start();

      expect(current()).toBe(40);
      expect(service.updateCharacteristic).toHaveBeenCalledWith('CurrentPosition', 40);
    });

    it('replaces that last-known position with what the device answers', async () => {
      device.cache = 40;
      device.position = 62;
      await start();

      expect(current()).toBe(62);
      expect(target()).toBe(62);
    });

    it('prefers the position HomeKit last displayed over the driver cache', async () => {
      device.cache = 40;
      node.pollValue.mockImplementation(() => new Promise(() => undefined));
      await start({ restoredHapValue: 33 });

      expect(current()).toBe(33);
    });

    it('seeds from a Window Covering CC position found through its parameter key', async () => {
      node.getDefinedValueIDs = jest
        .fn()
        .mockReturnValue([
          { endpoint: 0, commandClass: WINDOW_COVERING, property: 'currentValue', propertyKey: 13 },
        ]);
      endpoint.supportsCC.mockImplementation((cc: number) => cc === WINDOW_COVERING);
      node.getValue.mockImplementation((vid: any) =>
        vid.propertyKey === 13 && vid.property === 'currentValue' ? 40 : undefined,
      );
      node.pollValue.mockImplementation(() => new Promise(() => undefined));
      await start();

      expect(current()).toBe(40);
    });

    it('refuses to move when it advertises Window Covering CC but keys no position', async () => {
      /**
       * This shape reads convincingly and cannot be driven, which is why it is not offered as a
       * type a user can choose. The position is resolved through the Multilevel Switch fallback,
       * so the covering reports where it is. Movement does not use that fallback: the command
       * class comes from `supportsCC`, so a Window Covering `targetValue` is built, and the
       * write is refused because no keyed Window Covering position exists to name.
       */
      node.getDefinedValueIDs = jest
        .fn()
        .mockReturnValue([
          { endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'currentValue' },
          { endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'targetValue' },
        ]);
      endpoint.supportsCC.mockImplementation((cc: number) => cc === WINDOW_COVERING);
      node.getValue.mockImplementation((vid: any) =>
        vid.commandClass === MULTILEVEL_SWITCH && vid.property === 'currentValue' ? 40 : undefined,
      );
      node.pollValue.mockImplementation(() => new Promise(() => undefined));
      await start();

      // It reports a position, which is what makes the shape look serviceable.
      expect(current()).toBe(40);

      // HomeKit is told the command failed, and nothing is transmitted.
      await expect(move(80)).rejects.toBeDefined();

      expect(node.setValue).not.toHaveBeenCalled();
      // Nothing reaches the device, and nothing is logged to explain the refusal either, which
      // is why the type is withheld rather than offered and left to fail in use.
      expectLogged(/HomeKit requested 80%/);
      expectNotLogged(/transmitting/);
    });

    it('prefers the keyed Window Covering position over a stale Multilevel Switch one', async () => {
      node.getDefinedValueIDs = jest
        .fn()
        .mockReturnValue([
          { endpoint: 0, commandClass: WINDOW_COVERING, property: 'currentValue', propertyKey: 13 },
        ]);
      node.getValue.mockImplementation((vid: any) => {
        if (vid.commandClass === WINDOW_COVERING && vid.propertyKey === 13) {
          return 72;
        }
        if (vid.commandClass === MULTILEVEL_SWITCH) {
          return 0;
        }
        return undefined;
      });
      node.pollValue.mockImplementation(() => new Promise(() => undefined));
      await start();

      expect(current()).toBe(72);
    });

    it('polls the position value of the endpoint it serves, parameter and all', async () => {
      node.getDefinedValueIDs = jest.fn().mockReturnValue([
        { endpoint: 0, commandClass: WINDOW_COVERING, property: 'currentValue', propertyKey: 13 },
        { endpoint: 2, commandClass: WINDOW_COVERING, property: 'currentValue', propertyKey: 7 },
      ]);
      endpoint = { index: 2, supportsCC: jest.fn((cc: number) => cc === WINDOW_COVERING) };
      accessory.platformAccessory.getServiceById.mockReturnValue(undefined);
      await start();

      expect(node.pollValue).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 2, propertyKey: 7, property: 'currentValue' }),
      );
    });

    it('finds a position value the node only defines after its interview', async () => {
      node.getDefinedValueIDs = jest.fn().mockReturnValue([]);
      endpoint.supportsCC.mockImplementation((cc: number) => cc === WINDOW_COVERING);
      device.cache = undefined;
      await start();
      expect(() => current()).toThrow(platform.api.hap.HapStatusError);
      expect(node.pollValue).not.toHaveBeenCalled();

      node.getDefinedValueIDs = jest
        .fn()
        .mockReturnValue([
          { endpoint: 0, commandClass: WINDOW_COVERING, property: 'currentValue', propertyKey: 13 },
        ]);
      device.position = 55;
      await advance(5100);

      expect(node.pollValue).toHaveBeenCalledWith(
        expect.objectContaining({ commandClass: WINDOW_COVERING, propertyKey: 13 }),
      );
      expect(current()).toBe(55);
    });

    it('does not keep polling a covering that defines no position value', async () => {
      node.getDefinedValueIDs = jest.fn().mockReturnValue([
        {
          endpoint: 0,
          commandClass: WINDOW_COVERING,
          property: 'levelChangeUp',
          propertyKey: 13,
        },
      ]);
      endpoint.supportsCC.mockImplementation((cc: number) => cc === WINDOW_COVERING);
      await start();

      await expect(move(40)).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);
      await advance(40000);

      expect(node.pollValue).not.toHaveBeenCalled();
    });

    it('gives up on a poll the device never answers and ignores it if it arrives later', async () => {
      let late: (value: number) => void = () => undefined;
      node.pollValue
        .mockImplementationOnce(
          () =>
            new Promise<number>((resolve) => {
              late = resolve;
            }),
        )
        .mockImplementation(async () => 20);
      device.cache = undefined;
      await start();

      // The first poll hangs; it is abandoned, then retried, and the retry is what is believed.
      await advance(10000 + 5100);
      expect(current()).toBe(20);

      late(77);
      await settle();
      expect(current()).toBe(20);
    });
  });

  describe('device reports', () => {
    it('publishes a position the device reports', async () => {
      await start();

      report(99);

      expect(service.updateCharacteristic).toHaveBeenCalledWith('CurrentPosition', 100);
      expect(current()).toBe(100);
    });

    it('ignores reports the driver made up itself', async () => {
      await start();

      report(20, { source: 'driver' });

      expect(current()).toBe(50);
    });

    it('does not take an untagged echo of a commanded target for the device answering', async () => {
      await start();
      await move(70);

      report(70);

      expect(current()).toBe(50);
    });

    it('does take a report the node explicitly sent at the commanded target', async () => {
      await start();
      await move(70);

      report(70, { source: 'node' });

      expect(current()).toBe(70);
    });

    it('never lets the cached target value decide anything', async () => {
      await start();

      feature.update({
        commandClass: MULTILEVEL_SWITCH,
        property: 'targetValue',
        endpoint: 0,
        newValue: 90,
      } as any);

      expect(target()).toBe(50);
    });

    it('ignores another command class or endpoint', async () => {
      await start();
      service.updateCharacteristic.mockClear();

      feature.update({
        commandClass: 37,
        property: 'currentValue',
        endpoint: 0,
        newValue: 5,
      } as any);
      feature.update({
        commandClass: MULTILEVEL_SWITCH,
        property: 'currentValue',
        endpoint: 3,
        newValue: 5,
      } as any);

      expect(current()).toBe(50);
      expect(service.updateCharacteristic).not.toHaveBeenCalled();
    });

    it('does not republish values the characteristics already hold', async () => {
      await start();
      service.updateCharacteristic.mockClear();

      feature.update();
      report(50, { source: 'node' });

      expect(service.updateCharacteristic).not.toHaveBeenCalled();
    });

    it('republishes the projection on a full refresh', async () => {
      await start();
      charFor('CurrentPosition').value = 1;

      feature.update();

      expect(service.updateCharacteristic).toHaveBeenCalledWith('CurrentPosition', 50);
    });
  });

  describe('write path', () => {
    it('sends a position to the target value', async () => {
      await start();

      await move(50);

      expect(node.setValue).toHaveBeenCalledWith(
        expect.objectContaining({ property: 'targetValue' }),
        50,
      );
    });

    it('falls back to Multilevel Switch CC when Window Covering CC is absent', async () => {
      await start();

      await move(25);

      expect(node.setValue).toHaveBeenCalledWith(
        expect.objectContaining({
          commandClass: MULTILEVEL_SWITCH,
          property: 'targetValue',
          endpoint: 0,
        }),
        25,
      );
    });

    it('maps HomeKit 100% onto the Z-Wave maximum of 99', async () => {
      await start();

      await move(100);

      expect(node.setValue).toHaveBeenCalledWith(expect.anything(), 99);
    });

    it('sends 0 unchanged for a fully closed covering', async () => {
      await start();

      await move(0);

      expect(node.setValue).toHaveBeenCalledWith(expect.anything(), 0);
    });

    it('prefers Window Covering CC when the endpoint implements it', async () => {
      endpoint.supportsCC.mockImplementation((cc: number) => cc === WINDOW_COVERING);
      node.getDefinedValueIDs = jest
        .fn()
        .mockReturnValue([
          { commandClass: WINDOW_COVERING, endpoint: 0, property: 'currentValue', propertyKey: 13 },
        ]);
      await start();

      await move(25);

      expect(node.setValue).toHaveBeenCalledWith(
        expect.objectContaining({
          commandClass: WINDOW_COVERING,
          property: 'targetValue',
          propertyKey: 13,
        }),
        25,
      );
    });

    it('rejects native covering writes when no parameter key can be resolved', async () => {
      endpoint.supportsCC.mockImplementation((cc: number) => cc === WINDOW_COVERING);
      node.getDefinedValueIDs = jest.fn().mockReturnValue([]);
      await start();
      await expect(move(25)).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);
      expect(node.setValue).not.toHaveBeenCalled();
    });

    it('uses the selected parameter for stop, even when another action appears first', async () => {
      endpoint.supportsCC.mockImplementation((cc: number) => cc === WINDOW_COVERING);
      node.getDefinedValueIDs = jest.fn().mockReturnValue([
        { commandClass: WINDOW_COVERING, endpoint: 0, property: 'currentValue', propertyKey: 13 },
        { commandClass: WINDOW_COVERING, endpoint: 0, property: 'levelChangeUp', propertyKey: 7 },
        {
          commandClass: WINDOW_COVERING,
          endpoint: 0,
          property: 'levelChangeDown',
          propertyKey: 13,
        },
      ]);
      await start();
      await hold();
      expect(node.setValue).toHaveBeenCalledWith(
        expect.objectContaining({ property: 'levelChangeDown', propertyKey: 13 }),
        false,
      );
    });

    it('ignores reports for another native covering parameter', async () => {
      endpoint.supportsCC.mockImplementation((cc: number) => cc === WINDOW_COVERING);
      node.getDefinedValueIDs = jest.fn().mockReturnValue([
        { commandClass: WINDOW_COVERING, endpoint: 0, property: 'currentValue', propertyKey: 13 },
        { commandClass: WINDOW_COVERING, endpoint: 0, property: 'currentValue', propertyKey: 7 },
      ]);
      await start();
      feature.update({
        commandClass: WINDOW_COVERING,
        property: 'currentValue',
        propertyKey: 13,
        endpoint: 0,
        newValue: 40,
        source: 'node',
      } as any);
      expect(current()).toBe(40);
      feature.update({
        commandClass: WINDOW_COVERING,
        property: 'currentValue',
        propertyKey: 7,
        endpoint: 0,
        newValue: 90,
        source: 'node',
      } as any);
      expect(current()).toBe(40);
    });

    it('logs the request and what was transmitted', async () => {
      await start();

      await move(100);

      expectLogged(/HomeKit requested 100%/);
      expectLogged(/transmitting TargetPosition 99 -> /);
      expect(platform.log.debug).toHaveBeenCalledWith(expect.stringContaining('Set end'));
    });

    it('still transmits when the position is not yet known', async () => {
      device.cache = undefined;
      device.position = undefined;
      await start();

      await move(40);

      expect(node.setValue).toHaveBeenCalledWith(expect.anything(), 40);
      expect(() => current()).toThrow(platform.api.hap.HapStatusError);
    });

    it('reports a thrown driver error to HomeKit', async () => {
      node.setValue.mockRejectedValue(new Error('transmit failed'));
      await start();

      await expect(move(25)).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);
      expect(platform.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Set failed'),
        expect.any(Error),
      );
    });

    it('reports a refused write to HomeKit even though the promise resolved', async () => {
      node.setValue.mockResolvedValue({ status: FAIL });
      await start();

      await expect(move(25)).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);
      expect(platform.log.error).toHaveBeenCalledWith(expect.stringContaining('Set rejected'));
    });

    it('accepts a supervised write that is still working', async () => {
      node.setValue.mockResolvedValue({ status: WORKING });
      await start();

      await expect(move(25)).resolves.toBeUndefined();
    });

    it('treats a Supervision success as the covering having reached the target', async () => {
      node.setValue.mockResolvedValue({ status: SUPERVISED });
      await start();

      await move(25);

      expect(current()).toBe(25);
      expect(motion()).toBe(platform.Characteristic.PositionState.STOPPED);
      expectLogged(/25% was confirmed by Supervision/);
    });

    it('does not keep a target the device refused', async () => {
      node.setValue.mockResolvedValue({ status: FAIL, message: 'no ack' });
      device.position = 70;
      await start();

      // HAP records the written value on its own before the handler runs.
      charFor('TargetPosition').value = 20;
      await expect(move(20)).rejects.toBeDefined();

      expect(target()).toBe(70);
      expect(service.updateCharacteristic).toHaveBeenCalledWith('TargetPosition', 70);
    });

    it('does not reconcile after a failed write', async () => {
      node.setValue.mockRejectedValue(new Error('nope'));
      await start();
      node.pollValue.mockClear();

      await expect(move(25)).rejects.toBeTruthy();
      await advance(6000);

      expect(node.pollValue).not.toHaveBeenCalled();
    });
  });

  describe('rapid consecutive requests', () => {
    beforeEach(() => {
      Object.assign(node, RSZ1);
    });

    it('transmits one command for a burst of slider updates', async () => {
      await start();

      // A drag produces writes a few hundred milliseconds apart.
      const first = move(60);
      await advance(250);
      const second = move(55);
      await advance(300);
      const third = move(40);

      await advance(700);
      await Promise.all([first, second, third]);

      expect(node.setValue).toHaveBeenCalledTimes(1);
      expect(node.setValue).toHaveBeenCalledWith(expect.anything(), 40);
    });

    it('resolves every superseded request so HomeKit is not left waiting', async () => {
      await start();

      const first = move(60);
      const second = move(55);
      const third = move(40);

      /**
       * Observed rather than awaited. Awaiting a promise that is never settled hangs the run
       * under fake timers instead of failing, which hides the defect behind a stalled suite.
       */
      expect(await settlementOf(first)).toEqual({ settled: true, value: undefined });
      expect(await settlementOf(second)).toEqual({ settled: true, value: undefined });
      expect(node.setValue).not.toHaveBeenCalled();

      await advance(700);
      expect(await settlementOf(third)).toEqual({ settled: true, value: undefined });
    });

    it('transmits both targets when the second request is a deliberate retarget', async () => {
      await start();

      const first = move(60);
      await advance(700);
      await first;

      const second = move(20);
      // The shade is given 1.5 s after the last write before it is sent another.
      await advance(2500);
      await second;

      expect(node.setValue).toHaveBeenCalledTimes(2);
      expect(node.setValue).toHaveBeenNthCalledWith(1, expect.anything(), 60);
      expect(node.setValue).toHaveBeenNthCalledWith(2, expect.anything(), 20);
    });

    it('still transmits a request that arrives while an earlier one is being followed', async () => {
      node.setValue.mockResolvedValue({ status: WORKING });
      await start();

      const first = move(80);
      await advance(700);
      await first;
      const second = move(20);
      await advance(2500);
      await second;

      expect(node.setValue).toHaveBeenLastCalledWith(expect.anything(), 20);
    });

    it('logs the request and the target that was transmitted', async () => {
      await start();

      const first = move(60);
      const second = move(40);
      await advance(700);
      await Promise.all([first, second]);

      expectLogged(/HomeKit requested 60%/);
      expectLogged(/transmitting TargetPosition 40 -> /);
    });

    it('reports a failed write to the request that was actually transmitted', async () => {
      node.setValue.mockRejectedValue(new Error('transmit failed'));
      await start();

      const first = move(60);
      const second = move(40);
      const secondSettled = expect(second).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);

      await advance(700);

      // Observed rather than awaited: a superseded request that is never answered would stall
      // the run instead of failing this test.
      expect(await settlementOf(first)).toEqual({ settled: true, value: undefined });
      await secondSettled;
    });

    it('still reports a refused stop to HomeKit', async () => {
      node.getDefinedValueIDs = jest
        .fn()
        .mockReturnValue([{ endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'Up' }]);
      node.setValue.mockResolvedValue({ status: FAIL, message: 'no ack' });
      await start();

      await expect(hold()).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);
    });

    it('holds a second move until 1.5 s after the first write finished', async () => {
      await start();
      void move(60);
      await advance(700);
      expect(node.setValue).toHaveBeenCalledTimes(1);

      void move(20);
      await advance(1000);
      expect(node.setValue).toHaveBeenCalledTimes(1);

      await advance(1500);
      expect(node.setValue).toHaveBeenCalledTimes(2);
      expect(node.setValue).toHaveBeenLastCalledWith(expect.anything(), 20);
    });

    it('sends a slider drag as one command when its samples arrive close together', async () => {
      await start();

      // Samples inside the 600 ms window replace each other; only the last is transmitted.
      void move(10);
      await advance(150);
      void move(40);
      await advance(150);
      void move(66);
      await advance(1000);

      expect(node.setValue).toHaveBeenCalledTimes(1);
      expect(node.setValue).toHaveBeenCalledWith(expect.anything(), 66);
    });

    it('releases a pending request when the feature stops', async () => {
      await start();

      const request = move(40);
      feature.stop();
      await expect(request).resolves.toBeUndefined();

      await advance(700);
      expect(node.setValue).not.toHaveBeenCalled();
    });

    it('transmits immediately for a device with no coalescing window', async () => {
      Object.assign(node, { manufacturerId: 0x0086, productType: 3, productId: 0x62, nodeId: 11 });
      await start();

      await move(30);

      expect(node.setValue).toHaveBeenCalledWith(expect.anything(), 30);
    });

    it('settles a request made after the feature stopped instead of leaving it hanging', async () => {
      await start();
      feature.stop();

      await expect(move(30)).resolves.toBeUndefined();
      expect(node.setValue).not.toHaveBeenCalled();
    });
  });

  describe('stopping', () => {
    // The node reports Down/Up actions; writing false to either stops the movement.
    const definedValues = [
      { endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'currentValue' },
      { endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'Up' },
      { endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'Down' },
    ];

    beforeEach(() => {
      node.getDefinedValueIDs = jest.fn().mockReturnValue(definedValues);
      device.position = 43;
      device.cache = 43;
      // The driver goes on caching the target the stop abandoned.
      device.cachedTarget = 0;
    });

    it('registers a HoldPosition handler', async () => {
      await start();

      expect(setterFor('HoldPosition')).toEqual(expect.any(Function));
    });

    it('stops the covering by writing false to a level change action', async () => {
      await start();

      await hold();

      expect(node.setValue).toHaveBeenCalledWith(
        expect.objectContaining({ commandClass: MULTILEVEL_SWITCH, property: 'Up', endpoint: 0 }),
        false,
      );
    });

    it('ignores a write of false, which is not a stop request', async () => {
      await start();

      await setterFor('HoldPosition')(false);

      expect(node.setValue).not.toHaveBeenCalled();
    });

    it('prefers Window Covering CC when the device reports it', async () => {
      node.getDefinedValueIDs.mockReturnValue([
        { endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'Up' },
        {
          endpoint: 0,
          commandClass: WINDOW_COVERING,
          property: 'levelChangeUp',
          propertyKey: 13,
        },
      ]);
      await start();

      await hold();

      expect(node.setValue).toHaveBeenCalledWith(
        expect.objectContaining({
          commandClass: WINDOW_COVERING,
          property: 'levelChangeUp',
          propertyKey: 13,
        }),
        false,
      );
    });

    it('reports a device that cannot be stopped', async () => {
      node.getDefinedValueIDs.mockReturnValue([
        { endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'currentValue' },
      ]);
      await start();

      await expect(hold()).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);
      expect(node.setValue).not.toHaveBeenCalled();
      expect(warned(/does not report a way to stop the covering/)).toBe(true);
    });

    it('lets a position request that arrives during a stop go out once the stop is done', async () => {
      let releaseStop: (value: unknown) => void = () => undefined;
      node.setValue.mockImplementation((valueId: any) =>
        valueId.property === 'targetValue'
          ? Promise.resolve({ status: UNSUPERVISED })
          : new Promise((resolve) => {
              releaseStop = resolve;
            }),
      );
      await start();

      const stopping = hold();
      const moving = move(60);
      await settle();
      expect(node.setValue).toHaveBeenCalledTimes(1);

      releaseStop({ status: UNSUPERVISED });
      await stopping;
      await moving;
      await settle();

      expect(node.setValue).toHaveBeenLastCalledWith(
        expect.objectContaining({ property: 'targetValue' }),
        60,
      );
      expect(target()).toBe(60);
    });

    it('does not push HomeKit back to the target a stop abandoned', async () => {
      await start();

      await hold();
      await advance(6000);

      expect(service.updateCharacteristic).not.toHaveBeenCalledWith('TargetPosition', 0);
      expect(target()).toBe(43);
      expect(motion()).toBe(platform.Characteristic.PositionState.STOPPED);
    });

    it('holds the position it reached while the covering is still coasting', async () => {
      await start();

      await hold();

      expect(target()).toBe(43);
      expect(motion()).toBe(platform.Characteristic.PositionState.STOPPED);
    });

    it('follows the covering to where it finally rests, not where the stop was sent', async () => {
      await start();

      await hold();
      device.position = 30; // it drifted on after the stop was sent
      await advance(13000);

      expect(target()).toBe(30);
      expect(service.updateCharacteristic).toHaveBeenCalledWith('TargetPosition', 30);
      expectLogged(/a stop was carried out; the covering reports 30%/);
    });

    it('reports the covering as stopped while it coasts to a halt', async () => {
      await start();

      await hold();
      report(40, { source: 'node' });

      expect(motion()).toBe(platform.Characteristic.PositionState.STOPPED);
      expect(target()).toBe(40);
    });

    it('does not call a stop settled while the covering is still drifting', async () => {
      await start();

      await hold();
      let position = 43;
      node.pollValue.mockImplementation(async () => {
        position -= 3;
        return position;
      });
      await advance(8000);

      expectNotLogged(/a stop was carried out/);
    });

    it('releases the stopped position when HomeKit asks the covering to move again', async () => {
      await start();
      await hold();
      await advance(6000);
      expect(target()).toBe(43);

      await move(80);

      expect(target()).toBe(80);
    });

    it('follows a device-announced position after a stop', async () => {
      await start();
      await hold();
      await advance(6000);
      expect(target()).toBe(43);

      report(70, { source: 'node' });

      expect(current()).toBe(70);
      expect(target()).toBe(70);
    });

    it('lets a request coalesced behind a stop take over', async () => {
      Object.assign(node, RSZ1);
      let releaseStop: (value: unknown) => void = () => undefined;
      node.setValue.mockImplementation((valueId: any) =>
        valueId.property === 'targetValue'
          ? Promise.resolve({ status: UNSUPERVISED })
          : new Promise((resolve) => {
              releaseStop = resolve;
            }),
      );
      await start();

      const stopping = hold();
      const moving = move(80);
      releaseStop({ status: UNSUPERVISED });
      await stopping;
      await advance(2500);
      await moving;

      expect(target()).toBe(80);
    });

    it('keeps the stopped position when a following move is refused', async () => {
      await start();
      await hold();
      await advance(6000);
      expect(target()).toBe(43);

      node.setValue.mockResolvedValue({ status: FAIL, message: 'no ack' });
      charFor('TargetPosition').value = 80;
      await expect(move(80)).rejects.toBeDefined();

      expect(target()).toBe(43);
      expect(service.updateCharacteristic).toHaveBeenCalledWith('TargetPosition', 43);
    });

    it('restores the stopped position when a coalesced burst is refused', async () => {
      Object.assign(node, RSZ1);
      await start();
      await hold();
      await advance(6000);

      node.setValue.mockResolvedValue({ status: FAIL, message: 'no ack' });
      const burst = move(80);
      const settled = expect(burst).rejects.toBeDefined();
      await advance(1000);
      await settled;

      expect(target()).toBe(43);
    });

    it('drops a held request when a stop the device cannot perform arrives', async () => {
      Object.assign(node, RSZ1);
      await start();
      await hold();
      await advance(6000);

      const dragged = move(80);
      node.getDefinedValueIDs = jest.fn().mockReturnValue([]);
      await expect(hold()).rejects.toBeDefined();
      await dragged;

      expect(target()).toBe(43);
    });

    it('keeps reconciling an accepted command when the covering cannot be stopped', async () => {
      node.getDefinedValueIDs.mockReturnValue([
        { endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'currentValue' },
      ]);
      node.setValue.mockResolvedValue({ status: WORKING });
      await start();

      await move(70);
      await expect(hold()).rejects.toBeDefined();
      device.position = 70;
      await advance(4000);

      expectLogged(/70% was carried out; the covering reports 70%/);
    });

    it('lets a write still in flight finish when a stop is refused meanwhile', async () => {
      let releaseMove: () => void = () => undefined;
      node.setValue.mockImplementation((valueId: any) =>
        valueId.property === 'targetValue'
          ? new Promise((resolve) => {
              releaseMove = () => resolve({ status: WORKING });
            })
          : Promise.resolve({ status: FAIL, message: 'no ack' }),
      );
      await start();

      const moving = move(70);
      const stopping = hold();
      const stopSettled = expect(stopping).rejects.toBeDefined();
      releaseMove();
      await moving;
      await stopSettled;
      device.position = 70;
      await advance(4000);

      expectLogged(/70% was carried out; the covering reports 70%/);
    });

    it('does not reconcile a write that was in flight when the feature stopped', async () => {
      let releaseWrite: () => void = () => undefined;
      node.setValue.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseWrite = () => resolve({ status: UNSUPERVISED });
          }),
      );
      await start();
      node.pollValue.mockClear();

      const moving = move(80);
      feature.stop();
      releaseWrite();
      await moving;
      await advance(6000);

      expect(node.pollValue).not.toHaveBeenCalled();
    });

    it('never calls a stop settled when the device cannot be asked', async () => {
      delete node.pollValue;
      await start();

      await hold();
      await advance(70000);

      expectNotLogged(/a stop was carried out/);
      expect(warned(/still unconfirmed 60s after a stop/)).toBe(true);
    });

    it('warns that a stop is unconfirmed when the covering never comes to rest', async () => {
      await start();

      await hold();
      let position = 43;
      node.pollValue.mockImplementation(async () => {
        position = (position + 7) % 100;
        return position;
      });
      await advance(65000);

      expect(warned(/still unconfirmed 60s after a stop/)).toBe(true);
      expectNotLogged(/a stop was carried out/);
    });
  });

  describe('post-write reconciliation', () => {
    it('ignores a poll that outlives the command it belonged to', async () => {
      device.position = 81;
      await start();
      node.setValue.mockResolvedValue({ status: WORKING });

      let releasePoll: (value: number) => void = () => undefined;
      node.pollValue.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            releasePoll = resolve;
          }),
      );

      await move(25);
      await advance(2100);

      // A newer command takes over while the first command's poll is still out.
      await move(60);
      releasePoll(25);
      await advance(15000);

      expect(warned(/instead of reaching it/)).toBe(true);
      expect(warned(/accepted 25%/)).toBe(false);
      expectNotLogged(/25% was carried out/);
    });

    it('polls the position value the device actually defines, parameter and all', async () => {
      node.getDefinedValueIDs = jest.fn().mockReturnValue([
        { endpoint: 0, commandClass: WINDOW_COVERING, property: 'currentValue', propertyKey: 13 },
        { endpoint: 0, commandClass: WINDOW_COVERING, property: 'levelChangeUp', propertyKey: 13 },
      ]);
      endpoint.supportsCC.mockImplementation((cc: number) => cc === WINDOW_COVERING);
      device.position = 40;
      await start();
      node.pollValue.mockClear();

      await move(40);
      await advance(2100);

      expect(node.pollValue).toHaveBeenCalledWith(
        expect.objectContaining({
          commandClass: WINDOW_COVERING,
          property: 'currentValue',
          propertyKey: 13,
        }),
      );
    });

    it('asks the device even when the driver optimistically echoes the position', async () => {
      device.position = 100;
      device.cache = 100;
      await start();
      node.setValue.mockImplementation(async () => {
        // The driver's optimistic currentValue update, emitted as the write resolves.
        report(66);
        return { status: UNSUPERVISED };
      });
      node.pollValue.mockClear();
      node.pollValue.mockImplementation(async () => 67);

      await move(66);
      await advance(4000);

      expect(node.pollValue).toHaveBeenCalled();
      expectLogged(/66% was carried out; the covering reports 67%/);
      expect(platform.log.warn).not.toHaveBeenCalled();
    });

    it('does not let a failed older write cancel a newer command', async () => {
      let rejectFirst: (err: Error) => void = () => undefined;
      node.setValue
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject;
            }),
        )
        .mockResolvedValue({ status: UNSUPERVISED });
      device.position = 90;
      await start();

      const first = move(10);
      const firstSettled = expect(first).rejects.toBeDefined();
      const second = move(90);

      rejectFirst(new Error('no ack'));
      await firstSettled;
      await second;
      await advance(4000);

      expectLogged(/90% was carried out/);
      expect(target()).toBe(90);
    });

    it('reconciles against the newest command when an older write finishes late', async () => {
      let resolveFirst: (value: unknown) => void = () => undefined;
      node.setValue
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue({ status: UNSUPERVISED });
      device.position = 90;
      await start();

      const first = move(10);
      const second = move(90);
      await settle();
      resolveFirst({ status: UNSUPERVISED });
      expect(await settlementOf(first)).toMatchObject({ settled: true });
      await second;
      await advance(6000);

      expect(node.setValue).toHaveBeenNthCalledWith(1, expect.anything(), 10);
      expect(node.setValue).toHaveBeenNthCalledWith(2, expect.anything(), 90);
      expect(warned(/accepted 10%/)).toBe(false);
      expectLogged(/90% was carried out/);
    });

    it('republishes the old target when a write is refused', async () => {
      node.setValue.mockResolvedValue({ status: FAIL, message: 'no ack' });
      device.position = 55;
      await start();
      service.updateCharacteristic.mockClear();

      charFor('TargetPosition').value = 20;
      await expect(move(20)).rejects.toBeDefined();

      expect(service.updateCharacteristic).toHaveBeenCalledWith('TargetPosition', 55);
    });

    it('keeps following an accepted command when a later write is refused', async () => {
      node.setValue
        .mockResolvedValueOnce({ status: WORKING })
        .mockResolvedValue({ status: FAIL, message: 'no ack' });
      await start();

      await move(70);
      await expect(move(20)).rejects.toBeDefined();
      device.position = 70;
      await advance(4000);

      expectLogged(/70% was carried out; the covering reports 70%/);
    });

    it('keeps following an accepted command when a later write is refused mid-reconcile', async () => {
      node.setValue.mockResolvedValueOnce({ status: WORKING });
      await start();

      await move(80);
      let rejectSecond: (err: Error) => void = () => undefined;
      node.setValue.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject;
          }),
      );
      const second = move(20);
      const settled = expect(second).rejects.toBeDefined();
      await advance(2500);
      rejectSecond(new Error('no ack'));
      await settled;
      device.position = 80;
      await advance(6000);

      expectLogged(/80% was carried out; the covering reports 80%/);
    });

    it('waits for a covering to arrive instead of settling on its first reading', async () => {
      await start();
      await move(70);

      await advance(2500);
      expectNotLogged(/was carried out/);
      expect(platform.log.warn).not.toHaveBeenCalled();

      device.position = 70;
      await advance(2500);

      expectLogged(/70% was carried out; the covering reports 70%/);
    });

    it('warns when the device settles at a different position than commanded', async () => {
      device.position = 81;
      await start();

      await move(25);
      await advance(14000);

      expect(warned(/accepted 25% but reports 81% instead of reaching it/)).toBe(true);
    });

    it('confirms the position when the device reaches it', async () => {
      device.position = 25;
      await start();

      await move(25);
      await advance(6000);

      expectLogged(/25% was carried out; the covering reports 25%/);
      expect(platform.log.warn).not.toHaveBeenCalled();
    });

    it('accepts a one percent difference as the commanded position', async () => {
      device.position = 24;
      await start();

      await move(25);
      await advance(6000);

      expect(platform.log.warn).not.toHaveBeenCalled();
      expectLogged(/25% was carried out; the covering reports 24%/);
    });

    it('flags a two percent difference as a position that was not reached', async () => {
      device.position = 23;
      await start();

      await move(25);
      await advance(14000);

      expect(warned(/reports 23% instead of reaching it/)).toBe(true);
    });

    it('does not fail a covering that is still traveling between readings', async () => {
      let position = 36;
      node.pollValue.mockImplementation(async () => {
        position += 12;
        return Math.min(position, 99);
      });
      await start();
      await move(100);

      await advance(6000);
      expect(platform.log.warn).not.toHaveBeenCalled();
      expectNotLogged(/was carried out/);

      await advance(20000);

      expect(platform.log.warn).not.toHaveBeenCalled();
      expectLogged(/100% was carried out/);
    });

    it('does not fail a covering that pauses mid-travel and then carries on (seen on an RSZ1)', async () => {
      // Recorded on Demeter: 6, 10, 11, 11 and then it reached the 36% it had been sent to.
      const readings = [6, 10, 11, 11, 11, 20, 30, 36];
      node.pollValue.mockImplementation(async () => readings.shift() ?? 36);
      device.position = 0;
      device.cache = 0;
      await start();
      node.pollValue.mockClear();
      node.pollValue.mockImplementation(async () => readings.shift() ?? 36);

      await move(36);
      await advance(25000);

      expect(platform.log.warn).not.toHaveBeenCalled();
      expectLogged(/36% was carried out; the covering reports 36%/);
    });

    it('follows a covering that takes longer than a minute to travel', async () => {
      // A large covering: one percent every two seconds, so a full travel takes over three minutes.
      let traveling = 0;
      node.pollValue.mockImplementation(async () => Math.min(100, (traveling += 1)));
      await start();
      node.pollValue.mockClear();

      await move(100);
      await advance(100000);
      expect(platform.log.warn).not.toHaveBeenCalled();
      expectNotLogged(/was carried out/);

      await advance(150000);

      expect(platform.log.warn).not.toHaveBeenCalled();
      expectLogged(/100% was carried out/);
    });

    it('follows device reports made while the covering travels', async () => {
      await start();
      await move(100);

      report(60, { source: 'node' });
      expect(current()).toBe(60);
      expect(motion()).toBe(platform.Characteristic.PositionState.INCREASING);

      report(99, { source: 'node' });
      device.position = 99;
      await advance(2500);

      expectLogged(/100% was carried out/);
    });

    it('reports a covering that never reaches its target', async () => {
      let position = 40;
      node.pollValue.mockImplementation(async () => {
        position = position === 40 ? 45 : 40;
        return position;
      });
      await start();

      await move(100);
      await advance(65000);

      expect(warned(/still unconfirmed \d+s after 100%/)).toBe(true);
    });

    it('retries a position poll that the device did not answer', async () => {
      device.position = 30;
      await start();
      node.pollValue.mockReset();
      node.pollValue
        .mockRejectedValueOnce(new Error('no response from node'))
        .mockImplementation(async () => 30);

      await move(30);
      await advance(2500);
      expect(node.pollValue).toHaveBeenCalledTimes(1);
      expectNotLogged(/was carried out/);
      expect(platform.log.warn).not.toHaveBeenCalled();

      await advance(2500);

      expect(node.pollValue).toHaveBeenCalledTimes(2);
      expectLogged(/30% was carried out/);
    });

    it('treats an unanswered poll as no reading rather than a stale one', async () => {
      device.cache = 100;
      device.position = 100;
      await start();
      node.pollValue.mockReset();
      node.pollValue.mockResolvedValue(undefined);

      await move(30);
      await advance(6000);

      expect(node.pollValue.mock.calls.length).toBeGreaterThan(1);
      expect(platform.log.warn).not.toHaveBeenCalled();
      expectNotLogged(/was carried out/);
      expect(current()).toBe(100);

      report(31, { source: 'node' });
      node.pollValue.mockImplementation(async () => 31);
      await advance(2500);

      expectLogged(/30% was carried out; the covering reports 31%/);
    });

    it('re-syncs HomeKit with the position the device actually reports', async () => {
      device.position = 81;
      await start();

      await move(25);
      service.updateCharacteristic.mockClear();
      await advance(14000);

      expect(service.updateCharacteristic).toHaveBeenCalledWith('TargetPosition', 81);
      expect(target()).toBe(81);
    });

    it('settles on the first reading within tolerance without waiting for the covering to stop', async () => {
      // A covering that is passing through the commanded position is indistinguishable, from one
      // reading, from one that arrived. That is the documented limit of a poll.
      device.position = 25;
      await start();

      await move(25);
      await advance(2500);

      expectLogged(/25% was carried out/);
    });
  });

  describe('effects complete exactly once', () => {
    it('settles a hung reconcile poll once, then retries, and drops the late answer', async () => {
      await start();
      node.setValue.mockResolvedValue({ status: WORKING });
      let late: (value: number) => void = () => undefined;
      node.pollValue.mockClear();
      node.pollValue
        .mockImplementationOnce(
          () =>
            new Promise<number>((resolve) => {
              late = resolve;
            }),
        )
        .mockImplementation(async () => 50);

      await move(80);
      // The first poll starts at 2 s and hangs; it is abandoned after 10 s, and the next one
      // starts 2 s after that.
      await advance(2000 + 10000 + 2100);
      expect(node.pollValue).toHaveBeenCalledTimes(2);

      // The abandoned poll finally answers with the target. It must not conclude the command.
      late(80);
      await settle();
      expectNotLogged(/80% was carried out/);
      expect(node.pollValue).toHaveBeenCalledTimes(2);
    });

    it('does not run a second poll for one owner token when a timer and a poll overlap', async () => {
      await start();
      node.setValue.mockResolvedValue({ status: WORKING });
      node.pollValue.mockClear();
      let traveling = 50;
      node.pollValue.mockImplementation(async () => (traveling += 5));

      await move(80);
      await advance(2000);
      expect(node.pollValue).toHaveBeenCalledTimes(1);

      // Each answered poll arms one timer, so polls stay two seconds apart.
      await advance(2000);
      expect(node.pollValue).toHaveBeenCalledTimes(2);
      await advance(2000);
      expect(node.pollValue).toHaveBeenCalledTimes(3);
    });

    it('reports a poll that throws as one unanswered result, not two', async () => {
      await start();
      node.setValue.mockResolvedValue({ status: WORKING });
      node.pollValue.mockClear();
      node.pollValue.mockRejectedValue(new Error('no response'));

      await move(80);
      await advance(2000);
      await advance(2000);
      await advance(2000);

      expect(node.pollValue).toHaveBeenCalledTimes(3);
    });

    it('answers every request exactly once across a stop that supersedes a held move', async () => {
      Object.assign(node, RSZ1);
      node.getDefinedValueIDs = jest
        .fn()
        .mockReturnValue([{ endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'Up' }]);
      await start();

      const outcomes: string[] = [];
      const held = move(70).then(() => outcomes.push('held'));
      const stopping = hold().then(() => outcomes.push('stop'));
      await advance(1000);
      await Promise.all([held, stopping]);

      expect(outcomes.sort()).toEqual(['held', 'stop']);
      expect(node.setValue).toHaveBeenCalledTimes(1);
    });
  });

  describe('adapter boundaries', () => {
    let unhandled: unknown[];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);

    beforeEach(() => {
      unhandled = [];
      process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    describe('an effect that throws while it is being set up', () => {
      it('settles a stop whose value lookup throws, instead of leaving HomeKit waiting', async () => {
        node.getDefinedValueIDs = jest.fn(() => {
          throw new Error('metadata unavailable');
        });
        await start();

        await expect(hold()).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);
        await settle();

        expect(unhandled).toEqual([]);
      });

      it('releases the transport after a failed lookup so the next command goes out', async () => {
        let broken = true;
        node.getDefinedValueIDs = jest.fn(() => {
          if (broken) {
            throw new Error('metadata unavailable');
          }
          return [{ endpoint: 0, commandClass: MULTILEVEL_SWITCH, property: 'Up' }];
        });
        await start();
        await expect(hold()).rejects.toBeDefined();

        broken = false;
        await hold();

        expect(node.setValue).toHaveBeenCalledWith(
          expect.objectContaining({ property: 'Up' }),
          false,
        );
      });

      it('settles a reconcile poll whose value lookup throws and keeps reconciling', async () => {
        node.setValue.mockResolvedValue({ status: WORKING });
        await start();
        await move(80);
        node.getDefinedValueIDs = jest.fn(() => {
          throw new Error('metadata unavailable');
        });
        node.pollValue.mockClear();

        await advance(5000);
        expect(unhandled).toEqual([]);

        // The lookup recovers, and the very same command is then followed to its end.
        node.getDefinedValueIDs = jest.fn().mockReturnValue([]);
        device.position = 80;
        await advance(6000);

        expectLogged(/80% was carried out/);
      });
    });

    describe('hot recovery, which replaces the node object', () => {
      const replacement = (position: number | undefined) => {
        const next = {
          ...node,
          getValue: jest.fn((vid: any) => (vid.property === 'currentValue' ? position : undefined)),
          setValue: jest.fn().mockResolvedValue({ status: UNSUPERVISED }),
          pollValue: jest.fn(async () => position),
        };

        return next;
      };

      it('shows the new node position rather than the replaced node one', async () => {
        await start();
        expect(current()).toBe(50);

        const next = replacement(80);
        feature.updateNode(next, endpoint);
        await settle();

        expect(current()).toBe(80);
        expect(service.updateCharacteristic).toHaveBeenCalledWith('CurrentPosition', 80);
      });

      it('shows the new node cached position at once, before it answers a poll', async () => {
        await start();
        const next = replacement(80);
        next.pollValue.mockImplementation(() => new Promise(() => undefined));

        feature.updateNode(next, endpoint);

        expect(current()).toBe(80);
      });

      it('keeps what was displayed when the new node has nothing to offer yet', async () => {
        await start();
        const next = replacement(undefined);

        feature.updateNode(next, endpoint);

        expect(current()).toBe(50);
      });

      it('sends later commands to the new node', async () => {
        await start();
        const next = replacement(80);
        feature.updateNode(next, endpoint);
        await settle();

        await move(20);

        expect(next.setValue).toHaveBeenCalledWith(expect.anything(), 20);
        expect(node.setValue).not.toHaveBeenCalled();
      });

      it('fails requests of the replaced node and ignores its late results', async () => {
        let releaseWrite: (value: unknown) => void = () => undefined;
        node.setValue.mockImplementation(
          () =>
            new Promise((resolve) => {
              releaseWrite = resolve;
            }),
        );
        await start();
        const moving = move(10);
        await settle();

        // The new controller numbers its own commands from the start, so its first write
        // carries the same id the replaced node's write had.
        const next = replacement(80);
        next.setValue.mockImplementation(() => new Promise(() => undefined));
        feature.updateNode(next, endpoint);
        await expect(moving).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);
        await settle();
        void move(20);
        await settle();
        expect(next.setValue).toHaveBeenCalledTimes(1);

        // The old write finally reports a Supervision success for 10%.
        releaseWrite({ status: SUPERVISED });
        await settle();

        expect(current()).toBe(80);
        expect(target()).toBe(20);
        expect(service.updateCharacteristic).not.toHaveBeenCalledWith('CurrentPosition', 10);
      });

      it('ignores a poll answer from the replaced node that arrives afterwards', async () => {
        let late: (value: number) => void = () => undefined;
        node.pollValue.mockImplementation(
          () =>
            new Promise<number>((resolve) => {
              late = resolve;
            }),
        );
        device.cache = undefined;
        await start();

        const next = replacement(80);
        next.pollValue.mockImplementation(() => new Promise(() => undefined));
        next.getValue.mockReturnValue(undefined);
        feature.updateNode(next, endpoint);
        late(5);
        await settle();

        expect(() => current()).toThrow(platform.api.hap.HapStatusError);
      });

      it('fails a debounced request that never reached the replaced node', async () => {
        Object.assign(node, RSZ1);
        await start();

        const held = move(60);
        const settled = expect(held).rejects.toBeInstanceOf(platform.api.hap.HapStatusError);
        feature.updateNode(replacement(80), endpoint);
        await settled;
        await advance(2000);

        expect(node.setValue).not.toHaveBeenCalled();
      });

      it('still starts when the replacement node cannot read its metadata', async () => {
        await start();
        const next = replacement(undefined);
        next.getDefinedValueIDs = jest.fn(() => {
          throw new Error('metadata unavailable');
        });

        expect(() => feature.updateNode(next, endpoint)).not.toThrow();
        await settle();

        // The controller was restarted, so a command is accepted rather than ignored.
        await move(20);
        expect(next.setValue).toHaveBeenCalledWith(expect.anything(), 20);
        expect(current()).toBe(50);
      });

      it('starts from a node whose metadata cannot be read at startup', async () => {
        node.getDefinedValueIDs = jest.fn(() => {
          throw new Error('metadata unavailable');
        });
        device.cache = undefined;

        await expect(start()).resolves.toBeDefined();
        await move(20);

        expect(node.setValue).toHaveBeenCalledWith(expect.anything(), 20);
      });

      describe('the same node becoming ready after the startup probe gave up', () => {
        const probeGivesUp = async () => {
          device.cache = undefined;
          device.position = undefined;
          await start();
          await advance(36000);
          expect(() => current()).toThrow(platform.api.hap.HapStatusError);
          node.pollValue.mockClear();
        };

        it('asks the node for its position again', async () => {
          await probeGivesUp();

          device.position = 64;
          feature.updateNode(node, endpoint);
          await settle();

          expect(node.pollValue).toHaveBeenCalled();
          expect(current()).toBe(64);
        });

        it('does not restart while the first probe is still looking', async () => {
          device.cache = undefined;
          device.position = undefined;
          await start();
          node.pollValue.mockClear();

          feature.updateNode(node, endpoint);
          await settle();

          expect(node.pollValue).not.toHaveBeenCalled();
        });

        it('does not drop a command in flight', async () => {
          await probeGivesUp();
          node.setValue.mockResolvedValue({ status: WORKING });
          const moving = move(70);

          feature.updateNode(node, endpoint);
          await moving;
          device.position = 70;
          await advance(4000);

          // Still followed to its end, so the controller was not restarted under it.
          expect(node.setValue).toHaveBeenCalledTimes(1);
          expectLogged(/70% was carried out/);
        });

        it('does not drop a debounced command that has not been sent yet', async () => {
          Object.assign(node, RSZ1);
          await probeGivesUp();
          node.setValue.mockResolvedValue({ status: WORKING });
          const held = move(70);

          feature.updateNode(node, endpoint);
          await advance(1000);
          await held;

          expect(node.setValue).toHaveBeenCalledTimes(1);
          expect(node.setValue).toHaveBeenCalledWith(expect.anything(), 70);
        });

        it('leaves a stopped feature stopped', async () => {
          await probeGivesUp();
          feature.stop();
          node.pollValue.mockClear();
          device.position = 64;

          feature.updateNode(node, endpoint);
          await advance(6000);

          expect(node.pollValue).not.toHaveBeenCalled();
          expect(() => current()).toThrow(platform.api.hap.HapStatusError);
          await expect(move(20)).resolves.toBeUndefined();
          expect(node.setValue).not.toHaveBeenCalled();
        });

        it('does not drop a command that was accepted and is being followed', async () => {
          await probeGivesUp();
          node.setValue.mockResolvedValue({ status: WORKING });
          await move(70);

          feature.updateNode(node, endpoint);
          device.position = 70;
          await advance(4000);

          expectLogged(/70% was carried out/);
        });

        it('leaves a verified position alone', async () => {
          await start();
          node.pollValue.mockClear();

          feature.updateNode(node, endpoint);
          await advance(6000);

          expect(node.pollValue).not.toHaveBeenCalled();
          expect(current()).toBe(50);
        });
      });

      it('does nothing when the same node is handed back with a fresh endpoint', async () => {
        await start();
        node.pollValue.mockClear();
        service.updateCharacteristic.mockClear();

        feature.updateNode(node, { ...endpoint });
        await advance(6000);

        expect(node.pollValue).not.toHaveBeenCalled();
        expect(current()).toBe(50);
      });
    });

    describe('poll answers that are not positions', () => {
      it.each([254, 255, -3, Number.NaN, Infinity, 101])(
        'does not publish a poll answer of %s',
        async (answer) => {
          node.setValue.mockResolvedValue({ status: WORKING });
          await start();
          await move(80);
          node.pollValue.mockImplementation(async () => answer);

          await advance(8000);

          expect(current()).toBe(50);
          expect(service.updateCharacteristic).not.toHaveBeenCalledWith('CurrentPosition', answer);
          expectNotLogged(/was carried out/);
          expect(warned(/instead of reaching it/)).toBe(false);
        },
      );

      it('does not take such an answer as the startup position', async () => {
        device.cache = undefined;
        node.pollValue.mockImplementation(async () => 254);
        await start();
        await advance(6000);

        expect(() => current()).toThrow(platform.api.hap.HapStatusError);
      });

      it('still accepts the Z-Wave maximum of 99 as fully open', async () => {
        node.setValue.mockResolvedValue({ status: WORKING });
        await start();
        await move(100);
        node.pollValue.mockImplementation(async () => 99);

        await advance(3000);

        expect(current()).toBe(100);
      });
    });
  });
});
