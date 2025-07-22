// === ENTITY FACTORY ===
import { generateLazyEntityId, generateNumberedEntityId, hashBoard, encodeBoard } from './entity-utils.js';
const DEBUG = true;
// 1. LAZY ENTITIES (Free, instant)
export const createLazyEntity = (name, validators, threshold, jurisdiction) => {
    const entityId = generateLazyEntityId(validators, threshold);
    if (DEBUG)
        console.log(`🔒 Creating lazy entity: ${name}`);
    if (DEBUG)
        console.log(`   EntityID: ${entityId} (quorum hash)`);
    if (DEBUG)
        console.log(`   Validators: ${validators.join(', ')}`);
    if (DEBUG)
        console.log(`   Threshold: ${threshold}`);
    if (DEBUG)
        console.log(`   🆓 FREE - No gas required`);
    const shares = {};
    validators.forEach(validator => {
        shares[validator] = 1n; // Equal voting power for simplicity
    });
    return {
        mode: 'proposer-based',
        threshold,
        validators,
        shares,
        jurisdiction
    };
};
// 2. NUMBERED ENTITIES (Small gas cost)
export const createNumberedEntity = async (name, validators, threshold, jurisdiction) => {
    if (!jurisdiction) {
        throw new Error("Jurisdiction required for numbered entity registration");
    }
    const boardHash = hashBoard(encodeBoard({
        mode: 'proposer-based',
        threshold,
        validators,
        shares: validators.reduce((acc, v) => ({ ...acc, [v]: 1n }), {}),
        jurisdiction
    }));
    if (DEBUG)
        console.log(`🔢 Creating numbered entity: ${name}`);
    if (DEBUG)
        console.log(`   Board Hash: ${boardHash}`);
    if (DEBUG)
        console.log(`   Jurisdiction: ${jurisdiction.name}`);
    if (DEBUG)
        console.log(`   💸 Gas required for registration`);
    // Simulate blockchain call
    const entityNumber = Math.floor(Math.random() * 1000000) + 1; // Demo: random number
    const entityId = generateNumberedEntityId(entityNumber);
    if (DEBUG)
        console.log(`   ✅ Assigned Entity Number: ${entityNumber}`);
    if (DEBUG)
        console.log(`   EntityID: ${entityId}`);
    const shares = {};
    validators.forEach(validator => {
        shares[validator] = 1n;
    });
    const config = {
        mode: 'proposer-based',
        threshold,
        validators,
        shares,
        jurisdiction
    };
    return { config, entityNumber };
};
// 3. NAMED ENTITIES (Premium - admin assignment required)
export const requestNamedEntity = async (name, entityNumber, jurisdiction) => {
    if (!jurisdiction) {
        throw new Error("Jurisdiction required for named entity");
    }
    if (DEBUG)
        console.log(`🏷️ Requesting named entity assignment`);
    if (DEBUG)
        console.log(`   Name: ${name}`);
    if (DEBUG)
        console.log(`   Target Entity Number: ${entityNumber}`);
    if (DEBUG)
        console.log(`   Jurisdiction: ${jurisdiction.name}`);
    if (DEBUG)
        console.log(`   👑 Requires admin approval`);
    // Simulate admin assignment request
    const requestId = `req_${Math.random().toString(16).substring(2, 10)}`;
    if (DEBUG)
        console.log(`   📝 Name assignment request submitted: ${requestId}`);
    if (DEBUG)
        console.log(`   ⏳ Waiting for admin approval...`);
    return requestId;
};
export const transferNameBetweenEntities = async (name, fromNumber, toNumber, jurisdiction) => {
    if (DEBUG)
        console.log(`🔄 Transferring name "${name}" from #${fromNumber} to #${toNumber}`);
    const txHash = `0x${Math.random().toString(16).substring(2, 66)}`;
    if (DEBUG)
        console.log(`✅ Name transferred! TX: ${txHash}`);
    return txHash;
};
