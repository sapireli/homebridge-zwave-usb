import { Service, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class LockFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.LockMechanism, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .on('get', this.handleGetLockCurrentState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.LockTargetState)
      .on('get', this.handleGetLockTargetState.bind(this))
      .on('set', this.handleSetLockTargetState.bind(this));
  }

  update(): void {
    const value = this.node.getValue({
      commandClass: 98,
      property: 'currentMode',
      endpoint: this.endpoint.index,
    });

    if (typeof value === 'number') {
      const state = this.mapZWaveToHomeKit(value);
      this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, state);
      
      const target = state === this.platform.Characteristic.LockCurrentState.SECURED 
          ? this.platform.Characteristic.LockTargetState.SECURED 
          : this.platform.Characteristic.LockTargetState.UNSECURED;
          
      this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, target);
    }
  }

  private mapZWaveToHomeKit(value: number): number {
    if (value === 255) return this.platform.Characteristic.LockCurrentState.SECURED;
    if (value === 0) return this.platform.Characteristic.LockCurrentState.UNSECURED;
    return this.platform.Characteristic.LockCurrentState.UNKNOWN;
  }

  private async handleGetLockCurrentState(callback: CharacteristicGetCallback) {
    const value = this.node.getValue({
      commandClass: 98,
      property: 'currentMode',
      endpoint: this.endpoint.index,
    });
    const state = typeof value === 'number' ? this.mapZWaveToHomeKit(value) : this.platform.Characteristic.LockCurrentState.UNKNOWN;
    callback(null, state);
  }

  private async handleGetLockTargetState(callback: CharacteristicGetCallback) {
    const value = this.node.getValue({
      commandClass: 98,
      property: 'targetMode',
      endpoint: this.endpoint.index,
    }) ?? this.node.getValue({
      commandClass: 98,
      property: 'currentMode',
      endpoint: this.endpoint.index,
    });

    const state = typeof value === 'number' ? this.mapZWaveToHomeKit(value) : this.platform.Characteristic.LockCurrentState.UNKNOWN;
    const target = state === this.platform.Characteristic.LockCurrentState.SECURED 
        ? this.platform.Characteristic.LockTargetState.SECURED 
        : this.platform.Characteristic.LockTargetState.UNSECURED;
        
    callback(null, target);
  }

  private async handleSetLockTargetState(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    const targetMode = value === this.platform.Characteristic.LockTargetState.SECURED ? 255 : 0;
    try {
      await this.node.setValue(
        { commandClass: 98, property: 'targetMode', endpoint: this.endpoint.index },
        targetMode,
      );
      callback(null);
    } catch (err) {
      this.platform.log.error(`Failed to set Lock Target for node ${this.node.nodeId} endpoint ${this.endpoint.index}:`, err);
      callback(err as Error);
    }
  }
}
