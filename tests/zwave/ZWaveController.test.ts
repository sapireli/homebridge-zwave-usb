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

  it('should disable driver debug logging when debug is false', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0', { debug: false });
    await controller.start();

    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    expect(DriverMock).toHaveBeenCalledWith(
      '/dev/ttyACM0',
      expect.objectContaining({
        logConfig: expect.objectContaining({
          enabled: false,
          level: 'info',
          forceConsole: false,
        }),
      }),
    );
  });

  it('should enable driver debug logging when debug is true', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0', { debug: true });
    await controller.start();

    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    expect(DriverMock).toHaveBeenCalledWith(
      '/dev/ttyACM0',
      expect.objectContaining({
        logConfig: expect.objectContaining({
          enabled: true,
          level: 'debug',
          forceConsole: true,
        }),
      }),
    );
  });

  it('should handle inclusion', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();
    await controller.startInclusion();
    expect(mockDriver.controller.beginInclusion).toHaveBeenCalled();
  });

  it('should get available firmware updates', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4; // Alive
    mockNode.getAvailableFirmwareUpdates = jest.fn().mockResolvedValue([{ version: '1.1' }]);
    mockDriver.controller.emit('node added', mockNode);

    const updates = await controller.getAvailableFirmwareUpdates(2);
    expect(mockNode.getAvailableFirmwareUpdates).toHaveBeenCalled();
    expect(updates).toEqual([{ version: '1.1' }]);
  });

  it('should begin firmware update', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4; // Alive
    mockNode.updateFirmware = jest.fn().mockResolvedValue(undefined);
    mockDriver.controller.emit('node added', mockNode);

    await controller.beginFirmwareUpdate(2, { version: '1.1' });
    expect(mockNode.updateFirmware).toHaveBeenCalledWith([{ version: '1.1' }]);
  });

  it('should abort firmware update', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4; // Alive
    mockNode.abortFirmwareUpdate = jest.fn().mockResolvedValue(undefined);
    mockDriver.controller.emit('node added', mockNode);

    await controller.abortFirmwareUpdate(2);
    expect(mockNode.abortFirmwareUpdate).toHaveBeenCalled();
  });

  it('should set node name', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4; // Alive
    mockNode.name = 'Old Name';
    mockDriver.controller.emit('node added', mockNode);

    controller.setNodeName(2, 'New Name');
    expect(mockNode.name).toBe('New Name');
  });

  it('should refresh node info and surface wake-up guidance for sleepy nodes', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 1;
    mockNode.isListening = false;
    mockNode.isFrequentListening = false;
    mockNode.refreshInfo = jest.fn().mockResolvedValue(undefined);
    mockDriver.controller.emit('node added', mockNode);

    await expect(controller.refreshNodeInfo(2)).resolves.toEqual({
      nodeId: 2,
      requiresWakeUp: true,
    });
    expect(mockNode.refreshInfo).toHaveBeenCalled();
  });

  it('should return immediately when a sleepy node refresh is still waiting for wake-up', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    let resolveRefresh: (() => void) | undefined;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 3;
    mockNode.status = 1;
    mockNode.isListening = false;
    mockNode.isFrequentListening = false;
    mockNode.refreshInfo = jest.fn().mockReturnValue(refreshPromise);
    mockDriver.controller.emit('node added', mockNode);

    await expect(controller.refreshNodeInfo(3)).resolves.toEqual({
      nodeId: 3,
      requiresWakeUp: true,
    });
    expect(mockNode.refreshInfo).toHaveBeenCalled();

    resolveRefresh?.();
    await refreshPromise;
  });

  it('should emit node updated during interview lifecycle changes', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 1;
    mockNode.ready = false;

    const onNodeUpdated = jest.fn();
    controller.on('node updated', onNodeUpdated);

    mockDriver.controller.emit('node added', mockNode);
    mockNode.emit('interview stage completed', mockNode, 'NodeInfo');
    mockNode.emit('interview failed', mockNode, { errorMessage: 'timed out' });
    mockNode.emit('wake up', mockNode);
    mockNode.emit('sleep', mockNode);
    mockNode.emit('dead', mockNode);
    mockNode.emit('alive', mockNode);

    expect(onNodeUpdated).toHaveBeenCalledTimes(6);
  });

  it('should fetch and cache a device-specific serial number when a node becomes ready', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 4;
    mockNode.status = 4;
    mockNode.ready = false;
    mockNode.supportsCC = jest
      .fn()
      .mockImplementation((cc) => cc === 114);
    mockNode.commandClasses = {
      'Manufacturer Specific': {
        deviceSpecificGet: jest.fn().mockResolvedValue('lock-serial-0001'),
      },
    };

    const onNodeUpdated = jest.fn();
    controller.on('node updated', onNodeUpdated);

    mockDriver.controller.emit('node added', mockNode);
    mockNode.emit('ready');

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockNode.commandClasses['Manufacturer Specific'].deviceSpecificGet).toHaveBeenCalledWith(1);
    expect(mockNode.deviceSerialNumber).toBe('lock-serial-0001');
    expect(onNodeUpdated).toHaveBeenCalledWith(mockNode);
  });

  it('should resolve S2 PIN entry from the controller callback path', async () => {
    controller = new ZWaveController(log, '/dev/ttyACM0', { storagePath: '/tmp' });
    const onStatusUpdated = jest.fn();
    controller.on('status updated', onStatusUpdated);

    await controller.start();

    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    const driverOptions = DriverMock.mock.calls.at(-1)![1] as {
      inclusionUserCallbacks: { validateDSKAndEnterPIN: (dsk: string) => Promise<string | false> };
    };

    const pinPromise = driverOptions.inclusionUserCallbacks.validateDSKAndEnterPIN('12345-67890');
    controller.setS2Pin('00123');

    await expect(pinPromise).resolves.toBe('00123');
    expect(onStatusUpdated).toHaveBeenCalledWith('S2 PIN REQUIRED');
  });
});
