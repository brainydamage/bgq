// Точка входа Lambda (собирается scripts/build.ts в infra/build/handler.mjs).
import { dynamoStore } from './dynamo.ts';
import { createHandler, type UrlRequest } from './handler.ts';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`нет переменной окружения ${name}`);
  return v;
}

const sync = createHandler({ store: dynamoStore(env('TABLE')), code: env('SYNC_CODE') });

export async function handler(req: UrlRequest) {
  try {
    return await sync(req);
  } catch (e) {
    // Ошибка хранилища: телефон повторит запрос (запись идемпотентна).
    console.error(e);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'ошибка сервера — повторите' }),
    };
  }
}
