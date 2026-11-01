import { Characteristic, PlatformAccessory, Service } from 'homebridge';
import { ZWaveUsbPlatform } from '../platform/ZWaveUsbPlatform';
import { ZWaveAccessory } from '../accessories/ZWaveAccessory';
import { homeKitBatteryToMatterPercent } from './coveringPosition';
import { matterLabel, matterSerialNumber } from './matterText';
import { serviceMappings, ServiceMapping, StateBinding } from './serviceMappings';
import { composeBridgedRoot, composeDeviceType } from './deviceComposition';

/** The status errors a cluster handler throws to report a failure to the controller. */
interface MatterStatusErrors {
  Failure: new (message?: string) => Error;
  NotFound: new (message?: string) => Error;
}

/** One accessory on its way to Matter, with the descriptor built for it retained locally. */
interface PendingPublication {
  uuid: string;
  accessory: ZWaveAccessory;
  descriptor: MatterAccessoryDescriptor;
}

/**
 * The parts of Homebridge's Matter API this plugin uses. It is declared here rather than
 * imported because `api.matter` only exists on Homebridge 2 and the plugin still supports
 * Homebridge 1, where the property is simply absent.
 */
interface MatterApi {
  deviceTypes: Record<string, unknown>;
  switch?: {
    emitGesture(
      uuid: string,
      gesture: 'singlePress' | 'doublePress' | 'longPress',
      options?: { partId?: string },
    ): Promise<void>;
  };
  status: MatterStatusErrors;
  registerPlatformAccessories(
    pluginIdentifier: string,
    platformName: string,
    accessories: MatterAccessoryDescriptor[],
  ): Promise<unknown>;
  updateAccessoryState(
    uuid: string,
    cluster: string,
    attributes: Record<string, unknown>,
    partId?: string,
  ): Promise<unknown>;
  unregisterPlatformAccessories(
    pluginIdentifier: string,
    platformName: string,
    accessories: MatterAccessoryDescriptor[],
  ): Promise<unknown>;
}

interface MatterAccessoryDescriptor {
  UUID: string;
  displayName: string;
  deviceType: unknown;
  serialNumber: string;
  manufacturer: string;
  model: string;
  firmwareRevision?: string;
  context: Record<string, unknown>;
  clusters: Record<string, Record<string, unknown>>;
  handlers: Record<string, Record<string, (request?: never) => Promise<void> | void>>;
  parts?: Array<{
    id: string;
    displayName: string;
    deviceType: unknown;
    clusters: Record<string, Record<string, unknown>>;
    handlers: Record<string, Record<string, (request?: never) => Promise<void> | void>>;
  }>;
}

const POWER_SOURCE_CLUSTER = 'powerSource';

/** PowerSource.BatChargeLevel */
const BAT_CHARGE_OK = 0;
const BAT_CHARGE_WARNING = 1;

/**
 * How long to wait after an accessory becomes ready before publishing. Nodes finish their
 * interviews within moments of each other at startup, and Matter accessories are registered in
 * one batch rather than one call per node.
 */
const PUBLISH_DEBOUNCE_MS = 3000;

/** The noun that agrees with `count`. */
const accessoryNoun = (count: number): string => (count === 1 ? 'accessory' : 'accessories');

/**
 * Publishes supported Z-Wave services over Matter so controllers that cannot speak HomeKit, such as
 * Alexa, can operate them.
 *
 * Commands are routed through the accessory's HomeKit characteristics, so a Matter request goes
 * through the same command coalescing, encoding and position reconciliation as a HomeKit one.
 * Nothing here talks to Z-Wave directly.
 */
