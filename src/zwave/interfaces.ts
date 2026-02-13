import { EventEmitter } from 'events';

export interface IZWaveController extends EventEmitter {
  homeId: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodes: Map<number, any>; 
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'heal network progress', listener: (progress: any) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'heal network done', listener: (result: any) => void): this;
  on(event: 'node added', listener: (node: IZWaveNode) => void): this;
  on(event: 'node ready', listener: (node: IZWaveNode) => void): this;
  on(event: 'node removed', listener: (node: IZWaveNode) => void): this;
  on(event: 'value updated', listener: (node: IZWaveNode) => void): this;
}

export interface IZWaveNode {
  nodeId: number;
  name?: string;
  deviceConfig?: {
    label?: string;
    manufacturer?: string;
  };
  ready: boolean;
  interviewStage: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  status: number;
  
  // Methods
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
