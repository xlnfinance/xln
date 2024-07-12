export enum BodyTypes {
  kUndef = 0,
  kBlockMessage = 1,
}

export default interface IBody {
  type: BodyTypes;
}
