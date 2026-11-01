/**
 * The state machine behind a window covering.
 *
 * A pure reducer: `reduce(config, state, event)` returns the next state and the effects a thin
 * adapter has to perform, and never reads a clock, a timer, a node or HomeKit. Everything it
 * needs arrives in the event, so a sequence of events replays identically.
 *
 * State separates what was asked for from what is known. What was asked for is a set of
 * commands, each with one owner whose token retires its timers by ceasing to be current. What
 * is known is `reported`, which says how much to trust it. HomeKit sees a projection of that
 * state and nothing else.
 */

/** How close to its target a move has to be reported to count as carried out. */
export const POSITION_TOLERANCE = 1;
/**
 * How close two readings have to be to count as the covering being in the same place. Exact
 * agreement rules out a covering creeping at half a percent per second.
 */
export const STABILITY_TOLERANCE = 0;
/**
 * How long a covering has to stay in one place before it counts as having stopped there. A
 * covering can pause mid-travel (an RSZ1 was seen holding for about three seconds after a
 * command arrived while it moved, then carrying on), so a couple of matching readings prove
 * nothing.
 * Waiting has a cost: a covering that really is stuck is polled about six times instead of two
 * before the verdict, which is more radio traffic and more time a battery device stays awake.
 */
export const STALL_WINDOW_MS = 10000;
/** How often an accepted command is checked on. */
export const RECONCILE_INTERVAL_MS = 2000;
/**
 * How long an accepted command is followed without progress before its outcome is reported as
 * unconfirmed. Progress is a move's reported position getting closer to its target than it has
 * been; a stop gets no extension, because it should come to rest within a few seconds.
 */
export const RECONCILE_MAX_MS = 60000;
/**
 * The longest any command is followed, however much progress it makes. A covering that takes
 * longer than RECONCILE_MAX_MS to travel keeps being followed while it gets closer, so travel
 * time needs no setting, and this bounds one that never arrives.
 */
export const RECONCILE_CEILING_MS = 600000;
/** How often an unanswered startup poll is retried. */
export const PROBE_RETRY_MS = 5000;
/** How long the startup poll is retried before the seed is left as the last-known display. */
export const PROBE_WINDOW_MS = 30000;

/** How a verified position was obtained. */
export type Via = 'device' | 'poll' | 'supervision';

/**
 * What is known about where the covering is. The variants are separate because they are not
 * interchangeable evidence: only a verified position may satisfy a completion rule.
 */
export type Reported =
  | { kind: 'unknown' }
  | { kind: 'provisional'; position: number; from: 'hap-cache' | 'driver-cache' }
  | { kind: 'verified'; position: number; observedAt: number; via: Via };

export type Intent =
  | { id: number; requestId: number; kind: 'move'; target: number }
  | { id: number; requestId: number; kind: 'stop' };

export type Outcome = 'achieved' | 'not-achieved' | 'unconfirmed';

/** An accepted command that is being followed until its outcome is known. */
export type Active = Intent & {
  acceptedAt: number;
  /** When to give up: RECONCILE_MAX_MS after the last progress, never past RECONCILE_CEILING_MS. */
  deadline: number;
  /** For a move: the smallest distance to the target seen so far, starting from where it began. */
  closest?: number;
  /** Owns the reconcile timer and its polls. */
  token: number;
  /** The write returned a final Supervision Success. */
  supervised: boolean;
  /** Where the covering was last seen, and since when it has been there. */
  settling: {
    position?: number;
    since?: number;
  };
};

/** Debounce state. A ready intent has no live timer, so it carries no token. */
export type Pending =
  | { intent: Intent; dispatch: { kind: 'waiting'; token: number } }
  | { intent: Intent; dispatch: { kind: 'ready' } };

export interface CoveringState {
  lifecycle: 'uninitialized' | 'running' | 'stopped';
  reported: Reported;
  /** Verifies a `reported` that is not yet verified. Cleared when a verified one arrives. */
  probe?: { token: number; deadline: number };
  /** Ambiguous optimistic echoes. Diagnostic only; never projected to HomeKit. */
  ambiguous?: { position: number; observedAt: number };
  active?: Active;
  inFlight?: Intent;
  pending?: Pending;
  /** Diagnostic only; not command state. */
  lastOutcome?: Outcome;
  /** When the last write was issued or settled, for the minimum gap between moves. */
  lastWriteAt?: number;
  /** The only source of intent ids and tokens. Allocation takes the value, then increments. */
  nextId: number;
}

