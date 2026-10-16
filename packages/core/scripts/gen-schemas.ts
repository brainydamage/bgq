// Генерирует schemas/*.schema.json из TypeBox-схем core. Запуск: pnpm schemas
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSchemas } from '../src/schemas.ts';

const dir = join(import.meta.dirname, '../../../schemas');
mkdirSync(dir, { recursive: true });

const files = renderSchemas();
for (const old of readdirSync(dir)) {
  if (old.endsWith('.schema.json') && !(old in files)) rmSync(join(dir, old));
}
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(dir, name), text);
}
console.log(`schemas: ${Object.keys(files).length} файлов → ${dir}`);
