import { Accessory, Categories, Characteristic, HapStatusError, Service, uuid } from 'hap-nodejs';
import { IdentifierCache } from 'hap-nodejs/dist/lib/model/IdentifierCache';
import { CommandClasses, NodeStatus } from '@zwave-js/core';
import { AccessoryFactory } from '../src/accessories/AccessoryFactory';
import { ControllerAccessory } from '../src/accessories/ControllerAccessory';
import { CONFIGURED_NAME_COMPAT_SERVICE_UUIDS } from '../src/features/ZWaveFeature';
import { MANAGER_SERVICE_UUID, PIN_CHAR_UUID, STATUS_CHAR_UUID } from '../src/platform/settings';

type Scenario = {
  label: string;
  supportsCC: number[];
  definedValueIDs: Array<Record<string, unknown>>;
  endpointIndex?: number;
  values?: Array<{ key: Record<string, unknown>; value: unknown }>;
  metadata?: Array<{ key: Record<string, unknown>; value: unknown }>;
};

function createPlatform() {
  const platform = {
    log: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    api: {
      hap: {
        uuid,
        HapStatusError,
      },
      platformAccessory: Accessory,
      registerPlatformAccessories: jest.fn(),
      updatePlatformAccessories: jest.fn(),
    },
    Service,
    Characteristic,
    accessories: [],
  };

  class ZWaveStatus extends Characteristic {
    static readonly UUID = STATUS_CHAR_UUID;
    constructor() {
      super('System Status', STATUS_CHAR_UUID, {
        format: 'string',
        perms: ['pr', 'ev'],
      });
    }
  }

  class S2PinEntry extends Characteristic {
    static readonly UUID = PIN_CHAR_UUID;
    constructor() {
      super('S2 PIN Entry', PIN_CHAR_UUID, {
        format: 'uint32',
        perms: ['pr', 'pw', 'ev'],
      });
    }
  }

  class ZWaveManager extends Service {
    static readonly UUID = MANAGER_SERVICE_UUID;
    constructor(displayName: string, subtype?: string) {
      super(displayName, MANAGER_SERVICE_UUID, subtype);
      this.addOptionalCharacteristic(ZWaveStatus);
      this.addOptionalCharacteristic(S2PinEntry);
    }
  }

  (platform.Characteristic as typeof Characteristic & { ZWaveStatus?: typeof ZWaveStatus }).ZWaveStatus =
    ZWaveStatus;
  (platform.Characteristic as typeof Characteristic & { S2PinEntry?: typeof S2PinEntry }).S2PinEntry =
    S2PinEntry;
  (platform.Service as typeof Service & { ZWaveManager?: typeof ZWaveManager }).ZWaveManager =
    ZWaveManager;

  return platform;
}

function buildAccessory(scenario: Scenario) {
  const platform = createPlatform();
  const endpointIndex = scenario.endpointIndex ?? 0;
  const endpoint = {
    index: endpointIndex,
    supportsCC: (cc: number) => scenario.supportsCC.includes(cc),
  };
  const valueMap = new Map(
    (scenario.values ?? []).map(({ key, value }) => [JSON.stringify(key), value]),
  );
  const metadataMap = new Map(
    (scenario.metadata ?? []).map(({ key, value }) => [JSON.stringify(key), value]),
  );

  const node = {
    nodeId: 2,
    name: scenario.label,
    deviceConfig: {
      manufacturer: 'TestCo',
      label: `${scenario.label} Model`,
    },
    firmwareVersion: '1.2.3',
    status: NodeStatus.Alive,
    ready: true,
    supportsCC: (cc: number) => scenario.supportsCC.includes(cc),
    getAllEndpoints: () => [endpoint],
    getDefinedValueIDs: () => scenario.definedValueIDs,
    getValueMetadata: (key: Record<string, unknown>) => metadataMap.get(JSON.stringify(key)),
    getValue: (key: Record<string, unknown>) => valueMap.get(JSON.stringify(key)),
    setValue: async () => undefined,
  };

  const accessory = AccessoryFactory.create(platform as never, node as never, 12345);
  accessory.initialize();

  return accessory.platformAccessory;
}

async function serializeAccessory(accessory: Accessory) {
  const cache = new IdentifierCache('11:22:33:44:55:66');
  (
    accessory as Accessory & {
      _identifierCache?: IdentifierCache;
      _assignIDs: (cache: IdentifierCache) => void;
    }
  )._identifierCache = cache;
  (
    accessory as Accessory & {
      _assignIDs: (cache: IdentifierCache) => void;
    }
  )._assignIDs(cache);

  return accessory.toHAP(undefined as never, false);
}

