import { type Event, projectState, SYNC_BATCH, type SyncResponse } from '@bgq/core';
import { createHandler, memoryStore } from '@bgq/sync';
import { describe, expect, it } from 'vitest';
import { type Body, makeEvent } from '../src/events.ts';
import {
  backoffMs,
  createSyncer,
  mergeEvents,
  PERIOD_MS,
  parseResponse,
  type Send,
  SyncError,
  type SyncStatus,
  type SyncStore,
  syncOnce,
  syncText,
  type Timer,
} from '../src/sync.ts';

const GAME = '2026-10-10';
const CODE = 'team-code-0123456789';
const TZ = 'Europe/Belgrade';

/** Сервер — настоящий обработчик Lambda с хранилищем в памяти. */
function server(start = '2026-10-10T10:00:00.000Z') {
  let t = Date.parse(start);
  const store = memoryStore();
  const handler = createHandler({ store, code: CODE, now: () => new Date(t) });
  const send: Send = async (req) => {
    const res = await handler({
      requestContext: { http: { method: 'POST' } },
      headers: { 'x-bgq-code': CODE },
      body: JSON.stringify(req),
    });
    if (res.statusCode !== 200) throw new SyncError(res.body, res.statusCode);
    return parseResponse(JSON.parse(res.body));
  };
  return { store, send, tick: (ms: number) => (t += ms) };
}

/** Телефон: события, очередь и курсор в памяти — как в IndexedDB (db.ts). */
function phone(deviceId: string) {
  const events = new Map<string, Event>();
  const outbox = new Set<string>();
  const cursors = new Map<string, string>();
  let seq = 0;
  const store: SyncStore = {
    async pending(gameId, limit, skip) {
      return [...outbox]
        .filter((id) => !skip.has(id))
        .map((id) => events.get(id) as Event)
        .filter((e) => e.gameId === gameId)
        .slice(0, limit);
    },
    async pendingCount() {
      return outbox.size;
    },
    async markSent(ids) {
      for (const id of ids) outbox.delete(id);
    },
    async saveRemote(list) {
      for (const e of list) events.set(e.id, e);
    },
    async getCursor(gameId) {
      return cursors.get(gameId) ?? '';
    },
    async setCursor(gameId, c) {
      cursors.set(gameId, c);
    },
  };
  /** Отметка в «ЧЧ:ММ» по часам телефона (+02:00). */
  const add = (kpId: string, body: Body, at: string) => {
    const e = makeEvent(
      GAME,
      kpId,
      body,
      { deviceId, seq: seq++ },
      new Date(`${GAME}T${at}:00+02:00`),
    );
    events.set(e.id, e);
    outbox.add(e.id);
    return e;
  };
  const state = (kpId: string) => projectState([...events.values()], GAME).get(kpId);
  return { store, add, events, outbox, cursors, state };
}

