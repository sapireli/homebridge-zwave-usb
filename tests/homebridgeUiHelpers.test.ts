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
  describeFirmwareCell,
  firmwareProgressOf,
  describeNodeNotices,
  typeName,
  withoutFirmwareProgress,
  describeBattery,
  describeNodeStatus,
  describeNodeHeader,
  describeNodeDetail,
  nodeIdFromReviewLink,
  nextSectionTab,
  describeDiagnosticsSection,
  describeTypePanel,
  describeTypeForm,
  describeTypeExceptions,
  describeWriteRefusal,
  describeTypeWrite,
  describeWriteOutcome,
  describeParametersSection,
  describeParametersRefresh,
  parametersTabCount,
  parametersRefreshRunning,
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
      "A route's ACK RSSI and the average ACK RSSI show the signal strength of acknowledgment frames received by the controller.",
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

  it('idle shows the actions a node page offers, keeping the classes the page delegates on', () => {
    // Diagnostics is a section of the node's page rather than a button, so it is not here.
    const result = actionsFor(null);

    expect(result.kind).toBe('buttons');
    expect(result.buttons.map((b: any) => b.action)).toEqual([
      'rename-node',
      'refresh-node-info',
      'check-update',
      'remove-node',
    ]);
    expect(result.buttons.map((b: any) => b.variant)).toEqual([
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

  it('offers a way into every node but the controller, named for that node', () => {
    expect(actionsFor(null, undefined, { nodeId: 7 }).open).toEqual({
      action: 'open-node',
      label: 'Open node 7',
      variant: 'outline-secondary',
      icon: 'open',
      disabled: false,
      spinner: false,
    });

    // It sits beside the group rather than in it, so it is not one of the things done to a node.
    expect(
      actionsFor(null, undefined, { nodeId: 7 }).buttons.map((b: any) => b.action),
    ).not.toContain('open-node');
    expect(describeNodeActions(node({ nodeId: 1 }), { name: 'idle' }).open).toBeUndefined();
  });

  it('offers the way in while a firmware update is running', () => {
    // The row shows progress in place of the group, and a node being updated is one a reader
    // is more likely to want to look at, not less.
    const updating = describeNodeActions(
      node({ nodeId: 7 }),
      firmwareStateOf(node({ nodeId: 7, firmwareProgress: { percent: 40 } }), null),
    ) as any;

    expect(updating.kind).toBe('progress');
    expect(updating.open).toMatchObject({ action: 'open-node', label: 'Open node 7' });
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
      expect(result.buttons).toHaveLength(4);
    }
  });

  it('an available update turns the same slot into a green Update button', () => {
    const result = actionsFor('available', '11.4');
    // The same slot, found by what it is rather than by where it sits in the group.
    const slot = result.buttons.find((b: any) => b.icon === 'update');

    expect(slot).toMatchObject({
      action: 'start-update',
      variant: 'success',
      label: 'Update to v11.4',
      disabled: false,
      spinner: false,
    });
    expect(result.buttons).toHaveLength(4);
  });

  it('a running, finished or failed update replaces the group with a progress bar', () => {
    const bar = (progress: Record<string, unknown>) => {
      const { open, active, label, ...rest } = describeNodeActions(
        node(),
        firmwareStateOf(node({ firmwareProgress: progress }), null),
      ) as any;
      return rest;
    };

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

  it('names the type a node is published as, and every node the decision reaches', () => {
    expect(noticesFor({ typeOverride: { primaryKind: 'window-covering', sharedWith: [] } })).toEqual([
      { severity: 'info', text: 'Window Covering, overridden for this hardware', link: null },
    ]);
    expect(noticesFor({ typeOverride: { primaryKind: 'garage-door', sharedWith: [8] } })).toEqual([
      {
        severity: 'info',
        text: 'Garage Door, overridden for this hardware (also applies to Node 8)',
        link: null,
      },
    ]);
    expect(
      noticesFor({ typeOverride: { primaryKind: 'lock', sharedWith: [8, 11] } }),
    ).toEqual([
      {
        severity: 'info',
        text: 'Lock, overridden for this hardware (also applies to Nodes 8 and 11)',
        link: null,
      },
    ]);
    expect(
      noticesFor({ typeOverride: { primaryKind: 'siren', sharedWith: [8, 11, 12] } }),
    ).toEqual([
      {
        severity: 'info',
        text: 'Siren, overridden for this hardware (also applies to Nodes 8, 11 and 12)',
        link: null,
      },
    ]);
  });

  it('sends a node whose decision needs looking at to its own page', () => {
    const review = { href: '#node-5', text: 'Review' };

    expect(noticesFor({ typeInvalid: true })).toEqual([
      {
        severity: 'warning',
        text: 'Saved type override cannot be applied to this device',
        link: review,
      },
    ]);
    expect(noticesFor({ typeOrphans: 1 })).toEqual([
      { severity: 'warning', text: 'A saved type override no longer matches this node', link: review },
    ]);
    expect(noticesFor({ typeOrphans: 3 })).toEqual([
      {
        severity: 'warning',
        text: '3 saved type overrides no longer match this node',
        link: review,
      },
    ]);
    expect(
      noticesFor({
        typeRebuildFailed: true,
        typeOverride: { primaryKind: 'window-covering', sharedWith: [] },
      })[0],
    ).toEqual({
      severity: 'warning',
      text: 'Window Covering is saved for this hardware but is not published here',
      link: review,
    });
  });

  it('reports a default that could not be restored without naming it', () => {
    // A node with no override applied belongs on its default, whether the override was
    // reverted or this node cannot take it. Its own page is where the default is named.
    expect(noticesFor({ typeRebuildFailed: true })).toEqual([
      {
        severity: 'warning',
        text: 'The default device type could not be restored',
        link: { href: '#node-5', text: 'Review' },
      },
    ]);
  });

  it('does not take a type name from the object prototype', () => {
    for (const kind of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(typeof typeName(kind)).toBe('string');
    }
    expect(typeName('constructor')).toBe('Constructor');
  });

  it('reads the worst of the type news first, and the rest in turn', () => {
    expect(
      noticesFor({
        typeOrphans: 2,
        typeRebuildFailed: true,
        typeOverride: { primaryKind: 'thermostat', sharedWith: [] },
        refreshState: 'refreshing',
      }).map((notice) => notice.text),
    ).toEqual([
      '2 saved type overrides no longer match this node',
      'Thermostat is saved for this hardware but is not published here',
      'Refresh in progress',
      'Thermostat, overridden for this hardware',
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

describe('a node status badge', () => {
  it('names each status a controller reports and calls anything else unknown', () => {
    expect([0, 1, 2, 3, 4].map((status) => describeNodeStatus({ status }).text)).toEqual([
      'Unknown',
      'Asleep',
      'Awake',
      'Dead',
      'Alive',
    ]);

    expect(describeNodeStatus({ status: 9 }).text).toBe('Unknown');
    expect(describeNodeStatus({}).text).toBe('Unknown');
    expect(describeNodeStatus(undefined).text).toBe('Unknown');
  });

  it('colors a node that is answering and leaves the rest plain', () => {
    expect(describeNodeStatus({ status: 4 }).tone).toBe('success');
    expect(describeNodeStatus({ status: 2 }).tone).toBe('success');

    [0, 1, 3].forEach((status) => expect(describeNodeStatus({ status }).tone).toBe('secondary'));
  });
});

describe('a node page header', () => {
  it('falls back from the name to the label to the number', () => {
    expect(describeNodeHeader({ nodeId: 5, name: 'Shade', label: 'ZW140' }).name).toBe('Shade');
    expect(describeNodeHeader({ nodeId: 5, label: 'ZW140' }).name).toBe('ZW140');
    expect(describeNodeHeader({ nodeId: 5 }).name).toBe('Node 5');
  });

  it('says when the firmware version has not been reported', () => {
    expect(describeNodeHeader({ nodeId: 5, firmwareVersion: '1.2' }).firmware).toBe('Firmware 1.2');
    expect(describeNodeHeader({ nodeId: 5 }).firmware).toBe('Firmware unknown');
  });

  it('says whether the node has to be woken before it will answer', () => {
    expect(describeNodeHeader({ nodeId: 5, isListening: true }).listening).toBe('Always listening');
    expect(describeNodeHeader({ nodeId: 5, isFrequentListening: true }).listening).toBe(
      'Listens frequently',
    );
    expect(describeNodeHeader({ nodeId: 5 }).listening).toBe('Sleeps between reports');
  });

  it('carries the same badge the list draws', () => {
    // One table of status names, so the two surfaces cannot come to disagree.
    const node = { nodeId: 4, status: 3 };

    expect(describeNodeHeader(node).status).toBe(describeNodeStatus(node).text);
    expect(describeNodeHeader(node).statusTone).toBe(describeNodeStatus(node).tone);
  });
});

describe('a node page description', () => {
  const node = { nodeId: 5, name: 'Shade', status: 4, isListening: true };

  it('offers Rename beside the name and the three controls below it', () => {
    const detail = describeNodeDetail(node, { name: 'idle' });

    expect(detail.rename.action).toBe('rename-node');
    expect(detail.controls.map((button: any) => button.action)).toEqual([
      'refresh-node-info',
      'check-update',
      'remove-node',
    ]);
  });

  it('leaves Diagnostics and the way in to the places that offer them', () => {
    // Diagnostics has a section of its own, and the way in is how the reader got here.
    const actions = describeNodeDetail(node, { name: 'idle' }).controls.map(
      (button: any) => button.action,
    );

    expect(actions).not.toContain('node-diagnostics');
    expect(actions).not.toContain('open-node');
  });

  it('offers the update in place of the check once one is waiting', () => {
    const detail = describeNodeDetail(node, { name: 'available', version: '2.0' });

    expect(detail.controls.map((button: any) => button.action)).toEqual([
      'refresh-node-info',
      'start-update',
      'remove-node',
    ]);
  });

  it('replaces the controls with progress while an update runs', () => {
    const detail = describeNodeDetail(node, { name: 'updating', percent: 40 });

    expect(detail.progress).toMatchObject({ percent: 40, failed: false });
    expect(detail.controls).toEqual([]);
    expect(detail.rename).toBeNull();
    expect(describeNodeDetail(node, { name: 'failed', percent: 70 }).progress.failed).toBe(true);
  });

  it('offers the controller nothing, since nothing here acts on it', () => {
    const detail = describeNodeDetail({ nodeId: 1 }, { name: 'idle' });

    expect(detail.rename).toBeNull();
    expect(detail.controls).toEqual([]);
    expect(detail.progress).toBeNull();
  });

  it('describes an unchanged node identically, which is what lets a refresh leave it alone', () => {
    /**
     * The page compares the description it is given against the one it drew and writes nothing
     * when they match. A description that differed between two passes over the same node would
     * defeat that and take the keyboard, and later a half-made choice, with every refresh.
     */
    const first = JSON.stringify(describeNodeDetail(node, { name: 'idle' }));
    const second = JSON.stringify(describeNodeDetail({ ...node }, { name: 'idle' }));

    expect(second).toBe(first);
  });

  it('describes it differently as soon as anything the page shows has moved', () => {
    const base = JSON.stringify(describeNodeDetail(node, { name: 'idle' }));

    expect(JSON.stringify(describeNodeDetail({ ...node, status: 3 }, { name: 'idle' }))).not.toBe(
      base,
    );
    expect(JSON.stringify(describeNodeDetail({ ...node, name: 'Blind' }, { name: 'idle' }))).not.toBe(
      base,
    );
    expect(
      JSON.stringify(describeNodeDetail({ ...node, firmwareVersion: '3.1' }, { name: 'idle' })),
    ).not.toBe(base);
    expect(
      JSON.stringify(describeNodeDetail(node, { name: 'available', version: '2.0' })),
    ).not.toBe(base);
  });
});

describe('a review link', () => {
  it('reads the node it points at', () => {
    expect(nodeIdFromReviewLink('#node-7')).toBe('7');
    expect(nodeIdFromReviewLink('#node-12')).toBe('12');
  });

  it('refuses anything else, so a link added later is not mistaken for one', () => {
    ['#node-', '#node-7x', '#nodes-7', '#other', '', null, undefined].forEach((href) =>
      expect(nodeIdFromReviewLink(href)).toBeNull(),
    );
  });
});

describe('the node page section strip', () => {
  const sections = ['type', 'diagnostics'];

  it('moves along the strip and wraps at both ends', () => {
    expect(nextSectionTab(sections, 'type', 'ArrowRight')).toBe('diagnostics');
    expect(nextSectionTab(sections, 'diagnostics', 'ArrowRight')).toBe('type');
    expect(nextSectionTab(sections, 'type', 'ArrowLeft')).toBe('diagnostics');
    expect(nextSectionTab(sections, 'diagnostics', 'ArrowLeft')).toBe('type');
  });

  it('answers Home and End', () => {
    expect(nextSectionTab(sections, 'diagnostics', 'Home')).toBe('type');
    expect(nextSectionTab(sections, 'type', 'End')).toBe('diagnostics');
  });

  it('leaves every other key to the page', () => {
    // Tab, Enter and typing have to reach what they normally reach.
    ['Tab', 'Enter', ' ', 'a', 'ArrowUp', 'Escape'].forEach((key) =>
      expect(nextSectionTab(sections, 'type', key)).toBeNull(),
    );
  });

  it('answers nothing for a section it does not carry', () => {
    expect(nextSectionTab(sections, 'parameters', 'ArrowRight')).toBeNull();
  });
});

describe('the Diagnostics section', () => {
  it('says it is reading until a report has arrived', () => {
    expect(describeDiagnosticsSection(undefined)).toEqual({ kind: 'loading' });
    expect(describeDiagnosticsSection({ loading: true })).toEqual({ kind: 'loading' });
  });

  it('reports a failure in place of the report rather than beside it', () => {
    expect(describeDiagnosticsSection({ error: 'The plugin did not answer.' })).toEqual({
      kind: 'error',
      text: 'The plugin did not answer.',
    });
  });

  it('offers the covering controls only for a covering', () => {
    expect(describeDiagnosticsSection({ report: { isWindowCovering: false } }).controls).toBeNull();
    expect(describeDiagnosticsSection({ report: { isWindowCovering: true } }).controls).toEqual({
      disabled: false,
      text: '',
    });
  });

  it('holds the controls while an operation is running', () => {
    /**
     * The section is drawn from this rather than from what is on screen, which is what lets an
     * operation keep running while the reader changes section or leaves the node and returns.
     */
    const running = describeDiagnosticsSection({
      report: { isWindowCovering: true },
      covering: { running: true, text: 'Moving to 25%...' },
    });

    expect(running.controls).toEqual({ disabled: true, text: 'Moving to 25%...' });

    const finished = describeDiagnosticsSection({
      report: { isWindowCovering: true },
      covering: { running: false, text: 'Commanded 25% from 0%, now 25%. The covering moved there.' },
    });

    expect(finished.controls!.disabled).toBe(false);
  });
});

describe('the Device type section', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    nodeId: 10,
    fingerprint: { manufacturerId: 2748, productType: 2, productId: 16 },
    label: '[SAMPLE SHADE]',
    multiEndpoint: false,
    primaryKind: 'window-covering',
    source: 'registry',
    defaultKind: 'window-covering',
    defaultSource: 'registry',
    registryLabel: 'Springs Window Fashions RSZ1',
    override: null,
    store: { readable: true, error: null },
    rebuildFailure: null,
    ...over,
  });

  const rowFor = (label: string, over: Record<string, unknown> = {}) =>
    describeTypePanel(payload(over)).rows.find((row: any) => row.label === label);

  it('names the type, where it came from, the label and the fingerprint', () => {
    const { rows } = describeTypePanel(payload());

    expect(rows.map((row: any) => row.label)).toEqual([
      'Published as',
      'Source',
      'Device label',
      'Hardware fingerprint',
    ]);
    expect(rows[0]).toMatchObject({ value: 'Window Covering', chip: 'Verified default' });
  });

  it('writes the fingerprint as three four-digit words', () => {
    expect(rowFor('Hardware fingerprint')).toMatchObject({
      hex: ['0x0ABC', '0x0002', '0x0010'],
      caption: 'Manufacturer, product type, product',
    });
  });

  it('takes the source row from the source, not from the default', () => {
    /**
     * A node whose default comes from the registry but which is published as something else
     * read as "Built-in verified registry", crediting the registry for a type it did not give.
     */
    expect(rowFor('Source')).toMatchObject({
      value: 'Built-in verified registry',
      detail: 'Springs Window Fashions RSZ1',
    });
    expect(rowFor('Source', { source: 'detected' })).toMatchObject({
      value: 'Detected automatically from the device',
      detail: null,
    });
    expect(rowFor('Source', { source: 'detected', defaultSource: 'registry' })).toMatchObject({
      value: 'Detected automatically from the device',
    });
  });

  it('dates an override and names what it replaced', () => {
    const source = rowFor('Source', {
      source: 'override',
      defaultKind: 'multilevel-switch',
      override: { primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
    }) as any;

    expect(source.value).toMatch(/^Your override, saved [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    expect(source.detail).toBe('Default for this node: Multilevel Switch');

    // The date is the override's own, not a constant.
    const later = rowFor('Source', {
      source: 'override',
      override: { primaryKind: 'window-covering', savedAt: '2025-03-04T12:00:00Z' },
    }) as any;

    expect(later.value).not.toBe(source.value);
  });

  it('names the chip for each source', () => {
    expect(rowFor('Published as', { source: 'detected' })!.chip).toBe('Detected default');
    expect(
      rowFor('Published as', {
        source: 'override',
        override: { primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
      })!.chip,
    ).toBe('Your override');
  });

  it('counts a repeated endpoint type rather than writing it out again', () => {
    const multi = rowFor('Published as', {
      multiEndpoint: true,
      primaryKind: null,
      source: 'detected',
      endpointTypes: [
        { endpointIndex: 1, primaryKind: 'garage-door' },
        { endpointIndex: 2, primaryKind: 'binary-switch' },
        { endpointIndex: 3, primaryKind: 'binary-switch' },
      ],
    });

    expect(multi!.value).toBe('Garage Door, 2 Binary Switches');
  });

  it('says a device with several functions cannot be overridden', () => {
    const { notices } = describeTypePanel(
      payload({ multiEndpoint: true, primaryKind: null, endpointTypes: [] }),
    );

    expect(notices).toContainEqual({
      severity: 'info',
      body: 'This device provides multiple independent functions. Type overrides are not available for this kind of device yet.',
    });
  });

  it('keeps the Device label row whether or not the device sent one', () => {
    /**
     * The label describes the hardware, not the type, so dropping it when the device had sent
     * none took a row away without saying anything had been left out.
     */
    expect(rowFor('Device label')).toMatchObject({ value: '[SAMPLE SHADE]' });
    expect(rowFor('Device label', { label: null })).toMatchObject({ value: 'Not reported' });
  });

  it('says so when a device publishes no type at all', () => {
    /**
     * An endpoint whose only function is its battery publishes nothing that can be changed, so
     * there is no type to name and no source to credit, and the section says why.
     */
    const { rows, notices } = describeTypePanel(payload({ primaryKind: null, label: 'ZW-BATT' }));

    expect(rows.map((row: any) => row.label)).toEqual(['Device label', 'Hardware fingerprint']);
    expect(notices).toContainEqual({
      severity: 'info',
      body: 'This device has no HomeKit device type that can be changed.',
    });
  });

  it('shows only the fingerprint row before a device has reported one', () => {
    /**
     * Nothing is said about what HomeKit publishes: a node waiting for metadata and an
     * accessory already cached with an unfinished interview both reach this state, and a
     * missing fingerprint does not tell them apart.
     */
    const { rows, notices } = describeTypePanel(
      payload({ fingerprint: null, primaryKind: null, label: null }),
    );

    expect(rows).toEqual([
      { label: 'Hardware fingerprint', value: 'Not reported yet', detail: null },
    ]);
    expect(notices).toEqual([
      { severity: 'info', body: "Available once the device's interview has finished." },
    ]);
  });

  it('warns in amber when the saved overrides cannot be read', () => {
    // The plugin and the device are working; saved configuration is being ignored.
    const { notices } = describeTypePanel(
      payload({ store: { readable: false, error: { code: 'wrong-network' } } }),
    );

    expect(notices[0].severity).toBe('warning');
    expect(notices[0].heading).toBe('Saved device type overrides are unavailable.');
    expect(notices[0].body).toContain('belongs to a different Z-Wave network');
    expect(notices[0].body).not.toContain('undefined');
  });

  it('has a sentence for every code the store reports', () => {
    const codes = [
      'permission-denied',
      'unreadable',
      'invalid-json',
      'unsupported-version',
      'wrong-network',
      'invalid-data',
    ];

    codes.forEach((code) => {
      const { notices } = describeTypePanel(
        payload({ store: { readable: false, error: { code } } }),
      );
      expect(notices[0].body).toContain('type changes are disabled');
    });
  });

  it('relabels the first row when HomeKit is not publishing the saved decision', () => {
    const saved = describeTypePanel(
      payload({
        source: 'override',
        defaultKind: 'multilevel-switch',
        override: { primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
        rebuildFailure: { error: 'HAP refused' },
      }),
    );

    expect(saved.rows[0].label).toBe('Saved type');
    expect(saved.panels[0]).toMatchObject({
      severity: 'warning',
      heading: 'The saved type has not been applied.',
    });
    expect(saved.panels[0].body).toContain('Window Covering is saved for this hardware');
    // The exception reached the reader in the toast; the log keeps it.
    expect(saved.panels[0].body).not.toContain('HAP refused');

    const reverted = describeTypePanel(
      payload({
        primaryKind: 'multilevel-switch',
        source: 'detected',
        defaultKind: 'multilevel-switch',
        rebuildFailure: { error: 'HAP refused' },
      }),
    );

    expect(reverted.rows[0].label).toBe('Default type');
    expect(reverted.panels[0].heading).toBe('The default type has not been restored.');
    expect(reverted.panels[0].body).toContain('Multilevel Switch is the default for this device');
  });
});

describe('choosing a device type', () => {
  const member = (nodeId: number, over: Record<string, unknown> = {}) => ({
    nodeId,
    name: `Node ${nodeId} shade`,
    primaryKind: 'window-covering',
    defaultKind: 'multilevel-switch',
    takesOverride: true,
    ...over,
  });

  const overridden = (over: Record<string, unknown> = {}) => ({
    nodeId: 10,
    fingerprint: { manufacturerId: 2748, productType: 2, productId: 16 },
    multiEndpoint: false,
    primaryKind: 'window-covering',
    source: 'override',
    defaultKind: 'multilevel-switch',
    defaultSource: 'detected',
    options: ['multilevel-switch', 'window-covering'],
    override: { primaryKind: 'window-covering', savedAt: '2026-10-12T18:20:00Z' },
    cohort: [member(10), member(11)],
    cohortRevision: 'abc',
    store: { readable: true, error: null },
    rebuildFailure: null,
    ...over,
  });

  const plain = (over: Record<string, unknown> = {}) =>
    overridden({
      primaryKind: 'multilevel-switch',
      source: 'detected',
      override: null,
      cohort: [member(10, { primaryKind: 'multilevel-switch' })],
      ...over,
    });

  it('says who else the choice reaches, before and after an override exists', () => {
    expect(describeTypeForm(plain(), null).cohort).toMatchObject({
      heading: 'A type chosen here applies to this hardware, not only to this node.',
      count: '1 node reports this fingerprint:',
    });

    expect(describeTypeForm(overridden(), null).cohort).toMatchObject({
      heading: 'This override is saved for the hardware, not only for this node.',
      count: '2 nodes report this fingerprint:',
    });
  });

  it('marks this node among the others, and names what one of them cannot take', () => {
    const chips = describeTypeForm(
      overridden({ cohort: [member(10), member(11, { takesOverride: false })] }),
      null,
    ).cohort.chips;

    expect(chips[0]).toMatchObject({ nodeId: 10, thisNode: true, note: null });
    expect(chips[1]).toMatchObject({
      nodeId: 11,
      thisNode: false,
      note: '(cannot take Window Covering)',
    });
  });

  it('offers the current type first, then the node default, then the rest', () => {
    expect(describeTypeForm(overridden(), null).select).toMatchObject({
      label: 'Publish this device as',
      value: 'window-covering',
    });

    expect(describeTypeForm(overridden(), null).select.options.map((o: any) => o.label)).toEqual([
      'Window Covering (your override)',
      'Multilevel Switch (detected default)',
    ]);

    expect(
      describeTypeForm(plain({ defaultSource: 'registry', source: 'registry' }), null).select.options.map(
        (o: any) => o.label,
      ),
    ).toEqual(['Multilevel Switch (verified default)', 'Window Covering']);
  });

  it('keeps the chosen type rather than the published one', () => {
    // The draft is passed in, so a refresh replaces the payload without touching the choice.
    const form = describeTypeForm(plain(), 'window-covering');

    expect(form.select.value).toBe('window-covering');
    expect(form.apply).toMatchObject({ label: 'Apply to 1 node', disabled: false });
  });

  it('counts the nodes an apply would change, and only those', () => {
    /**
     * A chosen type that is also every node's default is the Revert case whatever the count,
     * so this counts against a third type rather than against the default.
     */
    const form = describeTypeForm(
      overridden({
        options: ['multilevel-switch', 'window-covering', 'binary-switch'],
        cohort: [member(10), member(11), member(12, { primaryKind: 'binary-switch' })],
      }),
      'binary-switch',
    );

    expect(form.apply).toMatchObject({ label: 'Apply to 2 nodes', disabled: false });
  });

  it('refuses an apply that would change nothing', () => {
    // Mirrors the backend, which refuses a kind equal to the existing override.
    expect(describeTypeForm(overridden(), 'window-covering').apply).toMatchObject({
      label: 'Apply',
      disabled: true,
      hint: null,
    });
  });

  it('sends the reader to Revert when they have picked the default back', () => {
    expect(describeTypeForm(overridden(), 'multilevel-switch').apply).toMatchObject({
      label: 'Apply',
      disabled: true,
      hint: 'Use Revert to return to the default type.',
    });
  });

  it('offers Revert only against an override, and names what it returns to', () => {
    expect(describeTypeForm(plain(), null).revert).toBeNull();

    expect(describeTypeForm(overridden(), null).revert).toMatchObject({
      label: 'Revert 2 nodes to Multilevel Switch',
      disabled: false,
    });

    expect(
      describeTypeForm(overridden({ cohort: [member(10)] }), null).revert!.label,
    ).toBe('Revert 1 node to Multilevel Switch');
  });

  it('offers no Revert where there is nothing to revert', () => {
    /**
     * An override no node in the cohort can take leaves every node on its own default, so a
     * Revert button would offer an operation over no nodes at all. Removing the override is
     * the way out of that state, and the invalid panel offers it.
     */
    const form = describeTypeForm(
      overridden({
        cohort: [
          member(10, { primaryKind: 'multilevel-switch', takesOverride: false }),
          member(11, { primaryKind: 'multilevel-switch', takesOverride: false }),
        ],
      }),
      null,
    );

    expect(form.revert).toBeNull();
  });

  it('does not name one default when the nodes have different ones', () => {
    const form = describeTypeForm(
      overridden({ cohort: [member(10), member(11, { defaultKind: 'binary-switch' })] }),
      null,
    );

    expect(form.revert!.label).toBe('Revert 2 nodes to their default types');
  });

  it('warns about as many accessories as the buttons below it would touch', () => {
    const one = describeTypeForm(plain(), 'window-covering');
    expect(one.warning).toContain('on this accessory');

    const many = describeTypeForm(overridden(), 'multilevel-switch');
    expect(many.warning).toContain('on each affected accessory');
  });

  it('names no number of accessories when neither button can act', () => {
    // There is no change to count, and the cohort is not a count of what would change.
    const resting = describeTypeForm(plain(), null).warning;

    expect(resting).toBe(
      'Changing a device type replaces its corresponding HomeKit service. Scenes and automations that use that service may need to be set up again.',
    );
    expect(resting).not.toContain('accessories');
  });

  it('marks a type the cohort cannot take, wherever it came from', () => {
    /**
     * The current type and this node's own default are listed whether or not the whole cohort
     * can take them, because they are what the device is and what it would go back to. A mixed
     * cohort puts either outside the intersection, and the backend refuses one that is.
     */
    const form = describeTypeForm(overridden({ options: ['multilevel-switch'] }), null);

    expect(form.select.options).toEqual([
      { kind: 'window-covering', label: 'Window Covering (your override)', available: false },
      { kind: 'multilevel-switch', label: 'Multilevel Switch (detected default)', available: true },
    ]);
    expect(form.apply).toMatchObject({ label: 'Apply', disabled: true });
  });

  it('says why a type it is showing cannot be acted on', () => {
    /**
     * Not "no longer": a current type or a node's own default can be one the whole cohort was
     * never able to take, so nothing is claimed about when it stopped being available.
     */
    expect(describeTypeForm(overridden({ options: ['multilevel-switch'] }), null).select.note).toBe(
      'The selected type is not available for every device with this hardware.',
    );
    expect(describeTypeForm(overridden(), 'multilevel-switch').select.note).toBeNull();
    expect(describeTypeForm(overridden({ fingerprint: null }), null).select.note).toBeNull();
  });

  it('holds a choice a refresh has invalidated instead of silently swapping it', () => {
    /**
     * The exact sequence: a type is chosen while the cohort can take it, and the next payload
     * no longer offers it. Dropping it would leave the select showing its first option while
     * Apply acted on the one the reader could no longer see.
     */
    const chosen = 'window-covering';
    const before = describeTypeForm(plain(), chosen);

    expect(before.apply).toMatchObject({ disabled: false });

    const after = describeTypeForm(plain({ options: ['multilevel-switch'] }), chosen);

    expect(after.select.value).toBe(chosen);
    expect(after.select.options.find((option: any) => option.kind === chosen)).toMatchObject({
      available: false,
    });
    expect(after.apply).toMatchObject({ label: 'Apply', disabled: true });
  });

  it('offers nothing to choose where nothing can be chosen', () => {
    const states = [
      overridden({ multiEndpoint: true, primaryKind: null }),
      overridden({ fingerprint: null }),
      overridden({ store: { readable: false, error: { code: 'invalid-json' } } }),
      overridden({ primaryKind: null }),
    ];

    states.forEach((payload) => {
      const form = describeTypeForm(payload, null);

      expect(form.select).toMatchObject({ disabled: true, placeholder: 'Not available' });
      expect(form.select.options).toEqual([]);
      expect(form.apply).toMatchObject({ label: 'Apply', disabled: true });
      expect(form.revert).toBeNull();
      expect(form.cohort).toBeNull();
    });
  });
});

describe('a refused type write', () => {
  it('sends a reader to the node-gone state when the node has left', () => {
    expect(describeWriteRefusal('unknown-node')).toEqual({
      gone: true,
      text: 'This node is no longer in the network. Nothing was changed.',
    });
  });

  it('says what changed under the reader when the hardware or the cohort did', () => {
    expect(describeWriteRefusal('fingerprint-changed')).toMatchObject({
      gone: false,
      text: 'This node now reports different hardware. Nothing was changed.',
    });
    expect(describeWriteRefusal('cohort-changed').text).toBe(
      'The devices that share this hardware changed. Nothing was changed. Review the list and try again.',
    );
  });

  it('sends every other refusal back to what the section now reports', () => {
    /**
     * The code names a condition the page has already redrawn itself around, so repeating it
     * as copy would describe the state the reader is looking at. It goes to the log instead.
     */
    ['read-only', 'not-overridable', 'incomplete-request', 'something-new', undefined].forEach(
      (code) =>
        expect(describeWriteRefusal(code as string)).toEqual({
          gone: false,
          text: 'The device type could not be changed. Nothing was changed. Review the updated device information.',
        }),
    );
  });

  it('cannot take a sentence from an inherited property', () => {
    expect(describeWriteRefusal('toString').text).toContain('could not be changed');
  });
});

describe('confirming a type write', () => {
  const member = (nodeId: number, name: string, over: Record<string, unknown> = {}) => ({
    nodeId,
    name,
    matterActive: false,
    primaryKind: 'multilevel-switch',
    defaultKind: 'multilevel-switch',
    takesOverride: true,
    ...over,
  });

  const payload = (over: Record<string, unknown> = {}) => ({
    nodeId: 10,
    cohort: [member(10, 'Hallway Shade'), member(11, 'Office Shade')],
    ...over,
  });

  it('says it once when every node changes the same way', () => {
    const dialog = describeTypeWrite(payload(), 'window-covering', 'apply');

    expect(dialog.title).toBe('Change the device type for this hardware?');
    expect(dialog.lines).toEqual([
      'Multilevel Switch becomes Window Covering on Node 10 Hallway Shade and Node 11 Office Shade.',
    ]);
    expect(dialog.confirmLabel).toBe('Apply');
  });

  it('takes a line each when they do not', () => {
    const dialog = describeTypeWrite(
      payload({ cohort: [member(10, 'Hallway Shade'), member(11, 'Office Shade', { primaryKind: 'binary-switch' })] }),
      'window-covering',
      'apply',
    );

    expect(dialog.lines).toEqual([
      'Node 10 Hallway Shade: Multilevel Switch becomes Window Covering',
      'Node 11 Office Shade: Binary Switch becomes Window Covering',
    ]);
  });

  it('names no node that would not change', () => {
    // A cohort node already publishing the chosen type is not touched by the write.
    const dialog = describeTypeWrite(
      payload({
        cohort: [member(10, 'Hallway Shade'), member(11, 'Office Shade', { primaryKind: 'window-covering' })],
      }),
      'window-covering',
      'apply',
    );

    expect(dialog.lines[0]).toContain('Node 10 Hallway Shade');
    expect(dialog.lines[0]).not.toContain('Office Shade');
    expect(dialog.nodeCount).toBe(1);
  });

  it('asks a different question for a revert', () => {
    const dialog = describeTypeWrite(
      payload({
        cohort: [
          member(10, 'Hallway Shade', { primaryKind: 'window-covering' }),
          member(11, 'Office Shade', { primaryKind: 'window-covering' }),
        ],
      }),
      null,
      'revert',
    );

    expect(dialog.title).toBe('Revert to the default type?');
    expect(dialog.confirmLabel).toBe('Revert');
    expect(dialog.lines).toEqual([
      'Window Covering becomes Multilevel Switch on Node 10 Hallway Shade and Node 11 Office Shade.',
    ]);
  });

  it('discloses the restart for whichever node the write would rebuild', () => {
    /**
     * A decision reaches every node sharing the fingerprint. Asking only about the node whose
     * page is open leaves a reader changing a device that Matter publishes, and that stays as
     * it was in Alexa until Homebridge restarts, with nothing said about it.
     */
    expect(describeTypeWrite(payload(), 'window-covering', 'apply').matter).toBeNull();

    const elsewhere = payload({
      cohort: [member(10, 'Hallway Shade'), member(11, 'Office Shade', { matterActive: true })],
    });

    expect(describeTypeWrite(elsewhere, 'window-covering', 'apply').matter).toBe(
      'Matter controllers, including Alexa, show the new type after Homebridge restarts.',
    );
  });

  it('says nothing about a restart for a node the write would not touch', () => {
    // A cohort node already publishing the chosen type is not rebuilt, so nothing about it
    // changes in Matter either.
    const settled = payload({
      cohort: [
        member(10, 'Hallway Shade'),
        member(11, 'Office Shade', { matterActive: true, primaryKind: 'window-covering' }),
      ],
    });

    expect(describeTypeWrite(settled, 'window-covering', 'apply').matter).toBeNull();
  });

  it('counts the accessories the write would rebuild', () => {
    const one = describeTypeWrite(
      payload({ cohort: [member(10, 'Hallway Shade')] }),
      'window-covering',
      'apply',
    );

    expect(one.warning).toContain('on this accessory');
    expect(describeTypeWrite(payload(), 'window-covering', 'apply').warning).toContain(
      'on each affected accessory',
    );
  });
});

describe('what a type write did', () => {
  const cohort = [
    { nodeId: 10, name: 'Hallway Shade' },
    { nodeId: 11, name: 'Office Shade' },
  ];

  it('counts what it rebuilt', () => {
    expect(
      describeWriteOutcome({ rebuilt: [10], failed: [] }, 'window-covering', cohort, 'apply'),
    ).toEqual({ type: 'success', lines: ['Device type changed on 1 node.'] });
    expect(
      describeWriteOutcome({ rebuilt: [10, 11], failed: [] }, 'window-covering', cohort, 'apply')
        .lines[0],
    ).toBe('Device type changed on 2 nodes.');
  });

  it('gives each node HomeKit would not take its own line and its own reason', () => {
    /**
     * Two nodes failing for different reasons is two things to know, and the nodes are named
     * the way the dialog that asked about them named them.
     */
    const outcome = describeWriteOutcome(
      {
        rebuilt: [],
        failed: [
          { nodeId: 11, error: 'HAP refused' },
          { nodeId: 10, error: 'timed out' },
        ],
      },
      'window-covering',
      cohort,
      'apply',
    );

    expect(outcome.type).toBe('error');
    expect(outcome.lines).toEqual([
      'Window Covering was saved for this hardware, but HomeKit could not update Node 10 Hallway Shade: timed out. Restart Homebridge to try again.',
      'Window Covering was saved for this hardware, but HomeKit could not update Node 11 Office Shade: HAP refused. Restart Homebridge to try again.',
    ]);
  });

  it('says what a revert did, rather than what an apply would have', () => {
    // Nothing was saved by a revert: the override was removed.
    const outcome = describeWriteOutcome(
      { rebuilt: [], failed: [{ nodeId: 11, error: 'HAP refused' }] },
      'multilevel-switch',
      cohort,
      'revert',
    );

    expect(outcome.lines).toEqual([
      'The override was removed, but HomeKit could not restore the default type on Node 11 Office Shade: HAP refused. Restart Homebridge to try again.',
    ]);
  });

  it('still names a node the cohort no longer knows', () => {
    const outcome = describeWriteOutcome(
      { rebuilt: [], failed: [{ nodeId: 12, error: 'boom' }] },
      'window-covering',
      cohort,
      'apply',
    );

    expect(outcome.lines[0]).toContain('could not update Node 12: boom');
  });
});

describe('an override that no longer fits', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    nodeId: 8,
    fingerprint: { manufacturerId: 881, productType: 4, productId: 2 },
    primaryKind: 'motion-sensor',
    orphans: [],
    invalid: null,
    ...over,
  });

  const invalid = (appliedTo: { nodeId: number; name: string }[]) =>
    describeTypeExceptions(payload({ invalid: { primaryKind: 'window-covering', appliedTo } }))
      .invalid;

  it('names the type this device cannot take, and who still has it', () => {
    const panel = invalid([
      { nodeId: 5, name: "Nico's Shade" },
      { nodeId: 11, name: 'Office Shade' },
    ])!;

    expect(panel.heading).toBe('Your saved override cannot be applied to this device');
    expect(panel.body).toBe(
      'This device reports the same hardware fingerprint, but it cannot take Window Covering, so the saved override does not apply here. The override is still applied to:',
    );
    expect(panel.chips).toEqual([
      { nodeId: 5, name: "Nico's Shade" },
      { nodeId: 11, name: 'Office Shade' },
    ]);
    expect(panel.manage).toMatchObject({ nodeId: 5, text: "Manage it from Node 5 Nico's Shade" });
    expect(panel.remove).toBeNull();
  });

  it('introduces no list when there is nobody to list', () => {
    // The closing sentence of the body introduces the chips, and an override applied to
    // nothing is removed rather than read about somewhere else.
    const panel = invalid([])!;

    expect(panel.body).toBe(
      'This device reports the same hardware fingerprint, but it cannot take Window Covering, so the saved override does not apply here.',
    );
    expect(panel.chips).toEqual([]);
    expect(panel.manage).toBeNull();
    expect(panel.remove).toMatchObject({ label: 'Remove saved override' });
  });

  it('leaves the choice to the node that has the override', () => {
    const elsewhere = { primaryKind: 'window-covering', appliedTo: [{ nodeId: 5, name: 'Shade' }] };
    const nowhere = { primaryKind: 'window-covering', appliedTo: [] };

    expect(
      describeTypeForm(payload({ invalid: elsewhere, options: ['motion-sensor'], cohort: [] }), null)
        .select.disabled,
    ).toBe(true);
    expect(
      describeTypeForm(payload({ invalid: nowhere, options: ['motion-sensor'], cohort: [] }), null)
        .select.disabled,
    ).toBe(false);
  });

  it('shows what the override was saved for beside what the node reports now', () => {
    const [orphan] = describeTypeExceptions(
      payload({
        orphans: [
          {
            observationId: 'obs-1',
            fingerprint: { manufacturerId: 2748, productType: 2, productId: 16 },
            primaryKind: 'window-covering',
            appliedAt: '2026-10-12T18:20:00Z',
            orphanedAt: '2026-10-20T10:00:00Z',
          },
        ],
      }),
    ).orphans;

    expect(orphan.heading).toBe('A saved override no longer matches this node');
    expect(orphan.body).toContain('Z-Wave reuses node numbers after a device is removed');
    expect(orphan.savedFor).toMatchObject({
      title: 'Override saved for',
      hex: ['0x0ABC', '0x0002', '0x0010'],
      type: 'Window Covering',
    });
    expect(orphan.nowReports).toMatchObject({
      title: 'Node 8 now reports',
      hex: ['0x0371', '0x0004', '0x0002'],
      type: 'Motion Sensor',
    });
    expect(orphan.acknowledge).toBe('Acknowledge hardware change');
    expect(orphan.canAcknowledge).toBe(true);
  });

  it('cannot acknowledge against a fingerprint the node is not reporting', () => {
    /**
     * The acknowledgement is answered against what the node reports now, so a re-interview
     * that has left it without a fingerprint leaves nothing to send. The section already says
     * the interview has to finish first.
     */
    const { orphans } = describeTypeExceptions(
      payload({
        fingerprint: null,
        orphans: [{ observationId: 'obs-1', fingerprint: null, primaryKind: null, appliedAt: null }],
      }),
    );

    expect(orphans[0].canAcknowledge).toBe(false);
  });

  it('says that a removal and an acknowledgement happened', () => {
    expect(describeWriteOutcome({}, null, [], 'remove').lines).toEqual([
      'Saved override removed.',
    ]);
    expect(describeWriteOutcome({}, null, [], 'acknowledge').lines).toEqual([
      'Hardware change acknowledged.',
    ]);
    expect(describeWriteOutcome({}, null, [], 'remove').type).toBe('success');
  });

  it('keeps each observation answerable on its own', () => {
    const { orphans } = describeTypeExceptions(
      payload({
        orphans: [
          { observationId: 'obs-1', fingerprint: null, primaryKind: null, appliedAt: null },
          { observationId: 'obs-2', fingerprint: null, primaryKind: null, appliedAt: null },
        ],
      }),
    );

    expect(orphans.map((orphan: any) => orphan.observationId)).toEqual(['obs-1', 'obs-2']);
  });

  it('asks before removing an override, and says it changes nothing', () => {
    expect(describeTypeWrite({ nodeId: 8 }, 'window-covering', 'remove')).toMatchObject({
      title: 'Remove this saved override?',
      lines: [
        'Window Covering is no longer applied to any device, so removing it changes nothing in HomeKit.',
      ],
      confirmLabel: 'Remove',
      warning: null,
      matter: null,
    });
  });
});

describe('the Firmware column', () => {
  it('reports the version, and says so when there is none', () => {
    expect(describeFirmwareCell({ firmwareVersion: '11.2' }, { name: 'idle' })).toEqual({
      version: '11.2',
      progress: null,
    });
    expect(describeFirmwareCell({}, { name: 'idle' }).version).toBe('Unknown');
  });

  it('carries the progress of an update that is running, finished or failed', () => {
    expect(describeFirmwareCell({}, { name: 'updating', percent: 40 }).progress).toMatchObject({
      percent: 40,
      failed: false,
    });
    expect(describeFirmwareCell({}, { name: 'completed', percent: 100 }).progress).toMatchObject({
      percent: 100,
      failed: false,
    });
    expect(describeFirmwareCell({}, { name: 'failed', percent: 70 }).progress).toMatchObject({
      percent: 70,
      failed: true,
    });
  });

  it('says an update is still moving only while it is', () => {
    /**
     * A bar that goes on animating once an update has finished or failed reports it as still
     * running, which is the one thing the bar is there to say.
     */
    expect(firmwareProgressOf({ name: 'updating', percent: 40 })!.active).toBe(true);
    expect(firmwareProgressOf({ name: 'completed', percent: 100 })!.active).toBe(false);
    expect(firmwareProgressOf({ name: 'failed', percent: 70 })!.active).toBe(false);
  });

  it('names the bar with the same sentence the notice beside it carries', () => {
    expect(firmwareProgressOf({ name: 'updating' })!.label).toBe('Updating firmware');
    expect(firmwareProgressOf({ name: 'completed' })!.label).toBe('Firmware update completed');
    expect(firmwareProgressOf({ name: 'failed' })!.label).toBe('Firmware update failed');
  });

  it('describes the node page bar the same way it describes the row one', () => {
    const state = { name: 'failed', percent: 70 };

    expect(describeNodeDetail({ nodeId: 5 }, state).progress).toEqual(firmwareProgressOf(state));
    expect(describeNodeActions({ nodeId: 5 }, state)).toMatchObject(firmwareProgressOf(state)!);
  });

  it('brings a percentage the driver did not give back into range', () => {
    expect(describeFirmwareCell({}, { name: 'updating', percent: 140 }).progress!.percent).toBe(100);
    expect(describeFirmwareCell({}, { name: 'updating', percent: -5 }).progress!.percent).toBe(0);
    expect(describeFirmwareCell({}, { name: 'updating' }).progress!.percent).toBe(0);
  });

  it('says nothing about progress while nothing is happening', () => {
    ['idle', 'checking', 'available', 'starting'].forEach((name) =>
      expect(describeFirmwareCell({}, { name }).progress).toBeNull(),
    );
    expect(describeFirmwareCell({}, null).progress).toBeNull();
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
    for (const id of ['typeWriteModal', 'removeNodeModal', 'renameModal', 'confirmModal']) {
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

  it('heads the last column "Details" and leaves the status cell to the badge', () => {
    // The column is a way into each node now, not a row of things to do to it.
    const html = readPage();

    expect(html).toMatch(/<th[^>]*>Details<\/th>/);
    expect(html).not.toMatch(/<th[^>]*>Actions?<\/th>/);
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

  it('centers a tooltip on its button, except where that would reach past the table', () => {
    const html = readPage();

    expect(html).toMatch(/\.tip::after\s*\{[^}]*left:\s*50%/);
    expect(html).toMatch(/\.tip::after\s*\{[^}]*transform:\s*translateX\(-50%\)/);

    // The way in, and the last of the group beside it, hang theirs from the right edge.
    expect(html).toMatch(
      /\.node-action-cell > \.tip:last-child::after,\s*\.node-action-cell \.btn-group \.tip:last-child::after\s*\{[^}]*right:\s*0/,
    );
  });

  it('keeps a tooltip out of the layout until it is read', () => {
    /**
     * An invisible tooltip that is still laid out counts toward the table's scrollable width,
     * which is the measurement the action column has to pass, so hiding one by opacity alone
     * puts the column over the limit while showing nothing.
     */
    const html = readPage();

    expect(html).toMatch(/\.tip::after\s*\{[^}]*display:\s*none/);
    expect(html).not.toMatch(/\.tip::after\s*\{[^}]*opacity:/);
    expect(html).toMatch(/\.tip:hover::after,\s*\.tip:focus-visible::after\s*\{\s*display:\s*block/);
    expect(html).toMatch(
      /max-width: 575\.98px\)\s*\{\s*\.tip::after,\s*\.tip:hover::after,\s*\.tip:focus-visible::after\s*\{\s*display:\s*none/,
    );
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
     * The indicator carries no text of its own: it is an SVG inside a span, written against the
     * name with no space between them, so the cell reads as the name and nothing else.
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

    for (const written of ['notice.text', 'button.label', 'nodeName', 'cell.version']) {
      expect(script).toContain(`uiHelpers.escapeHtml(${written})`);
    }
  });

  const lastScript = () =>
    [...readPage().matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1] as string;

  /** The body of a top-level `const name = ... };` in the page's inline script. */
  const declaration = (name: string) => {
    const match = new RegExp(`const ${name} = [\\s\\S]*?\\n      \\};`).exec(lastScript());
    expect(match).not.toBeNull();
    return match![0];
  };

  /** The body of a top-level arrow function, which a template literal ends with a backtick. */
  const templateBody = (name: string) => {
    const script = lastScript();
    const at = script.indexOf(`const ${name} = `);
    expect(at).toBeGreaterThan(-1);
    const rest = script.slice(at);
    const end = rest.slice(1).search(/\n {6}(const|let|\/\*\*|function)\b/);

    return end === -1 ? rest : rest.slice(0, end + 1);
  };

  it('puts Parameters between Device type and Diagnostics, on the same tab semantics', () => {
    const html = readPage();
    const strip = html.slice(html.indexOf('id="nodeSections"'), html.indexOf('</ul>', html.indexOf('id="nodeSections"')));

    expect([...strip.matchAll(/id="(nodeSection\w+Tab)"/g)].map(([, id]) => id)).toEqual([
      'nodeSectionTypeTab',
      'nodeSectionParametersTab',
      'nodeSectionDiagnosticsTab',
    ]);
    expect(strip).toMatch(/id="nodeSectionParametersTab"[\s\S]*?aria-controls="nodeSectionParameters"/);
    expect(strip).toMatch(/id="nodeSectionParametersTab"[\s\S]*?aria-selected="false"/);
    expect(strip).toMatch(/id="nodeSectionParametersTab"[\s\S]*?tabindex="-1"/);
    expect(html).toMatch(
      /id="nodeSectionParameters" role="tabpanel"\s*\n\s*aria-labelledby="nodeSectionParametersTab"/,
    );
    expect(declaration('NODE_SECTIONS')).toMatch(
      /'type'[\s\S]*'parameters'[\s\S]*'diagnostics'/,
    );
  });

  it('keeps the search field out of everything a refresh redraws', () => {
    /**
     * The payload is read again every five seconds while a re-read is running. A search field
     * inside what that redraws would lose the text typed into it, and the caret with it, in
     * front of a reader who had touched nothing.
     */
    const html = readPage();
    const render = declaration('renderParametersSection');

    expect(html).toMatch(/id="parameterSearch"/);
    expect(render).not.toContain("getElementById('parameterSearch')");
    expect([...render.matchAll(/(\w+)\.innerHTML =/g)].map(([, host]) => host)).toEqual(
      new Array(5).fill('list'),
    );
  });

  it('reads the parameters payload when the page opens, so the tab can carry its count', () => {
    // The read is of what the plugin already holds; it sends nothing to the device.
    const open = declaration('openNodeDetail');

    expect(open).toContain('loadParametersSection();');
    expect(open).toContain('renderParametersTab();');
  });

  it('starts another node with no filter and nothing revealed', () => {
    const open = declaration('openNodeDetail');

    expect(open).toContain("parametersSearch = '';");
    expect(open).toContain('parametersShowAdvanced = false;');
    expect(open).toContain("document.getElementById('parameterSearch').value = '';");
  });

  it('holds what it read for the device that holds the number, not for the number', () => {
    /**
     * Z-Wave gives a node number away again. A payload read for the device that had the number
     * before describes that device, and the page would otherwise go on drawing it under the
     * name of the one that has it now, with nothing to make it read the section again.
     */
    const forNode = declaration('parametersFor');

    expect(forNode).toContain('const identity = nodeIdentityOf(nodeId);');
    expect(forNode).toMatch(/held && \(identity === undefined \|\| held\.identity === identity\)/);
    expect(forNode).toContain('const fresh = { identity };');
  });

  it('takes that name from what the plugin listed', () => {
    const identityOf = declaration('nodeIdentityOf');

    expect(identityOf).toContain('lastNodes.find(');
    expect(identityOf).toContain('node.identity');
  });

  it('reads what it holds for a node only through that check', () => {
    // A read that went straight to the map would be a read that never asked whose payload it is.
    const page = readPage();

    expect([...page.matchAll(/parametersState\.(get|has)\(/g)]).toHaveLength(1);
    expect(declaration('parametersFor')).toContain('parametersState.get(key)');
  });

  it('drops an answer that is not about the device it asked about', () => {
    /**
     * The list is read every five seconds and a payload on demand, so the plugin can answer for
     * the device that holds the number now while the page still holds the one that had it when
     * it asked. Storing that answer would draw one device's settings under another's name.
     */
    const fits = declaration('parametersAnswerFits');
    const load = declaration('loadParametersSection');
    const ask = declaration('requestParametersRefresh');

    expect(fits).toContain('parametersFor(nodeId) !== asked');
    expect(fits).toContain('payload.identity === asked.identity');
    expect(load).toContain('if (!parametersAnswerFits(nodeId, state, payload)) return;');
    expect(ask).toContain('if (!parametersAnswerFits(nodeId, state, payload)) return;');
  });

  it('names the device it is asking when it asks for a re-read', () => {
    // A re-read puts commands on the network, so the plugin is told which device was meant.
    expect(declaration('requestParametersRefresh')).toMatch(
      /request\('refresh-node-parameters', \{\s*\n\s*nodeId,\s*\n\s*identity: state\.identity,/,
    );
  });

  it('re-reads while an attempt is running, and where the section has nothing to draw', () => {
    /**
     * Settling ends the reason to keep looking without answering the question: it says the
     * attempt finished, never that a value was confirmed.
     */
    const load = declaration('loadNodes');

    expect(load).toMatch(/nodeSection === 'parameters'/);
    expect(load).toMatch(/unread \|\| uiHelpers\.parametersRefreshRunning\(state\.payload\)/);
    expect(load).toContain('loadParametersSection();');
  });

  it('colors the two marks a reader has to act on, in each theme the host gives it', () => {
    /**
     * config-ui-x replays its own stylesheet and puts `dark-mode` on the body, so the card is
     * #fff under the light themes and #2b2b2b under the dark ones, and one set of colors
     * cannot serve both.
     */
    const html = readPage();

    expect(html).toMatch(/\.parameter-mark-caution \{ color: #8a4b00 !important; \}/);
    expect(html).toMatch(/\.parameter-mark-danger \{ color: #a71d2a !important; \}/);
    expect(html).toMatch(
      /body\.dark-mode #maintenance \.parameter-mark-caution \{ color: #e8a33d !important; \}/,
    );
    expect(html).toMatch(
      /body\.dark-mode #maintenance \.parameter-mark-danger \{ color: #ea868f !important; \}/,
    );
    /**
     * This page forces white text on every badge so the filled ones read, and a chip drawn in
     * its own color has to say so louder. Without this the marks render white on the light
     * card, which no reading of the stylesheet's text would catch.
     */
    expect(html).toMatch(/\.badge \{[^}]*color: #fff !important;/);
    expect(templateBody('parameterMarksHtml')).toContain(
      'parameter-mark-${uiHelpers.escapeHtml(',
    );
  });

  it('renders every string the device supplied as text', () => {
    /**
     * Labels, descriptions, units and state names come from the device and from zwave-js's
     * device files. A bare interpolation of one would put whatever it contains into the page as
     * markup, so each is passed through the page's own escaping.
     */
    const raw = /\$\{\s*(?!uiHelpers\.escapeHtml)[A-Za-z_$][\w$.]*\s*\}/;

    ['parameterFieldHtml', 'parameterGroupHtml', 'parameterMarksHtml'].forEach((name) => {
      const body = templateBody(name);
      expect(body).toContain('uiHelpers.escapeHtml(');
      expect(`${name}: ${raw.exec(body)?.[0] ?? 'escaped'}`).toBe(`${name}: escaped`);
    });
  });

  it('binds the section controls once, at page load', () => {
    /**
     * Opening a node does not bind them, so opening one twice cannot leave two listeners
     * answering one press, and the panel outlives every redraw of what is inside it.
     */
    const script = lastScript();
    const first = script.indexOf("getElementById('nodeSectionParameters').addEventListener");
    const second = script.indexOf(
      "getElementById('nodeSectionParameters').addEventListener",
      first + 1,
    );

    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    [first, second].forEach((at) =>
      expect(depthAt(script, at)).toBe(
        depthAt(script, script.indexOf("getElementById('nodeSectionDiagnostics').addEventListener")),
      ),
    );
  });

  it('takes the section away with the node it belongs to', () => {
    const sections = declaration('showNodeSections');

    expect(sections).toContain('parametersDrawn = null;');
    expect(sections).toContain('clearParametersAnnounce();');
  });

  it('writes the section live region once, outside what it redraws', () => {
    /**
     * A region recreated by a redraw announces whatever is in it again, so a sentence that had
     * not changed would be read out every five seconds.
     */
    const html = readPage();

    expect(html.match(/id="parametersAnnounce"/g)).toHaveLength(1);
    const between = html.slice(
      html.indexOf('id="nodeSectionParameters"'),
      html.indexOf('id="parametersAnnounce"'),
    );
    expect(between).toContain('id="nodeSectionDiagnostics"');
    expect(html).toMatch(/id="parametersAnnounce"[^>]*role="status"[^>]*aria-live="polite"/);
  });

  it('draws both surfaces from one repaint', () => {
    /**
     * Check Update and the firmware flow change what the page knows and then redraw. Redrawing
     * the table alone left an open node page showing the state the node was in before the click
     * until the next refresh, and showing nothing at all while a dialog held that refresh off.
     */
    const repaint = declaration('rerenderNodes');

    expect(repaint).toContain('renderNodes(lastNodes)');
    expect(repaint).toContain('renderNodeDetail()');
  });

  it('redraws a node page only when its description has changed', () => {
    /**
     * The five-second refresh has to keep the view current without resetting what the reader is
     * part way through. Comparing the description against the one already drawn means an
     * unchanged node touches no DOM at all, so focus stays where it was put.
     */
    const script = lastScript();

    expect(script).toContain('const signature = JSON.stringify(detail);');
    expect(script).toContain('if (signature === detailDrawn) return;');
    expect(declaration('openNodeDetail')).toContain('detailDrawn = null;');
    expect(declaration('closeNodeDetail')).toContain('detailDrawn = null;');
  });

  it('returns the list to where the reader left it', () => {
    expect(declaration('openNodeDetail')).toContain('listScroll = scrollOffset();');
    expect(declaration('closeNodeDetail')).toContain('window.scrollTo(0, listScroll);');
  });

  it('remembers that position only on the way in from the list', () => {
    /**
     * A node opened from another node's page would otherwise record the page's own offset,
     * which is zero, and back would land at the top of a list the reader had scrolled.
     */
    expect(declaration('openNodeDetail')).toContain(
      'if (detailNodeId === null) listScroll = scrollOffset();',
    );
  });

  it('carries the keyboard across the navigation', () => {
    /**
     * The control that was clicked goes away with the surface it sits on, so without this the
     * keyboard is left on the document body at the top of the page, both on the way in and on
     * the way back.
     */
    expect(declaration('openNodeDetail')).toContain(
      "document.getElementById('backToNodes').focus({ preventScroll: true });",
    );

    const close = declaration('closeNodeDetail');
    expect(close).toContain("button.getAttribute('data-nodeid') === String(leaving)");
    expect(close).toContain("(wayIn || document.getElementById('nodeListTitle')).focus(");
  });

  it('lands the keyboard on something that says where it is', () => {
    /**
     * Each of the three places focus is sent carries a name of its own: the back link and the
     * list heading their own text, and the way-in button the label the row already gives it.
     * None of them is a container, and none is redrawn, so a refresh cannot take focus off one.
     */
    const html = readPage();

    /**
     * The chevron is decoration. Left in the name, it reads as "left single quotation mark, All
     * nodes", and it is the one of the three names the page writes rather than reuses.
     */
    expect(html).toContain(
      '<a href="#" class="node-detail-back" id="backToNodes"><span aria-hidden="true">&lsaquo;</span> All nodes</a>',
    );
    expect(html).toContain('<h5 id="nodeListTitle" tabindex="-1">Z-Wave Node Maintenance</h5>');
    expect(html).toMatch(/id="nodeDetail"(?![^>]*tabindex)/);
    expect(html).toMatch(/id="nodeList"(?![^>]*tabindex)/);

    // The way-in button's name is the one the row renders for it.
    expect(describeNodeActions(node({ nodeId: 5 }), { name: 'idle' }).open).toMatchObject({
      action: 'open-node',
      label: 'Open node 5',
    });
  });

  it('says on the node page that a refresh did not answer', () => {
    /**
     * The list can give its rows over to the message. The node page is showing one node, so it
     * keeps what it has and says above it that this is no longer current, rather than going on
     * presenting stale readings as if they had just arrived.
     */
    const load = declaration('loadNodes');

    expect(load).toContain("showNodeError('Plugin not responding. Is it running?')");
    expect(load).toContain('showNodeError(err.message)');
    expect(load).toContain("showNodeError('')");
  });

  it('keeps one table of status names between the list and the node page', () => {
    const html = readPage();

    expect(html).toContain('uiHelpers.describeNodeStatus(node)');
    ['Asleep', 'Awake', 'Dead', 'Alive'].forEach((status) =>
      expect(html).not.toContain(`'${status}'`),
    );
  });

  it('answers an action and a review link wherever either is drawn', () => {
    const script = lastScript();

    ['nodeTableBody', 'nodeDetail'].forEach((id) => {
      expect(script).toContain(`getElementById('${id}').addEventListener('click', handleNodeAction)`);
      expect(script).toContain(`getElementById('${id}').addEventListener('click', handleReviewLink)`);
    });
  });

  it('takes the name for a rename from what the plugin reported', () => {
    /**
     * Both surfaces draw the name, and only one is on screen, so reading it back out of the
     * document found whichever cell came first rather than the one that was clicked.
     */
    const script = lastScript();

    expect(script).toContain('const named = lastNodes.find');
    expect(script).not.toContain('node-name-${nodeId}');
  });

  it('gives the section strip the semantics of a strip of tabs', () => {
    const html = readPage();

    expect(html).toMatch(/id="nodeSections"[^>]*role="tablist"/);
    ['nodeSectionType', 'nodeSectionDiagnostics'].forEach((panel) => {
      expect(html).toMatch(new RegExp(`id="${panel}Tab"[\\s\\S]{0,120}aria-controls="${panel}"`));
      expect(html).toMatch(new RegExp(`id="${panel}"[\\s\\S]{0,120}aria-labelledby="${panel}Tab"`));
    });

    // One stop for the strip, which moves with the selection, rather than one stop per tab.
    const select = declaration('selectNodeSection');
    expect(select).toContain("tab.setAttribute('aria-selected', chosen ? 'true' : 'false');");
    expect(select).toContain('tab.tabIndex = chosen ? 0 : -1;');
  });

  it('opens a node on Device type, whichever section was last read', () => {
    expect(declaration('openNodeDetail')).toContain("selectNodeSection('type');");
  });

  it('reads the diagnostics again each time the reader comes to the section', () => {
    /**
     * A rebuild, an interview or a repair changes what the report would say, and a request
     * that failed once has to be allowed to succeed, so a report read earlier is not the
     * answer for ever. Only a request already running is not repeated, and nothing polls.
     */
    const load = declaration('loadDiagnosticsSection');

    expect(load).toContain('if (state.loading) return;');
    expect(load).not.toContain('if (state.report || state.error || state.loading) {');
    expect(load).toContain('state.error = null;');
    expect(declaration('selectNodeSection')).toContain('loadDiagnosticsSection();');
  });

  it('takes the sections away with a node that has left', () => {
    /**
     * Z-Wave gives a node number away again, so controls that move a motor must not sit in the
     * page waiting for whatever device takes this number next. Requirement 7 asks for the
     * sentence, the back link and no controls, which is what emptying them leaves.
     */
    const away = declaration('showNodeSections');

    // What it held goes; what it is made of stays, so it can be drawn into again.
    expect(away).toContain('panel.innerHTML = SECTION_SKELETON.get(section.panel)');
    expect(away).toContain("strip.style.display = present ? '' : 'none';");
    expect(declaration('markNodeGone')).toContain('showNodeSections(false);');
  });

  it('treats a node that has gone as gone until the reader opens one again', () => {
    /**
     * Z-Wave gives a node number away again, so a later list carrying it is not necessarily
     * this device coming back. Redrawing the page around whatever now answers would put a
     * reader who was last told the node had gone in front of different hardware.
     */
    expect(declaration('renderNodeDetail')).toContain('if (!host || detailGone) return;');
    expect(declaration('markNodeGone')).toContain('detailGone = true;');
    expect(declaration('openNodeDetail')).toContain('detailGone = false;');
    expect(declaration('renderDiagnosticsSection')).toContain('if (detailGone) return;');
  });

  it('carries the keyboard off the controls it is about to remove', () => {
    /**
     * Read before anything is rewritten: once the controls are gone the keyboard is already on
     * the document body and there is nothing left to ask. The sentence is announced as well,
     * so a reader who was in the controls is told why they have been taken away.
     */
    const gone = declaration('markNodeGone');

    expect(gone).toContain('const hadFocus = detail.contains(document.activeElement);');
    expect(gone).toContain("document.getElementById('backToNodes').focus({ preventScroll: true });");
    expect(gone).toContain('role="status"');
    expect(gone.indexOf('const hadFocus')).toBeLessThan(gone.indexOf('host.innerHTML ='));
  });

  it('settles every section it opens, including one with nothing in it yet', () => {
    // The section shown first is reachable from the strip whether or not it has content.
    expect(declaration('selectNodeSection')).toContain('settlePanelFocus(panel);');
  });

  it('counts only a control someone could actually reach', () => {
    /**
     * A panel takes the keyboard when nothing in it can. Counting disabled controls would make
     * a dead end of every covering with an operation running, and of every Device type state
     * that cannot be edited, which is exactly where the panel has to be reachable. A control
     * that is not displayed cannot be reached either: the Parameters section puts its search
     * and its buttons away in the states that list nothing.
     */
    const script = lastScript();

    expect(script).toContain('button:not([disabled])');
    expect(script).toContain('select:not([disabled])');
    expect(declaration('settlePanelFocus')).toContain(
      'panel.tabIndex = [...panel.querySelectorAll(PANEL_FOCUSABLE)].some(isDisplayed) ? -1 : 0;',
    );
    expect(declaration('isDisplayed')).toContain('element.offsetParent !== null');
  });

  it('says how Stop is meant to be tested', () => {
    // It answers movement started elsewhere; it does not cancel a test this page started.
    expect(readPage()).toContain(
      'To test Stop, start the covering from another controller or its remote, then select Stop while it is moving.',
    );
  });

  it('keeps the covering generation per node, away from the dialog counter', () => {
    /**
     * `hideModals` bumps the shared counter, so sharing it would drop the result of a move
     * started on the node page the moment the reader opened and cancelled Rename, leaving the
     * controls disabled with nothing coming to enable them.
     */
    const script = lastScript();

    expect(script).toContain('const generation = (state.coveringRun || 0) + 1;');
    expect(script).toContain('if (generation !== state.coveringRun) return;');
  });

  it('leaves nothing of the dialog the Diagnostics section replaced', () => {
    /**
     * The dialog and the row icon that opened it went together, once the section was doing the
     * work. What drove the covering from inside the dialog went with them.
     */
    const html = readPage();

    ['diagnosticsModal', 'diagnosticsBody', 'closeDiagnostics', 'positionTestRow'].forEach((id) =>
      expect(html).not.toContain(id),
    );
    expect(html).not.toContain('runCoveringControl');
  });

  it('offers nothing in the row but the way into the node', () => {
    /**
     * Every control that acts on a node is on the node's own page, so none is offered twice
     * and the list reads as an overview. A node mid-update shows how far it has got beside
     * its firmware version, where a reader scanning for it is already looking.
     */
    const cell = declaration('actionCellHtml');

    expect(cell).toContain('actionButtonHtml(nodeId, actions.open)');
    expect(cell).not.toContain('actions.buttons');
    expect(cell).not.toContain("actions.kind === 'progress'");
    expect(lastScript()).toContain('uiHelpers.describeFirmwareCell(node, firmwareState)');
  });

  it('reads the device type when the reader comes to the section', () => {
    const load = declaration('loadTypeSection');

    expect(load).toContain('if (state.loading) return;');
    expect(load).toContain("window.homebridge.request('get-node-type', nodeId)");
    expect(declaration('selectNodeSection')).toContain('loadTypeSection();');
  });

  it('settles the Device type panel after drawing it', () => {
    // Its read-only states hold nothing focusable, which is where the panel has to take focus.
    expect(declaration('renderTypeSection')).toContain('settlePanelFocus(host);');
  });

  it('draws the Device type rows from the helper rather than deciding for itself', () => {
    const script = lastScript();

    expect(script).toContain('uiHelpers.describeTypePanel(state.payload)');
    expect(script).toContain('uiHelpers.describeTypeExceptions(state.payload)');
    // Written across lines by the formatter, so matched on the pieces rather than the line.
    expect(script).toMatch(/panel\.panels\s*\.?\s*\n?\s*\.map\(typeCalloutHtml\)/);
    expect(script).toMatch(/panel\.notices\s*\n?\s*\.map\(typeCalloutHtml\)/);
    expect(script).toMatch(/panel\.rows\.map\(typeRowHtml\)/);
  });

  it('escapes every value the plugin supplies for those rows', () => {
    const script = lastScript();

    ['row.label', 'row.value', 'row.chip', 'under', 'callout.heading', 'callout.body'].forEach(
      (written) => expect(script).toContain(`uiHelpers.escapeHtml(${written})`),
    );
  });

  it('discards a reading a write has already answered for', () => {
    /**
     * The five-second refresh means a read is often in flight when a write lands. One started
     * before the write describes the node as it was, so applying it when it arrives puts back
     * what the reader has just changed.
     */
    const load = declaration('loadTypeSection');
    const write = declaration('runTypeWrite');

    expect(load).toContain('const generation = typeGenerationOf(nodeId);');
    expect(load).toContain('if (generation === typeGenerationOf(nodeId)) {');
    expect(write).toContain('supersedeTypeReads(nodeId);');

    // Read before the request, not after it, or every read would look current.
    expect(load.indexOf('const generation = typeGenerationOf(nodeId);')).toBeLessThan(
      load.indexOf("await window.homebridge.request('get-node-type', nodeId)"),
    );

    // A failure that a write has answered for is dropped the same way a payload is.
    expect(load).toContain('state.error = err.message;');
    expect(load.split('if (generation === typeGenerationOf(nodeId)) {').length - 1).toBe(2);
  });

  it('keeps the device type current while the section is open', () => {
    /**
     * The payload describes what the plugin holds now, not a measurement taken once, so a node
     * that finished interviewing, a rebuild that recovered, or a write made in another window
     * would otherwise sit unreported for as long as the section stayed open.
     */
    const load = declaration('loadNodes');

    expect(load).toContain(
      "if (detailNodeId !== null && !detailGone && nodeSection === 'type') {",
    );
    expect(load).toContain('loadTypeSection();');

    // The radio report is a reading, not a view of current state, so it is not asked for here.
    expect(load).not.toContain('loadDiagnosticsSection();');
  });

  it('reserves the interrupting role for a warning', () => {
    /**
     * Waiting for an interview and having several endpoints are ordinary facts about a device.
     * Read over whatever the reader is doing, they would be an interruption saying nothing has
     * gone wrong.
     */
    const script = lastScript();

    expect(script).toContain("callout.severity === 'warning' ? 'alert' : 'status'");
  });

  it('keeps the live region out of the panel it redraws', () => {
    /**
     * A region recreated on every render announces a sentence that has not changed. This one
     * is written once in the markup and its text is set only when the sentence differs from
     * the one it is already carrying, so a choice invalidated by a refresh is announced and a
     * choice that was unavailable when the page was drawn is not.
     */
    const html = readPage();

    expect(html).toMatch(/id="typeAnnounce"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(html).not.toMatch(/nodeSectionType[^>]*>\s*<div id="typeAnnounce"/);

    const render = declaration('renderTypeSection');
    expect(render).toContain('if (note !== typeNoteSaid) {');
    expect(render).toContain("document.getElementById('typeAnnounce').textContent = note;");
  });

  it('reads the sentence to anyone who focuses the select', () => {
    expect(readPage()).toContain('aria-describedby="typeSelectNote"');
  });

  it('cannot offer a type the cohort will not take', () => {
    // The option stays visible so the choice is still the one on screen, but not selectable.
    expect(readPage()).toContain("${option.available ? '' : ' disabled'}");
  });

  it('writes against the state the dialog was composed from', () => {
    /**
     * The plugin recomputes everything from its own state and refuses the write if either the
     * fingerprint or the cohort has moved, so a page that has gone stale cannot act on what it
     * is still showing.
     */
    const write = declaration('runTypeWrite');

    const body = declaration('typeWriteBody');

    expect(body).toContain('expectedFingerprint: payload.fingerprint');
    expect(body).toContain('expectedRevision: payload.cohortRevision');
    expect(write).toContain('TYPE_WRITE_ROUTES[action]');
    expect(lastScript()).toContain("apply: 'set-node-type'");
    expect(lastScript()).toContain("revert: 'clear-node-type'");
  });

  it('holds both buttons and the list while a write is running', () => {
    const script = lastScript();

    expect(script).toContain('typeWriteRunning = true;');
    expect(script).toContain("form.apply.disabled || typeWriteRunning ? ' disabled' : ''");
    expect(script).toContain("form.revert.disabled || typeWriteRunning ? ' disabled' : ''");
    expect(script).toContain("form.select.disabled || typeWriteRunning ? ' disabled' : ''");
  });

  it('takes a reader to the node-gone state when the write says the node has left', () => {
    const write = declaration('runTypeWrite');

    expect(write).toContain('uiHelpers.describeWriteRefusal(outcome.refusal)');
    expect(write).toContain('if (refusal.gone && String(detailNodeId) === String(nodeId)) {');
    expect(write).toContain('markNodeGone();');
  });

  it('forgets a choice once it has been written, and on the way into a node', () => {
    expect(declaration('runTypeWrite')).toContain('typeDrafts.delete(String(nodeId));');
    expect(declaration('openNodeDetail')).toContain('typeDrafts.delete(String(nodeId));');
  });

  it('ties a choice to the hardware it was made against', () => {
    /**
     * Z-Wave reuses node numbers, and a fingerprint can change under a node being
     * re-interviewed, so a choice held by node number alone could be applied to a different
     * device that happens to accept it.
     */
    const held = declaration('draftFor');

    expect(held).toContain(
      "if (held.fingerprint !== uiHelpers.fingerprintKey(payload && payload.fingerprint)) {",
    );
    expect(held).toContain('typeDrafts.delete(String(nodeId));');
    expect(lastScript()).toContain('fingerprint: uiHelpers.fingerprintKey(');
  });

  it('forgets the choice after a refusal as well as after a write', () => {
    // A refused write was composed against something that has since moved.
    const write = declaration('runTypeWrite');
    const refusalAt = write.indexOf('outcome.refusal');

    expect(write.indexOf('typeDrafts.delete(String(nodeId));')).toBeLessThan(refusalAt);
  });

  it('puts the keyboard back on the control that replaced the one it was on', () => {
    const render = declaration('renderTypeSection');

    expect(render).toContain('const mark = focusKeyIn(formHost);');
    expect(render).toContain('if (mark) {');
    expect(render).toContain('restoreSectionFocus(formHost, mark);');
    expect(declaration('focusKeyIn')).toContain("return active.getAttribute('data-focus-key');");

    // Read before the control is replaced, put back after: the other order has nothing to ask.
    const redraw = render.slice(render.indexOf('formHost.innerHTML = typeFormHtml('));

    expect(render.indexOf('const mark = focusKeyIn(formHost);')).toBeLessThan(
      render.indexOf('formHost.innerHTML = typeFormHtml('),
    );
    expect(redraw).toContain('restoreSectionFocus(formHost, mark);');
  });

  it('draws what the plugin reports apart from what is being decided', () => {
    /**
     * One host for both meant that changing the selection rewrote the plugin's own callouts,
     * recreating their live regions and announcing again what had not changed.
     */
    const html = readPage();

    expect(html).toContain('<div id="typePanelRows"></div>');
    expect(html).toContain('<div id="typeFormHost"></div>');

    const render = declaration('renderTypeSection');
    expect(render).toContain('if (panelSignature !== typePanelDrawn) {');
    expect(render).toContain('if (formSignature !== typeFormDrawn) {');
  });

  it("keeps the form callouts out of the live regions", () => {
    // The cohort callout and the rebuild warning explain the form; they do not report events.
    const form = declaration('typeFormHtml');

    expect(form).not.toContain('role="status"');
    expect(form).not.toContain('role="alert"');
  });

  it('remembers the first sentence without saying it', () => {
    /**
     * A selection that was already unavailable when the page opened is read from the select's
     * own description. Only one that becomes unavailable under the reader is announced.
     */
    const render = declaration('renderTypeSection');

    expect(render).toContain('if (typeNoteSaid === null) {');
    expect(render).toContain('} else if (note !== typeNoteSaid) {');
    expect(declaration('clearTypeAnnounce')).toContain('typeNoteSaid = null;');
  });

  it('leaves an emptied section able to be drawn into again', () => {
    /**
     * The Device type section is two hosts, one for what the plugin reports and one for the
     * decision. Emptying the section itself took them with it, and the next node opened found
     * nothing to draw into.
     */
    const away = declaration('showNodeSections');

    expect(away).toContain("panel.innerHTML = SECTION_SKELETON.get(section.panel) || '';");
    expect(away).not.toContain("panel.innerHTML = '';");

    // Read from the markup rather than written out again, so the two cannot drift apart.
    expect(lastScript()).toContain('const SECTION_SKELETON = new Map(');
  });

  it('does not drop the keyboard, or keep talking, when the form goes', () => {
    /**
     * A reading that fails removes the control the keyboard is on just as surely as a redraw
     * replaces it, and the sentence under the select goes with the select. Reading the mark
     * only in the branch that redraws left the reader on the document body with the region
     * still carrying a sentence about a form that was no longer there.
     */
    const render = declaration('renderTypeSection');
    const mark = render.indexOf('const mark = focusKeyIn(formHost);');
    const branch = render.indexOf('if (!state.payload || state.error) {');

    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(branch);

    const errorBranch = render.slice(branch, render.indexOf('} else {', branch));
    expect(errorBranch).toContain("formHost.innerHTML = '';");
    expect(errorBranch).toContain('clearTypeAnnounce();');
    expect(errorBranch).toContain('restoreSectionFocus(formHost, mark);');
  });

  it('takes the form away with a reading that failed', () => {
    /**
     * The report half says the refresh failed while the form went on offering buttons built
     * from the payload before it, which a reader could still press.
     */
    const render = declaration('renderTypeSection');
    const formSignature = render.slice(render.indexOf('const formSignature'));

    expect(formSignature.slice(0, 120)).toContain("state.error || ''");
    expect(render).toContain("formHost.innerHTML = '';");
  });

  it('has somewhere to put the keyboard when the control will not take it', () => {
    /**
     * A refresh can disable the button focus was on, and a disabled control does not take it,
     * so without somewhere else to go the reader is dropped to the document body.
     */
    const restore = declaration('restoreSectionFocus');

    expect(restore).toContain('byFocusKey(host, key)');
    expect(restore).toContain("formHost.querySelector('#typeSelect')");
    expect(restore).toContain("document.getElementById('nodeSectionType')");
    expect(restore).toContain("document.getElementById('backToNodes')");
    expect(declaration('canTakeFocus')).toContain('!element.disabled');
  });

  it('says nothing about the node a reader has left', () => {
    const script = lastScript();

    expect(declaration('openNodeDetail')).toContain('clearTypeAnnounce();');
    expect(declaration('closeNodeDetail')).toContain('clearTypeAnnounce();');
    expect(declaration('showNodeSections')).toContain('clearTypeAnnounce();');
    expect(script).toContain("if (region) region.textContent = '';");
  });

  it('reads and restores the keyboard in the half that reports the node too', () => {
    /**
     * That half carries Manage, Remove and Acknowledge now, and the five-second refresh
     * redraws it, so a reader using one of them would be dropped out of it.
     */
    const render = declaration('renderTypeSection');

    expect(render).toContain('const panelKey = focusKeyIn(rows);');
    expect(render).toContain('restoreSectionFocus(rows, panelKey);');
    expect(render.indexOf('const panelKey = focusKeyIn(rows);')).toBeLessThan(
      render.indexOf('rows.innerHTML'),
    );
  });

  it('gives every control in the section a key it can be found by again', () => {
    const script = lastScript();

    ['select', 'apply', 'revert', 'manage', 'remove-override'].forEach((key) =>
      expect(script).toContain(`data-focus-key="${key}"`),
    );
    // One per observation, since a node can carry more than one.
    expect(script).toContain('data-focus-key="ack:${uiHelpers.escapeHtml(');
  });

  it('acknowledges a hardware change without asking first', () => {
    /**
     * Acknowledging says nothing is wrong and changes nothing in HomeKit, so there is nothing
     * to confirm. It carries the observation it answers, and the fingerprint it was read for.
     */
    const script = lastScript();

    expect(script).toContain("if (button.classList.contains('type-acknowledge')) {");
    expect(script).toContain("observationId: button.getAttribute('data-observation')");
    expect(declaration('typeWriteBody')).toContain(
      'return { nodeId, observationId, expectedFingerprint: payload.fingerprint };',
    );
    expect(lastScript()).toContain("acknowledge: 'acknowledge-type-orphan'");
  });

  it('asks before removing an override, and sends the revision it read', () => {
    const script = lastScript();

    expect(script).toContain("? 'remove'");
    expect(declaration('typeWriteBody')).toContain(
      'return { nodeId, expectedRevision: payload.cohortRevision };',
    );
    expect(lastScript()).toContain("remove: 'remove-type-override'");
  });

  it('answers every write it was asked for', () => {
    /**
     * A panel going away is useful, but it is not something a screen reader reports, and with
     * several panels left standing it is not obvious which one went.
     */
    const write = declaration('runTypeWrite');

    expect(write).toContain('uiHelpers.describeWriteOutcome(');
    expect(write).not.toContain("} else if (action === 'apply' || action === 'revert') {");
  });

  it('allows one write at a time', () => {
    /**
     * A second would be composed against state the first has moved, and two answers arriving
     * out of order would redraw the section from the older one.
     */
    expect(declaration('runTypeWrite')).toContain('if (!write || typeWriteRunning) return;');
  });

  it('holds the panel buttons while a write runs, like the form ones', () => {
    const script = lastScript();
    const render = declaration('renderTypeSection');

    const panelSignature = render.slice(
      render.indexOf('const panelSignature'),
      render.indexOf('if (panelSignature !== typePanelDrawn)'),
    );

    expect(panelSignature).toContain('${typeWriteRunning}');
    expect(script).toContain("data-focus-key=\"remove-override\"${typeWriteRunning ? ' disabled' : ''}");
    expect(script).toContain("typeWriteRunning || !orphan.canAcknowledge ? ' disabled' : ''");
  });

  it('draws no warning in a dialog that has none', () => {
    expect(declaration('openTypeWriteDialog')).toContain('dialog.warning');
    expect(declaration('openTypeWriteDialog')).toContain("? `<p class=\"mb-1 mt-2\">");
  });

  it('draws one bar, and draws its movement from whether anything is moving', () => {
    const bar = declaration('progressBarHtml');

    expect(bar).toContain("progress.active ? ' progress-bar-animated' : ''");
    expect(bar).toContain("progress.failed ? ' bg-danger' : ''");
    expect(bar).toContain('aria-valuemin="0"');
    expect(bar).toContain('aria-valuemax="100"');
    expect(bar).toContain('aria-valuenow="${\n            progress.percent\n          }"');
    expect(bar).toContain('aria-label="${uiHelpers.escapeHtml(');

    // Both places that show one use it, so neither can drift from the other.
    const script = lastScript();
    expect(script).toContain('progressBarHtml(cell.progress, 14)');
    expect(script).toContain('progressBarHtml(detail.progress, 20)');
    expect(script.match(/progress-bar-animated/g)).toHaveLength(1);
  });

  it('keeps no icon for a control the page no longer has', () => {
    /**
     * The route is still how the Diagnostics section reads a report. What went with the dialog
     * is the button that used to open it, and the icon drawn on that button.
     */
    expect(NODE_ICONS.diagnostics).toBeUndefined();
    expect(lastScript()).not.toContain("classList.contains('node-diagnostics')");
    expect(readPage()).toContain("request('node-diagnostics', nodeId)");
  });
});

describe('the Parameters section', () => {
  const value = (over: Record<string, unknown> = {}) => ({
    bitMask: null,
    value: 1,
    reportedAt: null,
    label: null,
    description: null,
    unit: null,
    min: null,
    max: null,
    defaultValue: null,
    recommended: null,
    states: null,
    allowed: null,
    format: null,
    valueSize: null,
    advanced: false,
    requiresReInclusion: false,
    destructive: false,
    allowManualEntry: true,
    fromConfig: false,
    readable: true,
    writable: true,
    ...over,
  });

  const group = (over: Record<string, unknown> = {}) => ({
    endpoint: 0,
    parameter: 1,
    partial: false,
    values: [value()],
    raw: 1,
    ...over,
  });

  const payloadOf = (over: Record<string, unknown> = {}) => ({
    nodeId: 10,
    state: 'parameters',
    listening: true,
    groups: [group()],
    refresh: { state: 'idle', requestedAt: null, waiting: [], asked: 0, canRequest: true },
    ...over,
  });

  const sectionOf = (over: Record<string, unknown> = {}, state: Record<string, unknown> = {}) =>
    describeParametersSection({ payload: payloadOf(over), ...state });

  describe('where there is nothing to list', () => {
    it('gives each reason its own wording', () => {
      const text = (state: string) =>
        describeParametersSection({ payload: { state, groups: [] } }).text;

      expect(text('interviewing')).toBe("Available once the device's interview has finished.");
      expect(text('unsupported')).toBe('This device does not expose configuration parameters.');
      expect(text('none')).toBe(
        'This device supports configuration, but no parameters are available.',
      );
    });

    it('says it is reading before a payload has arrived, and reports a failure instead', () => {
      expect(describeParametersSection({}).kind).toBe('loading');
      expect(describeParametersSection({ error: 'No answer.' })).toEqual({
        kind: 'error',
        text: 'No answer.',
      });
    });
  });

  describe('what a parameter shows', () => {
    it('lists a parameter the metadata says nothing about by its number and its value', () => {
      const [only] = sectionOf().groups;

      expect(only.number).toBe('Parameter 1');
      expect(only.label).toBeNull();
      expect(only.fields[0].value).toEqual({ text: '1', raw: null });
      expect(only.fields[0].rows).toEqual([]);
      expect(only.fields[0].marks).toEqual([]);
    });

    it('shows the name the metadata gives a value, and keeps the number beside it', () => {
      /**
       * The name is what the setting means; the number is what the manual, another controller
       * and the device itself all speak in, so neither replaces the other.
       */
      const named = sectionOf({
        groups: [group({ values: [value({ value: 2, states: { 0: 'Off', 2: 'Away' } })] })],
      });

      expect(named.groups[0].fields[0].value).toEqual({ text: 'Away', raw: '2' });
    });

    it('says a value the device has not reported is not reported', () => {
      const none = sectionOf({ groups: [group({ values: [value({ value: null })] })] });

      expect(none.groups[0].fields[0].value.text).toBe('Not reported');
    });

    it('carries the unit on the value and on the numbers the metadata compares it with', () => {
      const seconds = sectionOf({
        groups: [
          group({
            values: [
              value({ value: 30, unit: 'seconds', defaultValue: 10, recommended: 20, min: 0, max: 60 }),
            ],
          }),
        ],
      });
      const field = seconds.groups[0].fields[0];

      expect(field.value.text).toBe('30 seconds');
      expect(field.rows).toEqual([
        { label: 'Default', value: '10 seconds' },
        { label: 'Recommended', value: '20 seconds' },
        { label: 'Range', value: '0 to 60 seconds' },
      ]);
    });

    it('keeps an allowed set as its single values and its ranges, steps included', () => {
      const allowed = sectionOf({
        groups: [
          group({
            values: [
              value({
                allowed: [
                  { kind: 'value', value: 0 },
                  { kind: 'range', from: 5, to: 9, step: 2 },
                  { kind: 'range', from: 20, to: 30, step: 1 },
                ],
              }),
            ],
          }),
        ],
      });

      expect(allowed.groups[0].fields[0].rows).toEqual([
        { label: 'Allowed values', value: '0, 5 to 9 in steps of 2, 20 to 30' },
      ]);
    });

    describe('a permitted set that only repeats the range', () => {
      const rowsOf = (over: Record<string, unknown>) =>
        sectionOf({ groups: [group({ values: [value(over)] })] }).groups[0].fields[0].rows;

      it('writes the bounds once where both say the same thing', () => {
        /**
         * The ZAC38 repeater on the live network reports every parameter this way: a range and a
         * permitted set with the same bounds. Two rows saying the identical thing read as two
         * facts, and a reader has to check that they agree.
         */
        const rows = rowsOf({
          unit: '%',
          min: 10,
          max: 50,
          allowed: [{ kind: 'range', from: 10, to: 50, step: null }],
        });

        expect(rows).toContainEqual({ label: 'Range', value: '10 to 50 %' });
        expect(rows.map((row: { label: string }) => row.label)).not.toContain('Allowed values');
      });

      it('keeps a set that steps through the range, which the range does not say', () => {
        const rows = rowsOf({
          unit: '%',
          min: 10,
          max: 50,
          allowed: [{ kind: 'range', from: 10, to: 50, step: 5 }],
        });

        expect(rows).toContainEqual({ label: 'Range', value: '10 to 50 %' });
        expect(rows).toContainEqual({
          label: 'Allowed values',
          value: '10 to 50 % in steps of 5',
        });
      });

      it('keeps a set that names more than the range does', () => {
        const rows = rowsOf({
          unit: '%',
          min: 0,
          max: 50,
          allowed: [
            { kind: 'value', value: 0 },
            { kind: 'range', from: 10, to: 50, step: null },
          ],
        });

        expect(rows).toContainEqual({ label: 'Range', value: '0 to 50 %' });
        expect(rows).toContainEqual({
          label: 'Allowed values',
          value: '0 %, 10 to 50 %',
        });
      });

      it('keeps a set of single values beside the range they sit in', () => {
        const rows = rowsOf({
          unit: 'seconds',
          min: 0,
          max: 60,
          allowed: [
            { kind: 'value', value: 0 },
            { kind: 'value', value: 30 },
          ],
        });

        expect(rows).toContainEqual({
          label: 'Allowed values',
          value: '0 seconds, 30 seconds',
        });
      });

      it('keeps a set the parameter has no range to repeat', () => {
        const rows = rowsOf({ allowed: [{ kind: 'value', value: 7 }] });

        expect(rows).toContainEqual({ label: 'Allowed values', value: '7' });
        expect(rows.map((row: { label: string }) => row.label)).not.toContain('Range');
      });

      it('writes both where the bounds differ at all', () => {
        // The comparison is of the whole rendered line, so a set that stops one short of the
        // range is a different statement and stays.
        const rows = rowsOf({
          unit: '%',
          min: 10,
          max: 50,
          allowed: [{ kind: 'range', from: 10, to: 51, step: null }],
        });

        expect(rows).toContainEqual({ label: 'Range', value: '10 to 50 %' });
        expect(rows).toContainEqual({ label: 'Allowed values', value: '10 to 51 %' });
      });
    });

    it('gives every permitted number the unit the parameter is measured in', () => {
      /**
       * A permitted set is read against the value above it, which carries its unit. Numbers
       * stated without it would be read as a different quantity.
       */
      const allowed = sectionOf({
        groups: [
          group({
            values: [
              value({
                unit: 'seconds',
                allowed: [
                  { kind: 'value', value: 0 },
                  { kind: 'range', from: 1, to: 9, step: 2 },
                ],
              }),
            ],
          }),
        ],
      });

      expect(allowed.groups[0].fields[0].rows).toContainEqual({
        label: 'Allowed values',
        value: '0 seconds, 1 to 9 seconds in steps of 2',
      });
    });

    it('writes a size in bytes, singular where there is one', () => {
      const sizeOf = (valueSize: number) =>
        sectionOf({ groups: [group({ values: [value({ valueSize })] })] }).groups[0].fields[0]
          .rows[0].value;

      expect(sizeOf(1)).toBe('1 byte');
      expect(sizeOf(2)).toBe('2 bytes');
    });

    it('marks what a reader has to know before changing a parameter, each with its meaning', () => {
      const marked = sectionOf(
        {
          groups: [
            group({
              values: [
                value({
                  advanced: true,
                  writable: false,
                  destructive: true,
                  requiresReInclusion: true,
                }),
              ],
            }),
          ],
        },
        { showAdvanced: true },
      );

      expect(marked.groups[0].fields[0].marks).toEqual([
        {
          label: 'Advanced',
          tone: 'neutral',
          explanation: 'This setting is intended for advanced users.',
        },
        { label: 'Read-only', tone: 'neutral', explanation: 'This parameter cannot be changed.' },
        {
          label: 'Destructive',
          tone: 'danger',
          explanation: 'Changing this parameter may reset or erase device settings.',
        },
        {
          label: 'Requires re-inclusion',
          tone: 'caution',
          explanation:
            'Changing this parameter may require excluding and re-including the device.',
        },
      ]);
    });

    it('gives the two marks a reader has to act on a weight of their own', () => {
      /**
       * A parameter that can erase the device's settings, or leave it needing to be excluded
       * and re-included, is not the same kind of fact as one meant for advanced users. Marks
       * that all looked alike would leave the two that matter to be found by reading.
       */
      const every = sectionOf(
        {
          groups: [
            group({
              values: [
                value({
                  advanced: true,
                  writable: false,
                  readable: false,
                  destructive: true,
                  requiresReInclusion: true,
                }),
              ],
            }),
          ],
        },
        { showAdvanced: true },
      );
      const tones: Record<string, string> = {};
      every.groups[0].fields[0].marks.forEach((mark: { label: string; tone: string }) => {
        tones[mark.label] = mark.tone;
      });

      expect(tones).toEqual({
        Advanced: 'neutral',
        'Read-only': 'neutral',
        'Not readable': 'neutral',
        Destructive: 'danger',
        'Requires re-inclusion': 'caution',
      });
    });

    it('says when the device last reported a value, and says where it cannot say', () => {
      /**
       * A time the plugin does not have is reported as not being available, which is all it
       * knows. Saying it was not recorded would describe the plugin as having lost something.
       */
      const at = Date.UTC(2026, 9, 31, 12, 0, 0);
      const reported = sectionOf({ groups: [group({ values: [value({ reportedAt: at })] })] });
      const never = sectionOf();

      expect(reported.groups[0].fields[0].reportedAt).toMatch(
        /^Last reported [A-Z][a-z]{2} \d{1,2}, \d{4} at \d{1,2}:\d{2}\s[AP]M$/,
      );
      expect(never.groups[0].fields[0].reportedAt).toBe('Last report time unavailable');
    });

    it('does not tell a reader a time was not recorded for a value never reported at all', () => {
      /**
       * A write-only parameter has no report to be missing. Saying none was recorded would read
       * as something having gone wrong rather than as how the parameter is defined.
       */
      const writeOnly = sectionOf({
        groups: [group({ values: [value({ readable: false, value: null })] })],
      });
      const field = writeOnly.groups[0].fields[0];

      expect(field.reportedAt).toBeNull();
      expect(field.marks).toEqual([
        {
          label: 'Not readable',
          tone: 'neutral',
          explanation: 'The device does not report a current value for this parameter.',
        },
      ]);
    });
  });

  describe('a parameter divided into fields', () => {
    const partials = () =>
      group({
        parameter: 7,
        partial: true,
        values: [
          value({ bitMask: 0x0f, label: 'Fade time', value: 3 }),
          value({ bitMask: 0xf0, value: 1 }),
        ],
      });

    it('draws one group holding each field, never one parameter per field', () => {
      const [only] = sectionOf({ groups: [partials()] }).groups;

      expect(only.number).toBe('Parameter 7');
      expect(only.fields.map((field: { label: string }) => field.label)).toEqual([
        'Fade time',
        'Bit mask 0xF0',
      ]);
    });

    it('leaves a divided parameter without a label of its own', () => {
      // The fields are separate settings sharing a number, so the first field's label is not
      // the parameter's name.
      expect(sectionOf({ groups: [partials()] }).groups[0].label).toBeNull();
    });

    it('names a group by its own parameter label where it has one value', () => {
      const labelled = sectionOf({
        groups: [group({ values: [value({ label: 'Motion timeout' })] })],
      });

      expect(labelled.groups[0].label).toBe('Motion timeout');
    });

    it("does not write an undivided parameter's label again on its value", () => {
      /**
       * The value is the parameter, so the group's name is its name. Carried on both, it is
       * drawn twice, once under the other.
       */
      const labelled = sectionOf({
        groups: [group({ values: [value({ label: 'Motion timeout' })] })],
      });

      expect(labelled.groups[0].fields[0].label).toBeNull();
    });

    it('says which endpoint a group belongs to, and says nothing for the root', () => {
      const endpoints = sectionOf({
        groups: [group({ endpoint: 0 }), group({ endpoint: 2 })],
      });

      expect(endpoints.groups.map((one: { endpoint: string }) => one.endpoint)).toEqual([
        null,
        'Endpoint 2',
      ]);
    });
  });

  describe('searching', () => {
    const many = () => [
      group({ parameter: 1, values: [value({ label: 'Motion timeout' })] }),
      group({ parameter: 12, values: [value({ description: 'Reports the LED state' })] }),
      group({
        parameter: 30,
        partial: true,
        values: [value({ bitMask: 0x0f, label: 'Chime volume' }), value({ bitMask: 0xf0 })],
      }),
    ];

    const found = (search: string) =>
      sectionOf({ groups: many() }, { search }).groups.map(
        (one: { parameter: number }) => one.parameter,
      );

    it('matches a parameter number, a label and a description', () => {
      expect(found('12')).toEqual([12]);
      expect(found('motion')).toEqual([1]);
      expect(found('led state')).toEqual([12]);
    });

    it('matches a field label and keeps the whole parameter it belongs to', () => {
      /** A field is part of a parameter, and a group shown without its siblings would be a
       * parameter misdescribed. */
      const kept = sectionOf({ groups: many() }, { search: 'chime' }).groups;

      expect(kept).toHaveLength(1);
      expect(kept[0].fields).toHaveLength(2);
    });

    it('ignores case and surrounding space, and keeps everything for an empty search', () => {
      expect(found('  MOTION  ')).toEqual([1]);
      expect(found('   ')).toEqual([1, 12, 30]);
    });

    it('counts parameters rather than fields, and says nothing while nothing is hidden', () => {
      expect(sectionOf({ groups: many() }, { search: 'motion' }).search.count).toBe(
        'Showing 1 of 3 parameters',
      );
      expect(sectionOf({ groups: many() }).search.count).toBeNull();
    });

    it('says so where a search matches nothing', () => {
      const none = sectionOf({ groups: many() }, { search: 'zzz' });

      expect(none.groups).toEqual([]);
      expect(none.empty).toBe('No parameters match your search.');
    });
  });

  describe('advanced parameters', () => {
    const mixed = () => [
      group({ parameter: 1, values: [value({ label: 'Motion timeout' })] }),
      group({ parameter: 2, values: [value({ label: 'Calibration', advanced: true })] }),
      group({
        parameter: 3,
        partial: true,
        values: [
          value({ bitMask: 0x0f, label: 'Chime volume' }),
          value({ bitMask: 0xf0, label: 'Service bits', advanced: true }),
        ],
      }),
    ];

    it('hides a parameter whose every field is advanced', () => {
      const shown = sectionOf({ groups: mixed() }).groups;

      expect(shown.map((one: { parameter: number }) => one.parameter)).toEqual([1, 3]);
    });

    it('keeps a parameter that mixes ordinary and advanced fields, without its advanced ones', () => {
      const [, divided] = sectionOf({ groups: mixed() }).groups;

      expect(divided.fields.map((field: { label: string }) => field.label)).toEqual([
        'Chime volume',
      ]);
    });

    it('reveals every advanced field when the reader asks', () => {
      const revealed = sectionOf({ groups: mixed() }, { showAdvanced: true }).groups;

      expect(revealed.map((one: { parameter: number }) => one.parameter)).toEqual([1, 2, 3]);
      expect(revealed[2].fields).toHaveLength(2);
    });

    it('counts the same advanced fields whether they are shown or hidden', () => {
      /**
       * The number is written on the control that reveals them. One counted from what is on
       * screen would change the moment it was pressed, as though pressing it had found more.
       */
      expect(sectionOf({ groups: mixed() }).advanced).toEqual({
        label: 'Show advanced (2)',
        expanded: false,
      });
      expect(sectionOf({ groups: mixed() }, { showAdvanced: true }).advanced).toEqual({
        label: 'Hide advanced (2)',
        expanded: true,
      });
    });

    it('counts only the advanced fields a search has kept', () => {
      const searched = sectionOf({ groups: mixed() }, { search: 'calibration' });

      expect(searched.advanced.label).toBe('Show advanced (1)');
    });

    it('offers nothing to reveal where no parameter is advanced', () => {
      expect(sectionOf().advanced).toBeNull();
    });

    it('says why the list is empty where every parameter is advanced', () => {
      const all = sectionOf({
        groups: [group({ values: [value({ advanced: true })] })],
      });

      expect(all.empty).toBe('All parameters reported by this device are marked advanced.');
    });

    it('says a search found advanced parameters rather than that it found none', () => {
      /**
       * The search kept a parameter and the disclosure beside it offers to show what was kept.
       * Reporting no match there would be contradicted by the control next to it.
       */
      const hidden = sectionOf({ groups: mixed() }, { search: 'calibration' });

      expect(hidden.groups).toEqual([]);
      expect(hidden.advanced.label).toBe('Show advanced (1)');
      expect(hidden.empty).toBe(
        'Matching advanced parameters are hidden. Select Show advanced to view them.',
      );
    });

    it('still says a search found nothing where nothing matched at all', () => {
      const none = sectionOf({ groups: mixed() }, { search: 'nothing here' });

      expect(none.advanced).toBeNull();
      expect(none.empty).toBe('No parameters match your search.');
    });

    it('lists what the search found once the advanced parameters are shown', () => {
      const shown = sectionOf(
        { groups: mixed() },
        { search: 'calibration', showAdvanced: true },
      );

      expect(shown.groups).toHaveLength(1);
      expect(shown.empty).toBeNull();
    });
  });

  describe('asking the device for current values', () => {
    const refreshOf = (over: Record<string, unknown>, listening = true) =>
      describeParametersRefresh({
        listening,
        refresh: {
          state: 'idle',
          waiting: [],
          asked: 0,
          completedAt: null,
          canRequest: true,
          ...over,
        },
      });

    it('offers nothing where the device reports no value a re-read could confirm', () => {
      expect(refreshOf({ canRequest: false })).toEqual({
        button: null,
        status: 'This device does not report any configuration values that can be re-read.',
      });
    });

    it('says what a re-read can promise for a device that is awake and one that is not', () => {
      expect(refreshOf({}).button).toEqual({ label: 'Re-read values', disabled: false });
      expect(refreshOf({}, false).button).toEqual({
        label: 'Re-read when it wakes',
        disabled: false,
      });
    });

    it('refuses a second ask while one is running, and says what is being waited for', () => {
      expect(refreshOf({ state: 'dispatching' })).toEqual({
        button: { label: 'Re-read values', disabled: true },
        status: 'Waiting for the device to report current values.',
      });
      expect(refreshOf({ state: 'dispatching' }, false).status).toBe(
        'Re-read requested. Values will be confirmed when the device wakes.',
      );
    });

    it('offers another attempt where one finished with values unreported', () => {
      expect(refreshOf({ state: 'incomplete' })).toEqual({
        button: { label: 'Try re-read again', disabled: false },
        status: 'Some values have not been reported yet.',
      });
    });

    it('offers a sleeping device the attempt its own wording describes', () => {
      /**
       * A device that is asleep has not failed to answer and has not been asked yet, so the
       * retry says what it will wait for rather than inviting an immediate second try.
       */
      expect(refreshOf({ state: 'incomplete' }, false).button).toEqual({
        label: 'Try re-read when it wakes',
        disabled: false,
      });
    });

    it('says what became of an attempt even where nothing can be asked again', () => {
      /**
       * A device whose values have all gone reports nothing a re-read could confirm, and it is
       * the device with the most to explain. Whether a control is offered is the one thing the
       * capability decides; what the section says is what happened.
       */
      expect(refreshOf({ state: 'unavailable', canRequest: false })).toEqual({
        button: null,
        status: 'Some values could not be confirmed because they are no longer available.',
      });
      expect(refreshOf({ state: 'dispatching', canRequest: false })).toEqual({
        button: null,
        status: 'Waiting for the device to report current values.',
      });
      expect(refreshOf({ state: 'incomplete', canRequest: false })).toEqual({
        button: null,
        status: 'Some values have not been reported yet.',
      });
      expect(refreshOf({ state: 'complete', completedAt: 1_000, canRequest: false }).button).toBeNull();
    });

    it('says values that have gone could not be confirmed, which is not a success', () => {
      /**
       * Nothing is outstanding and nothing can be. Said apart from values that have yet to
       * answer, because another attempt can bring those and will never bring these.
       */
      expect(refreshOf({ state: 'unavailable' })).toEqual({
        button: { label: 'Re-read values', disabled: false },
        status: 'Some values could not be confirmed because they are no longer available.',
      });
      expect(refreshOf({ state: 'unavailable' }, false).button.label).toBe('Re-read when it wakes');
    });

    it('says a re-read finished only when every value it asked about answered', () => {
      expect(refreshOf({ state: 'complete' }).button).toEqual({
        label: 'Re-read values',
        disabled: false,
      });
    });

    it('dates the re-read it reports, so a success is not read as a recent one', () => {
      /**
       * The status stands for as long as the plugin holds the attempt. Undated, it would go on
       * saying the values were re-read, and a reader returning days later would read that as
       * having just happened.
       */
      const done = refreshOf({ state: 'complete', completedAt: Date.now() });

      expect(done.status).toMatch(
        /^Configuration values re-read [A-Z][a-z]{2} \d{1,2}, \d{4} at \d{1,2}:\d{2}\s[AP]M\.$/,
      );
    });

    it('says the re-read finished without a time where none was recorded', () => {
      expect(refreshOf({ state: 'complete' }).status).toBe('Configuration values re-read.');
    });

    it('marks the value that is being waited for, and only that one', () => {
      const waiting = sectionOf({
        groups: [
          group({
            parameter: 7,
            partial: true,
            values: [value({ bitMask: 0x0f }), value({ bitMask: 0xf0 })],
          }),
        ],
        refresh: {
          state: 'dispatching',
          waiting: [{ endpoint: 0, parameter: 7, bitMask: 0xf0 }],
          asked: 2,
          canRequest: true,
        },
      });

      expect(
        waiting.groups[0].fields.map((field: { waiting: boolean }) => field.waiting),
      ).toEqual([false, true]);
    });

    it('does not mark a value of another parameter that shares its bits', () => {
      const waiting = sectionOf({
        groups: [group({ parameter: 7 }), group({ parameter: 8 })],
        refresh: {
          state: 'dispatching',
          waiting: [{ endpoint: 0, parameter: 8, bitMask: null }],
          asked: 2,
          canRequest: true,
        },
      });

      expect(waiting.groups.map((one: { fields: { waiting: boolean }[] }) => one.fields[0].waiting))
        .toEqual([false, true]);
    });

    it('keeps re-reading while an attempt is running and not once it has settled', () => {
      /**
       * Settling says the attempt finished, never that a value answered, so what it ends is the
       * reason to keep looking and not the question itself.
       */
      expect(parametersRefreshRunning(payloadOf({ refresh: { state: 'dispatching' } }))).toBe(true);
      expect(parametersRefreshRunning(payloadOf({ refresh: { state: 'incomplete' } }))).toBe(false);
      expect(parametersRefreshRunning(payloadOf({ refresh: { state: 'complete' } }))).toBe(false);
      expect(parametersRefreshRunning(null)).toBe(false);
    });
  });

  describe('the count beside the tab', () => {
    it('counts the parameters a device reported', () => {
      expect(parametersTabCount(payloadOf({ groups: [group(), group({ parameter: 2 })] }))).toBe(2);
    });

    it('counts nothing where the device has no parameters to count', () => {
      expect(parametersTabCount({ state: 'none', groups: [] })).toBeNull();
      expect(parametersTabCount({ state: 'interviewing', groups: [] })).toBeNull();
      expect(parametersTabCount(null)).toBeNull();
    });
  });

  describe('text the device supplied', () => {
    it('passes a label through as the device wrote it, for the page to render as text', () => {
      const hostile = '<img src=x onerror=alert(1)>';
      const marked = sectionOf({
        groups: [group({ values: [value({ label: hostile, description: hostile })] })],
      });

      expect(marked.groups[0].label).toBe(hostile);
      expect(marked.groups[0].fields[0].description).toBe(hostile);
      expect(escapeHtml(hostile)).toBe('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('searches the text the device supplied rather than markup around it', () => {
      const found = sectionOf(
        { groups: [group({ values: [value({ label: '<b>Chime</b>' })] })] },
        { search: 'b>chime' },
      );

      expect(found.groups).toHaveLength(1);
    });
  });
});
