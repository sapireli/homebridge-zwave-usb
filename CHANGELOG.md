# Changelog

All notable changes to this project will be documented in this file.

## [3.3.3] - 2026-02-18

### Fixed
- **Lock Sensor Verification:** Tightened Notification-based Motion/Contact/Leak discovery with capability checks to reduce ghost sensor creation on lock devices.
- **Binary Sensor Lock Guard:** Prevented generic Binary Sensor fallback from creating Contact sensors on lock endpoints.
- **Health-Aware Sensor Fallbacks:** Updated Motion/Contact sensor reads to return safe defaults only when nodes are healthy, while preserving HomeKit communication errors for dead/offline nodes.
- **Regression Coverage:** Expanded AccessoryFactory tests for lock notification edge cases and confidence-gated sensor attachment.

## [3.3.2] - 2026-02-18

### Fixed
- **Door Lock Detection:** Updated accessory classification to recognize both `Door Lock` and `Lock` command classes so lock devices are consistently exposed as HomeKit locks.
- **Notification Sensor Confidence Rules:** Refined lock notification mapping to only create lock-adjacent Motion/Contact sensors when high-confidence key/category pairs are present, reducing false sensor creation.
- **Lock Mapping Tests:** Added regression coverage for Door Lock-only devices and lock notification edge cases to prevent future misclassification regressions.

## [3.0.2] - 2026-02-17

### Fixed
- **Code Cleanup:** Removed unused imports (`HAPPerm`) to fix linting warnings and ensure a clean build pipeline.

## [3.0.1] - 2026-02-17

### Fixed
- **Name Overwrite Fix:** Modified startup logic to only sync the accessory name if it has actually changed in the Z-Wave network. This prevents the plugin from overwriting custom names set by the user in the Home app on every restart.

## [3.0.0] - 2026-02-17

### Changed
- **Major Architecture Cleanup:** Finalized the transition to a clean, HAP-compliant schema.
  - Removed all experimental characteristics causing "Settings Errors" in HomeKit.
  - Implemented "Safe Name Sync" that respects user overrides while ensuring new devices are named correctly.
  - Stabilized Hardware Identity (Manufacturer/Model/Serial) to preventing pairing corruption.
  - This release is a recommended "Fresh Start" for users experiencing metadata issues.

## [2.9.9] - 2026-02-17

### Fixed
- **Build Stabilization:** Confirmed successful build and tests after interface updates. This release solidifies the schema cleanup and cache invalidation fixes.

## [2.9.8] - 2026-02-17

### Fixed
- **Cache Invalidation:** Forced a firmware revision update to trigger HomeKit to re-interview accessories. This helps clear corrupted metadata caches that might be causing "Unable to change settings" errors after the schema cleanup.

## [2.9.7] - 2026-02-17

### Fixed
- **Settings Error Fix (Final):** Removed `ConfiguredName` entirely as it is not officially supported for standard service types (Switch, Sensor, etc.) and was causing the "Could not change settings" error.
- **Safe Name Sync:** The plugin now only updates the `Name` characteristic if it is currently set to a generic "Node X" value. This respects all user-defined renames in the Home app while still ensuring new devices get their friendly names.

## [2.9.6] - 2026-02-17

### Fixed
- **Strict HAP Compliance:** Removed `NOTIFY` permission from the standard `Name` characteristic to align with HAP documentation and allow user-defined name overrides in the Home app to persist correctly.

## [2.9.5] - 2026-02-17

### Fixed
- **Multi-Service Naming:** Added `ServiceLabelNamespace` to the main Z-Wave Accessory. This ensures that `ConfiguredName` and `ServiceLabelIndex` are correctly interpreted by HomeKit for devices with multiple services (like dual switches or sensors), fixing potential naming conflicts.

## [2.9.4] - 2026-02-17

### Fixed
- **HAP Compliance:** Restored `NOTIFY` permissions to the standard `Name` characteristic. This ensures strict adherence to HAP specifications, where the Name characteristic is expected to be dynamic and capable of pushing updates to controllers.

## [2.9.3] - 2026-02-17

### Fixed
- **Build Integrity:** Fixed a missing import (`HAPPerm`) in `ZWaveAccessory.ts` that caused build failures.

## [2.9.2] - 2026-02-17

### Fixed
- **User Rename Support:** Removed `NOTIFY` permission from the standard `Name` characteristic while keeping it on `ConfiguredName`. This ensures that the plugin still syncs hardware names to HomeKit, but no longer aggressively overwrites manual names set by the user in the Home app tile view.

## [2.9.1] - 2026-02-17

