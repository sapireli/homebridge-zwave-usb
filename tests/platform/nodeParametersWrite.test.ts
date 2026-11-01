import { CommandClasses } from '@zwave-js/core';
import {
  checkParameterWrite,
  type ParameterWriteRequest,
} from '../../src/platform/NodeParametersWrite';
import {
  buildNodeParametersPayload,
  type NodeParametersPayload,
  type ParameterValue,
} from '../../src/platform/NodeParametersPayload';
import type { IZWaveNode } from '../../src/zwave/interfaces';

const value = (over: Partial<ParameterValue> = {}): ParameterValue => ({
  bitMask: null,
  value: 1,
  reportedAt: 1_000,
  label: 'Hold',
  description: null,
  unit: null,
  min: null,
  max: null,
  defaultValue: null,
  recommended: null,
  states: null,
  allowed: null,
  format: null,
  valueSize: 1,
  advanced: false,
  requiresReInclusion: false,
  destructive: false,
  allowManualEntry: true,
  fromConfig: false,
  readable: true,
  writable: true,
  ...over,
});

const payloadOf = (
  groups: { endpoint?: number; parameter: number; raw?: number | null; values: ParameterValue[] }[],
  state: NodeParametersPayload['state'] = 'parameters',
): NodeParametersPayload => ({
  nodeId: 10,
  state,
  listening: true,
  groups: groups.map((group) => ({
    endpoint: group.endpoint ?? 0,
    parameter: group.parameter,
    partial: group.values.some((one) => one.bitMask !== null),
    values: group.values,
    raw: group.raw ?? null,
  })),
});

const asked = (over: Partial<ParameterWriteRequest> = {}): ParameterWriteRequest => ({
  endpoint: 0,
  parameter: 1,
  bitMask: null,
  value: 2,
  expectedValueSize: 1,
  expectedFormat: null,
  acknowledgeDestructive: false,
  acknowledgeRequiresReInclusion: false,
  ...over,
});

const refusalFor = (payload: NodeParametersPayload, request = asked()) => {
  const check = checkParameterWrite(payload, request);

  return check.ok ? null : check.code;
};

