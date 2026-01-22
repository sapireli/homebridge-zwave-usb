import { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './platform/settings';
import { ZWaveUsbPlatform } from './platform/ZWaveUsbPlatform';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ZWaveUsbPlatform);
};
