import { Service as S, Characteristic as C } from 'hap-nodejs';
import { CommandClasses } from '@zwave-js/core';
import { MatterAccessories } from '../../src/matter/MatterAccessories';
import { serviceMappings } from '../../src/matter/serviceMappings';

const typeNames = [
  'WindowCovering',
  'OnOffOutlet',
  'DimmableOutlet',
  'OnOffLight',
  'DimmableLight',
  'ExtendedColorLight',
  'DoorLock',
  'MotionSensor',
  'ContactSensor',
  'LeakSensor',
  'SmokeSensor',
  'TemperatureSensor',
  'HumiditySensor',
  'LightSensor',
  'AirQualitySensor',
  'GenericSwitch',
  'Closure',
  'Thermostat',
];

function fakeDevice(name: string, behaviors: Record<string, unknown> = {}): any {
  return {
    name,
    behaviors,
    requirements: Object.fromEntries(
      [
        'AirQualityServer',
        'CarbonDioxideConcentrationMeasurementServer',
        'TotalVolatileOrganicCompoundsConcentrationMeasurementServer',
        'Pm25ConcentrationMeasurementServer',
      ].map((id) => [id, { with: (...features: string[]) => ({ id, features }) }]),
    ),
    with: (...servers: any[]) =>
      fakeDevice(name, {
        ...behaviors,
        ...Object.fromEntries(servers.map((server) => [server.id, server])),
      }),
  };
}

