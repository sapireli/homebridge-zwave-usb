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
    /**
     * These two are synchronous in zwave-js 15 and return a boolean. Mocking them as promises
     * would let the production code depend on an API shape the library does not have.
     */
    mockDriver.controller.beginRebuildingRoutes = jest.fn().mockReturnValue(true);
    mockDriver.controller.stopRebuildingRoutes = jest.fn().mockReturnValue(true);

    const DriverMock = Driver as jest.MockedClass<typeof Driver>;
    DriverMock.mockImplementation(() => mockDriver);
  });

  afterEach(async () => {
    jest.useRealTimers();
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
    mockNode.updateFirmware = jest.fn().mockResolvedValue({ success: true, status: 254 });
    mockDriver.controller.emit('node added', mockNode);

    await controller.beginFirmwareUpdate(2, { version: '1.1' });
    expect(mockNode.updateFirmware).toHaveBeenCalledWith([{ version: '1.1' }]);
  });

  it('reports firmware progress as the percentage the driver computed', async () => {
    // zwave-js 15 passes one progress object. Reading it as (sent, total) left the stored
    // numbers undefined and the bar showing NaN%.
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4;
    mockDriver.controller.emit('node added', mockNode);

    const seen: number[] = [];
    controller.on('firmware update progress', (_nodeId, percent) => seen.push(percent));
    mockNode.emit('firmware update progress', mockNode, {
      currentFile: 1,
      totalFiles: 1,
      sentFragments: 37,
      totalFragments: 100,
      progress: 37.5,
    });

    expect(seen).toEqual([37.5]);
  });

  it('reads the outcome from the result rather than from the status number', async () => {
    /**
     * The status cannot be judged by truthiness. A transmission failure is 1 and a timeout is
     * -1, both truthy, so a truth test calls a failed update successful; a checksum error is 0
     * and only happens to read correctly. The three success values are 253 to 255, and only
     * `success` says which case a given status is.
     */
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4;
    mockDriver.controller.emit('node added', mockNode);

    const outcomes: boolean[] = [];
    controller.on('firmware update finished', (_nodeId, success) => outcomes.push(success));

    mockNode.emit('firmware update finished', mockNode, { status: 255, success: true });
    mockNode.emit('firmware update finished', mockNode, { status: 0, success: false });
    mockNode.emit('firmware update finished', mockNode, { status: 1, success: false });

    expect(outcomes).toEqual([true, false, false]);
  });

  it('treats an update that resolves without success as a failure', async () => {
    // The driver reports a refused transfer in the result instead of throwing, so a caller
    // watching only for an exception would call a failed update done.
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4;
    mockNode.updateFirmware = jest.fn().mockResolvedValue({ status: 2, success: false });
    mockDriver.controller.emit('node added', mockNode);

    await expect(controller.beginFirmwareUpdate(2, { version: '1.1' })).rejects.toThrow(
      /did not succeed/,
    );

    // A result carrying no `success` field is a failure as well, and so is an empty resolve.
    mockNode.updateFirmware = jest.fn().mockResolvedValue({});
    await expect(controller.beginFirmwareUpdate(2, { version: '1.1' })).rejects.toThrow(
      /did not succeed/,
    );

    mockNode.updateFirmware = jest.fn().mockResolvedValue(undefined);
    await expect(controller.beginFirmwareUpdate(2, { version: '1.1' })).rejects.toThrow(
      /did not succeed/,
    );
  });

  it('reports a failed update check as an error rather than as no update', async () => {
    // An empty list means the service has nothing for this device. A failed check means it
    // does not know, and someone deciding whether to wait needs to tell those apart.
    controller = new ZWaveController(log, '/dev/ttyACM0');
    await controller.start();

    const mockNode = new EventEmitter() as any;
    mockNode.nodeId = 2;
    mockNode.status = 4;
    mockNode.getAvailableFirmwareUpdates = jest
      .fn()
      .mockRejectedValue(new Error('update service unreachable'));
    mockDriver.controller.emit('node added', mockNode);

    await expect(controller.getAvailableFirmwareUpdates(2)).rejects.toThrow(
      'update service unreachable',
    );
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
  describe('node route diagnostics', () => {
    const addNode = (extra: Record<string, unknown> = {}) => {
      const node = new EventEmitter() as any;
      node.nodeId = 5;
      node.status = 4;
      node.name = "Nico's Shade";
      node.statistics = {
        lwr: { repeaters: [], rssi: -88, protocolDataRate: 3 },
        nlwr: { repeaters: [4], rssi: -95, protocolDataRate: 2 },
        rssi: -88,
        rtt: 45.6,
        commandsTX: 120,
        commandsRX: 118,
        commandsDroppedTX: 2,
        commandsDroppedRX: 1,
        lastSeen: new Date('2026-10-18T12:00:00.000Z'),
      };
      Object.assign(node, extra);
      mockDriver.controller.emit('node added', node);

      return node;
    };

    beforeEach(() => {
      mockDriver.controller.getKnownLifelineRoutes = jest.fn().mockReturnValue(new Map());
      mockDriver.controller.getNodeNeighbors = jest.fn().mockResolvedValue([6, 4]);
      mockDriver.controller.getBackgroundRSSI = jest
        .fn()
        .mockResolvedValue({ rssiChannel0: -100, rssiChannel1: -98 });
    });

    it('reports what the controller holds for the node', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode();

      const report = await controller.getNodeRouteDiagnostics(5);

      expect(report).toMatchObject({
        nodeId: 5,
        name: "Nico's Shade",
        status: 4,
        neighbors: [4, 6],
        lastWorkingRoute: { repeaters: [], direct: true, ackRSSI: -88, protocolDataRate: 3 },
        nextToLastWorkingRoute: { repeaters: [4], direct: false, ackRSSI: -95 },
        averageAckRSSI: -88,
        roundTripTimeMs: 45.6,
        commandsTX: 120,
        commandsRX: 118,
        commandsDroppedTX: 2,
        commandsDroppedRX: 1,
        lastSeen: '2026-10-18T12:00:00.000Z',
        backgroundRSSI: { rssiChannel0: -100, rssiChannel1: -98 },
      });
    });

    it.each([
      [127, 'N/A'],
      [126, 'Receiver saturated'],
      [125, 'No signal detected'],
    ])('reports RSSI error state %i as words, never as a dBm figure', async (code, words) => {
      mockDriver.controller.getBackgroundRSSI = jest
        .fn()
        .mockResolvedValue({ rssiChannel0: code, rssiChannel1: -98, rssiChannel2: code });
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode({
        statistics: {
          lwr: { repeaters: [4], rssi: code, protocolDataRate: 2 },
          nlwr: { repeaters: [], rssi: -80, protocolDataRate: 3 },
          rssi: code,
        },
      });

      const report = await controller.getNodeRouteDiagnostics(5);

      expect(report.lastWorkingRoute?.ackRSSI).toBe(words);
      expect(report.nextToLastWorkingRoute?.ackRSSI).toBe(-80);
      expect(report.averageAckRSSI).toBe(words);
      expect(report.backgroundRSSI).toEqual({
        rssiChannel0: words,
        rssiChannel1: -98,
        rssiChannel2: words,
      });
    });

    it('keeps the strongest and weakest measurable values as numbers', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode({ statistics: { rssi: -128, lwr: { repeaters: [], rssi: 124 } } });

      const report = await controller.getNodeRouteDiagnostics(5);

      expect(report.averageAckRSSI).toBe(-128);
      expect(report.lastWorkingRoute?.ackRSSI).toBe(124);
    });

    it('passes on which two nodes the most recent transmission failed between', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode({
        statistics: { lwr: { repeaters: [4], rssi: -86, routeFailedBetween: [4, 5] } },
      });

      const report = await controller.getNodeRouteDiagnostics(5);

      expect(report.lastWorkingRoute?.routeFailedBetween).toEqual([4, 5]);
    });

    it('keeps the rest of the report when the neighbor query fails', async () => {
      mockDriver.controller.getNodeNeighbors = jest.fn().mockRejectedValue(new Error('timeout'));
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode();

      const report = await controller.getNodeRouteDiagnostics(5);

      expect(report.neighbors).toBeUndefined();
      expect(report.lastWorkingRoute).toBeDefined();
      expect(report.backgroundRSSI).toBeDefined();
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('Could not read neighbors'));
    });

    it('keeps the rest of the report when the background RSSI query fails', async () => {
      mockDriver.controller.getBackgroundRSSI = jest.fn().mockRejectedValue(new Error('busy'));
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode();

      const report = await controller.getNodeRouteDiagnostics(5);

      expect(report.backgroundRSSI).toBeUndefined();
      expect(report.neighbors).toEqual([4, 6]);
      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining('Could not read background RSSI'),
      );
    });

    it('leaves out a background channel the controller could not measure', async () => {
      mockDriver.controller.getBackgroundRSSI = jest
        .fn()
        .mockResolvedValue({ rssiChannel0: -100, rssiChannel1: -98, rssiChannel2: undefined });
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode();

      const report = await controller.getNodeRouteDiagnostics(5);

      // toEqual would treat a present-but-undefined key as absent, so the keys are compared.
      expect(Object.keys(report.backgroundRSSI ?? {})).toEqual(['rssiChannel0', 'rssiChannel1']);
    });

    it('falls back to the known lifeline routes when the node has no statistics yet', async () => {
      mockDriver.controller.getKnownLifelineRoutes = jest.fn().mockReturnValue(
        new Map([[5, { lwr: { repeaters: [4], rssi: -91, protocolDataRate: 2 } }]]),
      );
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode({ statistics: undefined });

      const report = await controller.getNodeRouteDiagnostics(5);

      expect(report.lastWorkingRoute).toMatchObject({ repeaters: [4], direct: false, ackRSSI: -91 });
      expect(report.nextToLastWorkingRoute).toBeUndefined();
      expect(report.lastSeen).toBeUndefined();
    });

    it('names a node by its label when it has no name', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode({ name: undefined, label: 'Somfy Motorized Shade' });

      expect((await controller.getNodeRouteDiagnostics(5)).name).toBe('Somfy Motorized Shade');
    });

    it('rejects a node it does not know', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      await expect(controller.getNodeRouteDiagnostics(99)).rejects.toThrow('Node 99 not found');
      await expect(controller.getNodeRouteDiagnostics(Number.NaN)).rejects.toThrow('not found');
    });

    it('rejects when the driver has not started', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');

      await expect(controller.getNodeRouteDiagnostics(5)).rejects.toThrow('Driver not started');
    });
  });

  describe('network heal lifecycle', () => {
    const addNode = (nodeId: number, status: number) => {
      const node = new EventEmitter() as any;
      node.nodeId = nodeId;
      node.status = status;
      mockDriver.controller.emit('node added', node);
      return node;
    };

    it('starts exactly one rebuild for repeated start requests', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const results = await Promise.all([
        controller.startHealing(),
        controller.startHealing(),
        controller.startHealing(),
      ]);

      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledTimes(1);
      expect(results).toEqual(['started', 'started', 'started']);
    });

    it('reports failure when the controller refuses and nothing is running', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      mockDriver.controller.beginRebuildingRoutes.mockReturnValueOnce(false);
      mockDriver.controller.isRebuildingRoutes = false;

      await expect(controller.startHealing()).resolves.toBe('refused');
      expect(controller.isHealing()).toBe(false);
    });

    it('never fabricates a completion event when every node is finished', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      controller.on('heal network done', onDone);

      jest.useFakeTimers();
      await controller.startHealing();
      mockDriver.controller.emit(
        'rebuild routes progress',
        new Map([
          [4, 'done'],
          [5, 'done'],
        ]),
      );

      jest.advanceTimersByTime(60000);

      expect(onDone).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(true);
    });

    it('ignores a completion for a rebuild it no longer owns', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      const onStatus = jest.fn();
      controller.on('heal network done', onDone);

      await controller.startHealing();
      await controller.stopHealing();
      controller.on('status updated', onStatus);

      /**
       * stopRebuildingRoutes clears the driver's progress map and the orphaned task can still
       * finish, so this arrives with only the nodes it managed afterwards. Reporting it would
       * announce a 100% completion for a heal the user cancelled.
       */
      mockDriver.controller.emit('rebuild routes done', new Map([[7, 'done']]));

      expect(onDone).not.toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalledWith('Heal Network Done');
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('Heal Network Complete'));
    });

    it('does not let a finished heal clear the status of the next one', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      jest.useFakeTimers();
      await controller.startHealing();
      mockDriver.controller.emit('rebuild routes done', new Map([[4, 'done']]));

      // A second heal starts inside the five second window the first one's epilogue owns.
      jest.advanceTimersByTime(1000);
      await controller.startHealing();

      const onStatus = jest.fn();
      controller.on('status updated', onStatus);
      jest.advanceTimersByTime(10000);

      mockDriver.controller.emit('rebuild routes progress', new Map([[4, 'pending']]));

      expect(onStatus).not.toHaveBeenCalledWith('Driver Ready');
      expect(onStatus).toHaveBeenLastCalledWith('Heal: 0/1');
    });

    it('counts pending nodes as unfinished in the progress it reports', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onStatus = jest.fn();
      controller.on('status updated', onStatus);

      await controller.startHealing();
      mockDriver.controller.emit(
        'rebuild routes progress',
        new Map([
          [4, 'done'],
          [5, 'pending'],
          [6, 'skipped'],
          [8, 'skipped'],
          [9, 'skipped'],
        ]),
      );

      expect(onStatus).toHaveBeenCalledWith('Heal: 4/5');
    });

    it('completes only on the genuine completion event', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      controller.on('heal network done', onDone);

      await controller.startHealing();
      const result = new Map([
        [4, 'done'],
        [5, 'done'],
        [6, 'skipped'],
      ]);
      mockDriver.controller.emit('rebuild routes done', result);

      expect(onDone).toHaveBeenCalledWith(result);
      expect(controller.isHealing()).toBe(false);
    });

    it('allows a new heal once the previous one completed', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      await controller.startHealing();
      mockDriver.controller.emit('rebuild routes done', new Map([[4, 'done']]));
      await controller.startHealing();

      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledTimes(2);
    });

    it('reports a timeout without forging a library completion event', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      const onStopped = jest.fn();
      controller.on('heal network done', onDone);
      controller.on('heal network stopped', onStopped);

      jest.useFakeTimers();
      await controller.startHealing();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      expect(onStopped).toHaveBeenCalledWith('timeout');
      expect(onDone).not.toHaveBeenCalled();
      expect(mockDriver.controller.stopRebuildingRoutes).toHaveBeenCalled();
      expect(controller.isHealing()).toBe(false);
    });

    it('still reports a timeout when stopping the rebuild rejects', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);

      const onStopped = jest.fn();
      const onDone = jest.fn();
      controller.on('heal network stopped', onStopped);
      controller.on('heal network done', onDone);

      mockDriver.controller.stopRebuildingRoutes.mockImplementationOnce(() => {
        throw new Error('controller is busy');
      });

      jest.useFakeTimers();
      await controller.startHealing();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
      jest.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));

      process.off('unhandledRejection', unhandled);

      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to stop the timed-out heal: controller is busy'),
      );
      expect(onStopped).toHaveBeenCalledWith('timeout');
      expect(onDone).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(false);
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('closes the lifecycle when the heal is cancelled', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onStopped = jest.fn();
      controller.on('heal network stopped', onStopped);

      await controller.startHealing();
      await controller.stopHealing();

      expect(onStopped).toHaveBeenCalledWith('cancelled');
      expect(controller.isHealing()).toBe(false);
    });

    it('does not start a second rebuild while the driver is still running one', async () => {
      /**
       * stopRebuildingRoutes removes the task asynchronously, and the parent task is not in the
       * scheduler's queue while it waits on a node, so it resumes and keeps going. The driver is
       * therefore the authority on whether a rebuild is running, not this plugin's own state.
       */
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      await controller.startHealing();
      await controller.stopHealing();

      mockDriver.controller.isRebuildingRoutes = true;
      mockDriver.controller.beginRebuildingRoutes.mockClear();

      /**
       * Refused rather than adopted. An adopted rebuild inherits a progress map the driver has
       * already cleared, so every later report would look like 100% - the very defect this
       * change exists to remove.
       */
      await expect(controller.startHealing()).resolves.toBe('busy');

      expect(mockDriver.controller.beginRebuildingRoutes).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('still rebuilding routes'));
    });

    it('does not time out a heal that was asked to include sleeping devices', async () => {
      /**
       * The driver emits nothing while it waits for a device to wake, so an inactivity watchdog
       * would cancel a run that is behaving exactly as configured.
       */
      controller = new ZWaveController(log, '/dev/ttyACM0', {
        healIncludesSleepingDevices: true,
      });
      const onStopped = jest.fn();
      controller.on('heal network stopped', onStopped);

      await controller.start();
      jest.useFakeTimers();
      await controller.startHealing();

      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(onStopped).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(true);
    });

    it('passes the configured sleeping-device policy to the driver', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      await controller.startHealing();
      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledWith({
        includeSleeping: false,
      });

      await controller.stop();
      controller = new ZWaveController(log, '/dev/ttyACM0', {
        healIncludesSleepingDevices: true,
      });
      await controller.start();
      await controller.startHealing();
      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenLastCalledWith({
        includeSleeping: true,
      });
    });

    it('ignores a progress event that arrives after the heal was cancelled', async () => {
      /**
       * Cancelling leaves the library's task briefly alive and it emits one last progress event
       * on its way out. Treating that as a running rebuild would revive a heal the user had just
       * stopped, and then block the next one until the watchdog expired.
       */
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      await controller.startHealing();
      await controller.stopHealing();

      const onProgress = jest.fn();
      const onStatus = jest.fn();
      controller.on('heal network progress', onProgress);
      controller.on('status updated', onStatus);

      mockDriver.controller.emit('rebuild routes progress', new Map([[4, 'pending']]));

      // The guard has to suppress the side effects, not merely leave the end state tidy.
      expect(controller.isHealing()).toBe(false);
      expect(onProgress).not.toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalledWith(expect.stringMatching(/^Heal: /));

      mockDriver.controller.beginRebuildingRoutes.mockClear();
      await controller.startHealing();
      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledTimes(1);
    });

    it('reports sleeping and offline nodes as skipped rather than failed', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const onDone = jest.fn();
      controller.on('heal network done', onDone);

      await controller.startHealing();
      // Skipped rather than failed is a consequence of asking the driver to leave them alone.
      expect(mockDriver.controller.beginRebuildingRoutes).toHaveBeenCalledWith({
        includeSleeping: false,
      });
      mockDriver.controller.emit(
        'rebuild routes done',
        new Map([
          [4, 'done'],
          [5, 'done'],
          [6, 'skipped'],
          [8, 'skipped'],
          [9, 'skipped'],
        ]),
      );

      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining('done 2, failed 0, skipped 3, pending 0'),
      );
    });

    it('keeps the watchdog alive while the rebuild is still reporting progress', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      const onStopped = jest.fn();
      controller.on('heal network stopped', onStopped);

      await controller.start();
      jest.useFakeTimers();
      await controller.startHealing();

      /**
       * A large network can take far longer in total than the idle timeout. As long as it keeps
       * reporting, it must not be cancelled.
       */
      for (let minute = 0; minute < 40; minute++) {
        await jest.advanceTimersByTimeAsync(60 * 1000);
        mockDriver.controller.emit('rebuild routes progress', new Map([[4, 'pending']]));
      }

      expect(onStopped).not.toHaveBeenCalled();
      expect(controller.isHealing()).toBe(true);
      expect(mockDriver.controller.stopRebuildingRoutes).not.toHaveBeenCalled();
    });

    it('times out only once the rebuild stops reporting progress', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      const onStopped = jest.fn();
      controller.on('heal network stopped', onStopped);

      await controller.start();
      jest.useFakeTimers();
      await controller.startHealing();

      await jest.advanceTimersByTimeAsync(9 * 60 * 1000);
      mockDriver.controller.emit('rebuild routes progress', new Map([[4, 'pending']]));
      await jest.advanceTimersByTimeAsync(9 * 60 * 1000);
      expect(onStopped).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(onStopped).toHaveBeenCalledWith('timeout');
    });
  });
  describe('failed node removal safety', () => {
    /** `sleeps` models a battery device: not always listening, not a FLiRS node. */
    const addNode = (nodeId: number, status: number, name?: string, sleeps = false) => {
      const node = new EventEmitter() as any;
      node.nodeId = nodeId;
      node.status = status;
      node.name = name;
      node.isListening = !sleeps;
      node.isFrequentListening = false;
      mockDriver.controller.emit('node added', node);
      return node;
    };

    beforeEach(() => {
      mockDriver.controller.isFailedNode = jest.fn().mockResolvedValue(false);
      mockDriver.controller.removeFailedNode = jest.fn().mockResolvedValue(undefined);
    });

    it('protects a controller whose own node ID is not 1', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode(7, 3, 'Controller');
      Object.defineProperty(mockDriver.controller, 'ownNodeId', { value: 7, configurable: true });
      mockDriver.controller.isFailedNode.mockResolvedValue(true);
      try {
        await expect(controller.assessFailedNodeRemoval(7)).resolves.toMatchObject({ eligible: false });
        await expect(controller.removeFailedNode(7, 7)).rejects.toThrow(/controller/);
        expect(mockDriver.controller.removeFailedNode).not.toHaveBeenCalled();
      } finally { delete mockDriver.controller.ownNodeId; }
    });

    it('refuses to remove a temporarily dead but valid node', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      // Node 8 is a real shade whose battery pack is out for charging.
      addNode(8, 3, "Lia's Shade");

      const assessment = await controller.assessFailedNodeRemoval(8);

      expect(assessment.eligible).toBe(false);
      expect(assessment.reason).toContain('does not consider Node 8 failed');
      await expect(controller.removeFailedNode(8, 8)).rejects.toThrow(
        /does not consider Node 8 failed/,
      );
      expect(mockDriver.controller.removeFailedNode).not.toHaveBeenCalled();
    });

    it('never removes a sleeping node', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode(6, 1, "Nico's Shade Remote", true);
      mockDriver.controller.isFailedNode.mockResolvedValue(true);

      const assessment = await controller.assessFailedNodeRemoval(6);

      expect(assessment.eligible).toBe(false);
      expect(assessment.reason).toContain('sleeping');
      await expect(controller.removeFailedNode(6, 6)).rejects.toThrow(/sleeping/);
      expect(mockDriver.controller.removeFailedNode).not.toHaveBeenCalled();
    });

    it('never removes a sleeping node that happens to be awake', async () => {
      // A battery device alternates between Asleep and Awake. Checking only Asleep would make it
      // removable in whichever instant the controller caught it awake.
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode(6, 2, "Nico's Shade Remote", true);
      mockDriver.controller.isFailedNode.mockResolvedValue(true);

      const assessment = await controller.assessFailedNodeRemoval(6);

      expect(assessment.eligible).toBe(false);
      expect(assessment.reason).toContain('sleeping');
      await expect(controller.removeFailedNode(6, 6)).rejects.toThrow(/sleeping/);
      expect(mockDriver.controller.removeFailedNode).not.toHaveBeenCalled();
    });

    it('refuses the removal when the controller cannot say whether the node failed', async () => {
      // Fail closed: a controller that times out mid-query must not leave a node removable.
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode(7, 3, 'Dead-looking node');
      mockDriver.controller.isFailedNode.mockRejectedValue(new Error('Controller timed out'));

      const assessment = await controller.assessFailedNodeRemoval(7);

      expect(assessment.eligible).toBe(false);
      await expect(controller.removeFailedNode(7, 7)).rejects.toThrow();
      expect(mockDriver.controller.removeFailedNode).not.toHaveBeenCalled();
    });

    it('never removes a battery device whose status is not yet known', async () => {
      // The hole the status check left: a battery node sits in Unknown between a restart and its
      // first wake-up, which is exactly when a user reaches for Remove.
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode(9, 0, "Lia's Shade Remote", true);
      mockDriver.controller.isFailedNode.mockResolvedValue(true);

      const assessment = await controller.assessFailedNodeRemoval(9);

      expect(assessment.eligible).toBe(false);
      await expect(controller.removeFailedNode(9, 9)).rejects.toThrow();
      expect(mockDriver.controller.removeFailedNode).not.toHaveBeenCalled();
    });

    it('never removes a node that is not part of this network', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const assessment = await controller.assessFailedNodeRemoval(42);

      expect(assessment.eligible).toBe(false);
      await expect(controller.removeFailedNode(42, 42)).rejects.toThrow();
      expect(mockDriver.controller.removeFailedNode).not.toHaveBeenCalled();
    });

    it('reports a removal the controller could not carry out', async () => {
      // Swallowing this would let the UI tell the user a node was removed when it was not.
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode(11, 3, 'Dead node');
      mockDriver.controller.isFailedNode.mockResolvedValue(true);
      mockDriver.controller.removeFailedNode.mockRejectedValue(new Error('Removal failed'));

      await expect(controller.removeFailedNode(11, 11)).rejects.toThrow(/Removal failed/);
    });

    it('never removes the controller node', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const assessment = await controller.assessFailedNodeRemoval(1);

      expect(assessment.eligible).toBe(false);
      await expect(controller.removeFailedNode(1, 1)).rejects.toThrow(/controller/);
    });

    it('requires the confirmation to match the node ID', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode(2, 3);
      mockDriver.controller.isFailedNode.mockResolvedValue(true);

      await expect(controller.removeFailedNode(2, 3)).rejects.toThrow(/confirmation/);
      expect(mockDriver.controller.removeFailedNode).not.toHaveBeenCalled();
    });

    it('checks with the controller immediately before removing', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode(2, 3, 'Ghost');
      mockDriver.controller.isFailedNode.mockResolvedValue(true);

      await controller.removeFailedNode(2, 2);

      expect(mockDriver.controller.isFailedNode).toHaveBeenCalledWith(2);
      expect(mockDriver.controller.removeFailedNode).toHaveBeenCalledWith(2);
    });

    it('logs why a node is or is not eligible', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      addNode(8, 3, "Lia's Shade");

      await controller.removeFailedNode(8, 8).catch(() => undefined);

      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Failed-node removal check for Node 8 (Lia's Shade): not eligible"),
      );
    });
  });

  describe('what startup writes to the log', () => {
    const infoText = () => log.info.mock.calls.flat().map((e: unknown) => String(e)).join('\n');

    const addNode = (over: Record<string, unknown> = {}) => {
      const node = new EventEmitter() as any;
      node.nodeId = 4;
      node.status = 0; // Unknown, which is what every node reports before it is interviewed
      node.interviewStage = 5;
      node.ready = false;
      Object.assign(node, over);
      mockDriver.controller.emit('node added', node);

      return node;
    };

    it('gives the Home ID in both bases, so it can be matched to the driver cache', async () => {
      mockDriver.controller.homeId = 3563963922;
      controller = new ZWaveController(log, '/dev/ttyACM0');

      await controller.start();

      expect(infoText()).toContain('Controller Home ID: 3563963922 (0xd46dc612)');
    });

    it('waits for a Home ID rather than reporting that it has none', async () => {
      /**
       * The driver reports the Home ID as possibly not known, and it is still unknown when the
       * driver says it is ready. Writing the line there would print `undefined` to a reader who
       * can do nothing with it, so it is written once startup has a number.
       */
      mockDriver.controller.homeId = undefined;
      controller = new ZWaveController(log, '/dev/ttyACM0');

      const started = controller.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The driver has reported ready by now, which is where the line used to be written.
      expect(infoText()).not.toContain('Controller Home ID');

      mockDriver.controller.homeId = 1;
      await started;

      expect(infoText()).toContain('Controller Home ID: 1 (0x1)');
      expect(infoText()).not.toContain('undefined');
    });

    it('leaves the status out while it is still unknown', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      addNode();

      expect(infoText()).toContain('Node 4 joined the network (Interview Stage: 5)');
      expect(infoText()).not.toContain('Status: Unknown');
    });

    it('gives the status once the node reports one', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      addNode({ status: 4 });

      expect(infoText()).toContain('Node 4 joined the network (Status: Alive, Interview Stage: 5)');
    });

    it('never writes a device serial number, at any level', async () => {
      /**
       * A serial number identifies one particular piece of a household's hardware, and debug
       * logs are the ones people attach to issue reports. That a device reported one is worth
       * saying, because it tells a reader the request succeeded; the number is not.
       */
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const node = addNode({
        ready: true,
        supportsCC: () => true,
        commandClasses: {
          'Manufacturer Specific': {
            deviceSpecificGet: jest.fn().mockResolvedValue('SN-0042-ABCDEF'),
          },
        },
      });
      node.emit('ready');
      await new Promise((resolve) => setImmediate(resolve));

      const everything = (['debug', 'info', 'warn', 'error'] as const)
        .flatMap((level) => log[level].mock.calls.flat())
        .map((entry: unknown) => String(entry))
        .join('\n');

      expect(everything).not.toContain('SN-0042-ABCDEF');

      // That one arrived is bookkeeping, so it belongs with the rest of the telemetry
      // rather than beside the outcomes a reader is looking for.
      const debugged = log.debug.mock.calls.flat().map((e: unknown) => String(e)).join('\n');
      expect(debugged).toContain('Node 4 reported a device serial number');
      expect(infoText()).not.toContain('reported a device serial number');
    });

    it('treats losing a node as degradation and getting it back as recovery', async () => {
      // An unreachable node is the plugin continuing in a degraded state, which is what warn
      // is for. Its return is an outcome worth reporting rather than a problem.
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const node = addNode();
      node.emit('dead');
      node.emit('alive');

      const warned = log.warn.mock.calls.flat().map((e: unknown) => String(e)).join('\n');
      expect(warned).toContain('Node 4 is not responding');
      expect(infoText()).toContain('Node 4 is responding again');
      expect(infoText()).not.toContain('not responding');
    });

    it('says once that a node joined, and does not say it twice', async () => {
      // Counting only the new phrasing would miss a second line that used different words,
      // so this counts every info line that mentions the node at all.
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();
      log.info.mockClear();

      const node = addNode({ status: 4, name: 'Hall' });

      const aboutNode = log.info.mock.calls
        .flat()
        .map((e: unknown) => String(e))
        .filter((line: string) => line.includes('Node 4'));

      expect(aboutNode).toHaveLength(1);
      expect(aboutNode[0]).toContain('Node 4 (Hall) joined the network');
      expect(aboutNode[0]).toContain('Status: Alive, Interview Stage: 5');
      expect(aboutNode[0]).not.toContain('added to controller');
    });

    it('does not announce the existing network as newly joined', async () => {
      /**
       * Startup walks every node the controller already knows through the same code as a node
       * that has just arrived. Those devices have been on the network for months.
       */
      const existing = new EventEmitter() as any;
      existing.nodeId = 4;
      existing.status = 4;
      existing.interviewStage = 5;
      existing.name = 'Hall';
      mockDriver.controller.nodes = new Map([[4, existing]]);

      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const aboutNode = log.info.mock.calls
        .flat()
        .map((e: unknown) => String(e))
        .filter((line: string) => line.includes('Node 4'));

      expect(aboutNode).toHaveLength(1);
      expect(aboutNode[0]).toContain('Node 4 (Hall) is on the network');
      expect(aboutNode[0]).not.toContain('joined');
    });

    it('names the device when it leaves, and says it once', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const node = addNode({ status: 4, name: 'Hall' });
      log.info.mockClear();
      mockDriver.controller.emit('node removed', node);

      const aboutNode = log.info.mock.calls
        .flat()
        .map((e: unknown) => String(e))
        .filter((line: string) => line.includes('Node 4'));

      expect(aboutNode).toHaveLength(1);
      expect(aboutNode[0]).toBe('Node 4 (Hall) removed from the network');
    });

    it('never says a node was added to the controller', async () => {
      // The phrase named an internal component and was written beside a second line that
      // said the same thing with more detail.
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const node = addNode({ status: 4, name: 'Hall' });
      mockDriver.controller.emit('node removed', node);

      const everything = (['debug', 'info', 'warn', 'error'] as const)
        .flatMap((level) => log[level].mock.calls.flat())
        .map((e: unknown) => String(e))
        .join('\n');

      expect(everything).not.toContain('added to controller');
      expect(everything).not.toContain('removed from controller');
    });

    it('keeps routine node telemetry at debug', async () => {
      // Interview progress and a battery device's sleep cycle are continuous and say nothing
      // about a change the reader asked for.
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const node = addNode();
      node.emit('interview stage completed', node, 'NodeInfo');
      node.emit('wake up');
      node.emit('sleep');

      const written = infoText();
      expect(written).not.toContain('interview stage completed');
      expect(written).not.toContain('woken up');
      expect(written).not.toContain('gone to sleep');

      const debugged = log.debug.mock.calls.flat().map((e: unknown) => String(e)).join('\n');
      expect(debugged).toContain('interview stage completed: NodeInfo');
      expect(debugged).toContain('has woken up');
      expect(debugged).toContain('has gone to sleep');
    });

    it('does not claim that sleeping and waking control the interview', async () => {
      // The driver resumes an interview on its own schedule. These lines only report what the
      // radio did, so they should not describe what they do not govern.
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const node = addNode();
      node.emit('wake up');
      node.emit('sleep');

      const debugged = log.debug.mock.calls.flat().map((e: unknown) => String(e)).join('\n');
      expect(debugged).not.toContain('Interview will resume');
      expect(debugged).not.toContain('Interview is paused');
    });

    it('keeps the plugin\u2019s own bookkeeping out of the ordinary log', async () => {
      controller = new ZWaveController(log, '/dev/ttyACM0');
      await controller.start();

      const node = addNode({ ready: true });
      node.emit('ready');

      const written = infoText();
      expect(written).not.toContain('registered with event listeners');
      expect(written).not.toContain('already ready, emitting');
      expect(written).not.toContain('is ready (Interview Stage');
    });
  });
});
