// Сборка Lambda: src/lambda.ts → infra/build/handler.mjs (один файл, AWS SDK — из среды Lambda).
// Запуск: corepack pnpm --filter @bgq/sync build (перед terraform apply).
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, '../../infra/build');

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  ssr: { noExternal: true, external: ['@aws-sdk/client-dynamodb'], target: 'node' },
  build: {
    ssr: resolve(root, 'src/lambda.ts'),
    outDir,
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'handler.mjs' } },
  },
});
console.log(`lambda: ${resolve(outDir, 'handler.mjs')}`);
