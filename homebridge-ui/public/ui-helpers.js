(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ZWaveUsbUiHelpers = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SECURITY_KEY_FIELDS = [
    'S0_Legacy',
    'S2_Unauthenticated',
    'S2_Authenticated',
    'S2_AccessControl',
    'S2_Authenticated_LR',
    'S2_AccessControl_LR',
  ];

  function normalizeSecurityKey(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizeSecurityKeys(keys) {
    const normalized = {};
    for (const field of SECURITY_KEY_FIELDS) {
      normalized[field] = normalizeSecurityKey(keys[field]);
    }
    return normalized;
  }

  function getInvalidSecurityKeyFields(keys) {
    return SECURITY_KEY_FIELDS.filter((field) => {
      const value = normalizeSecurityKey(keys[field]);
      return value !== '' && !/^[0-9A-F]{32}$/.test(value);
    });
  }

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  /**
   * Escapes a value for interpolation into HTML, as element text or inside a quoted attribute.
   * Single quotes are escaped as well as double, because attributes in this page are written
   * with either. A browser decodes the entities again when the attribute is read back, so a
   * value that goes through JSON.parse still parses.
   */
  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(
      /[&<>"']/g,
      (character) => HTML_ESCAPES[character],
    );
  }

  /**
   * Text for an RSSI the plugin reports: a number is a dBm measurement, a string is the words for
   * an RSSI error state, and anything else is nothing worth showing. Unescaped; the caller
   * escapes it where it is written into markup.
   */
  function formatRssi(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `${value} dBm`;
    }

    return typeof value === 'string' ? value : '';
  }

  /** A figure that arrives as JSON: anything that is not a finite number is shown as 0, never as markup. */
  function countOf(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  /** One observed route as escaped markup. */
  function describeRoute(route) {
    if (!route) {
      return 'not recorded';
    }
    const path = route.direct
      ? 'direct (no repeaters)'
      : `via ${(route.repeaters || []).map((repeater) => escapeHtml(repeater)).join(' &rarr; ')}`;
    const ackRssi = formatRssi(route.ackRSSI);
    const rssi = ackRssi ? `, ACK RSSI ${escapeHtml(ackRssi)}` : '';
    const rate =
      typeof route.protocolDataRate === 'number'
        ? `, protocol/speed code ${route.protocolDataRate}`
        : '';
    const failed =
      Array.isArray(route.routeFailedBetween) && route.routeFailedBetween.length === 2
        ? `, a transmission recently failed between nodes ${escapeHtml(
            route.routeFailedBetween[0],
          )} and ${escapeHtml(route.routeFailedBetween[1])}`
        : '';

    return `${path}${rssi}${rate}${failed}`;
  }

  /**
   * The node diagnostics dialog. The title is plain text for textContent; the body is markup in
   * which every value that came from the plugin is escaped or reduced to a number.
   *
   * A route's ACK RSSI and the node-level average show the signal strength of ACK frames received
   * by the controller, so for a routed transmission they describe the first hop (usually the
   * nearest repeater), not the destination device. The background figures are a separate
   * measurement: the controller's own network-wide reading of ambient radio noise, which says
   * nothing about the selected node.
   */
  function renderDiagnostics(report) {
    const d = report || {};
    const averageAck = formatRssi(d.averageAckRSSI);
    const neighbors =
      Array.isArray(d.neighbors) && d.neighbors.length
        ? escapeHtml(d.neighbors.join(', '))
        : 'not available';
    const background = d.backgroundRSSI
      ? escapeHtml(
          Object.entries(d.backgroundRSSI)
            .map(([channel, value]) => `${channel.replace('rssiChannel', 'ch')} ${formatRssi(value) || 'not recorded'}`)
            .join(', '),
        )
      : 'not available';

    return {
      title: `Node ${d.nodeId} (${d.name}) radio and routes`,
      html: `
        <p class="text-muted mb-2">
          Routes are chosen per transmission. These values describe the last observed
          and last working routes, not a fixed connection.
        </p>
        <p class="text-muted mb-2">
          A route's ACK RSSI and the average ACK RSSI show the signal strength of acknowledgment
          frames received by the controller. For a routed transmission they describe the first hop,
          usually the nearest repeater, not the device itself. Controller background RSSI is a
          separate, network-wide measurement of ambient radio noise.
        </p>
        <ul class="pl-3 mb-0">
          <li>Neighbor nodes: ${neighbors}</li>
          <li>Last working route: ${describeRoute(d.lastWorkingRoute)}</li>
          <li>Next-to-last working route: ${describeRoute(d.nextToLastWorkingRoute)}</li>
          <li>Average ACK RSSI at the controller (first hop): ${averageAck ? escapeHtml(averageAck) : 'not recorded'}</li>
          <li>Average round trip: ${typeof d.roundTripTimeMs === 'number' ? `${Math.round(d.roundTripTimeMs)} ms` : 'not recorded'}</li>
          <li>Commands sent / received: ${countOf(d.commandsTX)} / ${countOf(d.commandsRX)}</li>
          <li>Commands dropped sending / receiving: ${countOf(d.commandsDroppedTX)} / ${countOf(d.commandsDroppedRX)}</li>
          <li>Last seen: ${d.lastSeen ? escapeHtml(d.lastSeen) : 'not recorded'}</li>
          <li>Controller background RSSI (network-wide, not this node): ${background}</li>
        </ul>
      `,
    };
  }

  /** A position the covering reported, or wording for one it never did. */
  function positionText(value) {
    return typeof value === 'number' ? `${value}%` : 'an unknown position';
  }

  /**
   * What a position test proved. The plugin cannot say a command was accepted: a write can
   * resolve without reaching the device, so the wording reports what settled and nothing more.
   * A covering already at the commanded position ends there whether it moved or not, so that
   * case is reported as proving nothing rather than as a pass.
   */
  function describeCoveringTestResult(result) {
    const asked = `Commanded ${result.requested}%`;
    const from = `from ${positionText(result.before)}`;
    const now = `now ${positionText(result.after)}`;

    if (result.startedAtTarget) {
      return `${asked} ${from}, ${now}. The covering was already there, so this proves nothing. Try a different position.`;
    }

    if (result.timedOut) {
      return `${asked} ${from}, ${now}. The covering was still reporting movement when the test gave up, so nothing was established.`;
    }

    if (result.reached) {
      return `${asked} ${from}, ${now}. The covering moved there.`;
    }

    return `${asked} ${from}, ${now}. The covering did not reach that position.`;
  }

  /**
   * What a stop proved. A covering that ignores the stop carries on to its target and comes to
   * rest there, which is indistinguishable from a successful stop unless the target is part of
   * the answer.
   */
  function describeCoveringStopResult(result) {
    const ended = `Ended at ${positionText(result.after)}`;
    const sent = `It was at ${positionText(result.before)} when the stop was sent`;

    if (result.timedOut) {
      return `${ended}. ${sent}, and the covering was still reporting movement when the test gave up, so the stop cannot be credited.`;
    }

    if (result.shortOfTarget) {
      return `${ended}, short of its target of ${positionText(result.target)}. ${sent}, and it came to rest after the stop, consistent with the stop taking effect.`;
    }

    if (!result.moved) {
      return `${ended}. ${sent}, and the covering never reported moving afterward, so nothing was established. Start a move first, then stop it part way.`;
    }

    if (typeof result.target !== 'number') {
      return `${ended}. ${sent}, but no target was recorded, so there is nothing to compare against.`;
    }

    return `${ended}, which is its target of ${positionText(result.target)}. ${sent}. The covering may have finished traveling on its own, so the stop proved nothing.`;
  }

  /**
   * What the Rebuild Routes button should say and do for each outcome the controller reports.
   *
   * `busy` means the driver is rebuilding from a request this plugin no longer tracks. There is
   * something to wait for, but `isHealing` cannot see it, so the wait has to watch the driver's
   * own view instead.
   */
  function describeHealStart(result) {
    if (result === 'started') {
      return {
        status: 'Rebuilding routes. Watch the Homebridge log for progress.',
        watch: true,
      };
    }

    if (result === 'busy') {
      return {
        status: 'A route rebuild started elsewhere is already running. Waiting for it to finish.',
        watch: true,
      };
    }

    return { status: 'The controller did not start a route rebuild.', watch: false };
  }

  /** Whether a rebuild is still running, by either the plugin's reckoning or the driver's. */
  function healIsRunning(state) {
    return Boolean(state && (state.healing || state.rebuilding));
  }

  /**
   * Path data for the icons the node table draws, each the contents of an
   * `<svg class="ico" viewBox="0 0 16 16">`. Inline rather than an icon font: a second CDN
   * would leave the table unreadable on a Homebridge host with no internet access.
   */
  const NODE_ICONS = {
    open: '<path d="M6 3l5 5-5 5"/>',
    rename: '<path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/><path d="M9.5 4l2.5 2.5"/>',
    refresh: '<path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1"/><path d="M13.5 2v3h-3"/>',
    update: '<path d="M8 2v8M5 7l3 3 3-3"/><path d="M2.5 11v2.5h11V11"/>',
    battery: '<rect x="1" y="4" width="12" height="8" rx="1.6"/><path d="M14.3 6.6v2.8"/>',
    remove: '<path d="M2.5 4h11M6 4V2.5h4V4"/><path d="M4 4l.7 9.5h6.6L12 4"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.5v3.5M8 5v.1"/>',
    pending: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
    warning: '<path d="M8 2L1.5 13.5h13z"/><path d="M8 6.5v3M8 11.6v.1"/>',
    error: '<circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  };

  /** A key the caller supplied, looked up only among the map's own entries. */
  function lookup(map, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key)
      ? map[key]
      : undefined;
  }

  /**
   * The one firmware state a node is in, with the version or percentage belonging to it.
   *
   * What the plugin reports outranks what this page remembers: progress means an update is
   * running whatever the page last recorded, so the client record is read only when the plugin
   * reports no progress at all. That is what lets a five-second refresh leave a check or a
   * found update standing while never contradicting an update already under way.
   */
  function firmwareStateOf(node, record) {
    const progress = node && node.firmwareProgress;

    if (progress) {
      const reported = Number(progress.percent);
      const percent = Number.isFinite(reported) ? reported : 0;
      if (progress.outcome === 'success') {
        return { name: 'completed', percent };
      }
      if (progress.outcome === 'failure') {
        return { name: 'failed', percent };
      }
      return { name: 'updating', percent };
    }

    const phase = record && record.phase;
    if (phase === 'checking') {
      return { name: 'checking' };
    }
    if (phase === 'available' || phase === 'starting') {
      return { name: phase, version: record.version };
    }

    return { name: 'idle' };
  }

  const NO_UPDATE_TEXT = 'No updates available for this device.';
  const UPDATE_GONE_TEXT =
    'That firmware update is no longer available. The update was not started.';

  function updateChangedText(version) {
    return (
      `The available firmware update changed to v${version}. ` +
      'The update was not started. Select Update again to continue.'
    );
  }

  /**
   * The half of the firmware state this page keeps for itself, advanced by one event.
   *
   * Returns the record to keep (null means the node is back to idle), the message to show when
   * the wording belongs to this machine rather than to a server error, and whether the caller
   * should now send the update it has just been handed.
   *
   * The update payload is deliberately absent from the record. It is read at the moment it is
   * sent and never kept, so there is no stored payload to send later against a device that has
   * meanwhile been offered a different version.
   */
  function nextFirmwareRecord(record, event) {
    const version = record && record.version;
    const type = event && event.type;
    const updates = (event && event.updates) || [];
    const offered = updates.length > 0 ? updates[0] : null;
    const idle = { record: null, toast: null, start: false };

    // Keeping an "available" record without a version would offer an update called "vundefined".
    const availableAt = (at) =>
      typeof at === 'string' && at !== ''
        ? { record: { phase: 'available', version: at }, toast: null, start: false }
        : idle;

    /**
     * `update-finished` is the end of a transfer the plugin confirmed, so nothing this page
     * remembers about the update is worth keeping. Without it the page would wait for a refresh
     * to notice, and a refresh can fail.
     */
    if (type === 'node-gone' || type === 'check-failed' || type === 'update-finished') {
      return idle;
    }

    if (type === 'check-clicked') {
      return { record: { phase: 'checking' }, toast: null, start: false };
    }

    if (type === 'check-result') {
      return offered
        ? availableAt(offered.version)
        : { record: null, toast: { type: 'info', text: NO_UPDATE_TEXT }, start: false };
    }

    if (type === 'dialog-confirmed') {
      return { record: { phase: 'starting', version }, toast: null, start: false };
    }

    if (type === 'recheck-result') {
      if (!offered) {
        return { record: null, toast: { type: 'info', text: UPDATE_GONE_TEXT }, start: false };
      }
      if (offered.version !== version) {
        const changed = availableAt(offered.version);
        return {
          record: changed.record,
          toast: { type: 'info', text: updateChangedText(offered.version) },
          start: false,
        };
      }
      return { record: { phase: 'starting', version }, toast: null, start: true };
    }

    if (type === 'recheck-failed' || type === 'start-rejected') {
      return availableAt(version);
    }

    // Opening and canceling the dialog leave the record exactly as it was.
    return { record: record || null, toast: null, start: false };
  }

  /**
   * The node list with one node's firmware progress dropped.
   *
   * A snapshot taken while an update was running outlives the update: the plugin keeps its own
   * progress for thirty seconds and the page redraws from the list it last fetched, so a bar
   * that has finished moving would go on being drawn until a refresh replaced it. The list is
   * copied rather than edited, so a caller holding the old one still sees what it fetched.
   */
  function withoutFirmwareProgress(nodes, nodeId) {
    const wanted = String(nodeId);

    return (nodes || []).map((node) => {
      if (String(node && node.nodeId) !== wanted || !(node && node.firmwareProgress)) {
        return node;
      }
      const copy = Object.assign({}, node);
      delete copy.firmwareProgress;
      return copy;
    });
  }

  /**
   * The battery indicator for one node, or nothing for a device that has no battery to report.
   *
   * The icon is filled in fifths so the row reads at a glance, and the figure itself goes in the
   * label, where someone who wants the number can find it. A device can warn that its battery is
   * low without reporting a usable percentage, because Battery CC sends that warning in place of
   * one, so the warning counts on its own as well as when the level has fallen to a fifth.
   */
  function describeBattery(node) {
    const battery = node && node.battery;
    if (!battery) {
      return null;
    }

    const reported = Number(battery.level);
    const level = Number.isFinite(reported)
      ? Math.min(100, Math.max(0, Math.round(reported)))
      : undefined;
    const low = battery.low === true || (level !== undefined && level <= 20);

    return {
      level,
      low,
      // The shell is drawn whatever the charge, so an empty one still reads as a battery and a
      // device without one has no icon at all. Nothing is invented for a battery at zero, or
      // for a warning that arrived without a percentage.
      fifths: level === undefined ? 0 : Math.ceil(level / 20),
      // The warning is said in words as well as shown in red, so it reaches a screen reader and
      // anyone who cannot tell the red icon from the gray one.
      text: low
        ? level === undefined
          ? 'Battery low'
          : `Battery low, ${level}%`
        : `Battery ${level}%`,
    };
  }

  const NODE_BUTTONS = [
    { action: 'rename-node', label: 'Rename', variant: 'outline-secondary', icon: 'rename' },
    {
      action: 'refresh-node-info',
      label: 'Refresh Info',
      variant: 'outline-secondary',
      icon: 'refresh',
    },
    { action: 'check-update', label: 'Check Update', variant: 'outline-primary', icon: 'update' },
    { action: 'remove-node', label: 'Remove', variant: 'outline-danger', icon: 'remove' },
  ];

  /**
   * What the action cell holds for one node: the controller badge, a progress bar, or the
   * group of icon buttons. The page renders this and decides nothing for itself.
   */
  /**
   * How far a firmware update has got, or null while none is running.
   *
   * `active` is what the page draws movement from. A bar that goes on animating after an
   * update has finished or failed says it is still running, which is the one thing it is
   * there to report. The label is the same sentence the row notice carries, so the bar and
   * the notice beside it cannot say different things.
   */
  function firmwareProgressOf(firmwareState) {
    const state = firmwareState || { name: 'idle' };
    const terminal = state.name === 'completed' || state.name === 'failed';

    if (state.name !== 'updating' && !terminal) {
      return null;
    }

    const reported = Math.round(Number(state.percent));
    const notice = lookup(FIRMWARE_NOTICES, state.name);

    return {
      percent: Number.isFinite(reported) ? Math.min(100, Math.max(0, reported)) : 0,
      failed: state.name === 'failed',
      active: state.name === 'updating',
      label: notice ? notice.text : '',
    };
  }

  function describeNodeActions(node, firmwareState) {
    const state = firmwareState || { name: 'idle' };

    if (node && node.nodeId === 1) {
      return { kind: 'controller' };
    }

    /**
     * The way into the node sits outside the group of things you do to the node, so it reads
     * as a different kind of action, and it is offered whatever else the node is doing. A node
     * in the middle of a firmware update is one a reader is more likely to want to look at,
     * not less.
     */
    const open = {
      action: 'open-node',
      label: `Open node ${node.nodeId}`,
      variant: 'outline-secondary',
      icon: 'open',
      disabled: false,
      spinner: false,
    };

    const progress = firmwareProgressOf(state);
    if (progress) {
      return { kind: 'progress', ...progress, open };
    }

    const buttons = NODE_BUTTONS.map((button) => {
      if (button.action === 'refresh-node-info') {
        return Object.assign({}, button, {
          requiresWakeup: !(node && (node.isListening || node.isFrequentListening)),
          disabled: false,
          spinner: false,
        });
      }

      if (button.action === 'check-update') {
        if (state.name === 'available') {
          return {
            action: 'start-update',
            label: `Update to v${state.version}`,
            variant: 'success',
            icon: 'update',
            disabled: false,
            spinner: false,
          };
        }
        if (state.name === 'checking' || state.name === 'starting') {
          return Object.assign({}, button, { disabled: true, spinner: true });
        }
      }

      return Object.assign({}, button, { disabled: false, spinner: false });
    });

    return { kind: 'buttons', buttons, open };
  }

  /**
   * What the list's Firmware column says: the version the node reports, and the progress of an
   * update when one is running, finished or failed.
   *
   * The progress used to replace the row's group of buttons. The row no longer has one, and a
   * reader scanning the list for which device is updating is looking at the firmware.
   */
  function describeFirmwareCell(node, firmwareState) {
    return {
      version: (node && node.firmwareVersion) || 'Unknown',
      progress: firmwareProgressOf(firmwareState),
    };
  }

  /** Most serious first, so a failure is never read after the routine news below it. */
  const SEVERITY_ORDER = ['error', 'warning', 'pending', 'info'];

  const REFRESH_NOTICES = {
    'waiting-wakeup': { severity: 'pending', text: 'Refresh queued until the device wakes' },
    refreshing: { severity: 'info', text: 'Refresh in progress' },
  };

  const HOMEKIT_NOTICES = {
    'cached-pending': {
      severity: 'pending',
      text: 'Cached in HomeKit; waiting for the device to wake so the interview can continue',
    },
    'pending-interview': {
      severity: 'pending',
      text: 'Not yet in HomeKit; waiting for interview metadata',
    },
  };

  const FIRMWARE_NOTICES = {
    updating: { severity: 'info', text: 'Updating firmware' },
    completed: { severity: 'info', text: 'Firmware update completed' },
    failed: { severity: 'error', text: 'Firmware update failed' },
  };

  /** What a node reports about itself, in the order a Z-Wave controller numbers them. */
  const NODE_STATUS = ['Unknown', 'Asleep', 'Awake', 'Dead', 'Alive'];

  /**
   * The badge the list and the node's own page both draw, so the two cannot come to differ
   * about what a node is doing or about which color says so.
   */
  function describeNodeStatus(node) {
    const text = NODE_STATUS[(node || {}).status] || 'Unknown';

    return {
      text,
      tone: text === 'Alive' || text === 'Awake' ? 'success' : 'secondary',
    };
  }

  /**
   * What a node's own page says about it above everything else: who it is, whether it is
   * answering, and whether it can be reached without waiting for it to wake.
   */
  function describeNodeHeader(node) {
    const status = describeNodeStatus(node);

    return {
      name: node.name || node.label || `Node ${node.nodeId}`,
      nodeId: node.nodeId,
      status: status.text,
      statusTone: status.tone,
      firmware: node.firmwareVersion ? `Firmware ${node.firmwareVersion}` : 'Firmware unknown',
      listening: node.isListening
        ? 'Always listening'
        : node.isFrequentListening
          ? 'Listens frequently'
          : 'Sleeps between reports',
    };
  }

  /**
   * The actions a node's own page offers, in the order it draws them. Diagnostics is not among
   * them: it has a section of its own.
   */
  const DETAIL_CONTROLS = ['refresh-node-info', 'check-update', 'start-update', 'remove-node'];

  /**
   * Everything a node's own page draws, decided here rather than in the page.
   *
   * Two passes over the same node produce the same description, which is what lets the page
   * compare one against the last and leave the view alone when nothing has moved. A refresh
   * that rewrote the page every five seconds would take the keyboard with it, and would take a
   * half-made choice with it once a section carries a form.
   */
  function describeNodeDetail(node, firmwareState) {
    const actions = describeNodeActions(node, firmwareState);
    const buttons = actions.kind === 'buttons' ? actions.buttons : [];

    return {
      header: describeNodeHeader(node),
      rename: buttons.find((button) => button.action === 'rename-node') || null,
      controls: buttons.filter((button) => DETAIL_CONTROLS.indexOf(button.action) !== -1),
      /**
       * Carried whole rather than picked apart, so the bar on the node's page is drawn from
       * the same description as the one in the list and cannot come to differ from it.
       */
      progress: actions.kind === 'progress' ? firmwareProgressOf(firmwareState) : null,
    };
  }

  /** What the chip beside a published type says about where that type came from. */
  const TYPE_SOURCE_CHIPS = {
    registry: 'Verified default',
    detected: 'Detected default',
    override: 'Your override',
  };

  /** One heading for every way the saved overrides can be unavailable. */
  const STORE_ERROR_HEADING = 'Saved device type overrides are unavailable.';

  const STORE_ERROR_BODIES = {
    'permission-denied':
      'Homebridge does not have permission to read the saved overrides file, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    unreadable:
      'The saved overrides file could not be opened, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    'invalid-json':
      'The saved overrides file is damaged, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    'unsupported-version':
      'The saved overrides file is in a format this plugin does not read, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    'wrong-network':
      'The saved overrides file belongs to a different Z-Wave network, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
    'invalid-data':
      'The saved overrides file holds something this plugin cannot use, so no saved overrides are applied and type changes are disabled. Check the Homebridge log for the file location and details.',
  };

  /**
   * One string for one piece of hardware, so a choice made against a device can be told apart
   * from the same choice made against whatever reports the same node number later.
   */
  function fingerprintKey(fingerprint) {
    if (!fingerprint) {
      return '';
    }

    return `${fingerprint.manufacturerId}:${fingerprint.productType}:${fingerprint.productId}`;
  }

  /** Four uppercase hex digits behind 0x, which is how a fingerprint is written throughout. */
  function hexWord(value) {
    return `0x${Number(value).toString(16).toUpperCase().padStart(4, '0')}`;
  }

  /** Only the type names ending in a sibilant take "es", and only the switches do. */
  function pluralTypeName(name) {
    return /(s|x|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`;
  }

  /**
   * What the endpoints of a device publish, in endpoint order. A type published by more than
   * one endpoint is counted rather than written out again, and no endpoint is named or
   * numbered, because nothing a reader can do here is per endpoint.
   */
  function listEndpointTypes(endpointTypes) {
    const order = [];
    const counts = new Map();

    (endpointTypes || []).forEach((endpoint) => {
      const kind = endpoint.primaryKind;
      if (!counts.has(kind)) {
        counts.set(kind, 0);
        order.push(kind);
      }
      counts.set(kind, counts.get(kind) + 1);
    });

    return order
      .map((kind) => {
        const count = counts.get(kind);
        const name = typeName(kind);
        return count === 1 ? name : `${count} ${pluralTypeName(name)}`;
      })
      .join(', ');
  }

  /** The day an override was saved, as the page writes dates. */
  function savedOnText(savedAt) {
    const when = new Date(savedAt);
    if (Number.isNaN(when.getTime())) {
      return null;
    }

    return when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /**
   * What the Device type section says about a device before anything can be changed: what it is
   * published as, where that came from, and which hardware the answer belongs to.
   *
   * `panels` sit above the rows and describe something that has gone wrong with this node's
   * type. `notices` sit below them and say why nothing here can be edited.
   */
  function describeTypePanel(payload) {
    const data = payload || {};
    const rows = [];
    const panels = [];
    const notices = [];
    const failed = data.rebuildFailure ? true : false;
    const override = data.override || null;

    if (failed) {
      /**
       * The page knows the named type is not what HomeKit publishes, so the row is relabeled
       * rather than left saying "Published as". Neither panel carries the error text: that
       * reached the reader in the toast that reported the failure, and the log keeps it.
       */
      panels.push(
        override
          ? {
              severity: 'warning',
              heading: 'The saved type has not been applied.',
              body: `${typeName(override.primaryKind)} is saved for this hardware, but HomeKit could not update this device. Restart Homebridge to try again. Check the Homebridge log for details.`,
            }
          : {
              severity: 'warning',
              heading: 'The default type has not been restored.',
              body: `${typeName(data.defaultKind)} is the default for this device, but HomeKit could not restore it. Restart Homebridge to try again. Check the Homebridge log for details.`,
            },
      );
    }

    const publishedLabel = failed ? (override ? 'Saved type' : 'Default type') : 'Published as';
    const published = data.multiEndpoint
      ? listEndpointTypes(data.endpointTypes)
      : data.primaryKind
        ? typeName(data.primaryKind)
        : '';

    if (data.fingerprint && published) {
      rows.push({
        label: publishedLabel,
        value: published,
        chip: lookup(TYPE_SOURCE_CHIPS, data.source) || null,
      });

      if (data.source === 'override' && override) {
        const savedOn = savedOnText(override.savedAt);
        rows.push({
          label: 'Source',
          value: savedOn ? `Your override, saved ${savedOn}` : 'Your override',
          detail: data.defaultKind ? `Default for this node: ${typeName(data.defaultKind)}` : null,
        });
      } else if (data.source === 'registry') {
        rows.push({
          label: 'Source',
          value: 'Built-in verified registry',
          detail: data.registryLabel || null,
        });
      } else {
        rows.push({ label: 'Source', value: 'Detected automatically from the device', detail: null });
      }

    }

    if (data.fingerprint) {
      /**
       * The label describes the hardware, not the type, so it is a row for every device that
       * has reported a fingerprint. Dropping it when the device had not sent one took a row
       * away without saying anything had been left out.
       */
      rows.push({ label: 'Device label', value: data.label || 'Not reported', detail: null });
    }

    rows.push(
      data.fingerprint
        ? {
            label: 'Hardware fingerprint',
            hex: [
              hexWord(data.fingerprint.manufacturerId),
              hexWord(data.fingerprint.productType),
              hexWord(data.fingerprint.productId),
            ],
            caption: 'Manufacturer, product type, product',
          }
        : { label: 'Hardware fingerprint', value: 'Not reported yet', detail: null },
    );

    if (!data.fingerprint) {
      notices.push({
        severity: 'info',
        body: "Available once the device's interview has finished.",
      });
    } else if (!published && !data.multiEndpoint) {
      /**
       * An endpoint whose only function is its battery publishes no type, so there is nothing
       * here to change and nothing to name in the rows above.
       */
      notices.push({
        severity: 'info',
        body: 'This device has no HomeKit device type that can be changed.',
      });
    } else if (data.multiEndpoint) {
      notices.push({
        severity: 'info',
        body: 'This device provides multiple independent functions. Type overrides are not available for this kind of device yet.',
      });
    }

    const storeError = data.store && data.store.error ? data.store.error.code : null;
    if (storeError) {
      /**
       * Drawn amber rather than as information, because the plugin and the device are working
       * while saved configuration is being ignored and editing is turned off. No text from the
       * backend is shown; the code chooses the sentence.
       */
      notices.push({
        severity: 'warning',
        heading: STORE_ERROR_HEADING,
        body:
          lookup(STORE_ERROR_BODIES, storeError) || lookup(STORE_ERROR_BODIES, 'unreadable'),
      });
    }

    return { panels, rows, notices };
  }

  const REBUILD_WARNING_ONE =
    'Changing the device type replaces the corresponding HomeKit service on this accessory. Scenes and automations that use the replaced service may need to be set up again.';

  const REBUILD_WARNING_MANY =
    'Changing the device type replaces the corresponding HomeKit service on each affected accessory. Scenes and automations that use the replaced service may need to be set up again.';

  /** Said where neither button can act, so there is no number of accessories to name. */
  const REBUILD_WARNING_NONE =
    'Changing a device type replaces its corresponding HomeKit service. Scenes and automations that use that service may need to be set up again.';

  const WRITE_REFUSALS = {
    'unknown-node': 'This node is no longer in the network. Nothing was changed.',
    'fingerprint-changed': 'This node now reports different hardware. Nothing was changed.',
    'cohort-changed':
      'The devices that share this hardware changed. Nothing was changed. Review the list and try again.',
  };

  const WRITE_REFUSAL_OTHER =
    'The device type could not be changed. Nothing was changed. Review the updated device information.';

  /**
   * What a refused write tells the reader, and whether the node it was about is gone.
   *
   * Only the refusals a reader can act on get a sentence of their own. The rest say the write
   * did not happen and send them back to what the section now reports, because the code names
   * a condition the page has already redrawn itself around. The code goes to the log.
   */
  function describeWriteRefusal(code) {
    return {
      gone: code === 'unknown-node',
      text: lookup(WRITE_REFUSALS, code) || WRITE_REFUSAL_OTHER,
    };
  }

  /** How a type reads in the select when it is one of the two the device already knows about. */
  function selectOptionLabel(kind, role, defaultSource) {
    const name = typeName(kind);

    if (role === 'override') {
      return `${name} (your override)`;
    }
    if (role === 'default') {
      return defaultSource === 'registry' ? `${name} (verified default)` : `${name} (detected default)`;
    }

    return name;
  }

  /**
   * Everything the Device type section offers once a type can be chosen: who the choice
   * reaches, the list to choose from, and what each button would do.
   *
   * `draft` is the type the reader has selected and has not yet applied. It is passed in rather
   * than read from the payload, so a refresh arriving mid-decision replaces what the plugin
   * reports without touching what the reader has chosen.
   */
  function describeTypeForm(payload, draft) {
    const data = payload || {};
    const cohortMembers = Array.isArray(data.cohort) ? data.cohort : [];
    const override = data.override || null;
    const storeError = data.store && data.store.error ? data.store.error.code : null;
    /**
     * An override this device cannot take, which is still applied elsewhere, is managed from
     * the node that has it. Offering the list here would write for a cohort this node is not
     * publishing with.
     */
    const managedElsewhere = Boolean(
      data.invalid &&
        (data.invalid.appliedTo || []).some((node) => node.nodeId !== data.nodeId),
    );

    const editable =
      Boolean(data.fingerprint) &&
      !data.multiEndpoint &&
      !storeError &&
      !managedElsewhere &&
      Boolean(data.primaryKind);

    if (!editable) {
      return {
        cohort: null,
        select: {
          label: 'Publish this device as',
          value: null,
          options: [],
          disabled: true,
          placeholder: 'Not available',
          note: null,
        },
        hint: null,
        warning: null,
        apply: { label: 'Apply', disabled: true, hint: null },
        revert: null,
      };
    }

    const chosen = draft || data.primaryKind;

    /**
     * The types the whole cohort can take. The current type and this node's own default are
     * listed whether or not they are among them, because they are what the device is and what
     * it would go back to, but a type the cohort cannot take is not one to act on: a mixed
     * cohort, or a detection the plugin has since corrected, puts either of them outside it.
     */
    const available = new Set(data.options || []);
    const seen = new Set();
    const options = [];
    const offer = (kind, role) => {
      if (!kind || seen.has(kind)) return;
      seen.add(kind);
      options.push({
        kind,
        label: selectOptionLabel(kind, role, data.defaultSource),
        available: available.has(kind),
      });
    };

    offer(data.primaryKind, data.source === 'override' ? 'override' : 'default');
    offer(data.defaultKind, 'default');
    (data.options || []).forEach((kind) => offer(kind, 'other'));
    /**
     * A refresh can take the chosen type out of the intersection while the reader is deciding.
     * It stays in the list so the choice they made is still the one they see, and it carries
     * the same mark as any other type the cohort cannot take.
     */
    offer(chosen, 'other');

    const changing = cohortMembers.filter((member) => member.primaryKind !== chosen);
    const reverting = cohortMembers.filter(
      (member) => member.defaultKind && member.primaryKind !== member.defaultKind,
    );

    const matchesOverride = Boolean(override) && override.primaryKind === chosen;
    const everyDefault =
      Boolean(override) && cohortMembers.length > 0 && cohortMembers.every((member) => member.defaultKind === chosen);
    const applyDisabled =
      !available.has(chosen) || changing.length === 0 || matchesOverride || everyDefault;

    const defaults = new Set(reverting.map((member) => member.defaultKind));
    const revertCount = reverting.length;

    /**
     * The warning describes what the buttons below it would do, so it counts whichever of them
     * can be pressed. With neither available there is no change to count, and the warning says
     * what changing a type does without naming a number of accessories.
     */
    const changeCount = !applyDisabled ? changing.length : revertCount > 0 ? revertCount : null;

    return {
      cohort: {
        heading: override
          ? 'This override is saved for the hardware, not only for this node.'
          : 'A type chosen here applies to this hardware, not only to this node.',
        count:
          cohortMembers.length === 1
            ? '1 node reports this fingerprint:'
            : `${cohortMembers.length} nodes report this fingerprint:`,
        chips: cohortMembers.map((member) => ({
          nodeId: member.nodeId,
          name: member.name,
          thisNode: member.nodeId === data.nodeId,
          note:
            override && member.takesOverride === false
              ? `(cannot take ${typeName(override.primaryKind)})`
              : null,
        })),
      },
      select: {
        label: 'Publish this device as',
        value: chosen,
        options,
        disabled: false,
        placeholder: null,
        /**
         * Said rather than left to be worked out from a disabled button. Not "no longer":
         * a current type or a default can be one the whole cohort was never able to take.
         */
        note: available.has(chosen)
          ? null
          : 'The selected type is not available for every device with this hardware.',
      },
      hint: 'Other services on this device, such as Battery, are kept as they are.',
      warning:
        changeCount === null
          ? REBUILD_WARNING_NONE
          : changeCount === 1
            ? REBUILD_WARNING_ONE
            : REBUILD_WARNING_MANY,
      apply: {
        label: applyDisabled
          ? 'Apply'
          : `Apply to ${changing.length} ${changing.length === 1 ? 'node' : 'nodes'}`,
        disabled: applyDisabled,
        hint: everyDefault ? 'Use Revert to return to the default type.' : null,
      },
      /**
       * Offered only where it would do something. An override no node in the cohort can take
       * leaves nothing to revert, and the way to be rid of it is to remove the override
       * itself, which the invalid panel offers.
       */
      revert:
        override && revertCount > 0
          ? {
              label:
                defaults.size === 1
                  ? `Revert ${revertCount} ${revertCount === 1 ? 'node' : 'nodes'} to ${typeName([...defaults][0])}`
                  : `Revert ${revertCount} nodes to their default types`,
              disabled: false,
            }
          : null,
    };
  }

  /**
   * The panels that appear above the rows when something about this node's saved override no
   * longer holds. Each describes a state the reader did not ask for and offers the one thing
   * that resolves it.
   */
  function describeTypeExceptions(payload) {
    const data = payload || {};
    const invalid = data.invalid || null;
    const appliedTo = invalid && Array.isArray(invalid.appliedTo) ? invalid.appliedTo : [];
    const elsewhere = appliedTo.filter((node) => node.nodeId !== data.nodeId);

    return {
      invalid: invalid
        ? {
            heading: 'Your saved override cannot be applied to this device',
            /**
             * The closing sentence introduces the list of nodes it is applied to, so it is not
             * said when there is no list: an override applied to nothing is removed, not read
             * about somewhere else.
             */
            /**
             * What the device does instead is not said: a rebuild that failed leaves HomeKit
             * publishing something other than this node's own type, and the panel cannot tell
             * which. What it can say is that the override is not what this node is published
             * as, which is true either way.
             */
            body: `This device reports the same hardware fingerprint, but it cannot take ${typeName(
              invalid.primaryKind,
            )}, so the saved override does not apply here.${
              elsewhere.length > 0 ? ' The override is still applied to:' : ''
            }`,
            chips: elsewhere.map((node) => ({ nodeId: node.nodeId, name: node.name })),
            manage:
              elsewhere.length > 0
                ? {
                    nodeId: elsewhere[0].nodeId,
                    text: `Manage it from Node ${elsewhere[0].nodeId} ${elsewhere[0].name}`,
                  }
                : null,
            remove:
              elsewhere.length === 0
                ? { label: 'Remove saved override', primaryKind: invalid.primaryKind }
                : null,
          }
        : null,
      orphans: (Array.isArray(data.orphans) ? data.orphans : []).map((orphan) => ({
        observationId: orphan.observationId,
        heading: 'A saved override no longer matches this node',
        body: `Node ${data.nodeId} now reports different hardware from the device this override was applied to. Z-Wave reuses node numbers after a device is removed, so this is probably a different device. The override is kept for the earlier hardware and does not apply to this node.`,
        savedFor: {
          title: 'Override saved for',
          hex: orphan.fingerprint
            ? [
                hexWord(orphan.fingerprint.manufacturerId),
                hexWord(orphan.fingerprint.productType),
                hexWord(orphan.fingerprint.productId),
              ]
            : null,
          type: orphan.primaryKind ? typeName(orphan.primaryKind) : null,
          applied: savedOnText(orphan.appliedAt),
        },
        nowReports: {
          title: `Node ${data.nodeId} now reports`,
          hex: data.fingerprint
            ? [
                hexWord(data.fingerprint.manufacturerId),
                hexWord(data.fingerprint.productType),
                hexWord(data.fingerprint.productId),
              ]
            : null,
          type: data.primaryKind ? typeName(data.primaryKind) : null,
        },
        acknowledge: 'Acknowledge hardware change',
        /**
         * The acknowledgment is answered against the fingerprint the node reports now, so
         * there is nothing to send while a re-interview has left it without one. The section
         * already says the interview has to finish first.
         */
        canAcknowledge: Boolean(data.fingerprint),
      })),
    };
  }

  const MATTER_RESTART_LINE =
    'Matter controllers, including Alexa, show the new type after Homebridge restarts.';

  /** "Node 10 Hallway Shade and Node 11 Office Shade", as the dialogs name a set of nodes. */
  function listCohortNodes(members) {
    const named = members.map((member) => `Node ${member.nodeId} ${member.name}`);

    if (named.length <= 1) {
      return named.join('');
    }

    return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  }

  /**
   * What a confirmation dialog says before a type is written.
   *
   * Only the nodes that would change are named: a cohort node already publishing the chosen
   * type is not affected by the write and listing it would overstate what is about to happen.
   */
  function describeTypeWrite(payload, draft, action) {
    const data = payload || {};
    const members = Array.isArray(data.cohort) ? data.cohort : [];

    if (action === 'remove') {
      /**
       * Nothing in HomeKit moves: this is an override no device is publishing, which is the
       * only state the plugin allows it to be removed from.
       */
      return {
        title: 'Remove this saved override?',
        lines: [
          `${typeName(draft)} is no longer applied to any device, so removing it changes nothing in HomeKit.`,
        ],
        warning: null,
        matter: null,
        confirmLabel: 'Remove',
        nodeCount: 0,
      };
    }

    const reverting = action === 'revert';

    const changing = reverting
      ? members.filter((member) => member.defaultKind && member.primaryKind !== member.defaultKind)
      : members.filter((member) => member.primaryKind !== draft);

    const toKind = (member) => (reverting ? member.defaultKind : draft);
    const sameFrom = new Set(changing.map((member) => member.primaryKind));
    const sameTo = new Set(changing.map(toKind));

    const lines =
      changing.length > 0 && sameFrom.size === 1 && sameTo.size === 1
        ? [
            `${typeName([...sameFrom][0])} becomes ${typeName([...sameTo][0])} on ${listCohortNodes(changing)}.`,
          ]
        : changing.map(
            (member) =>
              `Node ${member.nodeId} ${member.name}: ${typeName(member.primaryKind)} becomes ${typeName(toKind(member))}`,
          );

    return {
      title: reverting ? 'Revert to the default type?' : 'Change the device type for this hardware?',
      lines,
      warning: changing.length === 1 ? REBUILD_WARNING_ONE : REBUILD_WARNING_MANY,
      /**
       * Asked of the nodes this write would actually rebuild, not of the one whose page is
       * open. A decision reaches every node sharing the fingerprint, so a reader looking at a
       * node Matter does not publish can still be changing one it does, and that device stays
       * as it was in Alexa until Homebridge restarts.
       */
      matter: changing.some((member) => member.matterActive) ? MATTER_RESTART_LINE : null,
      confirmLabel: reverting ? 'Revert' : 'Apply',
      nodeCount: changing.length,
    };
  }

  /**
   * What a write that was accepted, in whole or in part, tells the reader.
   *
   * Each node that HomeKit would not take gets a line of its own carrying its own error, in
   * node order, because two nodes failing for different reasons is two things to know. The
   * nodes are named the way the dialogs name them, which means reading the names out of the
   * cohort the write was composed against.
   *
   * A revert says what a revert did. Nothing was saved by one, so the sentence written for an
   * apply would report a type as saved that had just been cleared.
   */
  function describeWriteOutcome(outcome, kind, cohort, action) {
    if (action === 'remove' || action === 'acknowledge') {
      /**
       * Nothing in HomeKit moves for either, but a reader who asked for something is owed an
       * answer saying it happened, and a panel going away is not one a screen reader reports.
       */
      return {
        type: 'success',
        lines: [
          action === 'remove' ? 'Saved override removed.' : 'Hardware change acknowledged.',
        ],
      };
    }

    const result = outcome || {};
    const failed = Array.isArray(result.failed) ? result.failed : [];
    const rebuilt = Array.isArray(result.rebuilt) ? result.rebuilt : [];
    const members = Array.isArray(cohort) ? cohort : [];

    if (failed.length > 0) {
      const nameOf = (nodeId) => {
        const member = members.find((candidate) => candidate.nodeId === nodeId);
        return member && member.name ? `Node ${nodeId} ${member.name}` : `Node ${nodeId}`;
      };

      return {
        type: 'error',
        lines: [...failed]
          .sort((left, right) => left.nodeId - right.nodeId)
          .map((entry) =>
            action === 'revert'
              ? `The override was removed, but HomeKit could not restore the default type on ${nameOf(
                  entry.nodeId,
                )}: ${entry.error}. Restart Homebridge to try again.`
              : `${typeName(kind)} was saved for this hardware, but HomeKit could not update ${nameOf(
                  entry.nodeId,
                )}: ${entry.error}. Restart Homebridge to try again.`,
          ),
      };
    }

    return {
      type: 'success',
      lines: [
        `Device type changed on ${rebuilt.length} ${rebuilt.length === 1 ? 'node' : 'nodes'}.`,
      ],
    };
  }

  /**
   * The tab an arrow key moves to, or null for a key the strip does not answer, so the page
   * leaves every other key alone. Both ends wrap, which is what a tab strip does.
   */
  function nextSectionTab(names, current, key) {
    const at = names.indexOf(current);
    if (at === -1) {
      return null;
    }

    if (key === 'ArrowRight') {
      return names[(at + 1) % names.length];
    }
    if (key === 'ArrowLeft') {
      return names[(at - 1 + names.length) % names.length];
    }
    if (key === 'Home') {
      return names[0];
    }
    if (key === 'End') {
      return names[names.length - 1];
    }

    return null;
  }

  /**
   * What the Diagnostics section draws for a node.
   *
   * A failure is reported in place of a stale report rather than beside it. The covering
   * controls are offered only for a covering, and they are disabled while an operation is
   * running, which is how one stays running across a change of tab: the section is drawn from
   * this rather than from what is on screen.
   */
  function describeDiagnosticsSection(state) {
    const current = state || {};

    if (current.error) {
      return { kind: 'error', text: current.error };
    }
    if (!current.report) {
      return { kind: 'loading' };
    }

    const covering = current.covering || {};

    return {
      kind: 'report',
      report: current.report,
      controls: current.report.isWindowCovering
        ? {
            disabled: covering.running === true,
            text: typeof covering.text === 'string' ? covering.text : '',
          }
        : null,
    };
  }

  /**
   * The node a review link points at, or null for any other link. A notice sends a reader to
   * the node it is about, and parsing the target here keeps the page from treating a link it
   * gains later as one of them.
   */
  function nodeIdFromReviewLink(href) {
    const match = /^#node-(\d+)$/.exec(String(href == null ? '' : href));

    return match ? match[1] : null;
  }

  /** The name of every type a device can be published as. A kind is never shown. */
  const TYPE_NAMES = {
    'binary-switch': 'Binary Switch',
    'multilevel-switch': 'Multilevel Switch',
    'color-switch': 'Color Switch',
    'window-covering': 'Window Covering',
    'garage-door': 'Garage Door',
    lock: 'Lock',
    thermostat: 'Thermostat',
    'motion-sensor': 'Motion Sensor',
    'contact-sensor': 'Contact Sensor',
    'leak-sensor': 'Leak Sensor',
    'smoke-sensor': 'Smoke Sensor',
    'carbon-monoxide-sensor': 'Carbon Monoxide Sensor',
    'multilevel-sensor': 'Multilevel Sensor',
    'central-scene': 'Central Scene',
    siren: 'Siren',
  };

  /**
   * A type's name. A kind the table does not know is title-cased rather than shown as it is
   * written, so a type added to the plugin before this table reads as a name either way.
   */
  function typeName(kind) {
    const known = lookup(TYPE_NAMES, kind);
    if (known) {
      return known;
    }

    return String(kind || '')
      .split('-')
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /** "8", "8 and 11", "8, 11 and 12". */
  function listNodeNumbers(nodeIds) {
    const numbers = (nodeIds || []).map(String);
    if (numbers.length <= 1) {
      return numbers.join('');
    }

    return numbers.slice(0, -1).join(', ') + ' and ' + numbers[numbers.length - 1];
  }

  /**
   * What a node's row says about the type it is published as. Each one is its own sentence,
   * because a node can be behind a decision, carrying one that does not fit, and holding a
   * record of hardware that changed, all at once.
   */
  function describeTypeNotices(node) {
    const notices = [];
    const review = { href: `#node-${node.nodeId}`, text: 'Review' };

    if (node.typeInvalid) {
      notices.push({
        severity: 'warning',
        text: 'Saved type override cannot be applied to this device',
        link: review,
      });
    }

    if (node.typeOrphans === 1) {
      notices.push({
        severity: 'warning',
        text: 'A saved type override no longer matches this node',
        link: review,
      });
    } else if (node.typeOrphans > 1) {
      notices.push({
        severity: 'warning',
        text: `${node.typeOrphans} saved type overrides no longer match this node`,
        link: review,
      });
    }

    /**
     * The warning names the type this node should be publishing. With an override applied to
     * it that is the override's type. Without one the node belongs on its default, whether
     * because the override was reverted or because this node cannot take it, and the default
     * needs no naming here: the node's own page names it.
     */
    if (node.typeRebuildFailed) {
      notices.push(
        node.typeOverride
          ? {
              severity: 'warning',
              text: `${typeName(node.typeOverride.primaryKind)} is saved for this hardware but is not published here`,
              link: review,
            }
          : {
              severity: 'warning',
              text: 'The default device type could not be restored',
              link: review,
            },
      );
    }

    if (node.typeOverride) {
      const shared = node.typeOverride.sharedWith || [];
      const also =
        shared.length === 0
          ? ''
          : ` (also applies to ${shared.length === 1 ? 'Node' : 'Nodes'} ${listNodeNumbers(shared)})`;
      notices.push({
        severity: 'info',
        text: `${typeName(node.typeOverride.primaryKind)}, overridden for this hardware${also}`,
        link: null,
      });
    }

    return notices;
  }

  /**
   * The sentences shown under a node row, in the order they are to be read. Checking and
   * starting say nothing, because the spinner in the action cell already says it. The text is
   * unescaped; the caller escapes it where it is written into markup.
   */
  function describeNodeNotices(node, firmwareState) {
    const state = firmwareState || { name: 'idle' };
    const notices = [];
    const add = (notice) => {
      if (notice) {
        notices.push({
          severity: notice.severity,
          text: notice.text,
          link: notice.link || null,
        });
      }
    };

    add(lookup(REFRESH_NOTICES, node && node.refreshState));
    add(lookup(HOMEKIT_NOTICES, node && node.homekitState));

    if (state.name === 'available') {
      add({ severity: 'info', text: `Firmware update available: v${state.version}` });
    } else {
      add(lookup(FIRMWARE_NOTICES, state.name));
    }

    describeTypeNotices(node || {}).forEach(add);

    return notices.sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
  }

  function buildPluginConfig(currentConfig, formValues) {
    const securityKeys = normalizeSecurityKeys(formValues.securityKeys || {});
    const invalidSecurityKeyFields = getInvalidSecurityKeyFields(securityKeys);
    const anySecurityKeysEntered = Object.values(securityKeys).some(Boolean);

    const newConfig = {
      ...currentConfig,
      name: formValues.name,
      platform: 'ZWaveUSB',
      serialPort: formValues.serialPort,
      inclusionTimeoutSeconds: formValues.inclusionTimeoutSeconds,
      debug: formValues.debug,
      healIncludesSleepingDevices: formValues.healIncludesSleepingDevices,
    };

    if (!anySecurityKeysEntered) {
      delete newConfig.securityKeys;
    } else if (invalidSecurityKeyFields.length === 0) {
      newConfig.securityKeys = securityKeys;
    } else if (currentConfig.securityKeys) {
      newConfig.securityKeys = currentConfig.securityKeys;
    } else {
      delete newConfig.securityKeys;
    }

    return {
      config: newConfig,
      normalizedSecurityKeys: securityKeys,
      invalidSecurityKeyFields,
    };
  }

  /** What the Parameters section says where there is nothing to list, one wording per reason. */
  const PARAMETER_STATES = {
    interviewing: "Available once the device's interview has finished.",
    unsupported: 'This device does not expose configuration parameters.',
    none: 'This device supports configuration, but no parameters are available.',
  };

  /**
   * The marks a value can carry, in the order they are shown, each with the sentence that says
   * what it means and the weight the section gives it.
   *
   * Read-only and Not readable are different facts about different directions: one cannot be
   * changed, the other is never reported. A device can carry either, both, or neither.
   *
   * The tone separates what a reader should know from what a reader has to act on. A parameter
   * that can erase the device's settings, or leave it needing to be excluded and re-included,
   * is not the same kind of fact as one meant for advanced users, and marks that all looked
   * alike would leave the two that matter to be found by reading.
   */
  const PARAMETER_MARKS = [
    {
      label: 'Advanced',
      tone: 'neutral',
      explanation: 'This setting is intended for advanced users.',
      holds: (value) => value.advanced === true,
    },
    {
      label: 'Read-only',
      tone: 'neutral',
      explanation: 'This parameter cannot be changed.',
      holds: (value) => value.writable === false,
    },
    {
      label: 'Not readable',
      tone: 'neutral',
      explanation: 'The device does not report a current value for this parameter.',
      holds: (value) => value.readable === false,
    },
    {
      label: 'Destructive',
      tone: 'danger',
      explanation: 'Changing this parameter may reset or erase device settings.',
      holds: (value) => value.destructive === true,
    },
    {
      label: 'Requires re-inclusion',
      tone: 'caution',
      explanation:
        'Changing this parameter may require excluding and re-including the device.',
      holds: (value) => value.requiresReInclusion === true,
    },
  ];

  /** The one name a value is known by across a payload and the refresh that asked about it. */
  function parameterValueKey(endpoint, parameter, bitMask) {
    return `${endpoint}:${parameter}:${bitMask === null || bitMask === undefined ? '' : bitMask}`;
  }

  /** "30 seconds" where the metadata names a unit, "30" where it does not. */
  function withParameterUnit(text, unit) {
    return unit ? `${text} ${unit}` : text;
  }

  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

  /** "1 byte", "2 bytes". */
  function parameterSizeText(valueSize) {
    if (!isNumber(valueSize)) {
      return null;
    }

    return valueSize === 1 ? '1 byte' : `${valueSize} bytes`;
  }

  /**
   * A permitted set as the device describes it: single values and ranges, with a range's step
   * kept rather than flattened into the numbers it would produce, which for a wide range would
   * be a list no one could read.
   *
   * Each entry carries the parameter's unit, as every other number in the section does. A
   * permitted set is read against the value above it, and numbers stated without the unit that
   * one carries would be read as a different quantity.
   */
  function allowedValuesText(allowed, unit) {
    if (!Array.isArray(allowed) || allowed.length === 0) {
      return null;
    }

    const parts = allowed
      .map((entry) => {
        if (entry.kind === 'value') {
          return withParameterUnit(String(entry.value), unit);
        }
        const span = withParameterUnit(`${entry.from} to ${entry.to}`, unit);

        return isNumber(entry.step) && entry.step !== 1 ? `${span} in steps of ${entry.step}` : span;
      })
      .filter(Boolean);

    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** "Oct 30, 2026 at 7:05 AM", or none where there is no moment to name. */
  function parameterMomentText(at) {
    const when = isNumber(at) ? new Date(at) : null;
    if (!when || Number.isNaN(when.getTime())) {
      return null;
    }

    const date = when.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    return `${date} at ${when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }

  /**
   * When the device last reported a value.
   *
   * A value it does not report has no time to show and is not said to be missing one: the mark
   * already says the device never reports it, and a line about the time beside that would read
   * as a fault rather than as how the parameter is defined.
   */
  function parameterReportedText(value) {
    if (value.readable === false) {
      return null;
    }

    const moment = parameterMomentText(value.reportedAt);

    return moment ? `Last reported ${moment}` : 'Last report time unavailable';
  }

  /**
   * What one value is set to.
   *
   * Where the metadata names the number, the name is shown and the number is kept beside it: the
   * name is what the setting means, and the number is what a manual, another controller and the
   * device itself all speak in.
   */
  function parameterValueText(value) {
    if (!isNumber(value.value)) {
      return { text: 'Not reported', raw: null };
    }

    const named = value.states ? lookup(value.states, String(value.value)) : undefined;
    if (named) {
      return { text: String(named), raw: String(value.value) };
    }

    return { text: withParameterUnit(String(value.value), value.unit), raw: null };
  }

  /** The rows under a value, each one left out where the metadata does not have it. */
  function parameterDetailRows(value) {
    const rows = [];
    const add = (label, text) => {
      if (text !== null && text !== undefined && text !== '') rows.push({ label, value: text });
    };

    const range =
      isNumber(value.min) && isNumber(value.max)
        ? withParameterUnit(`${value.min} to ${value.max}`, value.unit)
        : null;
    const allowed = allowedValuesText(value.allowed, value.unit);

    add('Default', isNumber(value.defaultValue)
      ? withParameterUnit(String(value.defaultValue), value.unit)
      : null);
    add('Recommended', isNumber(value.recommended)
      ? withParameterUnit(String(value.recommended), value.unit)
      : null);
    add('Range', range);
    /**
     * The permitted set goes only where it is the range written out a second time, which is what
     * a device reporting both as the same bounds produces. Two rows saying the identical thing
     * read as two facts, and a reader comparing them has to check that they agree.
     *
     * Compared as the reader would see them, unit and all: a set that steps through the range, or
     * that names anything the range does not, says something the range does not say and stays.
     * Nothing is dropped from the payload, which item 16 writes against.
     */
    add('Allowed values', allowed === range ? null : allowed);
    add('Size', parameterSizeText(value.valueSize));

    return rows;
  }

  /**
   * One value of a group, as the section draws it.
   *
   * Only a partial carries a label. The fields of one parameter are separate settings sharing a
   * number, and one with no label of its own is named by the bits it occupies, which is the only
   * thing that tells it apart from its siblings. An ordinary value is the parameter, and its
   * label belongs to the group: carried here as well it would be written twice, once under the
   * other.
   */
  /**
   * The most values a list may hold before a reader is better served by typing one.
   *
   * A device can permit tens of thousands of numbers. A list of them is not a choice, it is a
   * scroll, and the number field beside it says the same thing in one line.
   */
  const PARAMETER_CHOICE_LIMIT = 24;

  /** Every number a permitted set names outright, or none where it describes a span instead. */
  function enumerated(allowed) {
    if (!Array.isArray(allowed)) {
      return null;
    }

    const numbers = [];

    for (const entry of allowed) {
      if (entry.kind === 'value') {
        numbers.push(entry.value);
        continue;
      }

      const step = isNumber(entry.step) && entry.step > 1 ? entry.step : 1;
      const count = Math.floor((entry.to - entry.from) / step) + 1;

      if (!isNumber(count) || count < 1 || numbers.length + count > PARAMETER_CHOICE_LIMIT) {
        return null;
      }
      for (let at = entry.from; at <= entry.to; at += step) {
        numbers.push(at);
      }
    }

    return numbers.length > 0 && numbers.length <= PARAMETER_CHOICE_LIMIT ? numbers : null;
  }

  /**
   * How a reader changes one value, or none where they may not.
   *
   * A device that names its values is offered them by name; one that permits a short set of
   * numbers is offered those; anything wider is typed into a field bounded by what the metadata
   * states. A device that forbids typing is never given a field, whatever the set looks like:
   * the list is the whole of what it will take.
   *
   * The editor describes only what the device permits. Whether the value may be written at all,
   * and whether this particular number is one it would accept, are settled again by the plugin
   * before anything reaches the network.
   */
  function describeParameterEditor(value) {
    if (value.writable === false) {
      return null;
    }

    const stated = Array.isArray(value.allowed);

    /**
     * A set the device stated and nobody could read permits nothing at all, and the plugin
     * refuses every number against it. Offering a field there would invite a reader to type
     * something that could only ever be turned away.
     */
    if (stated && value.allowed.length === 0) {
      return null;
    }

    const names = value.states
      ? Object.keys(value.states)
          .map((key) => Number(key))
          .filter((one) => isNumber(one))
      : [];
    const current = isNumber(value.value) ? value.value : null;
    const permitted = enumerated(value.allowed);
    const labelFor = (one) => {
      const named = value.states ? lookup(value.states, String(one)) : undefined;

      return named ? String(named) : withParameterUnit(String(one), value.unit);
    };

    /**
     * A list is offered only where the numbers in it are the whole of what the device permits:
     * a permitted set says so outright, and so do named states where the device forbids typing.
     * Named states beside a free field do not, since a number nobody named is still permitted,
     * and listing only the named ones would hide the rest.
     *
     * Every rule the route applies is applied to that list together. A number the device permits
     * but never named, or one outside the range it states, or one too large for the bits it is
     * written into, is a change the plugin refuses, and offering it would be offering a change
     * that cannot happen.
     */
    const typing = value.allowManualEntry !== false;
    const bounds = parameterBounds(value);
    /**
     * A field whose ends have crossed describes nothing a device would take. Metadata can state
     * a range in the wrong order, and a coherent range can still fall outside what the size it
     * is encoded in can hold, which leaves no number between the ends to offer.
     */
    const field = (over) =>
      isNumber(over.min) && isNumber(over.max) && over.min > over.max
        ? null
        : Object.assign({ kind: 'number', current, unit: value.unit || null }, over);
    const choice = (numbers) =>
      numbers.length > 0
        ? {
            kind: 'choice',
            current,
            options: numbers.map((one) => ({ value: one, label: labelFor(one) })),
          }
        : null;

    /**
     * Both rules at once, as the route applies them. A device can state a permitted set and
     * also forbid typing, and then only the numbers it both permits and named may be written:
     * offering one it permits but never named would be offering a change the plugin refuses.
     */
    const offerable = (numbers) =>
      numbers.filter(
        (one) => withinBounds(one, bounds) && (typing || names.includes(one)),
      );

    if (permitted) {
      return choice(offerable(permitted));
    }

    if (!typing) {
      // Nothing may be typed, so only a list can serve. A set too long to show leaves nothing
      // that could be offered, and a set the device stated has already overruled its names.
      return stated || names.length > PARAMETER_CHOICE_LIMIT ? null : choice(offerable(names));
    }

    const ranges = stated ? value.allowed.filter((entry) => entry.kind === 'range') : [];
    const span = stated && ranges.length === 1 && ranges.length === value.allowed.length
      ? ranges[0]
      : null;

    if (span) {
      /**
       * One span is exactly what a field says, bounds and step and all. Narrowing it moves the
       * ends onto the sequence rather than wherever the other bounds fall: a span counting by
       * five from ten permits fifteen and not seventeen, and a field starting at twelve would
       * count from twelve and offer exactly the numbers the route refuses. The span itself is
       * carried as well, so what is typed is held to the device's own arithmetic.
       */
      const step = isNumber(span.step) && span.step > 1 ? span.step : 1;
      const floor = isNumber(bounds.min) ? Math.max(span.from, bounds.min) : span.from;
      const ceiling = isNumber(bounds.max) ? Math.min(span.to, bounds.max) : span.to;

      return field({
        min: span.from + Math.ceil((floor - span.from) / step) * step,
        max: span.from + Math.floor((ceiling - span.from) / step) * step,
        step,
        constrained: false,
        permits: value.allowed,
      });
    }

    if (stated) {
      /**
       * A set too long to list and not one span. A field cannot describe it: it would invite
       * every number between its ends, and the device permits only some of them. It is bounded
       * by the set's own ends, which is tighter than the metadata's range, and marked so the
       * page can say that not every number in it will be taken.
       */
      const ends = value.allowed.flatMap((entry) =>
        entry.kind === 'value' ? [entry.value] : [entry.from, entry.to],
      );

      return field({
        min: isNumber(bounds.min) ? Math.max(Math.min(...ends), bounds.min) : Math.min(...ends),
        max: isNumber(bounds.max) ? Math.min(Math.max(...ends), bounds.max) : Math.max(...ends),
        step: 1,
        constrained: true,
        /** The set itself, so what is typed can be held to it before anything is asked of it. */
        permits: value.allowed,
      });
    }

    return field({ min: bounds.min, max: bounds.max, step: 1, constrained: false });
  }

  /** zwave-js's signed integer format, which is also what it assumes where none is stated. */
  const PARAMETER_SIGNED = 0;

  /**
   * The numbers a value can hold at all, before anything the device says it permits.
   *
   * A whole parameter is bounded by the size and format it is encoded in. A field is bounded by
   * the bits it occupies instead, because the driver shifts the value into them and a number too
   * large would be truncated there and silently mean something else. A field of more than one bit
   * is signed unless the metadata says otherwise, which is the rule the driver reads it by.
   */
  function encodedLimits(value) {
    const signed = (width) =>
      value.format === null || value.format === undefined || value.format === PARAMETER_SIGNED
        ? width > 1
        : false;

    if (isNumber(value.bitMask)) {
      const shift = value.bitMask & -value.bitMask;
      const span = Math.floor(value.bitMask / shift);
      const width = span.toString(2).length;

      return signed(width)
        ? { min: -(2 ** (width - 1)), max: 2 ** (width - 1) - 1 }
        : { min: 0, max: span };
    }

    if (!isNumber(value.valueSize) || value.valueSize < 1 || value.valueSize > 4) {
      return null;
    }

    const bits = value.valueSize * 8;

    return signed(bits)
      ? { min: -(2 ** (bits - 1)), max: 2 ** (bits - 1) - 1 }
      : { min: 0, max: 2 ** bits - 1 };
  }

  /**
   * Everything that bounds a value at once: what the metadata states, and what it can be encoded
   * in. The route applies both, so the page has to offer both or it offers changes that will be
   * turned away.
   */
  function parameterBounds(value) {
    const encoded = encodedLimits(value);
    const floors = [value.min, encoded && encoded.min].filter(isNumber);
    const ceilings = [value.max, encoded && encoded.max].filter(isNumber);

    return {
      min: floors.length > 0 ? Math.max(...floors) : null,
      max: ceilings.length > 0 ? Math.min(...ceilings) : null,
    };
  }

  const withinBounds = (number, bounds) =>
    (!isNumber(bounds.min) || number >= bounds.min) && (!isNumber(bounds.max) || number <= bounds.max);

  /**
   * Whether a permitted set takes this number.
   *
   * This mirrors the rule the route applies and does not replace it: the route reads the device's
   * live metadata and is the only thing that decides. It is here so the page can refuse a number
   * before asking a reader to confirm a change that was never going to be sent.
   */
  function permittedBy(number, allowed) {
    return allowed.some((entry) => {
      if (entry.kind === 'value') {
        return entry.value === number;
      }
      if (
        !Number.isInteger(entry.from) ||
        !Number.isInteger(entry.to) ||
        entry.from > entry.to ||
        number < entry.from ||
        number > entry.to
      ) {
        return false;
      }
      if (entry.step === null || entry.step === undefined || entry.step === 1) {
        return true;
      }
      if (!Number.isInteger(entry.step) || entry.step < 1) {
        return false;
      }

      return (number - entry.from) % entry.step === 0;
    });
  }

  /** Whether what the reader chose or typed is something the device would take. */
  function parameterAccepts(editor, number) {
    if (!editor || !Number.isInteger(number)) {
      return false;
    }
    if (editor.kind === 'choice') {
      return editor.options.some((option) => option.value === number);
    }
    if (
      (isNumber(editor.min) && number < editor.min) ||
      (isNumber(editor.max) && number > editor.max)
    ) {
      return false;
    }
    return editor.permits ? permittedBy(number, editor.permits) : true;
  }

  /** What a change asks the reader to agree to before it is sent, or none where it asks nothing. */
  function describeParameterRisks(value) {
    const risks = [];

    if (value.destructive === true) {
      risks.push({ kind: 'destructive', explanation: 'may reset or erase its settings' });
    }
    if (value.requiresReInclusion === true) {
      risks.push({
        kind: 'requiresReInclusion',
        explanation: 'may stop it working until it is excluded and re-included',
      });
    }

    return risks;
  }

  /**
   * Whether changing one field of this parameter would leave the others as the device has them.
   *
   * The driver builds a partial write from the cached values of the sibling fields, starting at
   * zero, so a field it holds no value for contributes nothing and so do the bits no field
   * describes. The route refuses such a change; the page does not offer it, and says why.
   */
  function groupComposes(group) {
    const values = group.values || [];

    return (
      group.raw !== null &&
      group.raw !== undefined &&
      values.length > 0 &&
      values.every((one) => isNumber(one.value) && isNumber(one.reportedAt))
    );
  }

  /**
   * What a change is doing, in the reader's terms rather than the plugin's.
   *
   * `sent` is where a change to a write-only parameter ends. Nothing will report the new value,
   * so the sentence says why no confirmation is coming rather than leaving the reader waiting
   * for one, and an unconfirmed change, which is a change that should have been reported and
   * was not, keeps its own sentence.
   */
  const PARAMETER_WRITE_SENTENCES = {
    queued: 'Queued. The change will be sent when the device wakes.',
    sending: 'Sending the new value to the device.',
    working: 'The device accepted the change and is still applying it.',
    confirming: 'Sent. Waiting for the device to report the new value.',
    sent: 'Sent. This parameter does not report a value, so the change cannot be confirmed here.',
    unconfirmed: 'The device did not report this value back. It may not have applied the change.',
  };

  /** Why a change that did reach the driver was turned away, which the plugin tells apart. */
  const PARAMETER_WRITE_FAILURES = {
    'send-failed': 'The change could not be sent to the device.',
    'device-rejected': 'The device rejected this change.',
  };

  /**
   * How each ending reads. A change in flight is neither good news nor bad and says so in the
   * muted color the rest of the section uses.
   */
  const PARAMETER_WRITE_TONES = {
    different: 'caution',
    unconfirmed: 'caution',
    refused: 'danger',
  };

  /** Said where the plugin reports something this page has no sentence for. */
  const PARAMETER_WRITE_UNKNOWN = 'This change was not made.';

  /**
   * Why a change was not begun at all.
   *
   * Several of these the page cannot provoke while its metadata is current: it offers no control
   * on a read-only value, no field where typing is forbidden, and no change at all without the
   * acknowledgment the value asks for. They are answered anyway, because the metadata the page
   * is holding can be older than the metadata the route reads.
   */
  const PARAMETER_REFUSALS = {
    'not-writable': 'This parameter cannot be changed.',
    'not-permitted': 'Choose one of the values this device permits.',
    'manual-entry-forbidden': 'Choose one of the values this device permits.',
    'partial-incomplete':
      'Some fields in this parameter have not been reported. Changing one could overwrite the ' +
      'others, so re-read the values first.',
    'definition-changed': 'This parameter changed while the page was open. Review it and try again.',
    'needs-acknowledgment': 'This change now needs confirmation. Review the warning and try again.',
    'no-identity': 'Reload the page and try again.',
    'wrong-device':
      'The device changed while this page was open. Return to the node list and open it again.',
    busy: 'Another setting change is still in progress for this device.',
    'busy-rereading': 'Wait for the current re-read to finish before changing a value.',
  };

  /**
   * Why the re-read control is refused rather than removed while a change is in flight.
   *
   * Only the states the plugin suppresses a re-read in are here. Once a change is being
   * confirmed the Set is out and further Gets can only help, so nothing blocks the control.
   */
  const PARAMETER_REREAD_BLOCKS = {
    queued: 'Wait for the current setting change to be sent before re-reading values.',
    sending: 'Wait for the current setting change to be sent before re-reading values.',
    working:
      'Wait for the device to finish applying the current setting change before re-reading values.',
  };

  /** The one sentence a field that cannot take every number between its ends adds. */
  const PARAMETER_CONSTRAINED_NOTE = 'Only the permitted values shown above can be saved.';

  /**
   * The change this node has in hand, where it belongs to this value and nowhere else.
   *
   * A parameter's other fields are not being changed, and a sentence under them would say they
   * were, so the write is matched to the one value it names before anything is said about it.
   */
  function describeParameterWrite(write, group, value) {
    const mask = (one) => (isNumber(one) ? one : null);
    if (
      !write ||
      write.state === 'idle' ||
      write.endpoint !== group.endpoint ||
      write.parameter !== group.parameter ||
      mask(write.bitMask) !== mask(value.bitMask)
    ) {
      return null;
    }

    const said = (text) => ({
      state: write.state,
      text,
      tone: lookup(PARAMETER_WRITE_TONES, write.state) || 'neutral',
    });

    if (write.state === 'confirmed') {
      const when = parameterMomentText(write.settledAt);

      return said(
        when ? `The device confirmed this value on ${when}.` : 'The device confirmed this value.',
      );
    }

    /**
     * A different number is worth reporting only where there is one. A state saying the device
     * answered with another value and carrying no value is a state that cannot be read, so it
     * falls back to the sentence for a change nothing confirmed.
     */
    if (write.state === 'different') {
      return said(
        isNumber(write.reported)
          ? `The device reported a different value: ${withParameterUnit(
              String(write.reported),
              value.unit,
            )}.`
          : PARAMETER_WRITE_SENTENCES.unconfirmed,
      );
    }

    if (write.state === 'refused') {
      return said(lookup(PARAMETER_WRITE_FAILURES, write.code) || PARAMETER_WRITE_UNKNOWN);
    }

    return said(lookup(PARAMETER_WRITE_SENTENCES, write.state) || PARAMETER_WRITE_UNKNOWN);
  }

  /**
   * The answer to the request just made, which is not the same thing as the change the node has
   * in hand: a change refused because another one is running is refused by a device that is
   * still running that other one.
   */
  function describeParameterRefusal(code, editor) {
    if (code === 'out-of-range' && editor && isNumber(editor.min) && isNumber(editor.max)) {
      return `Enter a number from ${editor.min} to ${editor.max}.`;
    }
    if (code === 'out-of-range') {
      return PARAMETER_REFUSALS['not-permitted'];
    }

    return lookup(PARAMETER_REFUSALS, code) || PARAMETER_WRITE_UNKNOWN;
  }

  /**
   * What the page makes of what was typed, while it is still being typed.
   *
   * This is the same arithmetic the route applies and does not replace it: the route reads the
   * live metadata and is the only thing that decides. It is here so that a reader is told which
   * number to choose before they ask for one that could only be turned away.
   */
  function describeParameterEntry(editor, text) {
    const typed = String(text === null || text === undefined ? '' : text).trim();
    if (!editor || typed === '') {
      return { kind: 'empty', value: null, text: null };
    }

    const number = Number(typed);
    if (parameterAccepts(editor, number)) {
      return { kind: 'ready', value: number, text: null };
    }

    /**
     * The nearer of the two things that can be wrong. A number the field's own ends exclude is
     * answered by those ends; one they take and the device still refuses is answered by the set.
     */
    const outside =
      editor.kind !== 'choice' &&
      isNumber(editor.min) &&
      isNumber(editor.max) &&
      (!Number.isInteger(number) || number < editor.min || number > editor.max);

    return {
      kind: 'invalid',
      value: null,
      text: outside
        ? `Enter a number from ${editor.min} to ${editor.max}.`
        : PARAMETER_REFUSALS['not-permitted'],
    };
  }

  /**
   * What the reader is asked to agree to before a change is sent, or nothing where the device
   * says the change carries neither risk.
   *
   * Every risk the device states is named, and a parameter carrying both states them on the one
   * subject: what is being changed and what it is on are said once, because naming the device
   * and the parameter twice in two sentences reads as two changes rather than one.
   */
  function describeParameterConfirmation(risks, device, label) {
    const asked = risks || [];
    if (asked.length === 0) {
      return null;
    }

    return {
      action: 'Change it',
      text: `Changing ${label} on ${device} ${asked
        .map((risk) => risk.explanation)
        .join(', and ')}.`,
      destructive: asked.some((risk) => risk.kind === 'destructive'),
      requiresReInclusion: asked.some((risk) => risk.kind === 'requiresReInclusion'),
    };
  }

  function describeParameterField(group, value, waiting, write) {
    const key = parameterValueKey(group.endpoint, group.parameter, value.bitMask);
    const partial = value.bitMask !== null && value.bitMask !== undefined;
    const blocked = partial && !groupComposes(group) ? 'partial-incomplete' : null;
    const editor = blocked ? null : describeParameterEditor(value);
    const bits = partial ? `Bit mask 0x${value.bitMask.toString(16).toUpperCase()}` : null;
    const title = value.label || bits;
    const where = `Parameter ${group.parameter}${
      group.endpoint > 0 ? ` on endpoint ${group.endpoint}` : ''
    }`;
    const marks = PARAMETER_MARKS.filter((mark) => mark.holds(value)).map((mark) => ({
      label: mark.label,
      tone: mark.tone,
      explanation: mark.explanation,
    }));

    return {
      key,
      label: partial ? title : null,
      /** What to call this value in a sentence about it, which is what a reader calls it. */
      name: title || where,
      /**
       * What a control for this value is called where only its name is read out. One number can
       * be a parameter on two endpoints, and one label can be on two fields, so the name carries
       * what tells them apart as well as what a reader would call it.
       */
      editorLabel: title ? `${where}, ${title}` : where,
      description: value.description || null,
      value: parameterValueText(value),
      rows: parameterDetailRows(value),
      marks,
      reportedAt: parameterReportedText(value),
      waiting: waiting.has(key),
      advanced: value.advanced === true,
      editor,
      /** Why no change is offered, where the value itself is not the reason. */
      blocked,
      /** Said where a field cannot describe the set the device permits, and nowhere else. */
      note: editor && editor.constrained ? PARAMETER_CONSTRAINED_NOTE : null,
      /**
       * What a change to this value has to name, carried rather than read back out of the key,
       * and including what the page believes the parameter to be so the route can tell that the
       * definition moved underneath it.
       */
      target: {
        endpoint: group.endpoint,
        parameter: group.parameter,
        bitMask: isNumber(value.bitMask) ? value.bitMask : null,
        valueSize: isNumber(value.valueSize) ? value.valueSize : null,
        format: isNumber(value.format) ? value.format : null,
      },
      risks: describeParameterRisks(value),
      write: describeParameterWrite(write, group, value),
    };
  }

  /**
   * One parameter number on one endpoint. Its fields are the one value it holds, or the several
   * a partial parameter divides it into, and both are drawn inside the one group so that a
   * parameter is never read as several, nor one of its fields as the whole of it.
   */
  function describeParameterGroup(group, waiting, write) {
    const values = group.values || [];
    const fields = values.map((value) => describeParameterField(group, value, waiting, write));

    return {
      key: `${group.endpoint}:${group.parameter}`,
      number: `Parameter ${group.parameter}`,
      parameter: group.parameter,
      label: group.partial ? null : (values[0] && values[0].label) || null,
      endpoint: group.endpoint > 0 ? `Endpoint ${group.endpoint}` : null,
      fields,
    };
  }

  /**
   * Whether a search keeps a group.
   *
   * A match anywhere in a group keeps the whole of it, fields included: a field is part of a
   * parameter, and a group shown with its siblings removed would be a parameter misdescribed.
   */
  function parameterGroupMatches(group, text) {
    const needle = String(text || '').trim().toLowerCase();
    if (!needle) {
      return true;
    }
    if (String(group.parameter).includes(needle)) {
      return true;
    }
    if ((group.label || '').toLowerCase().includes(needle)) {
      return true;
    }

    return group.fields.some(
      (field) =>
        (field.label || '').toLowerCase().includes(needle) ||
        (field.description || '').toLowerCase().includes(needle),
    );
  }

  /**
   * The re-read control and what it says about the attempt.
   *
   * What happened is said first and the control follows it. Whether the device has anything a
   * re-read could confirm decides whether a control is offered at all, and never what the
   * section says: an attempt that is running, or that ended with its values gone, is a thing
   * that happened to this device, and a device with nothing left to ask about is exactly the
   * device that has most to explain.
   *
   * While an attempt is running the control is refused rather than removed, so the reader can
   * see that the thing they asked for is what is happening.
   */
  function describeParametersRefresh(payload) {
    const refresh = (payload && payload.refresh) || {};
    const sleeping = payload && payload.listening === false;
    const label = sleeping ? 'Re-read when it wakes' : 'Re-read values';
    /**
     * A change the plugin is still sending is a change a re-read would read across, so the
     * control is refused rather than removed and says which of the two waits it is in.
     */
    const held = lookup(PARAMETER_REREAD_BLOCKS, ((payload && payload.write) || {}).state) || null;
    /** A control only where one could do something, which is the one thing capability decides. */
    const control = (text, disabled) =>
      refresh.canRequest
        ? { label: text, disabled: Boolean(disabled) || held !== null, note: held }
        : null;

    if (refresh.state === 'dispatching') {
      return {
        button: control(label, true),
        status: sleeping
          ? 'Re-read requested. Values will be confirmed when the device wakes.'
          : 'Waiting for the device to report current values.',
      };
    }

    if (refresh.state === 'incomplete') {
      /**
       * A device that is asleep has not failed to answer, it has not been asked yet, and the
       * control says so rather than offering a retry that would wait on the same sleep.
       */
      return {
        button: control(sleeping ? 'Try re-read when it wakes' : 'Try re-read again'),
        status: 'Some values have not been reported yet.',
      };
    }

    if (refresh.state === 'unavailable') {
      /**
       * Nothing is outstanding and nothing can be: what the refresh asked about is not there
       * any more. Said apart from the values that have yet to answer, because another attempt
       * can bring those and will never bring these.
       */
      return {
        button: control(label),
        status: 'Some values could not be confirmed because they are no longer available.',
      };
    }

    if (refresh.state === 'complete') {
      /**
       * Dated, because what the section is for is how current the values are. A success with no
       * time on it goes on saying the values were re-read for as long as the plugin holds the
       * attempt, and a reader coming back days later would read it as having just happened.
       */
      const when = parameterMomentText(refresh.completedAt);

      return {
        button: control(label),
        status: when ? `Configuration values re-read ${when}.` : 'Configuration values re-read.',
      };
    }

    // Nothing has been asked, so the only thing to say is where nothing can be.
    return refresh.canRequest
      ? { button: control(label), status: null }
      : {
          button: null,
          status: 'This device does not report any configuration values that can be re-read.',
        };
  }

  /**
   * Why there is nothing listed, which is three different things.
   *
   * A search that kept no parameter matched none of them. A search that kept parameters whose
   * every shown field is advanced did match, and saying it did not would be contradicted by the
   * control beside it offering to show what it found. With nothing typed, what is hidden is
   * everything the device reports.
   */
  function parametersEmptyText(listed, matched, search) {
    if (listed > 0) {
      return null;
    }
    if (matched === 0) {
      return 'No parameters match your search.';
    }

    return search.trim()
      ? 'Matching advanced parameters are hidden. Select Show advanced to view them.'
      : 'All parameters reported by this device are marked advanced.';
  }

  /**
   * What the Parameters section draws.
   *
   * The search text and the advanced disclosure are the reader's and are passed in rather than
   * read from the payload, which is replaced underneath them every five seconds while a refresh
   * is running.
   *
   * Advanced parameters are hidden rather than dropped, and a group goes only when every field
   * it would show is advanced: a parameter that mixes ordinary and advanced fields is still a
   * parameter the reader is looking for.
   */
  function describeParametersSection(state) {
    const current = state || {};

    if (current.error) {
      return { kind: 'error', text: current.error };
    }
    if (!current.payload) {
      return { kind: 'loading' };
    }

    const payload = current.payload;
    const stateText = lookup(PARAMETER_STATES, payload.state);
    if (stateText) {
      return { kind: 'empty', text: stateText };
    }

    const waiting = new Set(
      ((payload.refresh && payload.refresh.waiting) || []).map((one) =>
        parameterValueKey(one.endpoint, one.parameter, one.bitMask),
      ),
    );
    const search = String(current.search || '');
    const showAdvanced = current.showAdvanced === true;
    const matched = (payload.groups || [])
      .map((group) => describeParameterGroup(group, waiting, payload.write))
      .filter((group) => parameterGroupMatches(group, search));

    const groups = [];
    matched.forEach((group) => {
      const fields = showAdvanced ? group.fields : group.fields.filter((field) => !field.advanced);
      if (fields.length > 0) {
        groups.push(Object.assign({}, group, { fields }));
      }
    });

    /**
     * Counted across what the search kept rather than across what is on screen, so pressing the
     * control does not change the number written on it.
     */
    const advancedCount = matched.reduce(
      (total, group) => total + group.fields.filter((field) => field.advanced).length,
      0,
    );
    const total = (payload.groups || []).length;

    return {
      kind: 'parameters',
      search: {
        value: search,
        placeholder: 'Search by name or number',
        count: groups.length === total ? null : `Showing ${groups.length} of ${total} parameters`,
      },
      advanced:
        advancedCount > 0
          ? {
              label: `${showAdvanced ? 'Hide' : 'Show'} advanced (${advancedCount})`,
              expanded: showAdvanced,
            }
          : null,
      refresh: describeParametersRefresh(payload),
      groups,
      empty: parametersEmptyText(groups.length, matched.length, search),
    };
  }

  /** The number beside the tab's name, or none where the device has no parameters to count. */
  function parametersTabCount(payload) {
    return payload && payload.state === 'parameters' ? (payload.groups || []).length : null;
  }

  /** Whether the page has reason to keep re-reading: an attempt is running and nothing else. */
  function parametersRefreshRunning(payload) {
    return Boolean(payload && payload.refresh && payload.refresh.state === 'dispatching');
  }

  /**
   * Whether a change is still going somewhere, which is the other reason to keep reading.
   *
   * A change moves through its states on the plugin's own time: nothing the reader does advances
   * it, and a page that stopped reading would leave a change being applied described as one
   * still being sent until something else asked.
   */
  function parametersWriteRunning(payload) {
    const state = payload && payload.write ? payload.write.state : null;

    return (
      state === 'queued' || state === 'sending' || state === 'working' || state === 'confirming'
    );
  }


  return {
    SECURITY_KEY_FIELDS,
    normalizeSecurityKey,
    normalizeSecurityKeys,
    getInvalidSecurityKeyFields,
    describeHealStart,
    healIsRunning,
    escapeHtml,
    formatRssi,
    describeRoute,
    describeCoveringTestResult,
    describeCoveringStopResult,
    renderDiagnostics,
    buildPluginConfig,
    NODE_ICONS,
    firmwareStateOf,
    nextFirmwareRecord,
    describeNodeActions,
    describeFirmwareCell,
    firmwareProgressOf,
    describeNodeNotices,
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
    fingerprintKey,
    describeTypeWrite,
    describeWriteOutcome,
    TYPE_NAMES,
    typeName,
    listNodeNumbers,
    describeParametersSection,
    describeParameterEditor,
    describeParameterEntry,
    describeParameterWrite,
    describeParameterRefusal,
    describeParameterConfirmation,
    parameterAccepts,
    describeParameterRisks,
    describeParametersRefresh,
    describeParameterGroup,
    parameterGroupMatches,
    parameterValueKey,
    parametersTabCount,
    parametersRefreshRunning,
    parametersWriteRunning,
  };
});
