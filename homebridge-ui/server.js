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
    const storagePath = process.env.HOMEBRIDGE_STORAGE_PATH || path.join(process.cwd(), '.homebridge');
    const portFile = path.join(storagePath, 'homebridge-zwave-usb.port');

    if (!fs.existsSync(portFile)) {
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
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
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
