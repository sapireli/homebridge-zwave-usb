import { Endpoint, ValueID } from 'zwave-js';
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

export class AccessoryFactory {
  public static create(
    platform: ZWaveUsbPlatform,
    node: IZWaveNode,
    homeId: number,
  ): ZWaveAccessory {
    const accessory = new ZWaveAccessory(platform, node, homeId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoints = node.getAllEndpoints() as any[];

    for (const endpoint of endpoints) {
      // Endpoint interface from zwave-js might differ from what we have in virtual node
      this.attachFeatures(platform, accessory, node, endpoint);
    }

    return accessory;
  }

  private static attachFeatures(
    platform: ZWaveUsbPlatform,
    accessory: ZWaveAccessory,
    node: IZWaveNode,
    endpoint: Endpoint,
  ): void {
    const allValues = node.getDefinedValueIDs();
    const values = allValues.filter(v => v.endpoint === endpoint.index);

    const hasSwitch = endpoint.supportsCC(37);
    const hasMultilevelSwitch = endpoint.supportsCC(38);
    const hasLock = endpoint.supportsCC(98);
    const hasSensorMultilevel = endpoint.supportsCC(49);
    const hasNotification = endpoint.supportsCC(113);
    const hasSensorBinary = endpoint.supportsCC(48);
    const hasCentralScene = endpoint.supportsCC(91);

    // 1. Lock
    if (hasLock) {
      accessory.addFeature(new LockFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 2. Multilevel Switch (Dimmer)
    if (hasMultilevelSwitch) {
      accessory.addFeature(new MultilevelSwitchFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 3. Binary Switch
    if (hasSwitch && !hasMultilevelSwitch) {
      accessory.addFeature(new BinarySwitchFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 4. Multilevel Sensor
    if (hasSensorMultilevel) {
      accessory.addFeature(new MultilevelSensorFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 5. Notification Sensors
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
    }

    // 6. Binary Sensor (Legacy)
    if (hasSensorBinary) {
      // Default to ContactSensor for generic binary sensors
      accessory.addFeature(new ContactSensorFeature(platform, accessory.platformAccessory, endpoint));
    }

    // 7. Central Scene (Buttons)
    if (hasCentralScene) {
      accessory.addFeature(new CentralSceneFeature(platform, accessory.platformAccessory, endpoint));
    }
  }
}
