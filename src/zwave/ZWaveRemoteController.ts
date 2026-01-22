import { Logger } from 'homebridge';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { IZWaveController, IZWaveNode } from './interfaces';

interface RemoteControllerOptions {
  debug?: boolean;
}

export class VirtualZWaveNode extends EventEmitter implements IZWaveNode {
  public ready = true;
  private values = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  private metadata = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(
    public readonly nodeId: number,
    private readonly controller: ZWaveRemoteController,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialState?: any
  ) {
    super();
    if (initialState) {
        // Hydrate from initial state if provided
        if (initialState.values) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            initialState.values.forEach((v: any) => this.updateValue(v, false));
        }
    }
  }

  // Helper to generate a key for value map
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getKey(valueId: any): string {
    return `${valueId.commandClass}-${valueId.endpoint || 0}-${valueId.property}-${valueId.propertyKey}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public updateValue(valueObj: any, emitEvent = true) {
     const key = this.getKey(valueObj);
     
     // Normalize: Events use 'newValue', State uses 'value'
     const storedValue = { ...valueObj };
     if ('newValue' in valueObj) {
         storedValue.value = valueObj.newValue;
     }
     
     this.values.set(key, storedValue);
     if (emitEvent) {
         this.emit('value updated', this, storedValue);
     }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getValue(valueId: any): any {
    const key = this.getKey(valueId);
    return this.values.get(key)?.value;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getValueMetadata(valueId: any): any {
    const key = this.getKey(valueId);
    return this.values.get(key)?.metadata;
  }
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getDefinedValueIDs(): any[] {
      return Array.from(this.values.values());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async setValue(valueId: any, value: any): Promise<boolean | undefined> {
    return this.controller.sendValue(this.nodeId, valueId, value);
  }

  public supportsCC(cc: number): boolean {
    // Check if we have any values for this CC
    // This is a rough approximation. A proper sync would include cc list.
    for (const v of this.values.values()) {
        if (v.commandClass === cc) return true;
    }
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getAllEndpoints(): any[] {
      // Aggregate endpoints from values
      const endpoints = new Set<number>();
      for (const v of this.values.values()) {
          endpoints.add(v.endpoint || 0);
      }
      
      return Array.from(endpoints).map(i => ({
          index: i,
          supportsCC: (cc: number) => {
               for (const v of this.values.values()) {
                    if (v.endpoint === i && v.commandClass === cc) return true;
                }
                return false;
          }
      }));
  }
}

export class ZWaveRemoteController extends EventEmitter implements IZWaveController {
  private ws: WebSocket | undefined;
  public readonly nodes = new Map<number, VirtualZWaveNode>();
  private messageId = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  public homeId: number | undefined;

  constructor(
    private readonly log: Logger,
    private readonly url: string,
    private readonly options: RemoteControllerOptions = {},
  ) {
    super();
  }

  public async start(): Promise<void> {
    this.log.info(`Connecting to Z-Wave JS Server at ${this.url}...`);
    
    return new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.url);
        
        this.ws.on('open', async () => {
            this.log.info('Connected to Z-Wave JS Server.');
            
            // 1. Start Listening
            const result = await this.sendCommand('startListening');
            
            // 2. Hydrate State
            if (result && result.state) {
                this.homeId = result.state.controller.homeId;
                this.log.info(`Remote Controller Home ID: ${this.homeId}`);
                
                if (result.state.nodes) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    result.state.nodes.forEach((nodeState: any) => {
                        this.addNode(nodeState);
                    });
                }
            }
            resolve();
        });

        this.ws.on('message', (data: string) => {
            try {
                const msg = JSON.parse(data);
                this.handleMessage(msg);
            } catch (err) {
                this.log.error('Error parsing WS message', err);
            }
        });

        this.ws.on('error', (err) => {
            this.log.error('WebSocket error:', err);
            if (!this.homeId) reject(err);
        });
        
        this.ws.on('close', () => {
             this.log.warn('WebSocket closed. Reconnecting...');
             // Simple reconnect logic could go here
        });
    });
  }
  
  public async stop(): Promise<void> {
      this.ws?.close();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(msg: any) {
      if (msg.type === 'result') {
          const p = this.pendingRequests.get(msg.messageId);
          if (p) {
              if (msg.success) p.resolve(msg.result);
              else p.reject(new Error(msg.message || 'Unknown error'));
              this.pendingRequests.delete(msg.messageId);
          }
          return;
      }
      
      if (msg.type === 'event') {
          this.handleEvent(msg.event);
      }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleEvent(event: any) {
      // this.log.debug('Received event:', JSON.stringify(event));
      
      if (event.source === 'node') {
          const node = this.nodes.get(event.nodeId);
          if (!node) return;

          if (event.event === 'value updated') {
             node.updateValue(event.args);
             this.emit('value updated', node); // Re-emit for platform
          }
      }
      
      if (event.source === 'controller') {
          if (event.event === 'node added') {
              this.log.info(`Remote Node added: ${event.node.nodeId}`);
              this.addNode(event.node);
          }
          if (event.event === 'node removed') {
              this.log.info(`Remote Node removed: ${event.nodeId}`);
              const node = this.nodes.get(event.nodeId);
              if (node) {
                  this.nodes.delete(event.nodeId);
                  this.emit('node removed', node);
              }
          }
          if (event.event === 'inclusion started') {
              this.emit('inclusion started', event.secure);
          }
          if (event.event === 'inclusion stopped') {
              this.emit('inclusion stopped');
          }
          if (event.event === 'exclusion started') {
              this.emit('exclusion started');
          }
          if (event.event === 'exclusion stopped') {
              this.emit('exclusion stopped');
          }
      }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private addNode(nodeState: any) {
      const node = new VirtualZWaveNode(nodeState.nodeId, this, nodeState);
      this.nodes.set(node.nodeId, node);
      this.emit('node ready', node); // Simulate node ready
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async sendCommand(command: string, args: any = {}): Promise<any> {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
      
      const messageId = ++this.messageId;
      const payload = {
          command,
          messageId,
          ...args,
      };
      
      return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
              if (this.pendingRequests.has(messageId)) {
                  this.pendingRequests.delete(messageId);
                  reject(new Error('Timeout'));
              }
          }, 10000);

          this.pendingRequests.set(messageId, { 
              resolve: (val) => { clearTimeout(timeout); resolve(val); }, 
              reject: (err) => { clearTimeout(timeout); reject(err); } 
          });
          this.ws!.send(JSON.stringify(payload));
      });
  }
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async sendValue(nodeId: number, valueId: any, value: any): Promise<boolean> {
      await this.sendCommand('node.setValue', {
          nodeId,
          valueId,
          value
      });
      return true;
  }

  public async startInclusion(): Promise<boolean> {
      await this.sendCommand('controller.beginInclusion', { strategy: 'Default' }); // Simplified
      this.emit('inclusion started', false);
      return true;
  }
  
  public async stopInclusion(): Promise<boolean> {
      await this.sendCommand('controller.stopInclusion');
      this.emit('inclusion stopped');
      return true;
  }
  
  public async startExclusion(): Promise<boolean> {
      await this.sendCommand('controller.beginExclusion');
      this.emit('exclusion started');
      return true;
  }
  
  public async stopExclusion(): Promise<boolean> {
      await this.sendCommand('controller.stopExclusion');
      this.emit('exclusion stopped');
      return true;
  }
  
  public async startHealing(): Promise<boolean> {
      await this.sendCommand('controller.beginRebuildingRoutes');
      return true;
  }
  
  public async stopHealing(): Promise<boolean> {
      await this.sendCommand('controller.stopRebuildingRoutes');
      return true;
  }
}
