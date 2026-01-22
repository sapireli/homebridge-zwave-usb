# Homebridge Z-Wave USB

[![Build and Test](https://github.com/sapireli/homebridge-zwave-usb/actions/workflows/build.yml/badge.svg)](https://github.com/user/homebridge-zwave-usb/actions/workflows/build.yml)

A high-performance, native HomeKit integration for Z-Wave networks.

Unlike legacy plugins, **Homebridge Z-Wave USB** is built on the modern **Z-Wave JS** driver (the same stack used by Home Assistant), offering unmatched speed, reliability, and device support.

## Why this plugin?

*   🚀 **Performance:** Direct communication with your USB stick. No intermediate MQTT brokers or slow translation layers.
*   🔌 **Flexibility:** Run it standalone ("Direct Mode") OR connect it to an existing **Z-Wave JS UI** instance ("Remote Mode").
*   🏠 **Native Feel:** Devices appear in Apple Home exactly as you expect. Multi-sensor devices are grouped logically.
*   🔐 **Secure:** Full support for S2 Security (Locks, Garage Doors) with auto-generated keys.

---

## 🛠️ One Plugin, Three Architectures

Choose the setup that fits your needs:

| Mode | Best For... | Description |
| :--- | :--- | :--- |
| **Direct** | ⚡ **Speed & Simplicity** | The plugin owns the USB stick. Zero external dependencies. Ideal for Raspberry Pi setups. |
| **Remote** | 🐳 **Docker / NAS** | Connects to **Z-Wave JS UI** running in a separate container. Perfect if you want the advanced Z-Wave control panel. |
| **Host** | 🎛️ **Hybrid** | The plugin runs the Z-Wave network but exposes a server for **Z-Wave JS UI** to connect to for management/graphs. |

---

## 📦 Installation

1.  **Install Homebridge**: [Official Instructions](https://github.com/homebridge/homebridge/wiki).
2.  **Install Plugin**: 
    ```bash
    npm install -g homebridge-zwave-usb
    ```
3.  **Permissions (Linux/Pi)**: Ensure the user running Homebridge has access to serial ports:
    ```bash
    sudo usermod -a -G dialout $(whoami)
    ```

---

## ⚙️ Configuration

### Option A: Direct Mode (Recommended)
*The simplest way to get started.*

1.  Go to **Settings** in Homebridge UI.
2.  **Serial Port**: Enter the persistent path to your stick.
    > [!WARNING]
    > **Do not use `/dev/ttyACM0`**. Use the stable path found in `/dev/serial/by-id/...`
3.  **Security Keys**: Click the **"Auto-Generate Keys"** button.
4.  **Save & Restart**.

### Option B: Remote Mode (Z-Wave JS UI)
*Connect to an existing Z-Wave JS UI instance.*

1.  Ensure **Z-Wave JS UI** is running and "WS Server" is enabled (Settings -> Home Assistant / WS).
2.  In Homebridge Plugin Settings:
    *   **Serial Port**: Enter the WebSocket URL (e.g., `ws://localhost:3000` or `ws://192.168.1.50:3000`).
3.  **Keys**: Leave blank. (Keys are managed inside Z-Wave JS UI).
4.  **Save & Restart**.

### Option C: Host Mode
*Homebridge runs the network, but you want to view the graph in Z-Wave JS UI.*

1.  Follow "Direct Mode" setup.
2.  Check **"Enable Z-Wave Server"**.
3.  In **Z-Wave JS UI**, set the driver mode to "Remote" and point it to `ws://YOUR_HOMEBRIDGE_IP:3000`.

---

## ✅ Supported Devices

The plugin automatically maps Z-Wave capabilities to Apple HomeKit services:

| Device Type | HomeKit Service | Notes |
| :--- | :--- | :--- |
| **Switches / Plugs** | Switch / Outlet | Instant status updates. |
| **Dimmers** | Lightbulb | Brightness 0-100%. |
| **Locks** | Lock Mechanism | Supports Secure (S0/S2) pairing. |
| **Motion Sensors** | Motion Sensor | |
| **Door/Window** | Contact Sensor | |
| **Leak Sensors** | Leak Sensor | |
| **Climate** | Temp / Humidity | Auto-converts Fahrenheit/Celsius. |
| **Scene Controllers** | Programmable Switch | Supports Single, Double, Long press. |
| **Battery** | Battery Service | Low battery alerts in Home app. |

---

## 🎮 Managing Your Network

This plugin exposes a **"Z-Wave Controller"** accessory in Apple Home. You can use it to manage your mesh right from your phone:

*   **Inclusion Mode:** Turn ON to pair a new device (timeout: 60s).
*   **Exclusion Mode:** Turn ON to unpair/remove a device.
*   **Heal Network:** Turn ON to rebuild mesh routes (do this after moving devices).

---

## ❓ Troubleshooting

*   **Device not showing up?** Battery devices sleep. Wake them up (press the button) repeatedly after pairing until the interview completes.
*   **Port Busy Error?** Ensure no other software (like Z-Wave JS UI) is trying to use the USB stick at the same time. If you want both, use **Remote Mode**.
*   **Secure Inclusion Failed?** Ensure you have generated Security Keys in the settings.

## Contributing

Pull requests are welcome! Please ensure all changes pass `npm test` and `npm run build`.

## Legal & Disclaimer

**Homebridge Z-Wave USB** is an independent project and is not affiliated with, endorsed by, or sponsored by any of the following trademark owners:

- **Apple, HomeKit, and Apple Home** are trademarks of Apple Inc., registered in the U.S. and other countries.
- **Z-Wave and Z-Wave Plus** are registered trademarks of Silicon Labs and its subsidiaries.
- **Homebridge** is a registered trademark of the Homebridge project.
- **Aeotec, Zooz, and Home Assistant** are trademarks of their respective owners.

This project is **not affiliated with, maintained, or supported by** the official **Z-Wave JS** or **Z-Wave JS UI** (formerly zwavejs2mqtt) projects. It is an independent wrapper for Homebridge.

**DISCLAIMER:**
This software is provided "as is", without warranty of any kind. The authors are not responsible for any damage, data loss, or security breaches that may occur. 
**You use this software at your own risk.** 
This includes, but is not limited to, the risk of:
- Smart locks unlocking unexpectedly.
- Z-Wave devices failing to respond.
- Loss of configuration data.

Always ensure you have backups of your Z-Wave controller keys and Homebridge configuration.

## License

MIT