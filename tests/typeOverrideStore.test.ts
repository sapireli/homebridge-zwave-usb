import fs from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from 'homebridge';
import { TypeOverrideData, TypeOverrideStore } from '../src/platform/TypeOverrideStore';

describe('TypeOverrideStore', () => {
  const HOME_ID = 0xe4a1c0f2;
  const FILE = 'homebridge-zwave-usb-overrides-e4a1c0f2.json';
  const shade = { manufacturerId: 2748, productType: 2, productId: 16 };
  const other = { manufacturerId: 2748, productType: 3, productId: 32 };

  let directory: string;
  let log: jest.Mocked<Logger>;

  const store = (homeId = HOME_ID) => new TypeOverrideStore(directory, homeId, log);

  const valid = (): TypeOverrideData => ({
    version: 1,
    homeId: 'e4a1c0f2',
    overrides: [{ fingerprint: shade, primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' }],
    observations: [
      { id: 'abc', nodeId: 9, fingerprint: other, appliedAt: '2026-09-30T17:02:00Z', orphanedAt: null },
    ],
  });

  const write = (contents: unknown) =>
    fs.writeFileSync(
      path.join(directory, FILE),
      typeof contents === 'string' ? contents : JSON.stringify(contents),
    );

  const read = () => JSON.parse(fs.readFileSync(path.join(directory, FILE), 'utf8'));

  const loaded = (contents: unknown) => {
    write(contents);
    const s = store();
    s.load();
    return s;
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zwave-overrides-'));
    log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('naming', () => {
    it('names one file per network, by the home ID in hex', () => {
      expect(TypeOverrideStore.fileNameFor(HOME_ID)).toBe(FILE);
      expect(TypeOverrideStore.fileNameFor(1)).toBe('homebridge-zwave-usb-overrides-00000001.json');
    });

    it('reduces any value to eight hex digits', () => {
      expect(TypeOverrideStore.homeIdHex(0xe4a1c0f2)).toBe('e4a1c0f2');
      // The driver reads the home ID unsigned, so this only keeps the name well formed.
      expect(TypeOverrideStore.homeIdHex(-1)).toBe('ffffffff');
    });

    it('puts the file in the directory it was given', () => {
      expect(store().filePath).toBe(path.join(directory, FILE));
    });
  });

  describe('loading', () => {
    it('treats a missing file as a network with no decisions yet', () => {
      const s = store();
      s.load();

      expect(s.readOnly).toBe(false);
      expect(s.snapshot()).toEqual({ version: 1, homeId: 'e4a1c0f2', overrides: [], observations: [] });
      expect(log.error).not.toHaveBeenCalled();
    });

    it('reads a valid file', () => {
      const s = loaded(valid());

      expect(s.readOnly).toBe(false);
      expect(s.overrideFor(shade)?.primaryKind).toBe('window-covering');
      expect(s.observationsFor(other)).toHaveLength(1);
      expect(s.overrideFor(other)).toBeUndefined();
      expect(s.observationsFor(shade)).toEqual([]);
    });

    it('keeps apart two models that differ in one identifier', () => {
      const sibling = { ...shade, productId: shade.productId + 1 };
      const s = loaded({
        ...valid(),
        overrides: [
          { fingerprint: shade, primaryKind: 'window-covering', savedAt: 'now' },
          { fingerprint: sibling, primaryKind: 'lock', savedAt: 'now' },
        ],
        observations: [
          { id: 'a', nodeId: 9, fingerprint: shade, appliedAt: 'now', orphanedAt: null },
        ],
      });

      expect(s.overrideFor(shade)?.primaryKind).toBe('window-covering');
      expect(s.overrideFor(sibling)?.primaryKind).toBe('lock');
      expect(s.observationsFor(sibling)).toEqual([]);
      expect(s.overrideFor({ ...shade, productType: shade.productType + 1 })).toBeUndefined();
      expect(s.overrideFor({ ...shade, manufacturerId: shade.manufacturerId + 1 })).toBeUndefined();
    });

    it.each([
      ['unreadable JSON', '{ not json'],
      ['something other than an object', '[]'],
      ['nothing at all', 'null'],
      ['a bare number', '42'],
      ['a version this plugin does not write', { ...valid(), version: 2 }],
      ['no version at all', { homeId: 'e4a1c0f2', overrides: [], observations: [] }],
      ['another network', { ...valid(), homeId: '0000ffff' }],
      ['no list of overrides', { version: 1, homeId: 'e4a1c0f2', observations: [] }],
      ['a type this plugin does not publish', {
        ...valid(),
        overrides: [{ fingerprint: shade, primaryKind: 'teapot', savedAt: 'now' }],
      }],
      ['an override naming no device', { ...valid(), overrides: [{ primaryKind: 'lock', savedAt: 'now' }] }],
      ['a device whose manufacturer is not a number', {
        ...valid(),
        overrides: [{ fingerprint: { ...shade, manufacturerId: '2748' }, primaryKind: 'lock', savedAt: 'now' }],
      }],
      ['a device whose product type is not a number', {
        ...valid(),
        overrides: [{ fingerprint: { ...shade, productType: null }, primaryKind: 'lock', savedAt: 'now' }],
      }],
      ['a device whose product is not a number', {
        ...valid(),
        overrides: [{ fingerprint: { ...shade, productId: '16' }, primaryKind: 'lock', savedAt: 'now' }],
      }],
      ['an observation naming no device', {
        ...valid(),
        observations: [{ id: 'a', nodeId: 9, fingerprint: { productId: 16 }, appliedAt: 'now', orphanedAt: null }],
      }],
      ['an observation whose node is not a number', {
        ...valid(),
        observations: [{ id: 'a', nodeId: '9', fingerprint: other, appliedAt: 'now', orphanedAt: null }],
      }],
      ['an observation applied at no time at all', {
        ...valid(),
        observations: [{ id: 'a', nodeId: 9, fingerprint: other, appliedAt: '', orphanedAt: null }],
      }],
      ['an override saved at no time at all', {
        ...valid(),
        overrides: [{ fingerprint: shade, primaryKind: 'lock', savedAt: '' }],
      }],
      ['an override with no saved time', {
        ...valid(),
        overrides: [{ fingerprint: shade, primaryKind: 'lock' }],
      }],
      ['two overrides for one device', {
        ...valid(),
        overrides: [
          { fingerprint: shade, primaryKind: 'lock', savedAt: 'now' },
          { fingerprint: { ...shade }, primaryKind: 'siren', savedAt: 'now' },
        ],
      }],
      ['two observations for one node and device', {
        ...valid(),
        observations: [
          { id: 'a', nodeId: 9, fingerprint: other, appliedAt: 'now', orphanedAt: null },
          { id: 'b', nodeId: 9, fingerprint: { ...other }, appliedAt: 'now', orphanedAt: null },
        ],
      }],
      ['two observations sharing an identifier', {
        ...valid(),
        observations: [
          { id: 'a', nodeId: 9, fingerprint: other, appliedAt: 'now', orphanedAt: null },
          { id: 'a', nodeId: 10, fingerprint: shade, appliedAt: 'now', orphanedAt: null },
        ],
      }],
      ['an observation with no identifier', {
        ...valid(),
        observations: [{ nodeId: 9, fingerprint: other, appliedAt: 'now', orphanedAt: null }],
      }],
      ['an observation with an unreadable orphan time', {
        ...valid(),
        observations: [{ id: 'a', nodeId: 9, fingerprint: other, appliedAt: 'now', orphanedAt: 7 }],
      }],
    ])('refuses a file holding %s', (_label, contents) => {
      const s = loaded(contents);

      expect(s.readOnly).toBe(true);
      expect(s.readOnlyCode).toEqual(expect.any(String));
      expect(s.snapshot().overrides).toEqual([]);
      expect(log.error).toHaveBeenCalledTimes(1);
    });

    it('names the fault by code, so the panel never reads a sentence', () => {
      expect(loaded('{ not json').readOnlyCode).toBe('invalid-json');
      expect(loaded(7).readOnlyCode).toBe('invalid-data');
      expect(loaded({ ...valid(), version: 2 }).readOnlyCode).toBe('unsupported-version');
      expect(loaded({ ...valid(), homeId: 'c41b7e59' }).readOnlyCode).toBe('wrong-network');
      expect(loaded({ ...valid(), overrides: 'no list' }).readOnlyCode).toBe('invalid-data');
    });

    it('names a permission failure as its own fault, and relays any other', () => {
      const throwing = (code: string, message: string) => () => {
        throw Object.assign(new Error(message), { code });
      };

      const reading = jest.spyOn(fs, 'readFileSync');

      reading.mockImplementationOnce(throwing('EACCES', 'permission denied, open'));
      const denied = store();
      denied.load();
      expect(denied.readOnlyCode).toBe('permission-denied');
      expect(log.error.mock.calls[0][0]).toContain(': permission denied.');

      reading.mockImplementationOnce(throwing('EIO', 'EIO: i/o error, read'));
      const broken = store();
      broken.load();
      expect(broken.readOnlyCode).toBe('unreadable');
      expect(log.error.mock.calls[1][0]).toContain('EIO: i/o error, read.');
    });

    it('writes the fault, the file and what it did about it as one line', () => {
      loaded({ ...valid(), version: 2 });

      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error.mock.calls[0][0]).toBe(
        'Could not load saved type overrides for network e4a1c0f2 from ' +
          `${path.join(directory, FILE)}: it is version 2, and this plugin reads version 1. ` +
          'No overrides were applied, editing is disabled, and the file was left unchanged.',
      );
    });

    it('names the file even when the fault is in what it holds', () => {
      loaded({ ...valid(), overrides: [{ fingerprint: shade, primaryKind: 'window-covering' }] });

      expect(log.error.mock.calls[0][0]).toContain(path.join(directory, FILE));
      expect(log.error.mock.calls[0][0]).toContain(
        'an override does not record when it was saved.',
      );
    });

    it('refuses a file it cannot read at all', () => {
      fs.mkdirSync(path.join(directory, FILE));
      const s = store();
      s.load();

      expect(s.readOnly).toBe(true);
      expect(log.error).toHaveBeenCalledTimes(1);
    });

    it('applies no override while read-only', () => {
      const s = loaded({ ...valid(), version: 2 });

      expect(s.overrideFor(shade)).toBeUndefined();
      expect(s.observationsFor(other)).toEqual([]);
    });
  });

  describe('writing', () => {
    it('saves a decision and reads it back', async () => {
      const s = store();
      s.load();

      await s.update((data) => {
        data.overrides.push({ fingerprint: shade, primaryKind: 'lock', savedAt: 'now' });
      });

      expect(read()).toEqual({
        version: 1,
        homeId: 'e4a1c0f2',
        overrides: [{ fingerprint: shade, primaryKind: 'lock', savedAt: 'now' }],
        observations: [],
      });
      expect(s.overrideFor(shade)?.primaryKind).toBe('lock');
    });

    it('stamps the version and the network itself', async () => {
      const s = store();
      s.load();

      await s.update((data) => {
        (data as { version: number }).version = 99;
        data.homeId = 'whatever';
      });

      expect(read().version).toBe(1);
      expect(read().homeId).toBe('e4a1c0f2');
    });

    it('leaves no temporary file behind', async () => {
      const s = store();
      s.load();
      await s.update((data) => data.observations.push(
        { id: 'a', nodeId: 2, fingerprint: shade, appliedAt: 'now', orphanedAt: null },
      ));

      expect(fs.readdirSync(directory)).toEqual([FILE]);
    });

    it('applies writes started together in the order they were made', async () => {
      const s = store();
      s.load();

      const first = s.update((data) => {
        data.overrides.push({ fingerprint: shade, primaryKind: 'lock', savedAt: 'first' });
      });
      const second = s.update((data) => {
        data.overrides.push({ fingerprint: other, primaryKind: 'siren', savedAt: 'second' });
      });

      await Promise.all([first, second]);

      expect(read().overrides.map((o: { savedAt: string }) => o.savedAt)).toEqual(['first', 'second']);
    });

    it('refuses to write over a file it could not read', async () => {
      const original = JSON.stringify({ ...valid(), version: 2 });
      write(original);
      const s = store();
      s.load();

      await expect(s.update((data) => data.overrides.splice(0))).rejects.toThrow('Saved type overrides are read-only.');
      expect(fs.readFileSync(path.join(directory, FILE), 'utf8')).toBe(original);
    });

    it('keeps the stored contents and accepts the next write when one fails', async () => {
      const s = store();
      s.load();
      await s.update((data) => {
        data.overrides.push({ fingerprint: shade, primaryKind: 'lock', savedAt: 'kept' });
      });

      jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk full'));
      await expect(
        s.update((data) => {
          data.overrides.push({ fingerprint: other, primaryKind: 'siren', savedAt: 'lost' });
        }),
      ).rejects.toThrow('disk full');

      expect(s.snapshot().overrides).toHaveLength(1);
      expect(fs.readdirSync(directory)).toEqual([FILE]);
      expect(read().overrides).toHaveLength(1);

      await s.update((data) => {
        data.overrides.push({ fingerprint: other, primaryKind: 'siren', savedAt: 'later' });
      });

      expect(read().overrides.map((o: { savedAt: string }) => o.savedAt)).toEqual(['kept', 'later']);
    });

    it('puts the bytes on the disk before replacing the file', async () => {
      const order: string[] = [];
      const open = fs.promises.open;
      const rename = fs.promises.rename;

      jest.spyOn(fs.promises, 'open').mockImplementation((async (...args: never[]) => {
        const handle = await (open as never as (...a: never[]) => Promise<fs.promises.FileHandle>)(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          order.push('sync');
          return sync();
        };
        return handle;
      }) as never);

      jest.spyOn(fs.promises, 'rename').mockImplementation((async (...args: never[]) => {
        order.push('rename');
        return (rename as never as (...a: never[]) => Promise<void>)(...args);
      }) as never);

      const s = store();
      s.load();
      await s.update((data) => {
        data.overrides.push({ fingerprint: shade, primaryKind: 'lock', savedAt: 'now' });
      });

      expect(order).toEqual(['sync', 'rename']);
    });

    it('writes a file it can read again', async () => {
      const s = store();
      s.load();
      await s.update((data) => {
        data.overrides.push({ fingerprint: shade, primaryKind: 'window-covering', savedAt: 'now' });
        data.observations.push({ id: 'a', nodeId: 9, fingerprint: other, appliedAt: 'now', orphanedAt: null });
      });

      const reopened = store();
      reopened.load();

      expect(reopened.readOnly).toBe(false);
      expect(reopened.snapshot()).toEqual(s.snapshot());
    });

    it('creates the storage directory when Homebridge has not yet', async () => {
      directory = path.join(directory, 'not-made-yet');
      const s = store();
      s.load();

      await s.update((data) => {
        data.overrides.push({ fingerprint: shade, primaryKind: 'lock', savedAt: 'now' });
      });

      expect(read().overrides).toHaveLength(1);
    });
  });

  describe('holding on to what it returns', () => {
    it('hands out copies rather than its own records', () => {
      const s = loaded(valid());

      const snapshot = s.snapshot();
      snapshot.overrides[0].primaryKind = 'siren';
      snapshot.observations.splice(0);

      expect(s.overrideFor(shade)?.primaryKind).toBe('window-covering');
      expect(s.observationsFor(other)).toHaveLength(1);
    });
  });
});
