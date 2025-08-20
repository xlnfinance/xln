// Universal Server Adapter for XLN
// Provides a unified interface that works in both browser and headless environments
// Routes calls to appropriate implementation based on environment detection

import type { XLNEnvironment, EntityInput, EntityOutput, Snapshot } from '../types';

// Environment detection
export const isBrowser = typeof window !== 'undefined';
export const isHeadless = !isBrowser;

// Server adapter interface
export interface ServerAdapter {
  initialize(): Promise<XLNEnvironment>;
  applyServerInput(env: XLNEnvironment, input: { serverTxs?: any[], entityInputs?: EntityInput[] }): Promise<{ entityOutbox: EntityOutput[], mergedInputs: EntityInput[] }>;
  processUntilEmpty(env: XLNEnvironment, outputs: EntityOutput[]): Promise<XLNEnvironment>;
  runDemo(env: XLNEnvironment): Promise<void>;
  clearDatabase(): Promise<void>;
  getHistory(): Snapshot[];
  getSnapshot(index: number): Snapshot | null;
  
  // Entity creation functions
  createLazyEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any): Promise<{ config: any }>;
  generateLazyEntityId(validators: any[], threshold: bigint): Promise<string>;
  createNumberedEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any): Promise<{ config: any, entityNumber: number }>;
  generateNumberedEntityId(entityNumber: number): Promise<string>;
  
  // Display functions
  formatEntityDisplay(entityId: string): Promise<string>;
  formatSignerDisplay(signerId: string): Promise<string>;
  generateEntityAvatar(entityId: string): Promise<string>;
  generateSignerAvatar(signerId: string): Promise<string>;
}

// Browser implementation using dynamic import of real server.ts
class BrowserServerAdapter implements ServerAdapter {
  private serverModule: any = null;

  private async getServerModule() {
    if (!this.serverModule) {
      console.log('🌐 Browser: Loading real server.ts module...');
      try {
        // Try to import the real server module using relative path
        this.serverModule = await import('../../../../src/server');
        console.log('✅ Browser: Real server.ts module loaded successfully');
      } catch (error) {
        console.error('❌ Browser: Failed to load real server.ts, falling back to mock:', error);
        console.error('Error details:', error);
        // Fallback to mock implementation
        const mockModule = await import('../utils/xlnServer');
        this.serverModule = mockModule.XLNServer;
      }
    }
    return this.serverModule;
  }

  async initialize(): Promise<XLNEnvironment> {
    const server = await this.getServerModule();
    return server.main();
  }

  async applyServerInput(env: XLNEnvironment, input: { serverTxs?: any[], entityInputs?: EntityInput[] }) {
    const server = await this.getServerModule();
    return server.applyServerInput(env, input);
  }

  async processUntilEmpty(env: XLNEnvironment, outputs: EntityOutput[]) {
    const server = await this.getServerModule();
    return server.processUntilEmpty(env, outputs);
  }

  async runDemo(env: XLNEnvironment) {
    const server = await this.getServerModule();
    return server.runDemoWrapper(env);
  }

  async clearDatabase() {
    const server = await this.getServerModule();
    return server.clearDatabase();
  }

  getHistory(): Snapshot[] {
    // For browser, we'll need to implement history management
    return [];
  }

  getSnapshot(index: number): Snapshot | null {
    return null;
  }

  async createLazyEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any) {
    const server = await this.getServerModule();
    return server.createLazyEntity(name, validators, threshold, jurisdiction);
  }

  async generateLazyEntityId(validators: any[], threshold: bigint) {
    const server = await this.getServerModule();
    return server.generateLazyEntityId(validators, threshold);
  }

  async createNumberedEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any) {
    const server = await this.getServerModule();
    return server.createNumberedEntity(name, validators, threshold, jurisdiction);
  }

  async generateNumberedEntityId(entityNumber: number) {
    const server = await this.getServerModule();
    return server.generateNumberedEntityId(entityNumber);
  }

  async formatEntityDisplay(entityId: string) {
    const server = await this.getServerModule();
    return server.formatEntityDisplay(entityId);
  }

  async formatSignerDisplay(signerId: string) {
    const server = await this.getServerModule();
    return server.formatSignerDisplay(signerId);
  }

  async generateEntityAvatar(entityId: string) {
    const server = await this.getServerModule();
    return server.generateEntityAvatar(entityId);
  }

  async generateSignerAvatar(signerId: string) {
    const server = await this.getServerModule();
    return server.generateSignerAvatar(signerId);
  }
}

