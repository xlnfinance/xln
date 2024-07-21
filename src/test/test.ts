enum EventType {
  kEventOne,
  kEventTwo,
}

class Event {
  public readonly type: EventType;

  constructor(type: EventType) {
    this.type = type;
  }
}

class EventOne extends Event {
  constructor() {
    super(EventType.kEventTwo);
  }
}

const str = JSON.stringify(new EventOne());
console.log(str);

const obj: EventOne = JSON.parse(str);

console.log('type:: ', obj.type);
