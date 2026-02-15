# Homebridge Z-Wave USB
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![NPM Version](https://img.shields.io/npm/v/homebridge-zwave-usb.svg)](https://www.npmjs.com/package/homebridge-zwave-usb)
[![NPM Downloads](https://img.shields.io/npm/dt/homebridge-zwave-usb.svg)](https://www.npmjs.com/package/homebridge-zwave-usb)
[![Build and Test](https://github.com/sapireli/homebridge-zwave-usb/actions/workflows/build.yml/badge.svg)](https://github.com/sapireli/homebridge-zwave-usb/actions/workflows/build.yml)
[![GitHub License](https://img.shields.io/github/license/sapireli/homebridge-zwave-usb.svg)](https://github.com/sapireli/homebridge-zwave-usb/blob/main/LICENSE)

A high-performance, production-grade [Homebridge](https://homebridge.io) integration for Z-Wave networks. Built directly on the modern [Z-Wave JS](https://zwave-js.github.io/node-zwave-js/) driver, this plugin provides direct communication with USB controllers for ultra-low latency and maximum reliability.

## 🚀 Key Features

- **Direct Native Control**: No intermediate MQTT brokers or external servers required.
- **Homebridge Verified**: Adheres to strict stability, security, and HomeKit best practices.
- **S2 Security Support**: Full support for Security 2 (S2) authenticated pairing for locks, sensors, and more.
- **Reactive Architecture**: Real-time status updates and automatic hardware recovery (hot-plugging support).
- **Advanced Metadata Repair**: Automatically cleans up obsolete HomeKit services/characteristics during network updates.
- **Log Piping**: Internal Z-Wave JS driver logs are piped directly into the Homebridge terminal for seamless debugging.

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

## 📦 Prerequisites & Linux Setup

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

---

## 🔐 S2 Security & PIN Entry

When pairing a Security 2 (S2) device, you must enter a 5-digit PIN found on the device label or box.

### Method 1: Using HomeKit (Recommended)
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
- **Heal Network**: A switch to trigger a background mesh network optimization.

---

## ❓ Troubleshooting

- **Device showing "No Response"?** Check the Homebridge logs. If the device is battery-powered, it may need to be "woken up" (usually by pressing a physical button on the device) to complete the interview.
- **USB Stick busy?** Ensure no other software (like Home Assistant or a Z-Wave utility) is using the same serial port.
- **Permission Denied?** Re-run the `usermod` command in the Prerequisites section and **reboot** the host.

## 💖 Support & Contribution

- **Report Bugs**: Use the [GitHub Issues](https://github.com/sapireli/homebridge-zwave-usb/issues) page.
- **Contribute**: Pull requests are welcome! Please ensure all tests pass (`npm test`) and follow the existing code style.
- **Support**: If you find this plugin useful, consider [donating via PayPal](https://paypal.me/sapir).

---

## ⚖️ Legal & Disclaimer

### 1. Disclaimer of Warranty
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
