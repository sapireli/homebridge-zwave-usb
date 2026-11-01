import { createHash, randomUUID } from 'crypto';
import { Logger } from 'homebridge';
import { AccessoryFactory, PlanOptions, PrimaryKind } from '../accessories/AccessoryFactory';
import { findDeviceOverride } from '../devices/deviceOverrides';
import { IZWaveNode } from '../zwave/interfaces';
import {
  DeviceFingerprint,
  TypeObservation,
  TypeOverride,
  TypeOverrideData,
  TypeOverrideStore,
  describeError,
  fingerprintKey,
  isFingerprint,
} from './TypeOverrideStore';

/** Where a node's published primary type comes from. */
export type TypeSource = 'registry' | 'detected' | 'override';

/** What a node publishes when no override is in effect, and what decided it. */
export interface NodeDefaultType {
  kind?: PrimaryKind;
  source: 'registry' | 'detected';
  /** The registry's name for this hardware, or nothing when the registry did not decide the type. */
  registryLabel: string | null;
}

/** Why a write changed nothing. Each is a state the page mirrors rather than an error. */
export type WriteRefusal =
  | 'incomplete-request'
  | 'unknown-node'
  | 'read-only'
  | 'not-overridable'
  | 'fingerprint-changed'
  | 'cohort-changed'
  | 'unsupported-type'
  | 'already-current'
  | 'already-default'
  | 'use-clear'
  | 'no-override'
  | 'override-in-use'
  | 'unknown-observation';

export interface WriteResult {
  /** Why nothing was written, or nothing when the decision was saved. */
  refusal?: WriteRefusal;
  /** The nodes the saved decision reaches, for the caller to rebuild. Empty on a refusal. */
  rebuild: number[];
}

/**
 * What a write names, so that it acts on the state the page was showing and no other.
 *
 * Each operation requires exactly the guards that make it safe, and they are required rather
 * than optional because the declared types are gone by the time a request arrives over IPC. A
 * missing guard is refused, never skipped: skipping one would turn a stale write into an
 * accepted one, which is the opposite of what carrying it was for.
 */
export interface SetTypeRequest {
  nodeId: number;
  primaryKind: PrimaryKind;
  expectedFingerprint: DeviceFingerprint;
  expectedRevision: string;
}

export interface ClearTypeRequest {
  nodeId: number;
  expectedFingerprint: DeviceFingerprint;
  expectedRevision: string;
}

/** Discarding names no hardware: the node reporting it is not the hardware it was saved for. */
export interface RemoveTypeRequest {
  nodeId: number;
  expectedRevision: string;
}

/** Acknowledging names no revision: it changes nothing about what any node publishes. */
export interface AcknowledgeOrphanRequest {
  nodeId: number;
  observationId: string;
  expectedFingerprint: DeviceFingerprint;
}

/** What `writeSubject` reads, before each operation's own fields are looked at. */
interface GuardedRequest {
  nodeId: number;
  expectedFingerprint?: DeviceFingerprint;
  expectedRevision?: string;
}

/** Which guards an operation carries, and therefore which are required of it. */
interface RequiredGuards {
  fingerprint: boolean;
  revision: boolean;
}

/** Supplies the two values a write needs that are not derived from the network. */
export interface ResolverClock {
  now(): string;
  newId(): string;
}

const systemClock: ResolverClock = {
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};

const refused = (refusal: WriteRefusal): WriteResult => ({ refusal, rebuild: [] });

/** Either why no write can go ahead, or the state every write acts on. */
type WriteSubject =
  | { refusal: WriteRefusal }
  | { fingerprint: DeviceFingerprint; key: string; cohort: readonly IZWaveNode[] };

/** Drops a decision and every record of where it was applied, active and orphaned alike. */
const forget = (key: string) => (data: TypeOverrideData) => {
  data.overrides = data.overrides.filter(
    (override) => fingerprintKey(override.fingerprint) !== key,
  );
  data.observations = data.observations.filter(
    (observation: TypeObservation) => fingerprintKey(observation.fingerprint) !== key,
  );
};

/**
 * Reads the saved type overrides against what the network currently reports.
 *
 * The store holds decisions about hardware; this turns them into an answer about a node. The two
 * are kept apart because a decision outlives the device it was made for: a node can be replaced
 * with different hardware, a firmware update can take a capability away, and a plugin update can
 * change what a type needs. Each of those leaves the file as it was and changes only what this
 * resolves, so a decision is never quietly rewritten by the network.
 */
