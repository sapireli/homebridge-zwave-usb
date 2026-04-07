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
    await requests.get('rename-node')!({ nodeId: 9, name: 'Office' });
    await requests.get('check-firmware')!(9);
    await requests.get('start-update')!({ nodeId: 9, update: { version: '1.2.3' } });
    await requests.get('abort-update')!(9);

    expect(ipcRequest).toHaveBeenNthCalledWith(1, '/nodes', 'GET');
    expect(ipcRequest).toHaveBeenNthCalledWith(2, '/nodes/9/name', 'POST', { name: 'Office' });
    expect(ipcRequest).toHaveBeenNthCalledWith(3, '/firmware/updates/9', 'GET');
    expect(ipcRequest).toHaveBeenNthCalledWith(
      4,
      '/firmware/update/9',
      'POST',
      { version: '1.2.3' },
    );
    expect(ipcRequest).toHaveBeenNthCalledWith(5, '/firmware/abort/9', 'POST');
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
});
