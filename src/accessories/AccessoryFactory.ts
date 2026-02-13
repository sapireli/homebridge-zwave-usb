import { ValueID } from 'zwave-js';
import { IZWaveNode } from '../zwave/interfaces';
import { ZWaveAccessory } from './ZWaveAccessory';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { BinarySwitchFeature } from '../features/BinarySwitchFeature';
import { MultilevelSwitchFeature } from '../features/MultilevelSwitchFeature';
import { LockFeature } from '../features/LockFeature';
import { MultilevelSensorFeature } from '../features/MultilevelSensorFeature';
import { ContactSensorFeature } from '../features/ContactSensorFeature';
import { MotionSensorFeature } from '../features/MotionSensorFeature';
import { LeakSensorFeature } from '../features/LeakSensorFeature';
import { CentralSceneFeature } from '../features/CentralSceneFeature';
import { BatteryFeature } from '../features/BatteryFeature';
import { SmokeSensorFeature } from '../features/SmokeSensorFeature';
import { CarbonMonoxideSensorFeature } from '../features/CarbonMonoxideSensorFeature';
import { ThermostatFeature } from '../features/ThermostatFeature';
import { WindowCoveringFeature } from '../features/WindowCoveringFeature';
import { GarageDoorFeature } from '../features/GarageDoorFeature';
import { ColorSwitchFeature } from '../features/ColorSwitchFeature';
import { SirenFeature } from '../features/SirenFeature';

