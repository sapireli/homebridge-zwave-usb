# Homebridge Z-Wave USB
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![NPM Version](https://img.shields.io/npm/v/homebridge-zwave-usb.svg)](https://www.npmjs.com/package/homebridge-zwave-usb)
[![NPM Downloads](https://img.shields.io/npm/dt/homebridge-zwave-usb.svg)](https://www.npmjs.com/package/homebridge-zwave-usb)
[![Build and Test](https://github.com/sapireli/homebridge-zwave-usb/actions/workflows/build.yml/badge.svg)](https://github.com/sapireli/homebridge-zwave-usb/actions/workflows/build.yml)
[![GitHub License](https://img.shields.io/github/license/sapireli/homebridge-zwave-usb.svg)](https://github.com/sapireli/homebridge-zwave-usb/blob/main/LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/sapireli/homebridge-zwave-usb.svg)](https://github.com/sapireli/homebridge-zwave-usb/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/sapireli/homebridge-zwave-usb.svg)](https://github.com/sapireli/homebridge-zwave-usb/issues)

A high-performance HomeKit integration for Z-Wave networks, built on the modern **Z-Wave JS** driver.

## Why this plugin?

- 🚀 **Performance:** Direct communication with your USB stick via `zwave-js`. No intermediate brokers.
- 🏠 **Native Feel:** Devices appear in Apple Home exactly as you expect. Multi-sensor devices are grouped logically.
- 🔐 **Secure:** Full support for S2 Security (Locks, Sensors) with a unique terminal-based PIN entry system.
- 📋 **Full Visibility:** Internal Z-Wave JS logs are piped directly into your Homebridge terminal for easy troubleshooting.

---

## 📦 Prerequisites

1.  **Permissions (Linux/Pi)**: Ensure the user running Homebridge has access to serial ports:
    ```bash
    sudo usermod -a -G dialout homebridge
    sudo reboot
    ```
2.  **Hardware**: Compatible with most Z-Wave USB sticks (Aeotec Z-Stick Gen5/Gen7, Zooz 800, etc.).

---

## ⚙️ Configuration

1.  Go to **Settings** in Homebridge UI.
2.  **Serial Port Path**: Enter the persistent path to your stick (e.g., `/dev/serial/by-id/X` or `/dev/ttyACM0`).
3.  **Security Keys**: Click **"Auto-Generate Keys"** to enable secure device support.
4.  **Save & Restart**.

---

## 🔐 S2 PIN Entry

This plugin supports Security 2 (S2) without requiring an external UI. If a device requires a 5-digit PIN during pairing, you have two options:

### Option 1: HomeKit App (Easiest)

1.  Open a third-party HomeKit app (like **Controller for HomeKit**, **Eve**, or **Home+**).
2.  Navigate to the **"Z-Wave Controller"** accessory.
3.  Find the **"Z-Wave Manager"** service.
4.  You will see a field named **"S2 PIN Input"**.
5.  Enter the 5-digit PIN and save. The plugin will complete the pairing immediately.

### Option 2: Terminal

1.  Watch the **Homebridge Logs**.
2.  A warning box will appear showing the device's DSK.
3.  Open your terminal and run:
    ```bash
    echo "12345" > ~/.homebridge/s2_pin.txt
    ```
    _(Replace 12345 with your actual PIN)_

---

## ✅ Supported Devices

| Device Type          | HomeKit Service                      | Notes                                |
| :------------------- | :----------------------------------- | :----------------------------------- |
| **Switches / Plugs** | Switch / Outlet                      | Instant status updates.              |
| **Dimmers**          | Lightbulb                            | Brightness 0-100%.                   |
| **RGB Lighting**     | Lightbulb                            | Support for CC 51 (Hue/Saturation).  |
| **Locks**            | Lock Mechanism                       | Supports S0/S2 secure pairing.       |
| **Thermostats**      | Thermostat                           | Modes, Target Temp, Auto-conversion. |
| **Window Coverings** | Window Covering                      | Blinds, Shades, Shutters.            |
| **Garage Doors**     | Garage Door Opener                   | CC 102 Barrier Operator support.     |
| **Sensors**          | Contact / Motion / Leak / Smoke / CO | Multi-CC fallback support.           |
| **Air Quality**      | Air Quality Sensor                   | CO2, VOC, PM2.5 monitoring.          |
| **Climate**          | Temp / Humidity / Light              | Auto-converts Fahrenheit/Celsius.    |
| **Sirens**           | Switch                               | Sound Switch CC support.             |
| **Buttons**          | Programmable Switch                  | Single, Double, Long press support.  |
| **Battery**          | Battery Service                      | Low battery alerts in Home app.      |

---

## 🎮 Z-Wave Controller Accessory

A special accessory is added to HomeKit with these components:

- **Z-Wave Manager**: A dedicated service for monitoring **System Status** and entering **S2 PINs**.
  - _Tip_: Turning this switch **OFF** acts as a "Panic Button" to stop all active Z-Wave processes (Inclusion, Exclusion, Healing).
- **Inclusion Mode**: Turn ON to pair a new device (3-minute window for PIN entry).
- **Exclusion Mode**: Turn ON to unpair/remove a device.
- **Heal Network**: Turn ON to rebuild mesh routes.

## 💖 Support

If you find this plugin useful, please consider supporting its development:

- **[Donate via PayPal](https://paypal.me/sapir)**

---

## ❓ Troubleshooting

- **Node Stuck at Stage 0?** Battery sensors sleep to save power. **Press the pairing button on the sensor repeatedly** during inclusion to keep it awake until the interview completes.
- **Permission Denied?** Ensure you've added the `homebridge` user to the `dialout` group and **rebooted** the system.
- **Detailed Logs?** Run Homebridge with the `-D` flag or enable **"Verbose Driver Logging"** in settings.

## License

MIT
