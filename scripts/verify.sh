#!/bin/bash

# Project Health and Verification Script
# This script performs a series of checks to ensure the codebase meets the 
# architectural standards and is ready for production use.

set -e

echo "--- Running Build and Tests ---"
npm run lint
npm test
npm run build

echo -e "\n--- Verifying Entry Point & Registration ---"
grep -q 'api.registerPlatform' src/index.ts || (echo "Error: api.registerPlatform not found in src/index.ts"; exit 1)
grep -q '"main": "dist/index.js"' package.json || (echo "Error: main entry point mismatch in package.json"; exit 1)

echo -e "\n--- Verifying Versioning & Metadata ---"
grep -q "Initializing Homebridge Z-Wave USB v" src/platform/ZWaveUsbPlatform.ts || (echo "Error: Version log missing in ZWaveUsbPlatform.ts"; exit 1)
grep -q "homepage" package.json || (echo "Error: homepage missing in package.json"; exit 1)
grep -q "funding" package.json || (echo "Error: funding missing in package.json"; exit 1)

echo -e "\n--- Verifying UUID Stability & Naming ---"
grep -q "uuid.generate" src/accessories/ZWaveAccessory.ts || (echo "Error: UUID generation missing in ZWaveAccessory.ts"; exit 1)
grep -q "uuid.generate" src/accessories/ControllerAccessory.ts || (echo "Error: UUID generation missing in ControllerAccessory.ts"; exit 1)
grep -q "Characteristic.Name" src/features/ZWaveFeature.ts || (echo "Error: Name characteristic not found in ZWaveFeature.ts"; exit 1)
grep -q "UUID generation string" src/accessories/ZWaveAccessory.ts || (echo "Error: UUID stability warning missing"; exit 1)

echo -e "\n--- Verifying Connection & Best Practices ---"
grep -q "softReset: false" src/zwave/ZWaveController.ts || (echo "Error: softReset should be false in ZWaveController.ts"; exit 1)
grep -q "forceConsole: true" src/zwave/ZWaveController.ts || (echo "Error: forceConsole should be true in ZWaveController.ts"; exit 1)
grep -q "cacheDir: path.join(storagePath" src/zwave/ZWaveController.ts || (echo "Error: storagePath not used for cache in ZWaveController.ts"; exit 1)

echo -e "\n--- Verifying Z-Wave Manager & PIN System ---"
grep -q "ZWaveManager" src/accessories/ControllerAccessory.ts || (echo "Error: ZWaveManager service missing in ControllerAccessory.ts"; exit 1)
grep -q "ZWaveStatus" src/accessories/ControllerAccessory.ts || (echo "Error: ZWaveStatus characteristic missing in ControllerAccessory.ts"; exit 1)
grep -q "S2PinEntry" src/accessories/ControllerAccessory.ts || (echo "Error: S2PinEntry characteristic missing in ControllerAccessory.ts"; exit 1)
grep -q "s2_pin.txt" src/zwave/ZWaveController.ts || (echo "Error: s2_pin.txt logic missing in ZWaveController.ts"; exit 1)
grep -q "fs.watch" src/zwave/ZWaveController.ts || (echo "Error: fs.watch PIN logic missing in ZWaveController.ts"; exit 1)

echo -e "\n--- Verifying Feature Implementations ---"
features=("BatteryFeature.ts" "ThermostatFeature.ts" "WindowCoveringFeature.ts" "GarageDoorFeature.ts" "ColorSwitchFeature.ts" "SirenFeature.ts")
for feature in "${features[@]}"; do
  if [ ! -f "src/features/$feature" ]; then
    echo "Error: src/features/$feature is missing"
    exit 1
  fi
done

echo -e "\n--- Verifying Garage Door CC ---"
grep -q "CommandClasses\['Barrier Operator'\]" src/accessories/AccessoryFactory.ts || (echo "Error: Garage Door detection logic incorrect in AccessoryFactory.ts"; exit 1)

echo -e "\n--- Verifying Config Schema & UI ---"
grep -q "serialPort" config.schema.json || (echo "Error: serialPort missing in config.schema.json"; exit 1)
grep -q "generateKeys" homebridge-ui/public/index.html || (echo "Error: generateKeys missing in UI index.html"; exit 1)

echo -e "\n--- Verification Complete: All checks passed! ---"
