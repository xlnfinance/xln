import Block from '../Block';
import IBody, { BodyTypes } from '../IBody';

export default class BlockMessage extends IBody {
  constructor(
    public blockNumber: number,
    public newSignatures: string[],
    public ackSignatures: string[],
    public block?: Block,
  ) {
    super(BodyTypes.kBlockMessage);
  }
}
