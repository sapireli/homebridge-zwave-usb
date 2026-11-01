import { CommandClasses as CC } from '@zwave-js/core';
import { IZWaveNode } from '../../src/zwave/interfaces';

/**
 * Devices as they actually report: a command class is advertised only together with the values
 * a real device defines for it. The baseline shapes cannot serve here, because they were built
 * to exercise detection, which reads command classes, and define no actuator values at all.
 */
export interface RealisticDevice {
  name: string;
  supported: CommandClasses[];
  values: Array<{ commandClass: number; property: string; propertyKey?: string | number }>;
  sceneStates?: boolean;
}
type CommandClasses = number;

// Every value carries its endpoint, as zwave-js reports them. Detection matches the endpoint
// exactly, so a value without one is invisible to it.
const v = (commandClass: number, property: string, propertyKey?: string | number) => ({
  commandClass,
  endpoint: 0,
  property,
  ...(propertyKey === undefined ? {} : { propertyKey }),
});

const BATTERY = [v(CC.Battery, 'level')];
const MLS = [v(CC['Multilevel Switch'], 'currentValue'), v(CC['Multilevel Switch'], 'targetValue')];
const BS = [v(CC['Binary Switch'], 'currentValue'), v(CC['Binary Switch'], 'targetValue')];

/** Every sensor type zwave-js names as a Binary Sensor value property, and the unspecified 'Any'. */
export const BINARY_SENSOR_PROPERTIES = [
  'General Purpose',
  'Smoke',
  'CO',
  'CO2',
  'Heat',
  'Water',
  'Freeze',
  'Tamper',
  'Aux',
  'Door/Window',
  'Tilt',
  'Motion',
  'Glass Break',
  'Any',
] as const;

/** A battery-powered binary sensor that reports one type. */
export function binarySensorDevice(property: string): RealisticDevice {
  return {
    name: `binary sensor (${property})`,
    supported: [CC['Binary Sensor'], CC.Battery],
    values: [v(CC['Binary Sensor'], property), ...BATTERY],
  };
}

/** What a node reports about itself, beyond the capabilities the device describes. */
export interface NodeIdentity {
  nodeId?: number;
  ready?: boolean;
  manufacturerId?: number;
  productType?: number;
  productId?: number;
  /** How many endpoints the node exposes. Each reports the same capabilities. */
  endpoints?: number;
  /** The name the user gave the node, which panels show beside its number. */
  name?: string;
  /** The model name the device reports, which is shown as the device label. */
  label?: string;
}

/** A node that answers the three questions classification asks, and nothing more. */
export function buildNode(device: RealisticDevice, identity: NodeIdentity = {}): IZWaveNode {
  const codes = new Set<number>(device.supported);
  const endpoints = Array.from({ length: identity.endpoints ?? 1 }, (_unused, index) => ({
    index,
    supportsCC: (cc: number) => codes.has(cc),
  }));
  return {
    nodeId: identity.nodeId ?? 7,
    ready: identity.ready ?? true,
    name: identity.name,
    label: identity.label,
    manufacturerId: identity.manufacturerId,
    productType: identity.productType,
    productId: identity.productId,
    getAllEndpoints: () => endpoints,
    getDefinedValueIDs: () => device.values,
    getValueMetadata: () => (device.sceneStates ? { states: { 1: 'Scene 1' } } : undefined),
    getValue: () => undefined,
    // Both are part of the node contract, so a fixture that omitted them would quietly turn
    // freshness into nothing and a refresh into a call that is never made.
    getValueTimestamp: () => undefined,
    refreshCCValues: async () => undefined,
  } as unknown as IZWaveNode;
}

