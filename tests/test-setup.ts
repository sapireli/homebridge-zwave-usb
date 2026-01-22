jest.mock('zwave-js', () => {
  const originalModule = jest.requireActual('zwave-js');

  return {
    ...originalModule,
    Driver: jest.fn().mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      destroy: jest.fn(),
      controller: {
        nodes: new Map(),
        on: jest.fn(),
      },
    })),
    ZWaveNode: class {
      nodeId = 0;
      supportsCC() {
        return true;
      }
      getValue() {
        return true;
      }
      setValue() {}
      on() {}
    },
  };
});

