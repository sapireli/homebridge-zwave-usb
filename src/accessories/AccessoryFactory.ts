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
import { multilevelSwitchDrivesCovering } from '../devices/deviceOverrides';

/** Every kind the planner can produce, including the two that can never be primary. */
export type FeatureKind =
  | PrimaryKind
  | 'battery'
  | 'multilevel-sensor-skip-temperature';

/**
 * The kinds that can stand as a device's primary type, in the order the primary is chosen.
 *
 * This is deliberately not the order the planner pushes kinds in. A device that reports both a
 * multilevel sensor and a motion sensor is a motion sensor with a temperature reading, not a
 * thermometer that happens to detect motion, so the notification sensors rank above
 * `multilevel-sensor` even though the planner pushes that one first.
 */
export const PRIMARY_KINDS = [
  'thermostat',
  'window-covering',
  'garage-door',
  'lock',
  'color-switch',
  'multilevel-switch',
  'binary-switch',
  'siren',
  'leak-sensor',
  'motion-sensor',
  'contact-sensor',
  'smoke-sensor',
  'carbon-monoxide-sensor',
  'multilevel-sensor',
  'central-scene',
] as const;

export type PrimaryKind = (typeof PRIMARY_KINDS)[number];

export function isPrimaryKind(kind: string): kind is PrimaryKind {
  return (PRIMARY_KINDS as readonly string[]).includes(kind);
}

/**
 * One endpoint's plan: the kinds it publishes, in the order they are built, plus which of them
 * stands as its primary type and which are replaced along with it.
 */
export interface EndpointPlan {
  endpoint: Endpoint;
  /** Never re-sorted. The order is the order the features are attached in. */
  effectiveKinds: FeatureKind[];
  primaryKind?: PrimaryKind;
  /** The kinds an override removes together. Empty when the endpoint has no primary. */
  primaryGroup: PrimaryKind[];
}

export interface PlanOptions {
  /** Replaces the endpoint's primary group. Ignored when the endpoint has no primary. */
  primaryOverride?: PrimaryKind;
}

/**
 * What each primary kind needs before a device can be published as it.
 *
 * Separate from detection on purpose. Detection decides what a device publishes when nobody has
 * said otherwise, and is broader in places, because a device that reports a command class is
 * usually the thing that command class describes. Compatibility answers a different question:
 * whether this feature could drive a working service on this endpoint if a user asked for it.
 * Each predicate lives beside the feature it speaks for, so it is derived from the values that
 * feature actually reads rather than restated here.
 */
export const PRIMARY_CAPABILITY: Record<
  PrimaryKind,
  (node: IZWaveNode, endpoint: Endpoint) => boolean
> = {
  thermostat: ThermostatFeature.canBePrimary,
  'window-covering': WindowCoveringFeature.canBePrimary,
  'garage-door': GarageDoorFeature.canBePrimary,
  lock: LockFeature.canBePrimary,
  'color-switch': ColorSwitchFeature.canBePrimary,
  'multilevel-switch': MultilevelSwitchFeature.canBePrimary,
  'binary-switch': BinarySwitchFeature.canBePrimary,
  siren: SirenFeature.canBePrimary,
  'leak-sensor': LeakSensorFeature.canBePrimary,
  'motion-sensor': MotionSensorFeature.canBePrimary,
  'contact-sensor': ContactSensorFeature.canBePrimary,
  'smoke-sensor': SmokeSensorFeature.canBePrimary,
  'carbon-monoxide-sensor': CarbonMonoxideSensorFeature.canBePrimary,
  'multilevel-sensor': MultilevelSensorFeature.canBePrimary,
  'central-scene': CentralSceneFeature.canBePrimary,
};

export class AccessoryFactory {
  private static readonly FEATURE_CATEGORY_PRIORITY: Array<[FeatureKind, number]> = [
    ['garage-door', 4],
    ['lock', 6],
    ['thermostat', 9],
    ['window-covering', 14],
    ['central-scene', 15],
    ['color-switch', 5],
    ['multilevel-switch', 5],
    ['binary-switch', 8],
    ['siren', 3],
    ['leak-sensor', 10],
    ['motion-sensor', 10],
    ['contact-sensor', 10],
    ['smoke-sensor', 10],
    ['carbon-monoxide-sensor', 10],
    ['multilevel-sensor', 10],
    ['multilevel-sensor-skip-temperature', 10],
    ['battery', 10],
  ];

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

  /**
   * What each of the node's endpoints publishes, and which kind stands as its primary type.
   *
   * Detection is unchanged: `planFeatureKinds` decides what a device publishes, exactly as
   * before, and an override edits that result rather than taking part in deciding it. A node
   * with no override therefore plans the same kinds in the same order as it always has, which
   * is what keeps an upgrade from rebuilding and recategorizing accessories that nobody asked
   * to change.
   */
  public static planFeatures(node: IZWaveNode, options: PlanOptions = {}): EndpointPlan[] {
    const endpoints = node.getAllEndpoints();
    const isMultiEndpoint = endpoints.length > 1;
    const handledByEndpoints = this.getHandledByEndpoints(endpoints);

    return endpoints.map((endpoint) => {
      const detected = this.planFeatureKinds(
        node,
        endpoint,
        handledByEndpoints,
        isMultiEndpoint,
      ) as FeatureKind[];
      const primaryKind = this.selectPrimaryKind(detected);
      const primaryGroup = this.selectPrimaryGroup(detected, primaryKind);
      const effectiveKinds = this.applyPrimaryOverride(
        detected,
        primaryKind,
        primaryGroup,
        options.primaryOverride,
      );

      return { endpoint, effectiveKinds, primaryKind, primaryGroup };
    });
  }

