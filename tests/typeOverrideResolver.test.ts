import fs from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from 'homebridge';
import { AccessoryFactory } from '../src/accessories/AccessoryFactory';
import { TypeOverrideResolver } from '../src/platform/TypeOverrideResolver';
import { DeviceFingerprint, TypeOverrideStore } from '../src/platform/TypeOverrideStore';
import { IZWaveNode } from '../src/zwave/interfaces';
import {
  NodeIdentity,
  REALISTIC_DEVICES,
  binarySensorDevice,
  buildNode,
} from './fixtures/realisticDevices';

describe('TypeOverrideResolver', () => {
  const HOME_ID = 0xe4a1c0f2;
  const FILE = 'homebridge-zwave-usb-overrides-e4a1c0f2.json';
  const NOW = '2026-10-27T12:00:00.000Z';

  const SHADE: DeviceFingerprint = { manufacturerId: 2748, productType: 2, productId: 16 };
  const OTHER: DeviceFingerprint = { manufacturerId: 2748, productType: 3, productId: 32 };
  /** The one hardware the built-in registry reclassifies. */
  const RSZ1: DeviceFingerprint = { manufacturerId: 0x026e, productType: 0x5253, productId: 0x5a31 };
  const RSZ1_LABEL = 'Springs Window Fashions RSZ1 (Somfy Motorized Shade)';

  let directory: string;
  let log: jest.Mocked<Logger>;
  let nodes: IZWaveNode[];
  let issued: number;

  const clock = { now: () => NOW, newId: () => `id-${++issued}` };

  const named = (name: string) => {
    const device = REALISTIC_DEVICES.find((candidate) => candidate.name === name);
    if (!device) {
      throw new Error(`No realistic device named ${name}`);
    }
    return device;
  };

  const node = (name: string, identity: NodeIdentity = {}) =>
    buildNode(named(name), { ...SHADE, ...identity });

  const sensor = (property: string, identity: NodeIdentity = {}) =>
    buildNode(binarySensorDevice(property), { ...SHADE, ...identity });

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
    return new TypeOverrideResolver(store, () => nodes, log, clock);
  };

  const stored = () => JSON.parse(fs.readFileSync(path.join(directory, FILE), 'utf8'));

  /** A resolver whose store refused its file, so it holds no decision and accepts no write. */
  const refusedStore = () => {
    fs.writeFileSync(path.join(directory, FILE), '{ not json');
    const store = new TypeOverrideStore(directory, HOME_ID, log);
    store.load();
    return new TypeOverrideResolver(store, () => nodes, log, clock);
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zwave-resolver-'));
    log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;
    nodes = [];
    issued = 0;
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('reading what a node reports', () => {
    it('reads the fingerprint once the device has reported all three identifiers', () => {
      expect(TypeOverrideResolver.fingerprintOf(node('relay'))).toEqual(SHADE);
    });

    it.each([
      ['manufacturer', { manufacturerId: undefined }],
      ['product type', { productType: undefined }],
      ['product ID', { productId: undefined }],
    ])('reports no fingerprint while the %s is missing', (_label, missing) => {
      expect(TypeOverrideResolver.fingerprintOf(node('relay', missing))).toBeUndefined();
    });

    it('accepts a node that reports a fingerprint and one endpoint', () => {
      expect(TypeOverrideResolver.isOverridable(node('relay'))).toBe(true);
    });

    it('refuses a node that has not finished reporting its identifiers', () => {
      expect(TypeOverrideResolver.isOverridable(node('relay', { productId: undefined }))).toBe(false);
    });

    it('refuses a node with several endpoints, which has a primary for each of them', () => {
      expect(TypeOverrideResolver.isOverridable(node('relay', { endpoints: 2 }))).toBe(false);
    });
  });

  describe('a node default', () => {
    it('is what the device reports, when nothing names the hardware', () => {
      expect(TypeOverrideResolver.defaultTypeFor(node('dimmer with battery'))).toEqual({
        kind: 'multilevel-switch',
        source: 'detected',
        registryLabel: null,
      });
    });

    it('credits the registry when the registry is what chose the type', () => {
      expect(
        TypeOverrideResolver.defaultTypeFor(node('covering (Multilevel Switch only)', RSZ1)),
      ).toEqual({ kind: 'window-covering', source: 'registry', registryLabel: RSZ1_LABEL });
    });

    it('credits the device when the registry named the hardware but did not choose the type', () => {
      // The registry entry also carries command timing, which does not decide what is published.
      expect(TypeOverrideResolver.defaultTypeFor(node('relay', RSZ1))).toEqual({
        kind: 'binary-switch',
        source: 'detected',
        registryLabel: null,
      });
    });

    it('differs between two nodes of one model that report different capabilities', () => {
      const plain = TypeOverrideResolver.defaultTypeFor(node('relay'));
      const dimming = TypeOverrideResolver.defaultTypeFor(node('dimmer with battery'));

      expect(plain.kind).toBe('binary-switch');
      expect(dimming.kind).toBe('multilevel-switch');
    });
  });

  describe('applying a saved override', () => {
    it('passes a type the node can be published as into the plan', () => {
      const shade = node('covering (Multilevel Switch only)');

      expect(resolver([override(SHADE, 'window-covering')]).planOptionsFor(shade)).toEqual({
        primaryOverride: 'window-covering',
      });
    });

    it('publishes the overridden type rather than the detected one', () => {
      const shade = node('covering (Multilevel Switch only)');
      const options = resolver([override(SHADE, 'window-covering')]).planOptionsFor(shade);

      expect(AccessoryFactory.planFeatures(shade)[0].effectiveKinds).toEqual(['multilevel-switch']);
      expect(AccessoryFactory.planFeatures(shade, options)[0].effectiveKinds).toEqual([
        'window-covering',
      ]);
    });

    it('takes precedence over the registry for the same hardware', () => {
      const shade = node('covering (Multilevel Switch only)', RSZ1);
      const options = resolver([override(RSZ1, 'multilevel-switch')]).planOptionsFor(shade);

      expect(AccessoryFactory.planFeatures(shade)[0].effectiveKinds).toEqual(['window-covering']);
      expect(AccessoryFactory.planFeatures(shade, options)[0].effectiveKinds).toEqual([
        'multilevel-switch',
      ]);
    });

    it('plans nothing special for a node whose hardware has no saved decision', () => {
      expect(resolver([override(OTHER, 'window-covering')]).planOptionsFor(node('relay'))).toEqual(
        {},
      );
    });

    it('never overrides a node that has not reported its identifiers', () => {
      const unknown = node('covering (Multilevel Switch only)', { productId: undefined });

      expect(resolver([override(SHADE, 'window-covering')]).planOptionsFor(unknown)).toEqual({});
    });

    it('never overrides a node with several endpoints', () => {
      const split = node('covering (Multilevel Switch only)', { endpoints: 2 });

      expect(resolver([override(SHADE, 'window-covering')]).planOptionsFor(split)).toEqual({});
    });

    it('holds no decision at all over a node that cannot carry one', () => {
      // Reported as invalid, this would tell the reader to choose another type. There is no type
      // to choose: the node has a primary for each of its endpoints.
      const split = node('covering (Multilevel Switch only)', { endpoints: 2 });
      const subject = resolver([override(SHADE, 'window-covering')]);

      expect(subject.savedOverrideFor(split)).toBeUndefined();
      expect(subject.invalidOverrideFor(split)).toBeUndefined();
    });
  });

  describe('an override the node cannot take', () => {
    // A Binary Sensor reporting Motion is detected as a contact sensor but can only drive motion.
    const motion = () => sensor('Motion');

    it('is kept out of the plan, so the node is published as it was planned', () => {
      expect(resolver([override(SHADE, 'contact-sensor')]).planOptionsFor(motion())).toEqual({});
    });

    it('is reported against the node, so the reason can be shown', () => {
      const reported = resolver([override(SHADE, 'contact-sensor')]).invalidOverrideFor(motion());

      expect(reported?.primaryKind).toBe('contact-sensor');
    });

    it('is still the decision saved for the hardware', () => {
      const saved = resolver([override(SHADE, 'contact-sensor')]).savedOverrideFor(motion());

      expect(saved?.primaryKind).toBe('contact-sensor');
    });

    it('leaves nothing to report when the node can take it', () => {
      const subject = resolver([override(SHADE, 'motion-sensor')]);

      expect(subject.invalidOverrideFor(motion())).toBeUndefined();
      expect(subject.appliedOverrideFor(motion())?.primaryKind).toBe('motion-sensor');
    });
  });

  describe('where a type comes from', () => {
    it('is the override when one is applied', () => {
      const shade = node('covering (Multilevel Switch only)', RSZ1);

      expect(resolver([override(RSZ1, 'multilevel-switch')]).sourceFor(shade)).toBe('override');
    });

    it('is the registry when the hardware is named there and no override applies', () => {
      expect(resolver().sourceFor(node('covering (Multilevel Switch only)', RSZ1))).toBe('registry');
    });

    it('is the device when nothing else decided', () => {
      expect(resolver().sourceFor(node('relay'))).toBe('detected');
    });

    it('is the registry when the saved override cannot be applied', () => {
      const shade = node('covering (Multilevel Switch only)', RSZ1);

      expect(resolver([override(RSZ1, 'lock')]).sourceFor(shade)).toBe('registry');
    });
  });

  describe('the cohort a decision reaches', () => {
    it('is every interviewed single-endpoint node reporting the fingerprint', () => {
      nodes = [
        node('covering (Multilevel Switch only)', { nodeId: 10 }),
        node('dimmer with battery', { nodeId: 11 }),
        node('relay', { nodeId: 12, ...OTHER }),
      ];

      expect(resolver().cohortFor(SHADE).map((member) => member.nodeId)).toEqual([10, 11]);
    });

    it('leaves out a node whose interview has not finished', () => {
      nodes = [
        node('covering (Multilevel Switch only)', { nodeId: 10 }),
        node('dimmer with battery', { nodeId: 11, ready: false }),
      ];

      expect(resolver().cohortFor(SHADE).map((member) => member.nodeId)).toEqual([10]);
    });

    it('leaves out a node with several endpoints', () => {
      nodes = [
        node('covering (Multilevel Switch only)', { nodeId: 10 }),
        node('dimmer with battery', { nodeId: 11, endpoints: 2 }),
      ];

      expect(resolver().cohortFor(SHADE).map((member) => member.nodeId)).toEqual([10]);
    });

    it('leaves out a node that reports no fingerprint at all', () => {
      nodes = [node('dimmer with battery', { nodeId: 11, manufacturerId: undefined })];

      expect(resolver().cohortFor(SHADE)).toEqual([]);
    });

    it('keeps a node that cannot take the override, because a later decision may suit it', () => {
      nodes = [node('covering (Multilevel Switch only)', { nodeId: 10 }), sensor('Motion', { nodeId: 11 })];

      expect(
        resolver([override(SHADE, 'window-covering')]).cohortFor(SHADE).map((m) => m.nodeId),
      ).toEqual([10, 11]);
    });
  });

  describe('the types a cohort can be offered', () => {
    it('are the types every node in it could be published as', () => {
      nodes = [node('multisensor', { nodeId: 10 }), sensor('Motion', { nodeId: 11 })];

      expect(resolver().optionsFor(SHADE)).toEqual(['motion-sensor']);
    });

    it('are the types of the only node when it is alone', () => {
      nodes = [node('multisensor', { nodeId: 10 })];

      expect(resolver().optionsFor(SHADE)).toEqual(['motion-sensor', 'multilevel-sensor']);
    });

    it('are none when one node in the cohort can drive none of them', () => {
      // A Binary Sensor reporting Tilt has no feature that can read it.
      nodes = [node('multisensor', { nodeId: 10 }), sensor('Tilt', { nodeId: 11 })];

      expect(resolver().optionsFor(SHADE)).toEqual([]);
    });

    it('are none when no node reports the fingerprint', () => {
      nodes = [node('multisensor', { nodeId: 10, ...OTHER })];

      expect(resolver().optionsFor(SHADE)).toEqual([]);
    });
  });

  describe('recording where an override is applied', () => {
    it('records a node the first time the override reaches it', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      await resolver([override(SHADE, 'window-covering')]).observe(shade);

      expect(stored().observations).toEqual([
        { id: 'id-1', nodeId: 10, fingerprint: SHADE, appliedAt: NOW, orphanedAt: null },
      ]);
    });

    it('writes nothing on a later pass over the same node', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const subject = resolver([override(SHADE, 'window-covering')]);
      await subject.observe(shade);

      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(shade);

      expect(update).not.toHaveBeenCalled();
    });

    it('records nothing for a node that cannot take the override', async () => {
      const subject = resolver([override(SHADE, 'contact-sensor')]);
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(sensor('Motion', { nodeId: 10 }));

      expect(update).not.toHaveBeenCalled();
    });

    it('records nothing while the interview is unfinished', async () => {
      const subject = resolver([override(SHADE, 'window-covering')]);
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(node('covering (Multilevel Switch only)', { nodeId: 10, ready: false }));

      expect(update).not.toHaveBeenCalled();
    });

    it('records nothing while the node reports no fingerprint', async () => {
      const subject = resolver([override(SHADE, 'window-covering')]);
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(
        node('covering (Multilevel Switch only)', { nodeId: 10, productType: undefined }),
      );

      expect(update).not.toHaveBeenCalled();
    });

    it('records one node once, however many passes start together', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const subject = resolver([override(SHADE, 'window-covering')]);

      await Promise.all([subject.observe(shade), subject.observe(shade)]);

      expect(stored().observations).toHaveLength(1);
    });
  });

  describe('a node number that now reports other hardware', () => {
    it('orphans what was recorded for it', async () => {
      const replacement = node('relay', { nodeId: 10, ...OTHER });
      await resolver([], [observation('a', 10, SHADE)]).observe(replacement);

      expect(stored().observations).toEqual([
        { ...observation('a', 10, SHADE), orphanedAt: NOW },
      ]);
    });

    it('leaves the record of another node alone', async () => {
      const replacement = node('relay', { nodeId: 10, ...OTHER });
      await resolver([], [observation('a', 10, SHADE), observation('b', 11, SHADE)]).observe(
        replacement,
      );

      expect(stored().observations.map((o: { orphanedAt: string | null }) => o.orphanedAt)).toEqual([
        NOW,
        null,
      ]);
    });

    it('keeps the time an already orphaned record was orphaned at', async () => {
      const replacement = node('relay', { nodeId: 10, ...OTHER });
      const earlier = '2026-01-01T00:00:00Z';
      const subject = resolver([], [observation('a', 10, SHADE, earlier)]);
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(replacement);

      expect(update).not.toHaveBeenCalled();
      expect(stored().observations[0].orphanedAt).toBe(earlier);
    });

    it('revives the record when the hardware comes back', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const earlier = '2026-01-01T00:00:00Z';
      await resolver(
        [override(SHADE, 'window-covering')],
        [observation('a', 10, SHADE, earlier)],
      ).observe(shade);

      expect(stored().observations).toEqual([observation('a', 10, SHADE)]);
    });

    it('keeps the time an earlier record was orphaned at while recording another', async () => {
      // The node was recorded for other hardware and orphaned long ago. Recording what it reports
      // now must not restate when that first record stopped matching.
      const earlier = '2026-01-01T00:00:00Z';
      await resolver(
        [override(SHADE, 'window-covering')],
        [observation('a', 10, OTHER, earlier)],
      ).observe(node('covering (Multilevel Switch only)', { nodeId: 10 }));

      expect(stored().observations).toEqual([
        observation('a', 10, OTHER, earlier),
        { id: 'id-1', nodeId: 10, fingerprint: SHADE, appliedAt: NOW, orphanedAt: null },
      ]);
    });

    it('leaves a record orphaned when the hardware came back but cannot take the override', async () => {
      // The node reports hardware it was recorded for before, while the record for what it
      // reported in between is still active and has to be orphaned by this same write.
      const earlier = '2026-01-01T00:00:00Z';
      await resolver(
        [override(SHADE, 'contact-sensor')],
        [observation('a', 10, SHADE, earlier), observation('b', 10, OTHER)],
      ).observe(sensor('Motion', { nodeId: 10 }));

      expect(stored().observations).toEqual([
        observation('a', 10, SHADE, earlier),
        observation('b', 10, OTHER, NOW),
      ]);
    });

    it('does not revive a record for a node that cannot take the override', async () => {
      const earlier = '2026-01-01T00:00:00Z';
      const subject = resolver(
        [override(SHADE, 'contact-sensor')],
        [observation('a', 10, SHADE, earlier)],
      );
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(sensor('Motion', { nodeId: 10 }));

      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('the revision a decision is made against', () => {
    const revision = (subject: TypeOverrideResolver) => subject.cohortRevisionFor(SHADE);

    beforeEach(() => {
      nodes = [node('dimmer with battery', { nodeId: 10 })];
    });

    it('is eight hex digits', () => {
      expect(revision(resolver())).toMatch(/^[0-9a-f]{8}$/);
    });

    it('is the same while nothing about the cohort changes', () => {
      expect(revision(resolver())).toBe(revision(resolver()));
    });

    it('does not depend on the order the nodes were discovered in', () => {
      nodes = [node('dimmer with battery', { nodeId: 11 }), node('colour bulb', { nodeId: 10 })];
      const discovered = revision(resolver());
      nodes = [nodes[1], nodes[0]];

      expect(revision(resolver())).toBe(discovered);
    });

    it('changes when a node joins the cohort', () => {
      const alone = revision(resolver());
      nodes = [...nodes, node('colour bulb', { nodeId: 11 })];

      expect(revision(resolver())).not.toBe(alone);
    });

    it('changes when the same devices answer to different node numbers', () => {
      const asTen = revision(resolver());
      nodes = [node('dimmer with battery', { nodeId: 11 })];

      expect(revision(resolver())).not.toBe(asTen);
    });

    it('changes when a node reports different capabilities', () => {
      const dimming = revision(resolver());
      nodes = [node('colour bulb', { nodeId: 10 })];

      expect(revision(resolver())).not.toBe(dimming);
    });

    it('changes when the stored decision changes', () => {
      expect(revision(resolver([override(SHADE, 'window-covering')]))).not.toBe(
        revision(resolver()),
      );
    });

    it('changes when a decision no node can take is saved', () => {
      // Nothing about the nodes changes, since none of them can be published as it. What
      // changes is that Revert and Remove now mean something, so the revision has to move.
      nodes = [sensor('Motion', { nodeId: 10 })];
      const undecided = revision(resolver());

      expect(revision(resolver([override(SHADE, 'contact-sensor')]))).not.toBe(undecided);
    });

    it('is not shared by two models on the same network', () => {
      nodes = [
        node('dimmer with battery', { nodeId: 10 }),
        node('dimmer with battery', { nodeId: 11, ...OTHER }),
      ];
      const subject = resolver();

      expect(subject.cohortRevisionFor(SHADE)).not.toBe(subject.cohortRevisionFor(OTHER));
    });
  });

  describe('saving a type for a device', () => {
    const request = (subject: TypeOverrideResolver, primaryKind: string, extra = {}) => ({
      nodeId: 10,
      primaryKind: primaryKind as never,
      expectedFingerprint: SHADE,
      expectedRevision: subject.cohortRevisionFor(SHADE),
      ...extra,
    });

    beforeEach(() => {
      nodes = [node('dimmer with battery', { nodeId: 10 })];
    });

    it('saves the decision for the hardware and names the nodes to rebuild', async () => {
      nodes = [...nodes, node('covering (Multilevel Switch only)', { nodeId: 11 })];
      const subject = resolver();

      expect(await subject.setNodeType(request(subject, 'window-covering'))).toEqual({
        rebuild: [10, 11],
      });
      expect(stored().overrides).toEqual([
        { fingerprint: SHADE, primaryKind: 'window-covering', savedAt: NOW },
      ]);
    });

    it('replaces a decision already saved for that hardware rather than adding another', async () => {
      // A colour bulb, so that a third type is on offer beside the saved one and its own default.
      nodes = [node('colour bulb', { nodeId: 10 })];
      const subject = resolver([override(SHADE, 'window-covering')]);
      await subject.setNodeType(request(subject, 'multilevel-switch'));

      expect(stored().overrides).toEqual([
        { fingerprint: SHADE, primaryKind: 'multilevel-switch', savedAt: NOW },
      ]);
    });

    it('leaves a decision about other hardware alone', async () => {
      const subject = resolver([override(OTHER, 'lock')]);
      await subject.setNodeType(request(subject, 'window-covering'));

      expect(stored().overrides).toHaveLength(2);
      expect(stored().overrides[0]).toEqual(override(OTHER, 'lock'));
    });

    it('refuses a node it does not have', async () => {
      const subject = resolver();
      const sent = request(subject, 'window-covering', { nodeId: 99 });

      expect(await subject.setNodeType(sent)).toEqual({ refusal: 'unknown-node', rebuild: [] });
    });

    it('refuses while the saved file could not be read', async () => {
      const subject = refusedStore();

      expect(await subject.setNodeType(request(subject, 'window-covering'))).toEqual({
        refusal: 'read-only',
        rebuild: [],
      });
    });

    it.each([
      ['its interview has not finished', { ready: false }],
      ['it has several endpoints', { endpoints: 2 }],
      ['it reports no fingerprint', { productId: undefined }],
    ])('refuses a node because %s', async (_why, identity) => {
      nodes = [node('dimmer with battery', { nodeId: 10, ...identity })];
      const subject = resolver();

      expect(await subject.setNodeType(request(subject, 'window-covering'))).toEqual({
        refusal: 'not-overridable',
        rebuild: [],
      });
    });

    it('refuses when the node now reports other hardware', async () => {
      const subject = resolver();
      const sent = request(subject, 'window-covering', { expectedFingerprint: OTHER });

      expect(await subject.setNodeType(sent)).toEqual({
        refusal: 'fingerprint-changed',
        rebuild: [],
      });
    });

    it('refuses when the cohort changed since the decision was composed', async () => {
      const subject = resolver();
      const sent = request(subject, 'window-covering');
      nodes = [...nodes, node('colour bulb', { nodeId: 11 })];

      expect(await subject.setNodeType(sent)).toEqual({ refusal: 'cohort-changed', rebuild: [] });
    });

    it('refuses a type the named node could drive but another in the cohort could not', async () => {
      // The colour bulb could be published as a colour switch; the dimmer beside it could not.
      nodes = [...nodes, node('colour bulb', { nodeId: 11 })];
      const subject = resolver();
      const sent = { ...request(subject, 'color-switch'), nodeId: 11 };

      expect(await subject.setNodeType(sent)).toEqual({
        refusal: 'unsupported-type',
        rebuild: [],
      });
    });

    it('refuses the type already saved, which would change nothing', async () => {
      const subject = resolver([override(SHADE, 'window-covering')]);

      expect(await subject.setNodeType(request(subject, 'window-covering'))).toEqual({
        refusal: 'already-current',
        rebuild: [],
      });
    });

    it('refuses a type every node in the cohort already publishes', async () => {
      const subject = resolver();

      expect(await subject.setNodeType(request(subject, 'multilevel-switch'))).toEqual({
        refusal: 'already-default',
        rebuild: [],
      });
    });

    it('sends a revert to clearing rather than saving a default as a decision', async () => {
      const subject = resolver([override(SHADE, 'window-covering')]);

      expect(await subject.setNodeType(request(subject, 'multilevel-switch'))).toEqual({
        refusal: 'use-clear',
        rebuild: [],
      });
    });

    it('accepts a type that is the default of only part of the cohort', async () => {
      nodes = [...nodes, node('colour bulb', { nodeId: 11 })];
      const subject = resolver();

      expect(await subject.setNodeType(request(subject, 'multilevel-switch'))).toEqual({
        rebuild: [10, 11],
      });
    });

    it('writes nothing at all when it refuses', async () => {
      const subject = resolver([override(OTHER, 'lock')]);
      const before = fs.readFileSync(path.join(directory, FILE), 'utf8');
      await subject.setNodeType(request(subject, 'multilevel-switch'));

      expect(fs.readFileSync(path.join(directory, FILE), 'utf8')).toBe(before);
    });
  });

  describe('clearing a saved type', () => {
    const request = (subject: TypeOverrideResolver) => ({
      nodeId: 10,
      expectedFingerprint: SHADE,
      expectedRevision: subject.cohortRevisionFor(SHADE),
    });

    beforeEach(() => {
      nodes = [node('dimmer with battery', { nodeId: 10 })];
    });

    it('refuses when the hardware has no saved decision', async () => {
      const subject = resolver();

      expect(await subject.clearNodeType(request(subject))).toEqual({
        refusal: 'no-override',
        rebuild: [],
      });
    });

    it('refuses when the cohort changed since the decision was composed', async () => {
      const subject = resolver([override(SHADE, 'window-covering')]);
      const sent = request(subject);
      nodes = [...nodes, node('colour bulb', { nodeId: 11 })];

      expect(await subject.clearNodeType(sent)).toEqual({ refusal: 'cohort-changed', rebuild: [] });
    });

    it('drops the decision and every record of where it was applied', async () => {
      const subject = resolver(
        [override(SHADE, 'window-covering')],
        [observation('a', 10, SHADE), observation('b', 11, SHADE, '2026-01-01T00:00:00Z')],
      );

      expect(await subject.clearNodeType(request(subject))).toEqual({ rebuild: [10] });
      expect(stored().overrides).toEqual([]);
      expect(stored().observations).toEqual([]);
    });

    it('leaves the decision and records of another model alone', async () => {
      const subject = resolver(
        [override(SHADE, 'window-covering'), override(OTHER, 'lock')],
        [observation('a', 10, SHADE), observation('b', 12, OTHER)],
      );
      await subject.clearNodeType(request(subject));

      expect(stored().overrides).toEqual([override(OTHER, 'lock')]);
      expect(stored().observations).toEqual([observation('b', 12, OTHER)]);
    });
  });

  describe('discarding a decision no node can take', () => {
    const request = (subject: TypeOverrideResolver) => ({
      nodeId: 10,
      expectedRevision: subject.cohortRevisionFor(SHADE),
    });

    beforeEach(() => {
      nodes = [sensor('Motion', { nodeId: 10 })];
    });

    it('refuses when the hardware has no saved decision', async () => {
      const subject = resolver();

      expect(await subject.removeTypeOverride(request(subject))).toEqual({
        refusal: 'no-override',
        rebuild: [],
      });
    });

    it('refuses while any node is published as it', async () => {
      // The Door/Window sensor beside it can drive a contact sensor, so the decision is in use.
      nodes = [...nodes, sensor('Door/Window', { nodeId: 11 })];
      const subject = resolver([override(SHADE, 'contact-sensor')]);

      expect(await subject.removeTypeOverride(request(subject))).toEqual({
        refusal: 'override-in-use',
        rebuild: [],
      });
    });

    it('drops the decision and its records when no node takes it', async () => {
      const subject = resolver(
        [override(SHADE, 'contact-sensor')],
        [observation('a', 10, SHADE, '2026-01-01T00:00:00Z')],
      );

      expect(await subject.removeTypeOverride(request(subject))).toEqual({ rebuild: [10] });
      expect(stored()).toMatchObject({ overrides: [], observations: [] });
    });
  });

  describe('acknowledging that a node reports other hardware', () => {
    const request = { nodeId: 10, observationId: 'a', expectedFingerprint: SHADE };

    beforeEach(() => {
      nodes = [node('dimmer with battery', { nodeId: 10 })];
    });

    it('drops that one record and nothing else', async () => {
      const subject = resolver(
        [override(OTHER, 'lock')],
        [observation('a', 10, OTHER, '2026-01-01T00:00:00Z'), observation('b', 11, OTHER)],
      );

      expect(await subject.acknowledgeTypeOrphan(request)).toEqual({ rebuild: [] });
      expect(stored().observations).toEqual([observation('b', 11, OTHER)]);
      expect(stored().overrides).toEqual([override(OTHER, 'lock')]);
    });

    it('refuses a record it does not have', async () => {
      const subject = resolver([], [observation('b', 10, OTHER, '2026-01-01T00:00:00Z')]);

      expect(await subject.acknowledgeTypeOrphan(request)).toEqual({
        refusal: 'unknown-observation',
        rebuild: [],
      });
    });

    it('drops one record even when another carries the same identifier', async () => {
      // The file validator refuses a shared identifier, so one is forced past it here. The
      // delete names the whole record rather than resting on another module's invariant.
      const subject = resolver([], [observation('a', 10, OTHER, '2026-01-01T00:00:00Z')]);
      const intruder = { id: 'a', nodeId: 11, fingerprint: SHADE, appliedAt: NOW, orphanedAt: null };
      await subject.store.update((data) => {
        data.observations.push(intruder);
      });

      expect(await subject.acknowledgeTypeOrphan(request)).toEqual({ rebuild: [] });
      expect(stored().observations).toEqual([intruder]);
    });

    it('refuses a record that is not orphaned', async () => {
      // The page offers this only for an orphan. An active record is the plugin's own note that
      // the decision is in force, and dropping it would be dropping a fact, not accepting one.
      const subject = resolver([override(OTHER, 'lock')], [observation('a', 10, OTHER)]);

      expect(await subject.acknowledgeTypeOrphan(request)).toEqual({
        refusal: 'unknown-observation',
        rebuild: [],
      });
      expect(stored().observations).toHaveLength(1);
    });

    it('refuses a record kept against another node', async () => {
      const subject = resolver([], [observation('a', 11, OTHER, '2026-01-01T00:00:00Z')]);

      expect(await subject.acknowledgeTypeOrphan(request)).toEqual({
        refusal: 'unknown-observation',
        rebuild: [],
      });
    });

    it('refuses when the node now reports other hardware than the panel showed', async () => {
      const subject = resolver([], [observation('a', 10, OTHER, '2026-01-01T00:00:00Z')]);
      const sent = { ...request, expectedFingerprint: OTHER };

      expect(await subject.acknowledgeTypeOrphan(sent)).toEqual({
        refusal: 'fingerprint-changed',
        rebuild: [],
      });
    });
  });

  describe('when two writes overlap', () => {
    it('refuses a second decision carrying the revision the first one consumed', async () => {
      nodes = [node('colour bulb', { nodeId: 10 })];
      const subject = resolver();
      const expectedRevision = subject.cohortRevisionFor(SHADE);
      const sent = (primaryKind: string) => ({
        nodeId: 10,
        primaryKind: primaryKind as never,
        expectedFingerprint: SHADE,
        expectedRevision,
      });

      const [first, second] = await Promise.all([
        subject.setNodeType(sent('window-covering')),
        subject.setNodeType(sent('multilevel-switch')),
      ]);

      expect(first).toEqual({ rebuild: [10] });
      expect(second).toEqual({ refusal: 'cohort-changed', rebuild: [] });
      expect(stored().overrides).toEqual([
        { fingerprint: SHADE, primaryKind: 'window-covering', savedAt: NOW },
      ]);
    });

    it('refuses a clear carrying the revision a save consumed', async () => {
      nodes = [node('colour bulb', { nodeId: 10 })];
      const subject = resolver();
      const expectedRevision = subject.cohortRevisionFor(SHADE);

      const [saved, cleared] = await Promise.all([
        subject.setNodeType({
          nodeId: 10,
          primaryKind: 'window-covering',
          expectedFingerprint: SHADE,
          expectedRevision,
        }),
        subject.clearNodeType({ nodeId: 10, expectedFingerprint: SHADE, expectedRevision }),
      ]);

      expect(saved).toEqual({ rebuild: [10] });
      expect(cleared).toEqual({ refusal: 'cohort-changed', rebuild: [] });
      expect(stored().overrides).toHaveLength(1);
    });

    it('runs the next command after one of them fails', async () => {
      nodes = [node('dimmer with battery', { nodeId: 10 })];
      const subject = resolver();
      const sent = {
        nodeId: 10,
        primaryKind: 'window-covering' as const,
        expectedFingerprint: SHADE,
        expectedRevision: subject.cohortRevisionFor(SHADE),
      };
      const update = jest
        .spyOn(subject.store, 'update')
        .mockRejectedValueOnce(new Error('Disk is full'));

      await expect(subject.setNodeType(sent)).rejects.toThrow('Disk is full');
      update.mockRestore();

      expect(await subject.setNodeType(sent)).toEqual({ rebuild: [10] });
    });

    it('does not record a decision that was cleared while the pass was in flight', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      nodes = [shade];
      const subject = resolver([override(SHADE, 'window-covering')]);
      const sent = {
        nodeId: 10,
        expectedFingerprint: SHADE,
        expectedRevision: subject.cohortRevisionFor(SHADE),
      };

      const clearing = subject.clearNodeType(sent);
      // Let the clear reach its write before the pass starts. The pass then reads a decision
      // that is on its way out but still stored, and its own write lands behind the clear's.
      await Promise.resolve();
      const observing = subject.observe(shade);
      await Promise.all([clearing, observing]);

      expect(stored()).toMatchObject({ overrides: [], observations: [] });
    });
  });

  describe('a request missing what it must carry', () => {
    beforeEach(() => {
      nodes = [node('dimmer with battery', { nodeId: 10 })];
    });

    const incomplete = { refusal: 'incomplete-request', rebuild: [] };

    it.each([
      ['no hardware', { expectedFingerprint: undefined }],
      ['no revision', { expectedRevision: undefined }],
      ['an unreadable fingerprint', { expectedFingerprint: { manufacturerId: 2748 } }],
      ['a revision that is not text', { expectedRevision: 7 }],
    ])('refuses a save sent with %s', async (_why, forged) => {
      const subject = resolver();
      const sent = {
        nodeId: 10,
        primaryKind: 'window-covering',
        expectedFingerprint: SHADE,
        expectedRevision: subject.cohortRevisionFor(SHADE),
        ...forged,
      } as never;

      expect(await subject.setNodeType(sent)).toEqual(incomplete);
    });

    it.each([
      ['no hardware', { expectedFingerprint: undefined }],
      ['no revision', { expectedRevision: undefined }],
    ])('refuses a clear sent with %s', async (_why, forged) => {
      const subject = resolver([override(SHADE, 'window-covering')]);
      const sent = {
        nodeId: 10,
        expectedFingerprint: SHADE,
        expectedRevision: subject.cohortRevisionFor(SHADE),
        ...forged,
      } as never;

      expect(await subject.clearNodeType(sent)).toEqual(incomplete);
    });

    it('refuses a discard sent with no revision', async () => {
      nodes = [sensor('Motion', { nodeId: 10 })];
      const subject = resolver([override(SHADE, 'contact-sensor')]);

      expect(await subject.removeTypeOverride({ nodeId: 10 } as never)).toEqual(incomplete);
    });

    it('refuses an acknowledgement sent with no hardware', async () => {
      const subject = resolver([], [observation('a', 10, OTHER, '2026-01-01T00:00:00Z')]);
      const sent = { nodeId: 10, observationId: 'a' } as never;

      expect(await subject.acknowledgeTypeOrphan(sent)).toEqual(incomplete);
    });

    it('refuses a type this plugin does not publish', async () => {
      const subject = resolver();
      const sent = {
        nodeId: 10,
        primaryKind: 'teapot',
        expectedFingerprint: SHADE,
        expectedRevision: subject.cohortRevisionFor(SHADE),
      } as never;

      expect(await subject.setNodeType(sent)).toEqual({
        refusal: 'unsupported-type',
        rebuild: [],
      });
    });
  });

  describe('when the saved file could not be read', () => {
    it('publishes every node as planned, because it knows of no decision', () => {
      const subject = refusedStore();
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });

      expect(subject.planOptionsFor(shade)).toEqual({});
      expect(subject.savedOverrideFor(shade)).toBeUndefined();
      expect(subject.invalidOverrideFor(shade)).toBeUndefined();
    });

    it('finds nothing to record, so it never reaches the write the store would refuse', async () => {
      const subject = refusedStore();
      const update = jest.spyOn(subject.store, 'update');
      await subject.observe(node('covering (Multilevel Switch only)', { nodeId: 10 }));

      expect(update).not.toHaveBeenCalled();
    });

  });

  describe('when a write fails', () => {
    it('reports a failing write once for a node rather than on every event', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const subject = resolver([override(SHADE, 'window-covering')]);
      jest.spyOn(subject.store, 'update').mockRejectedValue(new Error('Disk is full'));

      await subject.observe(shade);
      await subject.observe(shade);

      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        'Could not record where the type override for Node 10 is applied. Disk is full. ' +
          'The type it publishes is unaffected.',
      );
    });

    it('reports again after a write succeeds and later fails', async () => {
      const shade = node('covering (Multilevel Switch only)', { nodeId: 10 });
      const subject = resolver([override(SHADE, 'window-covering')]);
      const update = jest.spyOn(subject.store, 'update');

      update.mockRejectedValueOnce(new Error('Disk is full'));
      await subject.observe(shade);
      update.mockRestore();
      await subject.observe(shade);
      jest.spyOn(subject.store, 'update').mockRejectedValue(new Error('Disk is full'));
      await subject.observe(node('relay', { nodeId: 10, ...OTHER }));

      expect(log.warn).toHaveBeenCalledTimes(2);
    });
  });
});
