const {
  normalizeSecurityKey,
  getInvalidSecurityKeyFields,
  buildPluginConfig,
} = require('../homebridge-ui/public/ui-helpers.js');

describe('homebridge-ui security key helpers', () => {
  it('should normalize keys by trimming whitespace and uppercasing hex', () => {
    expect(normalizeSecurityKey(' abcd1234 ')).toBe('ABCD1234');
  });

  it('should flag non-empty keys that are not 32 hex characters', () => {
    const invalid = getInvalidSecurityKeyFields({
      S0_Legacy: '1234',
      S2_Authenticated: 'G'.repeat(32),
      S2_AccessControl: 'A'.repeat(32),
    });

    expect(invalid).toEqual(['S0_Legacy', 'S2_Authenticated']);
  });

  it('should preserve the last valid security keys when current form input is invalid', () => {
    const currentConfig = {
      platform: 'ZWaveUSB',
      name: 'Plugin',
      securityKeys: {
        S0_Legacy: 'A'.repeat(32),
      },
    };

    const result = buildPluginConfig(currentConfig, {
      name: 'Plugin',
      serialPort: '/dev/tty',
      inclusionTimeoutSeconds: 60,
      debug: false,
      securityKeys: {
        S0_Legacy: '1234',
        S2_Authenticated: '',
      },
    });

    expect(result.invalidSecurityKeyFields).toEqual(['S0_Legacy']);
    expect(result.config.securityKeys).toEqual(currentConfig.securityKeys);
  });

  it('should commit normalized valid security keys into the plugin config', () => {
    const result = buildPluginConfig({}, {
      name: 'Plugin',
      serialPort: '/dev/tty',
      inclusionTimeoutSeconds: 60,
      debug: true,
      securityKeys: {
        S2_Authenticated: 'ab'.repeat(16),
        S2_AccessControl_LR: '',
      },
    });

    expect(result.invalidSecurityKeyFields).toEqual([]);
    expect(result.config.securityKeys).toEqual({
      S0_Legacy: '',
      S2_Unauthenticated: '',
      S2_Authenticated: 'AB'.repeat(16),
      S2_AccessControl: '',
      S2_Authenticated_LR: '',
      S2_AccessControl_LR: '',
    });
  });
});
