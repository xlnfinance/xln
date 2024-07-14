export enum BodyTypes {
  kUndef = 0,
  kBlockMessage = 1,
}

export default class IBody {
  type: BodyTypes;

  constructor(type: BodyTypes) {
    this.type = type;
  }
}
