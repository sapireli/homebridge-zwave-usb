# Window covering controller

How `WindowCoveringFeature` decides what a covering is doing, what HomeKit is shown, and when a command
counts as carried out. Read this before the code.

## Structure

| Piece | File | Role |
|---|---|---|
| Controller | `src/zwave/coveringController.ts` | A pure reducer: `reduce(config, state, event)` returns `{ state, effects }`. It never reads a clock, timer, node or HomeKit; everything it needs, including the time, is in the event. A sequence of events replays identically. |
| Adapter | `src/features/WindowCoveringFeature.ts` | Turns HomeKit writes and driver reports into events, performs the effects (writes, polls, timers), settles HomeKit's promises, and publishes the controller's projection. |
| Helpers | `src/zwave/coveringTravel.ts` | Finding the position and stop value ids a device defines, and reading a position from the driver's cache. |
| Settings | `src/devices/deviceOverrides.ts` | Per-device `coalescePositionCommandsMs` and `minPositionCommandGapMs`. |

## What is known: `reported`

`reported` is the only record of where the covering is, and it says how far to trust it.

- `unknown`: nothing. HomeKit cannot take "no value" and 0% would read as closed, so nothing is published and a read
  fails with `HAP_COMMUNICATION_FAILURE`.
- `provisional`: a value from HomeKit's last display or the driver's cache, set only at startup. It is published as a
  last-known display and never satisfies a completion rule.
- `verified`: a device report, an answered poll, or the final Supervision success of a move. Only this decides
  `achieved` or `not-achieved`.

A verified position is never replaced by a provisional or unknown one.

## What was asked for, and who owns it

Commands are kept apart from what is known, and each timer or poll has exactly one owner, identified by a token.

| Owner | Id | Holds |
|---|---|---|
| Transport | `inFlight.id` | the one write on the wire |
| Debounce and gap | `pending.dispatch.token` (only while `waiting`) | a move held for the debounce window or the minimum gap |
| Reconcile | `active.token` | an accepted command being followed, its timer and its polls |
| Startup check | `probe.token` | the poll that verifies a provisional position |

Intent ids and tokens all come from one counter, `nextId`, so no two owners ever hold the same value. A poll result or
timer tick carries only a token; one that matches no owner is stale and changes nothing, which is how a retired timer or a
late result is ignored without any cancellation logic.

## Events and effects

Events: `Init`, `HomeKitMove`, `HomeKitStop`, `DispatchTick`, `WriteSettled`, `ValueReport`, `PollSettled`, `ReconcileTick`,
`Teardown`. Effects: `Write`, `Poll`, `ArmReconcileTimer`, `ArmDispatchTimer`, `SettleRequest`, `Log`. There is no effect for
publishing and none for canceling a timer.

Every request HomeKit makes is settled exactly once (`accepted`, `superseded` by a newer one, or `refused`). A refused
write leaves the command that was already being followed untouched.

## Echoes

zwave-js writes the commanded value into its cache as a `currentValue` the moment it accepts a command, untagged, whether
or not the covering moves. It marks its own cache writes as `source: "driver"` internally but removes that field from the
node events the plugin receives, so every event arrives untagged. A `currentValue` equal to the target of a move that is in
flight or being followed is therefore recorded as `ambiguous` (diagnostic only, never projected) and is not taken as the
device answering. 99 and 100 are one level, because HomeKit's 100% is Z-Wave's 99. The target value is never used.

## When a command is carried out

An accepted command is followed with a poll every two seconds (`RECONCILE_INTERVAL_MS`) until:

- **achieved:** for a move, a verified position within one percent (`POSITION_TOLERANCE`) of the target. Supervision
  `Success` on a move verifies the target at once.
- **not-achieved:** for a move, the position has been unchanged for `STALL_WINDOW_MS` (10 s) while outside tolerance.
- **achieved (stop):** the position has been unchanged for `STALL_WINDOW_MS`.
- **unconfirmed:** `RECONCILE_MAX_MS` (60 s) passed without progress and without any of the above, or the device could not
  be asked, or `RECONCILE_CEILING_MS` (10 minutes) passed since the command was accepted.

Progress is a move's verified position getting closer to its target than it has been, counting the verified position the
move started from when there was one (from a poll or a trusted device report; an echo does not count), so a covering that
moves away from its target, or back toward where it began, earns nothing. Each time it happens the 60 second deadline moves to 60 seconds from then, up to the ceiling, so a
covering of any travel time is followed while it is getting closer, and one that wanders or stops getting closer is given up on
60 seconds after its last progress. A stop gets no extension: it should come to rest within a few seconds.

A poll at the same position keeps the time the covering arrived there; a poll anywhere else restarts it. A device report
of a different position also disturbs it: a trusted report restarts the clock at the reported position, an echo clears it
until the next poll. Two matching readings are not evidence that a covering stopped: a covering can pause mid-travel.

## What HomeKit is shown

A pure function of state, evaluated in order:

1. `reported` unknown: nothing published; reads fail.
2. The newest command (pending, then in flight, then active) is a stop: target is the reported position, state STOPPED.
3. It is a move: target is the move's target, state is the direction from the reported position, with a two percent
   tolerance except at 0 and 100.
4. Otherwise: target is the reported position, state STOPPED.

The adapter publishes each characteristic only when it differs from what the characteristic already holds, because HAP
records a written `TargetPosition` itself and a refused write has to put the old one back.

## Startup

`Init` seeds `reported` as provisional from HomeKit's last displayed position (only if the service already existed, since a
new service holds the characteristic default), else from the driver's cache, else leaves it unknown. It always starts a probe:
an explicit poll, retried every five seconds (`PROBE_RETRY_MS`) for 30 seconds (`PROBE_WINDOW_MS`). The first device report or
answered poll makes `reported` verified and ends the probe.