export interface CoveringConfig {
  /** A move is held this long so that a drag of the slider becomes one command. Zero disables. */
  debounceMs: number;
  /**
   * The least time between the end of one write and the start of the next move. A move that would
   * go out sooner is held, newest wins, so a covering that mishandles commands in quick succession
   * never gets them. A stop is never held. Zero or unset disables.
   */
  minGapMs?: number;
}

/** What the transport said about a write. The adapter classifies the driver's status. */
export type WriteResult =
  | { kind: 'accepted'; confirmation: 'supervised' | 'working' | 'unsupervised' }
  | { kind: 'refused'; message: string };

export type Event =
  | { t: 'Init'; seed?: { position: number; from: 'hap-cache' | 'driver-cache' }; now: number }
  | { t: 'HomeKitMove'; requestId: number; target: number; now: number }
  | { t: 'HomeKitStop'; requestId: number; now: number }
  | { t: 'DispatchTick'; dispatchToken: number; now: number }
  | { t: 'WriteSettled'; intentId: number; result: WriteResult; now: number }
  | {
      t: 'ValueReport';
      property: 'currentValue' | 'targetValue';
      value?: number;
      source?: 'driver' | 'node';
      now: number;
    }
  | ({ t: 'PollSettled'; token: number; now: number } & (
      | { outcome: 'answered'; position: number }
      | { outcome: 'unanswered' | 'unavailable' }
    ))
  | { t: 'ReconcileTick'; token: number; now: number }
  | { t: 'Teardown' };

export type RequestSettlement = 'accepted' | 'superseded' | { refused: string };

export type Effect =
  | { t: 'Write'; intent: Intent }
  | { t: 'Poll'; token: number }
  | { t: 'ArmReconcileTimer'; token: number; delayMs: number }
  | { t: 'ArmDispatchTimer'; dispatchToken: number; delayMs: number }
  | { t: 'SettleRequest'; requestId: number; outcome: RequestSettlement }
  | { t: 'Log'; level: 'debug' | 'warn'; message: string };

export interface Step {
  state: CoveringState;
  effects: Effect[];
}

export function initialState(): CoveringState {
  return { lifecycle: 'uninitialized', reported: { kind: 'unknown' }, nextId: 1 };
}

/** The command HomeKit should currently be shown: the newest one, accepted or not. */
export function liveIntent(state: CoveringState): Intent | undefined {
  return state.pending?.intent ?? state.inFlight ?? state.active;
}

export type PositionMotion = 'stopped' | 'increasing' | 'decreasing';

export interface Projection {
  current: number;
  target: number;
  motion: PositionMotion;
}

/**
 * What HomeKit is shown, as a pure function of state. Undefined while nothing is known: HomeKit
 * cannot take an unknown number, and inventing 0% would be indistinguishable from a closed
 * covering.
 */
export function project(state: CoveringState): Projection | undefined {
  if (state.reported.kind === 'unknown') {
    return undefined;
  }
  const position = state.reported.position;
  const live = liveIntent(state);

  if (live?.kind === 'stop') {
    return { current: position, target: position, motion: 'stopped' };
  }
  if (live?.kind === 'move') {
    return { current: position, target: live.target, motion: direction(position, live.target) };
  }

  return { current: position, target: position, motion: 'stopped' };
}

/**
 * Coverings report plus or minus a percent or two while they travel, so a position that close to
 * the target is not shown as a direction. Not at the ends, where arriving has to be exact.
 */
export function direction(current: number, target: number): PositionMotion {
  const tolerance = target === 0 || target === 100 ? 0 : 2;
  if (Math.abs(current - target) <= tolerance) {
    return 'stopped';
  }

  return current < target ? 'increasing' : 'decreasing';
}

function describe(intent: Intent): string {
  return intent.kind === 'stop' ? 'a stop' : `${intent.target}%`;
}

