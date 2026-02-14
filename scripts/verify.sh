#!/bin/bash

# Project Health and Verification Script
# This script performs a series of checks to ensure the codebase meets the 
# architectural standards and is ready for production use.

set -e

echo "--- Running Build and Tests ---"
npm run lint
npm test
npm run build

echo -e "
--- Verifying Entry Point & Registration ---"
grep -q 'api.registerPlatform' src/index.ts || (echo "Error: api.registerPlatform not found in src/index.ts"; exit 1)
grep -q '"main": "dist/index.js"' package.json || (echo "Error: main entry point mismatch in package.json"; exit 1)

echo -e "
--- Verifying Versioning & Metadata ---"
grep -q "Initializing Homebridge Z-Wave USB v" src/platform/ZWaveUsbPlatform.ts || (echo "Error: Version log missing in ZWaveUsbPlatform.ts"; exit 1)
grep -q "homepage" package.json || (echo "Error: homepage missing in package.json"; exit 1)
grep -q "funding" package.json || (echo "Error: funding missing in package.json"; exit 1)

echo -e "
--- Verifying UUID Stability & Naming ---"
grep -q "uuid.generate" src/accessories/ZWaveAccessory.ts || (echo "Error: UUID generation missing in ZWaveAccessory.ts"; exit 1)
grep -q "uuid.generate" src/accessories/ControllerAccessory.ts || (echo "Error: UUID generation missing in ControllerAccessory.ts"; exit 1)
grep -q "setCharacteristic(this.platform.Characteristic.Name" src/features/ZWaveFeature.ts || (echo "Error: Name characteristic not set in ZWaveFeature.ts"; exit 1)

echo -e "
--- Verifying Connection & Best Practices ---"
grep -q "softReset: false" src/zwave/ZWaveController.ts || (echo "Error: softReset should be false in ZWaveController.ts"; exit 1)
grep -q "forceConsole: true" src/zwave/ZWaveController.ts || (echo "Error: forceConsole should be true in ZWaveController.ts"; exit 1)
grep -q "storagePath:" src/zwave/ZWaveController.ts || (echo "Error: storagePath missing in ZWaveController.ts"; exit 1)

echo -e "
--- Verifying Z-Wave Manager & PIN System ---"
grep -q "Z-Wave Manager" src/accessories/ControllerAccessory.ts || (echo "Error: Z-Wave Manager missing in ControllerAccessory.ts"; exit 1)
grep -q "STATUS_CHAR_UUID" src/accessories/ControllerAccessory.ts || (echo "Error: STATUS_CHAR_UUID missing in ControllerAccessory.ts"; exit 1)
grep -q "PIN_CHAR_UUID" src/accessories/ControllerAccessory.ts || (echo "Error: PIN_CHAR_UUID missing in ControllerAccessory.ts"; exit 1)
grep -q "s2_pin.txt" src/zwave/ZWaveController.ts || (echo "Error: s2_pin.txt logic missing in ZWaveController.ts"; exit 1)

echo -e "
--- Verifying Feature Implementations ---"
features=("BatteryFeature.ts" "ThermostatFeature.ts" "WindowCoveringFeature.ts" "GarageDoorFeature.ts" "ColorSwitchFeature.ts" "SirenFeature.ts")
for feature in "${features[@]}"; do
  if [ ! -f "src/features/$feature" ]; then
    echo "Error: src/features/$feature is missing"
    exit 1
  fi
done

echo -e "
--- Verifying Config Schema & UI ---"
grep -q "serialPort" config.schema.json || (echo "Error: serialPort missing in config.schema.json"; exit 1)
grep -q "generateKeys" homebridge-ui/public/index.html || (echo "Error: generateKeys missing in UI index.html"; exit 1)

echo -e "
--- Verification Complete: All checks passed! ---"