export class TypeOverrideResolver {
  /** The three identifiers, once the device has reported all of them. */
  public static fingerprintOf(node: IZWaveNode): DeviceFingerprint | undefined {
    const { manufacturerId, productType, productId } = node;
    if (manufacturerId === undefined || productType === undefined || productId === undefined) {
      return undefined;
    }

    return { manufacturerId, productType, productId };
  }

  /**
   * Whether this node can carry an override at all.
   *
   * A device with several endpoints has a primary per endpoint, so one type for the node would
   * be choosing which endpoint the node is. A device that has not reported all three identifiers
   * cannot be told apart from another model, and a decision made for it would reach whatever
   * else arrived without them.
   *
   * Node 1 is the controller, which the sync never builds a generic accessory for. A decision
   * saved for it would be kept and applied to nothing, and a request for it has to be refused
   * here rather than only left out of the UI: the route can be called directly.
   */
  public static isOverridable(node: IZWaveNode): boolean {
    return (
      Number(node.nodeId) !== 1 &&
      TypeOverrideResolver.fingerprintOf(node) !== undefined &&
      node.getAllEndpoints().length === 1
    );
  }

  /**
   * What this node publishes with no override.
   *
   * Two nodes of the same model can differ here, because the plan is read from what each one
   * reports, so reverting returns each node to its own answer rather than to a shared one.
   */
  public static defaultTypeFor(node: IZWaveNode): NodeDefaultType {
    const kind = AccessoryFactory.planFeatures(node)[0]?.primaryKind;
    const entry = findDeviceOverride(node);
    /**
     * The registry decides a type only where it redirects Multilevel Switch to a covering. Its
     * other fields are command timing, which does not change what the device is published as.
     */
    const registryLabel =
      entry?.multilevelSwitchDrivesCovering && kind === 'window-covering' ? entry.label : null;

    return { kind, source: registryLabel === null ? 'detected' : 'registry', registryLabel };
  }

  /** Nodes whose write failure has been reported, so a failing disk is not reported every event. */
  private readonly reported = new Set<number>();

