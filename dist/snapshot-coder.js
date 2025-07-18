/**
 * A minimal, ~10-line encoder/decoder for snapshots using JSON with a replacer/reviver.
 */
// The replacer function handles types that JSON doesn't support natively.
const replacer = (key, value) => {
    if (value instanceof Map) {
        return { _dataType: 'Map', value: Array.from(value.entries()) };
    }
    if (typeof value === 'bigint') {
        return { _dataType: 'BigInt', value: value.toString() };
    }
    return value;
};
// The reviver function reconstructs the original types from our custom format.
const reviver = (key, value) => {
    if (typeof value === 'object' && value !== null) {
        if (value._dataType === 'Map')
            return new Map(value.value);
        if (value._dataType === 'BigInt')
            return BigInt(value.value);
    }
    return value;
};
export const encode = (data) => Buffer.from(JSON.stringify(data, replacer));
export const decode = (buffer) => JSON.parse(buffer.toString(), reviver);