export const REALISTIC_DEVICES: RealisticDevice[] = [
  { name: 'dimmer', supported: [CC['Multilevel Switch']], values: MLS },
  { name: 'dimmer with battery', supported: [CC['Multilevel Switch'], CC.Battery], values: [...MLS, ...BATTERY] },
  { name: 'relay', supported: [CC['Binary Switch']], values: BS },
  { name: 'colour bulb', supported: [CC['Color Switch'], CC['Multilevel Switch']], values: [...MLS, v(CC['Color Switch'], 'currentColor'), v(CC['Color Switch'], 'targetColor')] },
  { name: 'covering (Window Covering CC)', supported: [CC['Window Covering']], values: [v(CC['Window Covering'], 'currentValue', 13), v(CC['Window Covering'], 'targetValue', 13)] },
  { name: 'covering (Multilevel Switch only)', supported: [CC['Multilevel Switch']], values: MLS },
  { name: 'garage door', supported: [CC['Barrier Operator']], values: [v(CC['Barrier Operator'], 'currentState'), v(CC['Barrier Operator'], 'targetState'), v(CC['Barrier Operator'], 'obstruction')] },
  { name: 'door lock', supported: [CC['Door Lock']], values: [v(CC['Door Lock'], 'currentMode'), v(CC['Door Lock'], 'targetMode')] },
  { name: 'legacy lock', supported: [CC.Lock], values: [v(CC.Lock, 'locked')] },
  { name: 'thermostat', supported: [CC['Thermostat Mode'], CC['Thermostat Setpoint'], CC['Multilevel Sensor']], values: [v(CC['Thermostat Mode'], 'mode'), v(CC['Thermostat Setpoint'], 'setpoint', 1), v(CC['Thermostat Setpoint'], 'setpoint', 2), v(CC['Multilevel Sensor'], 'Air temperature')] },
  { name: 'siren (Sound Switch)', supported: [CC['Sound Switch'], CC['Binary Switch']], values: [...BS, v(CC['Sound Switch'], 'toneId'), v(CC['Sound Switch'], 'defaultVolume')] },
  { name: 'leak sensor (notification)', supported: [CC.Notification, CC.Battery], values: [v(CC.Notification, 'Water Alarm', 'Water leak status'), ...BATTERY] },
  { name: 'leak sensor (binary)', supported: [CC['Binary Sensor'], CC.Battery], values: [v(CC['Binary Sensor'], 'Water'), ...BATTERY] },
  { name: 'motion sensor (notification)', supported: [CC.Notification, CC.Battery], values: [v(CC.Notification, 'Home Security', 'Motion sensor status'), ...BATTERY] },
  { name: 'motion sensor (binary)', supported: [CC['Binary Sensor'], CC.Battery], values: [v(CC['Binary Sensor'], 'Motion'), ...BATTERY] },
  { name: 'contact sensor (notification)', supported: [CC.Notification, CC.Battery], values: [v(CC.Notification, 'Access Control', 'Door status'), ...BATTERY] },
  { name: 'contact sensor (binary)', supported: [CC['Binary Sensor'], CC.Battery], values: [v(CC['Binary Sensor'], 'Door/Window'), ...BATTERY] },
  { name: 'smoke alarm', supported: [CC.Notification, CC.Battery], values: [v(CC.Notification, 'Smoke Alarm'), ...BATTERY] },
  { name: 'CO alarm', supported: [CC.Notification, CC.Battery], values: [v(CC.Notification, 'Carbon Monoxide Alarm'), ...BATTERY] },
  { name: 'multisensor', supported: [CC['Multilevel Sensor'], CC.Notification, CC.Battery], values: [v(CC['Multilevel Sensor'], 'Air temperature'), v(CC['Multilevel Sensor'], 'Humidity'), v(CC.Notification, 'Home Security', 'Motion sensor status'), ...BATTERY] },
  { name: 'temperature only', supported: [CC['Multilevel Sensor'], CC.Battery], values: [v(CC['Multilevel Sensor'], 'Air temperature'), ...BATTERY] },
  { name: 'remote', supported: [CC['Central Scene'], CC.Battery], values: [v(CC['Central Scene'], 'scene'), v(CC['Central Scene'], 'keyAttribute'), ...BATTERY], sceneStates: true },
  { name: 'binary CO2 sensor', supported: [CC['Binary Sensor'], CC.Battery], values: [v(CC['Binary Sensor'], 'CO2'), ...BATTERY] },
];
