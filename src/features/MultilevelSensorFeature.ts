import { Service, CharacteristicGetCallback } from 'homebridge';
import { BaseFeature } from './ZWaveFeature';

export class MultilevelSensorFeature extends BaseFeature {
  private tempService: Service | undefined;
  private humidityService: Service | undefined;
  private lightService: Service | undefined;

  init(): void {
    const subType = this.endpoint.index.toString();
    
    if (this.hasSensorType('Air temperature')) {
      this.tempService = this.getService(this.platform.Service.TemperatureSensor, undefined, subType);
      this.tempService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .on('get', (cb) => this.handleGetSensorValue('Air temperature', cb));
    }

    if (this.hasSensorType('Humidity')) {
      this.humidityService = this.getService(this.platform.Service.HumiditySensor, undefined, subType);
      this.humidityService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .on('get', (cb) => this.handleGetSensorValue('Humidity', cb));
    }

    if (this.hasSensorType('Illuminance')) {
      this.lightService = this.getService(this.platform.Service.LightSensor, undefined, subType);
      this.lightService.getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
        .on('get', (cb) => this.handleGetSensorValue('Illuminance', cb));
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
