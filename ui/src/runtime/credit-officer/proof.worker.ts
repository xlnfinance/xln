import { validCreditProof, type CreditRequest } from '@xln/core/orchestrator/credit-officer/proof';

self.onmessage = (event: MessageEvent<{ request: CreditRequest; bits: number }>) => {
  const { request, bits } = event.data;
  if (!Number.isInteger(bits) || bits < 1 || bits > 24) {
    self.postMessage({ error: 'Credit proof difficulty exceeds this wallet limit' });
    return;
  }
  // The server verifies one digest; only the requesting wallet pays the search cost.
  const now = Date.now();
  const salt = crypto.randomUUID().replaceAll('-', '');
  for (let counter = 0; counter < 2 ** 28; counter++) {
    request.nonce = salt + counter.toString(16);
    if (validCreditProof(request, request.hubEntityId, now, bits)) {
      self.postMessage({ request });
      return;
    }
  }
  self.postMessage({ error: 'Credit proof search exhausted; request a fresh challenge' });
};
