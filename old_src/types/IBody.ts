export enum BodyTypes {
  kUndef = 0,
  kFlushMessage = 1,
  kBroadcastProfile = 2,
  kGetProfile = 3,
}

export default class IBody {
  type: BodyTypes;
  [key: string]: any;

  constructor(type: BodyTypes) {
    this.type = type;
  }
}
