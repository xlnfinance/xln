import Block from '../Block';
import IBody from '../IBody';

export default interface BlockMessage extends IBody {
  block?: Block;
  newSignatures: string[];
  blockNumber: number;
  ackSignatures: string[];
}
