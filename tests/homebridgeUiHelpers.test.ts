const { describeHealStart, healIsRunning,
  escapeHtml,
  formatRssi,
  describeRoute,
  renderDiagnostics,
  normalizeSecurityKey,
  getInvalidSecurityKeyFields,
  buildPluginConfig,
  describeCoveringTestResult,
  describeCoveringStopResult,
  NODE_ICONS,
  firmwareStateOf,
  nextFirmwareRecord,
  describeNodeActions,
  describeNodeNotices,
  withoutFirmwareProgress,
  describeBattery,
} = require('../homebridge-ui/public/ui-helpers.js');

describe('homebridge-ui security key helpers', () => {
  it('should normalize keys by trimming whitespace and uppercasing hex', () => {
    expect(normalizeSecurityKey(' abcd1234 ')).toBe('ABCD1234');
  });

  it('should flag non-empty keys that are not 32 hex characters', () => {
    const invalid = getInvalidSecurityKeyFields({
      S0_Legacy: '1234',
      S2_Authenticated: 'G'.repeat(32),
      S2_AccessControl: 'A'.repeat(32),
    });

    expect(invalid).toEqual(['S0_Legacy', 'S2_Authenticated']);
  });

  it('should preserve the last valid security keys when current form input is invalid', () => {
    const currentConfig = {
      platform: 'ZWaveUSB',
      name: 'Plugin',
      securityKeys: {
        S0_Legacy: 'A'.repeat(32),
      },
    };

    const result = buildPluginConfig(currentConfig, {
      name: 'Plugin',
      serialPort: '/dev/tty',
      inclusionTimeoutSeconds: 60,
      debug: false,
      securityKeys: {
        S0_Legacy: '1234',
        S2_Authenticated: '',
      },
    });

    expect(result.invalidSecurityKeyFields).toEqual(['S0_Legacy']);
    expect(result.config.securityKeys).toEqual(currentConfig.securityKeys);
  });

  it('should commit normalized valid security keys into the plugin config', () => {
    const result = buildPluginConfig({}, {
      name: 'Plugin',
      serialPort: '/dev/tty',
      inclusionTimeoutSeconds: 60,
      debug: true,
      securityKeys: {
        S2_Authenticated: 'ab'.repeat(16),
        S2_AccessControl_LR: '',
      },
    });

    expect(result.invalidSecurityKeyFields).toEqual([]);
    expect(result.config.securityKeys).toEqual({
      S0_Legacy: '',
      S2_Unauthenticated: '',
      S2_Authenticated: 'AB'.repeat(16),
      S2_AccessControl: '',
      S2_Authenticated_LR: '',
      S2_AccessControl_LR: '',
    });
  });

  it('should carry the sleeping-device heal policy through to the saved config', () => {
    const base = {
      name: 'Plugin',
      serialPort: '/dev/tty',
      inclusionTimeoutSeconds: 60,
      debug: false,
      securityKeys: {},
    };

    expect(
      buildPluginConfig({}, { ...base, healIncludesSleepingDevices: true }).config
        .healIncludesSleepingDevices,
    ).toBe(true);
    expect(
      buildPluginConfig({}, { ...base, healIncludesSleepingDevices: false }).config
        .healIncludesSleepingDevices,
    ).toBe(false);
  });
});

describe('homebridge-ui HTML escaping', () => {
  it('escapes the characters that can end an element or an attribute', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('renders a device name containing markup as text', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes single quotes, which close the single-quoted attributes this page uses', () => {
    expect(escapeHtml("x' onmouseover='evil()")).not.toContain("'");
  });

  it('leaves a JSON payload parseable once the browser decodes the attribute', () => {
    const update = { version: "1.2'3", url: 'https://example.test/f?a=1&b=2' };
    const attribute = escapeHtml(JSON.stringify(update));

    expect(attribute).not.toContain("'");
    // A browser decodes entities when the attribute is read back with getAttribute.
    const decoded = attribute
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(JSON.parse(decoded)).toEqual(update);
  });

  it('renders a missing value as an empty string rather than "undefined"', () => {
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
  });
});

