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
    await controller.startInclusion();
    expect(mockDriver.controller.beginInclusion).toHaveBeenCalled();
  });
});
