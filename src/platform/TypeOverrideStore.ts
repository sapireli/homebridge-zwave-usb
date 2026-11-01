import fs from 'fs';
import path from 'path';
import { Logger } from 'homebridge';
import { PRIMARY_KINDS, PrimaryKind } from '../accessories/AccessoryFactory';

/** The three identifiers that together name a device model. */
export interface DeviceFingerprint {
  manufacturerId: number;
  productType: number;
  productId: number;
}

/** The decision for one device model: every node reporting this fingerprint is published as this. */
export interface TypeOverride {
  fingerprint: DeviceFingerprint;
  primaryKind: PrimaryKind;
  savedAt: string;
}

/**
 * A record that an override has been applied to a node number on this network. It stores no type,
 * because the type shown is always the override's current one.
 */
export interface TypeObservation {
  id: string;
  nodeId: number;
  fingerprint: DeviceFingerprint;
  appliedAt: string;
  orphanedAt: string | null;
}

/** The whole file, as written. */
export interface TypeOverrideData {
  version: 1;
  homeId: string;
  overrides: TypeOverride[];
  observations: TypeObservation[];
}

const VERSION = 1;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Two devices are the same model when all three identifiers match. */
export function fingerprintKey(fingerprint: DeviceFingerprint): string {
  return `${fingerprint.manufacturerId}:${fingerprint.productType}:${fingerprint.productId}`;
}

