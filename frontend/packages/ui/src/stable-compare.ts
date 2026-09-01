export const compareStableText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
