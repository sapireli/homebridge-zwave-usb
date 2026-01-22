# Project: Homebridge Z-Wave USB Glue Plugin

You are an AI coding agent working in this repository.
Your task is to build a production-grade Homebridge plugin that bridges Z-Wave USB controllers (Aeotec Z-Stick and similar) to HomeKit accessories via Homebridge.

## High-level goal
Create a Homebridge dynamic platform plugin (TypeScript) that:
- Connects to a local Z-Wave controller via serial (e.g., /dev/serial/by-id/...) or optional TCP serial bridge (tcp://host:port).
- Uses Z-Wave JS (zwave-js) as the Z-Wave stack (modern, actively maintained).
- Discovers Z-Wave nodes and maps common device capabilities into HomeKit accessories in Apple Home.
- Supports inclusion/exclusion via a special "Controller" accessory (virtual switches).

## Non-goals (v1)
- Building a full Z-Wave admin UI like Z-Wave JS UI.
- Supporting every Z-Wave Command Class on day one.
- Advanced controller ops (NVM backup/restore, firmware upgrades).

## Prior art to consult (learn patterns; do NOT copy code)
- homebridge-openzwave (legacy mapping patterns)
- homebridge-zwave (archived)
- homebridge-zwave-direct (legacy)

Use these to learn:
- node <-> accessory identity strategies
- device capability mapping approaches
- inclusion/exclusion UX patterns

## Tech requirements
- Language: TypeScript
- Plugin type: Homebridge dynamic platform plugin
- Z-Wave: zwave-js driver
- Testing: Jest (or equivalent)
- CI: GitHub Actions (lint + test + build)

## Deliverables
1) Working Homebridge plugin repository:
   - package.json with correct homebridge metadata
   - src/ TypeScript source
   - dist/ build output via npm scripts
   - config.schema.json (Homebridge UI config)
   - README with setup, inclusion/exclusion, troubleshooting
2) Core implementation:
   - Dynamic accessory discovery & caching reconciliation
   - Reliable event handling + characteristic updates
   - Inclusion/exclusion via controller accessory switches
3) Tests:
   - Unit tests for mapper logic and characteristic conversion
   - Basic platform boot test with mocked Z-Wave controller events
4) CI workflow

## Architecture (required modules)
Implement these modules/files (names can vary slightly, but structure should be comparable):

- src/index.ts
  - registers platform with Homebridge
- src/platform/ZWaveUsbPlatform.ts
  - dynamic platform implementation
  - loads cached accessories via configureAccessory
  - registers/unregisters platform accessories at runtime
- src/zwave/ZWaveController.ts
  - wraps zwave-js Driver lifecycle
  - emits normalized events to platform layer
- src/accessories/AccessoryFactory.ts
  - determines services to create per node/endpoint
- src/accessories/AccessoryRegistry.ts
  - manages nodeId/endpoint -> PlatformAccessory mapping
- src/mappers/*
  - capability-to-HomeKit mapping modules
- src/util/*
  - uuid, logging helpers, throttling/debouncing, etc.

## Identity & caching rules (MUST)
- Accessories must have stable UUIDs derived from:
  pluginNamespace + controllerIdentity + nodeId (+ endpoint)
- Multi-endpoint devices:
  - either a single accessory with multiple services, OR
  - separate accessories per endpoint (choose one approach and document it)
- On startup:
  - load cached accessories
  - start driver
  - reconcile cache vs actual nodes:
    - add missing
    - update changed
    - unregister orphaned

## Minimum HomeKit mapping (v1 MUST implement)
Sensors:
- Contact sensor -> ContactSensor / ContactSensorState
- Motion sensor -> MotionSensor / MotionDetected
- Leak sensor -> LeakSensor / LeakDetected
- Temperature -> TemperatureSensor / CurrentTemperature
- Humidity -> HumiditySensor / CurrentRelativeHumidity
- Battery (if reported) -> BatteryService / BatteryLevel + StatusLowBattery

Actuators:
- Binary switch -> Switch / On
- Outlet (if identifiable) -> Outlet / On (OutletInUse optional)

Mapping notes:
- Prefer standard HomeKit services/characteristics only.
- Avoid vendor-specific custom characteristics in v1.

## Inclusion/Exclusion UX (v1 MUST implement option A)
Create a special "Z-Wave Controller" accessory:
- Switch: "Inclusion Mode"
  - On => start inclusion for N seconds (configurable)
  - Off => stop inclusion
- Switch: "Exclusion Mode"
  - On => start exclusion for N seconds
  - Off => stop exclusion
Optionally expose status (e.g., via logs or a read-only characteristic) but keep it simple.

## Configuration (config.schema.json MUST include these)
Required:
- platform: "ZWaveUSB"
- name
- serialPort: string (serial path or tcp://host:port)
Optional:
- rfRegion
- securityKeys (S0/S2 as supported by zwave-js)
- inclusionTimeoutSeconds (default 60)
- debug
- include/exclude device filters (nodeId/manufacturer/product)

Security:
- NEVER log keys
- Ensure config docs warn keys are sensitive

## Reliability requirements
- Clear error messages for:
  - missing serial port
  - permission denied
  - port busy
- Auto-reconnect with backoff if controller disconnects
- Throttle/debounce characteristic updates for chatty devices

## Implementation guidance
- Start by scaffolding a minimal Homebridge dynamic platform plugin that boots and logs.
- Add zwave-js driver connection next.
- Add discovery + cached accessory reconciliation.
- Add mappers (contact/motion/leak/battery first).
- Then add inclusion/exclusion controller accessory.
- Then tests + CI + README polish.

## Definition of done (acceptance criteria)
- Plugin connects to a Z-Wave USB controller using zwave-js.
- Existing paired nodes appear after restart (cache + reconcile).
- New nodes appear without restart.
- Removing a node removes its HomeKit accessory.
- Contact/motion/leak/binary switch + battery mapping works.
- Inclusion/exclusion works via controller accessory.
- npm test and npm run build succeed in CI.