describe('homebridge-ui formatRssi', () => {
  it('shows a measurement in dBm, including zero and the extremes', () => {
    expect(formatRssi(-86)).toBe('-86 dBm');
    expect(formatRssi(0)).toBe('0 dBm');
    expect(formatRssi(-128)).toBe('-128 dBm');
    expect(formatRssi(124)).toBe('124 dBm');
  });

  it.each(['N/A', 'Receiver saturated', 'No signal detected'])(
    'shows the words for an RSSI error state, %s, without a unit',
    (words) => {
      expect(formatRssi(words)).toBe(words);
    },
  );

  it.each([undefined, null, Number.NaN, Infinity, {}, [], true])(
    'shows nothing for a value that is not a measurement or words (%p)',
    (value) => {
      expect(formatRssi(value)).toBe('');
    },
  );

  it('leaves escaping to the caller', () => {
    expect(formatRssi('<b>x</b>')).toBe('<b>x</b>');
    expect(escapeHtml(formatRssi('<b>x</b>'))).toBe('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('homebridge-ui describeRoute', () => {
  it('says so when nothing was recorded', () => {
    expect(describeRoute(undefined)).toBe('not recorded');
  });

  it('describes a direct route with its ACK RSSI and data rate', () => {
    expect(
      describeRoute({ repeaters: [], direct: true, ackRSSI: -78, protocolDataRate: 3 }),
    ).toBe('direct (no repeaters), ACK RSSI -78 dBm, protocol/speed code 3');
  });

  it('lists the repeaters of a routed one in order', () => {
    expect(describeRoute({ repeaters: [4, 7], direct: false })).toBe('via 4 &rarr; 7');
  });

  it.each(['N/A', 'Receiver saturated', 'No signal detected'])(
    'shows the RSSI error state %s as words with no unit',
    (words) => {
      expect(describeRoute({ repeaters: [4], direct: false, ackRSSI: words })).toBe(
        `via 4, ACK RSSI ${words}`,
      );
    },
  );

  it('shows which two nodes the most recent transmission failed between', () => {
    expect(
      describeRoute({ repeaters: [4], direct: false, routeFailedBetween: [4, 5] }),
    ).toBe('via 4, a transmission recently failed between nodes 4 and 5');
  });

  it('ignores a failure pair that is not a pair', () => {
    expect(describeRoute({ repeaters: [], direct: true, routeFailedBetween: [4] })).toBe(
      'direct (no repeaters)',
    );
  });

  it('copes with a routed report that lost its repeaters', () => {
    expect(describeRoute({ direct: false })).toBe('via ');
  });

  it('escapes everything the plugin supplied', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = describeRoute({
      repeaters: [hostile],
      direct: false,
      ackRSSI: hostile,
      routeFailedBetween: [hostile, hostile],
    });

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('homebridge-ui renderDiagnostics', () => {
  const items = (html) =>
    [...html.matchAll(/<li>(.*?)<\/li>/gs)].map((match) => match[1].trim().replace(/\s+/g, ' '));

  const full = {
    nodeId: 5,
    name: "Nico's Shade",
    status: 4,
    neighbors: [4, 6, 8],
    lastWorkingRoute: {
      repeaters: [4],
      direct: false,
      ackRSSI: -86,
      protocolDataRate: 2,
      routeFailedBetween: [4, 5],
    },
    nextToLastWorkingRoute: { repeaters: [], direct: true, ackRSSI: -90, protocolDataRate: 3 },
    averageAckRSSI: -87,
    roundTripTimeMs: 740.6,
    commandsTX: 39,
    commandsRX: 38,
    commandsDroppedTX: 1,
    commandsDroppedRX: 0,
    lastSeen: '2026-10-19T04:09:20.410Z',
    backgroundRSSI: { rssiChannel0: -97, rssiChannel1: -104 },
  };

  it('titles the dialog with the node and its name as plain text', () => {
    expect(renderDiagnostics(full).title).toBe("Node 5 (Nico's Shade) radio and routes");
  });

  it('lays out every figure of a complete report', () => {
    expect(items(renderDiagnostics(full).html)).toEqual([
      'Neighbor nodes: 4, 6, 8',
      'Last working route: via 4, ACK RSSI -86 dBm, protocol/speed code 2, a transmission recently failed between nodes 4 and 5',
      'Next-to-last working route: direct (no repeaters), ACK RSSI -90 dBm, protocol/speed code 3',
      'Average ACK RSSI at the controller (first hop): -87 dBm',
      'Average round trip: 741 ms',
      'Commands sent / received: 39 / 38',
      'Commands dropped sending / receiving: 1 / 0',
      'Last seen: 2026-10-19T04:09:20.410Z',
      'Controller background RSSI (network-wide, not this node): ch0 -97 dBm, ch1 -104 dBm',
    ]);
  });

  it('says what the signal figures describe', () => {
    // The paragraphs wrap across lines in the markup; the reader sees them as running text.
    const text = renderDiagnostics(full).html.replace(/\s+/g, ' ');

    expect(text).toContain(
      "A route's ACK RSSI and the average ACK RSSI show the signal strength of acknowledgement frames received by the controller.",
    );
    expect(text).toContain(
      'they describe the first hop, usually the nearest repeater, not the device itself.',
    );
    expect(text).toContain(
      'Controller background RSSI is a separate, network-wide measurement of ambient radio noise.',
    );
    expect(text).toContain('Routes are chosen per transmission');
  });

  it('does not call the background measurement an acknowledgement', () => {
    const { html } = renderDiagnostics(full);

    const text = html.replace(/\s+/g, ' ');

    expect(text).not.toContain('Every RSSI');
    expect(text).not.toMatch(/background[^.]*acknowledg/i);
  });

  it('labels the aggregate as an average at the controller, never as this node\'s own signal', () => {
    const { html } = renderDiagnostics(full);

    expect(html).toContain('Average ACK RSSI at the controller (first hop)');
    expect(html).not.toContain("this node's frames");
    expect(html).not.toContain('Last ACK RSSI');
  });

  it('labels the background figures as the controller\'s, not the node\'s', () => {
    expect(renderDiagnostics(full).html).toContain(
      'Controller background RSSI (network-wide, not this node)',
    );
  });

  it('shows what is missing as missing', () => {
    expect(items(renderDiagnostics({ nodeId: 6, name: 'Remote' }).html)).toEqual([
      'Neighbor nodes: not available',
      'Last working route: not recorded',
      'Next-to-last working route: not recorded',
      'Average ACK RSSI at the controller (first hop): not recorded',
      'Average round trip: not recorded',
      'Commands sent / received: 0 / 0',
      'Commands dropped sending / receiving: 0 / 0',
      'Last seen: not recorded',
      'Controller background RSSI (network-wide, not this node): not available',
    ]);
  });

  it.each([
    [127, 'N/A'],
    [126, 'Receiver saturated'],
    [125, 'No signal detected'],
  ])('shows RSSI error state %i as words in the average and in a background channel', (_code, words) => {
    const lines = items(
      renderDiagnostics({
        ...full,
        averageAckRSSI: words,
        backgroundRSSI: { rssiChannel0: words, rssiChannel1: -98 },
      }).html,
    );

    expect(lines).toContain(`Average ACK RSSI at the controller (first hop): ${words}`);
    expect(lines).toContain(
      `Controller background RSSI (network-wide, not this node): ch0 ${words}, ch1 -98 dBm`,
    );
    expect(lines.join(' ')).not.toMatch(/\b12[567] dBm/);
  });

  it('shows a counter that is not a number as 0', () => {
    const lines = items(
      renderDiagnostics({ ...full, commandsTX: '<b>1</b>', commandsRX: null, commandsDroppedTX: {} }).html,
    );

    expect(lines).toContain('Commands sent / received: 0 / 0');
    expect(lines).toContain('Commands dropped sending / receiving: 0 / 0');
  });

  it('writes nothing the plugin supplied into the markup unescaped', () => {
    const hostile = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
    const { html } = renderDiagnostics({
      ...full,
      neighbors: [hostile],
      lastWorkingRoute: {
        repeaters: [hostile],
        direct: false,
        ackRSSI: hostile,
        routeFailedBetween: [hostile, hostile],
      },
      averageAckRSSI: hostile,
      lastSeen: hostile,
      backgroundRSSI: { ['rssiChannel0' + hostile]: hostile },
    });

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
  });

  it('does not throw for a missing report', () => {
    expect(() => renderDiagnostics(undefined)).not.toThrow();
  });
});

describe('covering test result wording', () => {
  it('calls a test inconclusive when the covering was already at the commanded position', () => {
    // The presets include 0 and 100 and a shade usually sits at one of them, so this is the
    // most likely click. Reporting it as a pass would hand a dead covering a clean bill.
    const text = describeCoveringTestResult({
      requested: 100,
      before: 100,
      after: 100,
      reached: false,
      startedAtTarget: true,
    });

    expect(text).toContain('already there');
    expect(text).not.toContain('moved there');
  });

  it('reports a covering that moved to the commanded position', () => {
    const text = describeCoveringTestResult({
      requested: 25,
      before: 81,
      after: 25,
      reached: true,
      startedAtTarget: false,
    });

    expect(text).toContain('moved there');
    expect(text).toContain('from 81%');
  });

  it('never claims a command was accepted, which the plugin cannot know', () => {
    const text = describeCoveringTestResult({
      requested: 25,
      before: 81,
      after: 81,
      reached: false,
      startedAtTarget: false,
    });

    expect(text).toContain('did not reach');
    expect(text).not.toMatch(/accepted/i);
  });

  it('says a position the covering never reported is unknown', () => {
    const text = describeCoveringTestResult({
      requested: 25,
      before: null,
      after: null,
      reached: false,
      startedAtTarget: false,
    });

    expect(text).toContain('an unknown position');
  });

  it('credits a stop only when the covering moved and then rested short of its target', () => {
    expect(
      describeCoveringStopResult({
        before: 60,
        after: 76,
        target: 100,
        shortOfTarget: true,
        moved: true,
        timedOut: false,
      }),
    ).toContain('consistent with the stop taking effect');
  });

  it('says when the earlier position was read, so it is not taken for where the move began', () => {
    // The covering was opening from well below 60% when the stop was sent; 60% is where it had
    // got to by then, not where it started. Naming only the two numbers invites the reader to
    // treat the first as the starting position and conclude the covering barely moved.
    const text = describeCoveringStopResult({
      before: 60,
      after: 76,
      target: 100,
      shortOfTarget: true,
      moved: true,
      timedOut: false,
    });

    expect(text).toContain('It was at 60% when the stop was sent');
    expect(text).toMatch(/^Ended at 76%, short of its target of 100%\./);
  });

  it('refuses to credit a stop when the covering never moved', () => {
    // A covering sitting at 76% with a stale target of 100% rests short of it without ever
    // receiving the stop. Crediting that would invent evidence out of a stale number.
    const text = describeCoveringStopResult({
      before: 76,
      after: 76,
      target: 100,
      shortOfTarget: false,
      moved: false,
      timedOut: false,
    });

    expect(text).toContain('never reported moving');
    expect(text).not.toContain('taking effect');
  });

  it('refuses to credit a stop that timed out', () => {
    const text = describeCoveringStopResult({
      before: 60,
      after: 40,
      target: 0,
      shortOfTarget: false,
      moved: true,
      timedOut: true,
    });

    expect(text).toContain('cannot be credited');
  });

  it('reports a position test that timed out as establishing nothing', () => {
    const text = describeCoveringTestResult({
      requested: 25,
      before: 81,
      after: 25,
      reached: false,
      startedAtTarget: false,
      timedOut: true,
    });

    // Even when the last sample happens to equal the target.
    expect(text).toContain('still reporting movement');
    expect(text).not.toContain('moved there');
  });

  it('refuses to credit a stop that ended at the target', () => {
    // A covering that ignored the stop finishes its travel and rests on the target, which looks
    // exactly like a stop that worked.
    const text = describeCoveringStopResult({
      before: 60,
      after: 0,
      target: 0,
      shortOfTarget: false,
      moved: true,
      timedOut: false,
    });

    expect(text).toContain('proved nothing');
    expect(text).not.toContain('took effect');
  });
});

describe('route rebuild helpers', () => {
  it('watches for the rebuild to end when one was started', () => {
    expect(describeHealStart('started')).toEqual({
      status: expect.stringContaining('Rebuilding routes'),
      watch: true,
    });
  });

  it('waits for a rebuild that was already running elsewhere', () => {
    // busy is not a failure: the driver is rebuilding from a request this plugin no longer
    // tracks, so there is something to wait for.
    const outcome = describeHealStart('busy');

    expect(outcome.watch).toBe(true);
    expect(outcome.status).toContain('already running');
  });

  it('does not watch when the controller refused', () => {
    expect(describeHealStart('refused')).toEqual({
      status: 'The controller did not start a route rebuild.',
      watch: false,
    });
  });

  it('treats an unrecognized outcome as refused rather than watching forever', () => {
    expect(describeHealStart('something new' as never).watch).toBe(false);
  });

  it.each([
    [{ healing: true, rebuilding: false }, true],
    [{ healing: false, rebuilding: true }, true],
    [{ healing: true, rebuilding: true }, true],
    [{ healing: false, rebuilding: false }, false],
    [undefined, false],
  ])('reads %p as running=%p', (state, running) => {
    // A rebuild this plugin did not start shows only in rebuilding, which is the whole reason
    // the status route reports both.
    expect(healIsRunning(state as never)).toBe(running);
  });
});

// The management page is not part of the TypeScript build. Parse its actual script so
// integrating independent UI changes cannot ship a page that fails before wiring controls.
const node = (over: Record<string, unknown> = {}) => ({
  nodeId: 5,
  name: "Nico's Shade",
  status: 4,
  isListening: true,
  ...over,
});

/** One step of the transition table: the record a phase leaves behind, advanced by one event. */
const step = (phase: string | null, event: Record<string, unknown>, version?: string) =>
  nextFirmwareRecord(phase === null ? null : { phase, version }, event);

const stateFor = (phase: string | null, version?: string) =>
  firmwareStateOf(node(), phase === null ? undefined : { phase, version });

describe('firmware state derivation', () => {
  it('reads the state the plugin reports in preference to the one the page remembers', () => {
    // A refresh arriving mid-update must not put the row back to whatever was last clicked.
    const updating = { firmwareProgress: { percent: 37.5 } };
    const done = { firmwareProgress: { percent: 100, outcome: 'success' } };
    const broke = { firmwareProgress: { percent: 100, outcome: 'failure' } };
    const remembered = { phase: 'available', version: '11.4' };

    expect(firmwareStateOf(node(updating), remembered)).toEqual({ name: 'updating', percent: 37.5 });
    expect(firmwareStateOf(node(done), remembered)).toEqual({ name: 'completed', percent: 100 });
    expect(firmwareStateOf(node(broke), remembered)).toEqual({ name: 'failed', percent: 100 });
  });

  it('falls back to idle once the plugin stops reporting progress', () => {
    expect(firmwareStateOf(node(), undefined)).toEqual({ name: 'idle' });
    expect(firmwareStateOf(node(), null)).toEqual({ name: 'idle' });
  });

  it('keeps a check, a found update and a starting update across a refresh', () => {
    // The node list is refetched every five seconds; none of these three may be reset by it.
    expect(stateFor('checking')).toEqual({ name: 'checking' });
    expect(stateFor('available', '11.4')).toEqual({ name: 'available', version: '11.4' });
    expect(stateFor('starting', '11.4')).toEqual({ name: 'starting', version: '11.4' });
  });

  it('shows no progress rather than NaN when the plugin reports an unusable percentage', () => {
    expect(firmwareStateOf(node({ firmwareProgress: {} }), null)).toEqual({
      name: 'updating',
      percent: 0,
    });
  });
});

describe('firmware transitions', () => {
  it('idle: clicking Check Update starts a check', () => {
    expect(step(null, { type: 'check-clicked' })).toEqual({
      record: { phase: 'checking' },
      toast: null,
      start: false,
    });
  });

  it('checking: an update that comes back is remembered by version alone', () => {
    const result = step('checking', {
      type: 'check-result',
      updates: [{ version: '11.4', files: ['payload'] }],
    });

    expect(result.record).toEqual({ phase: 'available', version: '11.4' });
    // The payload must not survive the check; it is fetched again at the moment it is sent.
    expect(JSON.stringify(result.record)).not.toContain('payload');
  });

  it('checking: no update, or a failed check, returns the node to idle', () => {
    const empty = step('checking', { type: 'check-result', updates: [] });
    expect(empty.record).toBeNull();
    expect(empty.toast).toEqual({ type: 'info', text: 'No updates available for this device.' });

    // A failed check reports the error itself, so the machine claims no wording of its own.
    expect(step('checking', { type: 'check-failed' })).toEqual({
      record: null,
      toast: null,
      start: false,
    });
  });

  it('available: opening and cancelling the dialog change nothing and send nothing', () => {
    const open = step('available', { type: 'update-clicked' }, '11.4');
    const cancel = step('available', { type: 'dialog-cancelled' }, '11.4');

    expect(open.record).toEqual({ phase: 'available', version: '11.4' });
    expect(cancel.record).toEqual({ phase: 'available', version: '11.4' });
    expect(open.start).toBe(false);
    expect(cancel.start).toBe(false);
  });

  it('available: confirming the dialog moves to starting without sending anything yet', () => {
    expect(step('available', { type: 'dialog-confirmed' }, '11.4')).toEqual({
      record: { phase: 'starting', version: '11.4' },
      toast: null,
      start: false,
    });
  });

  it('starting: the same version coming back is the one that gets sent', () => {
    const result = step('starting', {
      type: 'recheck-result',
      updates: [{ version: '11.4' }],
    }, '11.4');

    expect(result.start).toBe(true);
    expect(result.record).toEqual({ phase: 'starting', version: '11.4' });
  });

  it('starting: a different version is stored and reported, and nothing is sent', () => {
    const result = step('starting', {
      type: 'recheck-result',
      updates: [{ version: '11.5' }],
    }, '11.4');

    expect(result.start).toBe(false);
    expect(result.record).toEqual({ phase: 'available', version: '11.5' });
    expect(result.toast).toEqual({
      type: 'info',
      text:
        'The available firmware update changed to v11.5. The update was not started. Select Update again to continue.',
    });
  });

  it('starting: an update that has gone away returns the node to idle', () => {
    const result = step('starting', { type: 'recheck-result', updates: [] }, '11.4');

    expect(result.start).toBe(false);
    expect(result.record).toBeNull();
    expect(result.toast).toEqual({
      type: 'info',
      text: 'That firmware update is no longer available. The update was not started.',
    });
  });

  it('starting: a failed re-check or a refused start leaves the update there to retry', () => {
    for (const type of ['recheck-failed', 'start-rejected']) {
      const result = step('starting', { type }, '11.4');
      expect(result.record).toEqual({ phase: 'available', version: '11.4' });
      expect(result.start).toBe(false);
    }
  });

  it('never offers an update it cannot name', () => {
    // Without this the row would advertise an update to "vundefined".
    expect(step('starting', { type: 'recheck-failed' }, undefined).record).toBeNull();
    expect(step('checking', { type: 'check-result', updates: [{}] }).record).toBeNull();
  });

  it('forgets the update once the plugin confirms it finished', () => {
    /**
     * The request only resolves when the transfer is over and only when it succeeded, so the
     * page knows the update is done without being told again by a refresh. Leaving the record
     * would hold a disabled spinner in the row until a refresh happened to correct it, and a
     * refresh can fail.
     */
    expect(step('starting', { type: 'update-finished' }, '1.31')).toEqual({
      record: null,
      toast: null,
      start: false,
    });
  });

  it('drops a progress snapshot that has outlived its update', () => {
    /**
     * The page redraws from the node list it last fetched, and the plugin keeps its own
     * progress for thirty seconds, so a bar that has finished moving would go on being drawn
     * from that snapshot until a refresh replaced it.
     */
    const nodes = [
      { nodeId: 4, name: 'Repeater', firmwareProgress: { percent: 100, outcome: 'success' } },
      { nodeId: 5, name: 'Shade', firmwareProgress: { percent: 40 } },
    ];
    const stripped = withoutFirmwareProgress(nodes, 4);

    expect(stripped[0].firmwareProgress).toBeUndefined();
    expect(stripped[0].name).toBe('Repeater');
    // Another node's update is none of its business.
    expect(stripped[1].firmwareProgress).toEqual({ percent: 40 });
    // And the list it was given is left as it was.
    expect(nodes[0].firmwareProgress).toEqual({ percent: 100, outcome: 'success' });
  });

  it('matches a node id given as a string or a number', () => {
    const nodes = [{ nodeId: 4, firmwareProgress: { percent: 100 } }];

    expect(withoutFirmwareProgress(nodes, '4')[0].firmwareProgress).toBeUndefined();
    expect(withoutFirmwareProgress(nodes, 4)[0].firmwareProgress).toBeUndefined();
    expect(withoutFirmwareProgress(nodes, 9)[0].firmwareProgress).toEqual({ percent: 100 });
  });

  it('a node that is gone is forgotten from any state', () => {
    for (const phase of ['checking', 'available', 'starting']) {
      expect(step(phase, { type: 'node-gone' }, '11.4').record).toBeNull();
    }
  });
});

describe('node action cell', () => {
  const actionsFor = (phase: string | null, version?: string, over = {}) =>
    describeNodeActions(node(over), firmwareStateOf(node(over), phase === null ? null : { phase, version }));

  it('idle shows the five actions as icons, keeping the classes the page delegates on', () => {
    const result = actionsFor(null);

    expect(result.kind).toBe('buttons');
    expect(result.buttons.map((b: any) => b.action)).toEqual([
      'rename-node',
      'refresh-node-info',
      'node-diagnostics',
      'check-update',
      'remove-node',
    ]);
    expect(result.buttons.map((b: any) => b.variant)).toEqual([
      'outline-secondary',
      'outline-secondary',
      'outline-secondary',
      'outline-primary',
      'outline-danger',
    ]);
    result.buttons.forEach((button: any) => {
      expect(NODE_ICONS[button.icon]).toBeTruthy();
      expect(button.label).toBeTruthy();
      expect(button.disabled).toBe(false);
    });
  });

  it('marks Refresh Info for the devices that have to be woken first', () => {
    const sleeping = actionsFor(null, undefined, { isListening: false, isFrequentListening: false });
    const awake = actionsFor(null, undefined, { isListening: true });
    const slotOf = (result: any) =>
      result.buttons.find((b: any) => b.action === 'refresh-node-info');

    expect(slotOf(sleeping).requiresWakeup).toBe(true);
    expect(slotOf(awake).requiresWakeup).toBe(false);
  });

  it('checking and starting show a disabled spinner in the Check Update slot only', () => {
    for (const phase of ['checking', 'starting']) {
      const result = actionsFor(phase, '11.4');
      const slot = result.buttons.find((b: any) => b.action === 'check-update');

      expect(slot.spinner).toBe(true);
      expect(slot.disabled).toBe(true);
      expect(result.buttons.filter((b: any) => b.disabled)).toHaveLength(1);
      expect(result.buttons).toHaveLength(5);
    }
  });

  it('an available update turns the same slot into a green Update button', () => {
    const result = actionsFor('available', '11.4');
    const slot = result.buttons[3];

    expect(slot).toMatchObject({
      action: 'start-update',
      variant: 'success',
      label: 'Update to v11.4',
      disabled: false,
      spinner: false,
    });
    expect(result.buttons).toHaveLength(5);
  });

  it('a running, finished or failed update replaces the group with a progress bar', () => {
    const bar = (progress: Record<string, unknown>) =>
      describeNodeActions(node(), firmwareStateOf(node({ firmwareProgress: progress }), null));

    expect(bar({ percent: 37.5 })).toEqual({ kind: 'progress', percent: 38, failed: false });
    expect(bar({ percent: 100, outcome: 'success' })).toEqual({
      kind: 'progress',
      percent: 100,
      failed: false,
    });
    expect(bar({ percent: 100, outcome: 'failure' })).toEqual({
      kind: 'progress',
      percent: 100,
      failed: true,
    });
  });

  it('leaves the controller row without actions', () => {
    expect(describeNodeActions(node({ nodeId: 1 }), { name: 'idle' })).toEqual({
      kind: 'controller',
    });
  });
});

describe('node notices', () => {
  const noticesFor = (over: Record<string, unknown>, phase: string | null = null, version?: string) =>
    describeNodeNotices(
      node(over),
      firmwareStateOf(node(over), phase === null ? null : { phase, version }),
    );

  it('says nothing about a node with nothing to report', () => {
    expect(noticesFor({})).toEqual([]);
  });

  it('carries each status with the wording and severity it was given', () => {
    expect(noticesFor({ refreshState: 'waiting-wakeup' })).toEqual([
      { severity: 'pending', text: 'Refresh queued until the device wakes', link: null },
    ]);
    expect(noticesFor({ refreshState: 'refreshing' })).toEqual([
      { severity: 'info', text: 'Refresh in progress', link: null },
    ]);
    expect(noticesFor({ homekitState: 'cached-pending' })).toEqual([
      {
        severity: 'pending',
        text: 'Cached in HomeKit; waiting for the device to wake so the interview can continue',
        link: null,
      },
    ]);
    expect(noticesFor({ homekitState: 'pending-interview' })).toEqual([
      { severity: 'pending', text: 'Not yet in HomeKit; waiting for interview metadata', link: null },
    ]);
  });

  it('carries each firmware state with the wording and severity it was given', () => {
    expect(noticesFor({}, 'available', '11.4')).toEqual([
      { severity: 'info', text: 'Firmware update available: v11.4', link: null },
    ]);
    expect(noticesFor({ firmwareProgress: { percent: 40 } })).toEqual([
      { severity: 'info', text: 'Updating firmware', link: null },
    ]);
    expect(noticesFor({ firmwareProgress: { percent: 100, outcome: 'success' } })).toEqual([
      { severity: 'info', text: 'Firmware update completed', link: null },
    ]);
    expect(noticesFor({ firmwareProgress: { percent: 100, outcome: 'failure' } })).toEqual([
      { severity: 'error', text: 'Firmware update failed', link: null },
    ]);
  });

  it('says nothing while a check or a start is in flight, because the spinner says it', () => {
    expect(noticesFor({}, 'checking')).toEqual([]);
    expect(noticesFor({}, 'starting', '11.4')).toEqual([]);
  });

  it('puts the most serious notice first', () => {
    const notices = noticesFor(
      { refreshState: 'refreshing', homekitState: 'cached-pending', firmwareProgress: { percent: 100, outcome: 'failure' } },
    );

    expect(notices.map((n: any) => n.severity)).toEqual(['error', 'pending', 'info']);
  });

  it('ignores a state it does not recognize rather than inheriting one from Object', () => {
    expect(noticesFor({ refreshState: 'constructor', homekitState: 'toString' })).toEqual([]);
  });
});

describe('battery indicator', () => {
  it('shows nothing for a device that has no battery to report', () => {
    // An empty shell would read as a flat battery rather than as a mains-powered device.
    expect(describeBattery({})).toBeNull();
    expect(describeBattery({ battery: undefined })).toBeNull();
    expect(describeBattery(undefined)).toBeNull();
  });

  it('fills the icon in fifths and names the exact figure', () => {
    const cases: [number, number][] = [
      [100, 5],
      [81, 5],
      [80, 4],
      [61, 4],
      [60, 3],
      [47, 3],
      [41, 3],
      [40, 2],
      [21, 2],
      [20, 1],
      [1, 1],
    ];

    cases.forEach(([level, fifths]) => {
      const battery = describeBattery({ battery: { level, low: false } });
      expect(battery.fifths).toBe(fifths);
      // A level at or under a fifth is low, and says so.
      expect(battery.text).toBe(level <= 20 ? `Battery low, ${level}%` : `Battery ${level}%`);
    });
  });

  it('draws an empty shell for a battery that reports zero', () => {
    /**
     * The shell is drawn whatever the charge, so an empty one still reads as a battery while a
     * device without one has no icon at all. Showing a fifth would invent charge the device
     * never claimed.
     */
    const battery = describeBattery({ battery: { level: 0, low: false } });

    expect(battery.fifths).toBe(0);
    expect(battery.text).toBe('Battery low, 0%');

    // A warning that arrived without a percentage invents nothing either.
    expect(describeBattery({ battery: { low: true } }).fifths).toBe(0);
    // One percent is still a sliver, because the device did report charge.
    expect(describeBattery({ battery: { level: 1, low: false } }).fifths).toBe(1);
  });

  it('calls a battery low at a fifth or less', () => {
    expect(describeBattery({ battery: { level: 21, low: false } }).low).toBe(false);
    expect(describeBattery({ battery: { level: 20, low: false } }).low).toBe(true);
    expect(describeBattery({ battery: { level: 5, low: false } }).low).toBe(true);
  });

  it('says the battery is low in words, not in color alone', () => {
    /**
     * The class turns the icon red, which a screen reader never sees and which someone who
     * cannot tell the two icons apart never sees either. The label carries the warning too.
     */
    expect(describeBattery({ battery: { level: 60, low: true } }).text).toBe('Battery low, 60%');
    expect(describeBattery({ battery: { level: 14, low: false } }).text).toBe('Battery low, 14%');
    expect(describeBattery({ battery: { low: true } }).text).toBe('Battery low');
    expect(describeBattery({ battery: { level: 80, low: false } }).text).toBe('Battery 80%');
  });

  it("honors the device's own warning whatever level it reports", () => {
    /**
     * Battery CC sends the low-battery warning in place of a percentage, and a device may also
     * raise it while still reporting a comfortable level. Reading only the number would show a
     * device that says it is failing as three fifths full and not low.
     */
    const warnedHigh = describeBattery({ battery: { level: 60, low: true } });
    expect(warnedHigh.low).toBe(true);
    expect(warnedHigh.fifths).toBe(3);
    expect(warnedHigh.text).toBe('Battery low, 60%');

    const warnedOnly = describeBattery({ battery: { low: true } });
    expect(warnedOnly.low).toBe(true);
    expect(warnedOnly.level).toBeUndefined();
    expect(warnedOnly.text).toBe('Battery low');
  });

  it('brings an impossible reading back into range', () => {
    expect(describeBattery({ battery: { level: 140, low: false } }).level).toBe(100);
    expect(describeBattery({ battery: { level: -5, low: false } }).level).toBe(0);
  });
});

describe('management page integration', () => {
  it('has valid inline JavaScript and one instance of each modal', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const match of scripts) expect(() => new Function(match[1])).not.toThrow();
    for (const id of ['diagnosticsModal', 'removeNodeModal', 'renameModal', 'confirmModal']) {
      expect(html.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
    }
  });

  /**
   * Nesting depth of an offset inside JavaScript source, counting brackets but not those in
   * strings, template literals or comments. A listener registered at depth 0 runs when the page
   * loads; one nested inside another handler runs only after that handler has fired.
   */
  const depthAt = (source: string, offset: number): number => {
    let depth = 0;
    let quote: string | null = null;
    // Depth at which each open `${` sat, so its `}` is matched rather than counted as a close.
    const templates: number[] = [];
    let comment: 'line' | 'block' | null = null;

    for (let i = 0; i < offset; i += 1) {
      const c = source[i];
      const next = source[i + 1];

      if (comment === 'line') {
        if (c === '\n') comment = null;
        continue;
      }
      if (comment === 'block') {
        if (c === '*' && next === '/') {
          comment = null;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (c === '\\') i += 1;
        else if (c === quote) quote = null;
        else if (quote === '`' && c === '$' && next === '{') {
          templates.push(depth);
          quote = null;
          i += 1;
        }
        continue;
      }
      if (c === '/' && next === '/') {
        comment = 'line';
        i += 1;
        continue;
      }
      if (c === '/' && next === '*') {
        comment = 'block';
        i += 1;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c;
        continue;
      }
      if (c === '(' || c === '[') depth += 1;
      else if (c === ')' || c === ']') depth -= 1;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        if (templates.length > 0 && templates[templates.length - 1] === depth) {
          templates.pop();
          quote = '`';
        } else depth -= 1;
      }
    }
    return depth;
  };

  it('measures nesting depth without being fooled by strings or comments', () => {
    // The scanner is the instrument for the assertion below, so it is checked first.
    expect(depthAt('a(); MARK', 'a(); '.length)).toBe(0);
    expect(depthAt('f(() => { MARK', 'f(() => { '.length)).toBe(2);
    expect(depthAt('const s = "{{{"; MARK', 'const s = "{{{"; '.length)).toBe(0);
    expect(depthAt('const s = `x${ y }z`; MARK', 'const s = `x${ y }z`; '.length)).toBe(0);
    // Interpolation inside an open block: the `}` of `${}` must not close the block.
    expect(depthAt('f(() => { `a${ b }c`; MARK', 'f(() => { `a${ b }c`; '.length)).toBe(2);
    expect(depthAt('// {{{\nMARK', '// {{{\n'.length)).toBe(0);
    expect(depthAt('/* {{{ */ MARK', '/* {{{ */ '.length)).toBe(0);
  });

  it('registers the Rebuild Routes listener at page load, not inside another handler', () => {
    /**
     * It was nested inside the Remove confirmation handler, so Rebuild Routes did nothing until
     * a node had been removed, and every removal added another listener, making one click start
     * several rebuilds.
     */
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/index.html'), 'utf8');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1] as string;

    const registrationDepth = (id: string) => {
      const at = script.indexOf(`getElementById('${id}').addEventListener`);
      expect(at).toBeGreaterThan(-1);
      return depthAt(script, at);
    };

    /**
     * Compared with its siblings rather than against a fixed number, so the assertion keeps
     * meaning if the page gains or loses an enclosing wrapper.
     */
    const siblings = ['cancelRemoveNode', 'confirmRemoveNode', 'cleanupStaleAccessories'];
    const expected = registrationDepth(siblings[0]);
    siblings.forEach((id) => expect(registrationDepth(id)).toBe(expected));
    expect(registrationDepth('healNetwork')).toBe(expected);
  });

  const readPage = () => {
    const fs = require('fs');
    const path = require('path');
    return fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/index.html'), 'utf8');
  };

  describe('when the node list asks the plugin for nodes', () => {
    /**
     * The host writes a line into the Homebridge log for every request a custom UI makes, so a
     * page left open on a quiet network used to write one every five seconds for as long as it
     * stayed open, whether or not anyone was looking at it.
     */
    it('asks nothing while the page is hidden or the tab is elsewhere', () => {
      const page = readPage();

      expect(page).toMatch(
        /const maintenanceOnScreen = \(\) =>\s+document\.getElementById\('maintenance'\)\.classList\.contains\('active'\) &&\s+document\.visibilityState !== 'hidden';/,
      );
      expect(page).toMatch(/if \(!maintenanceOnScreen\(\)\) \{\s+scheduleNodePoll\(NODE_POLL_IDLE_MS\);\s+return;/);
    });

    it('asks at once when the page comes back', () => {
      expect(readPage()).toMatch(
        /visibilitychange[\s\S]{0,160}scheduleNodePoll\(0\);/,
      );
    });

    it('follows reported progress rather than an offered update', () => {
      /**
       * An update that is merely offered waits for the reader indefinitely, and the loader
       * deletes its record the moment real progress arrives, so counting records would poll
       * fast forever for an offer and slowly for an update actually running.
       */
      const page = readPage();

      expect(page).toContain('const NODE_POLL_BUSY_MS = 5000;');
      expect(page).toContain('const NODE_POLL_IDLE_MS = 30000;');
      expect(page).toMatch(
        /const nodeWorkInProgress = \(\) =>\s+rebuildWatching \|\| updatesRunning > 0 \|\| lastNodes\.some\(\(node\) => node\.firmwareProgress\);/,
      );
      expect(page).not.toMatch(/firmwareRecords\.size > 0/);
      expect(page).toContain('rebuildWatching = true;');
      expect(page).toContain('rebuildWatching = false;');
    });

    it('reads at once when work starts, rather than waiting out an armed interval', () => {
      /**
       * The cadence is chosen when a read settles, so work beginning between two reads would
       * otherwise go unobserved until an interval armed before it began ran out. A committed
       * update is counted separately from a reported one, because the device can take a while
       * to report progress and the transfer is running in the meantime.
       */
      const page = readPage();

      expect(page).toMatch(/const nodeWorkStarted = \(\) => \{\s+scheduleNodePoll\(0\);/);
      expect(page).toMatch(/rebuildWatching = true;\s+nodeWorkStarted\(\);/);
      expect(page).toMatch(/updatesRunning \+= 1;\s+nodeWorkStarted\(\);/);
      expect(page).toMatch(/\} finally \{\s+updatesRunning -= 1;/);
    });

    it('reads through one loader, so nothing overlaps and every caller resets the cadence', () => {
      const page = readPage();

      expect(page).toMatch(/const loadNodes = \(\) => \{\s+if \(nodesInFlight\) \{\s+return nodesInFlight;/);
      expect(page).toMatch(/\.finally\(\(\) => \{\s+nodesInFlight = null;/);
      expect(page).toMatch(
        /scheduleNodePoll\(\s+answered && !nodeWorkInProgress\(\) \? NODE_POLL_IDLE_MS : NODE_POLL_BUSY_MS,\s+\);/,
      );
    });

    it('starts through the scheduler, so Configuration asks for nothing', () => {
      const page = readPage();

      expect(page).toMatch(
        /Everything starts through the scheduler[\s\S]{0,160}scheduleNodePoll\(0\);/,
      );
      expect(page).not.toMatch(/\n\s+loadNodes\(\);\n\s+scheduleNodePoll\(/);
    });

    it('does not leave the old unconditional interval behind', () => {
      expect(readPage()).not.toMatch(/setInterval\(\(\) => \{\s+if \(document\.getElementById\('maintenance'\)/);
    });
  });

  it('answers a request that arrives before the plugin is up, without a stack trace', () => {
    const fs = require('fs');
    const path = require('path');
    const server = fs.readFileSync(path.join(__dirname, '../homebridge-ui/server.js'), 'utf8');

    expect(server).toContain('RequestError');
    expect(server).toMatch(/throw new RequestError\(/);
    expect(server).not.toMatch(/throw new Error\('Plugin IPC server not found/);
  });

  it('repairs the table contrast with selectors scoped to the Maintenance surface', () => {
    /**
     * config-ui-x ships a bare `td { color: #999 !important }` that the plugin's own rule
     * cannot beat, leaving every body cell at 2.85:1 on the light card, and its light values
     * for headings and muted text are never replaced under the dark themes, leaving 1.09:1 and
     * 3.02:1 on the dark one.
     */
    const html = readPage();

    expect(html).toMatch(
      /#nodeTable > tbody > tr > td \{ color: var\(--hb-text-color, #212529\) !important; \}/,
    );
    expect(html).toMatch(
      /body\.dark-mode #nodeTable > tbody > tr > td \{ color: #dee2e6 !important; \}/,
    );
    expect(html).toMatch(/body\.dark-mode #nodeTable > thead > tr > th \{ color: #e9ecef; \}/);
    expect(html).toMatch(/body\.dark-mode #maintenance \.text-muted \{ color: #adb5bd !important; \}/);
  });

  it('leaves every surface outside Maintenance alone', () => {
    /**
     * The Configuration tab and the dialogs were not measured, so no rule here may reach them.
     * A dark-mode `.text-muted` rule without `#maintenance` would restyle both.
     */
    const html = readPage();
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const darkRules = [...style.matchAll(/^\s*(body\.dark-mode[^{]*)\{/gm)].map(([, sel]) =>
      sel.trim(),
    );

    expect(darkRules.length).toBeGreaterThan(0);
    darkRules.forEach((selector) => {
      const scoped =
        selector.includes('#maintenance') ||
        selector.includes('#nodeTable') ||
        selector.includes('.node-notice') ||
        selector.includes('.battery');
      expect(`${selector} -> scoped`).toBe(`${selector} -> ${scoped ? 'scoped' : 'GLOBAL'}`);
    });
  });

  it('heads the action column "Actions" and leaves the status cell to the badge', () => {
    const html = readPage();

    expect(html).toMatch(/<th[^>]*>Actions<\/th>/);
    expect(html).not.toMatch(/<th[^>]*>Action<\/th>/);
    // The status texts live in the notice line now, so their lookup tables are gone from here.
    expect(html).not.toContain('refreshStateMap');
    expect(html).not.toContain('homeKitStateMap');
  });

  it('keeps no update payload in a global or in the markup', () => {
    /**
     * The payload used to be written into a data-update attribute and parsed back on click,
     * so a dialog left open while the device was offered a different version could send the
     * stale one. It is now read between the confirm-time re-check and the request.
     */
    const html = readPage();

    expect(html).not.toContain('activeUpdateData');
    expect(html).not.toContain('data-update=');
  });

  it('loads no resource beyond the one stylesheet it already had', () => {
    // An icon font or a second CDN would leave the table unreadable on a host with no internet.
    const external = [...readPage().matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);

    expect(external).toEqual([
      'https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css',
    ]);
  });

  it('draws the action cell and the notices from the helpers rather than deciding for itself', () => {
    const html = readPage();

    for (const helper of ['firmwareStateOf', 'describeNodeActions', 'describeNodeNotices']) {
      expect(html).toContain(`uiHelpers.${helper}(`);
    }
  });

  it('reports the update as completed, because the request resolves only when it is', () => {
    /**
     * zwave-js resolves updateFirmware() after the process has completed, the IPC route answers
     * in its `then`, and no layer in between sets a timeout. Announcing a start at that point
     * would report the end of the transfer as its beginning.
     */
    const html = readPage();

    expect(html).toContain("toast.success('Firmware update completed.')");
    expect(html).not.toContain('Firmware update started');
  });

  it('keeps the tooltip reading as a sentence inside the host UI', () => {
    /**
     * The page is served inside config-ui-x, which replays its own stylesheet into it and sets
     * `text-transform: uppercase` on `.btn`. A pseudo-element inherits that from the button it
     * belongs to, which turned every tooltip into SHOUTING and made it wider.
     */
    const html = readPage();

    expect(html).toMatch(/\.tip::after\s*\{[^}]*text-transform:\s*none/);
    expect(html).toMatch(/\.tip::after\s*\{[^}]*letter-spacing:\s*normal/);
  });

  it('centers every tooltip on its own button, with no button singled out', () => {
    // One rule for all five; the last button no longer anchors its tooltip differently.
    const html = readPage();

    expect(html).toMatch(/\.tip::after\s*\{[^}]*left:\s*50%/);
    expect(html).toMatch(/\.tip::after\s*\{[^}]*transform:\s*translateX\(-50%\)/);
    expect(html).not.toContain(':last-child::after');
  });

  it('stops the settings modal lending its own tooltip to anything on the page', () => {
    /**
     * A browser looks up the nearest ancestor carrying a title attribute, and the settings
     * modal around this page has one, so anything here without its own showed the modal's
     * "Plugin Config" beside the page's tooltip. An empty title ends that lookup, so every
     * element the page puts at the top level needs one, the backdrop included.
     */
    const html = readPage();
    const body = html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
    const topLevel = [...body.matchAll(/^ {2}<(\w+)([^>]*)>/gm)].filter(
      ([, tag]) => tag !== 'script',
    );

    expect(topLevel.length).toBeGreaterThan(1);
    topLevel.forEach(([, tag, attrs]) => {
      expect(`${tag} ${attrs}`).toContain('title=""');
    });

    // And on the buttons themselves, matched in the markup rather than in the comment.
    expect(html).toMatch(/title=""\s+data-tip=/);
  });

  it('carries notice colors for the dark themes as well as the light ones', () => {
    /**
     * config-ui-x puts `dark-mode` on the body and the card becomes #2b2b2b, where the light
     * colors measure between 1.92:1 and 3.02:1. Measured ratios are in the comment beside them.
     */
    const html = readPage();

    for (const severity of ['info', 'pending', 'error']) {
      expect(html).toMatch(new RegExp(`body\\.dark-mode[^}]*\\.node-notice\\.${severity}[^}]*color:`));
    }
  });

  it('gives every dialog the same button row', () => {
    /**
     * Cancel, OK, Save, Remove and Close all sit at the trailing edge of their dialog at one
     * spacing. The Close button had been left on an older row that sat tighter to the content
     * above it than the other three.
     */
    const html = readPage();

    expect(html.match(/<div class="modal-actions">/g)).toHaveLength(4);
    expect(html).not.toContain('text-right');
  });

  it('names the version in the confirmation, not just the warning', () => {
    /**
     * The button and the notice show the version, but the decision is taken in this dialog, so
     * it has to say what is about to be installed rather than warning in the abstract.
     */
    const script = [...readPage().matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1] as string;

    expect(script).toContain('Install firmware update v${offered.version}?');
    expect(script).toContain("firmwareRecords.get(String(nodeId))");
  });

  it('acts on a confirmed completion instead of waiting for a refresh to notice', () => {
    /**
     * The refresh that follows can fail, and the plugin drops its own progress thirty seconds
     * later, so a row left in `starting` or redrawn from a stale snapshot would keep a
     * disabled spinner or a moving bar with nothing left to correct it.
     */
    const script = [...readPage().matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1] as string;
    const success = script.slice(
      script.indexOf("await window.homebridge.request('start-update'"),
      script.indexOf("toast.success('Firmware update completed.')"),
    );

    expect(success).toContain("applyFirmwareEvent(nodeId, { type: 'update-finished' })");
    expect(success).toContain('uiHelpers.withoutFirmwareProgress(lastNodes, nodeId)');
  });

  it('puts the battery beside the name without disturbing the rename field', () => {
    /**
     * The rename dialog prefills from the name cell's text, so the indicator has to contribute
     * none: it is an SVG inside a span, written against the name with no space between them.
     */
    const html = readPage();

    expect(html).toContain('uiHelpers.describeBattery(node)');
    // A span takes no focus of its own, so the figure in the tooltip would be mouse-only.
    expect(html).toMatch(/tabindex="0"[^>]*data-tip="\$\{label\}"/);
    expect(html).toContain('${uiHelpers.escapeHtml(nodeName)}${batteryHtml(');
    expect(html).toMatch(/role="img" aria-label="\$\{label\}"/);
  });

  it('escapes every node-supplied value it writes into the row', () => {
    const script = [...readPage().matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1] as string;

    for (const written of ['notice.text', 'button.label', 'nodeName', "node.firmwareVersion || 'Unknown'"]) {
      expect(script).toContain(`uiHelpers.escapeHtml(${written})`);
    }
  });
});
