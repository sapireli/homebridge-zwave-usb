# Contributing to Homebridge Z-Wave USB

First off, thank you for considering contributing to this project! 

## Code of Conduct

This project and everyone participating in it is governed by the [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

- Ensure the bug was not already reported by searching on GitHub under [Issues](https://github.com/eliransapir/homebridge-zwave-usb/issues).
- If you're unable to find an open issue addressing the problem, [open a new one](https://github.com/eliransapir/homebridge-zwave-usb/issues/new). Be sure to include a **title and clear description**, as much relevant information as possible, and a **code sample** or an **executable test case** demonstrating the expected behavior that is not occurring.

### Suggesting Enhancements

- Open a new issue with the enhancement proposal.
- Clearly describe the enhancement and the motivation for it.

### Pull Requests

- Fork the repo and create your branch from `main`.
- If you've added code that should be tested, add tests.
- Ensure the test suite passes (`npm test`).
- Make sure your code lints (`npm run lint`).
- Issue that pull request!

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
- `src/zwave/ZWaveController.ts`: Wrapper for the `zwave-js` driver.
- `src/accessories/`: Accessory-related classes.
- `src/mappers/`: Maps Z-Wave device capabilities to HomeKit characteristics.
- `src/util/`: Utility functions.
- `config.schema.json`: Defines the configuration schema for the Homebridge UI.
- `tests/`: Contains all the tests.
