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
  private static readonly FEATURE_ATTACHERS: Record<
    string,
    (
      platform: ZWaveUsbPlatform,
      accessory: ZWaveAccessory,
      endpoint: Endpoint,
      node: IZWaveNode,
    ) => void
  > = {
      thermostat: (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new ThermostatFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'window-covering': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new WindowCoveringFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'garage-door': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new GarageDoorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      lock: (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new LockFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'color-switch': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new ColorSwitchFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'multilevel-switch': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new MultilevelSwitchFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'binary-switch': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new BinarySwitchFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      siren: (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new SirenFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'multilevel-sensor': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new MultilevelSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'multilevel-sensor-skip-temperature': (platform, accessory, endpoint, node) => {
        const feature = new MultilevelSensorFeature(
          platform,
          accessory.platformAccessory,
          endpoint,
          node,
        );
        feature.skipTemperature = true;
        accessory.addFeature(feature);
      },
      'leak-sensor': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new LeakSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'motion-sensor': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new MotionSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'contact-sensor': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new ContactSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'smoke-sensor': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new SmokeSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'carbon-monoxide-sensor': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new CarbonMonoxideSensorFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      'central-scene': (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new CentralSceneFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
      battery: (platform, accessory, endpoint, node) => {
        accessory.addFeature(
          new BatteryFeature(platform, accessory.platformAccessory, endpoint, node),
        );
      },
    };

  private static getFeaturePlans(
    node: IZWaveNode,
  ): Array<{ endpoint: Endpoint; featureKinds: string[] }> {
    const endpoints = node.getAllEndpoints();
    const isMultiEndpoint = endpoints.length > 1;
    const handledByEndpoints = this.getHandledByEndpoints(endpoints);

    return endpoints.map((endpoint) => ({
      endpoint,
      featureKinds: this.planFeatureKinds(node, endpoint, handledByEndpoints, isMultiEndpoint),
    }));
  }

  public static getGraphSignature(node: IZWaveNode): string {
    const graph = this.getFeaturePlans(node).map(({ endpoint, featureKinds }) => ({
      endpoint: endpoint.index,
      features: featureKinds,
    }));

    return JSON.stringify(graph);
  }

  public static create(
    platform: ZWaveUsbPlatform,
    node: IZWaveNode,
    homeId: number,
  ): ZWaveAccessory {
    const accessory = new ZWaveAccessory(platform, node, homeId);
    const featurePlans = this.getFeaturePlans(node);
    const graphSignature = this.getGraphSignature(node);

    for (const { endpoint, featureKinds } of featurePlans) {
      this.attachFeatures(platform, accessory, node, endpoint, featureKinds);
    }

    accessory.setGraphSignature(graphSignature);

    return accessory;
  }

  private static getHandledByEndpoints(
    endpoints: Endpoint[],
  ): Map<CommandClasses, Set<number>> {
    const handledByEndpoints = new Map<CommandClasses, Set<number>>();
    if (endpoints.length <= 1) {
      return handledByEndpoints;
    }

    for (const ep of endpoints) {
      if (ep.index === 0) {
        continue;
      }
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
        CommandClasses['Central Scene'],
        CommandClasses.Battery,
      ].forEach((cc) => {
        if (ep.supportsCC(cc)) {
          if (!handledByEndpoints.has(cc)) {
            handledByEndpoints.set(cc, new Set());
          }
          handledByEndpoints.get(cc)!.add(ep.index);
        }
      });
    }

    return handledByEndpoints;
  }

  private static planFeatureKinds(
    node: IZWaveNode,
    endpoint: Endpoint,
    handledByEndpoints: Map<CommandClasses, Set<number>>,
    isMultiEndpoint: boolean,
  ): string[] {
    const allValues = node.getDefinedValueIDs();
    const values = allValues.filter((v) => v.endpoint === endpoint.index);
    const featureKinds: string[] = [];

    const isRootOnMultiEndpoint = endpoint.index === 0 && isMultiEndpoint && handledByEndpoints.size > 0;

    const hasSwitch =
      endpoint.supportsCC(CommandClasses['Binary Switch']) &&
      (!isRootOnMultiEndpoint || !handledByEndpoints.has(CommandClasses['Binary Switch']));
    const hasMultilevelSwitch =
      endpoint.supportsCC(CommandClasses['Multilevel Switch']) &&
      (!isRootOnMultiEndpoint || !handledByEndpoints.has(CommandClasses['Multilevel Switch']));
    const supportsAnyLockCc =
      endpoint.supportsCC(CommandClasses['Door Lock']) ||
      endpoint.supportsCC(CommandClasses.Lock);
    const lockHandledByNonRootEndpoint =
      handledByEndpoints.has(CommandClasses['Door Lock']) ||
      handledByEndpoints.has(CommandClasses.Lock);
    const hasLock =
      supportsAnyLockCc && (!isRootOnMultiEndpoint || !lockHandledByNonRootEndpoint);
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

    let handledAsActuator = false;

    if (hasThermostat) {
      featureKinds.push('thermostat');
      handledAsActuator = true;
    }

    if (hasWindowCovering) {
      featureKinds.push('window-covering');
      handledAsActuator = true;
    }

    if (hasGarageDoor) {
      featureKinds.push('garage-door');
      handledAsActuator = true;
    }

    if (hasLock) {
      featureKinds.push('lock');
      handledAsActuator = true;
    }

    if (hasColor) {
      featureKinds.push('color-switch');
    }

    if (hasMultilevelSwitch && !handledAsActuator) {
      featureKinds.push('multilevel-switch');
      handledAsActuator = true;
    }

    if (hasSwitch && !handledAsActuator && !hasSiren) {
      featureKinds.push('binary-switch');
      handledAsActuator = true;
    }

    if (hasSiren) {
      featureKinds.push('siren');
    }

    if (hasSensorMultilevel) {
      featureKinds.push(hasThermostat ? 'multilevel-sensor-skip-temperature' : 'multilevel-sensor');
    }

    if (hasNotification) {
      const notificationValues = values.filter(
        (v: ValueID) => v.commandClass === CommandClasses.Notification,
      );

      const isVerifiedSensor = (
        property: string,
        keys: string[],
        sensorStates: number[],
      ): boolean => {
        const v = notificationValues.find(
          (valueId) =>
            valueId.property === property &&
            (keys.length === 0 || keys.includes(valueId.propertyKey as string)),
        );
        if (!v) {
          return false;
        }

        const meta = node.getValueMetadata(v) as { states?: Record<string, unknown> } | undefined;

        if (endpoint.index > 0 && hasLock) {
          return true;
        }

        if (meta?.states && typeof meta.states === 'object') {
          const supported = Object.keys(meta.states).map(Number);
          if (sensorStates.some((state) => supported.includes(state))) {
            return true;
          }
        }

        if (node.getValue(v) !== undefined) {
          return true;
        }

        return !hasLock;
      };

      if (isVerifiedSensor('Water Alarm', ['Water leak status'], [1, 2, 3, 4])) {
        featureKinds.push('leak-sensor');
      }

      if (isVerifiedSensor('Home Security', ['Motion sensor status', 'Sensor status'], [7, 8])) {
        featureKinds.push('motion-sensor');
      }

      if (isVerifiedSensor('Access Control', ['Door status'], [22, 23])) {
        featureKinds.push('contact-sensor');
      }

      if (notificationValues.some((v: ValueID) => v.property === 'Smoke Alarm')) {
        featureKinds.push('smoke-sensor');
      }

      if (notificationValues.some((v: ValueID) => v.property === 'Carbon Monoxide Alarm')) {
        featureKinds.push('carbon-monoxide-sensor');
      }
    }

    if (hasSensorBinary) {
      if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses['Binary Sensor'] && v.property === 'Water',
        )
      ) {
        featureKinds.push('leak-sensor');
      } else if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses['Binary Sensor'] && v.property === 'Smoke',
        )
      ) {
        featureKinds.push('smoke-sensor');
      } else if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses['Binary Sensor'] && v.property === 'CO',
        )
      ) {
        featureKinds.push('carbon-monoxide-sensor');
      } else if (
        values.some(
          (v: ValueID) =>
            v.commandClass === CommandClasses['Binary Sensor'] && v.property === 'CO2',
        )
      ) {
        featureKinds.push('multilevel-sensor');
      } else if (!hasLock) {
        featureKinds.push('contact-sensor');
      }
    }

    if (hasCentralScene) {
      featureKinds.push('central-scene');
    }

    if (hasBattery) {
      featureKinds.push('battery');
    }

    return featureKinds;
  }

  private static attachFeatures(
    platform: ZWaveUsbPlatform,
    accessory: ZWaveAccessory,
    node: IZWaveNode,
    endpoint: Endpoint,
    featureKinds: string[],
  ): void {
    for (const featureKind of featureKinds) {
      const attachFeature = this.FEATURE_ATTACHERS[featureKind];
      if (!attachFeature) {
        throw new Error(`Unsupported feature plan "${featureKind}" for endpoint ${endpoint.index}`);
      }
      attachFeature(platform, accessory, endpoint, node);
    }
  }
}
