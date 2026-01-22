import { Logger } from 'homebridge';
import WebSocket from 'ws';
import { EventEmitter } from 'events';

// Mock setup must be handled carefully with hoisting
const mockWsInstance = new EventEmitter() as any;
mockWsInstance.readyState = 1; // WebSocket.OPEN
mockWsInstance.send = jest.fn();
mockWsInstance.close = jest.fn();
mockWsInstance.ping = jest.fn();

const MockWebSocket = jest.fn().mockImplementation(() => mockWsInstance);
(MockWebSocket as any).OPEN = 1;

jest.mock('ws', () => {
  return MockWebSocket;
});

// Import after mock
import { ZWaveRemoteController, VirtualZWaveNode } from '../../src/zwave/ZWaveRemoteController';

describe('ZWaveRemoteController', () => {
  let controller: ZWaveRemoteController;
  let log: jest.Mocked<Logger>;
  
  // Access the singleton mock
  const mockWs = mockWsInstance;

  const sampleNodeState = {
    nodeId: 5,
    status: 4, // Alive
    ready: true,
    deviceConfig: {
      manufacturer: 'Aeotec',
      label: 'Smart Switch 7',
    },
    values: [
      {
        endpoint: 0,
        commandClass: 37, // Binary Switch
        property: 'currentValue',
        value: true,
        metadata: {
          label: 'Current Value',
          type: 'boolean',
          readable: true,
          writeable: false,
        },
      },
      {
        endpoint: 0,
        commandClass: 49, // Multilevel Sensor
        property: 'Air temperature',
        value: 72.5,
        metadata: {
          unit: '°F',
          readable: true,
        },
      },
    ],
  };

  beforeEach(() => {
    log = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as any;
    
    // Reset mocks
    mockWs.removeAllListeners();
    mockWs.send.mockClear();
    
    controller = new ZWaveRemoteController(log, 'ws://localhost:3000');
  });

  test('should connect, start listening, and hydrate nodes', async () => {
    const startPromise = controller.start();
    
    // 1. WebSocket Opens
    mockWs.emit('open');

    // 2. Expect 'startListening' command
    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"command":"startListening"'));
    
    // Extract messageId from the sent command to respond correctly
    const sentCommand = JSON.parse(mockWs.send.mock.calls[0][0]);
    const msgId = sentCommand.messageId;

    // 3. Simulate Server Response (Dump State)
    const mockResponse = {
      type: 'result',
      messageId: msgId,
      success: true,
      result: {
        state: {
          controller: { homeId: 0x12345678 },
          nodes: [sampleNodeState],
        },
      },
    };
    mockWs.emit('message', JSON.stringify(mockResponse));

    await startPromise;

    // Verification
    expect(controller.homeId).toBe(0x12345678);
    expect(controller.nodes.has(5)).toBe(true);
    
    const node = controller.nodes.get(5) as VirtualZWaveNode;
    expect(node).toBeDefined();
    expect(node.ready).toBe(true);
  });

  test('VirtualZWaveNode should mimic ZWaveNode behavior', async () => {
    // Setup node manually
    const node = new VirtualZWaveNode(5, controller, sampleNodeState);

    // 1. getValue
    expect(node.getValue({ commandClass: 37, property: 'currentValue', endpoint: 0 })).toBe(true);
    expect(node.getValue({ commandClass: 49, property: 'Air temperature', endpoint: 0 })).toBe(72.5);

    // 2. getValueMetadata
    const meta = node.getValueMetadata({ commandClass: 49, property: 'Air temperature', endpoint: 0 });
    expect(meta.unit).toBe('°F');

    // 3. supportsCC
    expect(node.supportsCC(37)).toBe(true);
    expect(node.supportsCC(49)).toBe(true);
    expect(node.supportsCC(99)).toBe(false); // Unknown CC

    // 4. getAllEndpoints
    // Should find endpoint 0
    const endpoints = node.getAllEndpoints();
    expect(endpoints.length).toBe(1);
    expect(endpoints[0].index).toBe(0);
    
    // Endpoint should support CCs that define values on it
    expect(endpoints[0].supportsCC(37)).toBe(true);
  });

  test('should handle "value updated" event from server', () => {
    // We need to initialize the controller and socket first
    controller.start();
    mockWs.emit('open'); // Sets up listeners

    const node = new VirtualZWaveNode(5, controller, sampleNodeState);
    controller.nodes.set(5, node);

    const spy = jest.fn();
    controller.on('value updated', spy);
    node.on('value updated', spy);

    // Simulate Event
    const eventMsg = {
      type: 'event',
      event: {
        source: 'node',
        event: 'value updated',
        nodeId: 5,
        args: {
          commandClass: 37,
          endpoint: 0,
          property: 'currentValue',
          newValue: false, // Changed from true
          prevValue: true,
        },
      },
    };
    
    mockWs.emit('message', JSON.stringify(eventMsg));

    // Verify Node State Updated
    expect(node.getValue({ commandClass: 37, property: 'currentValue', endpoint: 0 })).toBe(false);

    // Verify Events Emitted
    // Once on the node, once on the controller
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('setValue should send command to server', async () => {
    controller.start();
    mockWs.emit('open');

    const node = new VirtualZWaveNode(5, controller, sampleNodeState);
    
    const setPromise = node.setValue(
        { commandClass: 37, property: 'targetValue', endpoint: 0 }, 
        true
    );

    // Expect WS send
    // The first call was startListening, the second should be setValue
    const lastCall = mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0];
    const msg = JSON.parse(lastCall);
    
    expect(msg.command).toBe('node.setValue');
    expect(msg.nodeId).toBe(5);
    expect(msg.valueId).toEqual({ commandClass: 37, property: 'targetValue', endpoint: 0 });
    expect(msg.value).toBe(true);

    // Simulate success response
    const response = {
        type: 'result',
        messageId: msg.messageId,
        success: true,
        result: { success: true }
    };
    mockWs.emit('message', JSON.stringify(response));

    await setPromise;
  });

  test('should handle "node removed" event from server', () => {
    controller.start();
    mockWs.emit('open');

    const node = new VirtualZWaveNode(5, controller, sampleNodeState);
    controller.nodes.set(5, node);

    const spy = jest.fn();
    controller.on('node removed', spy);

    const eventMsg = {
      type: 'event',
      event: {
        source: 'controller',
        event: 'node removed',
        nodeId: 5,
      },
    };

    mockWs.emit('message', JSON.stringify(eventMsg));

    expect(controller.nodes.has(5)).toBe(false);
    expect(spy).toHaveBeenCalledWith(node);
  });
});
