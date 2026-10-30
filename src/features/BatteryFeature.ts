import { Endpoint } from 'zwave-js';
import { PlatformAccessory, Service } from 'homebridge';
import { CommandClasses } from '@zwave-js/core';
import { BaseFeature, BatterySnapshot, HAP_COMMUNICATION_FAILURE } from './ZWaveFeature';
import { IZWaveNode, ZWaveValueEvent } from '../zwave/interfaces';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { BatteryReport, getBatteryApi } from '../zwave/nodeApi';

/** Shortest gap between two explicit Battery Get commands to the same endpoint. */
const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;

interface BatteryContext {
  batteryLevels?: Record<string, number>;
}

/**
 * Battery CC encodes "low battery warning" as level 0xFF rather than as a percentage. Treating
 * it as a number means clamping it to 100, which reports a flat battery as a full one.
 */
const BATTERY_LOW_WARNING_LEVEL = 0xff;

export class BatteryFeature extends BaseFeature {
  private service!: Service;
  private lastKnownLevel?: number;
  private refreshInFlight = false;
  private lastRefreshAt = 0;
  /** The device last reported the low-battery warning sentinel rather than a percentage. */
  private lowBatteryWarning = false;
  /**
   * The percentage that was current when the sentinel arrived, used to tell a passive resync
   * apart from a fresh reading. zwave-js keeps its cached percentage when a report carries
   * 0xFF, so re-reading that same value is not evidence that the battery recovered.
   */
  private levelAtWarning?: number;

  constructor(
    platform: ZWaveUsbPlatform,
    accessory: PlatformAccessory,
    endpoint: Endpoint,
    node: IZWaveNode,
  ) {
    super(platform, accessory, endpoint, node);
  }

