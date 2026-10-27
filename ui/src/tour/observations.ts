import { create } from 'zustand';
import type { TourContext } from './steps';

/** Volatile observations of actual backup reads/exports, never a persisted completion flag. */
export const useTourObservations = create<Pick<TourContext, 'backup' | 'exported' | 'restored' | 'shareTokens' | 'governance'>>(() => ({}));
