const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const fs = require('fs');
const path = require('path');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // Handle Factory Reset requests from the UI
    this.onRequest('/factory-reset', async () => {
      try {
        const triggerFilePath = path.join(this.homebridgeStoragePath, 'zwave_factory_reset_trigger');
        // Create the trigger file
        fs.writeFileSync(triggerFilePath, ''); 
        this.log.info(`[UI Server] Created factory reset trigger file at: ${triggerFilePath}`);
        return { success: true };
      } catch (e) {
        this.log.error('[UI Server] Failed to create factory reset trigger file:', e.message);
        // Return an error to the UI
        return { success: false, error: e.message };
      }
    });

    this.ready();
  }
}

(() => new UiServer())();
