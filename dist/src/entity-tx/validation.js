// Security validation helpers: validateNonce, validateMessage
import { log } from '../utils';
export const validateNonce = (currentNonce, expectedNonce, from) => {
    try {
        if (expectedNonce !== currentNonce + 1) {
            log.error(`❌ Invalid nonce from ${from}: expected ${currentNonce + 1}, got ${expectedNonce}`);
            return false;
        }
        return true;
    }
    catch (error) {
        log.error(`❌ Nonce validation error: ${error}`);
        return false;
    }
};
export const validateMessage = (message) => {
    try {
        if (typeof message !== 'string') {
            log.error(`❌ Message must be string, got: ${typeof message}`);
            return false;
        }
        if (message.length > 1000) {
            log.error(`❌ Message too long: ${message.length} > 1000 chars`);
            return false;
        }
        if (message.length === 0) {
            log.error(`❌ Empty message not allowed`);
            return false;
        }
        return true;
    }
    catch (error) {
        log.error(`❌ Message validation error: ${error}`);
        return false;
    }
};
