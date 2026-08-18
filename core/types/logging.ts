/** Log severity levels - ordered by priority */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Log categories for filtering */
export type LogCategory =
  | 'consensus'     // BFT entity consensus
  | 'account'       // Bilateral account consensus
  | 'jurisdiction'  // J-machine events
  | 'evm'           // Blockchain interactions
  | 'network'       // Routing/messaging
  | 'ui'            // UI events
  | 'system';       // System-level

/** Single log entry attached to a frame */
export interface FrameLogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  entityId?: string;              // Associated entity (if applicable)
  data?: Record<string, unknown>; // Structured data
}
