import { Service, CharacteristicGetCallback } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class MultilevelSensorFeature extends BaseFeature {
  private tempService: Service | undefined;
  private humidityService: Service | undefined;
  private lightService: Service | undefined;
  private airQualityService: Service | undefined;

  init(): void {
    const subType = this.endpoint.index.toString();
    
    if (this.hasSensorType('Air temperature')) {
      this.tempService = this.getService(this.platform.Service.TemperatureSensor, undefined, subType);
      this.tempService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(() => this.getSensorValue('Air temperature') ?? 0);
    }

    if (this.hasSensorType('Humidity')) {
      this.humidityService = this.getService(this.platform.Service.HumiditySensor, undefined, subType);
      this.humidityService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.getSensorValue('Humidity') ?? 0);
    }

    if (this.hasSensorType('Illuminance')) {
      this.lightService = this.getService(this.platform.Service.LightSensor, undefined, subType);
      this.lightService.getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
        .onGet(() => this.getSensorValue('Illuminance') ?? 0.0001);
    }

    // Air Quality Group
    if (this.hasSensorType('Carbon dioxide (CO2) level') || this.hasSensorType('Volatile Organic Compound level') || this.hasSensorType('Particulate Matter 2.5')) {
        this.airQualityService = this.getService(this.platform.Service.AirQualitySensor, undefined, subType);
        
        // Main State (Derived from PM2.5 or CO2)
        this.airQualityService.getCharacteristic(this.platform.Characteristic.AirQuality)
            .onGet(this.handleGetAirQuality.bind(this));

        if (this.hasSensorType('Carbon dioxide (CO2) level')) {
            this.airQualityService.getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)
                .onGet(() => this.getSensorValue('Carbon dioxide (CO2) level') ?? 0);
        }
        if (this.hasSensorType('Volatile Organic Compound level')) {
            this.airQualityService.getCharacteristic(this.platform.Characteristic.VOCDensity)
                .onGet(() => this.getSensorValue('Volatile Organic Compound level') ?? 0);
        }
        if (this.hasSensorType('Particulate Matter 2.5')) {
            this.airQualityService.getCharacteristic(this.platform.Characteristic.PM2_5Density)
                .onGet(() => this.getSensorValue('Particulate Matter 2.5') ?? 0);
        }
    }
  }

  update(): void {
    if (this.tempService) {
      const val = this.getSensorValue('Air temperature');
      if (val !== undefined) this.tempService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, val);
    }
    if (this.humidityService) {
      const val = this.getSensorValue('Humidity');
      if (val !== undefined) this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, val);
    }
    if (this.lightService) {
      const val = this.getSensorValue('Illuminance');
      if (val !== undefined) this.lightService.updateCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel, val);
    }
    if (this.airQualityService) {
        this.airQualityService.updateCharacteristic(this.platform.Characteristic.AirQuality, this.handleGetAirQuality());
        
        const co2 = this.getSensorValue('Carbon dioxide (CO2) level');
        if (co2 !== undefined) this.airQualityService.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, co2);
        
        const voc = this.getSensorValue('Volatile Organic Compound level');
        if (voc !== undefined) this.airQualityService.updateCharacteristic(this.platform.Characteristic.VOCDensity, voc);

        const pm25 = this.getSensorValue('Particulate Matter 2.5');
        if (pm25 !== undefined) this.airQualityService.updateCharacteristic(this.platform.Characteristic.PM2_5Density, pm25);
    }
  }

  private handleGetAirQuality(): number {
      // Simplified logic
      const co2 = this.getSensorValue('Carbon dioxide (CO2) level');
      const pm25 = this.getSensorValue('Particulate Matter 2.5');

      if (co2 && co2 > 1000) return this.platform.Characteristic.AirQuality.POOR;
      if (pm25 && pm25 > 25) return this.platform.Characteristic.AirQuality.POOR;
      
      return this.platform.Characteristic.AirQuality.EXCELLENT;
  }

  private hasSensorType(propertyName: string): boolean {
    const values = this.node.getDefinedValueIDs();
    return values.some(v => v.commandClass === 49 && v.property === propertyName && v.endpoint === this.endpoint.index);
  }

  private getSensorValue(propertyName: string): number | undefined {
    const valueId = {
      commandClass: 49,
      property: propertyName,
      endpoint: this.endpoint.index,
    };
    const val = this.node.getValue(valueId);
    
    if (typeof val === 'number') {
      if (propertyName === 'Air temperature') {
        const meta = this.node.getValueMetadata(valueId);
        if (meta && (meta as { unit?: string }).unit === '°F') {
          return (val - 32) * 5 / 9;
        }
      }
      return val;
    }
    return undefined;
  }

  private async handleGetSensorValue(propertyName: string, callback: CharacteristicGetCallback) {
    callback(null, this.getSensorValue(propertyName) ?? 0);
  }
}
