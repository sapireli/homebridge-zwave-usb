import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * SirenFeature supports sirens using 'Sound Switch' CC or 'Binary Switch' fallback.
 * It is exposed as a Fan to allow volume control via the RotationSpeed slider in the Apple Home app.
 */
export class SirenFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    // Use Lightbulb instead of Switch to get a native Brightness slider for Volume
    this.service = this.getService(this.platform.Service.Lightbulb, 'Siren', subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleGetState.bind(this))
      .onSet(this.handleSetState.bind(this));

    /**
     * VOLUME SUPPORT FIX: Add Brightness characteristic if Sound Switch is supported
     * to act as a Volume slider in the Apple Home app.
     */
    if (this.node.supportsCC(CommandClasses['Sound Switch'])) {
      if (!this.service.testCharacteristic(this.platform.Characteristic.Brightness)) {
        this.service.addCharacteristic(this.platform.Characteristic.Brightness);
      }
      this.service
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(this.handleGetVolume.bind(this))
        .onSet(this.handleSetVolume.bind(this));
    }
  }

  update(args?: ZWaveValueEvent): void {
    if (args) {
      if ((args.endpoint || 0) !== this.endpoint.index && args.endpoint !== 0) {
        return;
      }
      if (
        args.commandClass !== CommandClasses['Sound Switch'] &&
        args.commandClass !== CommandClasses['Binary Switch']
      ) {
        return;
      }
    }
    const onVal = this.handleGetState();
    this.service.updateCharacteristic(this.platform.Characteristic.On, onVal);

    if (this.node.supportsCC(CommandClasses['Sound Switch'])) {
      const volVal = this.handleGetVolume();
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, volVal);
    }
  }

  private handleGetVolume(): number {
    const targetEndpoint = this.endpoint.supportsCC(CommandClasses['Sound Switch']) ? this.endpoint.index : 0;
    const volume = this.node.getValue({
      commandClass: CommandClasses['Sound Switch'],
      property: 'defaultVolume',
      endpoint: targetEndpoint,
    });

    return typeof volume === 'number' ? volume : 100;
  }

  private async handleSetVolume(value: CharacteristicValue) {
    const volume = value as number;
    const targetEndpoint = this.endpoint.supportsCC(CommandClasses['Sound Switch']) ? this.endpoint.index : 0;
    try {
      await this.node.setValue(
        {
          commandClass: CommandClasses['Sound Switch'],
          property: 'defaultVolume',
          endpoint: targetEndpoint,
        },
        volume,
      );
    } catch (err) {
      this.platform.log.error('Failed to set siren volume:', err);
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  private handleGetState(): boolean {
    // 1. Try Sound Switch on this endpoint
    if (this.endpoint.supportsCC(CommandClasses['Sound Switch'])) {
      const toneId = this.node.getValue({
        commandClass: CommandClasses['Sound Switch'],
        property: 'toneId',
        endpoint: this.endpoint.index,
      });

      if (typeof toneId === 'number') {
        return toneId > 0;
      }
    }

    // 2. Fallback: Binary Switch
    if (this.endpoint.supportsCC(CommandClasses['Binary Switch'])) {
      const binVal = this.node.getValue({
        commandClass: CommandClasses['Binary Switch'],
        property: 'currentValue',
        endpoint: this.endpoint.index,
      });

      if (binVal !== undefined) {
        return !!binVal;
      }
    }

    if (this.node.ready === false || this.node.status === 3) {
      throw new this.platform.api.hap.HapStatusError(-70402);
    }

    return false;
  }

  private async handleSetState(value: CharacteristicValue) {
    const on = value as boolean;

    // Use Sound Switch if supported on this endpoint
    if (this.endpoint.supportsCC(CommandClasses['Sound Switch'])) {
      try {
        /**
         * TONE SELECTION FIX: We use Tone 1 as primary default,
         * but we check for value metadata to see if 255 (default) is valid.
         */
        const toneMetadata = this.node.getValueMetadata({
          commandClass: CommandClasses['Sound Switch'],
          property: 'toneId',
          endpoint: this.endpoint.index,
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const targetTone =
          on &&
          toneMetadata &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          typeof (toneMetadata as any).max === 'number' &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (toneMetadata as any).max === 255
            ? 255
            : on
              ? 1
              : 0;

        await this.node.setValue(
          {
            commandClass: CommandClasses['Sound Switch'],
            property: 'toneId',
            endpoint: this.endpoint.index,
          },
          targetTone,
        );
        return;
      } catch (err) {
        this.platform.log.error('Failed to set siren state (Sound Switch):', err);
        throw new this.platform.api.hap.HapStatusError(-70402);
      }
    }

    // Fallback to Binary Switch
    try {
      await this.node.setValue(
        {
          commandClass: CommandClasses['Binary Switch'],
          property: 'targetValue',
          endpoint: this.endpoint.index,
        },
        on,
      );
    } catch (err) {
      this.platform.log.error('Failed to set siren state (Binary Switch):', err);
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }
}
