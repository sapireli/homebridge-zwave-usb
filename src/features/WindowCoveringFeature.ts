import { Service, CharacteristicValue } from 'homebridge';
import { SetValueResult, SetValueStatus, ValueID, setValueFailed } from 'zwave-js';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature, HAP_COMMUNICATION_FAILURE, definedValues, hasValue } from './ZWaveFeature';
import { Endpoint } from 'zwave-js';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { canPollNodeValues, pollNodeValue } from '../zwave/nodeApi';
import {
  findCoveringPositionValueId,
  findCoveringStopValueId,
  readCoveringPosition,
} from '../zwave/coveringTravel';
import {
  CoveringConfig,
  CoveringState,
  Effect,
  Event,
  Intent,
  WriteResult,
  initialState,
  project,
  reduce,
} from '../zwave/coveringController';
import { describeSetValueResult } from '../zwave/setValueResult';
import { findDeviceOverride } from '../devices/deviceOverrides';

/** How long a position poll may take before it is given up on and counted as unanswered. */
const POLL_TIMEOUT_MS = 10000;

/** What an operation HomeKit is waiting on needs to be told when it is settled. */
interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

type PollOutcome =
  | { outcome: 'answered'; position: number }
  | { outcome: 'unanswered' | 'unavailable' };

/**
 * WindowCoveringFeature handles shades and blinds using Window Covering or Multilevel Switch CC.
 *
 * It is the thin edge around a pure controller (coveringController.ts). Everything that decides
 * what a command means, whether it has finished and what HomeKit should be shown lives there.
 * This class turns HomeKit writes and driver reports into controller events, carries out the
 * effects the controller asks for, and publishes the projection it derives.
 *
 * The contract with the controller: each Write, Poll and timer effect completes exactly once,
 * with the id or token it was issued under, and nothing is ever reported for an effect that was
 * not issued.
 */
export class WindowCoveringFeature extends BaseFeature {
  /**
   * Which command class drives the position is decided by `supportsCC`, not by which values the
   * device happens to define, so the two branches are checked separately and neither falls back
   * to the other.
   *
   * A device that advertises Window Covering CC without a keyed position can still be read
   * through the Multilevel Switch fallback that `resolvePositionValueId` provides, which makes
   * it look serviceable. It is not: `transmit` builds a Window Covering `targetValue` because
   * the command class is chosen from `supportsCC`, then refuses the write outright when the
   * position it resolves is not a keyed Window Covering value. Such a covering would report a
   * position and decline every command to move, so it is not compatible.
   */
  public static canBePrimary(node: IZWaveNode, endpoint: Endpoint): boolean {
    const values = definedValues(node, endpoint.index);

    if (endpoint.supportsCC(CommandClasses['Window Covering'])) {
      const position = values.find(
        (valueId) =>
          valueId.commandClass === CommandClasses['Window Covering'] &&
          valueId.property === 'currentValue' &&
          typeof valueId.propertyKey === 'number',
      );

      return (
        position !== undefined &&
        hasValue(
          values,
          CommandClasses['Window Covering'],
          'targetValue',
          position.propertyKey as number,
        )
      );
    }

    return (
      hasValue(values, CommandClasses['Multilevel Switch'], 'currentValue') &&
      hasValue(values, CommandClasses['Multilevel Switch'], 'targetValue')
    );
  }

  private service!: Service;
  private state: CoveringState = initialState();
  private requestSequence = 0;
  /**
   * Counts controller lifetimes. An effect remembers the one it was issued in and reports back
   * only if it is still current, so a result from before a node replacement cannot reach the
   * controller that replaced it, whose tokens start again from the beginning.
   */
  private epoch = 0;
  private readonly waiters = new Map<number, Waiter>();
  /** Live timers, so a teardown can cancel them. A retired token's timer is harmless when it fires. */
  private readonly timers = new Set<NodeJS.Timeout>();

  init(): void {
    const subType = this.endpoint.index.toString();
    const restoredService = this.serviceExists(subType);
    this.service = this.getService(this.platform.Service.WindowCovering, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.handleGetCurrentPosition.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.handleGetTargetPosition.bind(this))
      .onSet(this.handleSetTargetPosition.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handleGetPositionState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.HoldPosition)
      .onSet(this.handleSetHoldPosition.bind(this));

    this.dispatch({
      t: 'Init',
      seed: this.startupSeed(restoredService ? 'hap-first' : 'driver-only'),
      now: Date.now(),
    });
  }

