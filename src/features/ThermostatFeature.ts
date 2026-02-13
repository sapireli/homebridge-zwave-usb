import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';

export class ThermostatFeature extends BaseFeature {
  private service!: Service;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Thermostat, undefined, subType);

    // 1. Current Heating/Cooling State
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleGetCurrentState.bind(this));

    // 2. Target Heating/Cooling State
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleGetTargetState.bind(this))
      .onSet(this.handleSetTargetState.bind(this));

    // 3. Current Temperature (CC 49)
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleGetCurrentTemp.bind(this));

    // 4. Target Temperature (CC 67)
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.handleGetTargetTemp.bind(this))
      .onSet(this.handleSetTargetTemp.bind(this));

    // 5. Display Units (Default to Celsius as Z-Wave is native C usually, but we check metadata)
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleGetDisplayUnits.bind(this));
  }

  update(): void {
    this.updateCurrentState();
    this.updateTargetState();
    this.updateCurrentTemp();
    this.updateTargetTemp();
  }

  private updateCurrentState() {
    // We infer current state from the mode or operating state if available
    // CommandClasses['Thermostat Operating State'] is best, but CommandClasses['Thermostat Mode'] is acceptable fallback
    const opState = this.node.getValue({
      commandClass: CommandClasses['Thermostat Operating State'],
      property: 'state',
      endpoint: this.endpoint.index,
    });
    
    let state = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    if (typeof opState === 'number') {
        if (opState === 1) state = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        if (opState === 2) state = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    } else {
        // Fallback to Mode
        const mode = this.handleGetTargetState();
        if (mode === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) state = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        if (mode === this.platform.Characteristic.TargetHeatingCoolingState.COOL) state = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
        if (mode === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) state = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT; // Simplified
    }
    
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, state);
  }

  private handleGetCurrentState(): number {
    // Similar logic to updateCurrentState but sync return
    const opState = this.node.getValue({ commandClass: CommandClasses['Thermostat Operating State'], property: 'state', endpoint: this.endpoint.index });
    if (typeof opState === 'number') {
        if (opState === 1) return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
        if (opState === 2) return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    }
    return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  private updateTargetState() {
    const val = this.handleGetTargetState();
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, val);
  }

  private handleGetTargetState(): number {
    const mode = this.node.getValue({
      commandClass: CommandClasses['Thermostat Mode'],
      property: 'mode',
      endpoint: this.endpoint.index,
    });

    // Z-Wave Modes: 0=Off, 1=Heat, 2=Cool, 3=Auto
    switch (mode) {
      case 1: return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      case 2: return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      case 3: return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      default: return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  private async handleSetTargetState(value: CharacteristicValue) {
    let zwaveMode = 0; // Off
    switch (value) {
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT: zwaveMode = 1; break;
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL: zwaveMode = 2; break;
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO: zwaveMode = 3; break;
    }

    try {
      await this.node.setValue(
        { commandClass: CommandClasses['Thermostat Mode'], property: 'mode', endpoint: this.endpoint.index },
        zwaveMode
      );
    } catch (err) {
      this.platform.log.error('Failed to set thermostat mode:', err);
    }
  }

  private updateCurrentTemp() {
    const val = this.handleGetCurrentTemp();
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, val);
  }

  private handleGetCurrentTemp(): number {
    const val = this.node.getValue({
      commandClass: CommandClasses['Multilevel Sensor'],
      property: 'Air temperature',
      endpoint: this.endpoint.index,
    });

    if (typeof val === 'number') {
       // Check metadata for conversion
       const meta = this.node.getValueMetadata({ commandClass: CommandClasses['Multilevel Sensor'], property: 'Air temperature', endpoint: this.endpoint.index });
       if (meta && (meta as { unit?: string }).unit === '°F') {
         return (val - 32) * 5 / 9;
       }
       return val;
    }
    return 0; // Fallback
  }

  private updateTargetTemp() {
    const val = this.handleGetTargetTemp();
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, val);
  }

  private handleGetTargetTemp(): number {
    // Depends on mode. If Heat, get Setpoint 1. If Cool, get Setpoint 2.
    const mode = this.handleGetTargetState();
    let setpointType = 1; // Heating
    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.COOL) setpointType = 2;

    const val = this.node.getValue({
        commandClass: CommandClasses['Thermostat Setpoint'],
        property: 'setpoint',
        propertyKey: setpointType,
        endpoint: this.endpoint.index,
    });

    if (typeof val === 'number') {
        const meta = this.node.getValueMetadata({ 
            commandClass: CommandClasses['Thermostat Setpoint'], 
            property: 'setpoint', 
            propertyKey: setpointType, 
            endpoint: this.endpoint.index 
        });
        if (meta && (meta as { unit?: string }).unit === '°F') {
            return (val - 32) * 5 / 9;
        }
        return val;
    }
    return 20; // Default sensible Celsius
  }

  private async handleSetTargetTemp(value: CharacteristicValue) {
    const tempC = value as number;
    
    // Determine setpoint type based on current mode
    const mode = this.handleGetTargetState();
    let setpointType = 1;
    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.COOL) setpointType = 2;

    // Check unit to see if we need to convert back to F for the device
    const meta = this.node.getValueMetadata({ 
        commandClass: CommandClasses['Thermostat Setpoint'], 
        property: 'setpoint', 
        propertyKey: setpointType, 
        endpoint: this.endpoint.index 
    });
    
    let targetVal = tempC;
    if (meta && (meta as { unit?: string }).unit === '°F') {
        targetVal = (tempC * 9 / 5) + 32;
    }

    try {
        await this.node.setValue(
            { commandClass: CommandClasses['Thermostat Setpoint'], property: 'setpoint', propertyKey: setpointType, endpoint: this.endpoint.index },
            targetVal
        );
    } catch (err) {
        this.platform.log.error('Failed to set target temp:', err);
    }
  }

  private handleGetDisplayUnits(): number {
      // 0 = Celsius, 1 = Fahrenheit
      // Check metadata of air temp
      const meta = this.node.getValueMetadata({ commandClass: CommandClasses['Multilevel Sensor'], property: 'Air temperature', endpoint: this.endpoint.index });
      if (meta && (meta as { unit?: string }).unit === '°F') {
          return this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
      }
      return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }
}