## Device settings

| Setting | Meaning | Springs RSZ1 |
|---|---|---|
| `coalescePositionCommandsMs` | a move waits this long for a newer one to replace it | 600 |
| `minPositionCommandGapMs` | least time between the end of one write and the start of the next move; newest wins; a stop is never held | 1500 |

Two RSZ1 shades were seen to ignore, stop short of or pause on a command that arrived right behind another. A slider drag
reaches the plugin as a series of writes whose spacing depends on the HomeKit client (a few hundred milliseconds to about a
second were seen), so the debounce window collapses the fast ones and the gap spaces out the rest. Devices without these
settings get neither (both default to zero).

## Adapter guarantees

- Each `Write`, `Poll` and timer effect completes exactly once, with the id or token it was issued under.
- A poll the device does not answer is given up on after ten seconds and a late answer is dropped.
- A write or poll that throws while it is being set up is a refusal or an unanswered poll; it never leaves the transport or the
  reconcile waiting.
- A poll answer outside 0 to 100 is not a position.
- Replacing the node object restarts the controller from the new node, fails requests still waiting on the old one, and drops
  results from before the replacement (an epoch check, since the new controller reuses ids).
- A stopped feature settles new requests at once instead of leaving them pending.

## Constants

| Constant | Value | Basis |
|---|---|---|
| `POSITION_TOLERANCE` | 1 | RSZ1 shades settled within a percent of the target; a covering that reports in coarser steps would not satisfy it |
| `STABILITY_TOLERANCE` | 0 | a covering creeping half a percent a second changes by a whole percent in the window |
| `STALL_WINDOW_MS` | 10000 | about three times the longest mid-travel pause seen (about three seconds) on two RSZ1 shades; not validated beyond that |
| `RECONCILE_INTERVAL_MS` | 2000 | one poll per two seconds while traveling, so polls per move are about travel time divided by two |
| `RECONCILE_MAX_MS` | 60000 | how long a command is followed without progress; an RSZ1 takes about 25 seconds end to end |
| `RECONCILE_CEILING_MS` | 600000 | the longest any command is followed, however much progress it makes |
| `PROBE_WINDOW_MS`, `PROBE_RETRY_MS` | 30000, 5000 | initial values |
| poll timeout (adapter) | 10000 | the controller only re-arms from a settled poll |
| RSZ1 debounce, gap | 600, 1500 | see above |

## Invariants the tests assert

The generated-sequence tests replay short sequences exhaustively and long ones from a seeded generator, with stale tokens,
duplicates and results for writes no longer in flight mixed in, and check after every step that:

1. every request id is settled exactly once;
2. at most one write is in flight;
3. a result whose token is not current changes nothing and emits no effect;
4. a verified position comes only from a device report, an answered poll or a supervised move, and is never downgraded;
   a provisional one is set only by `Init`;
5. a live stop projects as stopped;
6. a driver-sourced report changes nothing;
7. `ambiguous` never reaches a projected value;
8. nothing is emitted after `Teardown`;
9. the projection is a pure function of state, checked against an independently written one;
10. an outcome is recorded only when the command is cleared;
11. a refused write never changes the command being followed;
12. a ready pending move never waits while the transport is free;
13. one reconcile timer per token;
14. nothing is published from unknown, and no verdict reads a provisional position;
15. no probe while a position is verified;
16. an unanswered poll never changes `reported`;
17. `Init` takes effect once;
18. every id and token is bound to one request or owner for good, and `nextId` advances once per new one;
19. a move is judged not achieved, or a stop achieved, only after every position seen since the command was accepted stayed
    the same for the stall window;
20. a followed command's deadline never moves earlier or past the ceiling, a stop's never moves, and a move's moves out only for
    an observation closer to its target than the starting position and every earlier observation (tracked independently).

A focused exhaustive test covers invariant 19 across interleavings of poll cycles, device reports and echoes.

## Running the tests

```
npm run build
npm run lint
npm test
```

`tests/zwave/coveringController.test.ts` holds the reducer and generated tests; `tests/features/WindowCoveringFeature.test.ts`
holds the adapter tests around a simulated device. To check that the tests actually fail when the code is wrong,
`scripts/covering-mutations.py` applies each of a set of deliberate breaks to the controller and adapter in turn and runs the
suite: `python3 scripts/covering-mutations.py .` from the repository root, with nothing else using the CPU (the generated tests
are time-sensitive under load). Every mutation should be reported as CAUGHT.

## Limits

- The constants above are measured on two Springs RSZ1 shades, which travel end to end in about 25 seconds and report whole
  percents. Other coverings may pause for longer than the stall window, report in coarser steps than the position tolerance
  (a covering that reports in steps larger than one percent may be judged not carried out when it reached its target), or take
  longer to answer a poll. A covering that takes longer than ten minutes to travel ends `unconfirmed` at the ceiling.
- Polling a covering that is traveling is real Z-Wave traffic, and a battery covering stays awake for it. A covering that
  sleeps between wake-ups cannot be polled until it wakes: its polls go unanswered and the command ends `unconfirmed`.
- Hold Position is covered by tests, and the stop path was exercised against a physical shade: a move was interrupted
  mid-travel, the shade stopped at 76%, subsequent polls remained at 76%, and the move was reported as not carried out rather
  than as reaching its target. Apple Home does not expose a Hold Position control, so this path has not been initiated through
  the Home app itself. (The shade's own remote can stop it, but that does not go through the plugin.)
- A covering that is still moving at the 60 second limit, or that never answers, ends `unconfirmed`; the plugin does not guess.
