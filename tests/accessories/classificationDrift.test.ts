import { Endpoint } from 'zwave-js';
import {
  AccessoryFactory,
  PRIMARY_CAPABILITY,
  PrimaryKind,
} from '../../src/accessories/AccessoryFactory';
import {
  BINARY_SENSOR_PROPERTIES,
  REALISTIC_DEVICES,
  RealisticDevice,
  binarySensorDevice,
  buildNode,
} from '../fixtures/realisticDevices';

/**
 * The primary kind decides which feature class drives a device's HomeKit service, and that
 * feature's compatibility predicate reports whether the endpoint defines the values it reads.
 * Where detection assigns a primary its own predicate rejects, the published service has nothing
 * to drive it.
 *
 * The mismatches recorded here belong to detection and are older than the predicates. They are
 * pinned rather than excused: narrowing detection, or widening a feature to cover one of them,
 * fails these tests, which is where the list should shrink.
 */

function primaryOf(device: RealisticDevice): { detected?: PrimaryKind; driveable: boolean } {
  const node = buildNode(device);
  const endpoint = node.getAllEndpoints()[0] as Endpoint;
  const detected = AccessoryFactory.planFeatures(node)[0].primaryKind;

  return {
    detected,
    driveable: detected === undefined || PRIMARY_CAPABILITY[detected](node, endpoint),
  };
}

describe('classification drift', () => {
  it('gives each realistic device a primary its own feature can drive', () => {
    const mismatched: Record<string, PrimaryKind | undefined> = {};
    for (const device of REALISTIC_DEVICES) {
      const { detected, driveable } = primaryOf(device);
      if (!driveable) {
        mismatched[device.name] = detected;
      }
    }

    expect(mismatched).toEqual({
      'motion sensor (binary)': 'contact-sensor',
      'binary CO2 sensor': 'multilevel-sensor',
    });
  });

  it('publishes a contact sensor for every binary sensor type it does not recognize', () => {
    const table: Record<string, { detected?: PrimaryKind; driveable: boolean }> = {};
    for (const property of BINARY_SENSOR_PROPERTIES) {
      table[property] = primaryOf(binarySensorDevice(property));
    }

    // Detection recognizes four of the fourteen types by name. 'Door/Window' and the unspecified
    // 'Any' are the two the contact sensor reads, so the rest reach a service that cannot report
    // them: their reports are filtered out and the characteristic holds its closed default.
    expect(table).toEqual({
      'General Purpose': { detected: 'contact-sensor', driveable: false },
      Smoke: { detected: 'smoke-sensor', driveable: true },
      CO: { detected: 'carbon-monoxide-sensor', driveable: true },
      CO2: { detected: 'multilevel-sensor', driveable: false },
      Heat: { detected: 'contact-sensor', driveable: false },
      Water: { detected: 'leak-sensor', driveable: true },
      Freeze: { detected: 'contact-sensor', driveable: false },
      Tamper: { detected: 'contact-sensor', driveable: false },
      Aux: { detected: 'contact-sensor', driveable: false },
      'Door/Window': { detected: 'contact-sensor', driveable: true },
      Tilt: { detected: 'contact-sensor', driveable: false },
      Motion: { detected: 'contact-sensor', driveable: false },
      'Glass Break': { detected: 'contact-sensor', driveable: false },
      Any: { detected: 'contact-sensor', driveable: true },
    });
  });

  it('offers a drifting device the types it could be, which need not include its own', () => {
    // A legacy motion sensor is published as a contact sensor, so the type it is published as is
    // absent from its own options and the type it could be is the only entry.
    expect(AccessoryFactory.compatiblePrimaryKinds(buildNode(binarySensorDevice('Motion')))).toEqual(
      ['motion-sensor'],
    );

    // Nothing reads a Tilt report, so there is no type to offer.
    expect(AccessoryFactory.compatiblePrimaryKinds(buildNode(binarySensorDevice('Tilt')))).toEqual(
      [],
    );
  });
});
