const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const fs = require('fs');
const path = require('path');
const http = require('http');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('get-nodes', async () => {
      return await this.ipcRequest('/nodes', 'GET');
    });

    this.onRequest('rename-node', async ({ nodeId, name }) => {
      return await this.ipcRequest(`/nodes/${nodeId}/name`, 'POST', { name });
    });

    this.onRequest('cleanup-stale-accessories', async () => {
      return await this.ipcRequest('/accessories/prune-stale', 'POST');
    });

    this.onRequest('check-firmware', async (nodeId) => {
      return await this.ipcRequest(`/firmware/updates/${nodeId}`, 'GET');
    });

    this.onRequest('start-update', async ({ nodeId, update }) => {
      return await this.ipcRequest(`/firmware/update/${nodeId}`, 'POST', update);
    });

    this.onRequest('abort-update', async (nodeId) => {
      return await this.ipcRequest(`/firmware/abort/${nodeId}`, 'POST');
    });

    this.ready();
  }

  async ipcRequest(url, method, body = null) {
    const storagePath = this.homebridgeStoragePath || process.env.HOMEBRIDGE_STORAGE_PATH || path.join(process.cwd(), '.homebridge');
    const portFile = path.join(storagePath, 'homebridge-zwave-usb.port');

    if (!fs.existsSync(portFile)) {
      console.error(`IPC Port file not found at: ${portFile}`);
      throw new Error('Plugin IPC server not found. Is the plugin running?');
    }

    const port = parseInt(fs.readFileSync(portFile, 'utf8'), 10);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: port,
        path: url,
        method: method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const rawPayload = data.trim();
          let parsedPayload = rawPayload;
          try {
            parsedPayload = rawPayload ? JSON.parse(rawPayload) : null;
          } catch (e) {
            parsedPayload = rawPayload;
          }

          if ((res.statusCode || 500) >= 400) {
            const message =
              parsedPayload && typeof parsedPayload === 'object' && 'error' in parsedPayload
                ? parsedPayload.error
                : rawPayload || `IPC Request failed with status ${res.statusCode}`;
            reject(new Error(String(message)));
            return;
          }

          resolve(parsedPayload);
        });
      });

      req.on('error', (err) => {
        reject(new Error(`IPC Request failed: ${err.message}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}

(() => new UiServer())();
