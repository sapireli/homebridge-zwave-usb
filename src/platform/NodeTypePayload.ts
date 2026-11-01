import { AccessoryFactory, PrimaryKind } from '../accessories/AccessoryFactory';
import { IZWaveNode } from '../zwave/interfaces';
import { TypeOverrideResolver, TypeSource } from './TypeOverrideResolver';
import { DeviceFingerprint, StoreErrorCode, TypeOverride } from './TypeOverrideStore';

/**
 * One endpoint's published type, named by the endpoint it belongs to.
 *
 * The index is carried rather than the position in a list, because an endpoint that publishes
 * no primary type contributes no entry: after that, position names nothing.
 */
export interface EndpointType {
  endpointIndex: number;
  primaryKind: PrimaryKind;
}

/** One node the decision about this hardware reaches. */
export interface CohortMember {
  nodeId: number;
  name: string;
  /** Whether Matter publishes this node, which decides whether a change to it needs a restart. */
  matterActive: boolean;
  primaryKind: PrimaryKind | null;
  defaultKind: PrimaryKind | null;
  /** Whether the saved override is in effect here, and null while the hardware has none. */
  takesOverride: boolean | null;
}

/** The saved override this node cannot be published as, and the nodes still publishing it. */
export interface InvalidOverrideReport {
  primaryKind: PrimaryKind;
  appliedTo: { nodeId: number; name: string }[];
}

/** A record that this node number once carried an override, written when its hardware changed. */
export interface OrphanReport {
  observationId: string;
  fingerprint: DeviceFingerprint;
  primaryKind: PrimaryKind | null;
  appliedAt: string;
  orphanedAt: string;
}

/** Everything the node detail view draws, as values rather than sentences. */
export interface NodeTypePayload {
  nodeId: number;
  fingerprint: DeviceFingerprint | null;
  label: string | null;
  multiEndpoint: boolean;
  primaryKind: PrimaryKind | null;
  /**
   * What each endpoint publishes, in endpoint order.
   *
   * A device with one endpoint publishes one type, and this repeats `primaryKind`. A device with
   * several publishes one per endpoint and has no single type, so `primaryKind` is null and this
   * is the only reading of what it publishes. The root endpoint of such a device is deliberately
   * left empty by the planner, because its children carry the functions, so it adds no entry.
   */
  endpointTypes: EndpointType[];
  source: TypeSource;
  defaultKind: PrimaryKind | null;
  defaultSource: 'registry' | 'detected';
  registryLabel: string | null;
  options: PrimaryKind[];
  override: TypeOverride | null;
  cohort: CohortMember[];
  cohortRevision: string;
  invalid: InvalidOverrideReport | null;
  orphans: OrphanReport[];
  store: { readable: boolean; error: { code: StoreErrorCode } | null };
  /**
   * Set while this node publishes something other than the decision saved for it, because the
   * rebuild that would have applied it failed. Everything else here describes the saved
   * decision, so without this the panel would report the new type as published from the next
   * refresh onwards, having said a moment earlier that it could not be applied.
   */
  rebuildFailure: { error: string } | null;
  matterActive: boolean;
}

/** What the plugin knows about a node that the resolver does not decide. */
export interface PayloadContext {
  /**
   * Whether Matter publishes a given node, asked per node rather than once for the one whose
   * page is open. A decision reaches every node sharing the fingerprint, and the restart it
   * needs is disclosed for whichever of them Matter is publishing.
   */
  matterPublishes: (nodeId: number) => boolean;
  /** The error from the last rebuild of this node, until one succeeds or the plugin restarts. */
  rebuildFailure: string | null;
}

const nameOf = (node: IZWaveNode): string => node.name || `Node ${node.nodeId}`;

/**
 * What each endpoint publishes.
 *
 * A planned endpoint names the type it was detected as, which is the type an override replaces
 * rather than the one that reaches HomeKit, so the published type is read from the resolver for
 * the single endpoint that can carry a decision. A device with several endpoints never carries
 * one, so each of its endpoints publishes what it was detected as.
 */
const endpointTypesOf = (node: IZWaveNode, published?: PrimaryKind): EndpointType[] => {
  const endpoints = node.getAllEndpoints();
  if (endpoints.length === 1) {
    return published ? [{ endpointIndex: endpoints[0].index, primaryKind: published }] : [];
  }

  return AccessoryFactory.planFeatures(node).flatMap((plan) =>
    plan.primaryKind === undefined
      ? []
      : [{ endpointIndex: plan.endpoint.index, primaryKind: plan.primaryKind }],
  );
};

/**
 * Describes one node's type decision.
 *
 * Nothing here is a sentence. The view renders the words, so the same payload serves the row
 * notice, the detail view and the confirmation dialogs without any of them parsing text.
 */
