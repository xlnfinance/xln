import { useEffect, useRef, useState } from 'react';
import { getJson, resolveApiBase } from '../runtime/http';

type Status = { creditOfficerUnavailable: string; error: string };
const pending: Status = { creditOfficerUnavailable: '', error: '' };

/** One read per activation, shared by chapters and StrictMode effect replays. */
export function createTourCreditOfficerProbe() {
  let request: Promise<Status> | null = null;
  return (active: boolean, apiBase: string): Promise<Status> | null => {
    if (!active) {
      request = null;
      return null;
    }
    return (request ??= getJson('/api/credit-officer/status', {}, apiBase)
      .then(status => {
        if (typeof status['enabled'] !== 'boolean') throw new Error('Invalid credit officer status');
        return { creditOfficerUnavailable: status['enabled'] ? '' : 'disabled on this stack', error: '' };
      })
      .catch(error => ({
        creditOfficerUnavailable: '',
        error: error instanceof Error ? error.message : String(error),
      })));
  };
}

export function useCreditOfficerStatus(active: boolean): Status {
  const read = useRef(createTourCreditOfficerProbe());
  const probe = useRef<Promise<Status> | null>(null);
  const [result, setResult] = useState<{ probe: Promise<Status>; status: Status } | null>(null);
  useEffect(() => {
    const request = (probe.current = read.current(active, active ? resolveApiBase() : ''));
    if (!request) return;
    let stopped = false;
    void request.then(status => {
      if (!stopped) setResult({ probe: request, status });
    });
    return () => {
      stopped = true;
    };
  }, [active]);
  return active && result?.probe === probe.current ? result.status : pending;
}
