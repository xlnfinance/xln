export type Codec<T> = Readonly<{
  encode: (value: T) => Uint8Array;
  decode: (bytes: Uint8Array) => T;
}>;
