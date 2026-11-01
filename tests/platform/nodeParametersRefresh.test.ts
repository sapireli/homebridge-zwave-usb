import {
  baselinesFor,
  canRefresh,
  isComplete,
  reconcilePending,
  refreshStatus,
  shouldDispatch,
  type RefreshToken,
} from '../../src/platform/NodeParametersRefresh';
import type { NodeParametersPayload, ParameterValue } from '../../src/platform/NodeParametersPayload';

const value = (over: Partial<ParameterValue> = {}): ParameterValue => ({
  bitMask: null,
  value: 1,
  reportedAt: 1_000,
  label: null,
  description: null,
  unit: null,
  min: null,
  max: null,
  defaultValue: null,
  recommended: null,
  states: null,
  allowed: null,
  format: null,
  valueSize: null,
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
  groups: { endpoint?: number; parameter: number; values: ParameterValue[] }[],
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
    raw: null,
  })),
});

const owner = { nodeId: 10 };

const tokenOf = (payload: NodeParametersPayload, over: Partial<RefreshToken> = {}): RefreshToken => {
  const baselines = baselinesFor(payload);

  return {
    nodeId: 10,
    owner,
    fingerprint: 'abc',
    requestedAt: 5_000,
    dispatching: true,
    asked: baselines.length,
    retired: 0,
    completedAt: null,
    pending: baselines,
    ...over,
  };
};

