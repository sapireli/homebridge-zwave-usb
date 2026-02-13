# Changelog

All notable changes to this project will be documented in this file.

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
