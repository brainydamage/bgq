// Регистрация service worker и «есть новая версия». В dev (vite) не регистрируется.

const supported = () => 'serviceWorker' in navigator && import.meta.env.PROD;

let registration: Promise<ServiceWorkerRegistration | null> = Promise.resolve(null);

export function registerServiceWorker() {
  if (!supported()) return;
  registration = navigator.serviceWorker.register('./sw.js').catch(() => null);
  // Первая установка тоже меняет controller (clients.claim) — перезагружать незачем.
  let hadController = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  // Вернулись в приложение — проверить обновление (если есть сеть).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible')
      void registration.then((r) => r?.update().catch(() => {}));
  });
}

/** Оболочка в кэше: приложение откроется без сети. */
export async function offlineReady(): Promise<boolean> {
  if (!supported()) return false;
  const r = await registration;
  if (!r) return false;
  await navigator.serviceWorker.ready;
  return true;
}

/** Новая версия скачана и ждёт: apply() переключает на неё и перезагружает страницу. */
export function onUpdate(cb: (apply: () => void) => void) {
  void registration.then((r) => {
    if (!r) return;
    const notify = (w: ServiceWorker) => cb(() => w.postMessage('skipWaiting'));
    if (r.waiting && navigator.serviceWorker.controller) notify(r.waiting);
    r.addEventListener('updatefound', () => {
      const w = r.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) notify(w);
      });
    });
  });
}
