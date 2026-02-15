import { Service, CharacteristicValue } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * ThermostatFeature implements a standard HomeKit Thermostat.
 * It maps Z-Wave Thermostat Mode, Setpoint, and Operating State to HomeKit.
 */
export class ThermostatFeature extends BaseFeature {
  private service!: Service;
  private lastKnownTemp?: number;

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Thermostat, undefined, subType);

    // 1. Current Heating/Cooling State
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleGetCurrentState.bind(this));

    // 2. Target Heating/Cooling State
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleGetTargetState.bind(this))
      .onSet(this.handleSetTargetState.bind(this));

    // 3. Current Temperature (CC 49)
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleGetCurrentTemp.bind(this));

    // 4. Target Temperature (Main setpoint for HEAT/COOL modes)
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.handleGetTargetTemp.bind(this))
      .onSet(this.handleSetTargetTemp.bind(this));

    // 5. Dual Setpoints for AUTO mode
    this.service
      .getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onGet(() => this.getSetpoint(1)) // 1 = Heating
      .onSet((val) => this.setSetpoint(1, val));

    this.service
      .getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onGet(() => this.getSetpoint(2)) // 2 = Cooling
      .onSet((val) => this.setSetpoint(2, val));

    // 6. Display Units
    this.service
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleGetDisplayUnits.bind(this));
  }

  update(args?: ZWaveValueEvent): void {
    if (args) {
      if ((args.endpoint || 0) !== this.endpoint.index) {
        return;
      }
      const relevant = [
        CommandClasses['Thermostat Operating State'],
        CommandClasses['Thermostat Mode'],
        CommandClasses['Thermostat Setpoint'],
        CommandClasses['Multilevel Sensor'],
      ];
      if (!relevant.includes(args.commandClass)) {
        return;
      }
    }
    this.updateCurrentState();
    this.updateTargetState();
    this.updateCurrentTemp();
    this.updateTargetTemp();

    // Update threshold characteristics for AUTO mode
    const mode = this.handleGetTargetState();
    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.HeatingThresholdTemperature,
        this.getSetpoint(1),
      );
      this.service.updateCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature,
        this.getSetpoint(2),
      );
    }
  }

  private updateCurrentState() {
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHeatingCoolingState,
      this.handleGetCurrentState(),
    );
  }

  private handleGetCurrentState(): number {
    const opState = this.node.getValue({
      commandClass: CommandClasses['Thermostat Operating State'],
      property: 'state',
      endpoint: this.endpoint.index,
    });

    if (typeof opState === 'number') {
      if (opState === 1) {
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      }
      if (opState === 2) {
        return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      }
      if (opState === 0) {
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
      }
    }

    // Fallback: Infer from target mode if operating state is unsupported
    const mode = this.handleGetTargetState();
    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
    }
    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.COOL) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    }

    return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  private updateTargetState() {
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetHeatingCoolingState,
      this.handleGetTargetState(),
    );
  }

  private handleGetTargetState(): number {
    const mode = this.node.getValue({
      commandClass: CommandClasses['Thermostat Mode'],
      property: 'mode',
      endpoint: this.endpoint.index,
    });

    // Z-Wave Modes: 0=Off, 1=Heat, 2=Cool, 3=Auto
    if (mode === 0) {
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
    switch (mode) {
      case 1:
        return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      case 2:
        return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      case 3:
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      default:
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  private async handleSetTargetState(value: CharacteristicValue) {
    let zwaveMode = 0; // Off
    switch (value) {
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        zwaveMode = 1;
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        zwaveMode = 2;
        break;
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        zwaveMode = 3;
        break;
    }

    try {
      await this.node.setValue(
        {
          commandClass: CommandClasses['Thermostat Mode'],
          property: 'mode',
          endpoint: this.endpoint.index,
        },
        zwaveMode,
      );

      /**
       * MODE DESYNC FIX: Optimistically update current state to match target.
       */
      const currentState =
        value === this.platform.Characteristic.TargetHeatingCoolingState.OFF
          ? this.platform.Characteristic.CurrentHeatingCoolingState.OFF
          : value === this.platform.Characteristic.TargetHeatingCoolingState.COOL
            ? this.platform.Characteristic.CurrentHeatingCoolingState.COOL
            : this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;

      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState,
        currentState,
      );
    } catch (err) {
      this.platform.log.error('Failed to set thermostat mode:', err);
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  private updateCurrentTemp() {
    try {
      const val = this.handleGetCurrentTemp();
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, val);
    } catch {
      // Ignore errors during background update
    }
  }

  private handleGetCurrentTemp(): number {
    const val = this.node.getValue({
      commandClass: CommandClasses['Multilevel Sensor'],
      property: 'Air temperature',
      endpoint: this.endpoint.index,
    });

    if (typeof val === 'number') {
      const meta = this.node.getValueMetadata({
        commandClass: CommandClasses['Multilevel Sensor'],
        property: 'Air temperature',
        endpoint: this.endpoint.index,
      });
      const tempC = meta && (meta as { unit?: string }).unit === '°F' ? ((val - 32) * 5) / 9 : val;
      // ROUNDING FIX: Round to 1 decimal place
      const rounded = Math.round(tempC * 10) / 10;
      this.lastKnownTemp = rounded;
      return rounded;
    }

    if (this.lastKnownTemp !== undefined) {
      return this.lastKnownTemp;
    }

    throw new this.platform.api.hap.HapStatusError(-70402); // SERVICE_COMMUNICATION_FAILURE
  }

  private updateTargetTemp() {
    const mode = this.handleGetTargetState();
    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
      return;
    }
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetTemperature,
      this.handleGetTargetTemp(),
    );
  }

  private handleGetTargetTemp(): number {
    const mode = this.handleGetTargetState();

    /**
     * THERMOSTAT AUTO FIX: In Auto mode, HomeKit expects a single target temperature.
     * We return the midpoint of our dual thresholds to provide a stable UI value.
     */
    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
      const heat = this.getSetpoint(1);
      const cool = this.getSetpoint(2);
      return Math.round(((heat + cool) / 2) * 10) / 10;
    }

    const setpointType =
      mode === this.platform.Characteristic.TargetHeatingCoolingState.COOL ? 2 : 1;
    return this.getSetpoint(setpointType);
  }

  private async handleSetTargetTemp(value: CharacteristicValue) {
    const mode = this.handleGetTargetState();

    /**
     * THERMOSTAT AUTO FIX: Shift the existing range instead of collapsing it.
     */
    if (mode === this.platform.Characteristic.TargetHeatingCoolingState.AUTO) {
      const currentTarget = this.handleGetTargetTemp();
      const diff = (value as number) - currentTarget;

      const heatMeta = this.node.getValueMetadata({
        commandClass: CommandClasses['Thermostat Setpoint'],
        property: 'setpoint',
        propertyKey: 1,
        endpoint: this.endpoint.index,
      }) as { min?: number; max?: number; unit?: string };

      const coolMeta = this.node.getValueMetadata({
        commandClass: CommandClasses['Thermostat Setpoint'],
        property: 'setpoint',
        propertyKey: 2,
        endpoint: this.endpoint.index,
      }) as { min?: number; max?: number; unit?: string };

      let newHeat = this.getSetpoint(1) + diff;
      let newCool = this.getSetpoint(2) + diff;

      /**
       * ROBUST SHIFTING FIX:
       * 1. Clamp to hardware limits.
       */
      if (heatMeta && heatMeta.min !== undefined) {
        const minC = heatMeta.unit === '°F' ? ((heatMeta.min - 32) * 5) / 9 : heatMeta.min;
        newHeat = Math.max(newHeat, minC);
      }
      if (heatMeta && heatMeta.max !== undefined) {
        const maxC = heatMeta.unit === '°F' ? ((heatMeta.max - 32) * 5) / 9 : heatMeta.max;
        newHeat = Math.min(newHeat, maxC);
      }
      if (coolMeta && coolMeta.min !== undefined) {
        const minC = coolMeta.unit === '°F' ? ((coolMeta.min - 32) * 5) / 9 : coolMeta.min;
        newCool = Math.max(newCool, minC);
      }
      if (coolMeta && coolMeta.max !== undefined) {
        const maxC = coolMeta.unit === '°F' ? ((coolMeta.max - 32) * 5) / 9 : coolMeta.max;
        newCool = Math.min(newCool, maxC);
      }

      /**
       * 2. Enforce 0.5C deadband.
       * If shifting up pushed cool into its limit, pull heat back.
       * If shifting down pushed heat into its limit, pull cool back.
       */
      if (newCool < newHeat + 0.5) {
        if (diff > 0) {
          newHeat = newCool - 0.5;
        } else {
          newCool = newHeat + 0.5;
        }
      }

      await Promise.all([this.setSetpoint(1, newHeat), this.setSetpoint(2, newCool)]);
    } else {
      const setpointType =
        mode === this.platform.Characteristic.TargetHeatingCoolingState.COOL ? 2 : 1;
      await this.setSetpoint(setpointType, value);
    }
  }

  private getSetpoint(setpointType: number): number {
    const valueId = {
      commandClass: CommandClasses['Thermostat Setpoint'],
      property: 'setpoint',
      propertyKey: setpointType,
      endpoint: this.endpoint.index,
    };
    const val = this.node.getValue(valueId);

    if (typeof val === 'number') {
      /**
       * UNIT FIX: Check the unit metadata for the SPECIFIC setpoint value.
       */
      const meta = this.node.getValueMetadata(valueId);
      const tempC = meta && (meta as { unit?: string }).unit === '°F' ? ((val - 32) * 5) / 9 : val;
      /**
       * ROUNDING FIX: Standardize getter to 0.5 precision to match the setter.
       * This prevents UI jumping where 20.1 becomes 20.0 or 20.5 when touched.
       */
      return Math.round(tempC * 2) / 2;
    }
    return 20; // Default fallback
  }

  private async setSetpoint(setpointType: number, value: CharacteristicValue) {
    const tempC = value as number;
    const valueId = {
      commandClass: CommandClasses['Thermostat Setpoint'],
      property: 'setpoint',
      propertyKey: setpointType,
      endpoint: this.endpoint.index,
    };
    const meta = this.node.getValueMetadata(valueId);

    /**
     * UNIT FIX: Check the unit metadata for the SPECIFIC setpoint value.
     * ROUNDING FIX: Round to 0.5 precision for both C and F to ensure
     * better compatibility with hardware and HomeKit UI.
     */
    const targetVal =
      meta && (meta as { unit?: string }).unit === '°F'
        ? Math.round(((tempC * 9) / 5 + 32) * 2) / 2
        : Math.round(tempC * 2) / 2;

    try {
      await this.node.setValue(valueId, targetVal);
    } catch (err) {
      this.platform.log.error(`Failed to set thermostat setpoint ${setpointType}:`, err);
      throw new this.platform.api.hap.HapStatusError(-70402);
    }
  }

  private handleGetDisplayUnits(): number {
    const meta = this.node.getValueMetadata({
      commandClass: CommandClasses['Multilevel Sensor'],
      property: 'Air temperature',
      endpoint: this.endpoint.index,
    });
    if (meta && (meta as { unit?: string }).unit === '°F') {
      return this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    }
    return this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
  }
}
