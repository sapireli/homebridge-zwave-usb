import { EventEmitter } from 'events';

export interface IZWaveController extends EventEmitter {
  homeId: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodes: Map<number, any>; // Relaxed type to allow VirtualNode
  start(): Promise<void>;
  stop(): Promise<void>;
  startInclusion(): Promise<boolean>;
  stopInclusion(): Promise<boolean>;
  startExclusion(): Promise<boolean>;
  stopExclusion(): Promise<boolean>;
  startHealing(): Promise<boolean>;
  stopHealing(): Promise<boolean>;
}

// We need an interface that matches ZWaveNode's public API that we use
export interface IZWaveNode {
  nodeId: number;
  name?: string;
  deviceConfig?: {
    label?: string;
  };
  ready: boolean;
  
  // Methods we use
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getValue(valueId: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setValue(valueId: any, value: any): Promise<boolean | undefined>;
  supportsCC(cc: number): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDefinedValueIDs(): any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllEndpoints(): any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getValueMetadata(valueId: any): any;
  
  // Events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): this;
}