  /**
   * Runs one command at a time.
   *
   * Validating a decision and saving it has to be one step. The store serializes its writes, so
   * two decisions carrying the same revision would both pass a check made outside that order and
   * the second would replace the first without ever seeing that the first had happened. Reading
   * the record of where a decision was applied belongs in the same order for the same reason: a
   * pass that began while a decision was being cleared would otherwise write down where a
   * decision that no longer exists had been applied.
   */
  private commands: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly store: TypeOverrideStore,
    private readonly listNodes: () => readonly IZWaveNode[],
    private readonly log: Logger,
    private readonly clock: ResolverClock = systemClock,
  ) {}

  /** The override saved for this node's hardware, whether or not this node can take it. */
  public savedOverrideFor(node: IZWaveNode): TypeOverride | undefined {
    const fingerprint = TypeOverrideResolver.fingerprintOf(node);
    if (!fingerprint || !TypeOverrideResolver.isOverridable(node)) {
      return undefined;
    }

    return this.store.overrideFor(fingerprint);
  }

  /**
   * The override in effect for this node, which is none when the node cannot be published as the
   * saved type. A node included after the decision was made, one running different firmware and
   * one read by a plugin version that asks more of the type all reach this.
   */
  public appliedOverrideFor(node: IZWaveNode): TypeOverride | undefined {
    const saved = this.savedOverrideFor(node);
    if (!saved) {
      return undefined;
    }

    return AccessoryFactory.compatiblePrimaryKinds(node).includes(saved.primaryKind)
      ? saved
      : undefined;
  }

  /** The saved override this node cannot be published as, when there is one. */
  public invalidOverrideFor(node: IZWaveNode): TypeOverride | undefined {
    const saved = this.savedOverrideFor(node);

    return saved && !this.appliedOverrideFor(node) ? saved : undefined;
  }

  /**
   * What the planner is given for this node. An override that this node cannot take is never
   * passed in, so the node is published as planned rather than as a type its services cannot
   * drive.
   */
  public planOptionsFor(node: IZWaveNode): PlanOptions {
    const applied = this.appliedOverrideFor(node);

    return applied ? { primaryOverride: applied.primaryKind } : {};
  }

  /** The type this node publishes, which is the override's when one is applied. */
  public primaryKindFor(node: IZWaveNode): PrimaryKind | undefined {
    return (
      this.appliedOverrideFor(node)?.primaryKind ??
      TypeOverrideResolver.defaultTypeFor(node).kind
    );
  }

  /** Where this node's published primary type comes from. */
  public sourceFor(node: IZWaveNode): TypeSource {
    return this.appliedOverrideFor(node)
      ? 'override'
      : TypeOverrideResolver.defaultTypeFor(node).source;
  }

  /**
   * Every node a decision about this hardware reaches: interviewed, single-endpoint and reporting
   * this fingerprint. A node that cannot take the current override stays in the cohort, because a
   * later write is validated against all of them and may well suit it.
   */
  public cohortFor(fingerprint: DeviceFingerprint): IZWaveNode[] {
    const key = fingerprintKey(fingerprint);

    return this.listNodes().filter((node) => {
      const theirs = TypeOverrideResolver.fingerprintOf(node);

      // The same question the write asks, so the cohort cannot hold a node a write would refuse.
      return (
        node.ready &&
        theirs !== undefined &&
        fingerprintKey(theirs) === key &&
        TypeOverrideResolver.isOverridable(node)
      );
    })
      .sort((one, other) => one.nodeId - other.nodeId);
  }

  /**
   * The types the cohort can be offered, which is what every one of its nodes could be published
   * as. A type one node cannot drive is not offered for the hardware, because the decision is
   * saved for the hardware and would reach that node too.
   */
  public optionsFor(fingerprint: DeviceFingerprint): PrimaryKind[] {
    const cohort = this.cohortFor(fingerprint);
    if (cohort.length === 0) {
      return [];
    }

    return cohort
      .map((node) => AccessoryFactory.compatiblePrimaryKinds(node))
      .reduce((shared, kinds) => shared.filter((kind) => kinds.includes(kind)));
  }

  /**
   * Names the state a decision was made against: the cohort's node numbers, what each one
   * reports, what each would publish without an override, what each publishes now, what each
   * could publish, and the stored decision itself.
   *
   * A write carries the revision it was composed against and is refused when it no longer
   * matches, because anything in that list can change between the page being drawn and Apply
   * being pressed, and each of those changes alters what the decision would do.
   */
  public cohortRevisionFor(fingerprint: DeviceFingerprint): string {
    const cohort = this.cohortFor(fingerprint).map((node) => ({
      nodeId: node.nodeId,
      fingerprint: TypeOverrideResolver.fingerprintOf(node),
      defaultKind: TypeOverrideResolver.defaultTypeFor(node).kind,
      primaryKind: this.primaryKindFor(node),
      compatible: AccessoryFactory.compatiblePrimaryKinds(node),
    }));
    const subject = { cohort, override: this.store.overrideFor(fingerprint) ?? null };

    return createHash('sha256').update(JSON.stringify(subject)).digest('hex').slice(0, 8);
  }

  /** Saves a type for the hardware this node reports, and for every node that reports it. */
  public setNodeType(request: SetTypeRequest): Promise<WriteResult> {
    return this.serialize(() => this.saveType(request));
  }

  /** Returns this hardware to what each of its nodes reports, and forgets where it was applied. */
  public clearNodeType(request: ClearTypeRequest): Promise<WriteResult> {
    return this.serialize(() => this.forgetType(request));
  }

  /**
   * Discards a decision no node can take. Refused while any node is published as it, because
   * that node would be rebuilt by a panel describing hardware it does not report.
   */
  public removeTypeOverride(request: RemoveTypeRequest): Promise<WriteResult> {
    return this.serialize(() => this.discardType(request));
  }

  /**
   * Accepts that a node number now reports other hardware, and drops the one record saying it
   * did not. The decision itself is untouched: the hardware it was made for may still exist.
   */
  public acknowledgeTypeOrphan(request: AcknowledgeOrphanRequest): Promise<WriteResult> {
    return this.serialize(() => this.dropOrphan(request));
  }

  /**
   * Brings the record of where the override has been applied up to date with what this node now
   * reports, and writes only when that record changes, because this runs on every node event.
   *
   * A store that refused its file knows of no override and no earlier record, so it finds nothing
   * to change and never reaches the write it would refuse.
   */
  public observe(node: IZWaveNode): Promise<void> {
    return this.serialize(() => this.record(node));
  }

  /**
   * Resolves once everything already queued has run.
   *
   * Recording where an override is applied is started by the sync and not waited on, because
   * publishing a device does not depend on it. A reply that describes the network does depend on
   * it, so the reply waits here rather than racing the records it has just caused.
   */
  public settled(): Promise<void> {
    return this.commands.then(() => undefined);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    // What is kept is the settled promise, never the rejected one, so a failed command is
    // waited on by the command behind it but does not refuse it.
    const run = this.commands.then(task);
    this.commands = run.catch(() => undefined);

    return run;
  }

  private async saveType(request: SetTypeRequest): Promise<WriteResult> {
    const subject = this.writeSubject(request, { fingerprint: true, revision: true });
    if ('refusal' in subject) {
      return refused(subject.refusal);
    }

    const { fingerprint, key, cohort } = subject;
    const { primaryKind } = request;
    const saved = this.store.overrideFor(fingerprint);

    if (!this.optionsFor(fingerprint).includes(primaryKind)) {
      return refused('unsupported-type');
    }
    if (saved?.primaryKind === primaryKind) {
      return refused('already-current');
    }
    if (
      cohort.every((node) => TypeOverrideResolver.defaultTypeFor(node).kind === primaryKind)
    ) {
      // Saving a decision that matches every default would leave a record of nothing, and
      // undoing one is what clearing is for, so each is sent back to the caller it belongs to.
      return refused(saved ? 'use-clear' : 'already-default');
    }

    const savedAt = this.clock.now();
    await this.store.update((data) => {
      const existing = data.overrides.find(
        (override) => fingerprintKey(override.fingerprint) === key,
      );
      if (existing) {
        existing.primaryKind = primaryKind;
        existing.savedAt = savedAt;
        return;
      }
      data.overrides.push({ fingerprint, primaryKind, savedAt });
    });

    return { rebuild: cohort.map((node) => node.nodeId) };
  }

  private async forgetType(request: ClearTypeRequest): Promise<WriteResult> {
    const subject = this.writeSubject(request, { fingerprint: true, revision: true });
    if ('refusal' in subject) {
      return refused(subject.refusal);
    }

    const { fingerprint, key, cohort } = subject;
    if (!this.store.overrideFor(fingerprint)) {
      return refused('no-override');
    }

    await this.store.update(forget(key));

    return { rebuild: cohort.map((node) => node.nodeId) };
  }

  private async discardType(request: RemoveTypeRequest): Promise<WriteResult> {
    const subject = this.writeSubject(request, { fingerprint: false, revision: true });
    if ('refusal' in subject) {
      return refused(subject.refusal);
    }

    const { fingerprint, key, cohort } = subject;
    if (!this.store.overrideFor(fingerprint)) {
      return refused('no-override');
    }
    if (cohort.some((node) => this.appliedOverrideFor(node))) {
      return refused('override-in-use');
    }

    await this.store.update(forget(key));

    return { rebuild: cohort.map((node) => node.nodeId) };
  }

  private async dropOrphan(request: AcknowledgeOrphanRequest): Promise<WriteResult> {
    const subject = this.writeSubject(request, { fingerprint: true, revision: false });
    if ('refusal' in subject) {
      return refused(subject.refusal);
    }

    const orphan = this.store
      .snapshot()
      .observations.find(
        (observation) =>
          observation.id === request.observationId &&
          observation.nodeId === request.nodeId &&
          // An active record is this plugin's own note that the decision is in force. Dropping
          // one would be discarding a fact rather than accepting a change of hardware.
          observation.orphanedAt !== null,
      );
    if (!orphan) {
      return refused('unknown-observation');
    }

    const orphanKey = fingerprintKey(orphan.fingerprint);
    await this.store.update((data) => {
      data.observations = data.observations.filter(
        (observation) =>
          observation.id !== orphan.id ||
          observation.nodeId !== orphan.nodeId ||
          fingerprintKey(observation.fingerprint) !== orphanKey,
      );
    });

    return { rebuild: [] };
  }

  /**
   * The state every write acts on, or why none of them can.
   *
   * Everything is recomputed from this plugin's own reading of the network. The request supplies
   * what the page believed, which is compared and never trusted, so a decision made against a
   * node that has since changed is refused rather than applied to whatever is there now.
   */
  private writeSubject(request: GuardedRequest, requires: RequiredGuards): WriteSubject {
    let expectedFingerprint: DeviceFingerprint | undefined;
    if (requires.fingerprint) {
      if (!isFingerprint(request.expectedFingerprint)) {
        return { refusal: 'incomplete-request' };
      }
      expectedFingerprint = request.expectedFingerprint;
    }

    let expectedRevision: string | undefined;
    if (requires.revision) {
      if (typeof request.expectedRevision !== 'string') {
        return { refusal: 'incomplete-request' };
      }
      expectedRevision = request.expectedRevision;
    }

    const node = this.listNodes().find((candidate) => candidate.nodeId === request.nodeId);
    if (!node) {
      return { refusal: 'unknown-node' };
    }
    if (this.store.readOnly) {
      return { refusal: 'read-only' };
    }

    const fingerprint = TypeOverrideResolver.fingerprintOf(node);
    if (!fingerprint || !TypeOverrideResolver.isOverridable(node) || !node.ready) {
      return { refusal: 'not-overridable' };
    }

    const key = fingerprintKey(fingerprint);
    if (expectedFingerprint && fingerprintKey(expectedFingerprint) !== key) {
      return { refusal: 'fingerprint-changed' };
    }
    if (expectedRevision !== undefined && expectedRevision !== this.cohortRevisionFor(fingerprint)) {
      return { refusal: 'cohort-changed' };
    }

    return { fingerprint, key, cohort: this.cohortFor(fingerprint) };
  }

  private async record(node: IZWaveNode): Promise<void> {
    const change = this.observationChange(node);
    if (!change) {
      return;
    }

    try {
      await this.store.update(change);
      this.reported.delete(node.nodeId);
    } catch (error) {
      if (this.reported.has(node.nodeId)) {
        return;
      }
      this.reported.add(node.nodeId);
      this.log.warn(
        `Could not record where the type override for Node ${node.nodeId} is applied. ` +
          `${describeError(error)} The type it publishes is unaffected.`,
      );
    }
  }

  /**
   * What this node's report changes about the record, or nothing when it changes none of it.
   *
   * The returned change decides from the data it is handed rather than from what was read here,
   * because writes are serialized: another node's write can land in between, and a second pass
   * for this node can be queued behind the first. Only the values a write cannot derive, the
   * time and the identifier, are taken now.
   */
  private observationChange(node: IZWaveNode): ((data: TypeOverrideData) => void) | undefined {
    // An interview that has not finished reports no fingerprint to compare, so it records nothing.
    if (!node.ready) {
      return undefined;
    }

    const fingerprint = TypeOverrideResolver.fingerprintOf(node);
    if (!fingerprint) {
      return undefined;
    }

    const key = fingerprintKey(fingerprint);
    const { nodeId } = node;
    const applied = this.appliedOverrideFor(node) !== undefined;
    const { observations } = this.store.snapshot();
    const mine = observations.find(
      (observation) => observation.nodeId === nodeId && fingerprintKey(observation.fingerprint) === key,
    );
    const orphaned = observations.some(
      (observation) =>
        observation.nodeId === nodeId &&
        observation.orphanedAt === null &&
        fingerprintKey(observation.fingerprint) !== key,
    );

    const records = applied && mine === undefined;
    const returns = applied && mine?.orphanedAt != null;
    if (!orphaned && !records && !returns) {
      return undefined;
    }

    const at = this.clock.now();
    const id = this.clock.newId();

    return (data) => {
      data.observations.forEach((observation) => {
        if (observation.nodeId !== nodeId) {
          return;
        }
        if (fingerprintKey(observation.fingerprint) !== key) {
          // The node number now reports other hardware, so what was recorded for it is orphaned.
          observation.orphanedAt ??= at;
          return;
        }
        if (applied) {
          // The hardware came back, so the record it left is revived rather than replaced.
          observation.orphanedAt = null;
        }
      });

      const recorded = data.observations.some(
        (observation) =>
          observation.nodeId === nodeId && fingerprintKey(observation.fingerprint) === key,
      );
      if (applied && !recorded) {
        data.observations.push({ id, nodeId, fingerprint, appliedAt: at, orphanedAt: null });
      }
    };
  }
}
