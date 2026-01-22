import { ZWaveController } from '../../src/zwave/ZWaveController';
import { Logger } from 'homebridge';
import { Driver } from 'zwave-js';
import { ZwavejsServer } from '@zwave-js/server';

// Mock dependencies
jest.mock('zwave-js');

// Define mock server instance to be returned
const mockServerInstance = {
  start: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
};

jest.mock('@zwave-js/server', () => {
  return {
    ZwavejsServer: jest.fn().mockImplementation(() => mockServerInstance),
  };
});

describe('ZWaveController (Host Mode)', () => {
  let controller: ZWaveController;
  let log: jest.Mocked<Logger>;
  let mockDriver: jest.Mocked<Driver>;

  beforeEach(() => {
    log = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;
    
    // Reset mocks
    (mockServerInstance.start as jest.Mock).mockClear();
    (mockServerInstance.destroy as jest.Mock).mockClear();
    const ZwaveJsServerMock = ZwavejsServer as jest.MockedClass<typeof ZwavejsServer>;
    ZwaveJsServerMock.mockClear();

    // Setup Driver mock
    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    mockDriver = {
      start: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      controller: {
        nodes: new Map(),
        on: jest.fn(),
        homeId: 1,
      },
    } as any;
    DriverMock.mockImplementation(() => mockDriver);
  });

  it('should start Z-Wave Server if enabled', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0', {
      server: { enabled: true, port: 3000 },
    });

    await controller.start();

    expect(mockDriver.start).toHaveBeenCalled();
    expect(ZwavejsServer).toHaveBeenCalledWith(mockDriver, expect.objectContaining({ port: 3000 }));
    expect(mockServerInstance.start).toHaveBeenCalled();
  });

  it('should NOT start Z-Wave Server if disabled', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0', {
      server: { enabled: false, port: 3000 },
    });

    await controller.start();

    expect(mockDriver.start).toHaveBeenCalled();
    expect(ZwavejsServer).not.toHaveBeenCalled();
  });

  it('should stop server on shutdown', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0', {
        server: { enabled: true, port: 3000 },
    });
    
    await controller.start();
    await controller.stop();
    
    expect(mockServerInstance.destroy).toHaveBeenCalled();
    expect(mockDriver.destroy).toHaveBeenCalled();
  });
});
