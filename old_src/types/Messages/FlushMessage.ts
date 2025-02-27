import IBody, { BodyTypes } from '../IBody';
import Block from '../Block';

export interface IFlushMessage {
  blockId: number;
  pendingSignatures: string[];
  newSignatures?: string[];
  block?: Block;
  debugState?: string;
}

export default class FlushMessage extends IBody implements IFlushMessage {
  constructor(
    public blockId: number,
    public pendingSignatures: string[] = [],
    public newSignatures?: string[],
    public block?: Block,
    public debugState?: string,
    public counter: number = 0 
  ) {
    super(BodyTypes.kFlushMessage);
  }
}

export function isValidFlushMessage(obj: any): obj is IFlushMessage {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  if (typeof obj.blockId !== 'number' || isNaN(obj.blockId) || obj.blockId < 0) {
    return false;
  }

  if (!Array.isArray(obj.pendingSignatures) || !obj.pendingSignatures.every((sig: any) => typeof sig === 'string')) {
    return false;
  }

  if (obj.newSignatures !== undefined && obj.newSignatures !== null) {
    if (!Array.isArray(obj.newSignatures) || !obj.newSignatures.every((sig: any) => typeof sig === 'string')) {
      return false;
    }
  }

  
  if (obj.block !== undefined && obj.block !== null) {
    if (typeof obj.block !== 'object' || obj.block === null) {
      return false;
    }
    // Add more specific checks for Block properties here
    if (typeof obj.block.isLeft !== 'boolean' ||
        typeof obj.block.timestamp !== 'number' ||
        typeof obj.block.previousStateHash !== 'string' ||
        typeof obj.block.previousBlockHash !== 'string' ||
        typeof obj.block.blockId !== 'number' ||
        !Array.isArray(obj.block.transitions)) {

      return false;
    }
  }

  if ((obj.newSignatures === undefined) !== (obj.block === undefined)) {
    return false;
  }

  return true;
}