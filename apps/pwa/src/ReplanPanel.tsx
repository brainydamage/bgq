// Пересчёт маршрута: выбор «пауза впереди», «было → стало», «Принять» (событие plan_accepted).
import type { AcceptedPlan, Pauses, PhoneGame, Plan } from '@bgq/core';
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  acceptedPlan,
  PAUSE_CHOICES,
  pauseChoices,
  pauseLeftMin,
  type ReplanSide,
  type ReplanView,
  replanSetup,
  runReplan,
  verdictText,
} from './replan.ts';
import type { RouteRows } from './route.ts';

const PAUSE_CHOICES_SET = new Set(PAUSE_CHOICES);

/** «Было» / «Стало»: финиш (красным — позже дедлайна) и баллы; сколько КП — мелко. */
function SideText(props: { title: string; side: ReplanSide }) {
  const s = props.side;
  return (
    <div class="replan-side">
      <strong>{props.title}</strong>
      <span class={s.slackMin < 0 ? 'warn' : ''}>финиш {s.finish}</span>
      <span>{s.points} б</span>
      <span class="muted small">{s.kps} КП</span>
    </div>
  );
}

export function ReplanPanel(props: {
  game: PhoneGame;
  rows: RouteRows;
  now: Date;
  pauses: Pauses;
  accepted: AcceptedPlan | undefined;
  onAccept: (plan: Plan, pauseMin: number) => void;
  onClose: () => void;
}) {
  const left = useMemo(
    () => pauseLeftMin(props.game, props.pauses, props.now, props.accepted),
    // Остаток резерва — на момент открытия панели.
    [],
  );
  const [pauseMin, setPauseMin] = useState(left);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [found, setFound] = useState<{
    view: ReplanView;
    accept: () => Plan;
    from: string;
  } | null>(null);

  // Считаем при открытии и при смене паузы; setTimeout — чтобы «Считаю…» успело нарисоваться.
  useEffect(() => {
    setBusy(true);
    setFound(null);
    const timer = setTimeout(() => {
      const now = new Date();
      const setup = replanSetup(props.game, props.rows, now, props.pauses, pauseMin);
      if (typeof setup === 'string') {
        setError(setup);
        setBusy(false);
        return;
      }
      try {
        const t0 = props.game.plan?.t0 ?? '';
        const { result, view } = runReplan(setup, t0);
        setFound({
          view,
          from: setup.fromLabel,
          accept: () => acceptedPlan(props.game, setup, result, new Date(), pauseMin),
        });
        setError('');
      } catch (e) {
        setError(`Не посчиталось: ${(e as Error).message}`);
      }
      setBusy(false);
    }, 30);
    return () => clearTimeout(timer);
  }, [pauseMin]);

  const v = found?.view;
  const same =
    v &&
    !v.added.length &&
    !v.removed.length &&
    v.after.points === v.before.points &&
    v.after.finish === v.before.finish;
  return (
    <section class="replan" aria-live="polite">
      <div class="replan-head">
        <strong>⟳ Пересчёт маршрута</strong>
        <button type="button" class="link" onClick={props.onClose}>
          Закрыть
        </button>
      </div>
      <p class="muted small">Пауза впереди (резерв до дедлайна):</p>
      <div class="filter chips">
        {pauseChoices(left).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={m === pauseMin}
            disabled={busy}
            onClick={() => setPauseMin(m)}
          >
            {m}
            {m === left && left > 0 && !PAUSE_CHOICES_SET.has(m) ? '*' : ''}
          </button>
        ))}
      </div>
      <p class="muted small">
        {left > 0 && !PAUSE_CHOICES_SET.has(left) ? '* осталось от резерва. ' : ''}
        Время, не нужное на паузу, пойдёт на точки; больше паузы — меньше точек.
      </p>
      {busy && <p>Считаю…</p>}
      {error && <p class="warn">{error}</p>}
      {v && found && (
        <>
          <p class="muted small">{found.from}</p>
          <div class="replan-cmp">
            <SideText title="Было" side={v.before} />
            <SideText title="Стало" side={v.after} />
          </div>
          {same ? (
            <p class="muted small">Лучше не нашлось — порядок прежний.</p>
          ) : (
            verdictText(v, pauseMin) && <p class="replan-verdict">{verdictText(v, pauseMin)}</p>
          )}
          {v.next.length > 0 && <p class="small">дальше: {v.next.join(' → ')} …</p>}
          <div class="replan-actions">
            <button
              type="button"
              class="primary"
              onClick={() => props.onAccept(found.accept(), pauseMin)}
            >
              Принять
            </button>
            <button type="button" onClick={props.onClose}>
              Отмена
            </button>
          </div>
          <p class="muted small">«Принять» — новый план на оба телефона.</p>
        </>
      )}
    </section>
  );
}
