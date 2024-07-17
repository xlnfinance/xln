import Block from '../Block';
import IBody, { BodyTypes } from '../IBody';

export default class FlushMessage extends IBody {
  constructor(
    public blockNumber: number,
    public newSignatures: string[],
    public pendingSignatures: string[],
    public block?: Block,
  ) {
    super(BodyTypes.kFlushMessage);
  }
}
