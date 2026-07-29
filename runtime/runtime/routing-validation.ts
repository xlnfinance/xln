import type {
  DeliverableEntityInput,
  RoutedEntityInput,
} from '../types';
import { validateObject } from '../protocol/validation-primitives';

/**
 * Entity outputs and destination inputs share one canonical wire shape.
 * Direction is routing metadata, not a second schema.
 */
export const decodeRoutedEntityOutput = (
  output: unknown,
): RoutedEntityInput => {
  const value = validateObject(output, 'RoutedEntityOutput');
  if (typeof value['entityId'] !== 'string' || value['entityId'].length === 0) {
    throw new Error(
      'FINANCIAL-SAFETY: EntityOutput entityId is missing - routing corruption',
    );
  }
  if (
    typeof value['signerId'] !== 'string' ||
    value['signerId'].trim().length === 0
  ) {
    throw new Error(
      'FINANCIAL-SAFETY: EntityOutput signerId is missing - routed outputs must target an exact signer replica',
    );
  }
  return output as RoutedEntityInput;
};

/** Network delivery additionally requires an already resolved Runtime. */
export const validateDeliverableEntityInput = (
  output: unknown,
): DeliverableEntityInput => {
  const input = decodeRoutedEntityOutput(output);
  if (typeof input.runtimeId !== 'string' || input.runtimeId.trim().length === 0) {
    throw new Error(
      'FINANCIAL-SAFETY: Deliverable EntityOutput missing runtimeId',
    );
  }
  return input as DeliverableEntityInput;
};
