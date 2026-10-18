// Экран «Штурман»: следующие точки плана, «вести» в Organic Maps, «пропустить».
import type { Loc } from '@bgq/core';
import { geoUri, type KpRow, kpLabel, nextStops } from './route.ts';
import { go } from './router.ts';

export function NavView(props: {
  plan: KpRow[];
  hasPlan: boolean;
  finish: Loc | undefined;
  onSkip: (kpId: string) => void;
  onReopen: (kpId: string) => void;
}) {
  if (!props.hasPlan)
    return (
      <p class="note-msg">
        Плана нет. На ноутбуке: <code>./bgq route</code>, затем <code>./bgq pwa</code> и «Обновить
        игру».
      </p>
    );
  const next = nextStops(props.plan);
  const skipped = props.plan.filter((r) => r.status === 'skipped');
  return (
    <>
      <ol class="next">
        {next.map((r, i) => (
          <li key={r.kp.id} class={i === 0 ? 'stop first' : 'stop'}>
            <button type="button" class="stop-head" onClick={() => go({ name: 'kp', id: r.kp.id })}>
              <span class="line">
                <span class="id">{r.kp.id}</span>
                <span class="pts">{r.kp.points} б</span>
                {r.kp.kind === 'riddle' && <span>🧩</span>}
                <span class="spacer" />
                <span class="muted">{r.stop?.arrive}</span>
              </span>
              {r.kp.window && (
                <span class="flag small">
                  ⏰ работает {r.kp.window.from}–{r.kp.window.to}
                </span>
              )}
              <span class="title-line">{r.kp.title}</span>
              {r.kp.address && !r.kp.title.includes(r.kp.address.raw) && (
                <span class="muted small">{r.kp.address.raw}</span>
              )}
            </button>
            <div class="actions">
              {r.kp.loc && (
                <a class="lead primary" href={geoUri(r.kp.loc, kpLabel(r.kp))}>
                  🧭 Вести
                </a>
              )}
              <button type="button" onClick={() => props.onSkip(r.kp.id)}>
                ⏭ Пропустить
              </button>
            </div>
          </li>
        ))}
        {next.length < 4 && (
          <li class="stop finish">
            <span class="line">
              <span class="id">🏁 Финиш</span>
            </span>
            {props.finish && (
              <div class="actions">
                <a class="lead primary" href={geoUri(props.finish, 'Финиш')}>
                  🧭 Вести
                </a>
              </div>
            )}
          </li>
        )}
      </ol>
      {skipped.length > 0 && (
        <>
          <h2 class="section">Пропущены · {skipped.length}</h2>
          <ul class="skipped">
            {skipped.map((r) => (
              <li key={r.kp.id}>
                <span>
                  {r.kp.id} · {r.kp.points} б
                </span>
                <button type="button" onClick={() => props.onReopen(r.kp.id)}>
                  Вернуть
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
