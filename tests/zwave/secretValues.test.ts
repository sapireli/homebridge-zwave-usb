import { CommandClasses } from '@zwave-js/core';
import { isSecretValue, REDACTED_LOG_VALUE } from '../../src/zwave/secretValues';

/**
 * These assertions run against the command class definitions shipped by the installed
 * zwave-js, not against invented metadata. A test that supplied its own secret flag would
 * agree with any implementation, including one that never finds the real one.
 */
describe('isSecretValue', () => {
  const USER_CODE = CommandClasses['User Code'];

  it('marks a keypad code secret', () => {
    expect(isSecretValue({ commandClass: USER_CODE, property: 'userCode', propertyKey: 1 })).toBe(
      true,
    );
    expect(isSecretValue({ commandClass: USER_CODE, property: 'userCode', propertyKey: 42 })).toBe(
      true,
    );
  });

  it('marks the admin code secret', () => {
    expect(isSecretValue({ commandClass: USER_CODE, property: 'adminCode' })).toBe(true);
  });

  it('leaves the rest of User Code diagnosable', () => {
    // Whether a slot is occupied says nothing about what is in it, and zwave-js marks it
    // accordingly. A blanket rule on the command class would lose this.
    expect(
      isSecretValue({ commandClass: USER_CODE, property: 'userIdStatus', propertyKey: 1 }),
    ).toBe(false);
  });

  it('leaves ordinary device values alone', () => {
    expect(
      isSecretValue({ commandClass: CommandClasses['Binary Switch'], property: 'currentValue' }),
    ).toBe(false);
    expect(
      isSecretValue({ commandClass: CommandClasses['Multilevel Switch'], property: 'targetValue' }),
    ).toBe(false);
    expect(
      isSecretValue({
        commandClass: CommandClasses['Thermostat Setpoint'],
        property: 'setpoint',
        propertyKey: 1,
      }),
    ).toBe(false);
  });

  it('withholds a value from a command class it does not know', () => {
    expect(isSecretValue({ commandClass: 0xff, property: 'anything' })).toBe(true);
  });

  it('withholds a value no definition claims', () => {
    // The command class is known and the property is not. Nothing establishes that this is
    // harmless, so it is not published.
    expect(
      isSecretValue({ commandClass: CommandClasses['Binary Switch'], property: 'notARealValue' }),
    ).toBe(true);
  });

  it('is the string the payload substitutes', () => {
    expect(REDACTED_LOG_VALUE).toBe('[redacted]');
  });
});

describe('isSecretValue when the lookup fails', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('withholds the value', () => {
    // Whatever the reason the definitions cannot be consulted, the answer is the safe one.
    // Without this, a future change to how they are resolved would start publishing values.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zwaveJs = require('zwave-js');
    jest.spyOn(zwaveJs, 'getCCValues').mockImplementation(() => {
      throw new Error('definitions unavailable');
    });

    const ordinary = {
      commandClass: CommandClasses['Binary Switch'],
      property: 'currentValue',
    };

    // The same value reads as ordinary when the lookup works, so this is the lookup failing
    // and not the value being secret.
    expect(isSecretValue(ordinary)).toBe(true);

    jest.restoreAllMocks();
    expect(isSecretValue(ordinary)).toBe(false);
  });
});