export function reduce(config: CoveringConfig, previous: CoveringState, event: Event): Step {
  if (event.t === 'Teardown') {
    return teardown(previous);
  }
  if (event.t === 'Init') {
    return previous.lifecycle === 'uninitialized' ? init(previous, event) : unchanged(previous);
  }
  if (previous.lifecycle !== 'running') {
    return unchanged(previous);
  }

  const run = new Run(config, previous, event.now);
  switch (event.t) {
    case 'HomeKitMove':
      run.submit({
        id: run.allocate(),
        requestId: event.requestId,
        kind: 'move',
        target: event.target,
      });
      break;
    case 'HomeKitStop':
      run.submit({ id: run.allocate(), requestId: event.requestId, kind: 'stop' });
      break;
    case 'DispatchTick':
      if (!run.dispatchTick(event.dispatchToken)) {
        return unchanged(previous);
      }
      break;
    case 'WriteSettled':
      if (!run.writeSettled(event)) {
        return unchanged(previous);
      }
      break;
    case 'ValueReport':
      if (!run.valueReport(event)) {
        return unchanged(previous);
      }
      break;
    case 'PollSettled':
      if (!run.pollSettled(event)) {
        return unchanged(previous);
      }
      break;
    case 'ReconcileTick':
      if (!run.reconcileTick(event)) {
        return unchanged(previous);
      }
      break;
  }

  return run.finish();
}

function unchanged(state: CoveringState): Step {
  return { state, effects: [] };
}

function init(previous: CoveringState, event: Extract<Event, { t: 'Init' }>): Step {
  const state: CoveringState = { ...previous, lifecycle: 'running' };
  const seed = event.seed;
  if (seed && Number.isFinite(seed.position) && seed.position >= 0 && seed.position <= 100) {
    state.reported = { kind: 'provisional', position: seed.position, from: seed.from };
  }

  const token = state.nextId++;
  state.probe = { token, deadline: event.now + PROBE_WINDOW_MS };

  return { state, effects: [{ t: 'Poll', token }] };
}

function teardown(previous: CoveringState): Step {
  const effects: Effect[] = [];
  for (const intent of [previous.pending?.intent, previous.inFlight]) {
    if (intent) {
      effects.push({ t: 'SettleRequest', requestId: intent.requestId, outcome: 'superseded' });
    }
  }

  const state: CoveringState = {
    lifecycle: 'stopped',
    reported: previous.reported,
    nextId: previous.nextId,
  };

  return { state, effects };
}

/** One reducer call. Works on a copy and reports every change through the same few helpers. */
class Run {
  private readonly state: CoveringState;
  private readonly effects: Effect[] = [];

  constructor(
    private readonly config: CoveringConfig,
    previous: CoveringState,
    private readonly now: number,
  ) {
    this.state = { ...previous };
  }

  allocate(): number {
    return this.state.nextId++;
  }

  finish(): Step {
    return { state: this.state, effects: this.effects };
  }

  /** The one place a verified position is produced, so the probe it supersedes always goes. */
  private verify(position: number, via: Via, now: number): void {
    this.state.reported = { kind: 'verified', position, observedAt: now, via };
    this.state.probe = undefined;
  }

  private settle(requestId: number, outcome: RequestSettlement): void {
    this.effects.push({ t: 'SettleRequest', requestId, outcome });
  }

  private log(level: 'debug' | 'warn', message: string): void {
    this.effects.push({ t: 'Log', level, message });
  }

  /** How much longer a move has to wait to keep the minimum gap after the last write. */
  private gapRemaining(intent: Intent): number {
    const gap = this.config.minGapMs ?? 0;
    const last = this.state.lastWriteAt;
    if (intent.kind !== 'move' || gap <= 0 || last === undefined) {
      return 0;
    }

    return Math.max(0, last + gap - this.now);
  }

  /** Holds a move behind a timer, which is how both the debounce and the gap are kept. */
  private hold(intent: Intent, delayMs: number): void {
    const token = this.allocate();
    this.state.pending = { intent, dispatch: { kind: 'waiting', token } };
    this.effects.push({ t: 'ArmDispatchTimer', dispatchToken: token, delayMs });
  }

  private write(intent: Intent): void {
    this.state.inFlight = intent;
    this.state.lastWriteAt = this.now;
    this.effects.push({ t: 'Write', intent });
  }

  /** Starts the next write when the transport is free and the debounce and gap have expired. */
  private drain(): void {
    const pending = this.state.pending;
    if (pending?.dispatch.kind !== 'ready' || this.state.inFlight) {
      return;
    }

    const wait = this.gapRemaining(pending.intent);
    if (wait > 0) {
      this.hold(pending.intent, wait);

      return;
    }
    this.state.pending = undefined;
    this.write(pending.intent);
  }

