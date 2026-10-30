import { Characteristic, Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { ZWaveAccessory } from '../accessories/ZWaveAccessory';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { homeKitPositionToMatterLift, matterLiftToHomeKitPosition } from './coveringPosition';

type CharacteristicType = typeof Characteristic.On;
type Attributes = Record<string, unknown>;
export interface StateBinding {
  characteristic: CharacteristicType;
  /** A co-located HAP service contributing another measurement to this endpoint. */
  service?: Service;
  cluster: string;
  attributes: (value: unknown) => Attributes;
  event?: true;
  /** Raw measurement exists in the driver cache; HAP getters may otherwise return a default zero. */
  available?: () => boolean;
}
export interface ServiceMapping {
  /** Stable across service ordering changes and process restarts. */
  key: string;
  service: Service;
  deviceType: string;
  clusters: Record<string, Attributes>;
  /** Optional servers exposed through the host's public AirQualitySensor requirements. */
  composition?: Record<string, string[]>;
  bindings: StateBinding[];
  commands: Record<string, Record<string, (request?: never) => Promise<void>>>;
}
export interface MappingIo {
  read(key: string, characteristic: CharacteristicType): Promise<unknown>;
  write(key: string, characteristic: CharacteristicType, value: unknown): Promise<void>;
}

function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Expected a number from ${min} to ${max}`);
  }
  return value;
}
const numeric = (value: unknown, convert = (n: number) => n): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? convert(value) : null;

/** Map the services we actually publish, including every endpoint of a multi-service node. */
export function serviceMappings(
  platform: ZWaveUsbPlatform,
  accessory: ZWaveAccessory,
  io: MappingIo,
): ServiceMapping[] {
  const C = platform.Characteristic;
  const S = platform.Service;
  const result: ServiceMapping[] = [];
  for (const service of accessory.platformAccessory.services) {
    const is = (name: keyof typeof S) =>
      service.UUID === (S[name] as unknown as { UUID?: string })?.UUID;
    const has = (type: CharacteristicType) => !!type && service.testCharacteristic?.(type);
    const key = `${service.UUID}-${service.subtype ?? 'root'}`;
    const m: ServiceMapping = {
      key,
      service,
      deviceType: '',
      clusters: {},
      bindings: [],
      commands: {},
    };
    const bind = (
      characteristic: CharacteristicType,
      cluster: string,
      attributes: StateBinding['attributes'],
    ) => {
      m.bindings.push({ characteristic, cluster, attributes });
    };
    const field = (
      characteristic: CharacteristicType,
      cluster: string,
      name: string,
      convert: (v: unknown) => unknown = (v) => v,
    ) => bind(characteristic, cluster, (v) => ({ [name]: convert(v) }));
    const measurement = (characteristic: CharacteristicType, cluster: string, property: string) => {
      field(characteristic, cluster, 'measuredValue', (v) => numeric(v));
      m.bindings[m.bindings.length - 1].available = () => {
        if (typeof accessory.node.getValue !== 'function') return true;
        try {
          const value = accessory.node.getValue({
            commandClass: CommandClasses['Multilevel Sensor'],
            endpoint: Number(service.subtype ?? 0),
            property,
          });
          return typeof value === 'number' && Number.isFinite(value) && value >= 0;
        } catch {
          return false;
        }
      };
    };
    const write = (type: CharacteristicType, value: unknown) => io.write(key, type, value);
    const onOff = () => {
      field(C.On, 'onOff', 'onOff', Boolean);
      m.commands.onOff = {
        on: async () => write(C.On, true),
        off: async () => write(C.On, false),
        toggle: async () => write(C.On, !(await io.read(key, C.On))),
      };
    };
    const level = (type: CharacteristicType) => {
      field(type, 'levelControl', 'currentLevel', (v) =>
        numeric(v, (n) => Math.round((n * 254) / 100)),
      );
      m.clusters.levelControl = { minLevel: 0, maxLevel: 254 };
      const move = async (request?: never) => {
        const { level: requested } = (request ?? {}) as { level?: unknown };
        await write(type, Math.round((number(requested, 0, 254) * 100) / 254));
      };
      const absoluteOnly = async () => {
        throw new Error('Only absolute level commands are supported');
      };
      m.commands.levelControl = {
        move: absoluteOnly,
        step: absoluteOnly,
        stop: absoluteOnly,
        moveToLevel: move,
        moveToLevelWithOnOff: async (request?: never) => {
          await move(request);
          // Brightness already writes the multilevel target. A second On write sends
          // Z-Wave Restore Previous (255) and can overwrite the requested brightness.
          if (type === C.RotationSpeed) {
            await write(C.On, (request as unknown as { level: number }).level > 0);
          }
        },
      };
    };
    if (is('WindowCovering')) {
      m.deviceType = 'WindowCovering';
      m.clusters.windowCovering = {
        type: 0,
        endProductType: 0,
        configStatus: { operational: true, online: true, liftPositionAware: true },
      };
      field(C.CurrentPosition, 'windowCovering', 'currentPositionLiftPercent100ths', (v) =>
        numeric(v, homeKitPositionToMatterLift),
      );
      field(C.TargetPosition, 'windowCovering', 'targetPositionLiftPercent100ths', (v) =>
        numeric(v, homeKitPositionToMatterLift),
      );
      m.commands.windowCovering = {
        upOrOpen: async () => write(C.TargetPosition, 100),
        downOrClose: async () => write(C.TargetPosition, 0),
        stopMotion: async () => write(C.HoldPosition, true),
        goToLiftPercentage: async (request?: never) => {
          const { liftPercent100thsValue } = (request ?? {}) as {
            liftPercent100thsValue?: unknown;
          };
          await write(
            C.TargetPosition,
            matterLiftToHomeKitPosition(number(liftPercent100thsValue, 0, 10000)),
          );
        },
      };
    } else if (is('Switch') || is('Outlet')) {
      // OnOffSwitch is a Matter controller/client device, not a controllable actuator.
      m.deviceType = 'OnOffOutlet';
      onOff();
    } else if (is('Lightbulb')) {
      m.deviceType =
        has(C.Hue) && has(C.Saturation)
          ? 'ExtendedColorLight'
          : has(C.Brightness)
            ? 'DimmableLight'
            : 'OnOffLight';
      onOff();
      if (has(C.Brightness)) level(C.Brightness);
      if (has(C.Hue) && has(C.Saturation)) {
        m.clusters.colorControl = { colorMode: 0, enhancedColorMode: 0 };
        field(C.Hue, 'colorControl', 'currentHue', (v) =>
          numeric(v, (n) => Math.round((n * 254) / 360)),
        );
        field(C.Saturation, 'colorControl', 'currentSaturation', (v) =>
          numeric(v, (n) => Math.round((n * 254) / 100)),
        );
        m.commands.colorControl = {
          moveToHueAndSaturationLogic: async (request?: never) => {
            const r = (request ?? {}) as { hue?: unknown; saturation?: unknown };
            const hue = number(r.hue, 0, 254);
            const saturation = number(r.saturation, 0, 254);
            await write(C.Hue, (hue * 360) / 254);
            await write(C.Saturation, (saturation * 100) / 254);
          },
          moveToHueLogic: async (request?: never) => {
            const r = (request ?? {}) as { targetHue?: unknown; isEnhancedHue?: boolean };
            await write(
              C.Hue,
              (number(r.targetHue, 0, r.isEnhancedHue ? 65535 : 254) * 360) /
                (r.isEnhancedHue ? 65535 : 254),
            );
          },
          moveToSaturationLogic: async (request?: never) => {
            await write(
              C.Saturation,
              (number(
                ((request ?? {}) as { targetSaturation?: unknown }).targetSaturation,
                0,
                254,
              ) *
                100) /
                254,
            );
          },
        };
      }
    } else if (is('Fan')) {
      // Sirens use HomeKit Fan for their volume slider. Keep On/Off and volume in Matter.
      m.deviceType = has(C.RotationSpeed) ? 'DimmableOutlet' : 'OnOffOutlet';
      onOff();
      if (has(C.RotationSpeed)) level(C.RotationSpeed);
    } else if (is('LockMechanism')) {
      m.deviceType = 'DoorLock';
      m.clusters.doorLock = {
        lockType: 0,
        actuatorEnabled: true,
        operatingMode: 0,
        supportedOperatingModes: { normal: true },
      };
      field(C.LockCurrentState, 'doorLock', 'lockState', (v) =>
        v === 1 ? 1 : v === 0 ? 2 : v === 2 ? 0 : null,
      );
      m.commands.doorLock = {
        lockDoor: async () => write(C.LockTargetState, 1),
        unlockDoor: async () => write(C.LockTargetState, 0),
      };
    } else if (is('MotionSensor')) {
      m.deviceType = 'MotionSensor';
      field(C.MotionDetected, 'occupancySensing', 'occupancy', (v) => ({ occupied: !!v }));
    } else if (is('ContactSensor') || is('LeakSensor')) {
      m.deviceType = is('ContactSensor') ? 'ContactSensor' : 'LeakSensor';
      // Matter contact true means closed; HAP CONTACT_DETECTED is 0.
      field(
        is('ContactSensor') ? C.ContactSensorState : C.LeakDetected,
        'booleanState',
        'stateValue',
        (v) => (is('ContactSensor') ? v === 0 : v === 1),
      );
    } else if (is('SmokeSensor') || is('CarbonMonoxideSensor')) {
      m.deviceType = 'SmokeSensor';
      const smoke = is('SmokeSensor');
      bind(smoke ? C.SmokeDetected : C.CarbonMonoxideDetected, 'smokeCoAlarm', (v) => ({
        [smoke ? 'smokeState' : 'coState']: v === 1 ? 1 : 0,
        expressedState: v === 1 ? (smoke ? 1 : 2) : 0,
      }));
    } else if (is('CarbonDioxideSensor')) {
      m.deviceType = 'AirQualitySensor';
      field(C.CarbonDioxideDetected, 'airQuality', 'airQuality', (v) =>
        v === 0 ? 1 : v === 1 ? 4 : 0,
      );
      if (has(C.CarbonDioxideLevel)) {
        m.composition = { CarbonDioxideConcentrationMeasurementServer: ['NumericMeasurement'] };
        m.clusters.carbonDioxideConcentrationMeasurement = {
          measurementMedium: 0,
          measurementUnit: 0,
          minMeasuredValue: 0,
          maxMeasuredValue: null,
        };
        measurement(
          C.CarbonDioxideLevel,
          'carbonDioxideConcentrationMeasurement',
          'Carbon dioxide (CO2) level',
        );
      }
    } else if (is('TemperatureSensor') || is('HumiditySensor') || is('LightSensor')) {
      const defined = accessory.node.getDefinedValueIDs?.() ?? [];
      const sensors = defined.filter(
        (v) =>
          v.commandClass === CommandClasses['Multilevel Sensor'] &&
          (v.endpoint ?? 0) === Number(service.subtype ?? 0),
      );
      if (
        is('LightSensor') &&
        sensors.some((v) => v.property === 'Ultraviolet') &&
        !sensors.some((v) => v.property === 'Illuminance')
      )
        continue;
      const temp = is('TemperatureSensor'),
        humidity = is('HumiditySensor');
      m.deviceType = temp ? 'TemperatureSensor' : humidity ? 'HumiditySensor' : 'LightSensor';
      const cluster = temp
        ? 'temperatureMeasurement'
        : humidity
          ? 'relativeHumidityMeasurement'
          : 'illuminanceMeasurement';
      m.clusters[cluster] = {
        minMeasuredValue: temp ? -27315 : humidity ? 0 : 1,
        maxMeasuredValue: temp ? 32767 : humidity ? 10000 : 65534,
      };
      field(
        temp
          ? C.CurrentTemperature
          : humidity
            ? C.CurrentRelativeHumidity
            : C.CurrentAmbientLightLevel,
        cluster,
        'measuredValue',
        (v) =>
          numeric(v, (n) =>
            temp || humidity
              ? Math.round(n * 100)
              : n <= 0
                ? 0
                : Math.min(65534, Math.max(1, Math.round(10000 * Math.log10(n) + 1))),
          ),
      );
    } else if (is('AirQualitySensor')) {
      m.deviceType = 'AirQualitySensor';
      m.composition = {};
      // The host restores base AirQuality types before the plugin can reclaim them.
      // Optional enum grades fail that restore; retain the core categories and raw readings.
      field(C.AirQuality, 'airQuality', 'airQuality', (v) =>
        v === 1 || v === 2 ? 1 : v === 3 || v === 4 || v === 5 ? 4 : 0,
      );
      for (const [characteristic, cluster, requirement] of [
        [
          C.VOCDensity,
          'totalVolatileOrganicCompoundsConcentrationMeasurement',
          'TotalVolatileOrganicCompoundsConcentrationMeasurementServer',
        ],
        [C.PM2_5Density, 'pm25ConcentrationMeasurement', 'Pm25ConcentrationMeasurementServer'],
      ] as const) {
        if (!has(characteristic)) continue;
        m.composition[requirement] = ['NumericMeasurement'];
        m.clusters[cluster] = {
          measurementMedium: 0,
          measurementUnit: 4,
          minMeasuredValue: 0,
          maxMeasuredValue: null,
        };
        measurement(
          characteristic,
          cluster,
          characteristic === C.VOCDensity
            ? 'Volatile Organic Compound level'
            : 'Particulate Matter 2.5',
        );
      }
    } else if (is('StatelessProgrammableSwitch')) {
      m.deviceType = 'GenericSwitch';
      m.clusters.switch = { numberOfPositions: 2, currentPosition: 0, multiPressMax: 2 };
      m.bindings.push({
        characteristic: C.ProgrammableSwitchEvent,
        cluster: 'switch',
        attributes: () => ({}),
        event: true,
      });
    } else if (is('GarageDoorOpener')) {
      m.deviceType = 'Closure';
      bind(C.CurrentDoorState, 'closureControl', (v) => ({
        mainState: v === 2 || v === 3 ? 1 : 0,
        overallCurrentState: { position: v === 0 ? 1 : v === 1 ? 0 : 2 },
      }));
      field(C.TargetDoorState, 'closureControl', 'overallTargetState', (v) => ({
        position: v === 0 ? 1 : 0,
      }));
      m.commands.closureControl = {
        moveTo: async (request?: never) => {
          const r = (request ?? {}) as { position?: unknown; latch?: unknown; speed?: unknown };
          /**
           * Closure Control requires a server to ignore the optional fields it does not
           * implement rather than refuse the command, and the specification uses a
           * position-only server receiving position and speed as its example. Latch and speed
           * are therefore dropped, not rejected: a controller that sends them is asking for a
           * position this door can reach, and refusing it leaves the door shut.
           */
          if (r.position !== 0 && r.position !== 1) {
            throw new Error('This garage door supports only fully open and fully closed commands');
          }
          await write(C.TargetDoorState, r.position === 1 ? 0 : 1);
        },
        // Barrier Operator has no portable stop operation.
        stop: async () => {
          throw new Error('This garage door does not support stop');
        },
      };
    } else if (is('Thermostat')) {
      m.deviceType = 'Thermostat';
      const endpoint = Number(service.subtype ?? 0);
      const values = accessory.node.getDefinedValueIDs?.() ?? [];
      const setpoints = values.filter(
        (v) =>
          v.commandClass === CommandClasses['Thermostat Setpoint'] &&
          (v.endpoint ?? 0) === endpoint &&
          v.property === 'setpoint',
      );
      const heat = setpoints.some((v) => v.propertyKey === 1);
      const cool = setpoints.some((v) => v.propertyKey === 2);
      if (!heat && !cool) continue;
      m.clusters.thermostat = { controlSequenceOfOperation: heat && cool ? 4 : cool ? 0 : 2 };
      field(C.CurrentTemperature, 'thermostat', 'localTemperature', (v) =>
        numeric(v, (n) => Math.round(n * 100)),
      );
      field(
        C.TargetHeatingCoolingState,
        'thermostat',
        'systemMode',
        (v) => [0, 4, 3, 1][Number(v)] ?? 0,
      );
      if (heat)
        field(C.HeatingThresholdTemperature, 'thermostat', 'occupiedHeatingSetpoint', (v) =>
          numeric(v, (n) => Math.round(n * 100)),
        );
      if (cool)
        field(C.CoolingThresholdTemperature, 'thermostat', 'occupiedCoolingSetpoint', (v) =>
          numeric(v, (n) => Math.round(n * 100)),
        );
      bind(C.TargetTemperature, 'thermostat', (v) => {
        const mode = service.getCharacteristic(C.TargetHeatingCoolingState).value;
        const attribute =
          mode === 1 && heat
            ? 'occupiedHeatingSetpoint'
            : mode === 2 && cool
              ? 'occupiedCoolingSetpoint'
              : undefined;
        return attribute ? { [attribute]: numeric(v, (n) => Math.round(n * 100)) } : {};
      });
      m.commands.thermostat = {
        setpointRaiseLower: async () => {
          throw new Error('Use an absolute thermostat setpoint');
        },
        systemModeChange: async (request?: never) => {
          const mode = ((request ?? {}) as { systemMode?: unknown }).systemMode;
          const hap =
            mode === 0
              ? 0
              : mode === 4 && heat
                ? 1
                : mode === 3 && cool
                  ? 2
                  : mode === 1 && heat && cool
                    ? 3
                    : undefined;
          if (hap === undefined) throw new Error('Unsupported thermostat mode');
          await write(C.TargetHeatingCoolingState, hap);
        },
        ...(heat
          ? {
              occupiedHeatingSetpointChange: async (request?: never) =>
                write(
                  C.HeatingThresholdTemperature,
                  number(
                    ((request ?? {}) as { occupiedHeatingSetpoint?: unknown })
                      .occupiedHeatingSetpoint,
                    0,
                    10000,
                  ) / 100,
                ),
            }
          : {}),
        ...(cool
          ? {
              occupiedCoolingSetpointChange: async (request?: never) =>
                write(
                  C.CoolingThresholdTemperature,
                  number(
                    ((request ?? {}) as { occupiedCoolingSetpoint?: unknown })
                      .occupiedCoolingSetpoint,
                    0,
                    10000,
                  ) / 100,
                ),
            }
          : {}),
      };
    }
    if (m.deviceType) result.push(m);
  }
  if (result.length === 0) {
    const battery = accessory.platformAccessory.services.find(
      (service) => service.UUID === S.Battery?.UUID,
    );
    if (battery)
      result.push({
        key: `${battery.UUID}-${battery.subtype ?? 'root'}`,
        service: battery,
        deviceType: 'BridgedNode',
        clusters: {},
        bindings: [],
        commands: {},
      });
  }
  // CO2 and air-quality HAP services at the same Z-Wave endpoint describe one sensor.
  // Keep the existing air-quality endpoint identity and bind each measurement to its source.
  for (const co2 of [...result].filter((m) => m.service.UUID === S.CarbonDioxideSensor?.UUID)) {
    const air = result.find(
      (m) =>
        m !== co2 &&
        m.service.UUID === S.AirQualitySensor?.UUID &&
        m.service.subtype === co2.service.subtype,
    );
    if (!air) continue;
    const measurements = co2.bindings.filter((binding) => binding.cluster !== 'airQuality');
    air.bindings.push(...measurements.map((binding) => ({ ...binding, service: co2.service })));
    Object.assign((air.composition ??= {}), co2.composition);
    Object.assign(air.clusters, co2.clusters);
    result.splice(result.indexOf(co2), 1);
  }
  // Preserve the covering root shape while keeping every other service in stable parts.
  return result.sort(
    (a, b) =>
      Number(b.deviceType === 'WindowCovering') - Number(a.deviceType === 'WindowCovering') ||
      a.key.localeCompare(b.key),
  );
}
