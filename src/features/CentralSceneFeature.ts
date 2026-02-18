import { Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature } from './ZWaveFeature';
import { ZWaveValueEvent } from '../zwave/interfaces';

/**
 * CentralSceneFeature implements support for buttons and remotes.
 * It maps each 'scene' (button) to a separate StatelessProgrammableSwitch service.
 */
export class CentralSceneFeature extends BaseFeature {
  private services = new Map<number, Service>();

  init(): void {
    /**
     * BUTTON PERSISTENCE FIX: For battery remotes, metadata is often missing on startup.
     * We must discover existing button services from the cache to prevent the
     * ghost service pruning logic from deleting them.
     */
    this.accessory.services.forEach((service) => {
      if (service.UUID === this.platform.Service.StatelessProgrammableSwitch.UUID) {
        const subType = service.subtype;
        if (subType && subType.startsWith(`${this.endpoint.index}-`)) {
          const sceneId = Number(subType.split('-')[1]);
          if (!isNaN(sceneId)) {
            this.services.set(sceneId, service);
            if (!this.managedServices.includes(service)) {
              this.managedServices.push(service);
            }
          }
        }
      }
    });

    // Initial discovery of buttons if metadata is available
    const sceneMetadata = this.node.getValueMetadata({
      commandClass: CommandClasses['Central Scene'],
      property: 'scene',
      endpoint: this.endpoint.index,
    }) as { states?: Record<string, string> };

    if (sceneMetadata && sceneMetadata.states) {
      const sceneIds = Object.keys(sceneMetadata.states).map(Number);
      for (const id of sceneIds) {
        this.getOrCreateButtonService(id);
      }
    }
  }

  update(args?: ZWaveValueEvent): void {
    if (!this.shouldUpdate(args, CommandClasses['Central Scene'])) {
      return;
    }

    /**
     * RE-TRIGGER FIX: Only process events that come from real-time notifications.
     * If 'args' is undefined, it's a cold refresh (startup), and we MUST NOT
     * re-trigger the last persistent value as an event.
     */
    if (!args) {
      return;
    }

    if (args.newValue !== undefined) {
      const sceneId =
        args.property === 'scene'
          ? (args.newValue as number)
          : (this.node.getValue({
              commandClass: CommandClasses['Central Scene'],
              property: 'scene',
              endpoint: this.endpoint.index,
            }) as number);

      const keyAttribute =
        args.property === 'keyAttribute'
          ? (args.newValue as number)
          : (this.node.getValue({
              commandClass: CommandClasses['Central Scene'],
              property: 'keyAttribute',
              endpoint: this.endpoint.index,
            }) as number);

      if (sceneId !== undefined && keyAttribute !== undefined) {
        this.platform.log.info(`Central Scene event: Scene ${sceneId}, Action ${keyAttribute}`);
        this.triggerButton(sceneId, keyAttribute);
      }
    }
  }

  private getOrCreateButtonService(sceneId: number): Service {
    let service = this.services.get(sceneId);
    if (!service) {
      const subType = `${this.endpoint.index}-${sceneId}`;
      const name = `Button ${sceneId}`;
      service = this.getService(this.platform.Service.StatelessProgrammableSwitch, name, subType);

      // Label the button index
      if (!service.testCharacteristic(this.platform.Characteristic.ServiceLabelIndex)) {
        service.addOptionalCharacteristic(this.platform.Characteristic.ServiceLabelIndex);
      }
      service.getCharacteristic(this.platform.Characteristic.ServiceLabelIndex).updateValue(sceneId);

      this.services.set(sceneId, service);
    }
    return service;
  }

  private triggerButton(sceneId: number, keyAttribute: number) {
    const service = this.getOrCreateButtonService(sceneId);

    // Map Z-Wave keyAttribute to HomeKit ProgrammableSwitchEvent
    // Z-Wave (common): 0 = Pressed, 1 = Released, 2 = Held, 3 = Double Pressed, 4 = Triple Pressed
    // Z-Wave (v3+): 5 = Key pressed 2x, 6 = 3x, 7 = 4x, 8 = 5x, 9 = Held down
    // HomeKit: 0 = SINGLE_PRESS, 1 = DOUBLE_PRESS, 2 = LONG_PRESS

    let hkEvent: number | undefined;
    switch (keyAttribute) {
      case 0: // Pressed
      case 1: // Released (map to single press for controllers that only emit release)
        hkEvent = this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
        break;
      case 5: // Key pressed 2x (v3+)
      case 3: // Double Pressed
        hkEvent = this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS;
        break;
      case 9: // Held down (v3+)
      case 2: // Held
        hkEvent = this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS;
        break;
    }

    if (hkEvent !== undefined) {
      service
        .getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent)
        .updateValue(hkEvent);
    }
  }
}