export class MatterAccessories {
  private readonly published = new Set<string>();
  /** Descriptors of what was registered, so an accessory can be unregistered again. */
  private readonly descriptors = new Map<string, MatterAccessoryDescriptor>();
  /**
   * UUIDs Homebridge restored from its own Matter cache and that this run has not claimed yet.
   * The distinction is load bearing rather than bookkeeping: a restored endpoint is the only
   * one Homebridge lets a registration attach to in place, so an entry leaving this map is what
   * says the identifier must never be offered for registration again this session.
   */
  private readonly cached = new Map<string, MatterAccessoryDescriptor>();
  /**
   * Accessories whose descriptor construction or publication is in progress. While a UUID is
   * here it is in neither `pending` nor `published`, so without it a second `add()` would queue
   * the same accessory again and register it twice.
   */
  private readonly inFlight = new Set<string>();
  /**
   * A replacement offered while publication was in flight, tagged with the generation current
   * when it was offered. Kept apart from `inFlight` because the two answer different questions:
   * one is whether an operation is running, the other is what to do when it finishes. A removal
   * bumps the generation, which is what makes a replacement offered before it stale, while a
   * genuinely new request made after the removal carries the new generation and still runs.
   */
  private readonly deferred = new Map<string, { accessory: ZWaveAccessory; generation: number }>();
  /** Bumped whenever an accessory is removed, so a registration in flight can be discarded. */
  private readonly generations = new Map<string, number>();
  /**
   * State observed before the endpoint exists, keyed by UUID then by cluster and part. Listening
   * begins before the descriptor snapshot, so these updates have nowhere to go yet; the newest
   * value per attribute is kept and released once the accessory is published.
   */
  private readonly held = new Map<string, Map<string, Record<string, unknown>>>();
  /** Per-accessory detach callbacks for the HomeKit listeners that mirror state into Matter. */
  private readonly trackers = new Map<string, Array<() => void>>();
  /** The accessory instance each published UUID is currently mirroring. */
  private readonly tracked = new Map<string, ZWaveAccessory>();
  private readonly pending = new Map<string, ZWaveAccessory>();
  private publishTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly platform: ZWaveUsbPlatform) {}

  private get matter(): MatterApi | undefined {
    return (this.platform.api as unknown as { matter?: MatterApi }).matter;
  }

  public stop(): void {
    this.stopped = true;
    for (const uuid of this.inFlight)
      this.generations.set(uuid, (this.generations.get(uuid) ?? 0) + 1);
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    this.pending.clear();
    this.inFlight.clear();
    this.deferred.clear();
    [...this.trackers.keys()].forEach((uuid) => this.untrack(uuid));
    // Untracking clears what it knows about, but a mapping with no bindings leaves held state
    // and no tracker, so nothing would collect it.
    this.held.clear();
  }

  /**
   * Records a Matter accessory Homebridge restored from its own cache. Anything still recorded
   * once the network has been discovered belongs to a node that is gone, so it is removed rather
   * than left in the controller as a device that no longer answers.
   */
  public configureCachedAccessory(descriptor: { UUID: string; displayName: string }): void {
    this.cached.set(descriptor.UUID, descriptor as MatterAccessoryDescriptor);
  }

  /** Removes an accessory from Matter, so an excluded node does not linger in the controller. */
  public async remove(uuid: string): Promise<void> {
    this.pending.delete(uuid);
    this.untrack(uuid);
    // Anything still in flight for this accessory belongs to a generation that is now obsolete.
    this.generations.set(uuid, (this.generations.get(uuid) ?? 0) + 1);

    const descriptor = this.descriptors.get(uuid) ?? this.cached.get(uuid);
    if (!descriptor || !this.matter) {
      this.published.delete(uuid);
      this.descriptors.delete(uuid);
      this.cached.delete(uuid);
      return;
    }

    try {
      await this.matter.unregisterPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', [
        descriptor,
      ]);
    } catch (err) {
      /**
       * Only a refusal raised before the removal is dispatched reaches here. Bridged
       * unregistration is dispatched as an event that is not awaited, so a removal the Matter
       * server goes on to refuse returns from this call as though it had worked, and the record
       * is dropped below. Homebridge offers the endpoint back from its cache on the next start,
       * which is where such a removal is noticed and tried again; within this session it is
       * not detectable.
       */
      this.platform.log.warn(
        `Could not remove ${descriptor.displayName} from Matter, so it is still recorded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      /**
       * No longer published, because the plugin has given up on it as a live accessory, but
       * still recorded as restored so the next reconcile tries the removal again. Dropping it
       * from both would leave a device in the controller that nothing here can ever remove.
       */
      this.published.delete(uuid);
      this.descriptors.set(uuid, descriptor);
      this.cached.set(uuid, descriptor);
      return;
    }

    this.published.delete(uuid);
    this.descriptors.delete(uuid);
    this.cached.delete(uuid);
  }

  /**
   * Removes every Matter accessory Homebridge restored that this run did not match to a live
   * device. Called once the network has been discovered, which is the first moment the absence
   * of a node means the node is gone rather than not interviewed yet.
   */
  public async reconcileCached(liveUuids: ReadonlySet<string>): Promise<void> {
    /**
     * Keyed on what the network has, not on what has been published. Publication is debounced
     * and a covering that is asleep, dead or still interviewing may not have been queued at all
     * yet, so treating unpublished as absent would unregister a shade whose battery is simply
     * out.
     */
    const leftovers = [...this.cached.keys()].filter((uuid) => !liveUuids.has(uuid));
    for (const uuid of leftovers) {
      this.platform.log.info(
        `Removing ${this.cached.get(uuid)?.displayName ?? uuid} from Matter: ` +
          'it was restored from the cache but is not a node on this network.',
      );
      await this.remove(uuid);
    }
  }

  /**
   * Queues an accessory for publication. Safe to call repeatedly: an accessory is only ever
   * published once, and services without a supported mapping are ignored.
   */
  public add(accessory: ZWaveAccessory): void {
    if (!this.matter || this.stopped) {
      return;
    }

    const uuid = accessory.platformAccessory.UUID;
    if (!this.supports(accessory)) {
      return;
    }

    if (this.inFlight.has(uuid)) {
      // Publication is already running for this accessory. Record the newest object so the
      // operation can republish against it when it finishes, rather than starting a second one.
      this.deferred.set(uuid, { accessory, generation: this.generations.get(uuid) ?? 0 });
      return;
    }

    if (this.published.has(uuid)) {
      if (this.tracked.get(uuid) === accessory) {
        return;
      }

      // The accessory object was rebuilt while its Matter endpoint is live.
      this.refreshTracking(uuid, accessory);
      return;
    }

    this.pending.set(uuid, accessory);

    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
    }
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.publishPending();
    }, PUBLISH_DEBOUNCE_MS);
    this.publishTimer.unref();
  }

  public supports(accessory: ZWaveAccessory): boolean {
    return (
      serviceMappings(this.platform, accessory, {
        read: async () => undefined,
        write: async () => undefined,
      }).length > 0
    );
  }

  private mappings(accessory: ZWaveAccessory): ServiceMapping[] {
    return serviceMappings(this.platform, accessory, {
      read: async (key, type) => {
        const current = this.live(accessory.platformAccessory.UUID, this.matter!);
        const service = this.mappings(current).find((m) => m.key === key)?.service;
        if (!service) throw new this.matter!.status.NotFound('Service is no longer available');
        return service.getCharacteristic(type).handleGetRequest();
      },
      write: async (key, type, value) => {
        const current = this.live(accessory.platformAccessory.UUID, this.matter!);
        const service = this.mappings(current).find((m) => m.key === key)?.service;
        if (!service) throw new this.matter!.status.NotFound('Service is no longer available');
        await this.writeCharacteristic(
          service,
          type,
          value,
          current,
          type === this.platform.Characteristic.HoldPosition
            ? 'stop request'
            : type === this.platform.Characteristic.TargetPosition
              ? `${String(value)}% position request`
              : type.UUID,
        );
      },
    }).filter((mapping) => !!this.matter?.deviceTypes[mapping.deviceType]);
  }

  private async publishPending(): Promise<void> {
    const matter = this.matter;
    if (!matter || this.stopped || this.pending.size === 0) {
      return;
    }

    const queued = [...this.pending.entries()];
    this.pending.clear();

    /**
     * Captured before any await. A removal that happens while a descriptor is being built would
     * otherwise bump the generation before this read, and the publication would see its own
     * stale work as current.
     */
    queued.forEach(([uuid]) => this.inFlight.add(uuid));

    const generations = new Map(
      queued.map(([uuid]) => [uuid, this.generations.get(uuid) ?? 0] as const),
    );

    /**
     * Both groups go through registration, which is the only path that records the plugin and
     * platform an endpoint belongs to. Homebridge accepts it for an identifier it has never seen
     * and for one it restored from its own cache, where it attaches the handlers and the
     * ownership to the endpoint already there; it rejects a second registration of an endpoint
     * that is already live this session. That rejection happens downstream of the call awaited
     * here, so nothing offered in error would be visible: the groups are built from what has not
     * been claimed yet rather than from what a failure would tell us. They stay separate so a
     * failure of one cannot discard the other.
     */
    const fresh: PendingPublication[] = [];
    const restored: PendingPublication[] = [];

    for (const [uuid, accessory] of queued) {
      let descriptor: MatterAccessoryDescriptor | undefined;
      try {
        descriptor = await this.describe(accessory, matter);
      } catch (err) {
        this.platform.log.warn(
          `Could not describe ${accessory.platformAccessory.displayName} for Matter: ${String(err)}`,
        );
        this.untrack(uuid);
        continue;
      }
      if (!descriptor) {
        this.untrack(uuid);
        continue;
      }

      /**
       * Listening starts here rather than after registration. The descriptor is a snapshot, and
       * a characteristic that changed between the snapshot and the listeners being attached
       * would appear in neither: Matter would hold the older value with no event coming to
       * correct it. The listeners need the descriptor to resolve which part each mapping
       * belongs to, so this is the earliest point they can exist. Until the endpoint is
       * published their updates are held rather than sent, and `commit` releases them.
       */
      this.untrack(uuid);
      this.tracked.set(uuid, accessory);
      this.trackState(accessory, descriptor);
      this.trackBattery(accessory, descriptor);
      /**
       * Closes the remaining window, which is the snapshot itself: it reads characteristics one
       * at a time and awaits several of them, so a value can move after being read. Current
       * readings fill only the attributes nothing has reported yet, so a listener event, which
       * is necessarily newer than this read, is never overwritten by it.
       */
      await this.fillHeldStateGaps(accessory, descriptor);

      /**
       * Held locally until dispatch. Recording it now would let a removal that arrives
       * mid-flight ask Matter to unregister an accessory that was never offered.
       */
      (this.cached.has(uuid) ? restored : fresh).push({ uuid, accessory, descriptor });
    }

    // Handed over separately, so a failure reported for one group does not discard a group that
    // was already dispatched and would otherwise be offered a second time later.
    try {
      await this.commit(matter, fresh, generations);
      await this.commit(matter, restored, generations);
    } finally {
      for (const [uuid, accessory] of queued) {
        this.inFlight.delete(uuid);
        const replacement = this.deferred.get(uuid);
        this.deferred.delete(uuid);

        if (!replacement) {
          continue;
        }

        if (replacement.generation !== (this.generations.get(uuid) ?? 0)) {
          /**
           * The accessory was removed after this replacement was offered. Publishing it now
           * would put back a device the plugin has already been told to take away.
           */
          continue;
        }

        /**
         * Ordering is established by the generation, not by object identity. The same object
         * offered again after a removal is a new request, because the publication it would
         * have duplicated has been undone, and skipping it on identity alone would lose a
         * re-included node that happens to reuse its wrapper.
         *
         * The publication also has to have happened. An offer made while a registration was
         * running duplicates nothing if that registration then failed, and dropping it on
         * identity alone turns a transient failure into one that needs a restart, against
         * `add()`'s promise that calling it again is safe.
         */
        const duplicate =
          replacement.accessory === accessory &&
          replacement.generation === (generations.get(uuid) ?? 0) &&
          this.published.has(uuid);
        if (duplicate) {
          continue;
        }

        // Rebuilt while this was in flight, so the handlers just published close over a stopped
        // object, or removed and asked for again. Queue it now that the UUID is free.
        this.add(replacement.accessory);
      }
    }
  }

  /**
   * Offers one group to Matter and records what it handed over. An entry whose accessory was
   * removed while this was in flight is undone rather than committed, using the descriptor
   * retained here rather than the shared map, which the removal has already emptied.
   */
  private async commit(
    matter: MatterApi,
    group: PendingPublication[],
    generations: ReadonlyMap<string, number>,
  ): Promise<void> {
    if (group.length === 0) {
      return;
    }

    /**
     * Checked here rather than only after the call, because a removal that arrives while the
     * descriptors are being built would otherwise be dispatched anyway and undone afterwards.
     * The undo is not a reliable answer: bridged unregistration is dispatched as an event of
     * its own, so it can be handled before the registration it is meant to cancel. Not sending
     * the work at all is the only part of this the plugin controls.
     */
    const live: PendingPublication[] = [];

    for (const entry of group) {
      if ((this.generations.get(entry.uuid) ?? 0) === generations.get(entry.uuid)) {
        live.push(entry);
        continue;
      }
      /**
       * Removed while the descriptor was being built. The listeners opened for it are still
       * attached, so they have to come down here: leaving them would mirror a wrapper the
       * plugin has given up, and feed its state to whatever later takes the same identifier.
       */
      this.untrack(entry.uuid);
    }

    if (live.length === 0) {
      return;
    }

    const descriptors = live.map((entry) => entry.descriptor);
    try {
      await matter.registerPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', descriptors);
    } catch (err) {
      /**
       * Matter is optional. A bridge without it, or a registration refused before it is
       * dispatched, must not disturb the HomeKit accessories that are already working.
       */
      this.platform.log.warn(
        `Could not publish ${descriptors.length} ${accessoryNoun(descriptors.length)} over Matter: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Nothing was published, so the listeners opened for this group have nowhere to send.
      live.forEach((entry) => this.untrack(entry.uuid));
      return;
    }

    const undo: MatterAccessoryDescriptor[] = [];
    const committed: PendingPublication[] = [];

    for (const entry of live) {
      if ((this.generations.get(entry.uuid) ?? 0) !== generations.get(entry.uuid)) {
        // Removed while the registration was being dispatched. Compensating for it is
        // best-effort, for the ordering reason above, which is why the window is kept small
        // rather than relied on.
        this.untrack(entry.uuid);
        undo.push(entry.descriptor);
        continue;
      }

      this.descriptors.set(entry.uuid, entry.descriptor);
      this.published.add(entry.uuid);
      // Claimed, so no longer a restored endpoint awaiting reclamation.
      this.cached.delete(entry.uuid);
      this.tracked.set(entry.uuid, entry.accessory);
      /**
       * Published, so `pushState` sends directly from here on. Releasing what was held in the
       * same turn leaves no window for a live update to overtake the held one, since nothing
       * else runs between the flag and the flush.
       */
      this.releaseHeldState(entry.uuid);
      committed.push(entry);
    }

    if (committed.length > 0) {
      /**
       * A bridged registration is dispatched as an event that is not awaited, so this call
       * returning says the accessories were handed over and nothing about what became of them.
       * The wording follows.
       */
      this.platform.log.info(
        `Handed ${committed.length} ${accessoryNoun(committed.length)} to Matter: ` +
          committed.map((entry) => entry.accessory.platformAccessory.displayName).join(', '),
      );
    }

    if (undo.length === 0) {
      return;
    }

    try {
      await matter.unregisterPlatformAccessories('homebridge-zwave-usb', 'ZWaveUSB', undo);
    } catch (err) {
      /**
       * The registration was dispatched and the plugin no longer wants it. Keeping these as
       * restored leaves something for the next reconcile to remove, rather than an orphan in
       * the controller that nothing knows about.
       */
      this.platform.log.warn(
        `Could not undo a registration for ${undo.length} removed ${accessoryNoun(undo.length)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      undo.forEach((descriptor) => this.cached.set(descriptor.UUID, descriptor));
    }
  }

  private async mappingState(
    mapping: ServiceMapping,
  ): Promise<Record<string, Record<string, unknown>>> {
    const clusters = Object.fromEntries(
      Object.entries(mapping.clusters).map(([name, state]) => [name, { ...state }]),
    );
    for (const binding of mapping.bindings) {
      if (binding.event) continue;
      let value: unknown;
      try {
        if (binding.available && !binding.available())
          throw new Error('No measurement has been reported');
        const characteristic = (binding.service ?? mapping.service).getCharacteristic(
          binding.characteristic,
        );
        value = await characteristic.handleGetRequest();
      } catch {
        value = undefined;
      }
      Object.assign((clusters[binding.cluster] ??= {}), binding.attributes(value));
    }
    if (
      clusters.windowCovering &&
      clusters.windowCovering.targetPositionLiftPercent100ths == null
    ) {
      clusters.windowCovering.targetPositionLiftPercent100ths =
        clusters.windowCovering.currentPositionLiftPercent100ths;
    }
    return clusters;
  }

  private async describe(
    accessory: ZWaveAccessory,
    matter: MatterApi,
  ): Promise<MatterAccessoryDescriptor | undefined> {
    const mappings = this.mappings(accessory);
    const root = mappings[0];
    if (!root) return undefined;
    const information = this.readAccessoryInformation(accessory.platformAccessory);
    const battery = await this.describeBattery(accessory.platformAccessory, root.service);
    const descriptor: MatterAccessoryDescriptor = {
      UUID: accessory.platformAccessory.UUID,
      displayName: matterLabel(accessory.platformAccessory.displayName),
      deviceType: composeBridgedRoot(
        composeDeviceType(root, matter.deviceTypes),
        mappings,
        matter.deviceTypes,
      ),
      serialNumber: matterSerialNumber(information.serialNumber),
      manufacturer: matterLabel(information.manufacturer),
      model: matterLabel(information.model),
      firmwareRevision: information.firmwareRevision,
      context: { nodeId: accessory.node.nodeId, serviceKey: root.key },
      clusters: {
        ...(await this.mappingState(root)),
        ...(battery ? { powerSource: battery } : {}),
      },
      handlers: this.handlers(root, matter),
    };
    if (mappings.length > 1) {
      descriptor.parts = await Promise.all(
        mappings.slice(1).map(async (mapping) => ({
          id: mapping.key,
          displayName: matterLabel(
            mapping.service.displayName || accessory.platformAccessory.displayName,
          ),
          deviceType: composeDeviceType(mapping, matter.deviceTypes),
          clusters: {
            ...(await this.mappingState(mapping)),
            ...(await this.batteryCluster(accessory.platformAccessory, mapping.service)),
          },
          handlers: this.handlers(mapping, matter),
        })),
      );
    }
    return descriptor;
  }

  private handlers(
    mapping: ServiceMapping,
    matter: MatterApi,
  ): MatterAccessoryDescriptor['handlers'] {
    return Object.fromEntries(
      Object.entries(mapping.commands).map(([cluster, commands]) => [
        cluster,
        Object.fromEntries(
          Object.entries(commands).map(([command, handler]) => [
            command,
            async (request?: never) => {
              try {
                await handler(request);
              } catch (err) {
                if (err instanceof matter.status.NotFound) throw err;
                throw new matter.status.Failure(err instanceof Error ? err.message : String(err));
              }
            },
          ]),
        ),
      ]),
    );
  }

  private findBatteryService(
    platformAccessory: PlatformAccessory,
    target?: Service,
  ): Service | undefined {
    const batteryType = this.platform.Service.Battery as unknown as { UUID?: string };
    if (!batteryType?.UUID) {
      return undefined;
    }

    const batteries = platformAccessory.services.filter(
      (service) => service.UUID === batteryType.UUID,
    );
    if (!target) return batteries[0];
    const endpoint = (service: Service) => Number(/^(\d+)/.exec(service.subtype ?? '0')?.[1] ?? 0);
    return (
      batteries.find((service) => endpoint(service) === endpoint(target)) ??
      batteries.find((service) => endpoint(service) === 0)
    );
  }

  /**
   * Describes the accessory's battery for Matter.
   *
   * The static facts are always declared, even when no reading has arrived yet. Homebridge
   * decides whether to compose the Battery feature from the attributes present at registration,
   * so a power source declared without them would reject the device's first real reading for the
   * rest of the process. A missing level is reported as unknown rather than invented.
   */
  private async describeBattery(
    platformAccessory: PlatformAccessory,
    target?: Service,
  ): Promise<Record<string, unknown> | undefined> {
    const service = this.findBatteryService(platformAccessory, target);
    if (!service) {
      return undefined;
    }

    const level = await this.readBatteryLevel(service);

    /**
     * HAP describes a battery with a level, a low-battery flag and a charging state, and says
     * nothing about whether the source is supplying power, whether a cell is physically there,
     * or whether a user can replace it. Those were being asserted anyway, which is wrong in
     * ordinary cases: a standby source, an integrated pack, or a shade whose removable battery
     * is out would all be described as present and active. Matter has Unspecified for exactly
     * this, and `batPresent` is optional, so it is left out rather than guessed. The level and
     * the low-battery mapping are real readings and stay.
     */
    return {
      status: 0, // Unspecified
      order: 0,
      description: 'Battery',
      batReplaceability: 0, // Unspecified
      batChargeLevel: this.readBatteryChargeLevel(service),
      batPercentRemaining: level === undefined ? null : homeKitBatteryToMatterPercent(level),
    };
  }

  private async batteryCluster(
    platformAccessory: PlatformAccessory,
    target: Service,
  ): Promise<Record<string, Record<string, unknown>>> {
    const battery = await this.describeBattery(platformAccessory, target);
    return battery ? { powerSource: battery } : {};
  }

  private async readBatteryLevel(service: Service): Promise<number | undefined> {
    try {
      const characteristic = service.getCharacteristic(this.platform.Characteristic.BatteryLevel);
      // The cached HAP default is 0 even when BatteryFeature has never received a level.
      const value =
        typeof characteristic.handleGetRequest === 'function'
          ? await characteristic.handleGetRequest()
          : characteristic.value;
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private readBatteryChargeLevel(service: Service): number {
    const low = service.getCharacteristic(this.platform.Characteristic.StatusLowBattery)?.value;

    return low === this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      ? BAT_CHARGE_WARNING
      : BAT_CHARGE_OK;
  }

  private readAccessoryInformation(platformAccessory: PlatformAccessory): {
    serialNumber: string;
    manufacturer: string;
    model: string;
    firmwareRevision?: string;
  } {
    const info = platformAccessory.getService(this.platform.Service.AccessoryInformation);
    const read = (characteristic: typeof Characteristic.SerialNumber, fallback: string) => {
      const value = info?.getCharacteristic(characteristic)?.value;
      return typeof value === 'string' && value.length > 0 ? value : fallback;
    };

    return {
      serialNumber: read(this.platform.Characteristic.SerialNumber, platformAccessory.UUID),
      manufacturer: read(this.platform.Characteristic.Manufacturer, 'Z-Wave'),
      model: read(this.platform.Characteristic.Model, 'Z-Wave Device'),
      firmwareRevision: read(this.platform.Characteristic.FirmwareRevision, '1.0.0'),
    };
  }

  /**
   * Invokes a HomeKit characteristic's write handler. A failure is logged and then raised as a
   * Matter status, so the controller that sent the command is told it failed rather than being
   * left to assume it worked.
   */
  private async writeCharacteristic(
    service: Service,
    characteristicType: typeof Characteristic.TargetPosition,
    value: unknown,
    accessory: ZWaveAccessory,
    description: string,
  ): Promise<void> {
    const handleSetRequest = (
      service.getCharacteristic(characteristicType) as unknown as
        | { handleSetRequest?: (value: unknown) => Promise<unknown> }
        | undefined
    )?.handleSetRequest;

    const status = this.matter?.status;

    if (typeof handleSetRequest !== 'function') {
      this.platform.log.error(
        `Matter ${description} cannot be delivered for ` +
          `${accessory.platformAccessory.displayName}: the HomeKit characteristic has no setter.`,
      );
      throw status
        ? new status.NotFound(`${description} is not available`)
        : new Error(description);
    }

    try {
      await handleSetRequest.call(service.getCharacteristic(characteristicType), value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.platform.log.error(
        `Matter ${description} failed for ${accessory.platformAccessory.displayName}: ${message}`,
      );

      /**
       * The command did not reach the device, so the controller has to be told. Resolving here
       * would have Matter report success for a move that never happened, while the same command
       * from HomeKit correctly reports a communication failure.
       */
      throw status ? new status.Failure(`${description} failed`) : err;
    }
  }

  /**
   * Mirrors the covering's HomeKit position into Matter whenever it changes, so a controller that
   * is watching over Matter sees the same position the Home app does.
   */
  /**
   * The accessory an identifier stands for right now. A handler resolves it when a command
   * arrives rather than closing over the object that existed when the handler was built,
   * because a Matter endpoint outlives the Z-Wave wrapper it mirrors: a rebuild replaces the
   * wrapper while the endpoint, and the handlers registered with it, stay as they were.
   */
  private live(uuid: string, matter: MatterApi): ZWaveAccessory {
    const accessory = this.tracked.get(uuid);
    if (!accessory) {
      throw new matter.status.NotFound(`No accessory is registered for ${uuid}.`);
    }

    return accessory;
  }

  /**
   * Points a live endpoint at a rebuilt accessory. Registering the identifier again is not
   * available here: Homebridge attaches a registration in place only for an endpoint it
   * restored from its own cache, and rejects a second registration of one already live, which
   * it reports downstream of the call the plugin awaits. Nothing about the endpoint needs to
   * change in any case, since the handlers resolve the accessory by identifier, so repointing
   * the record and resubscribing is the whole update.
   */
  private refreshTracking(uuid: string, accessory: ZWaveAccessory): void {
    this.untrack(uuid);
    this.tracked.set(uuid, accessory);
    this.trackState(accessory);
    this.trackBattery(accessory);
    void this.pushCurrentState(accessory).catch((err) => {
      this.platform.log.debug(
        `Could not mirror the rebuilt accessory to Matter: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * Brings Matter back in step after a rebuild. The listeners that were mirroring state belonged
   * to the characteristics of the object just replaced, so without this the endpoint would hold
   * what was last reported until the new object happens to report a change of its own.
   */
  private async pushCurrentState(accessory: ZWaveAccessory): Promise<void> {
    const descriptor = this.descriptors.get(accessory.platformAccessory.UUID);
    if (!descriptor) return;
    for (const mapping of this.mappings(accessory)) {
      const partId = this.partId(descriptor, mapping);
      if (partId === null) continue;
      const clusters = partId
        ? descriptor.parts?.find((part) => part.id === partId)?.clusters
        : descriptor.clusters;
      const state = await this.mappingState(mapping);
      if (clusters?.powerSource)
        Object.assign(
          state,
          await this.batteryCluster(accessory.platformAccessory, mapping.service),
        );
      for (const [cluster, attributes] of Object.entries(state))
        this.pushState(accessory, cluster, attributes, partId);
    }
  }

  /** Only mirror services present in the endpoint registered this session. */
  private partId(
    descriptor: MatterAccessoryDescriptor,
    mapping: ServiceMapping,
  ): string | undefined | null {
    if (descriptor.parts?.some((part) => part.id === mapping.key)) return mapping.key;
    const rootKey = (descriptor.context as { serviceKey?: string }).serviceKey;
    return rootKey === mapping.key ? undefined : null;
  }

  private trackState(accessory: ZWaveAccessory, known?: MatterAccessoryDescriptor): void {
    const descriptor = known ?? this.descriptors.get(accessory.platformAccessory.UUID);
    if (!descriptor) return;
    for (const mapping of this.mappings(accessory)) {
      const partId = this.partId(descriptor, mapping);
      if (partId === null) continue;
      for (const binding of mapping.bindings) {
        this.onCharacteristicChange(
          accessory.platformAccessory.UUID,
          binding.service ?? mapping.service,
          binding.characteristic,
          (value) => {
            if (binding.event) {
              const gesture =
                value === 0
                  ? 'singlePress'
                  : value === 1
                    ? 'doublePress'
                    : value === 2
                      ? 'longPress'
                      : undefined;
              if (gesture)
                void this.matter?.switch
                  ?.emitGesture(accessory.platformAccessory.UUID, gesture, { partId })
                  .catch((err) =>
                    this.platform.log.warn(`Could not send Matter button event: ${String(err)}`),
                  );
            } else {
              // HAP error updates must not become sensor readings.
              if (value instanceof Error || value === undefined || value === null) return;
              this.pushState(
                accessory,
                binding.cluster,
                binding.attributes(binding.available && !binding.available() ? undefined : value),
                partId,
              );
            }
          },
        );
      }
    }
  }

  /** Mirrors battery readings the same way, so a Matter controller can show the charge level. */
  private trackBattery(accessory: ZWaveAccessory, known?: MatterAccessoryDescriptor): void {
    const descriptor = known ?? this.descriptors.get(accessory.platformAccessory.UUID);
    if (!descriptor) return;
    for (const mapping of this.mappings(accessory)) {
      const partId = this.partId(descriptor, mapping);
      if (partId === null) continue;
      const clusters = partId
        ? descriptor.parts?.find((part) => part.id === partId)?.clusters
        : descriptor.clusters;
      if (!clusters?.powerSource) continue;
      const service = this.findBatteryService(accessory.platformAccessory, mapping.service);
      if (!service) continue;
      this.onCharacteristicChange(
        accessory.platformAccessory.UUID,
        service,
        this.platform.Characteristic.BatteryLevel,
        (value) => {
          if (typeof value !== 'number' || !Number.isFinite(value)) return;
          this.pushState(
            accessory,
            POWER_SOURCE_CLUSTER,
            {
              batPercentRemaining: homeKitBatteryToMatterPercent(value),
            },
            partId,
          );
        },
      );
      this.onCharacteristicChange(
        accessory.platformAccessory.UUID,
        service,
        this.platform.Characteristic.StatusLowBattery,
        () => {
          this.pushState(
            accessory,
            POWER_SOURCE_CLUSTER,
            {
              batChargeLevel: this.readBatteryChargeLevel(service),
            },
            partId,
          );
        },
      );
    }
  }

  private onCharacteristicChange(
    uuid: string,
    service: Service,
    characteristicType: typeof Characteristic.CurrentPosition,
    listener: (newValue: unknown) => void,
  ): void {
    const characteristic = service.getCharacteristic(characteristicType) as unknown as
      | {
          on?: (event: string, handler: (change: { newValue: unknown }) => void) => void;
          removeListener?: (event: string, handler: (...args: never[]) => void) => void;
        }
      | undefined;

    if (typeof characteristic?.on !== 'function') {
      return;
    }

    const handler = ({ newValue }: { newValue: unknown }) => listener(newValue);
    characteristic.on('change', handler);

    const detach = () => characteristic.removeListener?.('change', handler as never);
    const existing = this.trackers.get(uuid) ?? [];
    existing.push(detach);
    this.trackers.set(uuid, existing);
  }

  /**
   * Covers the snapshot's own blind spot. The descriptor reads characteristics one at a time
   * and awaits several of them, so a value can move after being read, and no event reports that
   * move because nothing was listening yet. This re-reads through the same authoritative path
   * the descriptor uses, so an unknown reading stays unknown instead of becoming the cached HAP
   * default, which for a covering would announce it as fully closed.
   *
   * The read is asynchronous, so listener events can arrive while it runs. Anything already held
   * when a value is finally written came from a listener and is therefore newer, so it wins.
   */
  private async fillHeldStateGaps(
    accessory: ZWaveAccessory,
    descriptor: MatterAccessoryDescriptor,
  ): Promise<void> {
    const uuid = accessory.platformAccessory.UUID;

    for (const mapping of this.mappings(accessory)) {
      const partId = this.partId(descriptor, mapping);
      if (partId === null) continue;

      /**
       * Only what a listener would have sent. The descriptor also carries static cluster
       * fields, and those are accepted when the endpoint is built but rejected as a state
       * update, so sending the whole cluster back fails validation at the host.
       */
      for (const binding of mapping.bindings) {
        if (binding.event) continue;
        this.holdIfAbsent(
          uuid,
          binding.cluster,
          partId,
          binding.attributes(await this.currentValue(mapping, binding)),
        );
      }

      const battery = this.findBatteryService(accessory.platformAccessory, mapping.service);
      if (battery) {
        const level = await this.readBatteryLevel(battery);
        this.holdIfAbsent(uuid, POWER_SOURCE_CLUSTER, partId, {
          batChargeLevel: this.readBatteryChargeLevel(battery),
          ...(level === undefined
            ? {}
            : { batPercentRemaining: homeKitBatteryToMatterPercent(level) }),
        });
      }
    }
  }

  /**
   * One characteristic, read the way the descriptor reads it: through the getter rather than
   * the cache, with an unavailable or refused reading becoming undefined so the binding
   * encodes it as unknown instead of as HomeKit's default.
   */
  private async currentValue(mapping: ServiceMapping, binding: StateBinding): Promise<unknown> {
    try {
      if (binding.available && !binding.available()) return undefined;
      return await (binding.service ?? mapping.service)
        .getCharacteristic(binding.characteristic)
        .handleGetRequest();
    } catch {
      return undefined;
    }
  }

  /**
   * Keeps a reading only where nothing newer is already held. Read back inside the loop rather
   * than captured beforehand, because the awaits above give listener events room to land.
   */
  private holdIfAbsent(
    uuid: string,
    cluster: string,
    partId: string | undefined,
    attributes: Record<string, unknown>,
  ): void {
    const key = partId ? `${cluster}\u0000${partId}` : cluster;
    const forAccessory = this.held.get(uuid) ?? new Map<string, Record<string, unknown>>();
    forAccessory.set(key, { ...attributes, ...(forAccessory.get(key) ?? {}) });
    this.held.set(uuid, forAccessory);
  }

  /**
   * Sends what was observed while the endpoint was being created. Called once the accessory is
   * published, in the same turn as the flag, so a live update cannot overtake a held one.
   */
  private releaseHeldState(uuid: string): void {
    const forAccessory = this.held.get(uuid);
    this.held.delete(uuid);
    if (!forAccessory) {
      return;
    }

    const accessory = this.tracked.get(uuid);
    if (!accessory) {
      return;
    }

    for (const [key, attributes] of forAccessory) {
      const [cluster, partId] = key.split('\u0000');
      this.pushState(accessory, cluster, attributes, partId);
    }
  }

  /**
   * Stops mirroring an accessory and forgets what was observed for it. The two belong together:
   * state held for an identifier nothing is listening to will never be released by a
   * publication, and would otherwise surface later as the readings of whatever next takes that
   * identifier.
   */
  private untrack(uuid: string): void {
    this.trackers.get(uuid)?.forEach((detach) => detach());
    this.trackers.delete(uuid);
    this.tracked.delete(uuid);
    this.held.delete(uuid);
  }

  private pushState(
    accessory: ZWaveAccessory,
    cluster: string,
    attributes: Record<string, unknown>,
    partId?: string,
  ): void {
    const uuid = accessory.platformAccessory.UUID;

    if (!this.published.has(uuid)) {
      /**
       * The endpoint does not exist yet. Sending now would be dropped by the host, and the
       * event will not come again, so the value is kept and released at publication. Merging
       * by attribute leaves the newest reading of each one in place.
       */
      const key = partId ? `${cluster}\u0000${partId}` : cluster;
      const forAccessory = this.held.get(uuid) ?? new Map<string, Record<string, unknown>>();
      forAccessory.set(key, { ...(forAccessory.get(key) ?? {}), ...attributes });
      this.held.set(uuid, forAccessory);
      return;
    }

    void this.matter
      ?.updateAccessoryState(
        accessory.platformAccessory.UUID,
        cluster,
        attributes,
        ...(partId ? [partId] : []),
      )
      .catch((err) => {
        this.platform.log.debug(
          `Could not mirror ${cluster} to Matter: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}
