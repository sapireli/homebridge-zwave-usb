# Project: Homebridge Z-Wave USB Glue Plugin

Finalized architecture and decisions for the Z-Wave USB platform plugin.

## Finalized Goals
- **Direct Mode Only**: The plugin uses the local `zwave-js` driver to communicate directly with USB Z-Wave controllers.
- **Terminal Management**: S2 PIN entry and advanced logging are handled via the Homebridge terminal and filesystem, removing the need for an external UI.
- **Robustness**: Automatic reconciliation of cached accessories and detailed interview stage tracking.

## Architecture
- `src/index.ts`: Entry point.
- `src/platform/ZWaveUsbPlatform.ts`: Orchestrates node discovery, accessory caching, and lifecycle.
- `src/zwave/ZWaveController.ts`: Wrapper for the `zwave-js` Driver. Implements custom log piping and terminal-based S2 PIN entry.
- `src/accessories/AccessoryFactory.ts`: Maps Z-Wave nodes/endpoints to HomeKit features.
- `src/accessories/ZWaveAccessory.ts`: Encapsulates a Z-Wave node as a HomeKit accessory.
- `src/accessories/ControllerAccessory.ts`: Provides Inclusion/Exclusion/Heal switches in HomeKit.
- `src/features/*`: Implementation of specific HomeKit services (Switch, Lock, Sensors, etc.).

## Key Features
### 1. Dual S2 PIN Entry
When a device requires a PIN, the plugin polls for both a temporary file and a custom HomeKit characteristic for 3 minutes.
- **Terminal**: `echo "PIN" > s2_pin.txt`
- **HomeKit**: Write to `S2 PIN Input` characteristic in third-party apps.

### 2. Log Piping
All internal Z-Wave JS logs are redirected to the Homebridge logger.
- Debug: Raw protocol events.
- Info: Node status, interview stages, and security alerts.

### 3. Stability Fixes
- `softReset: false`: Prevents hangs on Aeotec Z-Stick controllers.
- `didFinishLaunching` Wait: Ensures the driver is ready before HomeKit starts.
- Homebridge-Managed Storage: Cache and config are stored in the user's Homebridge folder.

## Minimum HomeKit Mapping
- **Actuators**: Binary Switches, Dimmers, RGB/Color Lights, Locks, Thermostats, Window Coverings, Garage Doors, Sirens.
- **Sensors**: Contact, Motion, Leak, Smoke, CO, Air Quality (CO2, VOC, PM2.5), Temperature, Humidity, Illuminance.
- **Misc**: Central Scene (Programmable Switches), Battery Service.

## Identity & Caching
- **UUIDs**: Stable UUIDs derived from `homebridge-zwave-usb-[homeId]-[nodeId]`.
- **Reconciliation**: Orphaned accessories are automatically unregistered 10 seconds after startup.

## Testing Strategy
- **Jest**: Mocked Z-Wave JS driver with full `EventEmitter` support.
- **Linting**: Strict `typescript-eslint` rules with zero-warning tolerance.
- **CI**: GitHub Actions for every push (lint + test + build).
