import IBody from './IBody';
import IHeader from './IHeader';

export default interface IMessage {
  header: IHeader;
  body: IBody;
}
