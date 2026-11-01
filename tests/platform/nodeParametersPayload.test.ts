import { CommandClasses } from '@zwave-js/core';
import { buildNodeParametersPayload } from '../../src/platform/NodeParametersPayload';
import type { IZWaveNode } from '../../src/zwave/interfaces';

/** One configuration value as a device reports it: a whole parameter, or one bitmask field. */
interface Param {
  endpoint?: number;
  parameter: number;
  bitMask?: number;
  value?: number | null;
  reportedAt?: number;
  metadata?: Record<string, unknown>;
}

const key = (endpoint: number, parameter: number, bitMask?: number) =>
  `${endpoint}:${parameter}:${bitMask ?? ''}`;

/**
 * A node that answers the four calls the payload makes, from a list of parameters.
 *
 * The shared device fixtures describe devices by command class and cannot express a parameter, its
 * metadata or when it was last reported, so this builds those directly.
 */
const paramNode = (
  params: Param[],
  over: Partial<IZWaveNode> & { endpointsSupporting?: number[] } = {},
): IZWaveNode => {
  const values = new Map<string, Param>();
  for (const param of params) {
    values.set(key(param.endpoint ?? 0, param.parameter, param.bitMask), param);
  }

  const supporting = over.endpointsSupporting ?? [];

  return {
    nodeId: 10,
    ready: true,
    isListening: true,
    status: 4,
    interviewStage: 7,
    getDefinedValueIDs: () =>
      params.map((param) => ({
        commandClass: CommandClasses.Configuration,
        endpoint: param.endpoint ?? 0,
        property: param.parameter,
        ...(param.bitMask === undefined ? {} : { propertyKey: param.bitMask }),
      })),
    getValue: (valueId) =>
      values.get(key(valueId.endpoint ?? 0, Number(valueId.property), valueId.propertyKey as number))
        ?.value ?? undefined,
    getValueTimestamp: (valueId) =>
      values.get(key(valueId.endpoint ?? 0, Number(valueId.property), valueId.propertyKey as number))
        ?.reportedAt,
    getValueMetadata: (valueId) =>
      (values.get(
        key(valueId.endpoint ?? 0, Number(valueId.property), valueId.propertyKey as number),
      )?.metadata ?? { type: 'number', readable: true, writeable: true }) as never,
    supportsCC: (cc) => cc === CommandClasses.Configuration && supporting.includes(0),
    getAllEndpoints: () =>
      [0, ...supporting].filter((index, at, all) => all.indexOf(index) === at).map((index) => ({
        index,
        supportsCC: (cc: number) => cc === CommandClasses.Configuration && supporting.includes(index),
      })) as never,
    setValue: async () => ({ status: 0 }) as never,
    on: () => undefined as never,
    off: () => undefined as never,
    ...over,
  } as unknown as IZWaveNode;
};