  /**
   * Every primary kind this node could be published as, in the primary rule's order.
   *
   * Only single-endpoint nodes are answered. A device with several endpoints has a primary per
   * endpoint, and choosing one type for the node would be choosing which endpoint the node is.
   */
  public static compatiblePrimaryKinds(node: IZWaveNode): PrimaryKind[] {
    const endpoints = node.getAllEndpoints();
    if (endpoints.length !== 1) {
      return [];
    }

    const endpoint = endpoints[0];

    return PRIMARY_KINDS.filter((kind) => PRIMARY_CAPABILITY[kind](node, endpoint));
  }

  /** The first kind present by the primary rule's own order, not by the planner's push order. */
  private static selectPrimaryKind(kinds: readonly FeatureKind[]): PrimaryKind | undefined {
    return PRIMARY_KINDS.find((candidate) => kinds.includes(candidate));
  }

  /**
   * The kinds an override removes together with the primary.
   *
   * Color and brightness share one Lightbulb service today, so replacing the color control
   * has to take the brightness control with it or a second feature would be left writing to a
   * service that no longer exists. A thermostat is the opposite case: its suppressed
   * temperature sensor is not part of it, and is handed back as an ordinary sensor on override.
   */
  private static selectPrimaryGroup(
    kinds: readonly FeatureKind[],
    primaryKind: PrimaryKind | undefined,
  ): PrimaryKind[] {
    if (!primaryKind) {
      return [];
    }

    if (primaryKind === 'color-switch' && kinds.includes('multilevel-switch')) {
      return ['color-switch', 'multilevel-switch'];
    }

    return [primaryKind];
  }

  /**
   * The override takes the position of the first kind it replaces, so the order the features
   * are attached in is otherwise untouched. A kind identical to the override that appears later
   * is dropped, because the service would already have been built.
   */
  private static applyPrimaryOverride(
    detected: readonly FeatureKind[],
    primaryKind: PrimaryKind | undefined,
    primaryGroup: readonly PrimaryKind[],
    primaryOverride: PrimaryKind | undefined,
  ): FeatureKind[] {
    if (!primaryOverride || !primaryKind || primaryOverride === primaryKind) {
      return [...detected];
    }

    const firstReplaced = detected.findIndex((kind) => kind === primaryGroup[0]);
    if (firstReplaced === -1) {
      return [...detected];
    }

    const effective: FeatureKind[] = [];
    detected.forEach((kind, index) => {
      if (index === firstReplaced) {
        effective.push(primaryOverride);
        return;
      }
      if (primaryGroup.includes(kind as PrimaryKind)) {
        return;
      }
      if (kind === primaryOverride) {
        return;
      }
      // The temperature was suppressed only because the thermostat already reported it.
      if (primaryKind === 'thermostat' && kind === 'multilevel-sensor-skip-temperature') {
        effective.push('multilevel-sensor');
        return;
      }
      effective.push(kind);
    });

    return effective;
  }

  /** The signature of plans already computed, so a build never plans the same node twice. */
  public static signatureOfPlans(plans: readonly EndpointPlan[]): string {
    return JSON.stringify(
      plans.map(({ endpoint, effectiveKinds }) => ({
        endpoint: endpoint.index,
        features: effectiveKinds,
      })),
    );
  }

  /**
   * Builds the accessory from a plan the caller already holds.
   *
   * The plan is an argument rather than something made here, because the caller compares its
   * signature against the cached one to decide whether to build at all. Planning the node again
   * inside this method would read a node that is still interviewing a second time, and an
   * accessory built from the second reading would carry a signature describing the first.
   */
  public static create(
    platform: ZWaveUsbPlatform,
    node: IZWaveNode,
    homeId: number,
    featurePlans: readonly EndpointPlan[],
  ): ZWaveAccessory {
    const accessory = new ZWaveAccessory(
      platform,
      node,
      homeId,
      this.getCategory(featurePlans),
    );
    const graphSignature = AccessoryFactory.signatureOfPlans(featurePlans);

    for (const { endpoint, effectiveKinds } of featurePlans) {
      this.attachFeatures(platform, accessory, node, endpoint, effectiveKinds);
    }

    accessory.setGraphSignature(graphSignature);

    return accessory;
  }

  private static getCategory(featurePlans: readonly EndpointPlan[]): number {
    const featureKinds = new Set(featurePlans.flatMap(({ effectiveKinds }) => effectiveKinds));

    for (const [featureKind, category] of this.FEATURE_CATEGORY_PRIORITY) {
      if (featureKinds.has(featureKind)) {
        return category;
      }
    }

    return 1;
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
      /**
       * Some coverings expose Multilevel Switch CC instead of Window Covering CC. Without this
       * check they would be published as dimmable lights. WindowCoveringFeature already drives
       * Multilevel Switch CC, so only the classification differs.
       */
      featureKinds.push(
        multilevelSwitchDrivesCovering(node) ? 'window-covering' : 'multilevel-switch',
      );
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
