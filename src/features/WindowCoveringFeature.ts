import { Service, CharacteristicValue } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class WindowCoveringFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.WindowCovering, undefined, subType);

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.handleGetCurrentPosition.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.handleGetTargetPosition.bind(this))
      .onSet(this.handleSetTargetPosition.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handleGetPositionState.bind(this));
  }

  update(): void {
    const current = this.handleGetCurrentPosition();
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, current);
    
    // Optimistically update target if it's vastly different? 
    // Usually Z-Wave JS reports intermediate values so we rely on that.
  }

  private handleGetCurrentPosition(): number {
    // 0 = Closed, 99 = Open.
    // Use CC 38 (Multilevel Switch) as generic cover, or CC 106
    const val = this.node.getValue({
        commandClass: 38,
        property: 'currentValue',
        endpoint: this.endpoint.index
    });

    if (val === undefined) {
       // Try CC 106?
       // Not common in JS yet, usually mapped to Multilevel
    }

    if (typeof val === 'number') {
        if (val === 99) return 100;
        return val;
    }
    return 0;
  }

  private handleGetTargetPosition(): number {
    const val = this.node.getValue({
        commandClass: 38,
        property: 'targetValue',
        endpoint: this.endpoint.index
    });
    
    if (typeof val === 'number') {
        if (val === 99) return 100;
        return val;
    }
    // Fallback to current
    return this.handleGetCurrentPosition();
  }

  private async handleSetTargetPosition(value: CharacteristicValue) {
    const target = value as number;
    let zwaveVal = target;
    if (target === 100) zwaveVal = 99;

    try {
        await this.node.setValue(
            { commandClass: 38, property: 'targetValue', endpoint: this.endpoint.index },
            zwaveVal
        );
    } catch (err) {
        this.platform.log.error('Failed to set window covering position:', err);
    }
  }

  private handleGetPositionState(): number {
    // 0 = Decreasing, 1 = Increasing, 2 = Stopped
    // Z-Wave JS "duration" might tell us if moving?
    // Or inferred from target vs current.
    const current = this.handleGetCurrentPosition();
    const target = this.handleGetTargetPosition();

    if (current < target) return this.platform.Characteristic.PositionState.INCREASING;
    if (current > target) return this.platform.Characteristic.PositionState.DECREASING;
    return this.platform.Characteristic.PositionState.STOPPED;
  }
}
