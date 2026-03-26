import type { UIStyleSettings, UITabStyle } from '$lib/types/ui';

export interface UIStyleOptionGroup {
  key: keyof UIStyleSettings;
  label: string;
  description: string;
  options: Array<{ value: UIStyleSettings[keyof UIStyleSettings]; label: string }>;
}

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

export const UI_STYLE_OPTIONS: UIStyleOptionGroup[] = [
  {
    key: 'density',
    label: 'Density',
    description: 'Overall spacing and control height.',
    options: [
      { value: 'compact', label: 'Compact' },
      { value: 'comfortable', label: 'Comfortable' },
      { value: 'roomy', label: 'Roomy' },
    ],
  },
  {
    key: 'radius',
    label: 'Radius',
    description: 'How sharp or rounded controls should feel.',
    options: [
      { value: 'sharp', label: 'Sharp' },
      { value: 'soft', label: 'Soft' },
      { value: 'pill', label: 'Pill' },
    ],
  },
  {
    key: 'borders',
    label: 'Borders',
    description: 'Visible framing around cards and controls.',
    options: [
      { value: 'minimal', label: 'Minimal' },
      { value: 'subtle', label: 'Subtle' },
      { value: 'strong', label: 'Strong' },
    ],
  },
  {
    key: 'shadows',
    label: 'Shadows',
    description: 'Surface lift and depth.',
    options: [
      { value: 'flat', label: 'Flat' },
      { value: 'soft', label: 'Soft' },
      { value: 'float', label: 'Float' },
    ],
  },
  {
    key: 'tabs',
    label: 'Tabs',
    description: 'Tab rail treatment.',
    options: TAB_STYLE_OPTIONS.map(({ value, label }) => ({ value, label })),
  },
  {
    key: 'buttons',
    label: 'Buttons',
    description: 'Primary and secondary action style.',
    options: [
      { value: 'minimal', label: 'Minimal' },
      { value: 'soft', label: 'Soft' },
      { value: 'solid', label: 'Solid' },
    ],
  },
  {
    key: 'cards',
    label: 'Cards',
    description: 'Surface density and striping.',
    options: [
      { value: 'flat', label: 'Flat' },
      { value: 'filled', label: 'Filled' },
      { value: 'striped', label: 'Striped' },
    ],
  },
  {
    key: 'inputs',
    label: 'Inputs',
    description: 'Field framing style.',
    options: [
      { value: 'minimal', label: 'Minimal' },
      { value: 'outlined', label: 'Outlined' },
      { value: 'filled', label: 'Filled' },
    ],
  },
  {
    key: 'accent',
    label: 'Accent',
    description: 'How strongly accent color appears.',
    options: [
      { value: 'quiet', label: 'Quiet' },
      { value: 'normal', label: 'Normal' },
      { value: 'bold', label: 'Bold' },
    ],
  },
  {
    key: 'typography',
    label: 'Type Scale',
    description: 'Global text density.',
    options: [
      { value: 'sm', label: 'Small' },
      { value: 'md', label: 'Normal' },
      { value: 'lg', label: 'Large' },
    ],
  },
] as const;
