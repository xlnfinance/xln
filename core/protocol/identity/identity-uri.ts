import {
  XLN_URI_SCHEME,
  toEntityId,
  toEpAddress,
  toJId,
  toSignerId,
  type ReplicaUri,
} from './';

export const formatReplicaUri = (uri: ReplicaUri): string =>
  `${XLN_URI_SCHEME}${uri.runtimeHost}/${uri.jId}/${uri.epAddress}/${uri.entityId}/${uri.signerId}`;

export const parseReplicaUri = (uriString: string): ReplicaUri => {
  if (!uriString.startsWith(XLN_URI_SCHEME)) {
    throw new Error(`FINTECH-SAFETY: Invalid URI scheme: ${uriString}`);
  }
  const [runtimeHost, jId, epAddress, entityId, signerId] =
    uriString.slice(XLN_URI_SCHEME.length).split('/');
  if (!runtimeHost || !jId || !epAddress || !entityId || !signerId) {
    throw new Error(`FINTECH-SAFETY: Invalid URI format: ${uriString}`);
  }
  return {
    runtimeHost,
    jId: toJId(jId),
    epAddress: toEpAddress(epAddress),
    entityId: toEntityId(entityId),
    signerId: toSignerId(signerId),
  };
};
