import { SetValueStatus } from 'zwave-js';
import { describeSetValueResult } from '../../src/zwave/setValueResult';

describe('describeSetValueResult', () => {
  it('accepts a delivered command', () => {
    expect(describeSetValueResult({ status: SetValueStatus.Success })).toEqual({
      accepted: true,
      description: 'Success',
    });
  });

  it('accepts an unsupervised command, which reports no confirmation', () => {
    expect(describeSetValueResult({ status: SetValueStatus.SuccessUnsupervised }).accepted).toBe(
      true,
    );
  });

  it('accepts a command the driver is still working on', () => {
    expect(describeSetValueResult({ status: SetValueStatus.Working }).accepted).toBe(true);
  });

  it.each([
    ['NoDeviceSupport', SetValueStatus.NoDeviceSupport],
    ['Fail', SetValueStatus.Fail],
    ['EndpointNotFound', SetValueStatus.EndpointNotFound],
    ['NotImplemented', SetValueStatus.NotImplemented],
    ['InvalidValue', SetValueStatus.InvalidValue],
  ])('refuses %s', (name, status) => {
    expect(describeSetValueResult({ status })).toEqual({ accepted: false, description: name });
  });

  /**
   * The driver's own `setValueFailed` enumerates the failures, so a status added by a future
   * zwave-js release is accepted rather than turning a write that worked into a HomeKit error.
   */
  it('accepts a status it does not recognise rather than calling it a refusal', () => {
    expect(describeSetValueResult({ status: 42 } as never)).toEqual({
      accepted: true,
      description: 'status 42',
    });
  });

  it('includes the driver message with a refusal so the log says why', () => {
    expect(
      describeSetValueResult({ status: SetValueStatus.Fail, message: 'no ack' }).description,
    ).toBe('Fail (no ack)');
  });

  /**
   * Older driver versions and some command classes resolve without a status. Treating that as a
   * refusal would break every write that works today, so it counts as accepted.
   */
  it('accepts a result that carries no status at all', () => {
    expect(describeSetValueResult(undefined).accepted).toBe(true);
    expect(describeSetValueResult({} as never).accepted).toBe(true);
  });
});
