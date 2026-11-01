/**
 * Every node shape the classification baseline is measured over.
 *
 * Deterministic and ordered: the golden hash beside it is taken over these shapes in exactly
 * this order, so a change here changes the hash and has to be justified rather than absorbed.
 */
export const SHAPE_CC: Record<string, number> = {
  'Binary Switch': 37,
  'Multilevel Switch': 38,
  'Binary Sensor': 48,
  'Multilevel Sensor': 49,
  'Color Switch': 51,
  'Door Lock': 98,
  Lock: 118,
  Notification: 113,
  'Thermostat Mode': 64,
  'Window Covering': 106,
  'Barrier Operator': 102,
  'Sound Switch': 121,
  'Central Scene': 91,
  Battery: 128,
};

export interface NodeShape {
  supported: string[];
  values: Array<Record<string, unknown>>;
  endpoints?: number[];
}

const SINGLE = Object.keys(SHAPE_CC);

const COMBOS: string[][] = [
  [],
  ['Battery'],
  ['Multilevel Switch'],
  ['Multilevel Switch', 'Battery'],
  ['Binary Switch'],
  ['Binary Switch', 'Battery'],
  ['Color Switch', 'Multilevel Switch'],
  ['Color Switch', 'Multilevel Switch', 'Binary Switch'],
  ['Thermostat Mode', 'Multilevel Sensor'],
  ['Thermostat Mode', 'Multilevel Sensor', 'Binary Switch'],
  ['Window Covering'],
  ['Window Covering', 'Multilevel Switch'],
  ['Barrier Operator'],
  ['Door Lock'],
  ['Lock'],
  ['Door Lock', 'Notification'],
  ['Sound Switch'],
  ['Sound Switch', 'Binary Switch'],
  ['Central Scene'],
  ['Central Scene', 'Battery'],
  ['Multilevel Sensor'],
  ['Multilevel Sensor', 'Battery'],
  ['Notification'],
  ['Binary Sensor'],
  ['Multilevel Sensor', 'Binary Sensor', 'Battery'],
  ['Binary Switch', 'Binary Sensor'],
  ...SINGLE.map((name) => [name]),
];

const BINARY_PROPS: Array<string | undefined> = [
  undefined,
  'Water',
  'Smoke',
  'CO',
  'CO2',
  'Motion',
  'Any',
  'Door/Window',
];

const NOTIFICATION_PROPS: Array<Record<string, unknown> | undefined> = [
  undefined,
  { property: 'Water Alarm', propertyKey: 'Water leak status' },
  { property: 'Home Security', propertyKey: 'Motion sensor status' },
  { property: 'Access Control', propertyKey: 'Door status' },
  { property: 'Smoke Alarm' },
  { property: 'Carbon Monoxide Alarm' },
];

export const CLASSIFICATION_SHAPES: NodeShape[] = (() => {
  const shapes: NodeShape[] = [];
  for (const supported of COMBOS) {
    for (const binary of BINARY_PROPS) {
      for (const notification of NOTIFICATION_PROPS) {
        const values: Array<Record<string, unknown>> = [];
        if (binary) {
          values.push({ commandClass: SHAPE_CC['Binary Sensor'], endpoint: 0, property: binary });
        }
        if (notification) {
          values.push({ commandClass: SHAPE_CC.Notification, endpoint: 0, ...notification });
        }
        shapes.push({ supported, values });
      }
    }
  }
  // Two multi-endpoint shapes, covering the root-suppression path.
  shapes.push({ supported: ['Binary Switch'], values: [], endpoints: [0, 1, 2] });
  shapes.push({ supported: ['Multilevel Switch', 'Battery'], values: [], endpoints: [0, 1] });
  return shapes;
})();
