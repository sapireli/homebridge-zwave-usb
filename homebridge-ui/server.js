const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const fs = require('fs');
const path = require('path');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.ready();
  }
}

(() => new UiServer())();
