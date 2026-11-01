import { CommandClasses, encodePartial, type ValueID, type ValueMetadata } from '@zwave-js/core';
import type { IZWaveNode } from '../zwave/interfaces';

/** One entry of a parameter's permitted set: a single value, or a range it may step through. */
export type AllowedValue =
  | { kind: 'value'; value: number }
  | { kind: 'range'; from: number; to: number; step: number | null };

/**
 * What the device says about one value: a whole parameter, or one bitmask field of a parameter
 * several fields share.
 *
 * The metadata is carried rather than flattened, because item 16 writes through the same shape and
 * a viewer that drops `allowed` or `writeable` leaves an editor with nothing to validate against.
 */
export interface ParameterValue {
  /** Set where this is one field of a shared parameter, which zwave-js addresses by bitmask. */
  bitMask: number | null;
  value: number | null;
  /** When the node last reported it, from `getValueTimestamp`, or null where none is recorded. */
  reportedAt: number | null;
  label: string | null;
  description: string | null;
  unit: string | null;
  min: number | null;
  max: number | null;
  defaultValue: number | null;
  recommended: number | null;
  states: Record<number, string> | null;
  allowed: AllowedValue[] | null;
  format: number | null;
  valueSize: number | null;
  advanced: boolean;
  requiresReInclusion: boolean;
  destructive: boolean;
  allowManualEntry: boolean;
  fromConfig: boolean;
  readable: boolean;
  writable: boolean;
}

/**
 * One parameter number on one endpoint.
 *
 * A parameter is either an ordinary value or a set of bitmask fields. zwave-js addresses both with
 * the same property number, so grouping them here is what stops one parameter being drawn as
 * several rows, or one of its fields being drawn as though it were the whole parameter.
 */
export interface ParameterGroup {
  endpoint: number;
  parameter: number;
  partial: boolean;
  values: ParameterValue[];
  /**
   * The number the device holds for this parameter, where it can be stated.
   *
   * For an ordinary parameter it is that parameter's value. For a set of fields it is composed
   * from them, and only when they cover the whole width, because the bits no field describes
   * cannot be known. It is never read from the cached whole-parameter value ID: once fields are
   * defined, a report updates the fields and leaves that ID behind.
   */
  raw: number | null;
}

/** Which of the four situations the section is in. An unfinished interview outranks the rest. */
export type ParametersState = 'interviewing' | 'unsupported' | 'none' | 'parameters';

export interface NodeParametersPayload {
  nodeId: number;
  state: ParametersState;
  groups: ParameterGroup[];
  /** Whether the device is awake to answer, which decides what a re-read can promise. */
  listening: boolean;
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * zwave-js reports a permitted set as single values and as ranges. A range is `{ from, to, step? }`
 * in its own definition, and an entry that is neither is dropped rather than turned into a range
 * of zero to zero, which would read as a device permitting only the number 0.
 *
 * A range whose step is there at all but is not a positive whole number describes no sequence,
 * and is dropped entirely rather than reduced to a range with no step. A step stated as null is
 * stated, not omitted. The two are not the same thing:
 * a range with no step permits every number it covers, so reading nonsense as absence would turn
 * malformed metadata into a wider permission than the device ever offered.
 */
function allowedValuesOf(metadata: Record<string, unknown>): AllowedValue[] | null {
  /**
   * Absence is the only thing that means no restriction. Everything else the device said is an
   * attempt at stating one, however badly, and an attempt nobody can read permits nothing.
   */
  if (metadata.allowed === undefined) {
    return null;
  }

  const allowed = metadata.allowed;
  if (!Array.isArray(allowed)) {
    return [];
  }

  const entries: AllowedValue[] = [];

  for (const entry of allowed) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const candidate = entry as { value?: unknown; from?: unknown; to?: unknown; step?: unknown };
    const single = asNumber(candidate.value);

    if (single !== null) {
      entries.push({ kind: 'value', value: single });
      continue;
    }

    const from = asNumber(candidate.from);
    const to = asNumber(candidate.to);
    if (from === null || to === null) {
      continue;
    }

    const stated = candidate.step !== undefined;
    const step = asNumber(candidate.step);

    if (stated && (step === null || !Number.isInteger(step) || step < 1)) {
      continue;
    }

    entries.push({ kind: 'range', from, to, step });
  }

  /**
   * An empty set is not the same as no set. Null says the device stated no permitted values, and
   * a reader may use the whole range. An empty array says it stated some and none of them could
   * be read, which permits nothing: the writer refuses against it rather than treating unreadable
   * metadata as permission to write anything. The section draws neither.
   */
  return entries;
}

function describeValue(
  node: IZWaveNode,
  valueId: ValueID,
  bitMask: number | null,
): ParameterValue {
  const metadata = (node.getValueMetadata(valueId) ?? {}) as ValueMetadata &
    Record<string, unknown>;
  const timestamp = node.getValueTimestamp(valueId);

  return {
    bitMask,
    value: asNumber(node.getValue(valueId)),
    reportedAt: asNumber(timestamp),
    label: asText(metadata.label),
    description: asText(metadata.description),
    unit: asText(metadata.unit),
    min: asNumber(metadata.min),
    max: asNumber(metadata.max),
    defaultValue: asNumber(metadata.default),
    recommended: asNumber(metadata.recommended),
    states:
      metadata.states && typeof metadata.states === 'object'
        ? (metadata.states as Record<number, string>)
        : null,
    allowed: allowedValuesOf(metadata),
    format: asNumber(metadata.format),
    valueSize: asNumber(metadata.valueSize),
    advanced: metadata.isAdvanced === true,
    requiresReInclusion: metadata.requiresReInclusion === true,
    destructive: metadata.destructive === true,
    allowManualEntry: metadata.allowManualEntry !== false,
    fromConfig: metadata.isFromConfig === true,
    /** Both are required on the base metadata, so an absent one means the default, which is true. */
    readable: metadata.readable !== false,
    writable: metadata.writeable !== false,
  };
}