describe('what a device will take for one of its parameters', () => {
  const one = (over: Partial<ParameterValue> = {}) =>
    payloadOf([{ parameter: 1, values: [value(over)] }]);

  describe('the parameter the caller named', () => {
    it('accepts a value the parameter permits', () => {
      expect(checkParameterWrite(one(), asked()).ok).toBe(true);
    });

    it('refuses a device that is not listing parameters at all', () => {
      expect(refusalFor(payloadOf([], 'none'))).toBe('definition-changed');
      expect(refusalFor(payloadOf([], 'interviewing'))).toBe('definition-changed');
    });

    it('refuses a parameter the device does not have', () => {
      expect(refusalFor(one(), asked({ parameter: 99 }))).toBe('definition-changed');
      expect(refusalFor(one(), asked({ endpoint: 2 }))).toBe('definition-changed');
    });

    it('refuses a field the parameter does not have', () => {
      expect(refusalFor(one(), asked({ bitMask: 0x0f }))).toBe('definition-changed');
    });

    it('refuses a parameter whose size or format has moved under the caller', () => {
      /**
       * A page is read once and acted on later. A device re-interviewed in between can describe
       * the same number differently, and a value sized for the old description is not the value
       * the reader chose.
       */
      expect(refusalFor(one({ valueSize: 2 }), asked({ expectedValueSize: 1 }))).toBe(
        'definition-changed',
      );
      expect(refusalFor(one({ format: 1 }), asked({ expectedFormat: null }))).toBe(
        'definition-changed',
      );
    });
  });

  describe('what cannot be written at all', () => {
    it('refuses a read-only parameter, whatever the value', () => {
      expect(refusalFor(one({ writable: false }))).toBe('not-writable');
    });

    it('refuses a destructive parameter that was not acknowledged', () => {
      expect(refusalFor(one({ destructive: true }))).toBe('needs-acknowledgment');
      expect(
        checkParameterWrite(one({ destructive: true }), asked({ acknowledgeDestructive: true })).ok,
      ).toBe(true);
    });

    it('refuses one that may need re-inclusion without its own acknowledgment', () => {
      expect(refusalFor(one({ requiresReInclusion: true }))).toBe('needs-acknowledgment');
      expect(
        checkParameterWrite(
          one({ requiresReInclusion: true }),
          asked({ acknowledgeRequiresReInclusion: true }),
        ).ok,
      ).toBe(true);
    });

    it('takes only the boolean itself as an acknowledgment', () => {
      /**
       * The body arrives as parsed JSON and the types are gone by then. A request carrying the
       * string "false", a 1, or an empty object would otherwise acknowledge a risk that nobody
       * was shown.
       */
      const risky = one({ destructive: true });
      const acknowledgedBy = (ack: unknown) =>
        refusalFor(risky, asked({ acknowledgeDestructive: ack as boolean }));

      expect(acknowledgedBy('false')).toBe('needs-acknowledgment');
      expect(acknowledgedBy('true')).toBe('needs-acknowledgment');
      expect(acknowledgedBy(1)).toBe('needs-acknowledgment');
      expect(acknowledgedBy({})).toBe('needs-acknowledgment');
      expect(acknowledgedBy([])).toBe('needs-acknowledgment');
      expect(acknowledgedBy(true)).toBeNull();
    });

    it('requires both acknowledgments where the parameter carries both risks', () => {
      const both = one({ destructive: true, requiresReInclusion: true });

      expect(refusalFor(both, asked({ acknowledgeDestructive: true }))).toBe(
        'needs-acknowledgment',
      );
      expect(refusalFor(both, asked({ acknowledgeRequiresReInclusion: true }))).toBe(
        'needs-acknowledgment',
      );
      expect(
        checkParameterWrite(
          both,
          asked({ acknowledgeDestructive: true, acknowledgeRequiresReInclusion: true }),
        ).ok,
      ).toBe(true);
    });
  });

  describe('a parameter divided into fields', () => {
    const divided = (over: { raw?: number | null; second?: Partial<ParameterValue> } = {}) =>
      payloadOf([
        {
          parameter: 1,
          raw: over.raw === undefined ? 0x21 : over.raw,
          values: [
            value({ bitMask: 0x0f, value: 1, valueSize: 1 }),
            value({ bitMask: 0xf0, value: 2, valueSize: 1, ...(over.second ?? {}) }),
          ],
        },
      ]);

    const field = asked({ bitMask: 0x0f, value: 3 });

    it('accepts a field of a parameter that composes completely', () => {
      expect(checkParameterWrite(divided(), field).ok).toBe(true);
    });

    it('refuses a field where the parameter cannot be composed', () => {
      /**
       * The driver builds the whole parameter from the cached fields, starting at zero. A
       * parameter whose masks leave bits undescribed would have those bits written as zero, and
       * `raw` is null exactly when that is so.
       */
      expect(refusalFor(divided({ raw: null }), field)).toBe('partial-incomplete');
    });

    it('refuses a field whose sibling has never been reported', () => {
      expect(refusalFor(divided({ second: { reportedAt: null } }), field)).toBe(
        'partial-incomplete',
      );
      expect(refusalFor(divided({ second: { value: null } }), field)).toBe('partial-incomplete');
    });

    it('does not hold an ordinary parameter to that rule', () => {
      // Writing a whole parameter replaces all of it, so nothing of the device's is composed in.
      expect(checkParameterWrite(one({ reportedAt: null, value: null }), asked()).ok).toBe(true);
    });

    it('refuses a field too wide for the bits it is written into', () => {
      /**
       * The driver shifts the value into the mask, and a number too large would be truncated
       * there and silently mean something else. A field spanning more than one bit with no
       * stated format is signed in the driver's reading, so four bits carry -8 to 7 rather than
       * 0 to 15.
       */
      expect(checkParameterWrite(divided(), asked({ bitMask: 0x0f, value: 7 })).ok).toBe(true);
      expect(refusalFor(divided(), asked({ bitMask: 0x0f, value: 8 }))).toBe('out-of-range');
    });

    it('measures an unsigned field by the whole span of its mask', () => {
      const unsigned = payloadOf([
        {
          parameter: 1,
          raw: 0x21,
          values: [
            value({ bitMask: 0x0f, value: 1, valueSize: 1, format: 1 }),
            value({ bitMask: 0xf0, value: 2, valueSize: 1, format: 1 }),
          ],
        },
      ]);
      const field = (v: number) => asked({ bitMask: 0x0f, value: v, expectedFormat: 1 });

      expect(checkParameterWrite(unsigned, field(15)).ok).toBe(true);
      expect(refusalFor(unsigned, field(16))).toBe('out-of-range');
    });

    it('lets a field of more than one bit carry a sign, as the driver does', () => {
      const signed = payloadOf([
        {
          parameter: 1,
          raw: 0x21,
          values: [
            value({ bitMask: 0x0f, value: 1, valueSize: 1, format: 0 }),
            value({ bitMask: 0xf0, value: 2, valueSize: 1 }),
          ],
        },
      ]);

      expect(
        checkParameterWrite(signed, asked({ bitMask: 0x0f, value: -8, expectedFormat: 0 })).ok,
      ).toBe(true);
      expect(refusalFor(signed, asked({ bitMask: 0x0f, value: -9, expectedFormat: 0 }))).toBe(
        'out-of-range',
      );
    });
  });

  describe('the number itself', () => {
    it('refuses anything that is not a whole number', () => {
      expect(refusalFor(one(), asked({ value: 1.5 }))).toBe('not-permitted');
      expect(refusalFor(one(), asked({ value: Number.NaN }))).toBe('not-permitted');
      expect(refusalFor(one(), asked({ value: Number.POSITIVE_INFINITY }))).toBe('not-permitted');
    });

    it('holds a value to the range the metadata states, boundaries included', () => {
      const ranged = one({ min: 10, max: 50, valueSize: 1 });

      expect(refusalFor(ranged, asked({ value: 9 }))).toBe('out-of-range');
      expect(refusalFor(ranged, asked({ value: 51 }))).toBe('out-of-range');
      expect(checkParameterWrite(ranged, asked({ value: 10 })).ok).toBe(true);
      expect(checkParameterWrite(ranged, asked({ value: 50 })).ok).toBe(true);
    });

    it('holds a value to the permitted set where the device states one', () => {
      const set = one({
        allowed: [
          { kind: 'value', value: 0 },
          { kind: 'range', from: 10, to: 50, step: 10 },
        ],
      });

      expect(checkParameterWrite(set, asked({ value: 0 })).ok).toBe(true);
      expect(checkParameterWrite(set, asked({ value: 30 })).ok).toBe(true);
      expect(refusalFor(set, asked({ value: 5 }))).toBe('not-permitted');
      expect(refusalFor(set, asked({ value: 35 }))).toBe('not-permitted');
      expect(refusalFor(set, asked({ value: 60 }))).toBe('not-permitted');
    });

    it('lets a range of step one, or of none, permit every number it covers', () => {
      const stepped = one({ allowed: [{ kind: 'range', from: 1, to: 9, step: 1 }] });
      const stepless = one({ allowed: [{ kind: 'range', from: 1, to: 9, step: null }] });

      expect(checkParameterWrite(stepped, asked({ value: 4 })).ok).toBe(true);
      expect(checkParameterWrite(stepless, asked({ value: 4 })).ok).toBe(true);
    });

    it('refuses a range that cannot describe a whole number', () => {
      /**
       * `ConfigValueRange` says only that the bounds are numbers. A configuration value is a
       * whole number, so a range between fractions describes nothing a device could be set to,
       * and one that ends before it starts describes nothing at all.
       */
      const between = (from: number, to: number) =>
        one({ allowed: [{ kind: 'range', from, to, step: 1 }] });

      expect(refusalFor(between(1.5, 9.5), asked({ value: 4 }))).toBe('not-permitted');
      expect(refusalFor(between(9, 1), asked({ value: 4 }))).toBe('not-permitted');
      expect(checkParameterWrite(between(1, 9), asked({ value: 4 })).ok).toBe(true);
    });

    it('drops a range whose step is not a positive whole number', () => {
      /**
       * Metadata that makes no sense must narrow what may be written, never widen it. A step of
       * zero, a negative one, or a fraction describes no sequence, so the range it belongs to
       * permits nothing rather than everything.
       */
      const stepped = (step: unknown) =>
        one({ allowed: [{ kind: 'range', from: 1, to: 9, step: step as number }] });

      expect(refusalFor(stepped(0), asked({ value: 4 }))).toBe('not-permitted');
      expect(refusalFor(stepped(-1), asked({ value: 4 }))).toBe('not-permitted');
      expect(refusalFor(stepped(0.5), asked({ value: 4 }))).toBe('not-permitted');
      expect(refusalFor(stepped(Number.NaN), asked({ value: 4 }))).toBe('not-permitted');
    });

    it('offers only the named states where the device forbids typing a number', () => {
      const named = one({
        allowManualEntry: false,
        states: { 0: 'Off', 2: 'On when off' },
      });

      expect(checkParameterWrite(named, asked({ value: 2 })).ok).toBe(true);
      expect(refusalFor(named, asked({ value: 1 }))).toBe('manual-entry-forbidden');
    });

    it('lets an unnamed number through where the device allows typing one', () => {
      const named = one({ states: { 0: 'Off', 2: 'On when off' }, max: 9 });

      expect(checkParameterWrite(named, asked({ value: 1 })).ok).toBe(true);
    });

    it('holds a whole value to the size and format it is written in', () => {
      expect(refusalFor(one({ valueSize: 1, format: null }), asked({ value: 128 }))).toBe(
        'out-of-range',
      );
      expect(
        checkParameterWrite(one({ valueSize: 1, format: null }), asked({ value: 127 })).ok,
      ).toBe(true);
      expect(
        checkParameterWrite(
          one({ valueSize: 1, format: 1 }),
          asked({ value: 255, expectedFormat: 1 }),
        ).ok,
      ).toBe(true);
      expect(
        refusalFor(one({ valueSize: 1, format: 1 }), asked({ value: 256, expectedFormat: 1 })),
      ).toBe('out-of-range');
    });

    it('measures a three-byte parameter by its own limits', () => {
      const wide = one({ valueSize: 3, format: null });
      const askWide = (value: number) => asked({ value, expectedValueSize: 3 });

      expect(checkParameterWrite(wide, askWide(8_388_607)).ok).toBe(true);
      expect(checkParameterWrite(wide, askWide(-8_388_608)).ok).toBe(true);
      expect(refusalFor(wide, askWide(8_388_608))).toBe('out-of-range');
      expect(refusalFor(wide, askWide(-8_388_609))).toBe('out-of-range');
    });

    it('leaves a parameter with no stated size to the driver', () => {
      expect(
        checkParameterWrite(
          one({ valueSize: null }),
          asked({ value: 70_000, expectedValueSize: null }),
        ).ok,
      ).toBe(true);
    });
  });
});

