export type RelayTimelineDelivery = {
  outcome?: string;
  retryable?: boolean;
  fatal?: boolean;
  terminal?: boolean;
};

export type RelayTimelineEvent = {
  event?: string;
  status?: string;
  delivery?: RelayTimelineDelivery;
};

export type RelayTimelineTone = 'error' | 'warning' | 'neutral';

export const relayTimelineTone = (event: RelayTimelineEvent): RelayTimelineTone => {
  if (event.event === 'error') return 'error';

  const delivery = event.delivery;
  if (delivery) {
    if (delivery.fatal === true) return 'error';
    if (delivery.outcome === 'failed') return delivery.retryable === true ? 'warning' : 'error';
    if (delivery.outcome === 'queued' || delivery.outcome === 'deferred') return 'warning';
    return 'neutral';
  }

  if (event.status === 'rejected' || event.status === 'local-delivery-failed') return 'error';
  if (event.status === 'queued') return 'warning';
  return 'neutral';
};

export const isRelayTimelineError = (event: RelayTimelineEvent): boolean =>
  relayTimelineTone(event) === 'error';

export const isRelayTimelineWarning = (event: RelayTimelineEvent): boolean =>
  relayTimelineTone(event) === 'warning';
