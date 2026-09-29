/**
 * SDK-free content-block union. Mirrors the shape of MCP's `CallToolResult["content"]`
 * structurally, without importing `@modelcontextprotocol/sdk` — the runner must never
 * depend on the SDK (a wrapper widens this to the real SDK type at its own boundary).
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface AudioBlock {
  type: "audio";
  data: string;
  mimeType: string;
}

export interface ResourceBlock {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export type ContentBlock = TextBlock | ImageBlock | AudioBlock | ResourceBlock;

export function isBinaryBlock(block: ContentBlock): block is ImageBlock | AudioBlock {
  return block.type === "image" || block.type === "audio";
}
