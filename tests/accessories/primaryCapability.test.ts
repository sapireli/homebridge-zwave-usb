import { CommandClasses } from '@zwave-js/core';
import { AccessoryFactory, PRIMARY_CAPABILITY, PRIMARY_KINDS } from '../../src/accessories/AccessoryFactory';
import { IZWaveNode } from '../../src/zwave/interfaces';

/**
 * Whether a feature could drive a working primary service on an endpoint, judged by the values
 * the device defines rather than the command classes it advertises. A device can advertise a
 * command class and define none of the values the feature reads from it, and publishing that
 * would give someone a control that does nothing.
 */
describe('primary capability', () => {
  type Value = {
    commandClass: number;
    property: string;
    propertyKey?: string | number;
    endpoint?: number;
  };

  const node = (
    supported: CommandClasses[],
    values: Value[],
    metadata?: Record<string, unknown>,
  ): IZWaveNode => {
    const codes = new Set<number>(supported);
    return {
      nodeId: 7,
      ready: true,
      getAllEndpoints: () => [{ index: 0, supportsCC: (c: number) => codes.has(c) }],
      getDefinedValueIDs: () => values.map((v) => ({ endpoint: 0, ...v })),
      getValueMetadata: () => metadata,
      getValue: () => undefined,
    } as unknown as IZWaveNode;
  };

  const v = (commandClass: CommandClasses, property: string, propertyKey?: string | number) =>
    ({ commandClass, property, propertyKey }) as Value;

  const can = (kind: string, n: IZWaveNode) =>
    PRIMARY_CAPABILITY[kind as never](n, n.getAllEndpoints()[0] as never);

  const CC = CommandClasses;

  it('has a predicate for every primary kind and nothing else', () => {
    expect(Object.keys(PRIMARY_CAPABILITY).sort()).toEqual([...PRIMARY_KINDS].sort());
  });

  it('judges the endpoint it was asked about and not the node as a whole', () => {
    const onEndpointOne = node(
      [CC['Binary Switch']],
      [
        { commandClass: CC['Binary Switch'], property: 'currentValue', endpoint: 1 },
        { commandClass: CC['Binary Switch'], property: 'targetValue', endpoint: 1 },
      ],
    );

    expect(can('binary-switch', onEndpointOne)).toBe(false);
  });

  describe('switches and lights', () => {
    it('accepts a binary switch with both values and rejects one missing either', () => {
      expect(can('binary-switch', node([CC['Binary Switch']], [v(CC['Binary Switch'], 'currentValue'), v(CC['Binary Switch'], 'targetValue')]))).toBe(true);
      expect(can('binary-switch', node([CC['Binary Switch']], [v(CC['Binary Switch'], 'currentValue')]))).toBe(false);
      expect(can('binary-switch', node([CC['Binary Switch']], [v(CC['Binary Switch'], 'targetValue')]))).toBe(false);
    });

    it('accepts a dimmer with both values and rejects one that only reports or only accepts', () => {
      expect(can('multilevel-switch', node([CC['Multilevel Switch']], [v(CC['Multilevel Switch'], 'currentValue'), v(CC['Multilevel Switch'], 'targetValue')]))).toBe(true);
      expect(can('multilevel-switch', node([CC['Multilevel Switch']], [v(CC['Multilevel Switch'], 'currentValue')]))).toBe(false);
      expect(can('multilevel-switch', node([CC['Multilevel Switch']], [v(CC['Multilevel Switch'], 'targetValue')]))).toBe(false);
    });

    it('rejects colour without the switch values it needs to turn the light on', () => {
      const colourOnly = [v(CC['Color Switch'], 'currentColor'), v(CC['Color Switch'], 'targetColor')];
      expect(can('color-switch', node([CC['Color Switch']], colourOnly))).toBe(false);
      expect(
        can('color-switch', node([CC['Color Switch'], CC['Multilevel Switch']], [
          ...colourOnly,
          v(CC['Multilevel Switch'], 'currentValue'),
          v(CC['Multilevel Switch'], 'targetValue'),
        ])),
      ).toBe(true);
      expect(
        can('color-switch', node([CC['Color Switch'], CC['Multilevel Switch']], [
          v(CC['Color Switch'], 'currentColor'),
          v(CC['Multilevel Switch'], 'currentValue'),
          v(CC['Multilevel Switch'], 'targetValue'),
        ])),
      ).toBe(false);
      expect(
        can('color-switch', node([CC['Color Switch'], CC['Multilevel Switch']], [
          v(CC['Color Switch'], 'targetColor'),
          v(CC['Multilevel Switch'], 'currentValue'),
          v(CC['Multilevel Switch'], 'targetValue'),
        ])),
      ).toBe(false);
    });
  });

  describe('coverings', () => {
    const KEYED = 13;
    const wcComplete = [
      v(CC['Window Covering'], 'currentValue', KEYED),
      v(CC['Window Covering'], 'targetValue', KEYED),
    ];
    const mlsComplete = [
      v(CC['Multilevel Switch'], 'currentValue'),
      v(CC['Multilevel Switch'], 'targetValue'),
    ];

    it('accepts a keyed Window Covering device', () => {
      expect(can('window-covering', node([CC['Window Covering']], wcComplete))).toBe(true);
    });

    it('accepts a Multilevel-Switch-only covering, the path the RSZ1 shades take', () => {
      expect(can('window-covering', node([CC['Multilevel Switch']], mlsComplete))).toBe(true);
      expect(can('window-covering', node([CC['Multilevel Switch']], [v(CC['Multilevel Switch'], 'currentValue')]))).toBe(false);
    });

    it('rejects a Window Covering device whose Multilevel Switch values would shadow it', () => {
      /**
       * The reason this is not compatible is easy to misread. The position can be read through
       * the Multilevel Switch fallback, so the device looks serviceable. It is not: the command
       * class used to move it comes from `supportsCC`, so a Window Covering `targetValue` is
       * built and the write is refused outright when no keyed Window Covering position exists.
       * Such a covering reports a position and declines every command to move it.
       */
      expect(
        can('window-covering', node([CC['Window Covering'], CC['Multilevel Switch']], mlsComplete)),
      ).toBe(false);
    });

    it('rejects a keyed position whose target is keyed differently', () => {
      expect(
        can('window-covering', node([CC['Window Covering']], [
          v(CC['Window Covering'], 'currentValue', KEYED),
          v(CC['Window Covering'], 'targetValue', 99),
        ])),
      ).toBe(false);
    });

    it('rejects an unkeyed Window Covering position', () => {
      expect(
        can('window-covering', node([CC['Window Covering']], [
          v(CC['Window Covering'], 'currentValue'),
          v(CC['Window Covering'], 'targetValue'),
        ])),
      ).toBe(false);
    });
  });

  describe('locks, sirens and thermostats', () => {
    it('rejects a Door Lock device that would fall back to the older Lock value', () => {
      expect(
        can('lock', node([CC['Door Lock'], CC.Lock], [v(CC.Lock, 'locked')])),
      ).toBe(false);
      expect(can('lock', node([CC.Lock], [v(CC.Lock, 'locked')]))).toBe(true);
      expect(
        can('lock', node([CC['Door Lock']], [v(CC['Door Lock'], 'currentMode'), v(CC['Door Lock'], 'targetMode')])),
      ).toBe(true);
      expect(can('lock', node([CC['Door Lock']], [v(CC['Door Lock'], 'currentMode')]))).toBe(false);
      expect(can('lock', node([CC['Door Lock']], [v(CC['Door Lock'], 'targetMode')]))).toBe(false);
    });

    it('accepts a siren driven as a plain switch, and rejects one missing its volume', () => {
      expect(
        can('siren', node([CC['Binary Switch']], [v(CC['Binary Switch'], 'currentValue'), v(CC['Binary Switch'], 'targetValue')])),
      ).toBe(true);
      expect(can('siren', node([CC['Sound Switch']], [v(CC['Sound Switch'], 'toneId')]))).toBe(false);
      expect(
        can('siren', node([CC['Sound Switch']], [v(CC['Sound Switch'], 'toneId'), v(CC['Sound Switch'], 'defaultVolume')])),
      ).toBe(true);
      expect(can('siren', node([CC['Binary Switch']], [v(CC['Binary Switch'], 'currentValue')]))).toBe(false);
      expect(can('siren', node([CC['Binary Switch']], [v(CC['Binary Switch'], 'targetValue')]))).toBe(false);
    });

    it('rejects a Sound Switch siren that would fall back to its Binary Switch values', () => {
      expect(
        can('siren', node([CC['Sound Switch'], CC['Binary Switch']], [
          v(CC['Binary Switch'], 'currentValue'),
          v(CC['Binary Switch'], 'targetValue'),
        ])),
      ).toBe(false);
    });

    it('requires both setpoints and a temperature', () => {
      const complete = [
        v(CC['Thermostat Mode'], 'mode'),
        v(CC['Thermostat Setpoint'], 'setpoint', 1),
        v(CC['Thermostat Setpoint'], 'setpoint', 2),
        v(CC['Multilevel Sensor'], 'Air temperature'),
      ];
      expect(can('thermostat', node([CC['Thermostat Mode']], complete))).toBe(true);
      // Heating only: Auto reads and writes both thresholds.
      expect(can('thermostat', node([CC['Thermostat Mode']], complete.filter((x) => x.propertyKey !== 2)))).toBe(false);
      // Cooling only, the mirror of the case above.
      expect(can('thermostat', node([CC['Thermostat Mode']], complete.filter((x) => x.propertyKey !== 1)))).toBe(false);
      expect(can('thermostat', node([CC['Thermostat Mode']], complete.filter((x) => x.property !== 'Air temperature')))).toBe(false);
      expect(can('thermostat', node([CC['Thermostat Mode']], complete.filter((x) => x.property !== 'mode')))).toBe(false);
    });
  });

  describe('garage doors', () => {
    it('accepts a barrier with both values and rejects one missing either', () => {
      expect(can('garage-door', node([CC['Barrier Operator']], [v(CC['Barrier Operator'], 'currentState'), v(CC['Barrier Operator'], 'targetState')]))).toBe(true);
      expect(can('garage-door', node([CC['Barrier Operator']], [v(CC['Barrier Operator'], 'currentState')]))).toBe(false);
      expect(can('garage-door', node([CC['Barrier Operator']], [v(CC['Barrier Operator'], 'targetState')]))).toBe(false);
    });
  });

  describe('sensors', () => {
    it('accepts either source and rejects a sensor of a different kind', () => {
      expect(can('leak-sensor', node([CC.Notification], [v(CC.Notification, 'Water Alarm', 'Water leak status')]))).toBe(true);
      expect(can('leak-sensor', node([CC['Binary Sensor']], [v(CC['Binary Sensor'], 'Water')]))).toBe(true);
      // A motion-only binary sensor is not a contact sensor.
      expect(can('contact-sensor', node([CC['Binary Sensor']], [v(CC['Binary Sensor'], 'Motion')]))).toBe(false);
      expect(can('motion-sensor', node([CC['Binary Sensor']], [v(CC['Binary Sensor'], 'Motion')]))).toBe(true);
    });

    it('accepts an alarm reported without a sub-status', () => {
      expect(can('smoke-sensor', node([CC.Notification], [v(CC.Notification, 'Smoke Alarm')]))).toBe(true);
      expect(can('carbon-monoxide-sensor', node([CC.Notification], [v(CC.Notification, 'Carbon Monoxide Alarm')]))).toBe(true);
    });

    it('accepts a door reported under either notification and rejects one reported without a state', () => {
      expect(can('contact-sensor', node([CC.Notification], [v(CC.Notification, 'Access Control', 'Window/door state')]))).toBe(true);
      expect(can('contact-sensor', node([CC.Notification], [v(CC.Notification, 'Home Security', 'Sensor status')]))).toBe(true);
      // Access Control carries locks and barriers as well as doors, so a report that names no
      // sub-status does not say a door moved. The alarms accept one, having nothing else to carry.
      expect(can('contact-sensor', node([CC.Notification], [v(CC.Notification, 'Access Control')]))).toBe(false);
    });

    // Each of these advertises Binary Sensor and reports a neighbouring type, which is the shape
    // detection publishes as a contact sensor. See classificationDrift.
    it('rejects a freeze sensor as a leak sensor', () => {
      expect(can('leak-sensor', node([CC['Binary Sensor']], [v(CC['Binary Sensor'], 'Freeze')]))).toBe(false);
    });

    it('rejects a tamper-only sensor as a motion sensor', () => {
      expect(can('motion-sensor', node([CC['Binary Sensor']], [v(CC['Binary Sensor'], 'Tamper')]))).toBe(false);
    });

    it('rejects a heat alarm as a smoke sensor', () => {
      expect(can('smoke-sensor', node([CC['Binary Sensor']], [v(CC['Binary Sensor'], 'Heat')]))).toBe(false);
    });

    it('rejects a CO2 sensor as a carbon monoxide sensor', () => {
      expect(can('carbon-monoxide-sensor', node([CC['Binary Sensor']], [v(CC['Binary Sensor'], 'CO2')]))).toBe(false);
    });

    it('rejects a binary CO2 value as a multilevel sensor', () => {
      // Detection maps it to this kind, but the feature builds services only from Multilevel
      // Sensor types, so such a device would get the feature and no service at all.
      expect(can('multilevel-sensor', node([CC['Binary Sensor']], [v(CC['Binary Sensor'], 'CO2')]))).toBe(false);
      expect(can('multilevel-sensor', node([CC['Multilevel Sensor']], [v(CC['Multilevel Sensor'], 'Humidity')]))).toBe(true);
    });
  });

  describe('central scene', () => {
    const both = [v(CC['Central Scene'], 'scene'), v(CC['Central Scene'], 'keyAttribute')];

    it('needs both values and at least one numbered scene', () => {
      expect(can('central-scene', node([CC['Central Scene']], both, { states: { 1: 'Scene 1' } }))).toBe(true);
      expect(can('central-scene', node([CC['Central Scene']], [both[0]], { states: { 1: 'Scene 1' } }))).toBe(false);
      expect(can('central-scene', node([CC['Central Scene']], [both[1]], { states: { 1: 'Scene 1' } }))).toBe(false);
      expect(can('central-scene', node([CC['Central Scene']], both, {}))).toBe(false);
      expect(can('central-scene', node([CC['Central Scene']], both, { states: {} }))).toBe(false);
    });
  });

  describe('what a Multilevel-Switch-only device is offered', () => {
    const rsz1Like = node([CC['Multilevel Switch']], [
      v(CC['Multilevel Switch'], 'currentValue'),
      v(CC['Multilevel Switch'], 'targetValue'),
    ]);

    it('offers exactly the two types it can drive', () => {
      expect(AccessoryFactory.compatiblePrimaryKinds(rsz1Like)).toEqual([
        'window-covering',
        'multilevel-switch',
      ]);
    });

    it('offers nothing it cannot drive', () => {
      for (const kind of ['lock', 'thermostat', 'garage-door', 'binary-switch', 'siren', 'motion-sensor', 'contact-sensor', 'leak-sensor', 'smoke-sensor', 'carbon-monoxide-sensor', 'multilevel-sensor', 'central-scene', 'color-switch']) {
        expect(`${kind}:${can(kind, rsz1Like)}`).toBe(`${kind}:false`);
      }
    });
  });

  it('offers nothing for a node with more than one endpoint', () => {
    const multi = {
      nodeId: 7,
      ready: true,
      getAllEndpoints: () => [
        { index: 0, supportsCC: () => true },
        { index: 1, supportsCC: () => true },
      ],
      getDefinedValueIDs: () => [],
      getValueMetadata: () => undefined,
      getValue: () => undefined,
    } as unknown as IZWaveNode;

    expect(AccessoryFactory.compatiblePrimaryKinds(multi)).toEqual([]);
  });
});
