import { EventEmitter } from 'events';
import { ZWaveNode, ValueID, ValueMetadata, Endpoint, InterviewStage, RebuildRoutesStatus, SetValueResult } from 'zwave-js';

export interface IZWaveController extends EventEmitter {
  homeId: number | undefined;
  nodes: Map<number, ZWaveNode>; 
  start(): Promise<void>;
  stop(): Promise<void>;
  startInclusion(): Promise<boolean>;
  stopInclusion(): Promise<boolean>;
  startExclusion(): Promise<boolean>;
  stopExclusion(): Promise<boolean>;
  startHealing(): Promise<boolean>;
  stopHealing(): Promise<boolean>;
  setS2Pin(pin: string): void;
  
  on(event: 'status updated', listener: (status: string) => void): this;
  on(event: 'inclusion started', listener: (secure: boolean) => void): this;
  on(event: 'inclusion stopped', listener: () => void): this;
  on(event: 'exclusion started', listener: () => void): this;
  on(event: 'exclusion stopped', listener: () => void): this;
  on(event: 'heal network progress', listener: (progress: ReadonlyMap<number, RebuildRoutesStatus>) => void): this;
  on(event: 'heal network done', listener: (result: ReadonlyMap<number, RebuildRoutesStatus>) => void): this;
  on(event: 'node added', listener: (node: ZWaveNode) => void): this;
  on(event: 'node ready', listener: (node: ZWaveNode) => void): this;
  on(event: 'node removed', listener: (node: ZWaveNode) => void): this;
  on(event: 'value updated', listener: (node: ZWaveNode) => void): this;
}

export interface IZWaveNode {
  nodeId: number;
  name?: string;
  deviceConfig?: {
    label?: string;
    manufacturer?: string;
  };
  ready: boolean;
  interviewStage: InterviewStage;
  status: number;
  
  // Methods
  getValue(valueId: ValueID): unknown;
  setValue(valueId: ValueID, value: unknown): Promise<SetValueResult>;
  supportsCC(cc: number): boolean;
  getDefinedValueIDs(): ValueID[];
  getAllEndpoints(): Endpoint[];
  getValueMetadata(valueId: ValueID): ValueMetadata;
  
  // Events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): this;
}
