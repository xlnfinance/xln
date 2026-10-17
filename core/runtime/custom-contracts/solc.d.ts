declare module 'solc' {
  const solc: {
    version(): string;
    compile(input: string, callbacks?: { import(path: string): { contents: string } | { error: string } }): string;
  };
  export default solc;
}
