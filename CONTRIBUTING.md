# Contributing to Homebridge Z-Wave USB

First off, thank you for considering contributing to this project!

## Code of Conduct

This project and everyone participating in it is governed by the [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

- Ensure the bug was not already reported by searching the [issue tracker](https://github.com/sapireli/homebridge-zwave-usb/issues).
- If you cannot find an existing report, [open a new issue](https://github.com/sapireli/homebridge-zwave-usb/issues/new). Include a clear title, reproduction steps, relevant Homebridge and plugin versions, and sanitized logs or a focused test case where possible. Never post Z-Wave security keys, private hostnames, household device names, or other identifying installation details.

### Suggesting Enhancements

- Open a new issue with the enhancement proposal.
- Clearly describe the enhancement and the motivation for it.

### Pull Requests

- Fork the repo and create your branch from `main`.
- If you've added code that should be tested, add tests.
- Run the complete local gate (`npm run verify`).
- If your change affects Matter publication, also run the applicable host verification script
  described in [ARCHITECTURE.md](ARCHITECTURE.md).
- If your change adds or changes user-visible text, use American English and review the rendered
  Homebridge UI in both themes.
- Open the pull request.

## Styleguides

### Git Commit Messages

- Use the present tense ("Add feature" not "Added feature").
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...").
- Limit the first line to 72 characters or less.
- Reference issues and pull requests liberally after the first line.

### TypeScript Styleguide

- Follow the established code style in the project.
- Use `prettier` to format your code.

## Project Structure

The project is structured as a Homebridge dynamic platform plugin.

- `src/index.ts`: Main entry point, registers the platform with Homebridge.
- `src/platform/ZWaveUsbPlatform.ts`: The core platform implementation.
- `src/platform/`: Platform-owned persistence, payload, refresh, and write lifecycles.
- `src/zwave/ZWaveController.ts`: Wrapper for the `zwave-js` driver.
- `src/accessories/`: Accessory-related classes.
- `src/features/`: HomeKit services and Z-Wave value handling for each supported feature.
- `src/matter/`: Matter descriptors, service mappings, lifecycle, and state mirroring.
- `homebridge-ui/`: Config UI server, page, and pure presentation helpers.
- `config.schema.json`: Defines the configuration schema for the Homebridge UI.
- `scripts/`: Full verification and Homebridge Matter-host checks.
- `tests/`: Contains all the tests.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the ownership boundaries behind these directories.