  submit(intent: Intent): void {
    const displaced = this.state.pending;
    if (displaced) {
      this.settle(displaced.intent.requestId, 'superseded');
      this.state.pending = undefined;
    }

    if (intent.kind === 'move') {
      const delay = Math.max(this.config.debounceMs, this.gapRemaining(intent));
      if (delay > 0) {
        this.hold(intent, delay);

        return;
      }
    }

    if (this.state.inFlight) {
      this.state.pending = { intent, dispatch: { kind: 'ready' } };
      return;
    }

    this.write(intent);
  }

  dispatchTick(token: number): boolean {
    const pending = this.state.pending;
    if (pending?.dispatch.kind !== 'waiting' || pending.dispatch.token !== token) {
      return false;
    }

    this.state.pending = { intent: pending.intent, dispatch: { kind: 'ready' } };
    this.drain();

    return true;
  }

  writeSettled(event: Extract<Event, { t: 'WriteSettled' }>): boolean {
    const intent = this.state.inFlight;
    if (!intent || intent.id !== event.intentId) {
      return false;
    }
    this.state.inFlight = undefined;
    this.state.lastWriteAt = event.now;

    const { result, now } = event;
    if (result.kind === 'refused') {
      // The command never happened, so whatever was being followed still is, and keeps its token.
      this.settle(intent.requestId, { refused: result.message });
      this.drain();
      return true;
    }

    this.settle(intent.requestId, 'accepted');

    if (result.confirmation === 'supervised' && intent.kind === 'move') {
      // Supervision says the device executed the move, which justifies the target position.
      this.verify(intent.target, 'supervision', now);
      this.state.active = undefined;
      this.state.lastOutcome = 'achieved';
      this.log('debug', `${describe(intent)} was confirmed by Supervision`);
      this.drain();
      return true;
    }

    // A supervised stop confirms only that the stop ran, not where the covering came to rest.
    const token = this.allocate();
    // The known starting position is the first distance to beat, so a covering that moves away
    // from its target, or back toward where it started, earns no extension.
    const reported = this.state.reported;
    const closest =
      intent.kind === 'move' && reported.kind === 'verified'
        ? Math.abs(reported.position - intent.target)
        : undefined;
    this.state.active = {
      ...intent,
      acceptedAt: now,
      deadline: now + RECONCILE_MAX_MS,
      ...(closest === undefined ? {} : { closest }),
      token,
      supervised: result.confirmation === 'supervised',
      settling: {},
    };
    this.effects.push(
      result.confirmation === 'supervised'
        ? { t: 'Poll', token }
        : { t: 'ArmReconcileTimer', token, delayMs: RECONCILE_INTERVAL_MS },
    );
    this.drain();

    return true;
  }

  valueReport(event: Extract<Event, { t: 'ValueReport' }>): boolean {
    if (event.source === 'driver' || event.property !== 'currentValue') {
      return false;
    }
    const value = event.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      return false;
    }

    // The driver echoes the commanded value into currentValue without tagging it, so an untagged
    // report equal to the target of a command still in progress says nothing about the device.
    // A report the node explicitly sent is evidence even when it matches.
    const echoes =
      event.source === undefined &&
      [this.state.inFlight, this.state.active].some(
        (command) => command?.kind === 'move' && sameLevel(command.target, value),
      );
    if (echoes) {
      this.state.ambiguous = { position: value, observedAt: event.now };
      this.disturbStall(value, event.now, false);
      return true;
    }

    this.verify(value, 'device', event.now);
    this.disturbStall(value, event.now, true);
    if (this.state.active) {
      this.state.active = progressed(this.state.active, value, event.now);
    }

