import { Service, CharacteristicValue } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class SirenFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    // Use Switch for v1 simplicity
    this.service = this.getService(this.platform.Service.Switch, 'Siren', subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleGetState.bind(this))
      .onSet(this.handleSetState.bind(this));
  }

  update(): void {
    const val = this.handleGetState();
    this.service.updateCharacteristic(this.platform.Characteristic.On, val);
  }

  private handleGetState(): boolean {
    // CC 121 (Sound Switch) - Tone Identifier
    // 0 = Off, >0 = On (Playing a tone)
    const val = this.node.getValue({
        commandClass: 121,
        property: 'toneId',
        endpoint: this.endpoint.index
    });

    if (typeof val === 'number') {
        return val > 0;
    }
    // Fallback: Binary Switch (some sirens use this)
    // Handled by BinarySwitchFeature usually, but if this feature is forced:
    const binVal = this.node.getValue({ commandClass: 37, property: 'currentValue', endpoint: this.endpoint.index });
    return !!binVal;
  }

  private async handleSetState(value: CharacteristicValue) {
    const on = value as boolean;

    try {
        await this.node.setValue(
            { commandClass: 121, property: 'toneId', endpoint: this.endpoint.index },
            on ? 255 : 0 // 255 = Default Tone
        );
    } catch (err) {
        this.platform.log.error('Failed to set siren state:', err);
    }
  }
}