export function buildNodeTypePayload(
  resolver: TypeOverrideResolver,
  node: IZWaveNode,
  context: PayloadContext,
): NodeTypePayload {
  const fingerprint = TypeOverrideResolver.fingerprintOf(node) ?? null;
  const defaults = TypeOverrideResolver.defaultTypeFor(node);
  const override = resolver.savedOverrideFor(node) ?? null;

  /**
   * A decision is about hardware, and it is composed only from the nodes it reaches. Whether
   * this node is one of them is read from the cohort itself rather than tested again here, so
   * a node that is absent from its own hardware's scope is never shown that scope: a node with
   * several endpoints, and one whose interview has not finished, both report their own type and
   * no cohort, because neither can take part in a decision about the others.
   */
  const published = resolver.primaryKindFor(node);
  const reached = fingerprint ? resolver.cohortFor(fingerprint) : [];
  const participates = fingerprint !== null && reached.some((m) => m.nodeId === node.nodeId);
  const cohort = participates ? reached : [];
  /**
   * The state the page was drawn from, so a write composed against it can be refused once any of
   * it has moved. A node outside a cohort has none to pin and is offered nothing.
   */
  const scope =
    participates && fingerprint
      ? {
          options: resolver.optionsFor(fingerprint),
          cohortRevision: resolver.cohortRevisionFor(fingerprint),
        }
      : { options: [], cohortRevision: '' };

  const invalid = resolver.invalidOverrideFor(node);
  const orphans = resolver.store
    .snapshot()
    .observations.filter(
      (observation) => observation.nodeId === node.nodeId && observation.orphanedAt !== null,
    )
    .sort((one, other) => String(other.orphanedAt).localeCompare(String(one.orphanedAt)))
    .map((observation) => ({
      observationId: observation.id,
      fingerprint: observation.fingerprint,
      /** The type shown is the override's current one, which is the hardware's, not the node's. */
      primaryKind: resolver.store.overrideFor(observation.fingerprint)?.primaryKind ?? null,
      appliedAt: observation.appliedAt,
      orphanedAt: String(observation.orphanedAt),
    }));

  return {
    nodeId: node.nodeId,
    fingerprint,
    label: node.label || node.deviceConfig?.label || null,
    multiEndpoint: node.getAllEndpoints().length > 1,
    primaryKind: published ?? null,
    endpointTypes: endpointTypesOf(node, published),
    source: resolver.sourceFor(node),
    defaultKind: defaults.kind ?? null,
    defaultSource: defaults.source,
    registryLabel: defaults.registryLabel,
    options: scope.options,
    override,
    cohort: cohort.map((member) => ({
      nodeId: member.nodeId,
      name: nameOf(member),
      matterActive: context.matterPublishes(member.nodeId),
      primaryKind: resolver.primaryKindFor(member) ?? null,
      defaultKind: TypeOverrideResolver.defaultTypeFor(member).kind ?? null,
      takesOverride: override ? resolver.appliedOverrideFor(member) !== undefined : null,
    })),
    cohortRevision: scope.cohortRevision,
    invalid: invalid
      ? {
          primaryKind: invalid.primaryKind,
          appliedTo: cohort
            .filter((member) => resolver.appliedOverrideFor(member) !== undefined)
            .map((member) => ({ nodeId: member.nodeId, name: nameOf(member) })),
        }
      : null,
    orphans,
    store: {
      readable: !resolver.store.readOnly,
      error: resolver.store.readOnlyCode ? { code: resolver.store.readOnlyCode } : null,
    },
    rebuildFailure: context.rebuildFailure ? { error: context.rebuildFailure } : null,
    matterActive: context.matterPublishes(node.nodeId),
  };
}

/** What a node row shows about its type, which is a summary of the same decision. */
export interface NodeTypeSummary {
  typeOverride: { primaryKind: PrimaryKind; sharedWith: number[] } | null;
  typeInvalid: boolean;
  typeOrphans: number;
  /** Set while the node publishes something other than the decision saved for it. */
  typeRebuildFailed: boolean;
}

/** The row-sized view of the same facts, so the table does not fetch a payload per node. */
export function summarizeNodeType(
  resolver: TypeOverrideResolver,
  node: IZWaveNode,
  rebuildFailed: boolean,
): NodeTypeSummary {
  const applied = resolver.appliedOverrideFor(node);
  const fingerprint = TypeOverrideResolver.fingerprintOf(node);

  return {
    typeOverride: applied
      ? {
          primaryKind: applied.primaryKind,
          sharedWith: (fingerprint ? resolver.cohortFor(fingerprint) : [])
            .filter(
              (member) =>
                member.nodeId !== node.nodeId &&
                resolver.appliedOverrideFor(member) !== undefined,
            )
            .map((member) => member.nodeId),
        }
      : null,
    typeInvalid: resolver.invalidOverrideFor(node) !== undefined,
    typeRebuildFailed: rebuildFailed,
    typeOrphans: resolver.store
      .snapshot()
      .observations.filter(
        (observation) => observation.nodeId === node.nodeId && observation.orphanedAt !== null,
      ).length,
  };
}