### Fixed
- **Clean Naming Logic:** Removed redundant rename calls on startup and ensured strict adherence to HAP standards by removing the `Model` update from the rename logic. This guarantees that the hardware identity remains stable, preventing "Could not change settings" errors while still allowing dynamic name updates.

## [2.9.0] - 2026-02-17

### Added
- **Dynamic Renaming Support:** Implemented `ConfiguredName` with full Read/Write/Notify permissions. This is the official HomeKit mechanism for allowing plugins to push name updates while still letting users rename devices in the Home app without causing "Could not change settings" errors.

## [2.8.11] - 2026-02-17

### Fixed
- **Settings Access:** Removed permissions hacking (`setProps`) on standard characteristics which was causing the "Could not change settings" error in the Home app.
- **Naming Reliability:** Reverted to strictly standard HAP naming conventions. Names are now synchronized via the standard `Name` characteristic and the internal `displayName` property, ensuring compatibility with all HomeKit controllers.

## [2.8.10] - 2026-02-17

### Fixed
- **Stable Name Sync:** Implemented `setProps` on the `Name` characteristic to explicitly enable `NOTIFY` permissions. This allows HomeKit to receive live name updates without needing to clear the cache, while maintaining a stable hardware identity to avoid Home app settings errors.

## [2.8.9] - 2026-02-17

### Fixed
- **Home App Stability:** Finalized the fix for "could not change settings" errors by implementing strict HAP fingerprint stabilization. `Manufacturer`, `Model`, and `SerialNumber` are now guaranteed to be static once configured.
- **Naming Logic Cleanup:** Removed all non-standard and experimental naming characteristics to return to a 100% standard HomeKit schema, which is the most reliable way to avoid database corruption in the Home app.

## [2.8.8] - 2026-02-17

### Fixed
- **Critical Home App Stability Fix:** Fixed the "could not change settings" error by ensuring the hardware `Model` characteristic remains static and is never overwritten by the user-defined friendly name. This maintains a consistent hardware identity in the HomeKit database.
- **Improved Metadata Handling:** Added guards to prevent redundant updates to primary service flags.

## [2.8.7] - 2026-02-17

### Fixed
- **Build Fix:** Removed unused imports (`HAPPerm`) that were causing build failures in some environments due to strict linting/typing rules.

## [2.8.6] - 2026-02-17

### Fixed
- **Home App Error Fix:** Removed non-standard characteristics (`ConfiguredName` and `AccessoryInformation.Name`) that were causing "could not change settings" errors in the Home app.
- **Stable Naming Strategy:** Switched back to standard HomeKit naming using only `service.displayName` and the mandatory `Name` characteristic. This provides the most stable experience while still allowing the plugin to sync names from the Z-Wave network.

## [2.8.5] - 2026-02-17

### Fixed
- **Internal Property Synchronization:** Added synchronization for the internal `displayName` property of both Accessories and Services. HomeKit often uses these cached properties for its database mapping, and keeping them in sync alongside the Characteristics is the final step in ensuring reliable plugin-side renaming.

## [2.8.4] - 2026-02-17

### Fixed
- **Clean Build:** Removed unused `HAPFormat` imports that were causing build warnings in CI.

## [2.8.3] - 2026-02-17

### Fixed
- **Build Compatibility:** Fixed a potential build error by using a safer type casting for `setPrimaryService`.
- **Name Sync Reliability:** Restored `NOTIFY` permissions to all Name characteristics. This was inadvertently removed in 2.8.2 and is critical for forcing HomeKit to refresh device names dynamically.

## [2.8.2] - 2026-02-17

### Fixed
- **Authoritative Naming Fix:** Implemented a multi-layered synchronization strategy to force HomeKit to recognize plugin-side name changes.
  - Friendly names are now adopted immediately in the accessory constructor.
  - Functional services are marked as "Primary" to ensure their names are used for device tiles.
  - Re-introduced `ConfiguredName` support using standard HAP characteristics.
  - Automatically updates `SoftwareRevision` on rename to trigger HomeKit metadata cache invalidation.

## [2.8.1] - 2026-02-17

### Fixed
- **Deep Service Synchronization:** Fixed a race condition where sub-services were not correctly updated during the initial naming sync. By re-ordering the initialization sequence, the plugin now ensures all functional services (Switches, Sensors) are fully created before the friendly name is pushed to HomeKit.
- **Improved Versioning:** Switched to patch-level versioning for iterative fixes.

## [2.8.0] - 2026-02-17

### Fixed
- **Forceful Naming Synchronization:** Modified the startup logic to always re-sync friendly names for all services, even if the accessory was loaded from cache.
- **Event Propagation:** Switched from `updateValue` to `updateCharacteristic` throughout the plugin. This ensures that HomeKit is actively notified of the friendly name on every startup, forcing it to overwrite any lingering generic names (like "Node 2").