  public stop(): void {
    this.dispatch({ t: 'Teardown' });
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  update(args?: ZWaveValueEvent): void {
    if (
      !this.shouldUpdate(args, CommandClasses['Window Covering']) &&
      !this.shouldUpdate(args, CommandClasses['Multilevel Switch'])
    ) {
      return;
    }

    if (args && args.commandClass === CommandClasses['Window Covering']) {
      const selected = findCoveringPositionValueId(this.node, this.endpoint.index);
      if (
        selected?.commandClass === CommandClasses['Window Covering'] &&
        args.propertyKey !== selected.propertyKey
      )
        return;
    } else if (
      args &&
      args.commandClass === CommandClasses['Multilevel Switch'] &&
      this.positionCommandClass === CommandClasses['Window Covering']
    ) {
      // Do not let the less-specific switch cache overwrite the selected covering parameter.
      return;
    }

    if (
      args &&
      (args.property === 'currentValue' || args.property === 'targetValue') &&
      typeof args.newValue === 'number'
    ) {
      this.dispatch({
        t: 'ValueReport',
        property: args.property,
        value: args.newValue === 99 ? 100 : args.newValue,
        source: args.source,
        now: Date.now(),
      });
    } else {
      this.publish();
    }
  }

  /**
   * The position HomeKit last displayed is preferred, but only for a service that already
   * existed: a service created just now holds the characteristic's default, which is not a
   * position anybody ever saw. The driver's cache is the fallback.
   */
  private startupSeed(order: 'hap-first' | 'driver-only'): Extract<Event, { t: 'Init' }>['seed'] {
    const displayed = (): Extract<Event, { t: 'Init' }>['seed'] => {
      const shown = this.service.getCharacteristic(
        this.platform.Characteristic.CurrentPosition,
      ).value;

      return typeof shown === 'number' && Number.isFinite(shown)
        ? { position: shown, from: 'hap-cache' }
        : undefined;
    };
    const cached = (): Extract<Event, { t: 'Init' }>['seed'] => {
      const position = readCoveringPosition(this.node, this.endpoint.index, 'currentValue');

      return position === undefined ? undefined : { position, from: 'driver-cache' };
    };

    // A node whose metadata cannot be read yet has no cache worth seeding from, and a failed
    // lookup must not stop the controller from starting: the probe finds the position anyway.
    try {
      return order === 'hap-first' ? (displayed() ?? cached()) : cached();
    } catch (err) {
      this.platform.log.debug(
        `Node ${this.node.nodeId} position cache could not be read: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );

      return undefined;
    }
  }

  /**
   * Hot recovery replaces the node object, and with it everything the old one reported. The
   * controller's position, command and timers all describe the old node, so they are discarded
   * and the new node is started from scratch. A request still waiting on the old node is
   * failed, not resolved: nothing was confirmed, and HomeKit should say so.
   *
   * The same node handed back again is left alone unless the controller has nothing to go on:
   * no verified position, no probe still looking for one and no command to lose. That is a
   * node that was unavailable for longer than the probe waited and has since become ready.
   */
  public updateNode(node: IZWaveNode, endpoint: Endpoint): void {
    const replaced = node !== this.node;
    super.updateNode(node, endpoint);
    if (!this.service) {
      return;
    }

    if (replaced) {
      this.restart(true);
    } else if (this.needsReprobe()) {
      this.restart(false);
    }
  }

  private needsReprobe(): boolean {
    const { lifecycle, reported, probe, pending, inFlight, active } = this.state;

    return (
      lifecycle === 'running' &&
      reported.kind !== 'verified' &&
      !probe &&
      !pending &&
      !inFlight &&
      !active
    );
  }

  private restart(failRequests: boolean): void {
    // Decided before anything is torn down, so nothing that goes wrong reading the new node
    // can leave the controller reset and never started.
    const shown = this.state.reported.kind === 'unknown' ? undefined : this.state.reported.position;
    const seed =
      this.startupSeed('driver-only') ??
      (shown === undefined ? undefined : { position: shown, from: 'hap-cache' as const });

    if (failRequests) {
      this.waiters.forEach((waiter) =>
        waiter.reject(new this.platform.api.hap.HapStatusError(HAP_COMMUNICATION_FAILURE)),
      );
      this.waiters.clear();
    }
    this.dispatch({ t: 'Teardown' });
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.epoch += 1;
    this.state = initialState();
    this.dispatch({ t: 'Init', seed, now: Date.now() });
  }

  private serviceExists(subType: string): boolean {
    const type = this.platform.Service.WindowCovering;
    const found =
      subType && subType !== '0'
        ? this.accessory.getServiceById(type, subType)
        : this.accessory.getService(type);

    return found !== undefined;
  }

  private get config(): CoveringConfig {
    const override = findDeviceOverride(this.node);

    return {
      debounceMs: override?.coalescePositionCommandsMs ?? 0,
      minGapMs: override?.minPositionCommandGapMs ?? 0,
    };
  }

  /**
   * Position commands are logged as one traceable sequence: what HomeKit asked for, what was
   * actually transmitted and where the covering ended up. These are the lines that make a
   * misbehaving covering diagnosable, so they are promoted to info when verbose logging is on.
   */
  private logPosition(message: string): void {
    const line = `Covering [Node ${this.node.nodeId} endpoint ${this.endpoint.index}]: ${message}`;

    if (this.platform.config?.debug) {
      this.platform.log.info(line);
    } else {
      this.platform.log.debug(line);
    }
  }

  /**
   * Feeds one event to the controller, carries out what it asks for and publishes the result.
   * The new state is in place before any effect runs, and every effect that reports back does
   * so from a later turn of the event loop, so a result can never re-enter a transition.
   */
  private dispatch(event: Event): void {
    const step = reduce(this.config, this.state, event);
    this.state = step.state;
    step.effects.forEach((effect) => this.run(effect));
    this.publish();
  }

  private run(effect: Effect): void {
    switch (effect.t) {
      case 'Write':
        void this.write(effect.intent);
        break;
      case 'Poll':
        void this.poll(effect.token);
        break;
      case 'ArmReconcileTimer':
        this.arm(effect.delayMs, () =>
          this.dispatch({ t: 'ReconcileTick', token: effect.token, now: Date.now() }),
        );
        break;
      case 'ArmDispatchTimer':
        this.arm(effect.delayMs, () =>
          this.dispatch({
            t: 'DispatchTick',
            dispatchToken: effect.dispatchToken,
            now: Date.now(),
          }),
        );
        break;
      case 'SettleRequest':
        this.settle(effect.requestId, effect.outcome);
        break;
      case 'Log':
        if (effect.level === 'warn') {
          this.platform.log.warn(`Node ${this.node.nodeId}: ${effect.message}`);
        } else {
          this.logPosition(effect.message);
        }
        break;
    }
  }

  private arm(delayMs: number, fire: () => void): void {
    const epoch = this.epoch;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (epoch === this.epoch) {
        fire();
      }
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private settle(
    requestId: number,
    outcome: 'accepted' | 'superseded' | { refused: string },
  ): void {
    const waiter = this.waiters.get(requestId);
    this.waiters.delete(requestId);
    if (!waiter) {
      return;
    }
    if (typeof outcome === 'object') {
      waiter.reject(new this.platform.api.hap.HapStatusError(HAP_COMMUNICATION_FAILURE));
    } else {
      // A superseded request was replaced by something newer, which is not a failure.
      waiter.resolve();
    }
  }

  /** Waits for the controller to settle a command, or settles it at once when it is not running. */
  private submit(make: (requestId: number) => Event): Promise<void> {
    if (this.state.lifecycle !== 'running') {
      return Promise.resolve();
    }

    const requestId = ++this.requestSequence;

    return new Promise<void>((resolve, reject) => {
      this.waiters.set(requestId, { resolve, reject });
      this.dispatch(make(requestId));
    });
  }

  private async handleSetTargetPosition(value: CharacteristicValue): Promise<void> {
    const target = value as number;
    this.logPosition(`HomeKit requested ${target}%`);

    return this.submit((requestId) => ({
      t: 'HomeKitMove',
      requestId,
      target,
      now: Date.now(),
    }));
  }

  /** HomeKit's HoldPosition is write-only and means "stop where you are". */
  private async handleSetHoldPosition(value: CharacteristicValue): Promise<void> {
    if (!value) {
      return;
    }

    this.logPosition('stop requested');

    return this.submit((requestId) => ({ t: 'HomeKitStop', requestId, now: Date.now() }));
  }

  private get positionCommandClass(): CommandClasses {
    return this.endpoint.supportsCC(CommandClasses['Window Covering'])
      ? CommandClasses['Window Covering']
      : CommandClasses['Multilevel Switch'];
  }

  /**
   * Transmits one intent and reports how the driver received it, exactly once. Anything that
   * goes wrong, including while the value to write is being looked up, is a refusal: the
   * controller owns the transport until the write settles, so a write that never reported
   * back would hold it for good.
   */
  private async write(intent: Intent): Promise<void> {
    const epoch = this.epoch;
    let result: WriteResult;
    try {
      result = await this.transmit(intent);
    } catch (err) {
      this.platform.log.error(`Node ${this.node.nodeId} could not send ${intent.kind}:`, err);
      result = { kind: 'refused', message: err instanceof Error ? err.message : String(err) };
    }
    if (epoch === this.epoch) {
      this.dispatch({ t: 'WriteSettled', intentId: intent.id, result, now: Date.now() });
    }
  }

  private async transmit(intent: Intent): Promise<WriteResult> {
    const endpoint = this.endpoint.index;
    let valueId: ValueID;
    let zwaveValue: unknown;
    let label: string;

    if (intent.kind === 'stop') {
      const stopValueId = findCoveringStopValueId(this.node, endpoint);
      if (!stopValueId) {
        this.platform.log.warn(
          `Node ${this.node.nodeId} does not report a way to stop the covering.`,
        );
        // Settled from a later turn like every other result.
        await Promise.resolve();

        return { kind: 'refused', message: 'no way to stop the covering' };
      }
      valueId = {
        commandClass: stopValueId.commandClass,
        endpoint,
        property: stopValueId.property,
        propertyKey: stopValueId.propertyKey,
      };
      // Writing false to a level-change action is what stops the movement.
      zwaveValue = false;
      label = 'HoldPosition';
    } else {
      // Z-Wave levels top out at 99, so HomeKit's 100% maps onto the device's fully open value.
      valueId = {
        commandClass: this.positionCommandClass,
        endpoint,
        property: 'targetValue',
      };
      if (valueId.commandClass === CommandClasses['Window Covering']) {
        const position = this.resolvePositionValueId();
        if (
          position?.commandClass !== CommandClasses['Window Covering'] ||
          typeof position.propertyKey !== 'number'
        ) {
          return { kind: 'refused', message: 'no keyed Window Covering position is defined' };
        }
        valueId.propertyKey = position.propertyKey;
      }
      zwaveValue = intent.target === 100 ? 99 : intent.target;
      label = 'TargetPosition';
    }

    const target = `${CommandClasses[valueId.commandClass]}.${String(valueId.property)}`;
    this.logPosition(`transmitting ${label} ${JSON.stringify(zwaveValue)} -> ${target}`);

    let setResult: SetValueResult | undefined;
    try {
      setResult = await this.node.setValue(valueId, zwaveValue);
    } catch (err) {
      this.platform.log.error(`Set failed: Node ${this.node.nodeId} ${label} -> ${target}:`, err);

      return { kind: 'refused', message: err instanceof Error ? err.message : String(err) };
    }

    const outcome = describeSetValueResult(setResult);
    if (!outcome.accepted) {
      this.platform.log.error(
        `Set rejected: Node ${this.node.nodeId} ${label} -> ${target}: ${outcome.description}`,
      );

      return { kind: 'refused', message: outcome.description };
    }

    this.platform.log.debug(
      `Set end: Node ${this.node.nodeId} ${label} -> ${target}: ${outcome.description}`,
    );

    return { kind: 'accepted', confirmation: confirmationOf(setResult) };
  }

  /**
   * Asks the device where it is and reports under the token the poll was issued with, exactly
   * once. A poll the device never answers is given up on after POLL_TIMEOUT_MS: the controller
   * only re-arms its timer from a settled poll, so one that never settled would stall the
   * command until nothing was left to check its deadline. A completion arriving after that is
   * dropped, and so is anything that throws while the poll is being set up.
   */
  private async poll(token: number): Promise<void> {
    const epoch = this.epoch;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const settleOnce = (outcome: PollOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      if (epoch === this.epoch) {
        this.dispatch({ t: 'PollSettled', token, now: Date.now(), ...outcome });
      }
    };

    try {
      const valueId = this.resolvePositionValueId();
      if (!valueId || !canPollNodeValues(this.node)) {
        // Retrying cannot change either, so this is unavailable rather than unanswered.
        await Promise.resolve();
        settleOnce({ outcome: 'unavailable' });

        return;
      }

      timeout = setTimeout(() => {
        this.platform.log.debug(`Node ${this.node.nodeId} did not answer a position poll in time`);
        settleOnce({ outcome: 'unanswered' });
      }, POLL_TIMEOUT_MS);
      timeout.unref();

      const value = await pollNodeValue(this.node, valueId);
      // A resolved poll with no usable number is zwave-js saying no value came back. The cache
      // is not consulted: it is exactly the stale reading the poll exists to replace.
      const position = typeof value === 'number' && value === 99 ? 100 : value;
      if (typeof position === 'number' && position >= 0 && position <= 100) {
        settleOnce({ outcome: 'answered', position });
      } else {
        if (value !== undefined) {
          this.platform.log.debug(
            `Node ${this.node.nodeId} answered a position poll with ${String(value)}, ` +
              'which is not a position',
          );
        }
        settleOnce({ outcome: 'unanswered' });
      }
    } catch (err) {
      this.platform.log.debug(
        `Node ${this.node.nodeId} did not answer a position poll: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      settleOnce({ outcome: 'unanswered' });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  /**
   * The ValueID to poll for this covering's position, or undefined when the device defines none
   * that the driver could resolve. Falling back to the plain shape is safe only for Multilevel
   * Switch CC, which does not key its values by parameter.
   */
  private resolvePositionValueId(): ValueID | undefined {
    const defined = findCoveringPositionValueId(this.node, this.endpoint.index);
    if (defined) {
      return defined;
    }

    if (this.positionCommandClass === CommandClasses['Multilevel Switch']) {
      return {
        commandClass: CommandClasses['Multilevel Switch'],
        property: 'currentValue',
        endpoint: this.endpoint.index,
      };
    }

    return undefined;
  }

  /**
   * Shows HomeKit the controller's projection. Nothing is published while the position is
   * unknown. Each characteristic is compared with what it holds now rather than with what was
   * last published, because HomeKit records a written TargetPosition on its own and a refused
   * write has to put the old one back.
   */
  private publish(): void {
    const projection = project(this.state);
    if (!projection || !this.service) {
      return;
    }

    const { Characteristic } = this.platform;
    const shown: Array<[unknown, number]> = [
      [Characteristic.CurrentPosition, projection.current],
      [Characteristic.TargetPosition, projection.target],
      [Characteristic.PositionState, this.positionStateOf(projection.motion)],
    ];
    for (const [characteristic, value] of shown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (this.service.getCharacteristic(characteristic as any).value !== value) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.service.updateCharacteristic(characteristic as any, value);
      }
    }
  }

  private positionStateOf(motion: 'stopped' | 'increasing' | 'decreasing'): number {
    const { PositionState } = this.platform.Characteristic;

    return {
      stopped: PositionState.STOPPED,
      increasing: PositionState.INCREASING,
      decreasing: PositionState.DECREASING,
    }[motion];
  }

  private readProjection() {
    const projection = project(this.state);
    if (!projection) {
      // Neither cache is a device observation, and 0% would read as a closed covering.
      throw new this.platform.api.hap.HapStatusError(HAP_COMMUNICATION_FAILURE);
    }

    return projection;
  }

  private handleGetCurrentPosition(): number {
    return this.readProjection().current;
  }

  private handleGetTargetPosition(): number {
    return this.readProjection().target;
  }

  /** 0 = Decreasing, 1 = Increasing, 2 = Stopped. */
  private handleGetPositionState(): number {
    return this.positionStateOf(this.readProjection().motion);
  }
}

/**
 * How firmly the device vouched for a write that the driver accepted. Only Supervision's final
 * Success says the device executed it; Working says it is still going; anything else is a
 * delivery with no word from the device.
 */
function confirmationOf(
  result: SetValueResult | undefined,
): 'supervised' | 'working' | 'unsupervised' {
  if (!result || typeof result.status !== 'number' || setValueFailed(result)) {
    return 'unsupervised';
  }
  if (result.status === SetValueStatus.Success) {
    return 'supervised';
  }
  if (result.status === SetValueStatus.Working) {
    return 'working';
  }

  return 'unsupervised';
}
