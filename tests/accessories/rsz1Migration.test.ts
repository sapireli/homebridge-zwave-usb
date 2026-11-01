import { Categories } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { AccessoryFactory } from '../../src/accessories/AccessoryFactory';
import { ZWaveUsbPlatform } from '../../src/platform/ZWaveUsbPlatform';
import { IZWaveNode } from '../../src/zwave/interfaces';

const SERVICE_UUIDS = {
  AccessoryInformation: '0000003E-0000-1000-8000-0026BB765291',
  Lightbulb: '00000043-0000-1000-8000-0026BB765291',
  WindowCovering: '0000008C-0000-1000-8000-0026BB765291',
  Battery: '00000096-0000-1000-8000-0026BB765291',
};

class FakeCharacteristic {
  public value: unknown = undefined;
  constructor(public readonly type: string) {}
  onGet = jest.fn().mockReturnThis();
  onSet = jest.fn().mockReturnThis();
  setProps = jest.fn().mockReturnThis();
  updateValue = jest.fn().mockImplementation((value: unknown) => {
    this.value = value;
    return this;
  });
}

class FakeService {
  static UUID = '';
  public readonly UUID: string;
  public isPrimary = false;
  public characteristics: FakeCharacteristic[] = [];
  private readonly chars = new Map<string, FakeCharacteristic>();

  constructor(
    public displayName = '',
    public subtype?: string,
  ) {
    this.UUID = (this.constructor as typeof FakeService).UUID;
  }

  getCharacteristic(type: string): FakeCharacteristic {
    let char = this.chars.get(type);
    if (!char) {
      char = new FakeCharacteristic(type);
      this.chars.set(type, char);
      this.characteristics.push(char);
    }
    return char;
  }

  testCharacteristic(type: string): boolean {
    return this.chars.has(type);
  }

  addCharacteristic(type: string): FakeCharacteristic {
    return this.getCharacteristic(type);
  }

  addOptionalCharacteristic(type: string): FakeCharacteristic {
    return this.getCharacteristic(type);
  }

  removeCharacteristic(char: FakeCharacteristic): void {
    this.chars.delete(char.type);
    this.characteristics = this.characteristics.filter((c) => c !== char);
  }

  setCharacteristic(type: string, value: unknown): this {
    this.getCharacteristic(type).updateValue(value);
    return this;
  }

  updateCharacteristic(type: string, value: unknown): this {
    this.getCharacteristic(type).updateValue(value);
    return this;
  }

  setPrimaryService(isPrimary = true): void {
    this.isPrimary = isPrimary;
  }
}

class AccessoryInformationService extends FakeService {
  static UUID = SERVICE_UUIDS.AccessoryInformation;
}
class LightbulbService extends FakeService {
  static UUID = SERVICE_UUIDS.Lightbulb;
}
class WindowCoveringService extends FakeService {
  static UUID = SERVICE_UUIDS.WindowCovering;
}
class BatteryService extends FakeService {
  static UUID = SERVICE_UUIDS.Battery;
}

class FakeAccessory {
  public services: FakeService[] = [];
  public context: Record<string, unknown> = {};
  /** Homebridge serialises the category from this inner object, not from the outer field. */
  public _associatedHAPAccessory: { category: number };

  constructor(
    public displayName: string,
    public readonly UUID: string,
    public category = 1,
  ) {
    this._associatedHAPAccessory = { category };
    this.services.push(new AccessoryInformationService('Accessory Information'));
  }

  getService(type: { UUID: string }): FakeService | undefined {
    return this.services.find((service) => service.UUID === type.UUID);
  }

  getServiceById(type: { UUID: string }, subtype: string): FakeService | undefined {
    return this.services.find(
      (service) => service.UUID === type.UUID && service.subtype === subtype,
    );
  }

  addService(service: FakeService): FakeService {
    this.services.push(service);
    return service;
  }

  removeService(service: FakeService): void {
    this.services = this.services.filter((candidate) => candidate !== service);
  }
}

const HOME_ID = 3563963922;
const NODE_ID = 5;
const CACHED_UUID = 'cached-rsz1-uuid';

const createPlatform = (accessories: FakeAccessory[]) =>
  ({
    log: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
    api: {
      hap: {
        uuid: { generate: jest.fn().mockReturnValue(CACHED_UUID) },
        HapStatusError: class extends Error {},
      },
      platformAccessory: jest
        .fn()
        .mockImplementation(
          (name: string, uuid: string, category: number) => new FakeAccessory(name, uuid, category),
        ),
      registerPlatformAccessories: jest.fn(),
      updatePlatformAccessories: jest.fn(),
    },
    Service: {
      AccessoryInformation: AccessoryInformationService,
      Lightbulb: LightbulbService,
      WindowCovering: WindowCoveringService,
      Battery: BatteryService,
    },
    Characteristic: {
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      SerialNumber: 'SerialNumber',
      FirmwareRevision: 'FirmwareRevision',
      Name: 'Name',
      ConfiguredName: 'ConfiguredName',
      On: 'On',
      Brightness: 'Brightness',
      ServiceLabelIndex: 'ServiceLabelIndex',
      CurrentPosition: 'CurrentPosition',
      TargetPosition: 'TargetPosition',
      PositionState: { DECREASING: 0, INCREASING: 1, STOPPED: 2 },
      BatteryLevel: 'BatteryLevel',
      StatusLowBattery: { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 },
      StatusFault: { NO_FAULT: 0, GENERAL_FAULT: 1 },
      StatusTampered: { NOT_TAMPERED: 0, TAMPERED: 1 },
    },
    accessories,
  }) as unknown as ZWaveUsbPlatform;

