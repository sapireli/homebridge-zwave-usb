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
          A route's ACK RSSI and the average ACK RSSI show the signal strength of acknowledgement
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
      return `${ended}. ${sent}, and the covering never reported moving afterwards, so nothing was established. Start a move first, then stop it part way.`;
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
  };
});
