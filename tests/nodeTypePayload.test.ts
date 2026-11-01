import fs from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from 'homebridge';
import {
  buildNodeTypePayload,
  summarizeNodeType,
} from '../src/platform/NodeTypePayload';
import { TypeOverrideResolver } from '../src/platform/TypeOverrideResolver';
import { DeviceFingerprint, TypeOverrideStore } from '../src/platform/TypeOverrideStore';
import { IZWaveNode } from '../src/zwave/interfaces';
import { NodeIdentity, REALISTIC_DEVICES, buildNode } from './fixtures/realisticDevices';

describe('node type payload', () => {
  const HOME_ID = 0xe4a1c0f2;
  const FILE = 'homebridge-zwave-usb-overrides-e4a1c0f2.json';

  const SHADE: DeviceFingerprint = { manufacturerId: 2748, productType: 2, productId: 16 };
  const GONE: DeviceFingerprint = { manufacturerId: 1, productType: 2, productId: 3 };
  const RSZ1: DeviceFingerprint = { manufacturerId: 0x026e, productType: 0x5253, productId: 0x5a31 };
  const RSZ1_LABEL = 'Springs Window Fashions RSZ1 (Somfy Motorized Shade)';

  let directory: string;
  let log: jest.Mocked<Logger>;
  let nodes: IZWaveNode[];

  const named = (name: string) => {
    const device = REALISTIC_DEVICES.find((candidate) => candidate.name === name);
    if (!device) {
      throw new Error(`No realistic device named ${name}`);
    }
    return device;
  };

  const node = (name: string, identity: NodeIdentity = {}) =>
    buildNode(named(name), { ...SHADE, ...identity });

  /** A shade that reports only Multilevel Switch, which is what an override redirects. */
  const shade = (identity: NodeIdentity = {}) =>
    node('covering (Multilevel Switch only)', identity);

  const override = (fingerprint: DeviceFingerprint, primaryKind: string) => ({
    fingerprint,
    primaryKind,
    savedAt: '2026-10-12T18:20:00Z',
  });

  const observation = (
    id: string,
    nodeId: number,
    fingerprint: DeviceFingerprint,
    orphanedAt: string | null = null,
  ) => ({ id, nodeId, fingerprint, appliedAt: '2026-09-30T17:02:00Z', orphanedAt });

  const resolver = (overrides: unknown[] = [], observations: unknown[] = []) => {
    fs.writeFileSync(
      path.join(directory, FILE),
      JSON.stringify({ version: 1, homeId: 'e4a1c0f2', overrides, observations }),
    );
    const store = new TypeOverrideStore(directory, HOME_ID, log);
    store.load();
    return new TypeOverrideResolver(store, () => nodes, log);
  };

  const payloadFor = (
    target: IZWaveNode,
    built = resolver(),
    matterActive: boolean | ((nodeId: number) => boolean) = true,
    rebuildFailure: string | null = null,
  ) =>
    buildNodeTypePayload(built, target, {
      matterPublishes:
        typeof matterActive === 'function' ? matterActive : () => matterActive,
      rebuildFailure,
    });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zwave-payload-'));
    log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;
    nodes = [];
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('what the device reports', () => {
    it('describes a node with no decision saved for its hardware', () => {
      nodes = [shade({ nodeId: 10 })];

      expect(payloadFor(nodes[0])).toMatchObject({
        nodeId: 10,
        fingerprint: SHADE,
        multiEndpoint: false,
        primaryKind: 'multilevel-switch',
        endpointTypes: [{ endpointIndex: 0, primaryKind: 'multilevel-switch' }],
        source: 'detected',
        defaultKind: 'multilevel-switch',
        defaultSource: 'detected',
        registryLabel: null,
        options: ['window-covering', 'multilevel-switch'],
        override: null,
        invalid: null,
        orphans: [],
        store: { readable: true, error: null },
        matterActive: true,
      });
    });

    it('credits the registry when the registry chose the type', () => {
      nodes = [shade({ nodeId: 5, ...RSZ1 })];

      expect(payloadFor(nodes[0])).toMatchObject({
        primaryKind: 'window-covering',
        source: 'registry',
        defaultKind: 'window-covering',
        defaultSource: 'registry',
        registryLabel: RSZ1_LABEL,
      });
    });

    it('reports the name the user gave the node and the model it reports', () => {
      nodes = [shade({ nodeId: 15, name: 'Porch Shade', label: 'SH-200' })];

      expect(payloadFor(nodes[0])).toMatchObject({ label: 'SH-200' });
      expect(payloadFor(nodes[0]).cohort[0]).toMatchObject({ name: 'Porch Shade' });
    });

    it('falls back to the model the device database names', () => {
      nodes = [{ ...shade({ nodeId: 15 }), deviceConfig: { label: 'From database' } } as IZWaveNode];

      expect(payloadFor(nodes[0]).label).toBe('From database');
    });

    it('names an unnamed node by its number, so a chip is never blank', () => {
      nodes = [shade({ nodeId: 15 })];

      expect(payloadFor(nodes[0]).cohort[0].name).toBe('Node 15');
      expect(payloadFor(nodes[0]).label).toBeNull();
    });

    it('carries whether Matter is publishing, which decides the restart disclosure', () => {
      nodes = [shade({ nodeId: 10 })];

      expect(payloadFor(nodes[0], resolver(), false).matterActive).toBe(false);
    });

    it('says which of the nodes sharing the hardware Matter publishes', () => {
      /**
       * A decision reaches every node with this fingerprint, so the restart Matter needs is a
       * question about each of them. Asking it only of the node whose page is open leaves a
       * reader changing a device that stays as it was in Alexa with nothing said about it.
       */
      nodes = [shade({ nodeId: 10, name: 'Hallway' }), shade({ nodeId: 11, name: 'Office' })];

      const payload = payloadFor(nodes[0], undefined, (nodeId: number) => nodeId === 11);

      expect(payload.matterActive).toBe(false);
      expect(payload.cohort.map((member) => [member.nodeId, member.matterActive])).toEqual([
        [10, false],
        [11, true],
      ]);
    });

  });

  describe('the hardware a decision reaches', () => {
    it('lists every node reporting the fingerprint, with the current node among them', () => {
      nodes = [shade({ nodeId: 10, name: 'Hallway' }), shade({ nodeId: 11, name: 'Office' })];

      expect(payloadFor(nodes[0]).cohort).toEqual([
        {
          nodeId: 10,
          name: 'Hallway',
          matterActive: true,
          primaryKind: 'multilevel-switch',
          defaultKind: 'multilevel-switch',
          takesOverride: null,
        },
        {
          nodeId: 11,
          name: 'Office',
          matterActive: true,
          primaryKind: 'multilevel-switch',
          defaultKind: 'multilevel-switch',
          takesOverride: null,
        },
      ]);
    });

    it('says a node takes the override only once one is saved', () => {
      nodes = [shade({ nodeId: 10 }), shade({ nodeId: 11 })];
      const built = resolver([override(SHADE, 'window-covering')]);

      expect(payloadFor(nodes[0], built)).toMatchObject({
        primaryKind: 'window-covering',
        source: 'override',
        defaultKind: 'multilevel-switch',
        override: { primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
      });
      expect(payloadFor(nodes[0], built).cohort.map((member) => member.takesOverride)).toEqual([
        true,
        true,
      ]);
    });

    it('reports the endpoint as publishing the override, not what it would have published', () => {
      nodes = [shade({ nodeId: 10 })];
      const built = resolver([override(SHADE, 'window-covering')]);

      // One endpoint publishes one type, so the two readings of it have to agree.
      expect(payloadFor(nodes[0], built)).toMatchObject({
        primaryKind: 'window-covering',
        endpointTypes: [{ endpointIndex: 0, primaryKind: 'window-covering' }],
      });
    });

    it('offers only types every node in the cohort could be published as', () => {
      nodes = [shade({ nodeId: 10 }), node('relay', { nodeId: 11 })];

      // The shade offers a covering and the relay offers a siren, and neither offers the other.
      expect(payloadFor(nodes[0]).options).toEqual([]);
    });

    it('pins the state the page was drawn from, and moves when that state moves', () => {
      nodes = [shade({ nodeId: 10 })];
      const alone = payloadFor(nodes[0]).cohortRevision;

      nodes = [nodes[0], shade({ nodeId: 11 })];

      expect(alone).toHaveLength(8);
      expect(payloadFor(nodes[0]).cohortRevision).not.toBe(alone);
    });
  });

  describe('a node outside its own hardware scope', () => {
    it('shows no scope while the interview has not finished', () => {
      nodes = [shade({ nodeId: 10 }), shade({ nodeId: 11, ready: false })];

      // Node 10 is interviewed and reports the same hardware, so a scope exists; node 11 is not
      // part of it and is not shown a decision it cannot take part in.
      expect(payloadFor(nodes[1])).toMatchObject({
        fingerprint: SHADE,
        cohort: [],
        options: [],
        cohortRevision: '',
      });
      expect(payloadFor(nodes[0]).cohort).toHaveLength(1);
    });

    it('reports no fingerprint before the device has named itself', () => {
      nodes = [shade({ nodeId: 12, manufacturerId: undefined })];

      expect(payloadFor(nodes[0])).toMatchObject({
        fingerprint: null,
        cohort: [],
        options: [],
        cohortRevision: '',
      });
    });

    it('reports each endpoint of a device that has several, which has no single type', () => {
      nodes = [node('relay', { nodeId: 13, endpoints: 2 })];

      expect(payloadFor(nodes[0])).toMatchObject({
        multiEndpoint: true,
        primaryKind: null,
        defaultKind: null,
        endpointTypes: [{ endpointIndex: 1, primaryKind: 'binary-switch' }],
        cohort: [],
        options: [],
        cohortRevision: '',
      });
    });
  });

  describe('a saved override this device cannot take', () => {
    it('names the type and the nodes still publishing it', () => {
      nodes = [shade({ nodeId: 10, name: 'Hallway' }), node('relay', { nodeId: 11 })];
      const built = resolver([override(SHADE, 'window-covering')]);

      expect(payloadFor(nodes[1], built)).toMatchObject({
        primaryKind: 'binary-switch',
        source: 'detected',
        invalid: {
          primaryKind: 'window-covering',
          appliedTo: [{ nodeId: 10, name: 'Hallway' }],
        },
      });
      expect(payloadFor(nodes[1], built).cohort.map((member) => member.takesOverride)).toEqual([
        true,
        false,
      ]);
    });

    it('names no node when the override reaches none of them', () => {
      nodes = [node('relay', { nodeId: 11 })];
      const built = resolver([override(SHADE, 'window-covering')]);

      expect(payloadFor(nodes[0], built).invalid).toEqual({
        primaryKind: 'window-covering',
        appliedTo: [],
      });
    });
  });

  describe('records left by hardware that changed', () => {
    it('reports the most recently orphaned record first', () => {
      nodes = [node('relay', { nodeId: 9 })];
      const built = resolver(
        [override(RSZ1, 'window-covering'), override(GONE, 'binary-switch')],
        [
          observation('older', 9, RSZ1, '2026-09-30T17:02:00Z'),
          observation('newer', 9, GONE, '2026-10-05T00:00:00Z'),
        ],
      );

      expect(payloadFor(nodes[0], built).orphans.map((orphan) => orphan.observationId)).toEqual([
        'newer',
        'older',
      ]);
    });

    it('shows the type the earlier hardware is published as now, not the one it had', () => {
      nodes = [node('relay', { nodeId: 9 })];
      const built = resolver(
        [override(RSZ1, 'multilevel-switch')],
        [observation('one', 9, RSZ1, '2026-09-30T17:02:00Z')],
      );

      expect(payloadFor(nodes[0], built).orphans[0]).toMatchObject({
        observationId: 'one',
        fingerprint: RSZ1,
        primaryKind: 'multilevel-switch',
        appliedAt: '2026-09-30T17:02:00Z',
        orphanedAt: '2026-09-30T17:02:00Z',
      });
    });

    it('reports no type when the earlier hardware has no decision left', () => {
      nodes = [node('relay', { nodeId: 9 })];
      const built = resolver([], [observation('one', 9, RSZ1, '2026-09-30T17:02:00Z')]);

      expect(payloadFor(nodes[0], built).orphans[0].primaryKind).toBeNull();
    });

    it('leaves out a record still in force, which is not a change of hardware', () => {
      nodes = [node('relay', { nodeId: 9 })];
      const built = resolver([override(RSZ1, 'window-covering')], [observation('one', 9, RSZ1)]);

      expect(payloadFor(nodes[0], built).orphans).toEqual([]);
    });

    it('leaves out a record belonging to another node number', () => {
      nodes = [node('relay', { nodeId: 9 })];
      const built = resolver(
        [override(RSZ1, 'window-covering')],
        [observation('one', 8, RSZ1, '2026-09-30T17:02:00Z')],
      );

      expect(payloadFor(nodes[0], built).orphans).toEqual([]);
    });
  });

  describe('when the saved decisions could not be read', () => {
    it('reports the file as unreadable and applies nothing', () => {
      fs.writeFileSync(path.join(directory, FILE), '{ not json');
      const store = new TypeOverrideStore(directory, HOME_ID, log);
      store.load();
      nodes = [shade({ nodeId: 10 })];

      const payload = buildNodeTypePayload(
        new TypeOverrideResolver(store, () => nodes, log),
        nodes[0],
        { matterPublishes: () => true, rebuildFailure: null },
      );

      expect(payload.store.readable).toBe(false);
      expect(payload.store.error).toEqual({ code: 'invalid-json' });
      expect(payload).toMatchObject({ source: 'detected', override: null });
    });
  });

  describe('a decision this node could not be rebuilt for', () => {
    it('reports the mismatch beside the saved decision it describes', () => {
      nodes = [shade({ nodeId: 10 })];
      const built = resolver([override(SHADE, 'window-covering')]);

      const payload = payloadFor(nodes[0], built, true, 'HomeKit refused the service.');

      // The saved decision is still what every other field reads, which is why this is needed.
      expect(payload.primaryKind).toBe('window-covering');
      expect(payload.rebuildFailure).toEqual({ error: 'HomeKit refused the service.' });
    });

    it('reports no mismatch when the node publishes what was saved', () => {
      nodes = [shade({ nodeId: 10 })];

      expect(payloadFor(nodes[0]).rebuildFailure).toBeNull();
    });
  });

  describe('the row-sized summary', () => {
    it('names the other nodes the override reaches, and not this one', () => {
      nodes = [shade({ nodeId: 10 }), shade({ nodeId: 11 }), shade({ nodeId: 12 })];
      const built = resolver([override(SHADE, 'window-covering')]);

      expect(summarizeNodeType(built, nodes[0], false)).toEqual({
        typeOverride: { primaryKind: 'window-covering', sharedWith: [11, 12] },
        typeInvalid: false,
        typeOrphans: 0,
        typeRebuildFailed: false,
      });
    });

    it('leaves out a node the override does not reach', () => {
      nodes = [shade({ nodeId: 10 }), node('relay', { nodeId: 11 })];
      const built = resolver([override(SHADE, 'window-covering')]);

      expect(summarizeNodeType(built, nodes[0], false).typeOverride).toEqual({
        primaryKind: 'window-covering',
        sharedWith: [],
      });
    });

    it('marks a node that cannot take the saved type', () => {
      nodes = [shade({ nodeId: 10 }), node('relay', { nodeId: 11 })];
      const built = resolver([override(SHADE, 'window-covering')]);

      expect(summarizeNodeType(built, nodes[1], false)).toMatchObject({
        typeOverride: null,
        typeInvalid: true,
      });
    });

    it('counts only the records left by a change of hardware on this node', () => {
      nodes = [node('relay', { nodeId: 9 })];
      const built = resolver(
        [override(RSZ1, 'window-covering')],
        [
          observation('active', 9, RSZ1),
          observation('orphan', 9, GONE, '2026-10-05T00:00:00Z'),
          observation('elsewhere', 8, GONE, '2026-10-05T00:00:00Z'),
        ],
      );

      expect(summarizeNodeType(built, nodes[0], false).typeOrphans).toBe(1);
    });

    it('carries the rebuild failure the platform is holding for this node', () => {
      nodes = [shade({ nodeId: 10 })];
      const built = resolver([override(SHADE, 'window-covering')]);

      expect(summarizeNodeType(built, nodes[0], true).typeRebuildFailed).toBe(true);
      expect(summarizeNodeType(built, nodes[0], false).typeRebuildFailed).toBe(false);
    });
  });
});