    return true;
  }

  /**
   * A report of a different position says the covering moved, so the time it has been counted as
   * standing still no longer proves anything, whether or not the report can be trusted as a
   * position. A trusted one starts the clock again where the covering now is; an echo does not
   * say where it is, so the clock just stops until the next poll.
   */
  private disturbStall(value: number, now: number, trusted: boolean): void {
    const active = this.state.active;
    const at = active?.settling.position;
    if (!active || at === undefined || Math.abs(value - at) <= STABILITY_TOLERANCE) {
      return;
    }
    this.state.active = { ...active, settling: trusted ? { position: value, since: now } : {} };
  }

  pollSettled(event: Extract<Event, { t: 'PollSettled' }>): boolean {
    const { active, probe } = this.state;
    if (probe && probe.token === event.token) {
      if (event.outcome === 'answered') {
        this.verify(event.position, 'poll', event.now);
      } else {
        this.effects.push({ t: 'ArmReconcileTimer', token: probe.token, delayMs: PROBE_RETRY_MS });
      }
      return true;
    }
    if (!active || active.token !== event.token) {
      return false;
    }

    if (event.outcome !== 'answered') {
      this.effects.push({
        t: 'ArmReconcileTimer',
        token: active.token,
        delayMs: RECONCILE_INTERVAL_MS,
      });
      return true;
    }

    this.verify(event.position, 'poll', event.now);
    const settling = nextSettling(active.settling, event.position, event.now);
    const followed = progressed({ ...active, settling }, event.position, event.now);
    const outcome = evaluate(followed, event.position, event.now);

    if (outcome) {
      this.conclude(followed, outcome, event.now, event.position);
    } else if (event.now >= followed.deadline) {
      this.conclude(followed, 'unconfirmed', event.now, event.position);
    } else {
      this.state.active = followed;
      this.effects.push({
        t: 'ArmReconcileTimer',
        token: active.token,
        delayMs: RECONCILE_INTERVAL_MS,
      });
    }

    return true;
  }

  reconcileTick(event: Extract<Event, { t: 'ReconcileTick' }>): boolean {
    const { active, probe } = this.state;
    if (probe && probe.token === event.token) {
      if (event.now >= probe.deadline) {
        this.state.probe = undefined;
        this.log('warn', 'the covering never answered a request for its position');
      } else {
        this.effects.push({ t: 'Poll', token: probe.token });
      }
      return true;
    }
    if (!active || active.token !== event.token) {
      return false;
    }

    if (event.now >= active.deadline) {
      this.conclude(active, 'unconfirmed', event.now);
    } else {
      this.effects.push({ t: 'Poll', token: active.token });
    }

    return true;
  }

  /** Ends the followed command. Clearing it and recording why happen in one step. */
  private conclude(active: Active, outcome: Outcome, now: number, reportedPosition?: number): void {
    this.state.active = undefined;
    this.state.lastOutcome = outcome;

    const reported =
      reportedPosition === undefined ? 'an unknown position' : `${reportedPosition}%`;
    if (outcome === 'achieved') {
      this.log('debug', `${describe(active)} was carried out; the covering reports ${reported}`);
    } else if (outcome === 'not-achieved') {
      this.log(
        'warn',
        `the covering accepted ${describe(active)} but reports ${reported} instead of reaching it`,
      );
    } else {
      const seconds = Math.round((now - active.acceptedAt) / 1000);
      this.log(
        'warn',
        `the covering was still unconfirmed ${seconds}s after ${describe(active)}; ` +
          `it reports ${reported}`,
      );
    }
  }
}

/**
 * Folds one more answered poll into the record of where the covering is standing. A reading in
 * the same place keeps the time it first arrived there; a reading anywhere else starts again.
 */
function nextSettling(
  settling: Active['settling'],
  position: number,
  now: number,
): Active['settling'] {
  if (
    settling.position !== undefined &&
    Math.abs(position - settling.position) <= STABILITY_TOLERANCE
  ) {
    return settling;
  }

  return { position, since: now };
}

/**
 * Whether two percentages are the same level on the wire. Z-Wave tops out at 99, which HomeKit
 * calls 100, so the driver's echo of a command for 99 or 100 can come back as either.
 */
function sameLevel(a: number, b: number): boolean {
  return Math.min(a, 99) === Math.min(b, 99);
}

/**
 * A move that is reported closer to its target than ever before has made progress, which moves
 * its deadline out. A position that only wanders, or goes back, does not.
 */
function progressed(active: Active, position: number, now: number): Active {
  if (active.kind !== 'move') {
    return active;
  }
  const distance = Math.abs(position - active.target);
  if (active.closest !== undefined && distance >= active.closest) {
    return active;
  }
  const deadline = Math.min(
    active.acceptedAt + RECONCILE_CEILING_MS,
    Math.max(active.deadline, now + RECONCILE_MAX_MS),
  );

  return { ...active, closest: distance, deadline };
}

/** Whether the covering has stood in one place for the whole stall window. */
function stalled(active: Active, now: number): boolean {
  return active.settling.since !== undefined && now - active.settling.since >= STALL_WINDOW_MS;
}

/** The outcome a verified reading justifies, if it justifies one yet. */
function evaluate(active: Active, position: number, now: number): Outcome | undefined {
  if (active.kind === 'move') {
    if (Math.abs(position - active.target) <= POSITION_TOLERANCE) {
      return 'achieved';
    }

    return stalled(active, now) ? 'not-achieved' : undefined;
  }

  return stalled(active, now) ? 'achieved' : undefined;
}
