import { MatterAccessories } from '../../src/matter/MatterAccessories';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { ZWaveAccessory } from '../../src/accessories/ZWaveAccessory';

const WINDOW_COVERING_UUID = '0000008C-0000-1000-8000-0026BB765291';
const INFORMATION_UUID = '0000003E-0000-1000-8000-0026BB765291';
const BATTERY_UUID = '00000096-0000-1000-8000-0026BB765291';

describe('MatterAccessories', () => {
  let platform: any;
  let matter: any;
  let handleSetRequest: jest.Mock;
  let changeListeners: Array<(change: { newValue: unknown }) => void>;
  let batteryListeners: Array<(change: { newValue: unknown }) => void>;
  let currentPosition: number | undefined;
  let targetPosition: number | undefined;
  let targetListeners: Array<(change: { newValue: unknown }) => void>;
  let batteryLevel: number | null;
  let lowBattery: number;
  let holdSetRequest: jest.Mock;

  /** Real characteristics drop a listener on removeListener, which is how untracking works. */
  const detach = (
    listeners: Array<(change: { newValue: unknown }) => void>,
    listener: (change: { newValue: unknown }) => void,
  ) => {
    const at = listeners.indexOf(listener);
    if (at >= 0) {
      listeners.splice(at, 1);
    }
  };

  /**
   * `setRequest` is per accessory so a command can be traced to the object that answered it,
   * which is how a rebuild is told apart from the wrapper it replaced.
   */
  const createCoveringAccessory = (
    uuid = 'covering-uuid',
    displayName = "Nico's Shade",
    setRequest: jest.Mock = handleSetRequest,
    holdRequest: jest.Mock = holdSetRequest,
  ) => {
    changeListeners = [];
    targetListeners = [];
    targetPosition = undefined;
    batteryListeners = [];
    currentPosition = 80;

    const C = platform.Characteristic;
    const entries: Array<[unknown, any]> = Object.entries({
      CurrentPosition: {
        // HomeKit's cache for a covering that has never reported is 0, not undefined. Modeling
        // it as undefined would let a read of .value pass for the right answer.
        get value() {
          return currentPosition ?? 0;
        },
        // The plugin answers a read by throwing while the position is unknown, which is what
        // tells Matter it must not announce one.
        handleGetRequest: jest.fn(async () => {
          if (currentPosition === undefined) {
            throw -70402;
          }
          return currentPosition;
        }),
        on: (event: string, listener: (change: { newValue: unknown }) => void) => {
          if (event === 'change') {
            changeListeners.push(listener);
          }
        },
        removeListener: (event: string, listener: (change: { newValue: unknown }) => void) => {
          if (event === 'change') {
            detach(changeListeners, listener);
          }
        },
      },
      TargetPosition: {
        handleSetRequest: setRequest,
        get value() {
          return targetPosition ?? currentPosition ?? 0;
        },
        // The real characteristic emits change events, and the target mirroring subscribes to
        // them. A mock without this leaves that code unregistered and untested.
        on: (event: string, listener: (change: { newValue: unknown }) => void) => {
          if (event === 'change') {
            targetListeners.push(listener);
          }
        },
        removeListener: (event: string, listener: (change: { newValue: unknown }) => void) => {
          if (event === 'change') {
            detach(targetListeners, listener);
          }
        },
        // hap-nodejs rejects a refused read with the bare HAP status number, not an Error.
        handleGetRequest: jest.fn(async () => {
          if (currentPosition === undefined) {
            throw -70402;
          }
          return currentPosition;
        }),
      },
      HoldPosition: { handleSetRequest: holdRequest },
      BatteryLevel: {
        get value() {
          return batteryLevel;
        },
        on: (event: string, listener: (change: { newValue: unknown }) => void) => {
          if (event === 'change') {
            batteryListeners.push(listener);
          }
        },
        removeListener: (event: string, listener: (change: { newValue: unknown }) => void) => {
          if (event === 'change') {
            detach(batteryListeners, listener);
          }
        },
      },
      StatusLowBattery: {
        get value() {
          return lowBattery;
        },
        on: jest.fn(),
      },
      SerialNumber: { value: 'zwave-0x026E:0x5253:0x5A31-node-5' },
      Manufacturer: { value: 'Springs Window Fashions' },
      Model: { value: 'Somfy Motorized Shade' },
      FirmwareRevision: { value: '11.2' },
    }).map(([name, char]) => [(C as any)[name], char]);
    const characteristics = new Map<unknown, any>(entries);

    const covering = {
      UUID: WINDOW_COVERING_UUID,
      getCharacteristic: jest.fn((type: unknown) => characteristics.get(type)),
    };
    const information = {
      UUID: INFORMATION_UUID,
      getCharacteristic: jest.fn((type: unknown) => characteristics.get(type)),
    };
    const battery = {
      UUID: BATTERY_UUID,
      getCharacteristic: jest.fn((type: unknown) => characteristics.get(type)),
    };

    return {
      node: { nodeId: 5 },
      platformAccessory: {
        UUID: uuid,
        displayName,
        services: [information, covering, battery],
        getService: jest.fn(() => information),
      },
    } as unknown as ZWaveAccessory;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    handleSetRequest = jest.fn().mockResolvedValue(undefined);
    holdSetRequest = jest.fn().mockResolvedValue(undefined);
    batteryLevel = 84;
    lowBattery = 0;

    class MatterFailure extends Error {}
    class MatterNotFound extends Error {}

    matter = {
      deviceTypes: { WindowCovering: { name: 'WindowCoveringDevice' } },
      status: { Failure: MatterFailure, NotFound: MatterNotFound },
      unregisterPlatformAccessories: jest.fn().mockResolvedValue(undefined),
      registerPlatformAccessories: jest.fn().mockResolvedValue(undefined),
      updatePlatformAccessories: jest.fn().mockResolvedValue(undefined),
      updateAccessoryState: jest.fn().mockResolvedValue(undefined),
    };

    platform = {
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      api: { matter },
      Service: {
        WindowCovering: { UUID: WINDOW_COVERING_UUID },
        AccessoryInformation: { UUID: INFORMATION_UUID },
        Battery: { UUID: BATTERY_UUID },
      },
      Characteristic: {
        CurrentPosition: 'CurrentPosition',
        TargetPosition: 'TargetPosition',
        SerialNumber: 'SerialNumber',
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        FirmwareRevision: 'FirmwareRevision',
        HoldPosition: 'HoldPosition',
        BatteryLevel: 'BatteryLevel',
        StatusLowBattery: { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 },
      },
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const publish = async (coverings: MatterAccessories, accessory: ZWaveAccessory) => {
    coverings.add(accessory);
    await jest.advanceTimersByTimeAsync(4000);
  };

  it('publishes a covering as a Matter WindowCovering device', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);

    await publish(coverings, createCoveringAccessory());

    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    const [pluginId, platformName, descriptors] = matter.registerPlatformAccessories.mock.calls[0];
    expect(pluginId).toBe('homebridge-zwave-usb');
    expect(platformName).toBe('ZWaveUSB');
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      UUID: 'covering-uuid',
      displayName: "Nico's Shade",
      deviceType: matter.deviceTypes.WindowCovering,
      manufacturer: 'Springs Window Fashions',
      model: 'Somfy Motorized Shade',
      firmwareRevision: '11.2',
    });
  });

  it('reports the current position with Matter polarity', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);

    await publish(coverings, createCoveringAccessory());

    // HomeKit 80% open is Matter 20.00% closed.
    const cluster = matter.registerPlatformAccessories.mock.calls[0][2][0].clusters.windowCovering;
    expect(cluster.currentPositionLiftPercent100ths).toBe(2000);
    expect(cluster.configStatus.liftPositionAware).toBe(true);
  });

  it('does not announce a position for a covering that has not reported one', async () => {
    // Until the covering answers, the plugin publishes no position. Matter carries "not known"
    // in configStatus.liftPositionAware; announcing 0 instead would tell every controller on the
    // network that the covering is closed.
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
    const accessory = createCoveringAccessory();
    currentPosition = undefined;

    await publish(coverings, accessory);

    const cluster = matter.registerPlatformAccessories.mock.calls[0][2][0].clusters.windowCovering;
    expect(cluster.currentPositionLiftPercent100ths).toBeNull();
    expect(cluster.targetPositionLiftPercent100ths).toBeNull();
    // Not a capability claim: the covering can report position, it simply has not yet.
    expect(cluster.configStatus.liftPositionAware).toBe(true);
  });

  it('corrects an unknown position once the covering reports one', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
    const accessory = createCoveringAccessory();
    currentPosition = undefined;

    await publish(coverings, accessory);
    currentPosition = 40;
    changeListeners.forEach((listener) => listener({ newValue: 40 }));
    await jest.advanceTimersByTimeAsync(4000);

    const pushed = matter.updateAccessoryState.mock.calls.map((call: unknown[]) => call[2]);
    expect(pushed).toContainEqual(
      expect.objectContaining({ currentPositionLiftPercent100ths: 6000 }),
    );
  });

  it('batches several coverings into one registration', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);

    coverings.add(createCoveringAccessory('nico', "Nico's Shade"));
    coverings.add(createCoveringAccessory('lia', "Lia's Shade"));
    await jest.advanceTimersByTimeAsync(4000);

    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(matter.registerPlatformAccessories.mock.calls[0][2]).toHaveLength(2);
  });

  it('shortens an over-long serial number to what Matter accepts', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);

    await publish(coverings, createCoveringAccessory());

    const descriptor = matter.registerPlatformAccessories.mock.calls[0][2][0];
    expect(descriptor.serialNumber.length).toBeLessThanOrEqual(32);
    // The node ID is what distinguishes two shades of the same model, so it must survive.
    expect(descriptor.serialNumber.endsWith('node-5')).toBe(true);
  });

  it('keeps the Matter target distinct from the position while the covering travels', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
    await publish(coverings, createCoveringAccessory());

    matter.updateAccessoryState.mockClear();
    // An intermediate travel report must not be mistaken for the commanded target.
    changeListeners.forEach((listener) => listener({ newValue: 62 }));

    const pushed = matter.updateAccessoryState.mock.calls.map(
      ([, , attributes]: [unknown, unknown, Record<string, unknown>]) => attributes,
    );
    expect(pushed).toContainEqual({ currentPositionLiftPercent100ths: 3800 });
    expect(
      pushed.some((a: Record<string, unknown>) => 'targetPositionLiftPercent100ths' in a),
    ).toBe(false);
  });

  it('removes an accessory from Matter when its node leaves the network', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
    const accessory = createCoveringAccessory();
    await publish(coverings, accessory);

    await coverings.remove('covering-uuid');

    expect(matter.unregisterPlatformAccessories).toHaveBeenCalledWith(
      'homebridge-zwave-usb',
      'ZWaveUSB',
      [expect.objectContaining({ UUID: 'covering-uuid' })],
    );

    // The UUID is free again, so a node re-included with the same id can be published.
    await publish(coverings, createCoveringAccessory());
    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
  });

  it('never publishes the same accessory twice', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
    const accessory = createCoveringAccessory();

    await publish(coverings, accessory);
    await publish(coverings, accessory);

    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
  });

  it('ignores accessories that are not coverings', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
    const light = {
      node: { nodeId: 7 },
      platformAccessory: {
        UUID: 'light',
        displayName: 'A Dimmer',
        services: [{ UUID: '00000043-0000-1000-8000-0026BB765291' }],
        getService: jest.fn(),
      },
    } as unknown as ZWaveAccessory;

    await publish(coverings, light);

    expect(matter.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('does nothing when the bridge has no Matter support', async () => {
    platform.api = {};
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);

    await publish(coverings, createCoveringAccessory());

    expect(matter.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('keeps HomeKit working when Matter registration fails', async () => {
    matter.registerPlatformAccessories.mockRejectedValue(new Error('matter is not ready'));
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);

    await expect(publish(coverings, createCoveringAccessory())).resolves.toBeUndefined();
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not publish 1 accessory over Matter'),
    );
  });

  it('counts accessories in words that agree with the number', async () => {
    // The message is read by whoever is trying to work out what did not reach Matter, so it
    // should read as a sentence rather than as a template with both endings left in.
    matter.registerPlatformAccessories.mockRejectedValue(new Error('matter is not ready'));
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);

    coverings.add(createCoveringAccessory('covering-one', 'One'));
    coverings.add(createCoveringAccessory('covering-two', 'Two'));
    await jest.advanceTimersByTimeAsync(4000);

    const warned = (platform.log.warn as jest.Mock).mock.calls.flat().join('\n');
    expect(warned).toContain('Could not publish 2 accessories over Matter');
    expect(warned).not.toContain('accessory(ies)');
    expect(warned).not.toContain('2 accessory ');
  });

  describe('commands', () => {
    const handlers = () =>
      matter.registerPlatformAccessories.mock.calls[0][2][0].handlers.windowCovering;

    it('routes an absolute Matter position through the HomeKit characteristic', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      // Matter 75.00% closed is HomeKit 25% open.
      await handlers().goToLiftPercentage({ liftPercent100thsValue: 7500 });

      expect(handleSetRequest).toHaveBeenCalledWith(25);
    });

    it('opens fully on UpOrOpen and closes fully on DownOrClose', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      await handlers().upOrOpen();
      expect(handleSetRequest).toHaveBeenCalledWith(100);

      await handlers().downOrClose();
      expect(handleSetRequest).toHaveBeenCalledWith(0);
    });

    it('routes stopMotion through HomeKit HoldPosition', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      await handlers().stopMotion();

      expect(holdSetRequest).toHaveBeenCalledWith(true);
      // A stop must not also be sent as a position.
      expect(handleSetRequest).not.toHaveBeenCalled();
    });

    it('reports a failed stop to the Matter controller as a failure', async () => {
      holdSetRequest.mockRejectedValue(new Error('device did not respond'));
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      await expect(handlers().stopMotion()).rejects.toBeInstanceOf(matter.status.Failure);
      expect(platform.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Matter stop request failed'),
      );
    });

    it('reports a failed write to the Matter controller as a failure', async () => {
      handleSetRequest.mockRejectedValue(new Error('device did not respond'));
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      /**
       * Resolving here would have the controller confirm a move that never happened, while the
       * same command from HomeKit correctly reports a communication failure.
       */
      await expect(handlers().upOrOpen()).rejects.toBeInstanceOf(matter.status.Failure);
      expect(platform.log.error).toHaveBeenCalledWith(
        expect.stringContaining('position request failed'),
      );
    });
  });

  describe('battery', () => {
    const powerSource = () =>
      matter.registerPlatformAccessories.mock.calls[0][2][0].clusters.powerSource;

    it('publishes the battery as a Matter power source in half-percent units', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      // Matter reports battery charge in half-percent units, so 84% is 168.
      expect(powerSource()).toMatchObject({
        batPercentRemaining: 168,
        batChargeLevel: 0,
      });
    });

    it('registers as battery powered even with no reading yet', async () => {
      // Homebridge composes the Battery feature from the attributes present at registration, so
      // a shade whose battery pack is out must still register as battery powered.
      batteryLevel = null;
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      expect(powerSource()).toMatchObject({ batChargeLevel: expect.any(Number) });
      // Unknown is reported as unknown rather than as an invented percentage.
      expect(powerSource().batPercentRemaining).toBeNull();
    });

    it('does not assert battery facts HomeKit never supplies', async () => {
      // HAP gives a level, a low-battery flag and a charging state, and says nothing about
      // whether the source is supplying power, whether a cell is in the device, or whether a
      // user can replace it. Stating any of them would be invention, and the shade whose pack
      // is currently out is the case that makes it concrete.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      expect(powerSource()).toMatchObject({
        status: 0, // Unspecified
        batReplaceability: 0, // Unspecified
      });
      expect(powerSource()).not.toHaveProperty('batPresent');
    });

    it('reports a low battery as a charge warning', async () => {
      lowBattery = 1;
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      expect(powerSource().batChargeLevel).toBe(1);
    });

    it('omits the power source for an accessory with no battery service', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();
      (accessory.platformAccessory as any).services = (
        accessory.platformAccessory as any
      ).services.filter((s: any) => s.UUID !== BATTERY_UUID);

      await publish(coverings, accessory);

      expect(powerSource()).toBeUndefined();
    });

    it('mirrors later battery readings back to Matter', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      expect(batteryListeners).toHaveLength(1);
      batteryListeners[0]({ newValue: 50 });

      expect(matter.updateAccessoryState).toHaveBeenCalledWith('covering-uuid', 'powerSource', {
        batPercentRemaining: 100,
      });
    });
  });

  it('mirrors later position changes back to Matter', async () => {
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
    await publish(coverings, createCoveringAccessory());

    expect(changeListeners).toHaveLength(1);
    changeListeners[0]({ newValue: 25 });

    expect(matter.updateAccessoryState).toHaveBeenCalledWith(
      'covering-uuid',
      'windowCovering',
      expect.objectContaining({ currentPositionLiftPercent100ths: 7500 }),
    );
  });

  it('mirrors a target change to Matter', async () => {
    // Without this the whole target block could be deleted and every test would still pass,
    // because nothing was subscribed to the target characteristic.
    const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);

    await publish(coverings, createCoveringAccessory());
    targetPosition = 30;
    targetListeners.forEach((listener) => listener({ newValue: 30 }));
    await jest.advanceTimersByTimeAsync(4000);

    const pushed = matter.updateAccessoryState.mock.calls.map((call: unknown[]) => call[2]);
    expect(pushed).toContainEqual(
      expect.objectContaining({ targetPositionLiftPercent100ths: 7000 }),
    );
  });


  describe('lifecycle of a restored accessory', () => {
    it('registers an accessory Homebridge restored, which is what carries its ownership', async () => {
      // Registration is what stamps the plugin and platform onto the descriptor. The update
      // entry point carries no identity, so a restored accessory published through it is
      // persisted with no owner and removed as orphaned on the next start.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();

      coverings.configureCachedAccessory({
        UUID: accessory.platformAccessory.UUID,
        displayName: accessory.platformAccessory.displayName,
      });
      await publish(coverings, accessory);

      expect(matter.updatePlatformAccessories).not.toHaveBeenCalled();
      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(matter.registerPlatformAccessories.mock.calls[0][2]).toHaveLength(1);
    });

    it('still tracks a restored accessory so its state reaches Matter', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();

      coverings.configureCachedAccessory({
        UUID: accessory.platformAccessory.UUID,
        displayName: accessory.platformAccessory.displayName,
      });
      await publish(coverings, accessory);

      currentPosition = 40;
      changeListeners.forEach((listener) => listener({ newValue: 40 }));
      await jest.advanceTimersByTimeAsync(4000);

      const pushed = matter.updateAccessoryState.mock.calls.map((call: unknown[]) => call[2]);
      expect(pushed).toContainEqual(
        expect.objectContaining({ currentPositionLiftPercent100ths: 6000 }),
      );
    });

    it('does not resurrect an accessory removed while its registration was in flight', async () => {
      let releaseRegistration: () => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();
      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);

      // Removed while the registration has not come back yet.
      await coverings.remove(accessory.platformAccessory.UUID);
      releaseRegistration();
      await jest.advanceTimersByTimeAsync(4000);

      // The late completion must not put it back, and the registration it made has to be undone.
      // Asserting "called at all" would be satisfied by the remove() that happened first, so the
      // compensating call is identified by the descriptor it carries.
      const undone = matter.unregisterPlatformAccessories.mock.calls.filter(
        (call: unknown[]) =>
          Array.isArray(call[2]) &&
          (call[2] as Array<{ UUID: string; clusters?: unknown }>).some(
            (descriptor) => descriptor.clusters !== undefined,
          ),
      );
      expect(undone).toHaveLength(1);
      matter.registerPlatformAccessories.mockResolvedValue(undefined);
      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);
      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
    });

    it('keeps the record when unregistration fails, so nothing is forgotten', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();
      await publish(coverings, accessory);

      matter.unregisterPlatformAccessories.mockRejectedValueOnce(
        new Error('rejected before dispatch'),
      );
      await coverings.remove(accessory.platformAccessory.UUID);

      // The removal was never dispatched, so the accessory must still be known here: a later
      // sweep has to be able to try again rather than leave an orphan in the controller.
      matter.unregisterPlatformAccessories.mockResolvedValue(undefined);
      await coverings.reconcileCached(new Set());
      expect(matter.unregisterPlatformAccessories).toHaveBeenCalledTimes(2);
    });

    it('keeps a restored covering that is on the network but not published yet', async () => {
      // Publication is debounced, and a shade whose battery is out may not be queued at all.
      // Sweeping on "not published" would unregister a covering that is simply not awake.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      coverings.configureCachedAccessory({ UUID: 'asleep-uuid', displayName: 'Asleep Shade' });

      await coverings.reconcileCached(new Set(['asleep-uuid']));

      expect(matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('removes a restored accessory that no longer matches a covering', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);

      coverings.configureCachedAccessory({ UUID: 'gone-uuid', displayName: 'Removed Shade' });
      await coverings.reconcileCached(new Set(['a-node-that-still-exists']));

      expect(matter.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(matter.unregisterPlatformAccessories.mock.calls[0][2][0].UUID).toBe('gone-uuid');
    });

    it('leaves a restored accessory alone when it was matched to a live covering', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();

      coverings.configureCachedAccessory({
        UUID: accessory.platformAccessory.UUID,
        displayName: accessory.platformAccessory.displayName,
      });
      await publish(coverings, accessory);
      await coverings.reconcileCached(new Set([accessory.platformAccessory.UUID]));

      expect(matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
    });
  });


  describe('ownership across restarts', () => {
    /**
     * A stand-in for Homebridge 2.4's Matter host, keeping the three behaviors this plugin has
     * to live within.
     *
     * Registration is the only path that records the plugin and platform an endpoint belongs to,
     * and that claim is made afresh in every session: what is written back to the cache at
     * shutdown is what this session registered, so an endpoint restored and then never
     * registered again is persisted with no owner and is gone on the next start.
     *
     * Registration is accepted for an identifier the host has never seen, and for one restored
     * from the cache, where an unchanged structure means the handlers and the ownership attach
     * to the endpoint already there. An endpoint already live this session is a duplicate and is
     * refused. Structure is what Homebridge compares: the device type's name and behaviors and
     * the part identifiers, not the cluster attributes the plugin fills in.
     *
     * A refusal is not thrown back to the caller. Bridged registration is dispatched as an event
     * that is not awaited, so the call resolves either way and the plugin never learns. Refusals
     * are collected here instead, and a test asserting there are none is asserting the only
     * thing the plugin can actually be held to.
     */
    interface Endpoint {
      plugin?: string;
      platform?: string;
      claimed: boolean;
      restoredFromCache: boolean;
      structure: string;
      created: number;
      attached: number;
      updated: number;
    }

    let host: any;

    const structureOf = (descriptor: any) =>
      [
        descriptor.deviceType?.name,
        Object.keys(descriptor.deviceType?.behaviors ?? {})
          .sort()
          .join(','),
        (descriptor.parts ?? []).map((part: any) => part.id).sort().join(','),
      ].join('+');

    beforeEach(() => {
      const endpoints = new Map<string, Endpoint>();

      host = {
        deviceTypes: matter.deviceTypes,
        status: matter.status,
        endpoints,
        updateAccessoryState: jest.fn().mockResolvedValue(undefined),
        refused: [] as string[],
        registerPlatformAccessories: jest.fn(
          async (plugin: string, platformName: string, descriptors: any[]) => {
            descriptors.forEach((descriptor) => {
              const existing = endpoints.get(descriptor.UUID);
              const structure = structureOf(descriptor);

              if (existing && !existing.restoredFromCache) {
                host.refused.push(descriptor.UUID);
                return;
              }

              if (existing && existing.structure === structure) {
                existing.plugin = plugin;
                existing.platform = platformName;
                existing.claimed = true;
                existing.restoredFromCache = false;
                existing.attached += 1;
                return;
              }

              endpoints.set(descriptor.UUID, {
                plugin,
                platform: platformName,
                claimed: true,
                restoredFromCache: false,
                structure,
                created: (existing?.created ?? 0) + 1,
                attached: existing?.attached ?? 0,
                updated: existing?.updated ?? 0,
              });
            });
          },
        ),
        updatePlatformAccessories: jest.fn(async (descriptors: any[]) => {
          // Metadata on an endpoint this session already has. No plugin identity is passed in,
          // so nothing here can claim the endpoint for the next start.
          descriptors.forEach((descriptor) => {
            const existing = endpoints.get(descriptor.UUID);

            if (existing) {
              existing.updated += 1;
              return;
            }

            endpoints.set(descriptor.UUID, {
              claimed: false,
              restoredFromCache: false,
              structure: structureOf(descriptor),
              created: 1,
              attached: 0,
              updated: 1,
            });
          });
        }),
        unregisterPlatformAccessories: jest.fn(
          async (_plugin: string, _platformName: string, descriptors: any[]) => {
            descriptors.forEach((descriptor) => endpoints.delete(descriptor.UUID));
          },
        ),
      };

      platform.api.matter = host;
    });

    /** One Homebridge start: the cache is offered back, then the live covering is published. */
    const start = async (restored: string[], accessory: ZWaveAccessory) => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      restored.forEach((uuid) =>
        coverings.configureCachedAccessory({ UUID: uuid, displayName: "Nico's Shade" }),
      );
      await publish(coverings, accessory);
      return coverings;
    };

    /** Shutting down and coming back up, which is where an unclaimed endpoint is lost. */
    const restart = () => {
      const orphaned: string[] = [];

      host.endpoints.forEach((endpoint: Endpoint, uuid: string) => {
        if (endpoint.claimed) {
          endpoint.claimed = false;
          endpoint.restoredFromCache = true;
          return;
        }
        orphaned.push(uuid);
      });

      orphaned.forEach((uuid: string) => host.endpoints.delete(uuid));
      host.registerPlatformAccessories.mockClear();
      host.updatePlatformAccessories.mockClear();
      host.refused = [];
      return { orphaned, restored: [...host.endpoints.keys()] as string[] };
    };

    const withoutBattery = () => {
      const accessory = createCoveringAccessory();
      (accessory.platformAccessory as any).services = (
        accessory.platformAccessory as any
      ).services.filter((service: any) => service.UUID !== BATTERY_UUID);
      return accessory;
    };

    it('records the plugin and platform that own a published covering', async () => {
      await start([], createCoveringAccessory());

      expect(host.endpoints.get('covering-uuid')).toMatchObject({
        plugin: 'homebridge-zwave-usb',
        platform: 'ZWaveUSB',
      });
      expect(restart().orphaned).toEqual([]);
    });

    it('offers a restored descriptor through registration, never the update entry point', async () => {
      await start([], createCoveringAccessory());
      const first = restart();

      await start(first.restored, createCoveringAccessory());

      expect(host.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(host.updatePlatformAccessories).not.toHaveBeenCalled();
    });

    it('keeps the accessory across two consecutive restarts', async () => {
      await start([], createCoveringAccessory());

      const first = restart();
      expect(first.orphaned).toEqual([]);
      await start(first.restored, createCoveringAccessory());

      const second = restart();
      expect(second.orphaned).toEqual([]);
      expect(second.restored).toEqual(['covering-uuid']);
    });

    it('attaches to the endpoint it already has instead of adding a second one', async () => {
      await start([], createCoveringAccessory());
      const { restored } = restart();

      await start(restored, createCoveringAccessory());

      expect(host.endpoints.size).toBe(1);
      expect(host.endpoints.get('covering-uuid')).toMatchObject({ created: 1, attached: 1 });
    });

    it('offers a restored endpoint the shape Homebridge attaches to', async () => {
      // Homebridge replaces a restored endpoint whose structure changed, and structure to it is
      // the device type and the parts, not the cluster attributes. A covering that has lost its
      // battery service is the largest change this plugin can present, and it still has to come
      // back as an attach: a replacement would tear down the endpoint on a restart.
      await start([], createCoveringAccessory());
      const { restored } = restart();

      await start(restored, withoutBattery());

      expect(host.endpoints.get('covering-uuid')).toMatchObject({
        created: 1,
        attached: 1,
        plugin: 'homebridge-zwave-usb',
        platform: 'ZWaveUSB',
      });
      expect(host.refused).toEqual([]);
      expect(restart().orphaned).toEqual([]);
    });

    it('never offers a live identifier again when the accessory is rebuilt', async () => {
      const coverings = await start([], createCoveringAccessory());

      // A capability-graph change builds a new wrapper for a node already published, within
      // the same run.
      await publish(coverings, createCoveringAccessory());

      expect(host.endpoints.size).toBe(1);
      expect(host.endpoints.get('covering-uuid')).toMatchObject({ created: 1, attached: 0 });
      expect(host.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(host.updatePlatformAccessories).not.toHaveBeenCalled();
      expect(host.refused).toEqual([]);
      expect(restart().orphaned).toEqual([]);
    });

    it('keeps the rebuilt accessory owned across the restart that follows', async () => {
      // The rebuild does not re-register, so what the host recorded at the first registration
      // is what has to carry the endpoint through the next start.
      const coverings = await start([], createCoveringAccessory());
      await publish(coverings, createCoveringAccessory());

      const after = restart();

      expect(after.orphaned).toEqual([]);
      expect(after.restored).toEqual(['covering-uuid']);
    });
  });

  describe('state observed while the endpoint is being created', () => {
    it('sends a change that happened after the descriptor was built', async () => {
      // The descriptor is a snapshot. A covering that moves between that snapshot and the
      // endpoint existing would otherwise leave Matter holding the older position with no
      // event coming to correct it, because the listeners were attached after registration.
      let releaseRegistration: () => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      coverings.add(createCoveringAccessory());
      await jest.advanceTimersByTimeAsync(4000);

      // Registration is in flight and the endpoint does not exist yet.
      expect(matter.updateAccessoryState).not.toHaveBeenCalled();
      currentPosition = 30;
      changeListeners.forEach((listener) => listener({ newValue: 30 }));

      matter.registerPlatformAccessories.mockResolvedValue(undefined);
      releaseRegistration();
      await jest.advanceTimersByTimeAsync(4000);

      const pushed = matter.updateAccessoryState.mock.calls.map((call: unknown[]) => call[2]);
      expect(pushed).toContainEqual(
        expect.objectContaining({ currentPositionLiftPercent100ths: 7000 }),
      );
    });

    it('does not let the catch-up read overwrite a newer change', async () => {
      // The gap fill reads current values to cover what the snapshot could have missed. A
      // listener event is necessarily newer than that read, so it has to win.
      let releaseRegistration: () => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      coverings.add(createCoveringAccessory());
      await jest.advanceTimersByTimeAsync(4000);

      // Two changes while the endpoint is being created: only the last one is the truth.
      changeListeners.forEach((listener) => listener({ newValue: 30 }));
      currentPosition = 55;
      changeListeners.forEach((listener) => listener({ newValue: 55 }));

      matter.registerPlatformAccessories.mockResolvedValue(undefined);
      releaseRegistration();
      await jest.advanceTimersByTimeAsync(4000);

      const positions = matter.updateAccessoryState.mock.calls
        .map((call: unknown[]) => (call[2] as Record<string, unknown>))
        .filter((attributes) => 'currentPositionLiftPercent100ths' in attributes);
      expect(positions.at(-1)).toMatchObject({ currentPositionLiftPercent100ths: 4500 });
    });

    it('sends a change that happened while the descriptor was being built', async () => {
      // The snapshot reads characteristics one at a time and awaits several of them, so a
      // covering can move after being read and before the listeners exist. No event will ever
      // report that move, because nothing was listening when it happened, so the only thing
      // that can recover it is reading current state once the listeners are in place.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();

      let releaseDescribe: () => void = () => undefined;
      const slow = new Promise<void>((resolve) => {
        releaseDescribe = resolve;
      });
      const covering = accessory.platformAccessory.services.find(
        (service) => service.UUID === WINDOW_COVERING_UUID,
      ) as unknown as { getCharacteristic: jest.Mock };
      const realGet = covering.getCharacteristic;
      let snapshotRead = true;
      covering.getCharacteristic = jest.fn((type: unknown) => {
        const characteristic = realGet(type) as { handleGetRequest?: () => Promise<unknown> };
        if (type !== platform.Characteristic.CurrentPosition) return characteristic;
        return {
          ...characteristic,
          handleGetRequest: async () => {
            if (snapshotRead) {
              snapshotRead = false;
              // The snapshot's own read, held open while the shade moves below.
              await slow;
              return 80;
            }
            return currentPosition;
          },
        };
      });

      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);

      // The shade moves while the snapshot is still being assembled. Nothing is listening.
      currentPosition = 35;
      releaseDescribe();
      await jest.advanceTimersByTimeAsync(4000);

      const registered = matter.registerPlatformAccessories.mock.calls[0][2][0];
      expect(registered.clusters.windowCovering.currentPositionLiftPercent100ths).toBe(2000);

      const pushed = matter.updateAccessoryState.mock.calls.map((call: unknown[]) => call[2]);
      expect(pushed).toContainEqual(
        expect.objectContaining({ currentPositionLiftPercent100ths: 6500 }),
      );
    });

    it('never announces an unknown position as closed when catching up', async () => {
      // The catch-up read must go through the same getter the snapshot uses. HomeKit's cached
      // value for a covering that has never reported is 0, which inverts to fully closed, so
      // reading the cache would announce a shut shade to every controller on the network.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();
      // Set after building the accessory, which resets the shared position to a known value.
      currentPosition = undefined;
      await publish(coverings, accessory);

      const registered = matter.registerPlatformAccessories.mock.calls[0][2][0];
      expect(registered.clusters.windowCovering.currentPositionLiftPercent100ths).toBeNull();

      const positions = matter.updateAccessoryState.mock.calls
        .map((call: unknown[]) => call[2] as Record<string, unknown>)
        .filter((attributes) => 'currentPositionLiftPercent100ths' in attributes);
      positions.forEach((attributes) =>
        expect(attributes.currentPositionLiftPercent100ths).toBeNull(),
      );
    });

    it('sends a battery change that happened while the descriptor was being built', async () => {
      // Battery is read by the snapshot like everything else and tracked by listeners attached
      // afterwards, so it needs the same catch-up. A pack that drains during a slow interview
      // would otherwise be reported at its pre-interview charge until the next change.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();

      let releaseDescribe: () => void = () => undefined;
      const slow = new Promise<void>((resolve) => {
        releaseDescribe = resolve;
      });
      const covering = accessory.platformAccessory.services.find(
        (service) => service.UUID === WINDOW_COVERING_UUID,
      ) as unknown as { getCharacteristic: jest.Mock };
      const realGet = covering.getCharacteristic;
      covering.getCharacteristic = jest.fn((type: unknown) => {
        const characteristic = realGet(type) as { handleGetRequest?: () => Promise<unknown> };
        if (!characteristic?.handleGetRequest) return characteristic;
        return {
          ...characteristic,
          handleGetRequest: async () => {
            await slow;
            return currentPosition;
          },
        };
      });

      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);

      // The pack drains while the snapshot is still being assembled. 42% is 84 half-percent.
      batteryLevel = 42;
      releaseDescribe();
      await jest.advanceTimersByTimeAsync(4000);

      const pushed = matter.updateAccessoryState.mock.calls.map((call: unknown[]) => call[2]);
      expect(pushed).toContainEqual(expect.objectContaining({ batPercentRemaining: 84 }));
    });

    it('stops listening when an accessory is removed while its descriptor is built', async () => {
      // The listeners are attached after the removal has already run. Leaving them would mirror
      // a wrapper the plugin has given up, and feed its readings to whatever later takes the
      // same identifier.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();
      const uuid = accessory.platformAccessory.UUID;

      let releaseDescribe: () => void = () => undefined;
      const slow = new Promise<void>((resolve) => {
        releaseDescribe = resolve;
      });
      const covering = accessory.platformAccessory.services.find(
        (service) => service.UUID === WINDOW_COVERING_UUID,
      ) as unknown as { getCharacteristic: jest.Mock };
      const realGet = covering.getCharacteristic;
      covering.getCharacteristic = jest.fn((type: unknown) => {
        const characteristic = realGet(type) as { handleGetRequest?: () => Promise<unknown> };
        if (!characteristic?.handleGetRequest) return characteristic;
        return {
          ...characteristic,
          handleGetRequest: async () => {
            await slow;
            return currentPosition;
          },
        };
      });

      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);
      await coverings.remove(uuid);
      releaseDescribe();
      await jest.advanceTimersByTimeAsync(4000);

      expect(matter.registerPlatformAccessories).not.toHaveBeenCalled();
      /**
       * Asserted on the listeners themselves rather than on what they send. A leaked listener
       * writes into the held buffer instead of reaching Matter, because the identifier was
       * never published, so watching the update call cannot tell a detached listener from an
       * attached one with nowhere to send.
       */
      expect(changeListeners).toHaveLength(0);
      expect(targetListeners).toHaveLength(0);
      expect(batteryListeners).toHaveLength(0);
    });

    it('does not carry a removed wrapper state into the next accessory on that identifier', async () => {
      // Anything held for an abandoned publication has to go with it. Kept, it would be
      // released the next time that identifier is published, reporting the old wrapper's
      // readings as the new one's.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const abandoned = createCoveringAccessory();
      const uuid = abandoned.platformAccessory.UUID;

      let releaseDescribe: () => void = () => undefined;
      const slow = new Promise<void>((resolve) => {
        releaseDescribe = resolve;
      });
      const covering = abandoned.platformAccessory.services.find(
        (service) => service.UUID === WINDOW_COVERING_UUID,
      ) as unknown as { getCharacteristic: jest.Mock };
      const realGet = covering.getCharacteristic;
      covering.getCharacteristic = jest.fn((type: unknown) => {
        const characteristic = realGet(type) as { handleGetRequest?: () => Promise<unknown> };
        if (!characteristic?.handleGetRequest) return characteristic;
        return {
          ...characteristic,
          handleGetRequest: async () => {
            await slow;
            return currentPosition;
          },
        };
      });

      coverings.add(abandoned);
      await jest.advanceTimersByTimeAsync(4000);
      await coverings.remove(uuid);
      // 10% open is 9000 in Matter's inverted hundredths, and belongs to the abandoned wrapper.
      currentPosition = 10;
      releaseDescribe();
      await jest.advanceTimersByTimeAsync(4000);

      // The same identifier comes back, at a different position.
      matter.updateAccessoryState.mockClear();
      const replacement = createCoveringAccessory();
      currentPosition = 90;
      await publish(coverings, replacement);

      const pushed = matter.updateAccessoryState.mock.calls.map((call: unknown[]) => call[2]);
      expect(pushed).not.toContainEqual(
        expect.objectContaining({ currentPositionLiftPercent100ths: 9000 }),
      );
    });

    it('stops listening when the publication it was opened for fails', async () => {
      // Nothing was published, so an accessory that keeps reporting would be mirroring a
      // device Matter does not have.
      matter.registerPlatformAccessories.mockRejectedValueOnce(
        new Error('rejected before dispatch'),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      matter.updateAccessoryState.mockClear();
      changeListeners.forEach((listener) => listener({ newValue: 30 }));
      await jest.advanceTimersByTimeAsync(4000);

      expect(matter.updateAccessoryState).not.toHaveBeenCalled();
    });
  });

  describe('publication races and duplicates', () => {
    it('never registers an accessory removed while its descriptor was built', async () => {
      // The generation has to be read before the first await, not after it: a removal during
      // describe() would otherwise bump it first and the publication would see itself as
      // current. Stale work is then dropped before the call rather than undone afterwards,
      // because the undo is dispatched as an event of its own and can be handled first.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();
      const uuid = accessory.platformAccessory.UUID;

      let releaseDescribe: () => void = () => undefined;
      const slow = new Promise<void>((resolve) => {
        releaseDescribe = resolve;
      });
      const covering = accessory.platformAccessory.services.find(
        (service) => service.UUID === WINDOW_COVERING_UUID,
      ) as unknown as { getCharacteristic: jest.Mock };
      const realGet = covering.getCharacteristic;
      covering.getCharacteristic = jest.fn((type: unknown) => {
        const characteristic = realGet(type) as { handleGetRequest?: () => Promise<unknown> };
        if (characteristic?.handleGetRequest) {
          return { ...characteristic, handleGetRequest: async () => {
            await slow;
            return currentPosition;
          } };
        }
        return characteristic;
      });

      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);
      await coverings.remove(uuid);
      releaseDescribe();
      await jest.advanceTimersByTimeAsync(4000);

      // It was the only accessory queued, so nothing is left to hand over and the call is not
      // made at all rather than made with an empty list.
      expect(matter.registerPlatformAccessories).not.toHaveBeenCalled();
      expect(matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('refreshes a rebuilt accessory in place rather than registering it again', async () => {
      // A rebuilt object for an identifier already live is the same Matter accessory, and
      // Homebridge refuses a second registration of one. Nothing has to be published: the
      // handlers resolve the accessory by identifier, so repointing the record is the update.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());
      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);

      await publish(coverings, createCoveringAccessory());

      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(matter.updatePlatformAccessories).not.toHaveBeenCalled();
    });

    it('routes every command to the rebuilt accessory, not the one it replaced', async () => {
      // All four handlers were registered with the endpoint before the rebuild existed, so each
      // one has to resolve the accessory when it runs rather than keep the object it was built
      // with. One of them doing so is not evidence about the others.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const staleSet = jest.fn().mockResolvedValue(undefined);
      const staleHold = jest.fn().mockResolvedValue(undefined);
      const set = jest.fn().mockResolvedValue(undefined);
      const hold = jest.fn().mockResolvedValue(undefined);

      await publish(
        coverings,
        createCoveringAccessory('covering-uuid', "Nico's Shade", staleSet, staleHold),
      );
      const handlers =
        matter.registerPlatformAccessories.mock.calls[0][2][0].handlers.windowCovering;

      await publish(coverings, createCoveringAccessory('covering-uuid', "Nico's Shade", set, hold));

      await handlers.goToLiftPercentage({ liftPercent100thsValue: 7500 });
      await handlers.upOrOpen();
      await handlers.downOrClose();
      await handlers.stopMotion();

      expect(set.mock.calls.map((call: unknown[]) => call[0])).toEqual([25, 100, 0]);
      expect(hold).toHaveBeenCalledTimes(1);
      expect(staleSet).not.toHaveBeenCalled();
      expect(staleHold).not.toHaveBeenCalled();
    });

    it('brings Matter up to date with the rebuilt accessory', async () => {
      // The listeners that were mirroring state belonged to the wrapper just replaced, so
      // without a push here the endpoint keeps the last position it was told about until the
      // new wrapper happens to report a change of its own.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());

      const rebuilt = createCoveringAccessory();
      matter.updateAccessoryState.mockClear();
      currentPosition = 30;
      await publish(coverings, rebuilt);

      const pushed = matter.updateAccessoryState.mock.calls.map((call: unknown[]) => call[2]);
      expect(pushed).toContainEqual(
        expect.objectContaining({ currentPositionLiftPercent100ths: 7000 }),
      );
    });

    it('reports a command for an accessory it no longer has as not found', async () => {
      // The endpoint can outlive the covering, and a controller that commands one that is gone
      // has to be told so. Resolving to nothing and calling through would fail as a type error
      // inside the handler, which reaches the controller as an opaque failure.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      await publish(coverings, createCoveringAccessory());
      const handlers =
        matter.registerPlatformAccessories.mock.calls[0][2][0].handlers.windowCovering;

      await coverings.remove('covering-uuid');

      await expect(handlers.upOrOpen()).rejects.toBeInstanceOf(matter.status.NotFound);
    });

    it('stops mirroring the accessory it replaced', async () => {
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const first = createCoveringAccessory();
      await publish(coverings, first);

      // Homebridge hands a rebuild the services it already had, so a listener left on the old
      // wrapper is a listener still attached to the characteristic the new one reports through.
      const sameServices = {
        node: first.node,
        platformAccessory: first.platformAccessory,
      } as unknown as ZWaveAccessory;
      await publish(coverings, sameServices);

      matter.updateAccessoryState.mockClear();
      currentPosition = 40;
      changeListeners.forEach((listener) => listener({ newValue: 40 }));
      await jest.advanceTimersByTimeAsync(4000);

      const positions = matter.updateAccessoryState.mock.calls.filter(
        (call: unknown[]) =>
          (call[2] as Record<string, unknown>).currentPositionLiftPercent100ths === 6000,
      );
      expect(positions).toHaveLength(1);
    });

    it('keeps a group handed over when a later group in the same run is rejected', async () => {
      // The two groups are handed over separately, so a rejection of one must not discard the
      // other: the first group was already handed over and would be offered again later.
      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const restored = createCoveringAccessory('restored-uuid', 'Restored Shade');
      coverings.configureCachedAccessory({ UUID: 'restored-uuid', displayName: 'Restored Shade' });
      const brandNew = createCoveringAccessory('new-uuid', 'New Shade');

      // The fresh group goes first and is handed over; the restored group is then rejected.
      matter.registerPlatformAccessories
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('rejected before dispatch'));
      coverings.add(brandNew);
      coverings.add(restored);
      await jest.advanceTimersByTimeAsync(4000);

      // Handed over as two separate calls, so the failing one cannot discard the other.
      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
      const firstGroup = (
        matter.registerPlatformAccessories.mock.calls[0][2] as Array<{ UUID: string }>
      ).map((descriptor) => descriptor.UUID);
      expect(firstGroup).toEqual(['new-uuid']);

      // The one that was handed over is committed and is not offered again.
      matter.registerPlatformAccessories.mockResolvedValue(undefined);
      coverings.add(brandNew);
      await jest.advanceTimersByTimeAsync(4000);
      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
    });
  });


  describe('a retry offered while publication was running', () => {
    it('publishes the accessory again when the registration it waited on failed', async () => {
      // add() promises it is safe to call repeatedly. An offer made while a registration was
      // running duplicates nothing if that registration then failed, so discarding it on
      // identity alone leaves the accessory unpublished until a rebuild or a restart.
      let releaseRegistration: () => void = () => undefined;
      let failRegistration: (err: Error) => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            releaseRegistration = resolve;
            failRegistration = reject;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();

      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);

      // The same accessory offered again while the first attempt is still running.
      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(1000);

      matter.registerPlatformAccessories.mockResolvedValue(undefined);
      failRegistration(new Error('rejected before dispatch'));
      void releaseRegistration;
      await jest.advanceTimersByTimeAsync(8000);

      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
    });

    it('still drops the duplicate offer when the first publication succeeded', async () => {
      let releaseRegistration: () => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();

      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);
      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(1000);

      releaseRegistration();
      await jest.advanceTimersByTimeAsync(8000);

      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    });
  });

  describe('publication already in flight', () => {
    it('does not register twice when the same covering is added again mid-flight', async () => {
      // While a registration is awaiting the server the UUID is in neither pending nor
      // published, so without serialization a second add queues it and registers it again.
      let releaseRegistration: () => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();

      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);
      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);

      releaseRegistration();
      await jest.advanceTimersByTimeAsync(4000);

      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    });

    it('republishes once when the accessory object is rebuilt mid-flight', async () => {
      // The accessory offered while the registration was running is the one the endpoint has
      // to answer for once it finishes. It arrives after the identifier is live, so it is
      // taken up by repointing the record rather than by a second registration.
      let releaseRegistration: () => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const first = createCoveringAccessory();
      const rebuilt = createCoveringAccessory();

      coverings.add(first);
      await jest.advanceTimersByTimeAsync(4000);
      coverings.add(rebuilt);

      matter.registerPlatformAccessories.mockResolvedValue(undefined);
      releaseRegistration();
      await jest.advanceTimersByTimeAsync(8000);

      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(matter.updatePlatformAccessories).not.toHaveBeenCalled();
    });
  });


  describe('a rebuild offered before a removal', () => {
    it('does not publish a replacement that was offered before the accessory was removed', async () => {
      // register A, add rebuilt B, remove, then let A finish. B was offered while the plugin
      // still wanted the accessory; the removal came afterwards, so B must not be published.
      let releaseRegistration: () => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const first = createCoveringAccessory();
      const rebuilt = createCoveringAccessory();
      const uuid = first.platformAccessory.UUID;

      coverings.add(first);
      await jest.advanceTimersByTimeAsync(4000);
      coverings.add(rebuilt);
      await coverings.remove(uuid);

      matter.registerPlatformAccessories.mockResolvedValue(undefined);
      releaseRegistration();
      await jest.advanceTimersByTimeAsync(8000);

      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(matter.updatePlatformAccessories).not.toHaveBeenCalled();

      const compensating = matter.unregisterPlatformAccessories.mock.calls.filter(
        (call: unknown[]) =>
          Array.isArray(call[2]) &&
          (call[2] as Array<{ UUID: string; clusters?: unknown }>).some(
            (descriptor) => descriptor.UUID === uuid && descriptor.clusters !== undefined,
          ),
      );
      expect(compensating).toHaveLength(1);
    });

    it('still publishes the same object added again after the removal', async () => {
      // Ordering comes from the generation, not from object identity. A re-included node that
      // reuses its wrapper is a new request, because the publication it would have duplicated
      // has already been undone.
      let releaseRegistration: () => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const accessory = createCoveringAccessory();
      const uuid = accessory.platformAccessory.UUID;

      coverings.add(accessory);
      await jest.advanceTimersByTimeAsync(4000);
      await coverings.remove(uuid);
      coverings.add(accessory);

      matter.registerPlatformAccessories.mockResolvedValue(undefined);
      releaseRegistration();
      await jest.advanceTimersByTimeAsync(8000);

      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
    });

    it('still publishes an accessory added again after the removal', async () => {
      // The opposite case: a genuinely new request made after the removal carries the current
      // generation and has to run, or a re-included node could never come back.
      let releaseRegistration: () => void = () => undefined;
      matter.registerPlatformAccessories.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          }),
      );

      const coverings = new MatterAccessories(platform as ZWaveUsbPlatform);
      const first = createCoveringAccessory();
      const uuid = first.platformAccessory.UUID;

      coverings.add(first);
      await jest.advanceTimersByTimeAsync(4000);
      await coverings.remove(uuid);

      const readded = createCoveringAccessory();
      coverings.add(readded);

      matter.registerPlatformAccessories.mockResolvedValue(undefined);
      releaseRegistration();
      await jest.advanceTimersByTimeAsync(8000);

      expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(2);
    });
  });

});
