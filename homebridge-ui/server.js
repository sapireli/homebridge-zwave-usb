const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // Handle Factory Reset requests from the UI
    this.onRequest('/factory-reset', async () => {
      console.log('[UI Server] FACTORY RESET REQUESTED');
      
      // We push the event to the main platform process
      this.pushEvent('factory-reset-triggered', {});
      
      return { success: true };
    });

    this.ready();
  }
}

(() => new UiServer())();