describe('asking a device for its current configuration values', () => {
  describe('what a refresh can confirm', () => {
    it('asks about every readable value', () => {
      const payload = payloadOf([
        { parameter: 1, values: [value()] },
        { parameter: 2, values: [value({ bitMask: 0x0f }), value({ bitMask: 0xf0 })] },
      ]);

      expect(baselinesFor(payload)).toHaveLength(3);
    });

    it('never asks about a value the device will not report', () => {
      /**
       * zwave-js's Configuration refresh skips write-only parameters outright, so a baseline for
       * one would wait for a timestamp that is never going to move.
       */
      const payload = payloadOf([
        { parameter: 1, values: [value({ readable: false })] },
        { parameter: 2, values: [value()] },
      ]);

      expect(baselinesFor(payload).map((baseline) => baseline.parameter)).toEqual([2]);
    });

    it('is not offered where nothing could answer', () => {
      expect(canRefresh(payloadOf([{ parameter: 1, values: [value({ readable: false })] }]))).toBe(
        false,
      );
      expect(canRefresh(payloadOf([], 'none'))).toBe(false);
      expect(canRefresh(payloadOf([{ parameter: 1, values: [value()] }]))).toBe(true);
    });
  });

  describe('what has answered', () => {
    it('counts a value whose timestamp has moved past its own baseline', () => {
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);
      const token = tokenOf(before);
      const after = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_001 })] }]);

      expect(reconcilePending(token, before)).toHaveLength(1);
      expect(reconcilePending(token, after)).toHaveLength(0);
    });

    it('counts a value that had no timestamp and now has one', () => {
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: null })] }]);
      const token = tokenOf(before);
      const after = payloadOf([{ parameter: 1, values: [value({ reportedAt: 7 })] }]);

      expect(reconcilePending(token, before)).toHaveLength(1);
      expect(reconcilePending(token, after)).toHaveLength(0);
    });

    it('does not count a timestamp that merely equals the baseline', () => {
      // The same reading is not a new one, however recently the cache was read.
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);

      expect(reconcilePending(tokenOf(before), before)).toHaveLength(1);
    });

    it('compares each value against its own baseline, not against one instant', () => {
      /**
       * Two values asked for together can carry different baselines. Judging both against a
       * single wall-clock instant would call one of them answered on the strength of a reading
       * that predates the request.
       */
      const before = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 1_000 })] },
        { parameter: 2, values: [value({ reportedAt: 9_000 })] },
      ]);
      const token = tokenOf(before, { requestedAt: 5_000 });
      const after = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 6_000 })] },
        { parameter: 2, values: [value({ reportedAt: 9_000 })] },
      ]);

      expect(reconcilePending(token, after).map((baseline) => baseline.parameter)).toEqual([2]);
    });

    it('counts a value that has gone apart from one that answered', () => {
      /**
       * Both leave the waiting list, and only one of them says anything about the device. A
       * list that is empty because every value went is not a refresh that confirmed something.
       */
      const before = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 1_000 })] },
        { parameter: 2, values: [value({ reportedAt: 1_000 })] },
      ]);
      const token = tokenOf(before, { dispatching: false });

      reconcilePending(
        token,
        payloadOf([{ parameter: 1, values: [value({ reportedAt: 5_000 })] }]),
      );

      expect(token.pending).toHaveLength(0);
      expect(token.retired).toBe(1);
      expect(isComplete(token)).toBe(false);
      expect(refreshStatus(token, before).state).toBe('unavailable');
    });

    it('counts a value that turned unreadable as one that will never answer', () => {
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);
      const token = tokenOf(before, { dispatching: false });

      reconcilePending(
        token,
        payloadOf([{ parameter: 1, values: [value({ readable: false })] }]),
      );

      expect(token.retired).toBe(1);
      expect(refreshStatus(token, before).state).toBe('unavailable');
    });

    it('counts a value once, however often it is reconciled', () => {
      // Retirement is permanent, and a count that grew on every reading would be a count of
      // readings rather than of values.
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);
      const token = tokenOf(before, { dispatching: false });

      reconcilePending(token, payloadOf([]));
      reconcilePending(token, payloadOf([]));
      reconcilePending(token, before);

      expect(token.retired).toBe(1);
    });

    it('stops waiting on a value that has gone', () => {
      const before = payloadOf([
        { parameter: 1, values: [value()] },
        { parameter: 2, values: [value()] },
      ]);
      const token = tokenOf(before);
      const after = payloadOf([{ parameter: 1, values: [value()] }]);

      expect(reconcilePending(token, after).map((baseline) => baseline.parameter)).toEqual([1]);
    });

    it('stops waiting on a value that has turned unreadable', () => {
      const before = payloadOf([{ parameter: 1, values: [value()] }]);
      const token = tokenOf(before);
      const after = payloadOf([{ parameter: 1, values: [value({ readable: false })] }]);

      expect(reconcilePending(token, after)).toHaveLength(0);
    });

    it('does not wait on a value again because it came back', () => {
      /**
       * Retirement is permanent. A parameter that disappears and returns carrying the timestamp
       * it had before has still not answered, and taking it up again on the strength of its
       * return would leave a question that never ends.
       */
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);
      const token = tokenOf(before);

      reconcilePending(token, payloadOf([]));
      expect(token.pending).toHaveLength(0);

      reconcilePending(token, before);
      expect(token.pending).toHaveLength(0);
      expect(token.asked).toBe(1);
    });

    it('does not wait on a value again because it turned readable', () => {
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);
      const token = tokenOf(before);

      reconcilePending(token, payloadOf([{ parameter: 1, values: [value({ readable: false })] }]));
      expect(token.pending).toHaveLength(0);

      reconcilePending(token, before);
      expect(token.pending).toHaveLength(0);
    });

    it('keeps what it asked about even as the waiting list empties', () => {
      const before = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 1_000 })] },
        { parameter: 2, values: [value({ reportedAt: 1_000 })] },
      ]);
      const token = tokenOf(before);

      reconcilePending(
        token,
        payloadOf([
          { parameter: 1, values: [value({ reportedAt: 2_000 })] },
          { parameter: 2, values: [value({ reportedAt: 1_000 })] },
        ]),
      );

      expect(token.asked).toBe(2);
      expect(token.pending).toHaveLength(1);
    });

    it('never waits on a value that appeared after it asked', () => {
      // The refresh did not ask about it, so it has nothing to say about whether it answered.
      const before = payloadOf([{ parameter: 1, values: [value({ reportedAt: 2_000 })] }]);
      const token = tokenOf(before);
      const after = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 2_000 })] },
        { parameter: 9, values: [value({ reportedAt: null })] },
      ]);

      expect(reconcilePending(token, after).map((baseline) => baseline.parameter)).toEqual([1]);
    });

    it('tells a field apart from another field of the same parameter', () => {
      const before = payloadOf([
        { parameter: 1, values: [value({ bitMask: 0x0f, reportedAt: 1 }), value({ bitMask: 0xf0, reportedAt: 1 })] },
      ]);
      const token = tokenOf(before);
      const after = payloadOf([
        { parameter: 1, values: [value({ bitMask: 0x0f, reportedAt: 2 }), value({ bitMask: 0xf0, reportedAt: 1 })] },
      ]);

      expect(reconcilePending(token, after).map((baseline) => baseline.bitMask)).toEqual([0xf0]);
    });

    it('tells two endpoints using one parameter number apart', () => {
      const before = payloadOf([
        { endpoint: 0, parameter: 1, values: [value({ reportedAt: 1 })] },
        { endpoint: 2, parameter: 1, values: [value({ reportedAt: 1 })] },
      ]);
      const token = tokenOf(before);
      const after = payloadOf([
        { endpoint: 0, parameter: 1, values: [value({ reportedAt: 5 })] },
        { endpoint: 2, parameter: 1, values: [value({ reportedAt: 1 })] },
      ]);

      expect(reconcilePending(token, after).map((baseline) => baseline.endpoint)).toEqual([2]);
    });
  });

  describe('what the section is told', () => {
    const payload = payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]);

    it('says nothing is happening when nothing has been asked', () => {
      expect(refreshStatus(null, payload)).toMatchObject({
        state: 'idle',
        asked: 0,
        waiting: [],
        canRequest: true,
      });
    });

    it('reports what it is still waiting on, which the caller has narrowed', () => {
      const token = tokenOf(payload);

      reconcilePending(token, payload);

      expect(refreshStatus(token, payload)).toMatchObject({
        asked: 1,
        waiting: [{ endpoint: 0, parameter: 1, bitMask: null }],
      });
    });

    it('separates an attempt that is running from one that finished short', () => {
      /**
       * While the attempt runs there is reason to keep looking. Once it has settled with values
       * unanswered there is not, and another attempt is offered instead of an endless wait.
       */
      const running = tokenOf(payload);

      expect(refreshStatus(running, payload).state).toBe('dispatching');
      expect(refreshStatus({ ...running, dispatching: false }, payload).state).toBe('incomplete');
    });

    it('reports completion only when every value it asked about has answered', () => {
      const token = tokenOf(payload, { dispatching: false });
      const answered = payloadOf([{ parameter: 1, values: [value({ reportedAt: 2_000 })] }]);

      reconcilePending(token, answered);

      expect(refreshStatus(token, answered)).toMatchObject({ state: 'complete', waiting: [] });
    });

    it('does not call an attempt complete because the values it asked about went', () => {
      /**
       * A value that is no longer there did not answer. Reading an empty waiting list as a
       * success would tell a reader the device had just confirmed settings it no longer has.
       */
      const two = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 1_000 })] },
        { parameter: 2, values: [value({ reportedAt: 1_000 })] },
      ]);
      const token = tokenOf(two, { dispatching: false });

      reconcilePending(token, payloadOf([]));

      expect(refreshStatus(token, two)).toMatchObject({
        state: 'unavailable',
        waiting: [],
        asked: 2,
        completedAt: null,
      });
    });

    it('says what is still expected before what has gone, since only one can still arrive', () => {
      const two = payloadOf([
        { parameter: 1, values: [value({ reportedAt: 1_000 })] },
        { parameter: 2, values: [value({ reportedAt: 1_000 })] },
      ]);
      const token = tokenOf(two, { dispatching: false });

      reconcilePending(
        token,
        payloadOf([{ parameter: 1, values: [value({ reportedAt: 1_000 })] }]),
      );

      expect(token.retired).toBe(1);
      expect(refreshStatus(token, two)).toMatchObject({
        state: 'incomplete',
        waiting: [{ endpoint: 0, parameter: 1, bitMask: null }],
      });
    });

    it('names each value it is waiting on, so the section can mark that value', () => {
      /**
       * A count says how many are outstanding and not which. A reader looking at one field of a
       * parameter would have no way to tell whether that field is one of them.
       */
      const partials = payloadOf([
        { parameter: 7, values: [value({ bitMask: 0x0f }), value({ bitMask: 0xf0 })] },
      ]);
      const token = tokenOf(partials);

      reconcilePending(
        token,
        payloadOf([
          {
            parameter: 7,
            values: [value({ bitMask: 0x0f, reportedAt: 9_000 }), value({ bitMask: 0xf0 })],
          },
        ]),
      );

      expect(refreshStatus(token, partials).waiting).toEqual([
        { endpoint: 0, parameter: 7, bitMask: 0xf0 },
      ]);
    });

    it('is finished only once it has settled with nothing left outstanding', () => {
      /**
       * A value can answer while the refresh is still running, which empties the waiting list
       * without the attempt having finished. What finishes is the attempt.
       */
      const running = tokenOf(payload);

      expect(isComplete(running)).toBe(false);
      expect(isComplete({ ...running, pending: [] })).toBe(false);
      expect(isComplete({ ...running, dispatching: false })).toBe(false);
      expect(isComplete({ ...running, dispatching: false, pending: [], retired: 1 })).toBe(false);
      expect(isComplete({ ...running, dispatching: false, pending: [] })).toBe(true);
    });

    it('carries the completion it was given, which is what dates the success', () => {
      const done = tokenOf(payload, { dispatching: false, pending: [], completedAt: 7_000 });

      expect(refreshStatus(done, payload)).toMatchObject({
        state: 'complete',
        completedAt: 7_000,
      });
    });

    it('has no completion to carry while an attempt runs, or where none was made', () => {
      expect(refreshStatus(tokenOf(payload), payload).completedAt).toBeNull();
      expect(refreshStatus(null, payload).completedAt).toBeNull();
    });

    it('says a device with nothing readable cannot be asked', () => {
      const unreadable = payloadOf([{ parameter: 1, values: [value({ readable: false })] }]);

      expect(refreshStatus(null, unreadable).canRequest).toBe(false);
    });
  });

  describe('when a request dispatches', () => {
    const payload = payloadOf([{ parameter: 1, values: [value()] }]);

    it('dispatches when nothing is running', () => {
      expect(shouldDispatch(null)).toBe(true);
    });

    it('does not dispatch again while an attempt is running', () => {
      /**
       * A second dispatch would take its baselines from timestamps the running refresh has
       * already advanced, and then wait for a move it will never make again.
       */
      expect(shouldDispatch(tokenOf(payload))).toBe(false);
    });

    it('dispatches again once the attempt has settled', () => {
      expect(shouldDispatch(tokenOf(payload, { dispatching: false }))).toBe(true);
    });
  });
});
