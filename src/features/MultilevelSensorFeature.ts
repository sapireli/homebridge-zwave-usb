import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * MultilevelSensorFeature handles environmental sensors (Temp, Humidity, light).
 */
export class MultilevelSensorFeature extends BaseFeature {
  private tempService: Service | undefined;
  private humidityService: Service | undefined;
  private lightService: Service | undefined;
  private airQualityService: Service | undefined;
  public skipTemperature = false;

  init(): void {
    const subType = this.endpoint.index.toString();

    if (this.hasSensorType('Air temperature') && !this.skipTemperature) {
      this.tempService = this.getService(this.platform.Service.TemperatureSensor, undefined, subType);
      this.tempService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(() => this.getSensorValue('Air temperature') ?? 0);
    }

    if (this.hasSensorType('Humidity')) {
      this.humidityService = this.getService(this.platform.Service.HumiditySensor, undefined, subType);
      this.humidityService
        .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.getSensorValue('Humidity') ?? 0);
    }

    if (this.hasSensorType('Illuminance')) {
      this.lightService = this.getService(this.platform.Service.LightSensor, undefined, subType);
      this.lightService
        .getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
        .onGet(() => Math.max(this.getSensorValue('Illuminance') ?? 0.0001, 0.0001));
    }

    // Air Quality Group
    if (
      this.hasSensorType('Carbon dioxide (CO2) level') ||
      this.hasSensorType('Volatile Organic Compound level') ||
      this.hasSensorType('Particulate Matter 2.5')
    ) {
      this.airQualityService = this.getService(
        this.platform.Service.AirQualitySensor,
        undefined,
        subType,
      );

      // Main State (Derived from PM2.5 or CO2)
      this.airQualityService
        .getCharacteristic(this.platform.Characteristic.AirQuality)
        .onGet(this.handleGetAirQuality.bind(this));

      if (this.hasSensorType('Carbon dioxide (CO2) level')) {
        this.airQualityService
          .getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)
          .onGet(() => this.getSensorValue('Carbon dioxide (CO2) level') ?? 0);
      }
      if (this.hasSensorType('Volatile Organic Compound level')) {
        this.airQualityService
          .getCharacteristic(this.platform.Characteristic.VOCDensity)
          .onGet(() => this.getSensorValue('Volatile Organic Compound level') ?? 0);
      }
      if (this.hasSensorType('Particulate Matter 2.5')) {
        this.airQualityService
          .getCharacteristic(this.platform.Characteristic.PM2_5Density)
          .onGet(() => this.getSensorValue('Particulate Matter 2.5') ?? 0);
      }
    }
  }

  update(args?: ZWaveValueEvent): void {
    if (!this.shouldUpdate(args, CommandClasses['Multilevel Sensor'])) {
      return;
    }
    if (this.tempService) {
      const val = this.getSensorValue('Air temperature');
      if (val !== undefined) {
        this.tempService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, val);
      }
    }
    if (this.humidityService) {
      const val = this.getSensorValue('Humidity');
      if (val !== undefined) {
        this.humidityService.updateCharacteristic(
          this.platform.Characteristic.CurrentRelativeHumidity,
          val,
        );
      }
    }
    if (this.lightService) {
      const val = this.getSensorValue('Illuminance');
      if (val !== undefined) {
        this.lightService.updateCharacteristic(
          this.platform.Characteristic.CurrentAmbientLightLevel,
          Math.max(val, 0.0001),
        );
      }
    }
    if (this.airQualityService) {
      try {
        this.airQualityService.updateCharacteristic(
          this.platform.Characteristic.AirQuality,
          this.handleGetAirQuality(),
        );
      } catch {
        // Ignore background update errors for air quality
      }

      const co2 = this.getSensorValue('Carbon dioxide (CO2) level');
      if (co2 !== undefined) {
        this.airQualityService.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, co2);
      }

      const voc = this.getSensorValue('Volatile Organic Compound level');
      if (voc !== undefined) {
        this.airQualityService.updateCharacteristic(this.platform.Characteristic.VOCDensity, voc);
      }

      const pm25 = this.getSensorValue('Particulate Matter 2.5');
      if (pm25 !== undefined) {
        this.airQualityService.updateCharacteristic(
          this.platform.Characteristic.PM2_5Density,
          pm25,
        );
      }
    }
  }

  private handleGetAirQuality(): number {
    const co2 = this.getSensorValue('Carbon dioxide (CO2) level');
    const pm25 = this.getSensorValue('Particulate Matter 2.5');
    const voc = this.getSensorValue('Volatile Organic Compound level');

    // Handle binary CO2 sensor if present
    const binaryCo2 = this.node.getValue({
      commandClass: CommandClasses['Binary Sensor'],
      property: 'CO2',
      endpoint: this.endpoint.index,
    });

    if (co2 === undefined && pm25 === undefined && binaryCo2 === undefined && voc === undefined) {
      if (this.node.ready === false || this.node.status === 3) {
        throw new this.platform.api.hap.HapStatusError(-70402);
      }
      if (this.platform.Characteristic.AirQuality.UNKNOWN !== undefined) {
        return this.platform.Characteristic.AirQuality.UNKNOWN;
      }
      throw new this.platform.api.hap.HapStatusError(-70402);
    }

    /**
     * AIR QUALITY MAPPING FIX: Use intermediate levels based on typical thresholds.
     * Thresholds:
     * - POOR: CO2 > 1500, PM2.5 > 55, VOC > 8000
     * - INFERIOR: CO2 > 1000, PM2.5 > 35, VOC > 3000
     * - FAIR: CO2 > 800, PM2.5 > 23, VOC > 1000
     * - GOOD: CO2 > 600, PM2.5 > 12, VOC > 333
     * - EXCELLENT: Below all
     */
    if ((co2 && co2 > 1500) || (pm25 && pm25 > 55) || (voc && voc > 8000)) {
      return this.platform.Characteristic.AirQuality.POOR;
    }
    if ((co2 && co2 > 1000) || (pm25 && pm25 > 35) || (voc && voc > 3000) || binaryCo2 === true) {
      return this.platform.Characteristic.AirQuality.INFERIOR;
    }
    if ((co2 && co2 > 800) || (pm25 && pm25 > 23) || (voc && voc > 1000)) {
      return this.platform.Characteristic.AirQuality.FAIR;
    }
    if ((co2 && co2 > 600) || (pm25 && pm25 > 12) || (voc && voc > 333)) {
      return this.platform.Characteristic.AirQuality.GOOD;
    }

    return this.platform.Characteristic.AirQuality.EXCELLENT;
  }

  private hasSensorType(propertyName: string): boolean {
    const values = this.node.getDefinedValueIDs();
    return values.some(
      (v) =>
        v.commandClass === CommandClasses['Multilevel Sensor'] &&
        v.property === propertyName &&
        v.endpoint === this.endpoint.index,
    );
  }

  public getSensorValue(propertyName: string): number | undefined {
    const valueId = {
      commandClass: CommandClasses['Multilevel Sensor'],
      property: propertyName,
      endpoint: this.endpoint.index,
    };
    const val = this.node.getValue(valueId);

    if (typeof val === 'number') {
      if (propertyName === 'Air temperature') {
        const meta = this.node.getValueMetadata(valueId);
        if (meta && (meta as { unit?: string }).unit === '°F') {
          return ((val - 32) * 5) / 9;
        }
      }

      /**
       * VOC CONVERSION FIX: HomeKit expects ug/m3.
       * If Z-Wave reports ppm, we convert using a general factor (1000).
       */
      if (propertyName === 'Volatile Organic Compound level') {
        const meta = this.node.getValueMetadata(valueId);
        if (meta && (meta as { unit?: string }).unit === 'ppm') {
          return val * 1000;
        }
      }

      return val;
    }
    return undefined;
  }
}