function allowedCharacteristicNames(service: InstanceType<typeof Service.AccessoryInformation>) {
  return new Set(
    [...service.characteristics, ...service.optionalCharacteristics].map((char) => char.displayName),
  );
}

describe('HAP service compliance', () => {
  const scenarios: Scenario[] = [
    {
      label: 'Binary Switch',
      supportsCC: [CommandClasses['Binary Switch']],
      definedValueIDs: [
        { commandClass: CommandClasses['Binary Switch'], endpoint: 0, property: 'currentValue' },
      ],
    },
    {
      label: 'Dimmer',
      supportsCC: [CommandClasses['Multilevel Switch']],
      definedValueIDs: [
        { commandClass: CommandClasses['Multilevel Switch'], endpoint: 0, property: 'currentValue' },
      ],
    },
    {
      label: 'Lock',
      supportsCC: [CommandClasses['Door Lock']],
      definedValueIDs: [
        { commandClass: CommandClasses['Door Lock'], endpoint: 0, property: 'currentMode' },
      ],
    },
    {
      label: 'Thermostat',
      supportsCC: [CommandClasses['Thermostat Mode']],
      definedValueIDs: [
        { commandClass: CommandClasses['Thermostat Mode'], endpoint: 0, property: 'mode' },
      ],
    },
    {
      label: 'Window Covering',
      supportsCC: [CommandClasses['Window Covering']],
      definedValueIDs: [
        { commandClass: CommandClasses['Window Covering'], endpoint: 0, property: 'currentValue' },
      ],
    },
    {
      label: 'Garage Door',
      supportsCC: [CommandClasses['Barrier Operator']],
      definedValueIDs: [
        { commandClass: CommandClasses['Barrier Operator'], endpoint: 0, property: 'currentState' },
      ],
    },
    {
      label: 'Color Switch',
      supportsCC: [CommandClasses['Color Switch']],
      definedValueIDs: [
        { commandClass: CommandClasses['Color Switch'], endpoint: 0, property: 'currentColor' },
      ],
    },
    {
      label: 'Siren',
      supportsCC: [CommandClasses['Sound Switch']],
      definedValueIDs: [
        { commandClass: CommandClasses['Sound Switch'], endpoint: 0, property: 'toneId' },
      ],
    },
    {
      label: 'Battery',
      supportsCC: [CommandClasses.Battery],
      definedValueIDs: [
        { commandClass: CommandClasses.Battery, endpoint: 0, property: 'level' },
      ],
    },
    {
      label: 'Motion Notification',
      supportsCC: [CommandClasses.Notification],
      definedValueIDs: [
        {
          commandClass: CommandClasses.Notification,
          endpoint: 0,
          property: 'Home Security',
          propertyKey: 'Motion sensor status',
        },
      ],
    },
    {
      label: 'Contact Notification',
      supportsCC: [CommandClasses.Notification],
      definedValueIDs: [
        {
          commandClass: CommandClasses.Notification,
          endpoint: 0,
          property: 'Access Control',
          propertyKey: 'Door status',
        },
      ],
    },
    {
      label: 'Leak Notification',
      supportsCC: [CommandClasses.Notification],
      definedValueIDs: [
        {
          commandClass: CommandClasses.Notification,
          endpoint: 0,
          property: 'Water Alarm',
          propertyKey: 'Water leak status',
        },
      ],
    },
    {
      label: 'Smoke Notification',
      supportsCC: [CommandClasses.Notification],
      definedValueIDs: [
        {
          commandClass: CommandClasses.Notification,
          endpoint: 0,
          property: 'Smoke Alarm',
          propertyKey: 'Sensor status',
        },
      ],
    },
    {
      label: 'CO Notification',
      supportsCC: [CommandClasses.Notification],
      definedValueIDs: [
        {
          commandClass: CommandClasses.Notification,
          endpoint: 0,
          property: 'Carbon Monoxide Alarm',
          propertyKey: 'Sensor status',
        },
      ],
    },
    {
      label: 'Multilevel Sensor',
      supportsCC: [CommandClasses['Multilevel Sensor']],
      definedValueIDs: [
        {
          commandClass: CommandClasses['Multilevel Sensor'],
          endpoint: 0,
          property: 'Air temperature',
        },
        {
          commandClass: CommandClasses['Multilevel Sensor'],
          endpoint: 0,
          property: 'Humidity',
        },
        {
          commandClass: CommandClasses['Multilevel Sensor'],
          endpoint: 0,
          property: 'Illuminance',
        },
      ],
      values: [
        {
          key: {
            commandClass: CommandClasses['Multilevel Sensor'],
            endpoint: 0,
            property: 'Air temperature',
          },
          value: 20,
        },
      ],
    },
    {
      label: 'Air Quality',
      supportsCC: [CommandClasses['Multilevel Sensor']],
      definedValueIDs: [
        {
          commandClass: CommandClasses['Multilevel Sensor'],
          endpoint: 0,
          property: 'Carbon dioxide (CO2) level',
        },
        {
          commandClass: CommandClasses['Multilevel Sensor'],
          endpoint: 0,
          property: 'Volatile Organic Compound level',
        },
        {
          commandClass: CommandClasses['Multilevel Sensor'],
          endpoint: 0,
          property: 'Particulate Matter 2.5',
        },
      ],
      values: [
        {
          key: {
            commandClass: CommandClasses['Multilevel Sensor'],
            endpoint: 0,
            property: 'Carbon dioxide (CO2) level',
          },
          value: 900,
        },
      ],
    },
    {
      label: 'Central Scene',
      supportsCC: [CommandClasses['Central Scene']],
      definedValueIDs: [
        { commandClass: CommandClasses['Central Scene'], endpoint: 0, property: 'scene' },
      ],
      metadata: [
        {
          key: { commandClass: CommandClasses['Central Scene'], property: 'scene', endpoint: 0 },
          value: { states: { '1': 'Button 1', '2': 'Button 2' } },
        },
      ],
    },
    {
      label: 'Binary Switch Endpoint',
      endpointIndex: 2,
      supportsCC: [CommandClasses['Binary Switch']],
      definedValueIDs: [
        { commandClass: CommandClasses['Binary Switch'], endpoint: 2, property: 'currentValue' },
      ],
    },
  ];

  for (const scenario of scenarios) {
    it(`emits only HAP-defined characteristics for ${scenario.label}`, () => {
      const accessory = buildAccessory(scenario);

      for (const service of accessory.services) {
        if (service.UUID === Service.AccessoryInformation.UUID) {
          continue;
        }

        const reference = new (service.constructor as typeof Service)(service.displayName, service.subtype);
        const allowed = allowedCharacteristicNames(reference as InstanceType<typeof Service.AccessoryInformation>);

        const emitted = [...service.characteristics, ...service.optionalCharacteristics].map(
          (char) => char.displayName,
        );

        for (const charName of emitted) {
          if (
            charName === 'Configured Name' &&
            CONFIGURED_NAME_COMPAT_SERVICE_UUIDS.has(service.UUID)
          ) {
            continue;
          }
          expect(allowed.has(charName)).toBe(true);
        }
      }
    });
  }

  it('publishes Configured Name on switch services for Home app compatibility', async () => {
    const accessory = buildAccessory({
      label: 'Binary Switch',
      supportsCC: [CommandClasses['Binary Switch']],
      definedValueIDs: [
        { commandClass: CommandClasses['Binary Switch'], endpoint: 0, property: 'currentValue' },
      ],
    });

    const hap = await serializeAccessory(accessory);
    const switchService = hap[0].services.find((service) => service.type === '49');

    expect(switchService?.primary).toBe(true);
    expect(
      switchService?.characteristics.some((characteristic) => characteristic.type === 'E3'),
    ).toBe(true);
  });

  it('publishes Configured Name on leak services for Home app compatibility', async () => {
    const accessory = buildAccessory({
      label: 'Leak Notification',
      supportsCC: [CommandClasses.Notification],
      definedValueIDs: [
        {
          commandClass: CommandClasses.Notification,
          endpoint: 0,
          property: 'Water Alarm',
          propertyKey: 'Water leak status',
        },
      ],
    });

    const hap = await serializeAccessory(accessory);
    const leakService = hap[0].services.find((service) => service.type === '83');

    expect(leakService?.primary).toBe(true);
    expect(
      leakService?.characteristics.some((characteristic) => characteristic.type === 'E3'),
    ).toBe(true);
  });

  it('publishes Configured Name on AccessoryInformation for accessory rename compatibility', async () => {
    const accessory = buildAccessory({
      label: 'Leak Notification',
      supportsCC: [CommandClasses.Notification],
      definedValueIDs: [
        {
          commandClass: CommandClasses.Notification,
          endpoint: 0,
          property: 'Water Alarm',
          propertyKey: 'Water leak status',
        },
      ],
    });

    const hap = await serializeAccessory(accessory);
    const accessoryInformation = hap[0].services.find((service) => service.type === '3E');
    const configuredName = accessoryInformation?.characteristics.find(
      (characteristic) => characteristic.type === 'E3',
    );

    expect(configuredName).toBeDefined();
    expect(configuredName?.perms).toContain('pw');
  });

  it('does not publish Configured Name on battery services', async () => {
    const accessory = buildAccessory({
      label: 'Battery',
      supportsCC: [CommandClasses.Battery],
      definedValueIDs: [
        { commandClass: CommandClasses.Battery, endpoint: 0, property: 'level' },
      ],
    });

    const hap = await serializeAccessory(accessory);
    const batteryService = hap[0].services.find((service) => service.type === '96');

    expect(
      batteryService?.characteristics.some((characteristic) => characteristic.type === 'E3'),
    ).toBe(false);
  });

  it('uses explicit HomeKit categories for standard accessory types', () => {
    const switchAccessory = buildAccessory({
      label: 'Binary Switch',
      supportsCC: [CommandClasses['Binary Switch']],
      definedValueIDs: [
        { commandClass: CommandClasses['Binary Switch'], endpoint: 0, property: 'currentValue' },
      ],
    });
    const leakAccessory = buildAccessory({
      label: 'Leak Notification',
      supportsCC: [CommandClasses.Notification],
      definedValueIDs: [
        {
          commandClass: CommandClasses.Notification,
          endpoint: 0,
          property: 'Water Alarm',
          propertyKey: 'Water leak status',
        },
      ],
    });
    const thermostatAccessory = buildAccessory({
      label: 'Thermostat',
      supportsCC: [CommandClasses['Thermostat Mode']],
      definedValueIDs: [
        { commandClass: CommandClasses['Thermostat Mode'], endpoint: 0, property: 'mode' },
      ],
    });

    expect(switchAccessory.category).toBe(Categories.SWITCH);
    expect(leakAccessory.category).toBe(Categories.SENSOR);
    expect(thermostatAccessory.category).toBe(Categories.THERMOSTAT);
  });

  it('omits subtype for root services but keeps it for non-root endpoints', () => {
    const rootLeakAccessory = buildAccessory({
      label: 'Leak Notification',
      supportsCC: [CommandClasses.Notification],
      definedValueIDs: [
        {
          commandClass: CommandClasses.Notification,
          endpoint: 0,
          property: 'Water Alarm',
          propertyKey: 'Water leak status',
        },
      ],
    });
    const endpointSwitchAccessory = buildAccessory({
      label: 'Binary Switch Endpoint',
      endpointIndex: 2,
      supportsCC: [CommandClasses['Binary Switch']],
      definedValueIDs: [
        { commandClass: CommandClasses['Binary Switch'], endpoint: 2, property: 'currentValue' },
      ],
    });

    const rootLeakService = rootLeakAccessory.getService(Service.LeakSensor);
    const endpointSwitchService = endpointSwitchAccessory.getServiceById(Service.Switch, '2');

    expect(rootLeakService?.subtype).toBeUndefined();
    expect(endpointSwitchService?.subtype).toBe('2');
  });

  it('keeps controller-only label metadata isolated to the controller accessory', () => {
    const platform = createPlatform();
    const controller = {
      homeId: 12345,
      nodes: new Map(),
      on: jest.fn(),
      off: jest.fn(),
      startInclusion: jest.fn(),
      stopInclusion: jest.fn(),
      startExclusion: jest.fn(),
      stopExclusion: jest.fn(),
      startHealing: jest.fn(),
      stopHealing: jest.fn(),
      removeFailedNode: jest.fn(),
      setS2Pin: jest.fn(),
    };

    const controllerAccessory = new ControllerAccessory(platform as never, controller as never);

    for (const service of controllerAccessory.platformAccessory.services) {
      if (service.UUID === Service.AccessoryInformation.UUID) {
        const emitted = [...service.characteristics, ...service.optionalCharacteristics].map(
          (char) => char.displayName,
        );

        for (const charName of emitted) {
          if (charName === 'Service Label Namespace') {
            continue;
          }
          expect(
            allowedCharacteristicNames(
              new Service.AccessoryInformation() as InstanceType<typeof Service.AccessoryInformation>,
            ).has(charName),
          ).toBe(true);
        }
        continue;
      }

      if (service.UUID !== Service.Switch.UUID) {
        continue;
      }

      const reference = new Service.Switch(service.displayName, service.subtype);
      const allowed = allowedCharacteristicNames(
        reference as InstanceType<typeof Service.AccessoryInformation>,
      );
      const emitted = [...service.characteristics, ...service.optionalCharacteristics].map(
        (char) => char.displayName,
      );

      for (const charName of emitted) {
        if (charName === 'Service Label Index') {
          continue;
        }
        expect(allowed.has(charName)).toBe(true);
      }
    }
  });
});
