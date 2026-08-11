import type { UITabStyle } from '$lib/types/ui';

export interface UITabStyleOption {
  value: UITabStyle;
  label: string;
  description: string;
}

export const TAB_STYLE_OPTIONS: UITabStyleOption[] = [
  { value: 'minimal', label: 'Minimal', description: 'Quiet text rail with almost no chrome.' },
  { value: 'underline', label: 'Underline', description: 'Classic active underline with crisp separation.' },
  { value: 'rail', label: 'Rail', description: 'Soft fintech rail with one lifted active tab.' },
  { value: 'pill', label: 'Pill', description: 'Rounded chip tabs with calmer emphasis.' },
  { value: 'segmented', label: 'Segmented', description: 'Shared segmented control for compact filters.' },
  { value: 'floating', label: 'Floating', description: 'Independent soft tabs with subtle lift.' },
] as const;
