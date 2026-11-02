import { EventEmitter } from 'events';

// Robust Mock for Z-Wave JS Driver
class MockDriver extends EventEmitter {
  public start = jest.fn().mockImplementation(async () => {
    setTimeout(() => this.emit('driver ready'), 10);
  });
  public destroy = jest.fn().mockResolvedValue(undefined);
  public controller: any;

  constructor() {
    super();
    const controller = new EventEmitter() as any;
    controller.nodes = new Map();
    controller.homeId = 1;
    controller.beginInclusion = jest.fn().mockResolvedValue(true);
    controller.stopInclusion = jest.fn().mockResolvedValue(true);
    controller.beginExclusion = jest.fn().mockResolvedValue(true);
    controller.stopExclusion = jest.fn().mockResolvedValue(true);
    controller.beginRebuildingRoutes = jest.fn().mockResolvedValue(true);
    controller.stopRebuildingRoutes = jest.fn().mockResolvedValue(true);
    this.controller = controller;
  }
}

// Global Mock
jest.mock('zwave-js', () => {
  return {
    Driver: jest.fn().mockImplementation(() => new MockDriver()),
    ZWaveNode: class extends EventEmitter {
      nodeId = 0;
      ready = true;
      supportsCC = jest.fn().mockReturnValue(true);
      getValue = jest.fn().mockReturnValue(true);
      setValue = jest.fn().mockResolvedValue(undefined);
      getDefinedValueIDs = jest.fn().mockReturnValue([]);
      getAllEndpoints = jest.fn().mockReturnValue([]);
    },
    InclusionStrategy: {
      Default: 0,
    },
    /**
     * The command class value definitions are the real ones. Whether a value carries a
     * credential is read from them at runtime, so a stub here would make the plugin treat
     * every value as unrecognized and withhold all of them, with the tests still passing.
     * Resolved on call rather than at setup, so only the tests that ask for it pay to load it.
     */
    getCCValues: (...args: unknown[]) =>
      (jest.requireActual('zwave-js') as { getCCValues: (...a: unknown[]) => unknown }).getCCValues(
        ...args,
      ),
    /** Mirrors zwave-js's SetValueStatus and setValueFailed. */
    SetValueStatus: {
      0: 'NoDeviceSupport',
      1: 'Working',
      2: 'Fail',
      3: 'EndpointNotFound',
      4: 'NotImplemented',
      5: 'InvalidValue',
      254: 'SuccessUnsupervised',
      255: 'Success',
      NoDeviceSupport: 0,
      Working: 1,
      Fail: 2,
      EndpointNotFound: 3,
      NotImplemented: 4,
      InvalidValue: 5,
      SuccessUnsupervised: 254,
      Success: 255,
    },
    setValueFailed: (result: { status?: number }) => [0, 2, 3, 4, 5].includes(result?.status ?? -1),
  };
});
