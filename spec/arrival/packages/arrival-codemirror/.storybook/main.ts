import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  typescript: {
    check: false,
    reactDocgen: false,
  },
  async viteFinal(config) {
    config.resolve ??= {};
    config.resolve.alias = [
      ...(Array.isArray(config.resolve.alias) ? config.resolve.alias : []),
      { find: "@here.build/arrival-codemirror/react", replacement: `${src}react/index.ts` },
      { find: "@here.build/arrival-codemirror", replacement: `${src}index.ts` },
    ];
    // Same type-lens ?raw glob shims as demos/vite.config.mjs.
    config.plugins = [
      ...(config.plugins ?? []),
      {
        name: "type-lens-glob-shim",
        enforce: "pre" as const,
        transform(code: string, id: string) {
          if (!id.includes("arrival-lsp") || !code.includes('query: "?raw"')) return null;
          return code
            .replaceAll('import.meta.glob("typescript/lib/', 'import.meta.glob("../node_modules/typescript/lib/')
            .replaceAll('{ eager: true, query: "?raw" }', '{ eager: true, query: "?raw", import: "default" }');
        },
      },
    ];
    return config;
  },
};

export default config;
