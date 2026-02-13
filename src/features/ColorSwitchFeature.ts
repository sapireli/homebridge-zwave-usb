import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';

export class ColorSwitchFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Lightbulb, undefined, subType);

    // Hue (0-360)
    this.service
      .getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(this.handleGetHue.bind(this))
      .onSet(this.handleSetHue.bind(this));

    // Saturation (0-100)
    this.service
      .getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(this.handleGetSaturation.bind(this))
      .onSet(this.handleSetSaturation.bind(this));
  }

  update(): void {
    const hue = this.handleGetHue();
    const sat = this.handleGetSaturation();
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, hue);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, sat);
  }

  private handleGetHue(): number {
    // CommandClasses['Color Switch']
    // currentColor: { red: 0, green: 0, blue: 0, warmWhite: 0 ... }
    // We need to convert RGB to HSL
    const color = this.node.getValue({
        commandClass: CommandClasses['Color Switch'],
        property: 'currentColor',
        endpoint: this.endpoint.index
    });

    if (color && typeof color === 'object') {
        const { r, g, b } = this.zwaveColorToRgb(color as Record<string, number>);
        const [h, ,] = this.rgbToHsl(r, g, b);
        return h;
    }
    return 0;
  }

  private handleGetSaturation(): number {
    const color = this.node.getValue({
        commandClass: CommandClasses['Color Switch'],
        property: 'currentColor',
        endpoint: this.endpoint.index
    });

    if (color && typeof color === 'object') {
        const { r, g, b } = this.zwaveColorToRgb(color as Record<string, number>);
        const [, s,] = this.rgbToHsl(r, g, b);
        return s;
    }
    return 0;
  }

  private zwaveColorToRgb(color: Record<string, number>): { r: number, g: number, b: number } {
      // Z-Wave JS returns a dict like { red: 255, green: 0, blue: 0 }
      return {
          r: color.red || 0,
          g: color.green || 0,
          b: color.blue || 0
      };
  }

  private async handleSetHue(value: CharacteristicValue) {
      this.setLinkColor(value as number, this.handleGetSaturation());
  }

  private async handleSetSaturation(value: CharacteristicValue) {
      this.setLinkColor(this.handleGetHue(), value as number);
  }

  private async setLinkColor(hue: number, saturation: number) {
      // Convert HSL -> RGB
      const { r, g, b } = this.hslToRgb(hue, saturation, 50); // Assume 50% lightness for full color
      
      try {
          await this.node.setValue(
              { commandClass: CommandClasses['Color Switch'], property: 'targetColor', endpoint: this.endpoint.index },
              { red: r, green: g, blue: b }
          );
      } catch (err) {
          this.platform.log.error('Failed to set color:', err);
      }
  }

  // --- Helpers ---
  private rgbToHsl(r: number, g: number, b: number) {
    r /= 255, g /= 255, b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
  }

  private hslToRgb(h: number, s: number, l: number) {
    h /= 360; s /= 100; l /= 100;
    let r, g, b;

    if (s === 0) {
      r = g = b = l; // achromatic
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }
}
