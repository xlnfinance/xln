declare module 'qrcode' {
  export function toDataURL(text: string, options?: unknown): Promise<string>;
  export function toString(text: string, options?: unknown): Promise<string>;
  const QRCode: {
    toDataURL: typeof toDataURL;
    toString: typeof toString;
  };
  export default QRCode;
}
