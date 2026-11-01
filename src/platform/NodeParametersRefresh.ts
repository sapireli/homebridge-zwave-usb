import type { NodeParametersPayload, ParameterValue } from './NodeParametersPayload';

/** One value a refresh asked about, and what it said before the asking. */
export interface RefreshBaseline {
  endpoint: number;
  parameter: number;
  bitMask: number | null;
  /** What `getValueTimestamp` said at dispatch, or null where it said nothing. */
  reportedAt: number | null;
}

export interface RefreshToken {
  nodeId: number;
  /** The node the question was put to, which is its identity: a number is given away again. */
  owner: unknown;
  /** The hardware it was dispatched for, so it cannot outlive a device swap on the same number. */
  fingerprint: string | null;
  requestedAt: number;
  /** True until the attempt settles. Settling says the attempt finished, never that a value came. */
  dispatching: boolean;
  /** How many values it asked about, which does not change as they answer. */
  asked: number;
  /**
   * How many it will never hear about, because they went or stopped being readable.
   *
   * Counted apart from the ones that answered. Both leave the waiting list, and a list that is
   * empty because every value went is not a refresh that confirmed anything: reading the two as
   * one would report a device that has lost its parameters as a device that has just been read.
   */
  retired: number;
  /**
   * When every value it asked about had answered, or null while any is still outstanding.
   *
   * Stamped where the completion is seen rather than taken from `requestedAt`: a sleeping device
   * can answer hours after it was asked, and a reader told the time of the request would read it
   * as the time the values were confirmed.
   */
  completedAt: number | null;
  /**
   * The ones that have not answered, which only ever shrinks.
   *
   * Recomputing this from the original list each time would let a value that has answered, or
   * gone, come back to being waited on: a parameter that disappears and returns carrying the
   * timestamp it had before would look unanswered again, and the question would never close.
   */
  pending: RefreshBaseline[];
}

export type RefreshState = 'idle' | 'dispatching' | 'incomplete' | 'unavailable' | 'complete';

/** One value a refresh is still waiting on, named so the section can mark that value itself. */
export interface WaitingValue {
  endpoint: number;
  parameter: number;
  bitMask: number | null;
}

export interface RefreshStatus {
  state: RefreshState;
  requestedAt: number | null;
  /**
   * The values it asked about that have not answered.
   *
   * Named rather than counted, because the section says which value is waiting beside that value.
   * A count could say how many are outstanding but not which, and a reader looking at one
   * parameter would have no way to tell whether it is one of them.
   */
  waiting: WaitingValue[];
  /** How many it asked about at all. */
  asked: number;
  /** When the attempt was seen to have finished with every value answered, or null. */
  completedAt: number | null;
  /** False where the device has nothing a refresh could confirm. */
  canRequest: boolean;
}

const keyOf = (endpoint: number, parameter: number, bitMask: number | null) =>
  `${endpoint}:${parameter}:${bitMask ?? ''}`;

/**
 * The values a refresh can confirm.
 *
 * Only a readable value can ever answer: zwave-js's Configuration refresh skips write-only
 * parameters outright, so waiting on one would wait forever. The payload has already left a
 * whole-parameter value beside fields out of the group, so nothing here can ask about one.
 */
export function refreshableValues(
  payload: NodeParametersPayload,
): { endpoint: number; parameter: number; value: ParameterValue }[] {
  return payload.groups.flatMap((group) =>
    group.values
      .filter((value) => value.readable)
      .map((value) => ({ endpoint: group.endpoint, parameter: group.parameter, value })),
  );
}

export function canRefresh(payload: NodeParametersPayload): boolean {
  return payload.state === 'parameters' && refreshableValues(payload).length > 0;
}

/**
 * What each refreshable value said at the moment of asking.
 *
 * Taken at dispatch rather than read back later, because the question a refresh answers is whether
 * a value has moved since it was asked for, and nothing else establishes that.
 */