export function isFingerprint(value: unknown): value is DeviceFingerprint {
  if (!isObject(value)) {
    return false;
  }

  return (
    Number.isInteger(value.manufacturerId) &&
    Number.isInteger(value.productType) &&
    Number.isInteger(value.productId)
  );
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * Why a saved file could not be used.
 *
 * The store names the fault and stops there. The view turns the code into the sentence a user
 * reads, and the log keeps the detail, so neither has to take apart a sentence the other wrote.
 */
export type StoreErrorCode =
  | 'permission-denied'
  | 'unreadable'
  | 'invalid-json'
  | 'unsupported-version'
  | 'wrong-network'
  | 'invalid-data';

/** A refused file: a code for the view, and a clause the log frame completes into a sentence. */
interface StoreProblem {
  code: StoreErrorCode;
  detail: string;
}

/** An error as a clause, without the full stop `describeError` ends its sentence with. */
const clauseOf = (error: unknown): string => describeError(error).replace(/\.$/, '');

const invalidData = (detail: string): StoreProblem => ({ code: 'invalid-data', detail });

/**
 * Reports what is wrong with a parsed file, or nothing when the file can be used. Anything this
 * rejects leaves the stored file untouched, so a file written by a later version of the plugin,
 * or damaged in place, is never overwritten by this one.
 */
function findProblem(parsed: unknown, homeId: string): StoreProblem | undefined {
  if (!isObject(parsed)) {
    return invalidData('it does not hold an object');
  }

  if (parsed.version !== VERSION) {
    return {
      code: 'unsupported-version',
      detail: `it is version ${JSON.stringify(parsed.version)}, and this plugin reads version ${VERSION}`,
    };
  }

  if (parsed.homeId !== homeId) {
    return { code: 'wrong-network', detail: `it names network ${JSON.stringify(parsed.homeId)}` };
  }

  if (!Array.isArray(parsed.overrides) || !Array.isArray(parsed.observations)) {
    return invalidData('it is missing its list of overrides or its list of observations');
  }

  const kinds = new Set<string>(PRIMARY_KINDS);
  const seenOverrides = new Set<string>();
  for (const override of parsed.overrides) {
    if (!isObject(override) || !isFingerprint(override.fingerprint)) {
      return invalidData('an override does not name a device');
    }
    if (typeof override.primaryKind !== 'string' || !kinds.has(override.primaryKind)) {
      return invalidData(
        `an override names the type ${JSON.stringify(override.primaryKind)}, which this plugin does not publish`,
      );
    }
    if (!isNonEmptyString(override.savedAt)) {
      return invalidData('an override does not record when it was saved');
    }

    const key = fingerprintKey(override.fingerprint);
    if (seenOverrides.has(key)) {
      return invalidData('two overrides name the same device');
    }
    seenOverrides.add(key);
  }

  const seenIds = new Set<string>();
  const seenObservations = new Set<string>();
  for (const observation of parsed.observations) {
    if (!isObject(observation) || !isFingerprint(observation.fingerprint)) {
      return invalidData('an observation does not name a device');
    }
    if (!isNonEmptyString(observation.id)) {
      return invalidData('an observation has no identifier');
    }
    if (!Number.isInteger(observation.nodeId)) {
      return invalidData('an observation does not name a node');
    }
    if (!isNonEmptyString(observation.appliedAt)) {
      return invalidData('an observation does not record when it was applied');
    }
    if (observation.orphanedAt !== null && !isNonEmptyString(observation.orphanedAt)) {
      return invalidData('an observation records an unreadable orphan time');
    }

    // Acknowledgment names one record by its identifier, so two records cannot share one.
    if (seenIds.has(observation.id)) {
      return invalidData('two observations share an identifier');
    }
    seenIds.add(observation.id);

    const key = `${observation.nodeId}@${fingerprintKey(observation.fingerprint)}`;
    if (seenObservations.has(key)) {
      return invalidData('two observations name the same node and device');
    }
    seenObservations.add(key);
  }

  return undefined;
}

/** A reason reads after the sentence before it, so a message from the system gets an end. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return /[.!?]$/.test(message) ? message : `${message}.`;
}

/**
 * The type overrides for one Z-Wave network, held in one file per network so that moving a
 * controller between Homebridge instances carries its decisions with it, and so that two networks
 * on one host never share a record.
 *
 * A file that cannot be read puts the store in read-only mode rather than starting empty.
 * Starting empty would publish every device at its detected type, which looks like the overrides
 * were deliberately cleared, and the first write would then replace a file that was only
 * unreadable.
 */
export class TypeOverrideStore {
  /** The low 32 bits of the home ID, which is how a Z-Wave network is named in writing. */
  public static homeIdHex(homeId: number): string {
    return (homeId >>> 0).toString(16).padStart(8, '0');
  }

  public static fileNameFor(homeId: number): string {
    return `homebridge-zwave-usb-overrides-${TypeOverrideStore.homeIdHex(homeId)}.json`;
  }

  public readonly filePath: string;

  private readonly homeIdHex: string;
  private data: TypeOverrideData;
  private problem?: StoreProblem;
  private pending: Promise<unknown> = Promise.resolve();
  private temporaryFiles = 0;

  constructor(
    private readonly directory: string,
    homeId: number,
    private readonly log: Logger,
  ) {
    this.homeIdHex = TypeOverrideStore.homeIdHex(homeId);
    this.filePath = path.join(directory, TypeOverrideStore.fileNameFor(homeId));
    this.data = { version: VERSION, homeId: this.homeIdHex, overrides: [], observations: [] };
  }

  /** Why writes are refused, or nothing when the store is usable. */
  public get readOnlyCode(): StoreErrorCode | undefined {
    return this.problem?.code;
  }

  public get readOnly(): boolean {
    return this.problem !== undefined;
  }

  /**
   * Reads the file. Synchronous because every classification that follows depends on it: loading
   * it afterward would publish the detected graph first and rebuild it immediately.
   */
  public load(): void {
    let contents: string;
    try {
      contents = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        this.log.debug(`No saved type overrides for network ${this.homeIdHex}.`);
        return;
      }

      // Permission is the one read failure a user can act on, so it is named rather than relayed.
      this.refuse(
        errno === 'EACCES' || errno === 'EPERM'
          ? { code: 'permission-denied', detail: 'permission denied' }
          : { code: 'unreadable', detail: clauseOf(error) },
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      this.refuse({ code: 'invalid-json', detail: `not valid JSON (${clauseOf(error)})` });
      return;
    }

    const problem = findProblem(parsed, this.homeIdHex);
    if (problem) {
      this.refuse(problem);
      return;
    }

    this.data = parsed as TypeOverrideData;
    const count = this.data.overrides.length;
    this.log.debug(
      `Loaded ${count} saved type ${count === 1 ? 'override' : 'overrides'} for network ${this.homeIdHex}.`,
    );
  }

  /** The current contents, copied, so that a caller cannot change the store by holding onto it. */
  public snapshot(): TypeOverrideData {
    return structuredClone(this.data);
  }

  public overrideFor(fingerprint: DeviceFingerprint): TypeOverride | undefined {
    const key = fingerprintKey(fingerprint);
    return this.data.overrides.find((override) => fingerprintKey(override.fingerprint) === key);
  }

  public observationsFor(fingerprint: DeviceFingerprint): TypeObservation[] {
    const key = fingerprintKey(fingerprint);
    return this.data.observations.filter(
      (observation) => fingerprintKey(observation.fingerprint) === key,
    );
  }

  /**
   * Replaces the file with the result of `change`, applied to a copy of the current contents.
   * Calls are serialized, so two writes started together are applied in the order they were made
   * rather than one overwriting the other's base.
   */
  public async update(change: (data: TypeOverrideData) => void): Promise<TypeOverrideData> {
    return this.enqueue(async () => {
      if (this.problem) {
        throw new Error(`Saved type overrides are read-only. ${this.problem}`);
      }

      const next = structuredClone(this.data);
      change(next);
      next.version = VERSION;
      next.homeId = this.homeIdHex;

      await this.writeAtomically(`${JSON.stringify(next, null, 2)}\n`);
      this.data = next;

      return structuredClone(next);
    });
  }

  /**
   * The one place the fault is written out in full. The panel says only that the overrides are
   * unavailable and sends the reader here, so this names the file even when the fault is in its
   * contents rather than in reaching it.
   */
  private refuse(problem: StoreProblem): void {
    this.problem = problem;
    this.log.error(
      `Could not load saved type overrides for network ${this.homeIdHex} from ${this.filePath}: ` +
        `${problem.detail}. No overrides were applied, editing is disabled, and the file was ` +
        'left unchanged.',
    );
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // What is kept is the settled promise, never the rejected one, so a failed write is waited
    // on by the write behind it but does not refuse it.
    const run = this.pending.then(task);
    this.pending = run.catch(() => undefined);

    return run;
  }

  private async writeAtomically(contents: string): Promise<void> {
    await fs.promises.mkdir(this.directory, { recursive: true });

    this.temporaryFiles += 1;
    const temporary = `${this.filePath}.${process.pid}.${this.temporaryFiles}.tmp`;

    try {
      const handle = await fs.promises.open(temporary, 'w');
      try {
        await handle.writeFile(contents, 'utf8');
        // The rename only replaces the file atomically once these bytes are on the disk.
        await handle.sync();
      } finally {
        await handle.close();
      }

      await fs.promises.rename(temporary, this.filePath);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
