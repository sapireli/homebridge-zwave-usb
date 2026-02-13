# Changelog

All notable changes to this project will be documented in this file.

## [1.9.3] - 2026-02-13

### Fixed
- Fixed Homebridge warnings about custom characteristics not being in the required or optional section.
- Formally registered a custom **ZWaveManager** service class that explicitly includes our custom characteristics.
- Restored full visibility and editability of the **S2 PIN Entry** in third-party HomeKit apps.

## [1.9.2] - 2026-02-13

### Fixed
- Fixed a potential crash during plugin initialization when provided with invalid configuration (e.g., malformed serial port or security keys).
- Improved security key validation to ensure keys are valid hexadecimal strings.
- Wrapped critical initialization code in try/catch blocks to log errors gracefully instead of crashing Homebridge.

## [1.9.1] - 2026-02-13

### Fixed
- Fixed **S2 PIN Entry** visibility in third-party HomeKit apps by formally registering custom Characteristics with the HAP API.
- Fixed missing switch names by standardizing on `Switch` services with unique subtypes and explicit `Name` characteristics.
- Implemented a more robust cleanup of obsolete metadata from previous versions to prevent cache-related display bugs.

## [1.9.0] - 2026-02-13

### Changed
- Major refactor of the **Z-Wave Controller** HomeKit structure for maximum compatibility:
  - Moved **System Status** and **S2 PIN Input** to a dedicated "System Status" switch service (subtype: `Status`).
  - Standardized all management switches (Inclusion, Exclusion, Heal) to use explicit subtypes.
  - Guaranteed service naming in all HomeKit apps (fixed "Missing Name" bug).
  - Explicitly forced **PAIRED_WRITE** permissions on the PIN entry field.
  - Improved cleanup logic for obsolete characteristics and services from older versions.

## [1.8.9] - 2026-02-13

### Changed
- Aligned `package.json` with standard `homebridge-lib` patterns:
  - Removed `peerDependencies` for Homebridge (moved to `engines`).
  - Updated `engines` to match modern standard ranges (`node: "^24||^22||^20"`, `homebridge: "^1.6.0||^2.0.0-beta"`).
  - Verified zero runtime leaks of Homebridge or HAP-NodeJS in the production tree.

## [1.8.8] - 2026-02-13

### Fixed
- Fixed missing switch names in the Controller app by removing the non-standard custom service and restoring standard service types.
- Moved **System Status** and **S2 PIN Input** to the **Accessory Information** service. This is the most compatible "Meta" location for plugin-wide settings and follows patterns used by established Homebridge libraries.
- Guaranteed **S2 PIN Input** is writable in third-party apps by forcing explicit HAP permission strings.
- Added comprehensive cleanup for obsolete services and characteristics from previous versions.

## [1.8.7] - 2026-02-13

### Fixed
- Fixed critical "TypeError: setProps of undefined" by ensuring characteristics exist before configuration.
- Improved "Duplicate Characteristic" logic with case-insensitive UUID matching.
- Cleaned up dependency tree to satisfy strict Homebridge Verification requirements.
- Synced lockfile and removed redundant development packages.

## [1.8.6] - 2026-02-13

### Fixed
- Fixed a critical "Duplicate Characteristic" crash by implementing a case-insensitive check for existing characteristics in the Homebridge cache.
- Migrated the **Z-Wave Manager** to a custom Service UUID to ensure correct naming and characteristic visibility in third-party HomeKit apps.
- Guaranteed the **S2 PIN Input** field is writable by explicitly forcing permissions and using a dedicated management service.
- Fixed a regression where switch names were missing in the Controller app.

## [1.8.5] - 2026-02-13

### Changed
- Explicitly defined `hap-nodejs` as a development dependency to ensure clear separation from production runtime.
- Verified and finalized Homebridge Verified compliance criteria.

## [1.8.4] - 2026-02-13

### Fixed
- Fixed a critical "Duplicate Characteristic" crash by implementing a more robust characteristic initialization check.
- Migrated custom characteristics to truly unique random UUIDs to prevent collisions with standard HomeKit or Eve characteristics.

## [1.8.3] - 2026-02-13

### Changed
- Finalized compliance with Homebridge Verified standards.
- Restored `peerDependencies` for Homebridge.
- Verified runtime dependency tree excludes `homebridge` and `hap-nodejs`.

## [1.8.2] - 2026-02-13

### Added
- **Auto-Release CI**: The plugin now automatically creates GitHub releases and publishes to NPM whenever the version is bumped in `main`.

## [1.8.1] - 2026-02-13

### Changed
- Standardized `config.schema.json` to strictly follow JSON Schema draft-07 requirements (using `required` array at the object level).
- Refined `package.json` dependencies to exclude `homebridge` and `hap-nodejs` from runtime dependencies, ensuring compliance with Homebridge Verified standards.

## [1.8.0] - 2026-02-13

### Changed
- Refactored `config.schema.json` to follow strict JSON schema standards for better Homebridge verification.
- Updated `engines.node` requirements to match Homebridge Verified standards (>=18.15.0).

### Fixed
- Cleaned up unused dependencies (`ws`, `homebridge-lib`) to reduce package size and improve security.

## [1.7.9] - 2026-02-13

### Fixed
- Improved battery reporting reliability and silenced HomeKit out-of-range warnings.

## [1.7.8] - 2026-02-13

### Added
- Dedicated **Z-Wave Manager** service for centralized status monitoring and PIN entry.
- Support for explicit **Z-Wave Long Range (LR)** security keys with automatic S2 fallback.
- Real-time **System Status** characteristic for improved visibility in 3rd party apps.
- Plugin version logging on startup.

### Fixed
- Fixed "Battery Level" warning where illegal value -1 was supplied to HomeKit.
- Fixed "Ghost" Node 1 accessory appearing in HomeKit.
- Fixed duplicate characteristic crash during Homebridge restart.
- Fixed service naming regressions where devices showed generic "Switch" labels.
- Resolved HAP warnings regarding `ConfiguredName` usage.
- Improved Z-Wave JS log piping and removed verbose ASCII logo.

## [1.7.7] - 2026-02-13

### Added
- Initial stable release of **Homebridge Z-Wave USB**.
- Direct mode support using `zwave-js` driver.
- Support for various device classes:
  - Switches and Dimmers.
  - RGB/Color Lighting (CC 51).
  - Locks and Garage Doors.
  - Thermostats with auto unit conversion.
  - Window Coverings.
  - Sensors: Motion, Contact, Leak, Smoke, CO, and Air Quality (CO2, VOC, PM2.5).
  - Battery status monitoring.
  - Central Scene (Programmable Switches) support.
- Dual S2 PIN Entry system:
  - Terminal-based via `s2_pin.txt`.
  - HomeKit-based via custom characteristic in third-party apps.
- Real-time "System Status" characteristic for the Controller.
- Automatic accessory reconciliation to remove orphaned cached devices.
- Comprehensive logging piped directly to Homebridge terminal.
- Customizable serial port and security keys via Homebridge UI.
- Local Z-Wave JS Server support removed for a leaner Direct Mode operation.