// Headless implementation using WebSocket/IPC communication
class HeadlessServerAdapter implements ServerAdapter {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: Function, reject: Function }>();

  constructor(private wsUrl: string = 'ws://localhost:8080') {}

  private async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      
      this.ws.onopen = () => {
        console.log('🔗 Headless: Connected to XLN server via WebSocket');
        resolve();
      };

      this.ws.onerror = (error) => {
        console.error('❌ Headless: WebSocket connection failed:', error);
        reject(error);
      };

      this.ws.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data);
          const request = this.pendingRequests.get(response.id);
          if (request) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              request.reject(new Error(response.error));
            } else {
              request.resolve(response.result);
            }
          }
        } catch (error) {
          console.error('❌ Headless: Failed to parse WebSocket message:', error);
        }
      };
    });
  }

  private async sendRequest(method: string, params: any[] = []): Promise<any> {
    await this.connect();
    
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });
      
      this.ws!.send(JSON.stringify({
        id,
        method,
        params
      }));
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async initialize(): Promise<XLNEnvironment> {
    return this.sendRequest('main');
  }

  async applyServerInput(env: XLNEnvironment, input: { serverTxs?: any[], entityInputs?: EntityInput[] }) {
    return this.sendRequest('applyServerInput', [env, input]);
  }

  async processUntilEmpty(env: XLNEnvironment, outputs: EntityOutput[]) {
    return this.sendRequest('processUntilEmpty', [env, outputs]);
  }

  async runDemo(env: XLNEnvironment) {
    return this.sendRequest('runDemo', [env]);
  }

  async clearDatabase() {
    return this.sendRequest('clearDatabase');
  }

  getHistory(): Snapshot[] {
    // For headless, history is managed by the server
    return [];
  }

  getSnapshot(index: number): Snapshot | null {
    return null;
  }

  async createLazyEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any) {
    return this.sendRequest('createLazyEntity', [name, validators, threshold.toString(), jurisdiction]);
  }

  async generateLazyEntityId(validators: any[], threshold: bigint) {
    return this.sendRequest('generateLazyEntityId', [validators, threshold.toString()]);
  }

  async createNumberedEntity(name: string, validators: string[], threshold: bigint, jurisdiction?: any) {
    return this.sendRequest('createNumberedEntity', [name, validators, threshold.toString(), jurisdiction]);
  }

  async generateNumberedEntityId(entityNumber: number) {
    return this.sendRequest('generateNumberedEntityId', [entityNumber]);
  }

  async formatEntityDisplay(entityId: string) {
    return this.sendRequest('formatEntityDisplay', [entityId]);
  }

  async formatSignerDisplay(signerId: string) {
    return this.sendRequest('formatSignerDisplay', [signerId]);
  }

  async generateEntityAvatar(entityId: string) {
    return this.sendRequest('generateEntityAvatar', [entityId]);
  }

  async generateSignerAvatar(signerId: string) {
    return this.sendRequest('generateSignerAvatar', [signerId]);
  }
}

// Factory function to create appropriate adapter
export function createServerAdapter(options?: { 
  mode?: 'browser' | 'headless' | 'auto',
  wsUrl?: string 
}): ServerAdapter {
  const mode = options?.mode || 'auto';
  
  if (mode === 'auto') {
    if (isBrowser) {
      console.log('🌐 Auto-detected browser environment, using BrowserServerAdapter');
      return new BrowserServerAdapter();
    } else {
      console.log('🖥️ Auto-detected headless environment, using HeadlessServerAdapter');
      return new HeadlessServerAdapter(options?.wsUrl);
    }
  } else if (mode === 'browser') {
    return new BrowserServerAdapter();
  } else {
    return new HeadlessServerAdapter(options?.wsUrl);
  }
}

// Default export
export const serverAdapter = createServerAdapter();