const createRsz1Node = (): IZWaveNode =>
  ({
    nodeId: NODE_ID,
    name: "Nico's Shade",
    manufacturer: 'Springs Window Fashions',
    label: 'RSZ1',
    manufacturerId: 0x026e,
    productType: 0x5253,
    productId: 0x5a31,
    firmwareVersion: '11.2',
    deviceConfig: {
      manufacturer: 'Springs Window Fashions',
      label: 'RSZ1',
      description: 'Somfy Motorized Shade',
    },
    ready: true,
    status: 4,
    supportsCC: jest.fn().mockReturnValue(false),
    getDefinedValueIDs: jest.fn().mockReturnValue([
      { endpoint: 0, commandClass: CommandClasses['Multilevel Switch'], property: 'currentValue' },
      { endpoint: 0, commandClass: CommandClasses.Battery, property: 'level' },
    ]),
    getAllEndpoints: jest.fn().mockReturnValue([
      {
        index: 0,
        supportsCC: jest
          .fn()
          .mockImplementation(
            (cc: number) =>
              cc === CommandClasses['Multilevel Switch'] || cc === CommandClasses.Battery,
          ),
      },
    ]),
    getValueMetadata: jest.fn(),
    getValue: jest.fn().mockReturnValue(undefined),
    setValue: jest.fn(),
  }) as unknown as IZWaveNode;

const createCachedLightbulbAccessory = (): FakeAccessory => {
  const cached = new FakeAccessory("Nico's Shade", CACHED_UUID, Categories.LIGHTBULB);
  cached.context = {
    nodeId: NODE_ID,
    homeId: HOME_ID,
    cacheRepairVersion: 1,
    metadataSignature: 'stale',
    graphSignature: '[{"endpoint":0,"features":["multilevel-switch","battery"]}]',
  };
  cached.addService(new LightbulbService("Nico's Shade"));
  cached.addService(new BatteryService("Nico's Shade"));

  return cached;
};

