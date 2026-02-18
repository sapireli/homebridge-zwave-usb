import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * ColorSwitchFeature handles RGB and White channels for Z-Wave lights.
 */
export class ColorSwitchFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Lightbulb, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleGetOn.bind(this))
      .onSet(this.handleSetOn.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(this.handleGetHue.bind(this))
      .onSet(this.handleSetHue.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(this.handleGetSaturation.bind(this))
      .onSet(this.handleSetSaturation.bind(this));

    if (!this.service.testCharacteristic(this.platform.Characteristic.Brightness)) {
      this.service.addCharacteristic(this.platform.Characteristic.Brightness);
    }
    this.service
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(this.handleGetBrightness.bind(this))
      .onSet(this.handleSetBrightness.bind(this));
  }

  update(args?: ZWaveValueEvent): void {
    if (
      !this.shouldUpdate(args, CommandClasses['Color Switch']) &&
      !this.shouldUpdate(args, CommandClasses['Multilevel Switch'])
    ) {
      return;
    }
    const isOn = this.handleGetOn();
    const hue = this.handleGetHue();
    const sat = this.handleGetSaturation();
    const bri = this.handleGetBrightness();

    this.service.updateCharacteristic(this.platform.Characteristic.On, isOn);
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, hue);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, sat);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, bri);
  }

  private handleGetOn(): boolean {
    const bri = this.node.getValue({
      commandClass: CommandClasses['Multilevel Switch'],
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    return typeof bri === 'number' && bri > 0;
  }

  private async handleSetOn(value: CharacteristicValue) {
    const targetValue = value ? 255 : 0;
    try {
      await this.node.setValue(
        {
          commandClass: CommandClasses['Multilevel Switch'],
          property: 'targetValue',
          endpoint: this.endpoint.index,
        },
        targetValue,
      );
    } catch (err) {
      this.platform.log.error('Failed to set On/Off:', err);
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  private handleGetBrightness(): number {
    const bri = this.node.getValue({
      commandClass: CommandClasses['Multilevel Switch'],
      property: 'currentValue',
      endpoint: this.endpoint.index,
    });
    return typeof bri === 'number' ? Math.min(bri, 100) : 100;
  }

  private async handleSetBrightness(value: CharacteristicValue) {
    try {
      await this.node.setValue(
        {
          commandClass: CommandClasses['Multilevel Switch'],
          property: 'targetValue',
          endpoint: this.endpoint.index,
        },
        value,
      );
    } catch (err) {
      this.platform.log.error('Failed to set brightness:', err);
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  private handleGetHue(): number {
    const color = this.node.getValue({
      commandClass: CommandClasses['Color Switch'],
      property: 'currentColor',
      endpoint: this.endpoint.index,
    }) as Record<string, number>;

    if (color && typeof color === 'object') {
      if ((color.warmWhite || 0) > 0 || (color.coldWhite || 0) > 0) {
        return 0;
      }
      const { r, g, b } = this.zwaveColorToRgb(color);
      const [h] = this.rgbToHsl(r, g, b);
      return h;
    }
    return 0;
  }

  private handleGetSaturation(): number {
    const color = this.node.getValue({
      commandClass: CommandClasses['Color Switch'],
      property: 'currentColor',
      endpoint: this.endpoint.index,
    }) as Record<string, number>;

    if (color && typeof color === 'object') {
      if ((color.warmWhite || 0) > 0 || (color.coldWhite || 0) > 0) {
        return 0;
      }
      const { r, g, b } = this.zwaveColorToRgb(color);
      const [, s] = this.rgbToHsl(r, g, b);
      return s;
    }
    return 0;
  }

  private zwaveColorToRgb(color: Record<string, number>): {
    r: number;
    g: number;
    b: number;
  } {
    return {
      r: color.red || 0,
      g: color.green || 0,
      b: color.blue || 0,
    };
  }

  private async handleSetHue(value: CharacteristicValue) {
    await this.setLinkColor(value as number, this.handleGetSaturation());
  }

  private async handleSetSaturation(value: CharacteristicValue) {
    await this.setLinkColor(this.handleGetHue(), value as number);
  }

  private async setLinkColor(hue: number, saturation: number) {
    try {
      const brightness = this.handleGetBrightness();
      const intensity = Math.round((brightness / 100) * 255);

      /**
       * RGBW HANDLING: If saturation is low, we prioritize White channels.
       */
      if (saturation < 5) {
        const meta = this.node.getValueMetadata({
          commandClass: CommandClasses['Color Switch'],
          property: 'targetColor',
          endpoint: this.endpoint.index,
        }) as { states?: Record<string, string> };

        const targetColor: Record<string, number> = { red: 0, green: 0, blue: 0 };
        let hasWhite = false;

        // Check for warmWhite or coldWhite support in metadata
        if (meta && meta.states) {
          const components = Object.values(meta.states).map((s) => s.toLowerCase());
          if (components.includes('warm white')) {
            targetColor.warmWhite = intensity;
            hasWhite = true;
          } else if (components.includes('cold white')) {
            targetColor.coldWhite = intensity;
            hasWhite = true;
          }
        }

        if (!hasWhite) {
          // Fallback to RGB White if no white channels are supported
          targetColor.red = intensity;
          targetColor.green = intensity;
          targetColor.blue = intensity;
        }

        await this.node.setValue(
          {
            commandClass: CommandClasses['Color Switch'],
            property: 'targetColor',
            endpoint: this.endpoint.index,
          },
          targetColor,
        );
        return;
      }

      const { r, g, b } = this.hslToRgb(hue, saturation, 50);
      await this.node.setValue(
        {
          commandClass: CommandClasses['Color Switch'],
          property: 'targetColor',
          endpoint: this.endpoint.index,
        },
        { red: r, green: g, blue: b, warmWhite: 0, coldWhite: 0 },
      );
    } catch (err) {
      this.platform.log.error('Failed to set color:', err);
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  // --- Helpers ---
  private rgbToHsl(r: number, g: number, b: number) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    let h = 0,
      s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
      }
      h /= 6;
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
  }

  private hslToRgb(h: number, s: number, l: number) {
    h /= 360;
    s /= 100;
    l /= 100;
    let r, g, b;

    if (s === 0) {
      r = g = b = l; // achromatic
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) {
          t += 1;
        }
        if (t > 1) {
          t -= 1;
        }
        if (t < 1 / 6) {
          return p + (q - p) * 6 * t;
        }
        if (t < 1 / 2) {
          return q;
        }
        if (t < 2 / 3) {
          return p + (q - p) * (2 / 3 - t) * 6;
        }
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255),
    };
  }
}
