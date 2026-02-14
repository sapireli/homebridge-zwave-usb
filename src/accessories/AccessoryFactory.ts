import { ValueID, Endpoint } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
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
    const endpoints = node.getAllEndpoints();
    const isMultiEndpoint = endpoints.length > 1;

    // Track which CCs are handled by non-zero endpoints to avoid duplicates on root
    const handledByEndpoints = new Set<CommandClasses>();
    if (isMultiEndpoint) {
      for (const ep of endpoints) {
        if (ep.index === 0) {
          continue;
        }
        // Common CCs that might appear on endpoints
        [
          CommandClasses['Binary Switch'],
          CommandClasses['Multilevel Switch'],
          CommandClasses['Binary Sensor'],
          CommandClasses['Multilevel Sensor'],
          CommandClasses.Lock,
          CommandClasses.Notification,
          CommandClasses['Thermostat Mode'],
          CommandClasses['Window Covering'],
          CommandClasses['Door Lock'],
          CommandClasses['Color Switch'],
          CommandClasses['Sound Switch'],
        ].forEach((cc) => {
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
    endpoint: Endpoint,
    handledByEndpoints: Set<CommandClasses>,
  ): void {
    const allValues = node.getDefinedValueIDs();
    const values = allValues.filter((v) => v.endpoint === endpoint.index);

    const isRootOnMultiEndpoint = endpoint.index === 0 && handledByEndpoints.size > 0;

    const hasSwitch =
      endpoint.supportsCC(CommandClasses['Binary Switch']) &&
      (!isRootOnMultiEndpoint || !handledByEndpoints.has(CommandClasses['Binary Switch']));
    const hasMultilevelSwitch =
      endpoint.supportsCC(CommandClasses['Multilevel Switch']) &&
      (!isRootOnMultiEndpoint || !handledByEndpoints.has(CommandClasses['Multilevel Switch']));
    const hasLock =
      endpoint.supportsCC(CommandClasses.Lock) &&
      (!isRootOnMultiEndpoint || !handledByEndpoints.has(CommandClasses.Lock));
    const hasSensorMultilevel =
      endpoint.supportsCC(CommandClasses['Multilevel Sensor']) &&
      (!isRootOnMultiEndpoint || !handledByEndpoints.has(CommandClasses['Multilevel Sensor']));
    const hasNotification =
      endpoint.supportsCC(CommandClasses.Notification) &&
      (!isRootOnMultiEndpoint || !handledByEndpoints.has(CommandClasses.Notification));
    const hasSensorBinary =
      endpoint.supportsCC(CommandClasses['Binary Sensor']) &&
      (!isRootOnMultiEndpoint || !handledByEndpoints.has(CommandClasses['Binary Sensor']));
    const hasCentralScene = endpoint.supportsCC(CommandClasses['Central Scene']);
    const hasBattery = endpoint.supportsCC(CommandClasses.Battery);
    const hasThermostat = endpoint.supportsCC(CommandClasses['Thermostat Mode']);
    const hasWindowCovering = endpoint.supportsCC(CommandClasses['Window Covering']);
    const hasGarageDoor = endpoint.supportsCC(CommandClasses['Barrier Operator']);
    const hasColor = endpoint.supportsCC(CommandClasses['Color Switch']);
    const hasSiren = endpoint.supportsCC(CommandClasses['Sound Switch']);

    // 1. Thermostat (High Priority)
    if (hasThermostat) {
      accessory.addFeature(
        new ThermostatFeature(platform, accessory.platformAccessory, endpoint, node),
      );
    }

    // 2. Window Covering
    if (hasWindowCovering) {
      accessory.addFeature(
        new WindowCoveringFeature(platform, accessory.platformAccessory, endpoint, node),
      );
    }

    // 3. Garage Door
    if (hasGarageDoor) {
      accessory.addFeature(
        new GarageDoorFeature(platform, accessory.platformAccessory, endpoint, node),
      );
    }

    // 4. Lock
    if (hasLock) {
      accessory.addFeature(new LockFeature(platform, accessory.platformAccessory, endpoint, node));
    }

    // 5. Color Control (can coexist with Multilevel Switch)
    if (hasColor) {
      accessory.addFeature(
        new ColorSwitchFeature(platform, accessory.platformAccessory, endpoint, node),
      );
    }

    // 6. Multilevel Switch (Dimmer)
    if (hasMultilevelSwitch && !hasWindowCovering) {
      accessory.addFeature(
        new MultilevelSwitchFeature(platform, accessory.platformAccessory, endpoint, node),
      );
    }

    // 7. Binary Switch
    if (hasSwitch && !hasMultilevelSwitch && !hasWindowCovering && !hasGarageDoor && !hasSiren) {
      accessory.addFeature(
        new BinarySwitchFeature(platform, accessory.platformAccessory, endpoint, node),
      );
    }

    // 8. Siren
    if (hasSiren) {
      accessory.addFeature(new SirenFeature(platform, accessory.platformAccessory, endpoint, node));
    }

    // 9. Multilevel Sensor
    if (hasSensorMultilevel) {
      accessory.addFeature(
        new MultilevelSensorFeature(platform, accessory.platformAccessory, endpoint, node),
      );
    }

    // 10. Notification Sensors
    if (hasNotification) {
      // Water Alarm
      if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses.Notification &&
            (v.property === 'Water Alarm' || v.propertyKey === 'Water leak status'),
        )
      ) {
        accessory.addFeature(
          new LeakSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      }

      // Home Security - Motion
      if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses.Notification &&
            (v.property === 'Home Security' || v.propertyKey === 'Motion sensor status'),
        )
      ) {
        accessory.addFeature(
          new MotionSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      }

      // Access Control - Door/Window
      if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses.Notification &&
            (v.property === 'Access Control' || v.propertyKey === 'Door status'),
        )
      ) {
        accessory.addFeature(
          new ContactSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      }

      // Smoke Alarm
      if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses.Notification && v.property === 'Smoke Alarm',
        )
      ) {
        accessory.addFeature(
          new SmokeSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      }

      // CO Alarm
      if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses.Notification &&
            v.property === 'Carbon Monoxide Alarm',
        )
      ) {
        accessory.addFeature(
          new CarbonMonoxideSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      }
    }

    // 11. Binary Sensor (Legacy)
    if (hasSensorBinary) {
      if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses['Binary Sensor'] && v.property === 'Water',
        )
      ) {
        accessory.addFeature(
          new LeakSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      } else if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses['Binary Sensor'] && v.property === 'Smoke',
        )
      ) {
        accessory.addFeature(
          new SmokeSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      } else if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses['Binary Sensor'] &&
            (v.property === 'CO' || v.property === 'CO2'),
        )
      ) {
        accessory.addFeature(
          new CarbonMonoxideSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      } else {
        // Default to ContactSensor for other generic binary sensors
        accessory.addFeature(
          new ContactSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      }
    }

    // 12. Central Scene (Buttons)
    if (hasCentralScene) {
      accessory.addFeature(
        new CentralSceneFeature(platform, accessory.platformAccessory, endpoint, node),
      );
    }

    // 13. Battery
    if (hasBattery) {
      accessory.addFeature(
        new BatteryFeature(platform, accessory.platformAccessory, endpoint, node),
      );
    }
  }
}