## [2.7.0] - 2026-02-17

### Fixed
- **HomeKit Event Notifications:** Added the `NOTIFY` permission to all `Name` and `ConfiguredName` characteristics. This ensures that the Home app is actively notified of name changes, allowing it to update device tiles immediately without a manual refresh or re-pairing.
- **Redundant Naming Support:** Re-introduced `ConfiguredName` alongside `Name` to maximize compatibility with different iOS versions and HomeKit controller implementations.

## [2.6.0] - 2026-02-17

### Fixed
- **Authoritative Naming Fix:** Switched to updating the `Name` characteristic on the `AccessoryInformation` service. This is the industry-standard way to ensure HomeKit updates the primary accessory name in the room view.
- **Service Cleanup:** Removed experimental `ConfiguredName` to strictly adhere to standard HAP Switch/Sensor schemas.

## [2.5.0] - 2026-02-17

### Added
- **Aggressive Name Synchronization:** Added support for the `ConfiguredName` characteristic. This forces the Home app to prioritize the friendly name defined in the Z-Wave network over cached generic names (like "Node 2").
- **Automatic Name Correction:** The plugin now forcefully updates both `Name` and `ConfiguredName` on every startup for all services.

## [2.4.0] - 2026-02-17

### Added
- **Deep Name Synchronization:** Renaming a node now correctly updates both the Homebridge accessory name and the names of all associated HomeKit services (Switch, Motion Sensor, etc.).
- **Improved Logging:** Plugin logs now include the user-defined node name alongside the Node ID (e.g., "Node 4 (Basement Furnace Room) ready") for better readability.

### Fixed
- **Name Persistence Fix:** Ensured that renamed nodes maintain their names in the Home app after a plugin restart by synchronizing names during the discovery process for cached accessories.

## [2.3.1] - 2026-02-17

### Fixed
- **Sandbox Modal Support:** Replaced browser-native `prompt()` and `confirm()` with custom HTML-based modals to ensure functionality in sandboxed Homebridge UI environments where native modals are blocked.

## [2.3.0] - 2026-02-17

### Fixed
- **UI Stability:** Migrated Maintenance tab actions to event delegation for more reliable button clicks after dynamic data refreshes.
- **Theme Compatibility:** Added explicit CSS support for Homebridge light and dark themes, fixing an issue where table text could become invisible.
- **Maintenance UX:** Added a background refresh guard to prevent the node table from updating while a rename or firmware prompt is active.

## [2.2.0] - 2026-02-17

### Added
- **Node Renaming:** Added the ability to rename Z-Wave nodes directly from the "Maintenance" tab in the custom UI.
  - Names are persisted in the Z-Wave JS driver cache.
  - HomeKit accessory names are automatically updated to match.
  - Added unit tests for renaming logic and IPC communication.

## [2.1.0] - 2026-02-16

### Added
- **Z-Wave Firmware Updates:** Introduced Over-The-Air (OTA) firmware updates via the Z-Wave JS Firmware Update Service.
  - New "Maintenance" tab in the custom UI to view all nodes and their firmware versions.
  - Semi-automatic update discovery: check for official manufacturer updates with one click.
  - Real-time progress tracking for OTA transfers.
  - Supports both mains-powered and battery-powered devices (requires manual wake-up).
- **Internal IPC Server:** Added a secure local IPC bridge to allow the custom UI to communicate with the running Z-Wave driver for advanced management tasks.

### Fixed
- **Child Bridge Persistence:** Fixed an issue where saving configuration through the custom UI would cause the plugin to be kicked off its child bridge by preserving Homebridge's internal `_bridge` metadata.
- **Heal Network Reliability:** Resolved race conditions and added safety timers to ensure the "Heal Network" switch correctly resets to "Off" after completion.
- **Custom UI Robustness:** Improved tab navigation and connectivity for various Homebridge environments.
- **Controller Node Safety:** Prevented firmware update checks on Node 1 (USB Controller) which doesn't support the standard node API.

## [2.0.4] - 2026-02-16

### Fixed
- Resolved a race condition where the "Heal Network" switch could remain "On" after completion due to state settings overlapping with completion events.
- Added a safety completion timer (5s) for "Heal Network" to ensure UI reset even if the driver fails to emit a formal completion event after reaching 100% progress.
- Improved Mutex logic for all controller actions (Inclusion, Exclusion, Heal) to prevent state-flip race conditions.

## [2.0.3] - 2026-02-16

### Fixed
- Added a 500ms delay to the "Heal Network" switch reset to ensure HomeKit and Homebridge UI correctly register the state change to "Off".

## [2.0.2] - 2026-02-16

