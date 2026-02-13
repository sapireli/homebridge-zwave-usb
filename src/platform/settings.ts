export const PLUGIN_NAME = 'homebridge-zwave-usb';
export const PLATFORM_NAME = 'ZWaveUSB';

// Custom Service UUID for the Z-Wave Manager
export const MANAGER_SERVICE_UUID = '9f8e7d6c-5b4a-3f2e-1d0c-9b8a7f6e5d4c';

// Custom Characteristic UUIDs (Truly unique to avoid collisions)
export const STATUS_CHAR_UUID = '7f8e9d0a-1b2c-4d3e-8f9a-0b1c2d3e4f5a';
export const PIN_CHAR_UUID = '8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d';

// Obsolete UUIDs for cleanup
export const OBSOLETE_STATUS_UUID = 'E863F108-079E-48FF-8F25-9C2566232931';
export const OBSOLETE_PIN_UUID = 'E863F109-079E-48FF-8F25-9C2566232931';