function harness(services: any[], setpoints = [1, 2], uuid = 'node-8') {
  const matter = {
    deviceTypes: {
      ...Object.fromEntries(typeNames.map((name) => [name, fakeDevice(name)])),
      BridgedNode: fakeDevice('BridgedNode', {
        bridgedDeviceBasicInformation: { id: 'bridgedDeviceBasicInformation' },
      }),
    },
    registerPlatformAccessories: jest.fn().mockResolvedValue(undefined),
    unregisterPlatformAccessories: jest.fn().mockResolvedValue(undefined),
    updateAccessoryState: jest.fn().mockResolvedValue(undefined),
    switch: { emitGesture: jest.fn().mockResolvedValue(undefined) },
    status: { Failure: class extends Error {}, NotFound: class extends Error {} },
  };
  const platform = {
    api: { matter },
    Service: S,
    Characteristic: C,
    log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as any;
  const accessory = {
    platformAccessory: {
      UUID: uuid,
      displayName: 'Multi endpoint node',
      services,
      getService: (type: any) => services.find((s) => s.UUID === type.UUID),
    },
    node: {
      nodeId: 8,
      getDefinedValueIDs: () =>
        setpoints.map((n) => ({
          commandClass: CommandClasses['Thermostat Setpoint'],
          endpoint: 0,
          property: 'setpoint',
          propertyKey: n,
        })),
    },
  } as any;
  const bridge = new MatterAccessories(platform);
  const publish = async () => {
    bridge.add(accessory);
    await (bridge as any).publishPending();
    return matter.registerPlatformAccessories.mock.calls[0]?.[2]?.[0];
  };
  return { matter, platform, accessory, bridge, publish };
}

function service(Type: any, values: Array<[any, any]>, subtype = '0') {
  const s = new Type('Device', subtype);
  for (const [type, value] of values)
    s.getCharacteristic(type)
      .onGet(() => value)
      .updateValue(value);
  return s;
}

const categories: Array<[string, () => any, string, string, Record<string, unknown>]> = [
  [
    'binary switch',
    () => service(S.Switch, [[C.On, true]]),
    'OnOffOutlet',
    'onOff',
    { onOff: true },
  ],
  ['outlet', () => service(S.Outlet, [[C.On, false]]), 'OnOffOutlet', 'onOff', { onOff: false }],
  [
    'dimmer',
    () =>
      service(S.Lightbulb, [
        [C.On, true],
        [C.Brightness, 50],
      ]),
    'DimmableLight',
    'levelControl',
    { currentLevel: 127 },
  ],
  [
    'color light',
    () =>
      service(S.Lightbulb, [
        [C.On, true],
        [C.Brightness, 50],
        [C.Hue, 180],
        [C.Saturation, 50],
      ]),
    'ExtendedColorLight',
    'colorControl',
    { currentHue: 127, currentSaturation: 127 },
  ],
  [
    'lock',
    () => service(S.LockMechanism, [[C.LockCurrentState, 1]]),
    'DoorLock',
    'doorLock',
    { lockState: 1 },
  ],
  [
    'motion',
    () => service(S.MotionSensor, [[C.MotionDetected, true]]),
    'MotionSensor',
    'occupancySensing',
    { occupancy: { occupied: true } },
  ],
  [
    'contact',
    () => service(S.ContactSensor, [[C.ContactSensorState, 0]]),
    'ContactSensor',
    'booleanState',
    { stateValue: true },
  ],
  [
    'leak',
    () => service(S.LeakSensor, [[C.LeakDetected, 1]]),
    'LeakSensor',
    'booleanState',
    { stateValue: true },
  ],
  [
    'smoke',
    () => service(S.SmokeSensor, [[C.SmokeDetected, 1]]),
    'SmokeSensor',
    'smokeCoAlarm',
    { smokeState: 1 },
  ],
  [
    'carbon monoxide',
    () => service(S.CarbonMonoxideSensor, [[C.CarbonMonoxideDetected, 1]]),
    'SmokeSensor',
    'smokeCoAlarm',
    { coState: 1 },
  ],
  [
    'temperature',
    () => service(S.TemperatureSensor, [[C.CurrentTemperature, 21.5]]),
    'TemperatureSensor',
    'temperatureMeasurement',
    { measuredValue: 2150 },
  ],
  [
    'humidity',
    () => service(S.HumiditySensor, [[C.CurrentRelativeHumidity, 45]]),
    'HumiditySensor',
    'relativeHumidityMeasurement',
    { measuredValue: 4500 },
  ],
  [
    'illuminance',
    () => service(S.LightSensor, [[C.CurrentAmbientLightLevel, 100]]),
    'LightSensor',
    'illuminanceMeasurement',
    { measuredValue: 20001 },
  ],
  [
    'air quality',
    () => service(S.AirQualitySensor, [[C.AirQuality, 4]]),
    'AirQualitySensor',
    'airQuality',
    { airQuality: 4 },
  ],
  [
    'garage door',
    () =>
      service(S.GarageDoorOpener, [
        [C.CurrentDoorState, 0],
        [C.TargetDoorState, 1],
      ]),
    'Closure',
    'closureControl',
    { mainState: 0, overallCurrentState: { position: 1 }, overallTargetState: { position: 0 } },
  ],
  [
    'siren volume',
    () =>
      service(S.Fan, [
        [C.On, true],
        [C.RotationSpeed, 50],
      ]),
    'DimmableOutlet',
    'levelControl',
    { currentLevel: 127 },
  ],
  [
    'scene button',
    () => service(S.StatelessProgrammableSwitch, []),
    'GenericSwitch',
    'switch',
    { currentPosition: 0 },
  ],
  [
    'covering',
    () =>
      service(S.WindowCovering, [
        [C.CurrentPosition, 80],
        [C.TargetPosition, 60],
      ]),
    'WindowCovering',
    'windowCovering',
    { currentPositionLiftPercent100ths: 2000, targetPositionLiftPercent100ths: 4000 },
  ],
];

describe('Matter publication across device types', () => {
  afterEach(() => jest.useRealTimers());
  it.each(categories)(
    'publishes %s through its appropriate cluster',
    async (_name, make, type, cluster, attributes) => {
      const h = harness([make()]);
      const descriptor = await h.publish();
      expect(descriptor.deviceType.name).toBe(type);
      expect(descriptor.clusters[cluster]).toMatchObject(attributes);
      h.bridge.stop();
    },
  );

  it.each(categories)(
    'mirrors a %s after rebuilding without registering the UUID again',
    async (_name, make, _type, cluster) => {
      const original = make();
      const h = harness([original]);
      await h.publish();
      const replacement = make();
      const rebuilt = {
        ...h.accessory,
        platformAccessory: { ...h.accessory.platformAccessory, services: [replacement] },
      };
      h.bridge.add(rebuilt);
      // Finish the asynchronous state push before checking listener routing.
      await new Promise((resolve) => setImmediate(resolve));
      h.matter.updateAccessoryState.mockClear();
      const mapping = serviceMappings(h.platform, rebuilt, {
        read: jest.fn(),
        write: jest.fn(),
      })[0];
      const binding = mapping.bindings[0];
      original.getCharacteristic(binding.characteristic).emit('change', { newValue: 1 });
      expect(h.matter.updateAccessoryState).not.toHaveBeenCalled();
      replacement.getCharacteristic(binding.characteristic).emit('change', { newValue: 1 });
      if (binding.event)
        expect(h.matter.switch.emitGesture).toHaveBeenCalledWith('node-8', 'doublePress', {
          partId: undefined,
        });
      else
        expect(h.matter.updateAccessoryState).toHaveBeenCalledWith(
          'node-8',
          binding.cluster,
          expect.anything(),
        );
      expect(h.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
      await h.bridge.remove('node-8');
      h.matter.updateAccessoryState.mockClear();
      replacement.getCharacteristic(binding.characteristic).emit('change', { newValue: 1 });
      expect(h.matter.updateAccessoryState).not.toHaveBeenCalled();
      h.bridge.stop();
    },
  );

  it.each(categories)('reclaims a cached %s through registration', async (_name, make) => {
    const h = harness([make()]);
    h.bridge.configureCachedAccessory({ UUID: 'node-8', displayName: 'Cached device' });
    await h.publish();
    expect(h.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    await h.bridge.reconcileCached(new Set(['node-8']));
    expect(h.matter.unregisterPlatformAccessories).not.toHaveBeenCalled();
    h.bridge.stop();
  });

  it('drops publication that was building when shutdown started', async () => {
    const h = harness([service(S.Switch, [[C.On, true]])]);
    const describe = (h.bridge as any).describe.bind(h.bridge);
    let release!: () => void;
    (h.bridge as any).describe = async (...args: any[]) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return describe(...args);
    };
    h.bridge.add(h.accessory);
    const pending = (h.bridge as any).publishPending();
    h.bridge.stop();
    release();
    await pending;
    expect(h.matter.registerPlatformAccessories).not.toHaveBeenCalled();
    h.bridge.add(h.accessory);
    await (h.bridge as any).publishPending();
    expect(h.matter.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('publishes every endpoint and routes commands to the selected part, including two coverings', async () => {
    const first = service(
      S.WindowCovering,
      [
        [C.CurrentPosition, 80],
        [C.TargetPosition, 80],
      ],
      '1',
    );
    const second = service(
      S.WindowCovering,
      [
        [C.CurrentPosition, 20],
        [C.TargetPosition, 20],
      ],
      '2',
    );
    const temp = service(S.TemperatureSensor, [[C.CurrentTemperature, 25]], '2');
    const firstSet = jest.fn(),
      secondSet = jest.fn();
    first.getCharacteristic(C.TargetPosition).onSet(firstSet);
    second.getCharacteristic(C.TargetPosition).onSet(secondSet);
    const h = harness([temp, second, first]);
    const d = await h.publish();
    expect(d.parts).toHaveLength(2);
    const part = d.parts.find((p: any) => p.clusters.windowCovering);
    await part.handlers.windowCovering.downOrClose();
    expect(secondSet).toHaveBeenCalledWith(0, undefined, undefined);
    expect(firstSet).not.toHaveBeenCalled();
    h.matter.updateAccessoryState.mockClear();
    second.updateCharacteristic(C.CurrentPosition, 40);
    expect(h.matter.updateAccessoryState).toHaveBeenCalledWith(
      'node-8',
      'windowCovering',
      { currentPositionLiftPercent100ths: 6000 },
      part.id,
    );
    h.bridge.stop();
  });

  it('attaches battery reporting to a read-only sensor as well as to a covering', async () => {
    const contact = service(S.ContactSensor, [[C.ContactSensorState, 1]]);
    const battery = service(S.Battery, [
      [C.BatteryLevel, 40],
      [C.StatusLowBattery, 0],
    ]);
    const h = harness([contact, battery]);
    const d = await h.publish();
    expect(d.clusters.powerSource.batPercentRemaining).toBe(80);
    battery.updateCharacteristic(C.BatteryLevel, 20);
    expect(h.matter.updateAccessoryState).toHaveBeenCalledWith('node-8', 'powerSource', {
      batPercentRemaining: 40,
    });
    h.bridge.stop();
  });

  it.each([
    [false, true],
    [true, false],
    [true, true],
  ])('only advertises real thermostat setpoints: heat=%s cool=%s', async (heat, cool) => {
    const thermostat = service(S.Thermostat, [
      [C.CurrentTemperature, 21],
      [C.TargetHeatingCoolingState, heat ? 1 : 2],
      [C.TargetTemperature, 22],
      [C.HeatingThresholdTemperature, 20],
      [C.CoolingThresholdTemperature, 25],
    ]);
    const setMode = jest.fn(),
      setHeat = jest.fn(),
      setCool = jest.fn();
    thermostat.getCharacteristic(C.TargetHeatingCoolingState).onSet(setMode);
    thermostat.getCharacteristic(C.HeatingThresholdTemperature).onSet(setHeat);
    thermostat.getCharacteristic(C.CoolingThresholdTemperature).onSet(setCool);
    const h = harness([thermostat], [...(heat ? [1] : []), ...(cool ? [2] : [])]);
    const d = await h.publish();
    expect('occupiedHeatingSetpoint' in d.clusters.thermostat).toBe(heat);
    expect('occupiedCoolingSetpoint' in d.clusters.thermostat).toBe(cool);
    expect(d.clusters.thermostat.systemMode).toBe(heat ? 4 : 3);
    if (heat) {
      await d.handlers.thermostat.systemModeChange({ systemMode: 4 });
      expect(setMode).toHaveBeenCalledWith(1, undefined, undefined);
      await d.handlers.thermostat.occupiedHeatingSetpointChange({ occupiedHeatingSetpoint: 2150 });
      expect(setHeat).toHaveBeenCalledWith(21.5, undefined, undefined);
    }
    if (cool) {
      await d.handlers.thermostat.occupiedCoolingSetpointChange({ occupiedCoolingSetpoint: 2450 });
      expect(setCool).toHaveBeenCalledWith(24.5, undefined, undefined);
    }
    await expect(d.handlers.thermostat.systemModeChange({ systemMode: 9 })).rejects.toBeInstanceOf(
      h.matter.status.Failure,
    );
    h.bridge.stop();
  });

  it('publishes raw CO2, VOC and PM2.5 on one air sensor endpoint with their real units', async () => {
    const air = service(S.AirQualitySensor, [
      [C.AirQuality, 3],
      [C.VOCDensity, 180],
      [C.PM2_5Density, 14],
    ]);
    const co2 = service(S.CarbonDioxideSensor, [
      [C.CarbonDioxideDetected, 0],
      [C.CarbonDioxideLevel, 750],
    ]);
    const h = harness([air, co2]);
    const d = await h.publish();
    expect(d.parts).toBeUndefined();
    expect(d.clusters.carbonDioxideConcentrationMeasurement).toMatchObject({
      measuredValue: 750,
      measurementUnit: 0,
      measurementMedium: 0,
    });
    expect(d.clusters.totalVolatileOrganicCompoundsConcentrationMeasurement).toMatchObject({
      measuredValue: 180,
      measurementUnit: 4,
    });
    expect(d.clusters.pm25ConcentrationMeasurement).toMatchObject({
      measuredValue: 14,
      measurementUnit: 4,
    });
    co2.updateCharacteristic(C.CarbonDioxideLevel, 900);
    expect(h.matter.updateAccessoryState).toHaveBeenCalledWith(
      'node-8',
      'carbonDioxideConcentrationMeasurement',
      { measuredValue: 900 },
    );
    air.updateCharacteristic(C.PM2_5Density, 20);
    expect(h.matter.updateAccessoryState).toHaveBeenCalledWith(
      'node-8',
      'pm25ConcentrationMeasurement',
      { measuredValue: 20 },
    );
    h.bridge.stop();
  });

  it('keeps raw measurements on their selected endpoint through wrapper replacement', async () => {
    const cover = service(
      S.WindowCovering,
      [
        [C.CurrentPosition, 50],
        [C.TargetPosition, 50],
      ],
      '1',
    );
    const air = service(
      S.AirQualitySensor,
      [
        [C.AirQuality, 2],
        [C.VOCDensity, 10],
      ],
      '2',
    );
    const co2 = service(
      S.CarbonDioxideSensor,
      [
        [C.CarbonDioxideDetected, 0],
        [C.CarbonDioxideLevel, 700],
      ],
      '2',
    );
    const h = harness([cover, air, co2]);
    const d = await h.publish();
    const part = d.parts.find((p: any) => p.clusters.carbonDioxideConcentrationMeasurement);
    const nextCo2 = service(
      S.CarbonDioxideSensor,
      [
        [C.CarbonDioxideDetected, 0],
        [C.CarbonDioxideLevel, 800],
      ],
      '2',
    );
    h.bridge.add({
      ...h.accessory,
      platformAccessory: { ...h.accessory.platformAccessory, services: [cover, air, nextCo2] },
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.matter.updateAccessoryState.mockClear();
    co2.updateCharacteristic(C.CarbonDioxideLevel, 1000);
    expect(h.matter.updateAccessoryState).not.toHaveBeenCalled();
    nextCo2.updateCharacteristic(C.CarbonDioxideLevel, 900);
    expect(h.matter.updateAccessoryState).toHaveBeenCalledWith(
      'node-8',
      'carbonDioxideConcentrationMeasurement',
      { measuredValue: 900 },
      part.id,
    );
    expect(h.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    h.bridge.stop();
  });

  it('does not merge measurements belonging to different Z-Wave endpoints', async () => {
    const air = service(
      S.AirQualitySensor,
      [
        [C.AirQuality, 2],
        [C.PM2_5Density, 11],
      ],
      '1',
    );
    const co2 = service(
      S.CarbonDioxideSensor,
      [
        [C.CarbonDioxideDetected, 0],
        [C.CarbonDioxideLevel, 850],
      ],
      '2',
    );
    const h = harness([air, co2]);
    const d = await h.publish();
    expect(d.parts).toHaveLength(1);
    const endpoints = [d, ...d.parts];
    expect(
      endpoints.filter((p: any) => p.clusters.carbonDioxideConcentrationMeasurement),
    ).toHaveLength(1);
    expect(endpoints.filter((p: any) => p.clusters.pm25ConcentrationMeasurement)).toHaveLength(1);
    expect(
      endpoints.some(
        (p: any) =>
          p.clusters.carbonDioxideConcentrationMeasurement &&
          p.clusters.pm25ConcentrationMeasurement,
      ),
    ).toBe(false);
    h.bridge.stop();
  });

  it('publishes an unavailable raw measurement as null rather than its HAP default', async () => {
    const co2 = service(S.CarbonDioxideSensor, [
      [C.CarbonDioxideDetected, 0],
      [C.CarbonDioxideLevel, 0],
    ]);
    co2.getCharacteristic(C.CarbonDioxideLevel).onGet(() => {
      throw new Error('No reading');
    });
    const h = harness([co2]);
    const d = await h.publish();
    expect(d.clusters.carbonDioxideConcentrationMeasurement.measuredValue).toBeNull();
    h.bridge.stop();
  });

  it.each([undefined, NaN, -1])(
    'does not turn an unavailable/invalid raw sample %s into a HAP default zero',
    async (sample) => {
      const air = service(S.AirQualitySensor, [
        [C.AirQuality, 0],
        [C.VOCDensity, 0],
        [C.PM2_5Density, 0],
      ]);
      const co2 = service(S.CarbonDioxideSensor, [
        [C.CarbonDioxideDetected, 0],
        [C.CarbonDioxideLevel, 0],
      ]);
      const h = harness([air, co2]);
      h.accessory.node.getValue = jest.fn().mockReturnValue(sample);
      const d = await h.publish();
      for (const cluster of [
        'carbonDioxideConcentrationMeasurement',
        'totalVolatileOrganicCompoundsConcentrationMeasurement',
        'pm25ConcentrationMeasurement',
      ]) {
        expect(d.clusters[cluster].measuredValue).toBeNull();
      }
      h.accessory.node.getValue.mockReturnValue(400);
      co2.updateCharacteristic(C.CarbonDioxideLevel, 400);
      expect(h.matter.updateAccessoryState).toHaveBeenCalledWith(
        'node-8',
        'carbonDioxideConcentrationMeasurement',
        { measuredValue: 400 },
      );
      h.bridge.stop();
    },
  );

  it('keeps an unknown battery level null despite the characteristic cached default of zero', async () => {
    const contact = service(S.ContactSensor, [[C.ContactSensorState, 0]]);
    const battery = service(S.Battery, []);
    battery.getCharacteristic(C.BatteryLevel).onGet(() => {
      throw new Error('Battery has not reported');
    });
    expect(battery.getCharacteristic(C.BatteryLevel).value).toBe(0);
    const h = harness([contact, battery]);
    const d = await h.publish();
    expect(d.clusters.powerSource.batPercentRemaining).toBeNull();
    h.bridge.stop();
  });

  it('uses the battery belonging to each endpoint and mirrors changes to that part only', async () => {
    const first = service(S.Switch, [[C.On, true]], '0');
    const second = service(S.Switch, [[C.On, false]], '2');
    const rootBattery = service(
      S.Battery,
      [
        [C.BatteryLevel, 80],
        [C.StatusLowBattery, 0],
      ],
      '0',
    );
    const partBattery = service(
      S.Battery,
      [
        [C.BatteryLevel, 15],
        [C.StatusLowBattery, 1],
      ],
      '2',
    );
    const h = harness([first, second, rootBattery, partBattery]);
    const d = await h.publish();
    expect(d.clusters.powerSource.batPercentRemaining).toBe(160);
    expect(d.parts[0].clusters.powerSource).toMatchObject({
      batPercentRemaining: 30,
      batChargeLevel: 1,
    });
    h.matter.updateAccessoryState.mockClear();
    partBattery.updateCharacteristic(C.BatteryLevel, 10);
    expect(h.matter.updateAccessoryState).toHaveBeenCalledTimes(1);
    expect(h.matter.updateAccessoryState).toHaveBeenCalledWith(
      'node-8',
      'powerSource',
      { batPercentRemaining: 20 },
      d.parts[0].id,
    );
    h.bridge.stop();
  });

  it('publishes a battery-only device as a bridged power source', async () => {
    const battery = service(S.Battery, [
      [C.BatteryLevel, 40],
      [C.StatusLowBattery, 0],
    ]);
    const h = harness([battery]);
    const d = await h.publish();
    expect(d.deviceType.name).toBe('BridgedNode');
    expect(d.clusters.powerSource.batPercentRemaining).toBe(80);
    h.bridge.stop();
  });

  it('does not advertise UV as an invented illuminance measurement', async () => {
    const light = service(S.LightSensor, []);
    const h = harness([light]);
    h.accessory.node.getDefinedValueIDs = () => [
      { commandClass: CommandClasses['Multilevel Sensor'], endpoint: 0, property: 'Ultraviolet' },
    ];
    expect(await h.publish()).toBeUndefined();
    h.bridge.stop();
  });

  it('sets dimmer brightness without a second restore-previous write, and rejects relative motion', async () => {
    const dimmer = service(S.Lightbulb, [
      [C.On, false],
      [C.Brightness, 20],
    ]);
    const brightness = jest.fn(),
      on = jest.fn();
    dimmer.getCharacteristic(C.Brightness).onSet(brightness);
    dimmer.getCharacteristic(C.On).onSet(on);
    const h = harness([dimmer]);
    const d = await h.publish();
    await d.handlers.levelControl.moveToLevelWithOnOff({ level: 127 });
    expect(brightness).toHaveBeenCalledWith(50, undefined, undefined);
    expect(on).not.toHaveBeenCalled();
    await expect(d.handlers.levelControl.move({ rate: 10 })).rejects.toBeInstanceOf(
      h.matter.status.Failure,
    );
    expect(brightness).toHaveBeenCalledTimes(1);
    h.bridge.stop();
  });

  it('validates both color components before sending either one', async () => {
    const light = service(S.Lightbulb, [
      [C.On, true],
      [C.Hue, 0],
      [C.Saturation, 0],
    ]);
    const hue = jest.fn(),
      saturation = jest.fn();
    light.getCharacteristic(C.Hue).onSet(hue);
    light.getCharacteristic(C.Saturation).onSet(saturation);
    const h = harness([light]);
    const d = await h.publish();
    await expect(
      d.handlers.colorControl.moveToHueAndSaturationLogic({ hue: 127, saturation: 999 }),
    ).rejects.toBeInstanceOf(h.matter.status.Failure);
    expect(hue).not.toHaveBeenCalled();
    await d.handlers.colorControl.moveToHueAndSaturationLogic({ hue: 127, saturation: 127 });
    expect(hue).toHaveBeenCalledWith(180, undefined, undefined);
    expect(saturation).toHaveBeenCalledWith(50, undefined, undefined);
    h.bridge.stop();
  });

  it('routes binary toggle to the replacement wrapper and propagates failures', async () => {
    const old = service(S.Switch, [[C.On, true]]),
      current = service(S.Switch, [[C.On, false]]);
    const oldSet = jest.fn(),
      newSet = jest.fn();
    old.getCharacteristic(C.On).onSet(oldSet);
    current.getCharacteristic(C.On).onSet(newSet);
    const h = harness([old]);
    const d = await h.publish();
    h.bridge.add({
      ...h.accessory,
      platformAccessory: { ...h.accessory.platformAccessory, services: [current] },
    });
    await d.handlers.onOff.toggle();
    expect(newSet).toHaveBeenCalledWith(true, undefined, undefined);
    expect(oldSet).not.toHaveBeenCalled();
    newSet.mockRejectedValue(new Error('Radio failed'));
    await expect(d.handlers.onOff.off()).rejects.toBeInstanceOf(h.matter.status.Failure);
    await h.bridge.remove('node-8');
    await expect(d.handlers.onOff.on()).rejects.toBeInstanceOf(h.matter.status.NotFound);
    h.bridge.stop();
  });

  it('rejects unsupported garage movements and never claims to stop a motor', async () => {
    const garage = service(S.GarageDoorOpener, [
      [C.CurrentDoorState, 1],
      [C.TargetDoorState, 1],
    ]);
    const setter = jest.fn();
    garage.getCharacteristic(C.TargetDoorState).onSet(setter);
    const h = harness([garage]);
    const d = await h.publish();
    await d.handlers.closureControl.moveTo({ position: 1 });
    expect(setter).toHaveBeenCalledWith(0, undefined, undefined);
    await expect(d.handlers.closureControl.moveTo({ position: 2 })).rejects.toBeInstanceOf(
      h.matter.status.Failure,
    );
    await expect(d.handlers.closureControl.stop()).rejects.toBeInstanceOf(h.matter.status.Failure);
    h.bridge.stop();
  });

  it('ignores Closure fields it does not implement rather than refusing the command', async () => {
    // Closure Control requires a server to ignore the optional fields it does not implement,
    // and the specification's own example is a position-only server receiving position and
    // speed. Refusing leaves the door shut for a controller that is asking for a position
    // this door can reach.
    const garage = service(S.GarageDoorOpener, [
      [C.CurrentDoorState, 1],
      [C.TargetDoorState, 1],
    ]);
    const setter = jest.fn();
    garage.getCharacteristic(C.TargetDoorState).onSet(setter);
    const h = harness([garage]);
    const d = await h.publish();

    await d.handlers.closureControl.moveTo({ position: 1, speed: 2 });
    await d.handlers.closureControl.moveTo({ position: 0, latch: true });

    expect(setter.mock.calls.map((call: unknown[]) => call[0])).toEqual([0, 1]);
    h.bridge.stop();
  });

  it('does nothing on Homebridge 1 without a Matter API', async () => {
    const h = harness([service(S.Switch, [[C.On, true]])]);
    delete h.platform.api.matter;
    expect(await h.publish()).toBeUndefined();
    expect(h.matter.registerPlatformAccessories).not.toHaveBeenCalled();
    h.bridge.stop();
  });
});
