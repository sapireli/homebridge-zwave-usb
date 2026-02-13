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
  };
});
