import {
  confirmAfterMs,
  isSettled,
  noteDelivery,
  notePoll,
  noteWorkingElapsed,
  openWrite,
  writeStatus,
  UNKNOWN_DURATION_WAIT_MS,
  type WriteToken,
} from '../../src/platform/NodeParametersWrite';

const owner = { nodeId: 10 };

const opened = (over: Partial<Parameters<typeof openWrite>[0]> = {}): WriteToken =>
  openWrite({
    nodeId: 10,
    owner,
    fingerprint: 'abc',
    endpoint: 0,
    parameter: 7,
    bitMask: null,
    wrote: 30,
    readable: true,
    listening: true,
    ...over,
  });

/** A write that has been accepted and is waiting to be asked about. */
const accepted = (over: Partial<Parameters<typeof openWrite>[0]> = {}) =>
  noteDelivery(opened(over), { kind: 'accepted' }, 1_000);

describe('what a change to a parameter is doing', () => {
  describe('before anything is sent', () => {
    it('is being sent to a device that is awake', () => {
      expect(opened().state).toBe('sending');
    });

    it('is waiting in the queue of one that is asleep', () => {
      /**
       * Nothing is on the network yet and may not be for hours. A reader told it was being sent
       * would expect an answer that cannot come until the device wakes.
       */
      expect(opened({ listening: false }).state).toBe('queued');
    });

    it('says nothing at all where nothing has been asked for', () => {
      expect(writeStatus(null)).toMatchObject({ state: 'idle', wrote: null, parameter: null });
    });
  });

  describe('what the driver made of it', () => {
    it('does not settle a readable value on delivery alone', () => {
      /**
       * Acceptance is delivery and nothing more. The driver writes its own optimistic answer
       * into the cache afterward, so nothing short of asking the device settles this.
       */
      const token = accepted();

      expect(token.state).toBe('confirming');
      expect(token.sentAt).toBe(1_000);
      expect(isSettled(token.state)).toBe(false);
    });

    it('ends at sent for a value the device never reports', () => {
      // There is nothing to ask, so there is nothing to wait for and no silence to report.
      const token = accepted({ readable: false });

      expect(token.state).toBe('sent');
      expect(isSettled(token.state)).toBe(true);
    });

    it('waits while the device applies a change it accepted', () => {
      const token = noteDelivery(opened(), { kind: 'working', remainingMs: 4_000 }, 1_000);

      expect(token.state).toBe('working');
      expect(token.remainingMs).toBe(4_000);
      expect(isSettled(token.state)).toBe(false);
    });

    it('refuses with the code it was given, and settles there', () => {
      const token = noteDelivery(opened(), { kind: 'refused', code: 'device-rejected' }, 1_000);

      expect(token).toMatchObject({ state: 'refused', code: 'device-rejected', settledAt: 1_000 });
      expect(token.sentAt).toBeNull();
    });
  });

  describe('how long a device applying a change is left alone', () => {
    it('waits the whole duration the device reported', () => {
      /**
       * Asking earlier would read the old value from a device that is still working and settle
       * the write as different, which is terminal and cannot be taken back.
       */
      const token = noteDelivery(opened(), { kind: 'working', remainingMs: 300_000 }, 1_000);

      expect(confirmAfterMs(token)).toBe(300_000);
    });

    it('waits a short fixed time where the device reported no duration', () => {
      const token = noteDelivery(opened(), { kind: 'working', remainingMs: null }, 1_000);

      expect(confirmAfterMs(token)).toBe(UNKNOWN_DURATION_WAIT_MS);
    });

    it('asks once the time it asked for has passed', () => {
      const token = noteWorkingElapsed(
        noteDelivery(opened(), { kind: 'working', remainingMs: 4_000 }, 1_000),
        6_000,
      );

      expect(token).toMatchObject({ state: 'confirming', remainingMs: null });
    });

    it('leaves a write that was not working alone when the wait ends', () => {
      /**
       * The wait is a timer, and a timer can fire after the write it was started for has settled
       * another way or been replaced. Only a write that is working is waiting for it.
       */
      const settled = notePoll(accepted(), 30, 9_000);
      const sending = opened();

      expect(noteWorkingElapsed(settled, 11_000)).toMatchObject({
        state: 'confirmed',
        settledAt: 9_000,
      });
      expect(noteWorkingElapsed(sending, 11_000).state).toBe('sending');
      expect(noteWorkingElapsed(accepted(), 11_000).state).toBe('confirming');
    });

    it('waits for a device applying a change it will never report', () => {
      /**
       * A write-only value has nothing to confirm, but a device still applying the change is not
       * finished with it. Settling here would let the next write replace this one and send a
       * second change while the first was still being applied.
       */
      const working = noteDelivery(
        opened({ readable: false }),
        { kind: 'working', remainingMs: 300_000 },
        1_000,
      );

      expect(working).toMatchObject({ state: 'working', remainingMs: 300_000, settledAt: null });
      expect(isSettled(working.state)).toBe(false);
      expect(confirmAfterMs(working)).toBe(300_000);

      const done = noteWorkingElapsed(working, 301_000);

      expect(done).toMatchObject({ state: 'sent', settledAt: 301_000, remainingMs: null });
      expect(isSettled(done.state)).toBe(true);
      // Nothing can be asked of it, so nothing it could answer changes what it is.
      expect(notePoll(done, 30, 302_000).state).toBe('sent');
    });
  });

  describe('what the device answered', () => {
    it('is confirmed by the number that was written', () => {
      const token = notePoll(accepted(), 30, 9_000);

      expect(token).toMatchObject({
        state: 'confirmed',
        reported: 30,
        settledAt: 9_000,
      });
    });

    it('reports another number as another number, without calling it applied', () => {
      const token = notePoll(accepted(), 25, 9_000);

      expect(token).toMatchObject({ state: 'different', reported: 25, settledAt: 9_000 });
    });

    it('is unconfirmed where the device said nothing usable', () => {
      // `undefined` is no response at all; a throw is reported the same way by the caller.
      expect(notePoll(accepted(), undefined, 9_000).state).toBe('unconfirmed');
      expect(notePoll(accepted(), null, 9_000).state).toBe('unconfirmed');
      expect(notePoll(accepted(), Number.NaN, 9_000).state).toBe('unconfirmed');
      expect(notePoll(accepted(), undefined, 9_000).reported).toBeNull();
    });

    it('leaves a write that is not being confirmed alone', () => {
      /**
       * A late answer must not reopen a write that has settled, nor settle one that was never
       * sent. Only a write that is being confirmed is listening for one.
       */
      const settled = notePoll(accepted(), 30, 9_000);

      expect(notePoll(settled, 25, 11_000)).toMatchObject({ state: 'confirmed', reported: 30 });
      expect(notePoll(opened(), 30, 11_000).state).toBe('sending');
      expect(notePoll(accepted({ readable: false }), 30, 11_000).state).toBe('sent');
    });
  });

  it('tells the section what it is doing and no word the driver wrote', () => {
    const status = writeStatus(notePoll(accepted(), 25, 9_000));

    expect(status).toEqual({
      state: 'different',
      endpoint: 0,
      parameter: 7,
      bitMask: null,
      wrote: 30,
      reported: 25,
      sentAt: 1_000,
      settledAt: 9_000,
      remainingMs: null,
      code: null,
    });
  });

  it('separates what is still happening from what has stopped', () => {
    (['queued', 'sending', 'working', 'confirming'] as const).forEach((state) =>
      expect(isSettled(state)).toBe(false),
    );
    (['sent', 'confirmed', 'different', 'unconfirmed', 'refused'] as const).forEach((state) =>
      expect(isSettled(state)).toBe(true),
    );
    expect(isSettled('idle')).toBe(false);
  });
});
