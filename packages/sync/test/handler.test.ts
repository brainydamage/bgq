import type { Event, SyncRequest, SyncResponse } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import {
  createHandler,
  MAX_BODY,
  memoryStore,
  OVERLAP_MS,
  PAGE,
  readFrom,
  type UrlRequest,
} from '../src/index.ts';

const CODE = 'team-code-0123456789';
const GAME = '2026-10-10';

let n = 0;
function ev(over: Partial<Event> = {}): Event {
  n++;
  return {
    v: 1,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    gameId: GAME,
    kpId: '64',
    deviceId: 'iphone',
    seq: n,
    clientTs: '2026-10-10T12:51:10+02:00',
    type: 'taken',
    answerTime: '12:51',
    ...over,
  } as Event;
}

function post(body: unknown, code: string | null = CODE): UrlRequest {
  return {
    requestContext: { http: { method: 'POST' } },
    headers: code === null ? {} : { 'x-bgq-code': code },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

const req = (events: Event[], after = ''): SyncRequest => ({ v: 1, gameId: GAME, after, events });

/** Обработчик с часами, которые идут вперёд по секунде на вызов now(). */
function setup(start = '2026-10-10T10:00:00.000Z') {
  const store = memoryStore();
  let t = Date.parse(start);
  const clock = {
    set: (iso: string) => {
      t = Date.parse(iso);
    },
  };
  const handler = createHandler({ store, code: CODE, now: () => new Date(t) });
  const call = async (r: UrlRequest) => {
    const res = await handler(r);
    return {
      status: res.statusCode,
      body: JSON.parse(res.body) as SyncResponse & { error?: string },
    };
  };
  return { store, clock, call };
}

describe('доступ и проверка запроса', () => {
  it('без кода или с чужим кодом — 401, ничего не пишется', async () => {
    const { store, call } = setup();
    expect((await call(post(req([ev()]), null))).status).toBe(401);
    expect((await call(post(req([ev()]), 'wrong'))).status).toBe(401);
    expect(store.games.size).toBe(0);
  });

  it('не POST — 405', async () => {
    const { call } = setup();
    const r = { ...post(req([])), requestContext: { http: { method: 'GET' } } };
    expect((await call(r)).status).toBe(405);
  });

  it('битый JSON или конверт не по схеме — 400', async () => {
    const { store, call } = setup();
    expect((await call(post('{'))).status).toBe(400);
    expect((await call(post({ v: 1, gameId: GAME, events: [] }))).status).toBe(400);
    expect((await call(post({ ...req([]), after: 'вчера' }))).status).toBe(400);
    expect(store.games.size).toBe(0);
  });

  it('незнакомое событие (телефон новее сервера) — в rejected, остальные принимаются', async () => {
    const { store, call } = setup();
    const good = ev();
    const bad = { ...ev(), type: 'photo_added' } as unknown as Event;
    const res = await call(post(req([bad, good])));
    expect(res.status).toBe(200);
    expect(res.body.accepted).toEqual([good.id]);
    expect(res.body.rejected).toEqual([{ id: bad.id, error: expect.any(String) }]);
    expect([...(store.games.get(GAME)?.keys() ?? [])]).toEqual([good.id]);
  });

  it('событие другой игры — в rejected (код один на все игры, игры не смешиваются)', async () => {
    const { store, call } = setup();
    const other = ev({ gameId: '2026-10-17' });
    const res = await call(post(req([ev(), other])));
    expect(res.body.rejected.map((r) => r.id)).toEqual([other.id]);
    expect(store.games.has('2026-10-17')).toBe(false);
    expect(store.games.get(GAME)?.size).toBe(1);
  });

  it('больше 100 событий или тело больше предела — отказ', async () => {
    const { call } = setup();
    const many = Array.from({ length: 101 }, () => ev());
    expect((await call(post(req(many)))).status).toBe(400);
    const huge = JSON.stringify(
      req([ev({ type: 'answer_changed', answer: 'x'.repeat(MAX_BODY) })]),
    );
    expect((await call(post(huge))).status).toBe(413);
  });

  it('тело в base64 (Function URL так присылает бинарное) разбирается', async () => {
    const { call } = setup();
    const r = post(req([ev()]));
    const res = await call({
      ...r,
      body: Buffer.from(r.body ?? '').toString('base64'),
      isBase64Encoded: true,
    });
    expect(res.status).toBe(200);
  });
});

describe('запись и чтение', () => {
  it('запись идемпотентна: повторная отправка принята, но не дублирует', async () => {
    const { store, call } = setup();
    const e = ev();
    const first = await call(post(req([e])));
    const again = await call(post(req([e])));
    expect(first.body.accepted).toEqual([e.id]);
    expect(again.body.accepted).toEqual([e.id]);
    expect(store.games.get(GAME)?.size).toBe(1);
    expect(again.body.events.map((x) => x.id)).toEqual([e.id]);
  });

  it('второй телефон получает события первого; свои тоже возвращаются (восстановление)', async () => {
    const { call } = setup();
    const a = ev({ deviceId: 'iphone' });
    await call(post(req([a])));
    const { answerTime: _, ...base } = ev({ deviceId: 'android', kpId: '71' }) as Event & {
      answerTime: string;
    };
    const b = { ...base, type: 'skipped' } as Event;
    const res = await call(post(req([b])));
    expect(res.status).toBe(200);
    expect(res.body.events.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(res.body.events[1]).toEqual(b);
  });

  it('курсор — по времени прихода на сервер, а не по clientTs', async () => {
    const { call, clock } = setup();
    const first = ev({ clientTs: '2026-10-10T12:00:00+02:00' });
    const r1 = await call(post(req([first])));
    clock.set('2026-10-10T10:10:00.000Z');
    // Событие из очереди: на телефоне было раньше, на сервер пришло позже — не теряется.
    const late = ev({ clientTs: '2026-10-10T11:00:00+02:00' });
    await call(post(req([late])));
    clock.set('2026-10-10T10:20:00.000Z');
    const r3 = await call(post(req([], r1.body.cursor)));
    // first — из запаса OVERLAP_MS назад от курсора, late — новое.
    expect(r3.body.events.map((x) => x.id)).toEqual([first.id, late.id]);
    expect(r3.body.cursor > r1.body.cursor).toBe(true);
  });

  it('чтение с запасом OVERLAP_MS назад: недавние события приходят повторно, курсор не откатывается', async () => {
    const { call, clock } = setup();
    const a = ev();
    await call(post(req([a])));
    clock.set('2026-10-10T10:00:30.000Z');
    const b = ev();
    const rb = await call(post(req([b])));
    // Курсор на b; a пришло на 30 с раньше — в пределах запаса.
    const again = await call(post(req([], rb.body.cursor)));
    expect(again.body.events.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(again.body.cursor).toBe(rb.body.cursor);
    clock.set('2026-10-10T10:05:00.000Z');
    expect(readFrom(rb.body.cursor)).toBe(
      new Date(Date.parse('2026-10-10T10:00:30.000Z') - OVERLAP_MS).toISOString(),
    );
  });

  it('больше PAGE событий — по страницам с more', async () => {
    const { call, clock } = setup();
    for (let i = 0; i < 6; i++) {
      clock.set(new Date(Date.parse('2026-10-10T10:00:00.000Z') + i * 120_000).toISOString());
      await call(post(req(Array.from({ length: 100 }, () => ev()))));
    }
    const seen = new Set<string>();
    let cursor = '';
    let pages = 0;
    for (;;) {
      const res = await call(post(req([], cursor)));
      for (const e of res.body.events) seen.add(e.id);
      cursor = res.body.cursor;
      pages++;
      if (!res.body.more) break;
    }
    expect(PAGE).toBeLessThan(600);
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(600);
  });

  it('serverTime — часы сервера (телефон сверяет свои)', async () => {
    const { call } = setup('2026-10-10T10:00:00.000Z');
    const res = await call(post(req([])));
    expect(res.body.serverTime).toBe('2026-10-10T10:00:00.000Z');
    expect(res.body.cursor).toBe('');
    expect(res.body.more).toBe(false);
  });
});