### Added
- Detailed logging and progress tracking for the "Heal Network" command.
- Real-time progress display (e.g., "Heal: 5/11") in the HomeKit "System Status" characteristic.

## [2.0.1] - 2026-02-16

### Fixed
- **Child Bridge Persistence:** Fixed an issue where saving configuration through the custom UI would cause the plugin to be kicked off its child bridge by preserving Homebridge's internal `_bridge` metadata.

## [2.0.0] - 2026-02-16

### Changed
- **Controller Service UUID Migration:** Moved manager/status/PIN to fully custom UUIDs to avoid collisions with standard HAP UUIDs.
- **Controller Action Switch Behavior:** Improved Inclusion/Exclusion/Heal/Prune state handling in Homebridge UI by making writes non-blocking and state-driven via characteristic updates/events.
- **Config UI Restoration:** Restored the full custom UI config load/save script so existing `config.json` values populate correctly in Homebridge Config UI X.
- **Driver Debug Logging Control:** Wired Z-Wave JS driver logging to plugin `debug` setting so verbose log piping stops when debug is disabled.

### Fixed
- Fixed repeated startup pruning of the same `System Status` service caused by UUID collision with standard `Switch` service UUID.
- Fixed a reliability issue in S2 PIN file handling where file race conditions could throw from watcher callbacks.
- Removed unsupported private factory reset implementation and related trigger/documentation paths.

## [1.9.5-beta.0] - 2026-02-14

### Fixed
- **UUID Stability:** Implemented automated legacy UUID adoption to preserve user automations across version upgrades.
- **Metadata Repair:** Added in-place characteristic pruning to fix metadata bugs without destructive UUID resets.
- **Garage Door:** Fixed incorrect Command Class mapping for Garage Door detection (moved to CC 102).
- **Performance:** Optimized HomeKit updates by filtering value changes to specific features.
- **S2 PIN:** Improved pairing efficiency using `fs.watch` for terminal-based PIN entry.

### Changed
- Improved overall type safety by replacing `any` with strict `ZWaveValueEvent` interfaces.
- Standardized codebase formatting with Prettier and fixed ESLint warning regressions.

## [1.9.4-beta.6] - 2026-02-13

### Fixed

- Fixed **Read-Only S2 PIN Entry** by initializing the field with a placeholder string (`"Enter PIN"`) and removing complex length validation constraints that caused HomeKit to disable the input.
- Incremented to **Version 7 UUIDs** to forcefully clear any lingering metadata cache on the HomeKit controller side.

## [1.9.4-beta.5] - 2026-02-13

### Fixed

- Definitive fix for the **Read-Only S2 PIN Entry**. Every `setProps` call now includes the mandatory `format` field, ensuring HomeKit respects custom permissions.
- Incremented to **Version 5 UUIDs** to ensure a 100% clean state for HomeKit controllers.

## [1.9.4-beta.4] - 2026-02-13

### Fixed

- Pushed **Version 3 UUIDs** for the Z-Wave Manager service and characteristics. This is a definitive "hard reset" for HomeKit to resolve stuck read-only permissions and duplicate services.
- Implemented **ServiceLabelIndex** across all accessories.
- Aggressive cleanup logic now purges all legacy UUID variants (v1, v2, and obsolete custom IDs) from the accessory cache.

## [1.9.4-beta.3] - 2026-02-13

### Fixed

- Improved robustness of service and characteristic schema registration to silence all Homebridge warnings across all accessories.
- Guaranteed formal registration of custom characteristics (`ZWaveStatus`, `S2PinEntry`) even when services are retrieved from the Homebridge cache.

## [1.9.4-beta.2] - 2026-02-13

### Fixed

- Fixed Homebridge warnings regarding `Configured Name` characteristic not being in the required or optional section for services.
- Formally registered `ConfiguredName` as an optional characteristic for the `ZWaveManager` service and standard services.

## [1.9.4-beta.1] - 2026-02-13

### Fixed

- Fixed duplicate Z-Wave Controller services in HomeKit by adding aggressive service pruning for obsolete and duplicate UUIDs.
- Fixed read-only S2 PIN entry by strictly adhering to HAP-NodeJS `Perms` and `Formats` enums instead of raw strings.
- Removed all remaining `as any` and `eslint-disable` from HomeKit characteristic registration.

## [1.9.4-beta.0] - 2026-02-13

### Changed

- Major refactor to improve type safety and remove extensive 'any' usage.
- Consumed library types directly from `zwave-js` and `@zwave-js/core`.
- Refactored `AccessoryFactory` and all features to use `CommandClasses` enum instead of numeric literals.
- Improved constructor patterns for Features to ensure stable access to node data.
- Complied with HomeKit `isolatedModules` requirements by avoiding ambient const enums.

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
