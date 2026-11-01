import { CommandClasses } from '@zwave-js/core';
import {
  AccessoryFactory,
  PRIMARY_KINDS,
  PrimaryKind,
  isPrimaryKind,
} from '../../src/accessories/AccessoryFactory';
import { IZWaveNode } from '../../src/zwave/interfaces';

/**
 * The planner decides what a device publishes and which of those kinds stands as its primary
 * type. Detection itself is untouched by item 13: these tests pin the split, the primary rule
 * and what an override does to an already-planned list.
 */
describe('AccessoryFactory feature planner', () => {
  const cc = (name: keyof typeof CommandClasses | string) =>
    (CommandClasses as unknown as Record<string, number>)[name as string];

  /** A single-endpoint node supporting exactly the named command classes. */
  const nodeWith = (
    supported: string[],
    values: Array<Record<string, unknown>> = [],
    metadata: Record<string, unknown> | undefined = undefined,
  ): IZWaveNode => {
    const codes = new Set(supported.map((name) => cc(name)));
    const endpoint = { index: 0, supportsCC: (code: number) => codes.has(code) };

    return {
      nodeId: 7,
      ready: true,
      getAllEndpoints: () => [endpoint],
      getDefinedValueIDs: () => values,
      getValueMetadata: () => metadata,
      getValue: () => undefined,
    } as unknown as IZWaveNode;
  };

  const kindsOf = (node: IZWaveNode, primaryOverride?: PrimaryKind) =>
    AccessoryFactory.planFeatures(node, { primaryOverride })[0].effectiveKinds;

  const planOf = (node: IZWaveNode) => AccessoryFactory.planFeatures(node)[0];

  it('names every primary kind exactly once, and excludes the two that cannot be primary', () => {
    expect(new Set(PRIMARY_KINDS).size).toBe(PRIMARY_KINDS.length);
    expect(PRIMARY_KINDS).toHaveLength(15);
    expect(isPrimaryKind('battery')).toBe(false);
    expect(isPrimaryKind('multilevel-sensor-skip-temperature')).toBe(false);
  });

  it('chooses the primary by its own order, not by the order the kinds were planned', () => {
    /**
     * A device reporting both a multilevel sensor and motion plans the sensor first, but it is
     * a motion sensor that also reads temperature, not a thermometer that notices movement.
     */
    const node = nodeWith(
      ['Multilevel Sensor', 'Binary Sensor', 'Battery'],
      [{ commandClass: cc('Binary Sensor'), endpoint: 0, property: 'Any' }],
    );
    const plan = planOf(node);

    expect(plan.effectiveKinds).toEqual(['multilevel-sensor', 'contact-sensor', 'battery']);
    expect(plan.primaryKind).toBe('contact-sensor');
  });

  it('leaves an endpoint with nothing but a battery without a primary', () => {
    const plan = planOf(nodeWith(['Battery']));

    expect(plan.effectiveKinds).toEqual(['battery']);
    expect(plan.primaryKind).toBeUndefined();
    expect(plan.primaryGroup).toEqual([]);
  });

  it('groups colour with brightness, because they share one service', () => {
    const plan = planOf(nodeWith(['Color Switch', 'Multilevel Switch']));

    expect(plan.effectiveKinds).toEqual(['color-switch', 'multilevel-switch']);
    expect(plan.primaryKind).toBe('color-switch');
    expect(plan.primaryGroup).toEqual(['color-switch', 'multilevel-switch']);
  });

  describe('applying an override', () => {
    it('replaces a dimmer with a covering and keeps the battery where it was', () => {
      const node = nodeWith(['Multilevel Switch', 'Battery']);

      expect(kindsOf(node)).toEqual(['multilevel-switch', 'battery']);
      expect(kindsOf(node, 'window-covering')).toEqual(['window-covering', 'battery']);
    });

    it('takes brightness away with the colour control it shares a service with', () => {
      const node = nodeWith(['Color Switch', 'Multilevel Switch', 'Binary Switch']);

      expect(kindsOf(node, 'binary-switch')).toEqual(['binary-switch']);
    });

    it("hands back a thermostat's suppressed temperature as an ordinary sensor", () => {
      const node = nodeWith(['Thermostat Mode', 'Multilevel Sensor', 'Binary Switch']);

      expect(kindsOf(node)).toEqual(['thermostat', 'multilevel-sensor-skip-temperature']);
      expect(kindsOf(node, 'binary-switch')).toEqual(['binary-switch', 'multilevel-sensor']);
    });

    it('keeps a sensor it did not replace, in its original position', () => {
      const node = nodeWith(
        ['Multilevel Sensor', 'Binary Sensor', 'Battery'],
        [{ commandClass: cc('Binary Sensor'), endpoint: 0, property: 'Motion' }],
      );

      expect(kindsOf(node)).toEqual(['multilevel-sensor', 'contact-sensor', 'battery']);
      expect(kindsOf(node, 'leak-sensor')).toEqual([
        'multilevel-sensor',
        'leak-sensor',
        'battery',
      ]);
    });

    it('builds no service twice when the override already appears later', () => {
      const node = nodeWith(
        ['Binary Switch', 'Binary Sensor'],
        [{ commandClass: cc('Binary Sensor'), endpoint: 0, property: 'Any' }],
      );

      expect(kindsOf(node)).toEqual(['binary-switch', 'contact-sensor']);
      expect(kindsOf(node, 'contact-sensor')).toEqual(['contact-sensor']);
    });

    it('changes nothing for an endpoint that has no primary to replace', () => {
      const node = nodeWith(['Battery']);

      expect(kindsOf(node, 'window-covering')).toEqual(['battery']);
    });

    it('changes nothing when the override is the type already planned', () => {
      const node = nodeWith(['Multilevel Switch', 'Battery']);

      expect(kindsOf(node, 'multilevel-switch')).toEqual(['multilevel-switch', 'battery']);
    });
  });

  it('builds from the same reading the signature was taken from', () => {
    /**
     * A node that is still interviewing answers differently as it goes. The platform takes the
     * signature to decide whether to rebuild, then builds; if those were two readings, an
     * accessory could be built from the second and labelled with the first, so its stored
     * signature would describe services it does not have and the next comparison would rebuild
     * it again. This node changes after every reading, so any second read shows up.
     */
    let reads = 0;
    const statefulNode = {
      nodeId: 7,
      ready: true,
      getAllEndpoints: () => {
        reads += 1;
        // After the first reading the device also reports a battery.
        const codes = new Set<number>([cc('Multilevel Switch')]);
        if (reads > 1) {
          codes.add(cc('Battery'));
        }
        return [{ index: 0, supportsCC: (code: number) => codes.has(code) }];
      },
      getDefinedValueIDs: () => [],
      getValueMetadata: () => undefined,
      getValue: () => undefined,
    } as unknown as IZWaveNode;

    const plans = AccessoryFactory.planFeatures(statefulNode);
    const signature = AccessoryFactory.signatureOfPlans(plans);

    expect(reads).toBe(1);
    expect(plans[0].effectiveKinds).toEqual(['multilevel-switch']);

    // The same plan object describes the signature and whatever is built from it. Planning
    // again here would report a battery the signature never mentioned.
    expect(AccessoryFactory.signatureOfPlans(plans)).toBe(signature);
    expect(AccessoryFactory.planFeatures(statefulNode)[0].effectiveKinds).toEqual([
      'multilevel-switch',
      'battery',
    ]);
    expect(AccessoryFactory.signatureOfPlans(plans)).toBe(signature);
  });
});
