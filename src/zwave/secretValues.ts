import { getCCValues } from 'zwave-js';

/** What stands in for a value the command class definitions mark as a credential. */
export const REDACTED_LOG_VALUE = '[redacted]';

/** The part of a value event that identifies which value it belongs to. */
export interface SecretValueQuery {
  commandClass: number;
  property: string | number;
  propertyKey?: string | number;
}

/**
 * Whether zwave-js treats this value as a credential.
 *
 * The command class definitions are the authority, because a value is marked secret where it is
 * defined rather than in what a device reports. A door lock's keypad codes arrive through User
 * Code as ordinary value events, and that command class marks both the user codes and the admin
 * code secret.
 *
 * Anything the lookup cannot place is answered secret: an unknown command class, a value no
 * definition claims, or a lookup that throws. Withholding a value nobody recognized costs a line
 * of diagnostic detail, while publishing one costs whatever it turns out to have been.
 */
export function isSecretValue(valueId: SecretValueQuery): boolean {
  try {
    const defined = getCCValues(valueId.commandClass);
    if (!defined) {
      return true;
    }

    const match = Object.values(defined).find((value) => value?.is(valueId));
    if (!match) {
      return true;
    }

    return match.options.secret === true;
  } catch {
    return true;
  }
}