describe('the configuration parameters payload', () => {
  describe('which situation the device is in', () => {
    it('reports an unfinished interview ahead of anything else', () => {
      /**
       * An interview that has not finished has not discovered what the device supports, so a
       * device reporting no support yet is not a device without configuration.
       */
      const node = paramNode([], { ready: false });

      expect(buildNodeParametersPayload(node).state).toBe('interviewing');
    });

    it('reports a device that does not have the command class', () => {
      expect(buildNodeParametersPayload(paramNode([])).state).toBe('unsupported');
    });

    it('reports a device that has it and described nothing', () => {
      const node = paramNode([], { endpointsSupporting: [0] });

      expect(buildNodeParametersPayload(node).state).toBe('none');
    });

    it('finds the command class on an endpoint that is not the root', () => {
      /**
       * `supportsCC` answers for one endpoint and the node is its own root, so a device whose
       * child endpoint carries the parameters reports no support at the root.
       */
      const node = paramNode([], { endpointsSupporting: [2] });

      expect(buildNodeParametersPayload(node).state).toBe('none');
      expect(node.supportsCC(CommandClasses.Configuration)).toBe(false);
    });

    it('takes a reported value as evidence of support whatever the flag says', () => {
      const node = paramNode([{ parameter: 1, value: 3 }]);

      expect(node.supportsCC(CommandClasses.Configuration)).toBe(false);
      expect(buildNodeParametersPayload(node).state).toBe('parameters');
    });
  });

  describe('grouping', () => {
    it('gives one parameter one group, whatever it is called', () => {
      const payload = buildNodeParametersPayload(
        paramNode([{ parameter: 7, value: 2, metadata: { label: 'Report interval' } }]),
      );

      expect(payload.groups).toHaveLength(1);
      expect(payload.groups[0]).toMatchObject({ endpoint: 0, parameter: 7, partial: false });
      expect(payload.groups[0].values).toHaveLength(1);
      expect(payload.groups[0].values[0]).toMatchObject({ value: 2, label: 'Report interval' });
    });

    it('gathers the fields of a shared parameter into that one parameter', () => {
      /**
       * zwave-js addresses bitmask fields with the same property number, so one row per value ID
       * would show one parameter as several, each holding a fragment of it.
       */
      const payload = buildNodeParametersPayload(
        paramNode([
          { parameter: 3, bitMask: 0xf0, value: 2, metadata: { label: 'Upper' } },
          { parameter: 3, bitMask: 0x0f, value: 5, metadata: { label: 'Lower' } },
        ]),
      );

      expect(payload.groups).toHaveLength(1);
      expect(payload.groups[0].partial).toBe(true);
      expect(payload.groups[0].values.map((value) => value.label)).toEqual(['Lower', 'Upper']);
    });

    it('orders fields by bitmask and groups by endpoint then number', () => {
      const payload = buildNodeParametersPayload(
        paramNode([
          { endpoint: 1, parameter: 4, value: 1 },
          { parameter: 9, value: 1 },
          { parameter: 4, bitMask: 0xf0, value: 1 },
          { parameter: 4, bitMask: 0x0f, value: 2 },
        ]),
      );

      expect(payload.groups.map((group) => [group.endpoint, group.parameter])).toEqual([
        [0, 4],
        [0, 9],
        [1, 4],
      ]);
      expect(payload.groups[0].values.map((value) => value.bitMask)).toEqual([0x0f, 0xf0]);
    });

    it('keeps two endpoints using one parameter number apart', () => {
      const payload = buildNodeParametersPayload(
        paramNode([
          { endpoint: 0, parameter: 5, value: 1 },
          { endpoint: 2, parameter: 5, value: 9 },
        ]),
      );

      expect(payload.groups).toHaveLength(2);
      expect(payload.groups.map((group) => [group.endpoint, group.values[0].value])).toEqual([
        [0, 1],
        [2, 9],
      ]);
    });
  });

  describe('the number a parameter holds', () => {
    it('is the value itself for an ordinary parameter', () => {
      const payload = buildNodeParametersPayload(paramNode([{ parameter: 1, value: 42 }]));

      expect(payload.groups[0].raw).toBe(42);
    });

    it('is composed from the fields when they account for every bit', () => {
      // 0x0F holding 5 and 0xF0 holding 2 is 0x25.
      const payload = buildNodeParametersPayload(
        paramNode([
          { parameter: 3, bitMask: 0x0f, value: 5, metadata: { valueSize: 1 } },
          { parameter: 3, bitMask: 0xf0, value: 2, metadata: { valueSize: 1 } },
        ]),
      );

      expect(payload.groups[0].raw).toBe(0x25);
    });

    it('is not stated when the fields leave bits undescribed', () => {
      /**
       * The bits no field describes cannot be known, and composing anyway would invent them.
       */
      const payload = buildNodeParametersPayload(
        paramNode([{ parameter: 3, bitMask: 0x0f, value: 5, metadata: { valueSize: 1 } }]),
      );

      expect(payload.groups[0].raw).toBeNull();
    });

    it('is not stated when the fields disagree about how wide the parameter is', () => {
      const payload = buildNodeParametersPayload(
        paramNode([
          { parameter: 3, bitMask: 0x0f, value: 5, metadata: { valueSize: 1 } },
          { parameter: 3, bitMask: 0xf0, value: 2, metadata: { valueSize: 2 } },
        ]),
      );

      expect(payload.groups[0].raw).toBeNull();
    });

    it('is not stated when the first field does not say how wide the parameter is', () => {
      /**
       * Borrowing a width from a later field would compose a number on the strength of a size
       * the field it belongs to never claimed. The masks here cover a byte, so only the missing
       * width stops it.
       */
      const payload = buildNodeParametersPayload(
        paramNode([
          { parameter: 3, bitMask: 0x0f, value: 5 },
          { parameter: 3, bitMask: 0xf0, value: 2, metadata: { valueSize: 1 } },
        ]),
      );

      expect(payload.groups[0].raw).toBeNull();
    });

    it('is not stated when a field carries a mask of no bits', () => {
      /**
       * The other two masks cover the byte between them, so coverage alone would be satisfied
       * while a field that describes nothing was silently passed over.
       */
      const payload = buildNodeParametersPayload(
        paramNode([
          { parameter: 3, bitMask: 0, value: 1, metadata: { valueSize: 1 } },
          { parameter: 3, bitMask: 0x0f, value: 5, metadata: { valueSize: 1 } },
          { parameter: 3, bitMask: 0xf0, value: 2, metadata: { valueSize: 1 } },
        ]),
      );

      expect(payload.groups[0].raw).toBeNull();
    });

    it('is not stated when two fields claim the same bit', () => {
      // Either order composes a different number, so neither is reported.
      const payload = buildNodeParametersPayload(
        paramNode([
          { parameter: 3, bitMask: 0x3f, value: 5, metadata: { valueSize: 1 } },
          { parameter: 3, bitMask: 0xf0, value: 2, metadata: { valueSize: 1 } },
        ]),
      );

      expect(payload.groups[0].raw).toBeNull();
    });

    it('is not stated for a mask outside the width, or one that is not a mask', () => {
      const wide = buildNodeParametersPayload(
        paramNode([{ parameter: 3, bitMask: 0xffff, value: 1, metadata: { valueSize: 1 } }]),
      );
      const zero = buildNodeParametersPayload(
        paramNode([{ parameter: 4, bitMask: 0, value: 1, metadata: { valueSize: 1 } }]),
      );

      expect(wide.groups[0].raw).toBeNull();
      expect(zero.groups[0].raw).toBeNull();
    });

    it('is not stated when a field has no value', () => {
      const payload = buildNodeParametersPayload(
        paramNode([
          { parameter: 3, bitMask: 0x0f, value: null, metadata: { valueSize: 1 } },
          { parameter: 3, bitMask: 0xf0, value: 2, metadata: { valueSize: 1 } },
        ]),
      );

      expect(payload.groups[0].raw).toBeNull();
    });

    it('never reads the cached whole-parameter value beside fields', () => {
      /**
       * Once fields are defined, a report writes the fields and leaves the whole-parameter value
       * ID behind, so it can be older than everything shown. Here it says 99 and the fields say
       * 0x25; the payload must not report 99, and must not list it as another field either.
       */
      const payload = buildNodeParametersPayload(
        paramNode([
          { parameter: 3, value: 99, metadata: { valueSize: 1 } },
          { parameter: 3, bitMask: 0x0f, value: 5, metadata: { valueSize: 1 } },
          { parameter: 3, bitMask: 0xf0, value: 2, metadata: { valueSize: 1 } },
        ]),
      );

      expect(payload.groups).toHaveLength(1);
      expect(payload.groups[0].values).toHaveLength(2);
      expect(payload.groups[0].values.every((value) => value.bitMask !== null)).toBe(true);
      expect(payload.groups[0].raw).toBe(0x25);
    });
  });

  describe('what it keeps of the metadata', () => {
    it('carries a value the device has not reported as nothing, not as zero', () => {
      const payload = buildNodeParametersPayload(paramNode([{ parameter: 1 }]));

      expect(payload.groups[0].values[0].value).toBeNull();
    });

    it('carries when the node last reported the value', () => {
      const payload = buildNodeParametersPayload(
        paramNode([{ parameter: 1, value: 1, reportedAt: 1_700_000_000_000 }]),
      );

      expect(payload.groups[0].values[0].reportedAt).toBe(1_700_000_000_000);
      expect(buildNodeParametersPayload(paramNode([{ parameter: 1, value: 1 }])).groups[0].values[0]
        .reportedAt).toBeNull();
    });

    it('keeps a parameter it cannot describe rather than dropping it', () => {
      const payload = buildNodeParametersPayload(paramNode([{ parameter: 12, value: 4 }]));

      expect(payload.groups[0]).toMatchObject({ parameter: 12 });
      expect(payload.groups[0].values[0]).toMatchObject({ value: 4, label: null });
    });

    it('keeps the permitted set as single values and as ranges with their steps', () => {
      const payload = buildNodeParametersPayload(
        paramNode([
          {
            parameter: 2,
            value: 10,
            /**
             * The shape zwave-js defines: `ConfigValueRange` is `{ from, to, step? }`. Reading
             * `min` and `max` instead decoded every real range as zero to zero, and a test
             * written to the same wrong shape agreed with it.
             */
            metadata: {
              allowed: [{ value: 0 }, { from: 10, to: 100, step: 5 }, { from: 1, to: 3 }],
            },
          },
        ]),
      );

      expect(payload.groups[0].values[0].allowed).toEqual([
        { kind: 'value', value: 0 },
        { kind: 'range', from: 10, to: 100, step: 5 },
        { kind: 'range', from: 1, to: 3, step: null },
      ]);
    });

    it('drops an entry that is neither a value nor a range, rather than calling it zero', () => {
      const payload = buildNodeParametersPayload(
        paramNode([
          { parameter: 2, value: 1, metadata: { allowed: [{ nonsense: true }, { value: 4 }] } },
        ]),
      );

      expect(payload.groups[0].values[0].allowed).toEqual([{ kind: 'value', value: 4 }]);
    });

    it('reports no permitted set when every entry was unusable', () => {
      const payload = buildNodeParametersPayload(
        paramNode([{ parameter: 2, value: 1, metadata: { allowed: [{ nonsense: true }] } }]),
      );

      expect(payload.groups[0].values[0].allowed).toBeNull();
    });

    it('keeps the names a device gives its values', () => {
      const payload = buildNodeParametersPayload(
        paramNode([{ parameter: 2, value: 1, metadata: { states: { 0: 'Off', 1: 'On' } } }]),
      );

      expect(payload.groups[0].values[0].states).toEqual({ 0: 'Off', 1: 'On' });
    });

    it('carries every flag an editor will need, not only the ones a viewer draws', () => {
      const payload = buildNodeParametersPayload(
        paramNode([
          {
            parameter: 2,
            value: 1,
            metadata: {
              type: 'number',
              readable: false,
              writeable: true,
              isAdvanced: true,
              requiresReInclusion: true,
              destructive: true,
              allowManualEntry: false,
              isFromConfig: true,
              unit: 'seconds',
              min: 0,
              max: 100,
              default: 10,
              recommended: 20,
              valueSize: 2,
              format: 1,
              description: 'How long to wait',
            },
          },
        ]),
      );

      expect(payload.groups[0].values[0]).toMatchObject({
        readable: false,
        writable: true,
        advanced: true,
        requiresReInclusion: true,
        destructive: true,
        allowManualEntry: false,
        fromConfig: true,
        unit: 'seconds',
        min: 0,
        max: 100,
        defaultValue: 10,
        recommended: 20,
        valueSize: 2,
        format: 1,
        description: 'How long to wait',
      });
    });

    it('treats readable and writable as true where the metadata omits them', () => {
      // Both are required on the base metadata, so their absence means the documented default.
      const payload = buildNodeParametersPayload(
        paramNode([{ parameter: 1, value: 1, metadata: { label: 'Bare' } }]),
      );

      expect(payload.groups[0].values[0]).toMatchObject({ readable: true, writable: true });
    });
  });

  describe('whether the device is awake to answer', () => {
    const listeningOf = (over: Record<string, unknown>) =>
      buildNodeParametersPayload(
        paramNode([{ parameter: 1, value: 1 }], over as never),
      ).listening;

    it('counts an always-listening device', () => {
      expect(listeningOf({ isListening: true })).toBe(true);
    });

    it('counts a frequently listening device, which reports its beam interval', () => {
      /**
       * `FLiRS` is `false | "250ms" | "1000ms"`, never `true`. A device that can be beam-woken
       * for the request must not be offered the wording for one that cannot be reached until it
       * wakes on its own.
       */
      expect(listeningOf({ isListening: false, isFrequentListening: '250ms' })).toBe(true);
      expect(listeningOf({ isListening: false, isFrequentListening: '1000ms' })).toBe(true);
    });

    it('counts a sleeping device as asleep', () => {
      expect(listeningOf({ isListening: false, isFrequentListening: false })).toBe(false);
    });
  });
});
