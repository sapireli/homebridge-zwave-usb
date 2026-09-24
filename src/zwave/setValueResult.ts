import { SetValueResult, SetValueStatus, setValueFailed } from 'zwave-js';

export interface SetValueOutcome {
  /** The driver either delivered the command or is still working on it. */
  accepted: boolean;
  /** Human-readable status for logs. */
  description: string;
}

/**
 * `node.setValue` resolves even when the driver refused to send the command, so the status has
 * to be inspected before HomeKit is told that a write succeeded.
 *
 * Classification uses the driver's own `setValueFailed`, which enumerates the failure statuses
 * and treats everything else as accepted. A status this plugin has never heard of therefore
 * counts as success rather than turning a working write into a HomeKit error.
 *
 * This only covers delivery. A device that acknowledges a frame at the transport layer and then
 * ignores its contents still yields a successful status, so a write that the device quietly
 * disregards can only be caught afterwards by comparing its reported state against the command.
 */
export function describeSetValueResult(result: SetValueResult | undefined): SetValueOutcome {
  if (!result || typeof result.status !== 'number') {
    return { accepted: true, description: 'driver reported no status' };
  }

  const name = SetValueStatus[result.status] ?? `status ${result.status}`;

  if (!setValueFailed(result)) {
    return { accepted: true, description: name };
  }

  return {
    accepted: false,
    description: result.message ? `${name} (${result.message})` : name,
  };
}
