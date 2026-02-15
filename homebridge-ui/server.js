const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const fs = require('fs');
const path = require('path');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // Handle Factory Reset requests from the UI
    this.onRequest('/factory-reset', async () => {
      this.log.info('[UI Server] Received /factory-reset request.');
      const triggerFilePath = path.join(this.homebridgeStoragePath, 'zwave_factory_reset_trigger');
      this.log.info(`[UI Server] Attempting to create trigger file at: ${triggerFilePath}`);
      try {
        // Create the trigger file
        fs.writeFileSync(triggerFilePath, ''); 
        this.log.info(`[UI Server] Successfully created factory reset trigger file.`);
        return { success: true };
      } catch (e) {
        this.log.error('[UI Server] CRITICAL: Failed to create factory reset trigger file:', e.message);
        // Return an error to the UI
        return { success: false, error: e.message };
      }
    });

    this.ready();
  }
}

(() => new UiServer())();
