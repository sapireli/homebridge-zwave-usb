describe('homebridge-ui server request wiring', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('should register cleanup-stale-accessories and forward it to the IPC endpoint', async () => {
    const requests = new Map<string, (...args: any[]) => Promise<unknown>>();
    let serverInstance: { ipcRequest?: jest.Mock } | undefined;

    jest.doMock('@homebridge/plugin-ui-utils', () => {
      return {
        HomebridgePluginUiServer: class {
          homebridgeStoragePath = '/tmp';
          constructor() {
            serverInstance = this as { ipcRequest?: jest.Mock };
          }
          onRequest(name: string, handler: (...args: any[]) => Promise<unknown>) {
            requests.set(name, handler);
          }
          ready() {
            return undefined;
          }
        },
      };
    });

    jest.isolateModules(() => {
      require('../homebridge-ui/server.js');
    });

    const cleanupHandler = requests.get('cleanup-stale-accessories');
    expect(cleanupHandler).toBeDefined();

    const ipcRequest = jest.fn().mockResolvedValue({ success: true, removed: 2 });
    serverInstance!.ipcRequest = ipcRequest;
    const result = await cleanupHandler!();

    expect(ipcRequest).toHaveBeenCalledWith('/accessories/prune-stale', 'POST');
    expect(result).toEqual({ success: true, removed: 2 });
  });

  it('should register the main UI requests and forward them to the expected IPC routes', async () => {
    const requests = new Map<string, (...args: any[]) => Promise<unknown>>();
    let serverInstance: { ipcRequest?: jest.Mock } | undefined;

    jest.doMock('@homebridge/plugin-ui-utils', () => {
      return {
        HomebridgePluginUiServer: class {
          homebridgeStoragePath = '/tmp';
          constructor() {
            serverInstance = this as { ipcRequest?: jest.Mock };
          }
          onRequest(name: string, handler: (...args: any[]) => Promise<unknown>) {
            requests.set(name, handler);
          }
          ready() {
            return undefined;
          }
        },
      };
    });

    jest.isolateModules(() => {
      require('../homebridge-ui/server.js');
    });

    const ipcRequest = jest.fn().mockResolvedValue({ ok: true });
    serverInstance!.ipcRequest = ipcRequest;

    await requests.get('get-nodes')!();
    await requests.get('heal-network')!();
    await requests.get('heal-network-status')!();
    await requests.get('rename-node')!({ nodeId: 9, name: 'Office' });
    await requests.get('refresh-node-info')!(9);
    await requests.get('check-firmware')!(9);
    await requests.get('start-update')!({ nodeId: 9, update: { version: '1.2.3' } });
    await requests.get('abort-update')!(9);

    expect(ipcRequest).toHaveBeenNthCalledWith(1, '/nodes', 'GET');
    expect(ipcRequest).toHaveBeenNthCalledWith(2, '/network/heal', 'POST');
    expect(ipcRequest).toHaveBeenNthCalledWith(3, '/network/heal/status', 'GET');
    expect(ipcRequest).toHaveBeenNthCalledWith(4, '/nodes/9/name', 'POST', { name: 'Office' });
    expect(ipcRequest).toHaveBeenNthCalledWith(5, '/nodes/9/refresh-info', 'POST');
    expect(ipcRequest).toHaveBeenNthCalledWith(6, '/firmware/updates/9', 'GET');
    expect(ipcRequest).toHaveBeenNthCalledWith(7, '/firmware/update/9', 'POST', {
      version: '1.2.3',
    });
    expect(ipcRequest).toHaveBeenNthCalledWith(8, '/firmware/abort/9', 'POST');
  });

  it('should forward the node diagnostics request to the IPC endpoint', async () => {
    const requests = new Map<string, (...args: any[]) => Promise<unknown>>();
    let serverInstance: { ipcRequest?: jest.Mock } | undefined;

    jest.doMock('@homebridge/plugin-ui-utils', () => {
      return {
        HomebridgePluginUiServer: class {
          homebridgeStoragePath = '/tmp';
          constructor() {
            serverInstance = this as { ipcRequest?: jest.Mock };
          }
          onRequest(name: string, handler: (...args: any[]) => Promise<unknown>) {
            requests.set(name, handler);
          }
          ready() {
            return undefined;
          }
        },
      };
    });

    jest.isolateModules(() => {
      require('../homebridge-ui/server.js');
    });

    const ipcRequest = jest.fn().mockResolvedValue({ ok: true });
    serverInstance!.ipcRequest = ipcRequest;

    await requests.get('node-diagnostics')!(5);

    expect(ipcRequest).toHaveBeenCalledWith('/nodes/5/diagnostics', 'GET');

    await requests.get('test-covering-position')!({ nodeId: 5, position: 25 });
    await requests.get('stop-covering')!(5);

    expect(ipcRequest).toHaveBeenCalledWith('/nodes/5/test-position', 'POST', { position: 25 });
    expect(ipcRequest).toHaveBeenCalledWith('/nodes/5/test-stop', 'POST');
  });

  it('should forward the failed-node removal requests', async () => {
    const requests = new Map<string, (...args: any[]) => Promise<unknown>>();
    let serverInstance: { ipcRequest?: jest.Mock } | undefined;

    jest.doMock('@homebridge/plugin-ui-utils', () => {
      return {
        HomebridgePluginUiServer: class {
          homebridgeStoragePath = '/tmp';
          constructor() {
            serverInstance = this as { ipcRequest?: jest.Mock };
          }
          onRequest(name: string, handler: (...args: any[]) => Promise<unknown>) {
            requests.set(name, handler);
          }
          ready() {
            return undefined;
          }
        },
      };
    });

    jest.isolateModules(() => {
      require('../homebridge-ui/server.js');
    });

    const ipcRequest = jest.fn().mockResolvedValue({ ok: true });
    serverInstance!.ipcRequest = ipcRequest;

    await requests.get('check-node-removal')!(8);
    await requests.get('remove-failed-node')!({ nodeId: 8, confirmNodeId: 8 });

    expect(ipcRequest).toHaveBeenNthCalledWith(1, '/nodes/8/removal-check', 'GET');
    expect(ipcRequest).toHaveBeenNthCalledWith(2, '/nodes/8/remove-failed', 'POST', {
      confirmNodeId: 8,
    });
  });

  it('should reject IPC responses with error status codes', async () => {
    let serverInstance: any;

    jest.doMock('@homebridge/plugin-ui-utils', () => {
      return {
        HomebridgePluginUiServer: class {
          homebridgeStoragePath = '/tmp';
          constructor() {
            serverInstance = this;
          }
          onRequest() {
            return undefined;
          }
          ready() {
            return undefined;
          }
        },
      };
    });

    jest.doMock('fs', () => ({
      existsSync: jest.fn().mockReturnValue(true),
      readFileSync: jest.fn().mockReturnValue('12345'),
    }));

    jest.doMock('http', () => ({
      request: jest.fn().mockImplementation((_options, callback) => {
        const responseHandlers: Record<string, (...args: any[]) => void> = {};
        const res = {
          statusCode: 400,
          on: jest.fn((event, handler) => {
            responseHandlers[event] = handler;
          }),
        };

        callback(res);

        return {
          on: jest.fn(),
          write: jest.fn(),
          end: jest.fn(() => {
            responseHandlers.data?.('{"error":"Bad Request"}');
            responseHandlers.end?.();
          }),
        };
      }),
    }));

    jest.isolateModules(() => {
      require('../homebridge-ui/server.js');
    });

    await expect(serverInstance.ipcRequest('/nodes', 'GET')).rejects.toThrow('Bad Request');
  });
  it('should forward the device type requests to the IPC endpoints', async () => {
    const requests = new Map<string, (...args: any[]) => Promise<unknown>>();
    let serverInstance: { ipcRequest?: jest.Mock } | undefined;

    jest.doMock('@homebridge/plugin-ui-utils', () => {
      return {
        HomebridgePluginUiServer: class {
          homebridgeStoragePath = '/tmp';
          constructor() {
            serverInstance = this as { ipcRequest?: jest.Mock };
          }
          onRequest(name: string, handler: (...args: any[]) => Promise<unknown>) {
            requests.set(name, handler);
          }
          ready() {
            return undefined;
          }
        },
      };
    });

    jest.isolateModules(() => {
      require('../homebridge-ui/server.js');
    });

    const ipcRequest = jest.fn().mockResolvedValue({ ok: true });
    serverInstance!.ipcRequest = ipcRequest;
    const fingerprint = { manufacturerId: 2748, productType: 2, productId: 16 };

    await requests.get('get-node-type')!(10);
    await requests.get('set-node-type')!({
      nodeId: 10,
      primaryKind: 'window-covering',
      expectedFingerprint: fingerprint,
      expectedRevision: 'b41f0c2e',
    });
    await requests.get('clear-node-type')!({
      nodeId: 10,
      expectedFingerprint: fingerprint,
      expectedRevision: 'b41f0c2e',
    });
    await requests.get('acknowledge-type-orphan')!({
      nodeId: 10,
      observationId: 'ob-1',
      expectedFingerprint: fingerprint,
    });
    await requests.get('remove-type-override')!({ nodeId: 10, expectedRevision: 'b41f0c2e' });

    expect(ipcRequest).toHaveBeenNthCalledWith(1, '/nodes/10/type', 'GET');
    // The node number names the route, so it is not repeated in the body a write carries.
    expect(ipcRequest).toHaveBeenNthCalledWith(2, '/nodes/10/type', 'POST', {
      primaryKind: 'window-covering',
      expectedFingerprint: fingerprint,
      expectedRevision: 'b41f0c2e',
    });
    expect(ipcRequest).toHaveBeenNthCalledWith(3, '/nodes/10/type/clear', 'POST', {
      expectedFingerprint: fingerprint,
      expectedRevision: 'b41f0c2e',
    });
    expect(ipcRequest).toHaveBeenNthCalledWith(4, '/nodes/10/type/acknowledge', 'POST', {
      observationId: 'ob-1',
      expectedFingerprint: fingerprint,
    });
    expect(ipcRequest).toHaveBeenNthCalledWith(5, '/nodes/10/type/remove', 'POST', {
      expectedRevision: 'b41f0c2e',
    });
  });
});
