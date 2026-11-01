import { EventEmitter } from 'events';
import {
  ZWaveNode,
  ValueID,
  ValueMetadata,
  Endpoint,
  InterviewStage,
  RebuildRoutesStatus,
  SetValueResult,
} from 'zwave-js';

/**
 * `busy` is distinct from `refused`: the driver is rebuilding routes from a request this plugin
 * no longer tracks, so a rebuild is running even though this one did not start.
 */
export type HealStartResult = 'started' | 'busy' | 'refused';

export interface ZWaveValueEvent {
  commandClass: number;
  endpoint?: number;
  property: string | number;
  propertyKey?: string | number;
  newValue?: unknown;
  prevValue?: unknown;
  /**
   * Provenance, when the emitter has it. zwave-js tags an optimistic cache write as 'driver' on
   * its internal value DB, but its node-level 'value updated' event deletes the field before
   * emitting (`translateValueEvent`, checked in 15.20.1 and 15.27.1), so events from a node
   * arrive without it and the controller classifies echoes by value instead.
   */
  source?: 'driver' | 'node';
}

/**
 * The last observed route to a node. Z-Wave picks a route per transmission, so this describes
 * what was used most recently rather than a permanent connection.
 */
export interface ObservedRoute {
  repeaters: number[];
  direct: boolean;
  /**
   * The RSSI of the ACK the controller received, as a dBm measurement or the words for an RSSI
   * error state. On a routed transmission it is the controller's first hop.
   */
  ackRSSI?: number | string;
  protocolDataRate?: number;
  routeFailedBetween?: [number, number];
}

export interface NodeRouteDiagnostics {
  nodeId: number;
  name: string;
  status: number;
  neighbors?: number[];
  lastWorkingRoute?: ObservedRoute;
  nextToLastWorkingRoute?: ObservedRoute;
  /**
   * zwave-js keeps an exponentially weighted average, not the latest reading, of the ACK RSSI the
   * controller measured. For a routed transmission that is the first hop, not the destination.
   */
  averageAckRSSI?: number | string;
  roundTripTimeMs?: number;
  commandsTX?: number;
  commandsRX?: number;
  commandsDroppedTX?: number;
  commandsDroppedRX?: number;
  lastSeen?: string;
  backgroundRSSI?: Record<string, number | string>;
}

/** Why a node may or may not be removed from the network. */
export interface FailedNodeRemovalAssessment {
  nodeId: number;
  name: string;
  status: number;
  eligible: boolean;
  reason: string;
}

export interface IZWaveController extends EventEmitter {
  homeId: number | undefined;
  nodes: Map<number, ZWaveNode>;
  start(): Promise<void>;
  stop(): Promise<void>;
  startInclusion(): Promise<boolean>;
  stopInclusion(): Promise<boolean>;
  startExclusion(): Promise<boolean>;
  stopExclusion(): Promise<boolean>;
  startHealing(): Promise<HealStartResult>;
  stopHealing(): Promise<boolean>;
  /** Whether a route rebuild this plugin started is still in progress. */
  isHealing(): boolean;
  assessFailedNodeRemoval(nodeId: number): Promise<FailedNodeRemovalAssessment>;
  removeFailedNode(nodeId: number, confirmNodeId: number): Promise<void>;
  getNodeRouteDiagnostics(nodeId: number): Promise<NodeRouteDiagnostics>;
  /**
   * Whether the driver is rebuilding routes, whoever asked for it. A rebuild started before
   * this plugin began tracking one is invisible to `isHealing` but is still running.
   */
  isRebuildingRoutes(): boolean;
  setNodeName(nodeId: number, name: string): Promise<void>;
  refreshNodeInfo(nodeId: number): Promise<{ nodeId: number; requiresWakeUp: boolean }>;
  setS2Pin(pin: string): void;

  // Firmware Update Methods
  getAvailableFirmwareUpdates(nodeId: number): Promise<unknown[]>;
  beginFirmwareUpdate(nodeId: number, update: unknown): Promise<void>;
  abortFirmwareUpdate(nodeId: number): Promise<void>;

