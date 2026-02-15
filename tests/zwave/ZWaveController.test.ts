import { ZWaveController } from '../../src/zwave/ZWaveController';
import { Logger } from 'homebridge';
import { Driver } from 'zwave-js';
import { EventEmitter } from 'events';

// Mock dependencies
jest.mock('zwave-js');

describe('ZWaveController (Direct Mode)', () => {
  let controller: ZWaveController;
  let log: jest.Mocked<Logger>;
  let mockDriver: any;

  beforeEach(() => {
    log = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;

    // Setup Driver mock using EventEmitter
    mockDriver = new EventEmitter();
    mockDriver.start = jest.fn().mockImplementation(async () => {
      setTimeout(() => mockDriver.emit('driver ready'), 10);
    });
    mockDriver.destroy = jest.fn().mockResolvedValue(undefined);
    mockDriver.controller = new EventEmitter();
    mockDriver.controller.nodes = new Map();
    mockDriver.controller.homeId = 1;
    mockDriver.controller.beginInclusion = jest.fn().mockResolvedValue(true);
    mockDriver.controller.stopInclusion = jest.fn().mockResolvedValue(true);
    mockDriver.controller.beginExclusion = jest.fn().mockResolvedValue(true);
    mockDriver.controller.stopExclusion = jest.fn().mockResolvedValue(true);
    mockDriver.controller.beginRebuildingRoutes = jest.fn().mockResolvedValue(true);
    mockDriver.controller.stopRebuildingRoutes = jest.fn().mockResolvedValue(true);
    (mockDriver.controller as any)._factoryReset = jest.fn().mockResolvedValue(undefined);

    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    DriverMock.mockImplementation(() => mockDriver);
  });

  afterEach(async () => {
    await controller?.stop();
  });

  it('should start the driver and wait for ready', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();
    expect(mockDriver.start).toHaveBeenCalled();
  });

  it('should handle inclusion', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();
    await controller.startInclusion();
    expect(mockDriver.controller.beginInclusion).toHaveBeenCalled();
  });

  it('should handle factory reset', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();
    await controller.factoryReset();
    expect((mockDriver.controller as any)._factoryReset).toHaveBeenCalled();
  });
});