  init(): void {
    const subType = this.endpoint.index.toString();
    this.service = this.getService(this.platform.Service.Battery, undefined, subType);
    this.lastKnownLevel = this.readStoredLevel();

    this.service
      .getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(this.handleGetBatteryLevel.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(this.handleGetStatusLowBattery.bind(this));

    void this.refreshBatteryLevel('feature initialization');
  }

  /**
   * Called whenever the platform re-synchronizes the node, which covers node-ready, wake-up,
   * interview progress and an explicit Refresh Info. The interval guard keeps this from turning
   * into periodic polling.
   */
  public updateNode(node: IZWaveNode, endpoint: Endpoint): void {
    super.updateNode(node, endpoint);
    void this.refreshBatteryLevel('node refresh');
  }

  update(args?: ZWaveValueEvent): void {
    if (
      !this.shouldUpdate(args, CommandClasses.Battery) &&
      !this.shouldUpdate(args, CommandClasses.Notification)
    ) {
      return;
    }

    /**
     * NOTIFICATION FIX: Some devices report low battery via Power Management notifications.
     */
    if (args && args.commandClass === CommandClasses.Notification) {
      const alarmState = this.getLowBatteryAlarmStateFromEvent(args);
      if (alarmState !== undefined) {
        // The notification is newer than any remembered sentinel, so it settles it. Without
        // this the pushed value and a subsequent read of the same characteristic disagree.
        this.lowBatteryWarning = alarmState;
        if (!alarmState) {
          this.levelAtWarning = undefined;
        }
        this.service.updateCharacteristic(
          this.platform.Characteristic.StatusLowBattery,
          alarmState
            ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
      }
      return;
    }

    const cachedLevel = this.readCachedLevel();

    if (cachedLevel !== undefined) {
      if (this.lowBatteryWarning && this.supersedesWarning(args, cachedLevel)) {
        this.lowBatteryWarning = false;
        this.levelAtWarning = undefined;
      }
      this.platform.log.debug(
        `Battery [Node ${this.node.nodeId} endpoint ${this.endpoint.index}]: ` +
          `report with numeric level ${cachedLevel}%.`,
      );
      this.publishLevel(cachedLevel);
      return;
    }

    if (args) {
      this.platform.log.debug(
        `Battery [Node ${this.node.nodeId} endpoint ${this.endpoint.index}]: ` +
          'report without a numeric level; requesting an explicit Battery Get.',
      );
    }

    void this.refreshBatteryLevel('battery report without a level');
    this.publishLastKnownLevel();
  }

  /**
   * Reads the level with an explicit Battery Get. The Battery CC API returns the decoded report,
   * which still carries the level in the cases where zwave-js chooses not to store it.
   */
  private async refreshBatteryLevel(reason: string): Promise<void> {
    const label = `Battery [Node ${this.node.nodeId} endpoint ${this.endpoint.index}]`;

    if (this.refreshInFlight) {
      return;
    }

    const now = Date.now();
    if (this.lastRefreshAt !== 0 && now - this.lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
      return;
    }

    const api = getBatteryApi(
      this.endpoint as unknown as { commandClasses?: Record<string, unknown> },
    );
    if (!api?.get) {
      this.platform.log.debug(`${label}: Battery CC API unavailable, skipping refresh.`);
      return;
    }

    this.refreshInFlight = true;
    this.lastRefreshAt = now;

    let report: BatteryReport | undefined;
    try {
      report = await api.get();
    } catch (err) {
      this.platform.log.debug(
        `${label}: no report received (${reason}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      this.publishLastKnownLevel();
      return;
    } finally {
      this.refreshInFlight = false;
    }

    if (!report) {
      this.platform.log.debug(`${label}: no report received (${reason}).`);
      this.publishLastKnownLevel();
      return;
    }

    if (typeof report.level !== 'number') {
      this.platform.log.warn(`${label}: report received without a numeric level (${reason}).`);
      this.publishLastKnownLevel();
      return;
    }

    if (report.level === BATTERY_LOW_WARNING_LEVEL) {
      /**
       * 0xFF is the low-battery warning, not 255 percent. The percentage is unknown, so the last
       * known one is kept if there is one, and the warning is published either way.
       */
      this.lowBatteryWarning = true;
      this.levelAtWarning = this.lastKnownLevel;
      this.platform.log.warn(
        `${label}: report says the battery is low without giving a level (${reason}).`,
      );
      this.publishLastKnownLevel();
      return;
    }

    this.lowBatteryWarning = false;
    this.levelAtWarning = undefined;

    this.platform.log.debug(
      `${label}: report received with numeric level ${report.level}% (${reason}).`,
    );
    this.publishLevel(report.level);
  }

  /**
   * Whether a level update is evidence that the remembered low-battery warning no longer holds.
   *
   * A report the device just sent settles the question by itself: a percentage supersedes the
   * warning even when it equals the level the sentinel interrupted, and the sentinel restates
   * the warning rather than lifting it. A passive resync brings no new report, and zwave-js
   * replaces 0xFF with the previous percentage before persisting it, so an unchanged cached
   * value there is the sentinel's own aftermath rather than a fresh reading.
   */
  private supersedesWarning(args: ZWaveValueEvent | undefined, cachedLevel: number): boolean {
    if (
      args?.commandClass === CommandClasses.Battery &&
      args.property === 'level' &&
      typeof args.newValue === 'number'
    ) {
      return args.newValue !== BATTERY_LOW_WARNING_LEVEL;
    }

    return cachedLevel !== this.levelAtWarning;
  }

  private readCachedLevel(): number | undefined {
    const value = this.node.getValue({
      commandClass: CommandClasses.Battery,
      property: 'level',
      endpoint: this.endpoint.index,
    });

    return typeof value === 'number' ? this.clampLevel(value) : undefined;
  }

  private clampLevel(level: number): number {
    return Math.max(0, Math.min(level, 100));
  }

  private publishLevel(level: number): void {
    const clamped = this.clampLevel(level);
    this.lastKnownLevel = clamped;
    this.storeLevel(clamped);

    if (!this.service) {
      return;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.BatteryLevel, clamped);

    const lowBattery = this.resolveStatusLowBattery(clamped);
    if (lowBattery !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, lowBattery);
    }
  }

  private publishLastKnownLevel(): void {
    if (!this.service) {
      return;
    }

    /**
     * The low-battery warning is publishable even when no percentage has ever been known, so the
     * status is refreshed before the level is considered.
     */
    const lowBattery = this.resolveStatusLowBattery(this.lastKnownLevel);
    if (lowBattery !== undefined) {
      this.service.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, lowBattery);
    }

    if (this.lastKnownLevel === undefined) {
      return;
    }

    this.platform.log.debug(
      `Battery [Node ${this.node.nodeId} endpoint ${this.endpoint.index}]: ` +
        `using last known level ${this.lastKnownLevel}%.`,
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.BatteryLevel,
      this.lastKnownLevel,
    );
  }

  private getBatteryLevel(): number | undefined {
    const cached = this.readCachedLevel();
    if (cached !== undefined) {
      this.lastKnownLevel = cached;
      this.storeLevel(cached);
      return cached;
    }

    return this.lastKnownLevel;
  }

  /**
   * Returns undefined when nothing is known about the battery. Callers must not turn that into a
   * percentage: zero is a real battery level and must never stand in for "unknown".
   */
  private resolveStatusLowBattery(level: number | undefined): number | undefined {
    if (this.lowBatteryWarning) {
      return this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    }

    const alarmState = this.getLowBatteryAlarmStateFromCache();
    if (alarmState !== undefined) {
      return alarmState
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    const isLowFlag = this.node.getValue({
      commandClass: CommandClasses.Battery,
      property: 'isLow',
      endpoint: this.endpoint.index,
    });
    if (typeof isLowFlag === 'boolean') {
      return isLowFlag
        ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

    if (level === undefined) {
      return undefined;
    }

    return level <= 20
      ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private getLowBatteryAlarmStateFromEvent(args: ZWaveValueEvent): boolean | undefined {
    if (args.property !== 'Power Management') {
      return undefined;
    }
    return this.parseLowBatteryNotificationValue(args.newValue);
  }

  private getLowBatteryAlarmStateFromCache(): boolean | undefined {
    const notificationKeys = [
      'Replace battery soon status',
      'Replace battery now status',
      'Battery is low',
      'Low battery level status',
    ];

    for (const key of notificationKeys) {
      const val = this.node.getValue({
        commandClass: CommandClasses.Notification,
        property: 'Power Management',
        propertyKey: key,
        endpoint: this.endpoint.index,
      });
      const parsed = this.parseLowBatteryNotificationValue(val);
      if (parsed !== undefined) {
        return parsed;
      }
    }

    const fallback = this.node.getValue({
      commandClass: CommandClasses.Notification,
      property: 'Power Management',
      endpoint: this.endpoint.index,
    });
    return this.parseLowBatteryNotificationValue(fallback);
  }

  private parseLowBatteryNotificationValue(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'number') {
      return undefined;
    }

    // Notification event values used by devices for low battery alarms.
    if (value === 10 || value === 11) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return undefined;
  }

  /**
   * The last valid percentage lives in the accessory context so an ordinary restart does not
   * turn a known battery level back into "unknown".
   */
  private readStoredLevel(): number | undefined {
    const context = this.accessory?.context as BatteryContext | undefined;
    const stored = context?.batteryLevels?.[String(this.endpoint.index)];

    return typeof stored === 'number' ? this.clampLevel(stored) : undefined;
  }

  private storeLevel(level: number): void {
    if (!this.accessory) {
      return;
    }

    const context = (this.accessory.context ?? {}) as BatteryContext;
    this.accessory.context = context;

    const levels = context.batteryLevels ?? {};
    context.batteryLevels = levels;

    const key = String(this.endpoint.index);
    if (levels[key] === level) {
      return;
    }

    levels[key] = level;
    this.platform.api.updatePlatformAccessories?.([this.accessory]);
  }

  /**
   * The same battery this endpoint publishes to HomeKit, for the management page.
   *
   * It goes through the two accessors the Battery service itself uses rather than reading the
   * driver's values again, because the low-battery warning cannot be recovered from those
   * values: Battery CC replaces the 0xFF sentinel with nothing before the report is persisted,
   * so the cache still shows the last percentage. Only this feature remembers that the warning
   * arrived, along with the Power Management notification that can settle it.
   *
   * Unlike the HomeKit getters this does not poll the device and raises no HapStatusError of
   * its own, because the page asks for every node every few seconds. It can still fail the way
   * any read of the driver can, so the caller contains that per node rather than per page.
   */
  public batterySnapshot(): BatterySnapshot {
    const level = this.getBatteryLevel();

    return {
      level,
      low:
        this.resolveStatusLowBattery(level) ===
        this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    };
  }

  private handleGetBatteryLevel(): number {
    const level = this.getBatteryLevel();
    if (level !== undefined) {
      return level;
    }

    this.platform.log.debug(
      `Battery [Node ${this.node.nodeId} endpoint ${this.endpoint.index}]: ` +
        'no battery level has been received yet, reporting it as unavailable.',
    );
    void this.refreshBatteryLevel('HomeKit read');

    throw new this.platform.api.hap.HapStatusError(HAP_COMMUNICATION_FAILURE);
  }

  private handleGetStatusLowBattery(): number {
    const status = this.resolveStatusLowBattery(this.getBatteryLevel());
    if (status !== undefined) {
      return status;
    }

    throw new this.platform.api.hap.HapStatusError(HAP_COMMUNICATION_FAILURE);
  }
}
