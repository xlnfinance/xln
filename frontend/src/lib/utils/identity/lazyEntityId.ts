import { generateLazyEntityId } from '@xln/core/entity/factory';

type LazyValidator = string | { name: string; weight: number };

export const generateLazyEntityIdPreview = (validators: LazyValidator[], threshold: bigint): string =>
  generateLazyEntityId(validators, threshold);