describe('syncOnce: два телефона через сервер', () => {
  it('отметки секретаря видны штурману и наоборот, очереди пустеют', async () => {
    const srv = server();
    const ul = phone('iphone');
    const ira = phone('android');
    ul.add('64', { type: 'taken', answerTime: '12:41' }, '12:41');
    ira.add('71', { type: 'skipped' }, '12:43');

    expect((await syncOnce(GAME, ul.store, srv.send)).sent).toBe(1);
    const r = await syncOnce(GAME, ira.store, srv.send);
    expect(r.sent).toBe(1);
    expect(r.received.map((e) => e.kpId).sort()).toEqual(['64', '71']);
    await syncOnce(GAME, ul.store, srv.send);

    for (const p of [ul, ira]) {
      expect(p.outbox.size).toBe(0);
      expect(p.state('64')).toMatchObject({ status: 'taken', answerTime: '12:41' });
      expect(p.state('71')).toMatchObject({ status: 'skipped' });
    }
  });

  it('ответ потерялся (тайм-аут) — повтор не дублирует ни на сервере, ни на телефоне', async () => {
    const srv = server();
    const ul = phone('iphone');
    const e = ul.add('64', { type: 'taken', answerTime: '12:41' }, '12:41');
    const lost: Send = async (req) => {
      await srv.send(req);
      throw new SyncError('тайм-аут', 0);
    };
    await expect(syncOnce(GAME, ul.store, lost)).rejects.toThrow('тайм-аут');
    expect(ul.outbox.has(e.id)).toBe(true);

    await syncOnce(GAME, ul.store, srv.send);
    expect(ul.outbox.size).toBe(0);
    expect(srv.store.games.get(GAME)?.size).toBe(1);
    expect(ul.events.size).toBe(1);
  });

  it('порядок — по clientTs, а не по приходу: поздняя отмена с другого телефона побеждает', async () => {
    const srv = server();
    const ul = phone('iphone');
    const ira = phone('android');
    // Ира отменила «взято» в 12:50, но была без сети и отправила позже.
    ul.add('64', { type: 'taken', answerTime: '12:41' }, '12:41');
    const reopen = ira.add('64', { type: 'reopened' }, '12:50');
    await syncOnce(GAME, ul.store, srv.send);
    srv.tick(10 * 60_000);
    await syncOnce(GAME, ira.store, srv.send);
    await syncOnce(GAME, ul.store, srv.send);
    expect(ul.events.has(reopen.id)).toBe(true);
    expect(ul.state('64')?.status).toBe('open');
    expect(ira.state('64')?.status).toBe('open');
  });

  it('больше SYNC_BATCH в очереди — несколько пачек за один заход', async () => {
    const srv = server();
    const ul = phone('iphone');
    for (let i = 0; i < SYNC_BATCH * 2 + 5; i++)
      ul.add('64', { type: 'answer_changed', answer: `v${i}` }, '12:41');
    const r = await syncOnce(GAME, ul.store, srv.send);
    expect(r.sent).toBe(SYNC_BATCH * 2 + 5);
    expect(ul.outbox.size).toBe(0);
  });

  it('событие, которого сервер не знает, остаётся в очереди и не задерживает остальные', async () => {
    const ul = phone('iphone');
    const ok = ul.add('64', { type: 'taken', answerTime: '12:41' }, '12:41');
    const odd = ul.add('65', { type: 'skipped' }, '12:42');
    // Сервер старее телефона: тип skipped ему незнаком.
    const send: Send = async (req) => ({
      v: 1,
      accepted: req.events.filter((e) => e.id !== odd.id).map((e) => e.id),
      rejected: req.events.filter((e) => e.id === odd.id).map((e) => ({ id: e.id, error: '?' })),
      events: [],
      cursor: '',
      more: false,
      serverTime: '2026-10-10T10:00:00.000Z',
    });
    const r = await syncOnce(GAME, ul.store, send);
    expect(r.rejected).toEqual([odd.id]);
    expect([...ul.outbox]).toEqual([odd.id]);
    expect(ul.outbox.has(ok.id)).toBe(false);
  });

  it('курсор сохраняется: следующий заход не начинает с начала', async () => {
    const srv = server();
    const ul = phone('iphone');
    ul.add('64', { type: 'taken', answerTime: '12:41' }, '12:41');
    await syncOnce(GAME, ul.store, srv.send);
    expect(ul.cursors.get(GAME)).toMatch(/^2026-10-10T10:00:00\.000Z#/);
  });
});

describe('parseResponse', () => {
  const res: SyncResponse = {
    v: 1,
    accepted: [],
    rejected: [],
    events: [],
    cursor: '',
    more: false,
    serverTime: '2026-10-10T10:00:00.000Z',
  };

  it('незнакомое событие (сервер новее оболочки) пропускается, остальные — нет', () => {
    const e = makeEvent(GAME, '64', { type: 'reopened' }, { deviceId: 'd', seq: 0 });
    const parsed = parseResponse({ ...res, events: [{ ...e, type: 'photo_added' }, e] });
    expect(parsed.events).toEqual([e]);
  });

  it('конверт не по схеме — ошибка', () => {
    expect(() => parseResponse({ ...res, cursor: 5 })).toThrow(SyncError);
    expect(() => parseResponse(null)).toThrow(SyncError);
  });
});

describe('mergeEvents', () => {
  const a = makeEvent(GAME, '64', { type: 'reopened' }, { deviceId: 'd', seq: 0 });
  const b = makeEvent(GAME, '65', { type: 'reopened' }, { deviceId: 'd', seq: 1 });

  it('дубли по id отбрасываются', () => {
    expect(mergeEvents([a], [a, b, b])).toEqual([a, b]);
  });

  it('ничего нового — тот же массив (без перерисовки)', () => {
    const prev = [a, b];
    expect(mergeEvents(prev, [b, a])).toBe(prev);
  });
});

describe('backoffMs', () => {
  it('2, 4, 8 … до 60 с; разброс 50–100%', () => {
    expect(backoffMs(1, () => 1)).toBe(2000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(20, () => 1)).toBe(60_000);
    expect(backoffMs(1, () => 0)).toBe(1000);
  });
});

/** Таймер, которым управляет тест. */
function fakeTimer() {
  const jobs = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timer: Timer = {
    set: (fn, ms) => {
      jobs.set(next, { fn, ms });
      return next++;
    },
    clear: (h) => {
      jobs.delete(h as number);
    },
  };
  const fire = () => {
    const [id, job] = [...jobs.entries()][0] ?? [];
    if (!job) throw new Error('нет таймера');
    jobs.delete(id as number);
    job.fn();
  };
  return { timer, jobs, fire, delays: () => [...jobs.values()].map((j) => j.ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createSyncer', () => {
  function setup(send: Send) {
    const ul = phone('iphone');
    const t = fakeTimer();
    const statuses: SyncStatus[] = [];
    const got: Event[][] = [];
    const s = createSyncer({
      gameId: GAME,
      store: ul.store,
      send,
      onStatus: (x) => statuses.push(x),
      onEvents: (e) => got.push(e),
      timer: t.timer,
      random: () => 1,
      now: () => Date.parse('2026-10-10T10:00:00.000Z'),
    });
    return { ul, t, statuses, got, s, last: () => statuses.at(-1) };
  }

  it('успех: очередь пуста, «синхронизировано», следующий заход через PERIOD_MS', async () => {
    const srv = server();
    const { ul, t, s, last, got } = setup(srv.send);
    ul.add('64', { type: 'taken', answerTime: '12:41' }, '12:41');
    s.kick();
    await flush();
    expect(last()).toMatchObject({ state: 'idle', pending: 0, rejected: 0, skewMs: 0 });
    expect(got.flat().map((e) => e.kpId)).toEqual(['64']);
    expect(t.delays()).toEqual([PERIOD_MS]);
  });

  it('нет связи: «нет связи · в очереди», повтор с растущей паузой; связь вернулась — очередь ушла', async () => {
    const srv = server();
    let online = false;
    const { ul, t, s, last } = setup(async (req) => {
      if (!online) throw new SyncError('нет связи', 0);
      return srv.send(req);
    });
    ul.add('64', { type: 'taken', answerTime: '12:41' }, '12:41');
    s.kick();
    await flush();
    expect(last()).toMatchObject({ state: 'offline', pending: 1 });
    expect(t.delays()).toEqual([2000]);
    t.fire();
    await flush();
    expect(t.delays()).toEqual([4000]);
    online = true;
    t.fire();
    await flush();
    expect(last()).toMatchObject({ state: 'idle', pending: 0 });
    expect(t.delays()).toEqual([PERIOD_MS]);
  });

  it('401 — «сервер не принял код»', async () => {
    const { s, last } = setup(async () => {
      throw new SyncError('401 неверный код', 401);
    });
    s.kick();
    await flush();
    expect(last()?.state).toBe('denied');
  });

  it('kick во время захода — ещё один заход сразу после; после stop — тишина', async () => {
    const srv = server();
    let calls = 0;
    const { ul, t, s, statuses } = setup(async (req) => {
      calls++;
      return srv.send(req);
    });
    ul.add('64', { type: 'taken', answerTime: '12:41' }, '12:41');
    s.kick();
    s.kick();
    await flush();
    await flush();
    expect(calls).toBe(2);
    s.stop();
    const n = statuses.length;
    expect(t.jobs.size).toBe(0);
    s.kick();
    await flush();
    expect(statuses.length).toBe(n);
  });

  it('расхождение часов: serverTime против середины запроса', async () => {
    const srv = server();
    const { s, last } = setup(async (req) => ({
      ...(await srv.send(req)),
      serverTime: '2026-10-10T10:05:00.000Z',
    }));
    s.kick();
    await flush();
    expect(last()?.skewMs).toBe(5 * 60_000);
  });
});

describe('syncText', () => {
  const lastOk = new Date('2026-10-10T10:41:00.000Z');
  it.each<[string, SyncStatus | null, string]>([
    ['нет адреса', null, '△ без синхронизации — в phone.json нет адреса (games/sync.json)'],
    ['всё ушло', { state: 'idle', pending: 0, rejected: 0, lastOk }, '✓ синхронизировано 12:41'],
    ['в очереди', { state: 'syncing', pending: 3, rejected: 0, lastOk }, '⟳ в очереди 3'],
    [
      'нет связи',
      { state: 'offline', pending: 3, rejected: 0, lastOk },
      '△ нет связи · в очереди 3 · было в 12:41',
    ],
    [
      'код',
      { state: 'denied', pending: 1, rejected: 0 },
      '✗ сервер не принял код — обновите phone.json · в очереди 1',
    ],
    [
      'часы спешат',
      { state: 'idle', pending: 0, rejected: 0, lastOk, skewMs: -5 * 60_000 },
      '✓ синхронизировано 12:41 · △ часы телефона спешат на 5 мин',
    ],
    [
      'не принято',
      { state: 'idle', pending: 1, rejected: 1, lastOk },
      '⟳ в очереди 1 · △ сервер не принял 1 (обновите сервер)',
    ],
  ])('%s', (_name, status, text) => {
    expect(syncText(status, TZ)).toBe(text);
  });
});