export function baselinesFor(payload: NodeParametersPayload): RefreshBaseline[] {
  return refreshableValues(payload).map(({ endpoint, parameter, value }) => ({
    endpoint,
    parameter,
    bitMask: value.bitMask,
    reportedAt: value.reportedAt,
  }));
}

/**
 * Narrows what a token is still waiting on, counting what it has stopped waiting on and why.
 *
 * A value has answered when its timestamp becomes known having been unknown, or moves past the one
 * it carried at dispatch. A value that has disappeared, or that has turned unreadable, is retired
 * rather than held open: neither will ever answer. The two are counted apart, because a value
 * that went is not a value that was confirmed.
 *
 * Retirement is permanent, which is why this narrows the pending set rather than deciding it
 * afresh. A parameter that goes and comes back with the timestamp it had before has not answered
 * the question, and asking it again on the strength of its return would leave one that never ends.
 *
 * A value that appeared after the dispatch is not here at all: the refresh never asked about it.
 */
export function reconcilePending(
  token: RefreshToken,
  payload: NodeParametersPayload,
): RefreshBaseline[] {
  const current = new Map<string, ParameterValue>();

  for (const group of payload.groups) {
    for (const value of group.values) {
      current.set(keyOf(group.endpoint, group.parameter, value.bitMask), value);
    }
  }

  const waiting: RefreshBaseline[] = [];

  for (const baseline of token.pending) {
    const value = current.get(keyOf(baseline.endpoint, baseline.parameter, baseline.bitMask));

    if (!value || !value.readable) {
      token.retired += 1;
    } else if (value.reportedAt === null) {
      waiting.push(baseline);
    } else if (baseline.reportedAt !== null && value.reportedAt <= baseline.reportedAt) {
      waiting.push(baseline);
    }
  }

  token.pending = waiting;

  return token.pending;
}

/**
 * Whether the attempt has finished and every value it asked about has answered.
 *
 * A value that went is not one that answered, so an attempt holding one has not completed
 * however empty the waiting list is. Read both by the status and by the caller that stamps the
 * completion, so the moment recorded is the moment the section is told about, and not a second
 * judgment that could differ from it.
 */
export function isComplete(token: RefreshToken): boolean {
  return !token.dispatching && token.pending.length === 0 && token.retired === 0;
}

/**
 * What the section says about the refresh.
 *
 * `dispatching` and `incomplete` are different things. While the attempt runs there is reason to
 * keep looking; once it has settled with values still unanswered there is not, and the reader is
 * offered another attempt instead of a wait that will not end.
 *
 * `unavailable` is a third thing again: nothing is outstanding, and nothing can be, because the
 * values the refresh asked about are not there any more. A value that is still expected outranks
 * one that has gone, since another attempt can bring the first and will never bring the second.
 */
export function refreshStatus(
  token: RefreshToken | null,
  payload: NodeParametersPayload,
): RefreshStatus {
  const available = canRefresh(payload);

  if (!token) {
    return {
      state: 'idle',
      requestedAt: null,
      waiting: [],
      asked: 0,
      completedAt: null,
      canRequest: available,
    };
  }

  const pending = token.pending;
  const state: RefreshState = token.dispatching
    ? 'dispatching'
    : pending.length > 0
      ? 'incomplete'
      : isComplete(token)
        ? 'complete'
        : 'unavailable';

  return {
    state,
    requestedAt: token.requestedAt,
    waiting: pending.map(({ endpoint, parameter, bitMask }) => ({ endpoint, parameter, bitMask })),
    asked: token.asked,
    completedAt: token.completedAt,
    canRequest: available,
  };
}

/**
 * Whether a request should dispatch, or be answered with the attempt already running.
 *
 * Replacing a running token's baselines would make one that can never complete: a refresh already
 * past parameter 1 has left its timestamp advanced, and a baseline taken from that advanced
 * timestamp waits for a move the refresh will not make again. So a request arriving while one is
 * running is the same request, and only a settled attempt can be retried.
 */
export function shouldDispatch(token: RefreshToken | null): boolean {
  if (!token) {
    return true;
  }

  return !token.dispatching;
}