describe('a permitted set as the device actually reports it', () => {
  /**
   * The rules above are read against a payload, and a payload is built from metadata. A step the
   * device states as nonsense must not reach the rules as a step it never stated: an absent step
   * permits every number in the range, so the two cannot be allowed to arrive looking the same.
   */
  const nodeReporting = (allowed: unknown): IZWaveNode =>
    ({
      nodeId: 10,
      ready: true,
      isListening: true,
      getDefinedValueIDs: () => [
        { commandClass: CommandClasses.Configuration, endpoint: 0, property: 1 },
      ],
      getValue: () => 4,
      getValueTimestamp: () => 1_000,
      getValueMetadata: () => ({
        type: 'number',
        readable: true,
        writeable: true,
        label: 'Hold',
        valueSize: 1,
        allowed,
      }),
      supportsCC: (cc: number) => cc === CommandClasses.Configuration,
      getAllEndpoints: () => [{ index: 0, supportsCC: () => true }],
      on: () => undefined,
      off: () => undefined,
    }) as unknown as IZWaveNode;

  const writing = (value: number) =>
    asked({ value, expectedValueSize: 1, expectedFormat: null });

  it('keeps a step the device stated properly', () => {
    const payload = buildNodeParametersPayload(
      nodeReporting([{ from: 0, to: 10, step: 5 }]),
    );

    expect(payload.groups[0].values[0].allowed).toEqual([
      { kind: 'range', from: 0, to: 10, step: 5 },
    ]);
    expect(checkParameterWrite(payload, writing(5)).ok).toBe(true);
    expect(refusalFor(payload, writing(4))).toBe('not-permitted');
  });

  it('keeps a range the device stated without a step', () => {
    const payload = buildNodeParametersPayload(nodeReporting([{ from: 0, to: 10 }]));

    expect(payload.groups[0].values[0].allowed).toEqual([
      { kind: 'range', from: 0, to: 10, step: null },
    ]);
    expect(checkParameterWrite(payload, writing(4)).ok).toBe(true);
  });

  it('drops a range whose stated step is nonsense, rather than reading it as none', () => {
    [Number.NaN, 0, -1, 0.5, 'two'].forEach((step) => {
      const payload = buildNodeParametersPayload(nodeReporting([{ from: 0, to: 10, step }]));

      expect(payload.groups[0].values[0].allowed).toEqual([]);
      expect(refusalFor(payload, writing(4))).toBe('not-permitted');
    });
  });

  it('tells a set the device never stated from one nobody can read', () => {
    /**
     * Absence is the only shape that means no restriction. Anything else the metadata holds is
     * an attempt at stating one, and an attempt that cannot be read permits nothing rather than
     * everything. zwave-js normally validates these shapes; this is the boundary where that
     * assumption is not relied on.
     */
    const decoded = (allowed: unknown) =>
      buildNodeParametersPayload(nodeReporting(allowed)).groups[0].values[0].allowed;

    expect(decoded(undefined)).toBeNull();
    expect(checkParameterWrite(buildNodeParametersPayload(nodeReporting(undefined)), writing(4)).ok)
      .toBe(true);

    [[], null, 'all', [null], [{}], [{ from: 0, to: 10, step: null }]].forEach((allowed) => {
      const payload = buildNodeParametersPayload(nodeReporting(allowed));

      expect(decoded(allowed)).toEqual([]);
      expect(refusalFor(payload, writing(4))).toBe('not-permitted');
    });
  });

  it('reads a range the device stated without mentioning a step', () => {
    const payload = buildNodeParametersPayload(nodeReporting([{ from: 0, to: 10 }]));

    expect(payload.groups[0].values[0].allowed).toEqual([
      { kind: 'range', from: 0, to: 10, step: null },
    ]);
    expect(checkParameterWrite(payload, writing(4)).ok).toBe(true);
  });

  it('keeps the entries it can read beside one it cannot', () => {
    const payload = buildNodeParametersPayload(
      nodeReporting([{ value: 0 }, { from: 2, to: 8, step: Number.NaN }]),
    );

    expect(payload.groups[0].values[0].allowed).toEqual([{ kind: 'value', value: 0 }]);
    expect(checkParameterWrite(payload, writing(0)).ok).toBe(true);
    expect(refusalFor(payload, writing(4))).toBe('not-permitted');
  });
});
