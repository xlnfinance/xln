export enum BodyTypes {
  kUndef = 0,
  kFlushMessage = 1,
}

export default class IBody {
  type: BodyTypes;

  constructor(type: BodyTypes) {
    this.type = type;
  }
}
