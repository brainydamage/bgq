// Сборка PWA: `corepack pnpm --filter @bgq/pwa build` (CI → GitHub Pages) и ./bgq pwa build|preview.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin, transformWithOxc } from 'vite';

const APP_DIR = import.meta.dirname;

/** Все файлы каталога (пути через «/» относительно него). */
function walk(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? walk(join(dir, d.name), root)
      : [relative(root, join(dir, d.name)).split('\\').join('/')],
  );
}

/**
 * sw.js из src/sw.ts после сборки: список файлов для кэша и версия — хэш их содержимого
 * (новая сборка → новый sw.js → телефон видит обновление).
 */
function serviceWorker(): Plugin {
  let outDir = '';
  return {
    name: 'bgq-sw',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    async closeBundle() {
      const files = walk(outDir)
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map'))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const src = readFileSync(join(APP_DIR, 'src/sw.ts'), 'utf8');
      const { code } = await transformWithOxc(src, 'sw.ts');
      const out = code
        .replace(/^export\s*\{\s*\};?\s*$/m, '')
        .replaceAll('__BGQ_VERSION__', JSON.stringify(version))
        .replaceAll('__BGQ_PRECACHE__', JSON.stringify(['./', ...files]));
      writeFileSync(join(outDir, 'sw.js'), out);
      console.log(`sw.js: версия ${version}, в кэше ${files.length + 1} файлов`);
    },
  };
}

export default defineConfig({
  root: APP_DIR,
  // Относительные пути: работает и в корне (localhost), и в подпапке GitHub Pages (/bgq/).
  base: './',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  // Время сборки — в подвале: видно, какая версия стоит на телефоне.
  define: { __BGQ_BUILD__: JSON.stringify(new Date().toISOString()) },
  plugins: [serviceWorker()],
  build: { outDir: 'dist', emptyOutDir: true },
});
