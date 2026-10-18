// Карточка КП (секретарь): текст задания, ответ (сохраняется при вводе), «взято» со временем.
import { useAutosave } from './autosave.ts';
import { geoUri, type KpRow, kpLabel } from './route.ts';
import { TimeField } from './TasksView.tsx';

const KIND: Record<string, string> = {
  riddle: '🧩 загадка',
  task: 'задание',
  photo: '📷 фото',
};
const ANSWER: Record<string, string> = {
  photo: '📷 ответ — фото',
  drawing: '✏️ ответ — рисунок',
  judge: '⚖️ судья',
  video: '🎬 видео',
};

export function KpCard(props: {
  row: KpRow;
  onTaken: () => void;
  onReopen: () => void;
  onSkip: () => void;
  onAnswer: (answer: string) => void;
  onTime: (hhmm: string) => void;
}) {
  const { row: r } = props;
  const { kp } = r;
  const answer = useAutosave(r.answer, props.onAnswer);

  return (
    <article class={`card ${r.status}`}>
      <div class="card-head">
        <span class="big">{kp.id}</span>
        <span class="pts">{kp.points} б</span>
        {KIND[kp.kind] && <span class="muted">{KIND[kp.kind]}</span>}
        {ANSWER[kp.answerKind] && <span class="muted">{ANSWER[kp.answerKind]}</span>}
      </div>
      <p class="muted plan-line">
        {r.stop
          ? `${r.stop.n}-й по плану · приход ${r.stop.arrive}, уход ${r.stop.depart}`
          : 'не в плане'}
        {kp.window && (
          <span class="flag">
            {' '}
            · ⏰ работает {kp.window.from}–{kp.window.to}
          </span>
        )}
      </p>

      <h2 class="kp-title">{kp.title}</h2>
      {kp.address && !kp.title.includes(kp.address.raw) && <p class="muted">{kp.address.raw}</p>}
      {kp.description.map((line, i) => (
        <p key={i} class="text">
          {line}
        </p>
      ))}
      {kp.extraPhoto && <p class="text flag">+ {kp.extraPhoto}</p>}
      {kp.struck.length > 0 && (
        <details class="struck">
          <summary class="muted small">Зачёркнуто ({kp.struck.length})</summary>
          {kp.struck.map((line, i) => (
            <p key={i} class="text">
              <del>{line}</del>
            </p>
          ))}
        </details>
      )}
      {kp.links.map((l) => (
        <p key={l.url} class="small">
          <a href={l.url} target="_blank" rel="noreferrer">
            {l.kind === 'video' ? '🎬 видео' : l.kind === 'maps' ? '🗺 карта' : '🔗 ссылка'}
          </a>
        </p>
      ))}

      <label class="field">
        Ответ
        <textarea
          rows={3}
          value={answer.draft}
          placeholder="ответ в книжку"
          onInput={(e) => answer.onInput(e.currentTarget.value)}
          onBlur={answer.flush}
        />
      </label>

      {r.status === 'open' && (
        <div class="actions">
          <button type="button" class="primary" onClick={props.onTaken}>
            ✓ Взято
          </button>
          <button type="button" onClick={props.onSkip}>
            ⏭ Пропустить
          </button>
        </div>
      )}
      {r.status === 'taken' && (
        <>
          <p class="time">✓ взято{r.answerTime ? ` в ${r.answerTime}` : ' — впишите время'}</p>
          <TimeField label="Время в книжку" value={r.answerTime} onTime={props.onTime} />
          <div class="actions">
            <button type="button" onClick={props.onReopen}>
              Отменить «взято»
            </button>
          </div>
        </>
      )}
      {r.status === 'skipped' && (
        <div class="actions">
          <span class="muted">⏭ пропущен</span>
          <button type="button" onClick={props.onReopen}>
            Вернуть
          </button>
        </div>
      )}
      {kp.loc && (
        <a class="lead" href={geoUri(kp.loc, kpLabel(kp))}>
          🧭 Вести (Organic Maps)
        </a>
      )}
    </article>
  );
}
