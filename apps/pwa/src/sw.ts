// Service worker: оболочка приложения из кэша — без сети работает всё (данные — в IndexedDB).
// Собирается плагином в vite.config.ts: подставляет версию и список файлов сборки.

declare const __BGQ_VERSION__: string;
declare const __BGQ_PRECACHE__: string[];

// В tsconfig — DOM, не WebWorker: нужные типы описаны здесь.
interface SwExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface SwFetchEvent extends SwExtendableEvent {
  request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface SwScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', l: (e: SwExtendableEvent) => void): void;
  addEventListener(type: 'fetch', l: (e: SwFetchEvent) => void): void;
  addEventListener(type: 'message', l: (e: MessageEvent) => void): void;
}

const sw = self as unknown as SwScope;
const CACHE = `bgq-${__BGQ_VERSION__}`;

sw.addEventListener('install', (e) => {
  // Новая версия ждёт кнопки «Обновить» (skipWaiting) — не подменяет страницу посреди ввода.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(__BGQ_PRECACHE__)));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('bgq-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') void sw.skipWaiting();
});

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== sw.location.origin) return;
  // Страница (в т.ч. с ?load=…) — всегда index.html из кэша; остальное — кэш, затем сеть.
  const key = req.mode === 'navigate' ? new URL('index.html', sw.location.href).href : req;
  // ignoreVary: скрипты со crossorigin идут с Origin, а в кэш их клали без него.
  e.respondWith(
    caches.match(key, { cacheName: CACHE, ignoreVary: true }).then((hit) => hit ?? fetch(req)),
  );
});

export {};