export class AccessoryFactory {
  public static create(
    platform: ZWaveUsbPlatform,
    node: IZWaveNode,
    homeId: number,
  ): ZWaveAccessory {
    const accessory = new ZWaveAccessory(platform, node, homeId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoints = node.getAllEndpoints() as any[];
    const isMultiEndpoint = endpoints.length > 1;

    // Track which CCs are handled by non-zero endpoints to avoid duplicates on root
    const handledByEndpoints = new Set<number>();
    if (isMultiEndpoint) {
      for (const ep of endpoints) {
        if (ep.index === 0) {
          continue;
        }
        // Common CCs that might appear on endpoints
        [37, 38, 48, 49, 98, 113, 64, 106, 102, 51, 121].forEach(cc => {
          if (ep.supportsCC(cc)) {
            handledByEndpoints.add(cc);
          }
        });
      }
    }

    for (const endpoint of endpoints) {
      this.attachFeatures(platform, accessory, node, endpoint, handledByEndpoints);
    }

    return accessory;
  }

  private static attachFeatures(
    platform: ZWaveUsbPlatform,
    accessory: ZWaveAccessory,
    node: IZWaveNode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    endpoint: any,
    handledByEndpoints: Set<number>,
  ): void {
    const allValues = node.getDefinedValueIDs();
    const values = allValues.filter(v => v.endpoint === endpoint.index);

    const isRootOnMultiEndpoint = endpoint.index === 0 && handledByEndpoints.size > 0;

    const hasSwitch = endpoint.supportsCC(37) && (!isRootOnMultiEndpoint || !handledByEndpoints.has(37));
    const hasMultilevelSwitch = endpoint.supportsCC(38) && (!isRootOnMultiEndpoint || !handledByEndpoints.has(38));
    const hasLock = endpoint.supportsCC(98) && (!isRootOnMultiEndpoint || !handledByEndpoints.has(98));
    const hasSensorMultilevel = endpoint.supportsCC(49) && (!isRootOnMultiEndpoint || !handledByEndpoints.has(49));
    const hasNotification = endpoint.supportsCC(113) && (!isRootOnMultiEndpoint || !handledByEndpoints.has(113));
    const hasSensorBinary = endpoint.supportsCC(48) && (!isRootOnMultiEndpoint || !handledByEndpoints.has(48));
    const hasCentralScene = endpoint.supportsCC(91);
    const hasBattery = endpoint.supportsCC(128);
    const hasThermostat = endpoint.supportsCC(64);
    const hasWindowCovering = endpoint.supportsCC(106);
    const hasGarageDoor = endpoint.supportsCC(102);
    const hasColor = endpoint.supportsCC(51);
    const hasSiren = endpoint.supportsCC(121);

    // 1. Thermostat (High Priority)
    if (hasThermostat) {
        accessory.addFeature(new ThermostatFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 2. Window Covering
    if (hasWindowCovering) {
        accessory.addFeature(new WindowCoveringFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 3. Garage Door
    if (hasGarageDoor) {
        accessory.addFeature(new GarageDoorFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 4. Lock
    if (hasLock) {
      accessory.addFeature(new LockFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 5. Color Control (can coexist with Multilevel Switch)
    if (hasColor) {
        accessory.addFeature(new ColorSwitchFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 6. Multilevel Switch (Dimmer)
    if (hasMultilevelSwitch && !hasWindowCovering) {
      accessory.addFeature(new MultilevelSwitchFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 7. Binary Switch
    if (hasSwitch && !hasMultilevelSwitch && !hasWindowCovering && !hasGarageDoor && !hasSiren) {
      accessory.addFeature(new BinarySwitchFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 8. Siren
    if (hasSiren) {
        accessory.addFeature(new SirenFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 9. Multilevel Sensor
    if (hasSensorMultilevel) {
      accessory.addFeature(new MultilevelSensorFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 10. Notification Sensors
    if (hasNotification) {
      // Water Alarm
      if (values.some((v: ValueID) => v.commandClass === 113 && (v.property === 'Water Alarm' || v.propertyKey === 'Water leak status'))) {
        accessory.addFeature(new LeakSensorFeature(platform, accessory.platformAccessory, endpoint));
      }

      // Home Security - Motion
      if (values.some((v: ValueID) => v.commandClass === 113 && (v.property === 'Home Security' || v.propertyKey === 'Motion sensor status'))) {
        accessory.addFeature(new MotionSensorFeature(platform, accessory.platformAccessory, endpoint));
      }

      // Access Control - Door/Window
      if (values.some((v: ValueID) => v.commandClass === 113 && (v.property === 'Access Control' || v.propertyKey === 'Door status'))) {
        accessory.addFeature(new ContactSensorFeature(platform, accessory.platformAccessory, endpoint));
      }

      // Smoke Alarm
      if (values.some((v: ValueID) => v.commandClass === 113 && v.property === 'Smoke Alarm')) {
        accessory.addFeature(new SmokeSensorFeature(platform, accessory.platformAccessory, endpoint));
      }

      // CO Alarm
      if (values.some((v: ValueID) => v.commandClass === 113 && v.property === 'Carbon Monoxide Alarm')) {
        accessory.addFeature(new CarbonMonoxideSensorFeature(platform, accessory.platformAccessory, endpoint));
      }
    }

    // 11. Binary Sensor (Legacy)
    if (hasSensorBinary) {
      if (values.some((v: ValueID) => v.commandClass === 48 && v.property === 'Water')) {
        accessory.addFeature(new LeakSensorFeature(platform, accessory.platformAccessory, endpoint));
      } else if (values.some((v: ValueID) => v.commandClass === 48 && v.property === 'Smoke')) {
        accessory.addFeature(new SmokeSensorFeature(platform, accessory.platformAccessory, endpoint));
      } else if (values.some((v: ValueID) => v.commandClass === 48 && (v.property === 'CO' || v.property === 'CO2'))) {
        accessory.addFeature(new CarbonMonoxideSensorFeature(platform, accessory.platformAccessory, endpoint));
      } else {
        // Default to ContactSensor for other generic binary sensors
        accessory.addFeature(new ContactSensorFeature(platform, accessory.platformAccessory, endpoint));
      }
    }

    // 12. Central Scene (Buttons)
    if (hasCentralScene) {
      accessory.addFeature(new CentralSceneFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 13. Battery
    if (hasBattery) {
      accessory.addFeature(new BatteryFeature(platform, accessory.platformAccessory, endpoint));
    }
  }
}
