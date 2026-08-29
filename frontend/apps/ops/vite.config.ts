import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { createReactAppConfig } from '../../config/create-react-app-config';

export default defineConfig(createReactAppConfig({
  surfaceId: 'ops',
  rootDirectory: fileURLToPath(new URL('.', import.meta.url)),
}));
