/**
 * XLN Database Types
 *
 * Sovereign type definitions for database layer.
 * No 'any' types allowed.
 */
/**
 * Database key prefixes for different domains
 * Each domain is sovereign with its own keyspace
 */
export var DBPrefix;
(function (DBPrefix) {
    DBPrefix["ENTITY_STATE"] = "entity:state:";
    DBPrefix["ENTITY_PROFILE"] = "entity:profile:";
    DBPrefix["NAME_INDEX"] = "name:index:";
    DBPrefix["CHANNEL_STATE"] = "channel:state:";
    DBPrefix["ACCOUNT_STATE"] = "account:state:";
    DBPrefix["J_BLOCK"] = "j:block:";
    DBPrefix["SNAPSHOT"] = "snapshot:";
    DBPrefix["ORDERBOOK"] = "orderbook:";
})(DBPrefix || (DBPrefix = {}));
/**
 * Helper to create prefixed keys
 */
export function createDBKey(prefix, id) {
    return Buffer.from(`${prefix}${id}`);
}
/**
 * Helper to parse prefixed keys
 */
export function parseDBKey(key) {
    const keyStr = key.toString();
    const colonIndex = keyStr.lastIndexOf(':');
    if (colonIndex === -1) {
        return { prefix: '', id: keyStr };
    }
    return {
        prefix: keyStr.substring(0, colonIndex + 1),
        id: keyStr.substring(colonIndex + 1)
    };
}
