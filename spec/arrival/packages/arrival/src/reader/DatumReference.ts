// A forward placeholder the reader leaves where a datum label (`#0#`) refers
// back to a structure (`#0=`) that may not be fully built yet; a second pass
// patches it, which is how circular literals are read without infinite descent.
export class DatumReference {
  constructor(
    public readonly name: any,
    public readonly data: any,
  ) {}

  valueOf() {
    return this.data;
  }
}