/**
 * The number the fields add up to, or null where they do not account for every bit.
 *
 * Composed with zwave-js's own `encodePartial`, so the arithmetic cannot drift from the arithmetic
 * that produced the fields. A field with no value, or a set of masks that leaves bits undescribed,
 * means the whole number cannot be stated, and stating one anyway would invent the missing bits.
 */
function composeRaw(values: ParameterValue[]): number | null {
  if (values.length === 0) {
    return null;
  }

  /**
   * One width, agreed by every field. Taking the first one offered would let a field that
   * disagrees about how wide the parameter is be folded into a number stated as complete.
   */
  const width = values[0].valueSize;
  if (width === null || !Number.isInteger(width) || width < 1 || width > 4) {
    return null;
  }
  if (values.some((value) => value.valueSize !== width)) {
    return null;
  }

  // 1 << 32 overflows, so the full-width case is stated rather than computed.
  const full = (width === 4 ? 0xffffffff : (1 << (width * 8)) - 1) >>> 0;
  let covered = 0;
  let composed = 0;

  for (const value of values) {
    const mask = value.bitMask;

    if (mask === null || value.value === null) {
      return null;
    }
    if (!Number.isInteger(mask) || mask <= 0 || (mask >>> 0) > full) {
      return null;
    }
    // Two fields claiming the same bit cannot both be right, and either order composes a
    // different number, so neither is reported.
    if ((covered & mask) !== 0) {
      return null;
    }

    covered |= mask;
    composed = encodePartial(composed, value.value, mask);
  }

  return (covered >>> 0) === full ? composed >>> 0 : null;
}

/**
 * Whether any endpoint can carry configuration parameters.
 *
 * `supportsCC` answers for one endpoint, and the node is its own root, so a device whose child
 * endpoint holds the parameters reports no support at the root. A value the interview already
 * established is better evidence than the support flag either way.
 */
function supportsConfiguration(node: IZWaveNode, hasValues: boolean): boolean {
  if (hasValues) {
    return true;
  }

  const endpoints = typeof node.getAllEndpoints === 'function' ? node.getAllEndpoints() : [];
  const reported = endpoints.some((endpoint) =>
    typeof endpoint?.supportsCC === 'function'
      ? endpoint.supportsCC(CommandClasses.Configuration)
      : false,
  );

  return reported || node.supportsCC(CommandClasses.Configuration);
}

export function buildNodeParametersPayload(node: IZWaveNode): NodeParametersPayload {
  /**
   * A frequently listening device reports its beam interval, "250ms" or "1000ms", never `true`:
   * `FLiRS` is `false | "250ms" | "1000ms"`. Comparing against `true` would call every FLiRS
   * device asleep and offer it the wording for a device that cannot be reached until it wakes.
   */
  const listening = Boolean(node.isListening) || Boolean(node.isFrequentListening);

  if (!node.ready) {
    // An interview that has not finished has not yet discovered what the device supports, so it
    // outranks every other answer rather than being reported as a device with nothing.
    return { nodeId: node.nodeId, state: 'interviewing', groups: [], listening };
  }

  const valueIds = (
    typeof node.getDefinedValueIDs === 'function' ? node.getDefinedValueIDs() : []
  ).filter((valueId) => valueId.commandClass === CommandClasses.Configuration);

  if (!supportsConfiguration(node, valueIds.length > 0)) {
    return { nodeId: node.nodeId, state: 'unsupported', groups: [], listening };
  }

  if (valueIds.length === 0) {
    return { nodeId: node.nodeId, state: 'none', groups: [], listening };
  }

  const byGroup = new Map<string, { endpoint: number; parameter: number; ids: ValueID[] }>();

  for (const valueId of valueIds) {
    const endpoint = valueId.endpoint ?? 0;
    const parameter = Number(valueId.property);
    if (!Number.isFinite(parameter)) {
      continue;
    }

    const key = `${endpoint}:${parameter}`;
    if (!byGroup.has(key)) {
      byGroup.set(key, { endpoint, parameter, ids: [] });
    }
    byGroup.get(key)!.ids.push(valueId);
  }

  const groups: ParameterGroup[] = [...byGroup.values()]
    .map(({ endpoint, parameter, ids }) => {
      const partials = ids.filter((valueId) => typeof valueId.propertyKey === 'number');

      if (partials.length > 0) {
        const values = partials
          .map((valueId) => describeValue(node, valueId, valueId.propertyKey as number))
          .sort((one, other) => (one.bitMask ?? 0) - (other.bitMask ?? 0));

        return { endpoint, parameter, partial: true, values, raw: composeRaw(values) };
      }

      const values = ids.slice(0, 1).map((valueId) => describeValue(node, valueId, null));

      return {
        endpoint,
        parameter,
        partial: false,
        values,
        raw: values[0]?.value ?? null,
      };
    })
    .sort((one, other) => one.endpoint - other.endpoint || one.parameter - other.parameter);

  return { nodeId: node.nodeId, state: 'parameters', groups, listening };
}
