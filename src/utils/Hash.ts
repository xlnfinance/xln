import { keccak256 } from 'js-sha3';
import { encode } from './Codec';

export default function hash<T>(obj: T) {
  return keccak256(encode(obj));
}
