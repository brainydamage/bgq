// Сервер синхронизации на ноутбуке — проверка двух вкладок/телефонов без AWS. Тот же обработчик,
// события в памяти (до Ctrl+C). Запуск: node packages/sync/scripts/local.ts [--port 8787] [--code …]
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { createHandler, memoryStore } from '../src/index.ts';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '8787' }, code: { type: 'string' } },
});
// --code — тот же код после перезапуска (phone.json менять не надо).
const code = values.code ?? randomBytes(16).toString('hex');
const sync = createHandler({ store: memoryStore(), code });

createServer(async (req, res) => {
  // CORS — как у Function URL в infra/main.tf.
  res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-bgq-code');
  res.setHeader('access-control-allow-methods', 'POST');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const out = await sync({
    requestContext: { http: { method: req.method ?? 'GET' } },
    headers: { 'x-bgq-code': req.headers['x-bgq-code'] as string | undefined },
    body: Buffer.concat(chunks).toString('utf8'),
  });
  res.writeHead(out.statusCode, out.headers).end(out.body);
}).listen(Number(values.port), 'localhost', () => {
  const url = `http://localhost:${values.port}/`;
  console.log(`sync: ${url} · Ctrl+C — выход`);
  console.log(`games/sync.json (только для ./bgq pwa dev|preview на этом ноутбуке):`);
  console.log(JSON.stringify({ url, code }));
});