  on(event: 'status updated', listener: (status: string) => void): this;
  on(event: 'inclusion started', listener: (secure: boolean) => void): this;
  on(event: 'inclusion stopped', listener: () => void): this;
  on(event: 'exclusion started', listener: () => void): this;
  on(event: 'exclusion stopped', listener: () => void): this;
  on(
    event: 'heal network progress',
    listener: (progress: ReadonlyMap<number, RebuildRoutesStatus>) => void,
  ): this;
  on(
    event: 'heal network done',
    listener: (result: ReadonlyMap<number, RebuildRoutesStatus>) => void,
  ): this;
  on(event: 'heal network stopped', listener: (reason: 'cancelled' | 'timeout') => void): this;
  on(event: 'node added', listener: (node: ZWaveNode) => void): this;
  on(event: 'node ready', listener: (node: ZWaveNode) => void): this;
  on(event: 'node updated', listener: (node: ZWaveNode) => void): this;
  on(event: 'node removed', listener: (node: ZWaveNode) => void): this;
  on(event: 'value notification', listener: (node: ZWaveNode, args: ZWaveValueEvent) => void): this;
  on(event: 'value updated', listener: (node: ZWaveNode, args: ZWaveValueEvent) => void): this;
  /** `percent` is the driver's own total progress across every file, 0 to 100. */
  on(event: 'firmware update progress', listener: (nodeId: number, percent: number) => void): this;
  /**
   * `success` is the driver's own reading of the final status. The status number cannot stand
   * in for it: a transmission failure is 1 and a timeout is -1, both of which are truthy, so
   * testing the number for truth reports a failed update as a successful one.
   */
  on(
    event: 'firmware update finished',
    listener: (nodeId: number, success: boolean, waitTime?: number) => void,
  ): this;
}

export interface IZWaveNode {
  nodeId: number;
  name?: string;
  manufacturer?: string;
  label?: string;
  deviceSerialNumber?: string;
  manufacturerId?: number;
  productType?: number;
  productId?: number;
  deviceConfig?: {
    label?: string;
    description?: string;
    manufacturer?: string;
  };
  ready: boolean;
  interviewStage: InterviewStage;
  status: number;
  firmwareVersion?: string;
  isListening?: boolean | string;
  isFrequentListening?: boolean | string;

  // Methods
  getValue(valueId: ValueID): unknown;
  setValue(valueId: ValueID, value: unknown): Promise<SetValueResult>;
  supportsCC(cc: number): boolean;
  getDefinedValueIDs(): ValueID[];
  getAllEndpoints(): Endpoint[];
  getValueMetadata(valueId: ValueID): ValueMetadata;
  /**
   * When the node last updated this value, which is the only honest answer to how fresh a reading
   * is. The time the plugin read its own cache says nothing about the device.
   */
  getValueTimestamp(valueId: ValueID): number | undefined;
  /**
   * Asks the device for current values of one command class.
   *
   * zwave-js's own documentation says not to await this, and it resolves even where every
   * endpoint failed, because it catches and logs each one. Its settling therefore reports that
   * the attempt finished, never that any value was confirmed.
   */
  refreshCCValues(cc: number): Promise<void>;
  /**
   * Asks the device for one value and answers with what it reported.
   *
   * This is the only thing that can confirm a write. The driver puts its own optimistic answer
   * into the cache after an accepted write and strips the mark that says so, which leaves the
   * cache and its timestamps unable to tell the device's word from the driver's. A Get cannot be
   * confused that way: `undefined` means the device said nothing usable.
   *
   * Its defaults are built for background polling, so a caller the reader is waiting on passes
   * its own priority and attempts.
   */
  pollValue(
    valueId: ValueID,
    options?: { priority?: number; maxSendAttempts?: number },
  ): Promise<unknown>;

  // Events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): this;
}
