# Homebridge Z-Wave USB
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![NPM Version](https://img.shields.io/npm/v/homebridge-zwave-usb.svg)](https://www.npmjs.com/package/homebridge-zwave-usb)
[![NPM Downloads](https://img.shields.io/npm/dt/homebridge-zwave-usb.svg)](https://www.npmjs.com/package/homebridge-zwave-usb)
[![Build and Test](https://github.com/sapireli/homebridge-zwave-usb/actions/workflows/build.yml/badge.svg)](https://github.com/sapireli/homebridge-zwave-usb/actions/workflows/build.yml)
[![License: Polyform Noncommercial](https://img.shields.io/badge/License-Polyform_Noncommercial-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-ea4aaa?logo=github)](https://www.paypal.me/sapir)

A high-performance, production-grade [Homebridge](https://homebridge.io) integration for Z-Wave networks. Built directly on the modern [Z-Wave JS](https://zwave-js.github.io/node-zwave-js/) driver, this plugin provides direct communication with USB controllers for ultra-low latency and maximum reliability.

## 🚀 Key Features

- **Direct Native Control**: No intermediate MQTT brokers or external servers required.
- **Homebridge Verified**: Adheres to strict stability, security, and HomeKit best practices.
- **S2 Security Support**: Full support for Security 2 (S2) authenticated pairing for locks, sensors, and more.
- **Reactive Architecture**: Real-time status updates and automatic hardware recovery (hot-plugging support).
- **Advanced Metadata Repair**: Automatically cleans up obsolete HomeKit services/characteristics during network updates.
- **Log Piping**: Internal Z-Wave JS driver logs are piped directly into the Homebridge terminal for seamless debugging.
- **OTA Firmware Updates**: Check for and install official manufacturer firmware updates directly from the Homebridge UI.

---

## ✅ Supported Devices

| Device Category | HomeKit Support | Technical Notes |
| :--- | :--- | :--- |
| **Actuators** | Switches, Outlets, Dimmers, Lights | Supports `Binary Switch`, `Multilevel Switch`, and `Color Switch` (RGBW). |
| **Climate** | Thermostats, TRVs | Full mode control (Heat/Cool/Auto/Off) with 0.5° precision and deadband logic. |
| **Security** | Smart Locks | Supports `Door Lock` CC with S0/S2 security and detailed state reporting. |
| **Sensors** | Motion, Contact, Leak, Smoke, CO | Real-time notifications via `Notification` and `Binary Sensor` CCs. |
| **Environment** | Temp, Humidity, Light, CO2, VOC | Precise measurements with unit conversion and Air Quality indexing. |
| **Access** | Garage Doors, Window Blinds | Supports `Barrier Operator` and `Window Covering` CCs with motion states. |
| **Remotes** | Wall Controllers, Scene Buttons | Maps `Central Scene` events to HomeKit Stateless Programmable Switches. |
| **Misc** | Sirens, Battery Status | Supports `Sound Switch` tone selection and native Low Battery alerts. |

---

## Matter support

On Homebridge 2.4 or later, enable Matter for the bridge or child bridge and pair it with your
Matter controller. The plugin publishes its supported device services automatically. Homebridge 1
continues to use HomeKit alone.

| Z-Wave device service | Matter mapping |
| :--- | :--- |
| Binary switches and outlets | Controllable On/Off outlet |
| Dimmers and RGB lights | Dimmable light or extended color light |
| Locks | Door lock |
| Motion, contact, and leak sensors | Occupancy, contact, and water leak detector |
| Smoke and CO alarms | Smoke/CO alarm with the relevant alarm feature |
| Temperature, humidity, and illuminance | Measurement sensor, with Matter units |
| Air quality and CO2 sensors | Air quality category plus CO2, VOC and PM2.5 measurements |
| Thermostats and TRVs | Thermostat, advertising only the interviewed heating/cooling setpoints |
| Window coverings | Window covering, including open, close, position, and stop |
| Garage doors | Closure, with fully open and fully closed commands |
| Scene buttons | Generic switch, with single, double, and long press events |
| Sirens | On/Off outlet, or dimmable outlet with volume control |
| Battery status | Power source on the matching endpoint, including battery-only devices |

A node with several services publishes the additional services as child endpoints. Commands use
the same HomeKit handlers as the Home app, and state changes are mirrored to Matter. Battery,
cache restoration, removal, and replacement-wrapper handling apply across these mappings.

Controller apps decide which Matter types they display. Closure in particular may be unavailable
in an app even when Homebridge publishes it. Garage-door stop is rejected because the plugin's
Barrier Operator implementation has no portable stop command. Continuous dimmer/color movement
and transition timing are not implemented; absolute levels and colors are supported.

CO2 is published in ppm; VOC and PM2.5 use the HomeKit-normalized micrograms per cubic meter.
CO2 and air-quality services at the same Z-Wave endpoint are combined so one sensor is not
duplicated. Missing raw samples and unknown battery levels are reported as null rather than
HomeKit's default zero. Separate endpoint batteries retain their own levels and warnings.

The plugin composes measurement servers through Homebridge's public device requirements and
reclaims the full graph after name-only cache restoration. Automated tests cover three starts,
raw state updates, and stable endpoint numbers for standalone and child sensors. Homebridge 2.4
may log an unknown-cluster warning for CO2 or VOC state updates because its helper name list is
incomplete; the composed Matter clusters still receive the readings.

Custom UV readings remain HomeKit-only: the current Matter runtime has no standard UV-index
cluster. A UV-only HAP LightSensor is not advertised as a fabricated illuminance measurement.
Air quality still uses the host's core Good/Poor/Unknown categories: Excellent/Good map to Good,
and Fair/Inferior/Poor map to Poor. Optional finer enum grades fail Homebridge 2.4's pre-plugin
cache restoration; the raw readings preserve the quantitative data.

Homebridge dispatches bridged Matter registration and removal without a downstream acknowledgment.
The plugin prevents duplicate offers and reclaims cached endpoints at startup, but cannot detect
all server-side refusals. A live endpoint's service structure is retained until the next restart
if a device's capabilities change. Automated tests cover the plugin lifecycle and endpoint
construction against Homebridge 2.4; physical-device testing of the expanded mappings remains open.

---

## 📦 Prerequisites & Linux Setup

Version 4 requires Node.js **22.12 or later in the Node 22 line**, Node **24**, or Node **26**. Node 18 and 20 are no longer supported because the installed dependencies require newer runtimes. Upgrade Node before installing v4.

### 1. Hardware
- A compatible Z-Wave USB Stick (e.g., **Aeotec Z-Stick Gen5/Gen7**, **Zooz 800 Series**, **Silicon Labs UZB**).
- A host system running Homebridge (Raspberry Pi, Linux, macOS, or Windows).

### 2. Linux Persistence (Don’t use `/dev/ttyACM0`)
On Linux, serial paths like `/dev/ttyACM0` are fragile and can change after a reboot or if you unplug the device. You want a persistent path.

#### 1️⃣ Confirm the adapter path
Plug the stick in, then run:
```bash
ls -l /dev/serial/by-id/
```
You’ll see something like:
`usb-0658_0200-if00 -> ../../ttyACM0`

**That symlink is what you want.** Copy the full path, for example:
`/dev/serial/by-id/usb-0658_0200-if00`

#### 2️⃣ Check permissions
Most Z-Wave issues on Linux are permission issues. Check your device:
```bash
ls -l /dev/ttyACM0
```
You’ll likely see: `crw-rw---- 1 root dialout ...`. This means only users in the `dialout` group can access it.

Add the Homebridge user (usually `homebridge`) to the group:
```bash
sudo usermod -aG dialout homebridge
```
*Note: If you are running Homebridge manually as your own user, use `$USER` instead of `homebridge`.*

#### 3️⃣ Test the device manually
Quick sanity check to see if the device is accessible:
```bash
stty -F /dev/serial/by-id/YOUR_STICK_ID
```
If it prints settings and doesn’t error, the device is accessible.

---

## 📥 Installation

### Method 1: Homebridge UI (Recommended)
1. Open the Homebridge web interface.
2. Go to the **Plugins** tab.
3. Search for `homebridge-zwave-usb`.
4. Click **Install**.

### Method 2: Command Line
Run the following command on your Homebridge host:
```bash
npm install -g homebridge-zwave-usb
```

---

## ⚙️ Configuration

1. Install the plugin via the **Homebridge UI**.
2. Navigate to the **Plugin Settings**.
3. **Serial Port Path**: Enter your persistent path found above.
4. **Security Keys**: Click **"Auto-Generate Keys"** to enable secure pairing for locks and alarms.
5. **Save and Restart**.

### Advanced

- **Heal Network Includes Sleeping Devices** (default: off). Heal Network rebuilds routes for
  devices that are always reachable and reports sleeping devices as skipped, so it finishes in a
  predictable time. Turn this on to rebuild sleeping devices too: each one is only reachable when
  it next wakes, so a single sleepy device can hold the rebuild open for days, and the inactivity
  timeout is disabled while the option is on. Battery devices that listen frequently, such as many
  locks, stay reachable and are rebuilt either way. Dead devices and devices with priority return
  routes are always reported as skipped.

---

## 🔐 S2 Security & PIN Entry

When pairing a Security 2 (S2) device, you must enter a 5-digit PIN found on the device label or box.

### Method 1: Using a Third-Party HomeKit App (Recommended)
1. Use a third-party app like **Controller for HomeKit**, **Eve**, or **Home+**.
2. Find the **"Z-Wave Controller"** accessory and the **"Z-Wave Manager"** service.
3. Write the 5-digit PIN into the **"S2 PIN Entry"** field.

### Method 2: Using the Terminal
1. Watch the Homebridge logs during inclusion.
2. When prompted, run:
   ```bash
   echo "12345" > ~/.homebridge/s2_pin.txt
   ```
   *(The plugin reacts instantly to this file and deletes it after reading).*

---

## 🎮 The Z-Wave Controller Accessory

This plugin adds a management accessory to your Home app to handle network operations without an external UI:
- **System Status**: Displays the current driver state (Initializing, Ready, Inclusion Active, etc.).
- **Inclusion Mode**: A switch to start/stop pairing new devices (active for 3 minutes).
- **Exclusion Mode**: A switch to remove/reset existing devices.
- **Heal Network**: A switch to trigger a background mesh network optimization. Sleeping devices are skipped unless **Heal Network Includes Sleeping Devices** is turned on, so the operation finishes in a predictable time. Progress appears in System Status, and the switch turns itself off when the rebuild finishes, is stopped, or reports nothing for ten minutes.

Controller switch labels are exposed using a compatibility path for Home app visibility. Some HomeKit apps may still render these actions differently.

### 🛠️ Advanced Management

The plugin provides additional tools for network maintenance:

- **Dual S2 PIN Entry**: When a device requires a PIN, you can enter it via the Homebridge terminal (`echo "12345" > s2_pin.txt`) or via the `S2 PIN Entry` characteristic in third-party HomeKit apps.
- **Explicit Stale Accessory Cleanup**: The custom UI includes a maintenance action to remove stale cached accessories when a node has been removed from the Z-Wave network but Homebridge still has an old cached entry.

## 🛠️ Maintenance & Firmware Updates

The plugin includes a dedicated **Maintenance** tab within the Homebridge custom UI (accessible via the plugin settings).

- **Node Overview**: View a complete list of all Z-Wave nodes in your network, including their status and current firmware versions.
- **HomeKit Publication State**: See whether a node is already published to HomeKit, still cached and waiting for interview wake-up, or intentionally deferred until interview metadata is available.
- **Node Rename**: Rename the Z-Wave node from the plugin UI without recreating the HomeKit accessory.
- **Official Updates**: Click "Check Update" to query the official Z-Wave JS Firmware Update Service. If a manufacturer-approved update is available, you can start the OTA transfer with a single click.
- **Battery Device Support**: Firmware updates are supported for battery-powered devices. You will be prompted to manually wake the device after starting the process to initiate the transfer.
- **Real-time Progress**: Monitor the progress of the firmware transfer via a live progress bar.
- **Clean Up Stale Accessories**: Remove stale cached Homebridge accessories explicitly from the maintenance UI instead of relying on automatic startup pruning.
- **Remove a Failed Node**: Remove one node from the Z-Wave network, after the controller has been asked whether it can be removed and the answer has been shown. A battery device that sleeps between wake-ups is refused, as is a node the controller cannot assess. Removal is permanent and the device has to be included again physically.
- **Rebuild Routes**: Start a network route rebuild from the maintenance UI and watch it run. Sleeping devices are skipped unless Heal Network Includes Sleeping Devices is turned on. If a rebuild started elsewhere is already running, the button waits for that one to finish instead of starting a second.

## ❓ Troubleshooting

- **Device showing "No Response"?** Check the Homebridge logs. If the device is battery-powered, it may need to be "woken up" (usually by pressing a physical button on the device) to complete the interview.
- **USB Stick busy?** Ensure no other software (like Home Assistant or a Z-Wave utility) is using the same serial port.
- **Permission Denied?** Re-run the `usermod` command in the Prerequisites section and **reboot** the host.

## Contributors

Thanks to [Bruno Courbage (@bcourbage)](https://github.com/bcourbage) for the covering state machine,
radio diagnostics, explicit failed-node removal, route-rebuild UI, covering test controls, and the
initial Matter integration (#15–#20).

## 💖 Support & Contribution

- **Report Bugs**: Use the [GitHub Issues](https://github.com/sapireli/homebridge-zwave-usb/issues) page.
- **Contribute**: Pull requests are welcome! Please ensure all tests pass (`npm test`) and follow the existing code style.
- **Support**: If you find this plugin useful, consider [donating via PayPal](https://paypal.me/sapir).

---

## ⚖️ Legal & Disclaimer

### 1. License & Commercial Use
This software is licensed under the **Polyform Noncommercial License 1.0.0**. You are free to use, copy, and modify this software for personal or community non-commercial purposes. **Commercial sale or redistribution for monetary compensation is strictly prohibited.**

### 2. Disclaimer of Warranty
This software is provided **"as is"** and "with all faults," without warranty of any kind. As an open-source project shared for the love of the community, the author(s) make no warranties, express or implied, including but not limited to the warranties of merchantability or fitness for a particular purpose.

### 2. Limitation of Liability
In no event shall the author(s) be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, hardware damage, data loss, or security breaches) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software. **Use this plugin at your own risk.**

### 3. Non-Affiliation
This project is an independent open-source endeavor. It is **not** affiliated with, authorized, maintained, sponsored, or endorsed by:
- The **Z-Wave Alliance** or **Silicon Labs**.
- **Homebridge** or **Apple Inc.**
- Hardware manufacturers such as **Aeotec**, **Zooz**, or others.

### 4. Copyrights & Trademarks
- "Z-Wave" is a registered trademark of Silicon Labs and its subsidiaries.
- "Homebridge", "HomeKit", and "Apple" are trademarks of their respective owners.
- All product names, logos, and brands are property of their respective owners. Their use in this project is for identification and compatibility description purposes only and does not imply endorsement.

---
*Shared with love for the HomeKit community.* 🏡❤️
