import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

export class CentralSceneFeature extends BaseFeature {
  private service: Service | undefined;

  init(): void {
    const values = this.node.getDefinedValueIDs();
    const sceneValue = values.find(
      (v) =>
        v.commandClass === CommandClasses['Central Scene'] && v.endpoint === this.endpoint.index,
    );

    if (sceneValue) {
      const subType = this.endpoint.index.toString();
      this.service = this.getService(
        this.platform.Service.StatelessProgrammableSwitch,
        'Buttons',
        subType,
      );

      // Initialize the characteristic binding
      this.service.getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent);
    }
  }

  update(args?: ZWaveValueEvent): void {
    if (!this.shouldUpdate(args, CommandClasses['Central Scene'])) {
      return;
    }
    const value = this.node.getValue({
      commandClass: CommandClasses['Central Scene'],
      property: 'scene',
      endpoint: this.endpoint.index,
    });

    const action = this.node.getValue({
      commandClass: CommandClasses['Central Scene'],
      property: 'keyAttribute',
      endpoint: this.endpoint.index,
    });

    if (value !== undefined && action !== undefined) {
      this.platform.log.info(`Central Scene event: Scene ${value}, Action ${action}`);
      this.triggerButton(value as number, action as number);
    }
  }

  private triggerButton(sceneId: number, keyAttribute: number) {
    if (!this.service) return;

    // Map Z-Wave keyAttribute to HomeKit ProgrammableSwitchEvent
    // Z-Wave: 0 = Pressed, 1 = Released, 2 = Held, 3 = Double Pressed, 4 = Triple Pressed
    // HomeKit: 0 = SINGLE_PRESS, 1 = DOUBLE_PRESS, 2 = LONG_PRESS

    let hkEvent: number | undefined;
    switch (keyAttribute) {
      case 0: // Pressed
        hkEvent = this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
        break;
      case 3: // Double Pressed
        hkEvent = this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS;
        break;
      case 2: // Held
        hkEvent = this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS;
        break;
    }

    if (hkEvent !== undefined) {
      // We use the sceneId as the 'LabelIndex' if we had multiple services,
      // but here we just trigger the characteristic.
      // For multi-button devices, we might need multiple services or subTypes.
      this.service
        .getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent)
        .updateValue(hkEvent);
    }
  }
}