describe('RSZ1 accessory migration', () => {
  let cached: FakeAccessory;
  let platform: ZWaveUsbPlatform;
  let node: IZWaveNode;

  beforeEach(() => {
    cached = createCachedLightbulbAccessory();
    platform = createPlatform([cached]);
    node = createRsz1Node();
  });

  const migrate = () => {
    const accessory = AccessoryFactory.create(platform, node, HOME_ID, AccessoryFactory.planFeatures(node));
    accessory.initialize({ removeSupersededServices: true });
    return accessory;
  };

  it('reuses the cached platform accessory rather than registering a new one', () => {
    const accessory = migrate();

    expect(accessory.platformAccessory).toBe(
      cached as unknown as typeof accessory.platformAccessory,
    );
    expect(platform.api.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('preserves the platform accessory UUID, name and node context', () => {
    const accessory = migrate();

    expect(accessory.platformAccessory.UUID).toBe(CACHED_UUID);
    expect(accessory.platformAccessory.displayName).toBe("Nico's Shade");
    expect(accessory.platformAccessory.context).toMatchObject({
      nodeId: NODE_ID,
      homeId: HOME_ID,
    });
  });

  it('removes the obsolete Lightbulb service', () => {
    migrate();

    expect(cached.services.filter((s) => s.UUID === SERVICE_UUIDS.Lightbulb)).toHaveLength(0);
  });

  it('keeps a cached service that this pass did not re-derive', () => {
    /**
     * A node whose value database is still sparse can produce a feature graph missing a service
     * it had before. Deleting it would destroy the HomeKit automations bound to it, so only the
     * service the new classification directly replaces is removed.
     */
    class OrphanService extends FakeService {
      static UUID = '00000085-0000-1000-8000-0026BB765291'; // MotionSensor
    }
    const orphan = new OrphanService('Motion');
    cached.services.push(orphan as unknown as (typeof cached.services)[number]);

    migrate();

    expect(cached.services).toContain(orphan);
  });

  it('creates exactly one WindowCovering service', () => {
    migrate();

    expect(cached.services.filter((s) => s.UUID === SERVICE_UUIDS.WindowCovering)).toHaveLength(1);
  });

  it('keeps the battery service and the accessory information service', () => {
    migrate();

    expect(cached.services.filter((s) => s.UUID === SERVICE_UUIDS.Battery)).toHaveLength(1);
    expect(
      cached.services.filter((s) => s.UUID === SERVICE_UUIDS.AccessoryInformation),
    ).toHaveLength(1);
  });

  it('sets the platform accessory category to WINDOW_COVERING', () => {
    // This is the field the plugin controls. Whether HomeKit honours a category change on an
    // accessory it has already seen is the Home app's business, not this plugin's.
    migrate();

    expect(cached.category).toBe(Categories.WINDOW_COVERING);
  });

  it('marks the WindowCovering service as the primary service', () => {
    migrate();

    const covering = cached.services.find((s) => s.UUID === SERVICE_UUIDS.WindowCovering);
    expect(covering?.isPrimary).toBe(true);
  });

  it('records the new graph signature so the migration is not repeated', () => {
    const accessory = migrate();

    expect(accessory.getGraphSignature()).toContain('window-covering');
    expect(accessory.getGraphSignature()).not.toContain('multilevel-switch');
  });

  it('registers HomeKit position handlers on the migrated service', () => {
    migrate();

    const covering = cached.services.find((s) => s.UUID === SERVICE_UUIDS.WindowCovering)!;
    expect(covering.getCharacteristic('TargetPosition').onSet).toHaveBeenCalled();
    expect(covering.getCharacteristic('TargetPosition').onGet).toHaveBeenCalled();
    expect(covering.getCharacteristic('CurrentPosition').onGet).toHaveBeenCalled();
  });

  it('stays stable when the accessory is rebuilt after a restart', () => {
    migrate();
    const servicesAfterFirstRun = cached.services.length;

    // A restart re-runs the same path against the already migrated cache entry.
    const second = AccessoryFactory.create(platform, node, HOME_ID, AccessoryFactory.planFeatures(node));
    second.initialize({ removeSupersededServices: true });

    expect(cached.services).toHaveLength(servicesAfterFirstRun);
    expect(cached.services.filter((s) => s.UUID === SERVICE_UUIDS.WindowCovering)).toHaveLength(1);
    expect(cached.services.filter((s) => s.UUID === SERVICE_UUIDS.Lightbulb)).toHaveLength(0);
  });

  it('removes a pre-3.6.0 Lightbulb whose subtype is a literal zero', () => {
    const legacy = cached.services.findIndex((s) => s.UUID === SERVICE_UUIDS.Lightbulb);
    cached.services.splice(legacy, 1);
    cached.addService(new LightbulbService("Nico's Shade", '0'));

    migrate();

    expect(cached.services.filter((s) => s.UUID === SERVICE_UUIDS.Lightbulb)).toHaveLength(0);
    expect(cached.services.filter((s) => s.UUID === SERVICE_UUIDS.WindowCovering)).toHaveLength(1);
  });

  it('keeps the Lightbulb it just built when only a stale covering says otherwise', () => {
    /**
     * An already migrated accessory whose fingerprint is unreadable on this pass classifies as
     * a plain Multilevel Switch again. Deciding from the cache would delete the Lightbulb this
     * pass just created and leave the accessory driving nothing.
     */
    migrate();
    (node as unknown as { manufacturerId?: number }).manufacturerId = undefined;

    const rebuilt = AccessoryFactory.create(platform, node, HOME_ID, AccessoryFactory.planFeatures(node));
    rebuilt.initialize({ removeSupersededServices: true });

    const lightbulbs = cached.services.filter((s) => s.UUID === SERVICE_UUIDS.Lightbulb);
    expect(lightbulbs).toHaveLength(1);
    expect(lightbulbs[0].getCharacteristic('On').onSet).toHaveBeenCalled();
  });

  it('leaves a native covering alone when no override matched', () => {
    /**
     * A device that implements Window Covering CC needs no override, so nothing about it was
     * reclassified. A Lightbulb left in its cache is not this change's business.
     */
    (node as unknown as { manufacturerId?: number }).manufacturerId = 0x1234;
    (node.getAllEndpoints as jest.Mock).mockReturnValue([
      {
        index: 0,
        supportsCC: (cc: number) =>
          cc === CommandClasses['Window Covering'] || cc === CommandClasses.Battery,
      },
    ]);
    (node.getDefinedValueIDs as jest.Mock).mockReturnValue([
      { endpoint: 0, commandClass: CommandClasses['Window Covering'], property: 'currentValue' },
      { endpoint: 0, commandClass: CommandClasses.Battery, property: 'level' },
    ]);

    const strandedLightbulb = cached.services.find((s) => s.UUID === SERVICE_UUIDS.Lightbulb)!;

    const accessory = AccessoryFactory.create(platform, node, HOME_ID, AccessoryFactory.planFeatures(node));
    accessory.initialize({ removeSupersededServices: true });

    expect(cached.services).toContain(strandedLightbulb);
  });

  it('keeps a Lightbulb another feature built at the covering endpoint', () => {
    const accessory = migrate();
    const unrelated = new LightbulbService("Nico's Shade");
    cached.addService(unrelated);
    // As if a second feature on this endpoint had produced it on this pass.
    (accessory as unknown as { features: { getServices(): unknown[] }[] }).features.push({
      getServices: () => [unrelated],
    });

    (accessory as unknown as { removeSupersededServices(): void }).removeSupersededServices();

    expect(cached.services).toContain(unrelated);
  });
});
