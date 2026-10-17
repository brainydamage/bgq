import type { Kp, Loc, Plan, PlanStop, PointsFile, TimeWindow } from '@bgq/core';
import { haversineM } from '@bgq/geo';
import { clock } from '@bgq/routing';

/**
 * Цвета меток из палитры Organic Maps: стиль с id «placemark-<цвет>» он показывает своим цветом
 * (проверено на iPhone 16.10). Четыре уровня по баллам с разными оттенками и яркостью —
 * жёлтый/оранжевый и синий/голубой на карте почти не различаются, их вместе не используем.
 * На 10.10: 1–3 — 31 КП, 4–5 — 21, 6–7 — 16, 8+ — 8.
 */
export function colorOf(kp: Pick<Kp, 'points'> & Partial<Pick<Kp, 'kind'>>): string {
  // Загадки — отдельным ярким цветом, баллы видны в названии («🧩96 · 9б»).
  if (kp.kind === 'riddle') return RIDDLE_COLOR;
  if (kp.points >= 8) return 'red';
  if (kp.points >= 6) return 'purple';
  if (kp.points >= 4) return 'cyan';
  return 'yellow';
}

const START_COLOR = 'green';
const FINISH_COLOR = 'brown';
const INELIGIBLE_COLOR = 'gray';
/** Загадки: розовый — в палитре Organic Maps не путается с цветами баллов [проверить на iPhone]. */
const RIDDLE_COLOR = 'pink';
const KP_COLORS = ['red', 'purple', 'cyan', 'yellow', RIDDLE_COLOR];

/** Линия маршрута (KML-цвет aabbggrr): синяя — на карте не путается с метками. */
const ROUTE_STYLE = 'route';
const ROUTE_COLOR = 'ffd27819';

export const LEGEND =
  'красный — 8+ баллов · фиолетовый — 6–7 · бирюзовый — 4–5 · жёлтый — 1–3 · розовый — загадка 🧩 · зелёный — старт · коричневый — финиш · ⏰ — окно работы';

export const PLAN_LEGEND =
  'синяя линия — маршрут · «07 · 92 · 9б · 12:41» — 7-й по плану, приход в 12:41';

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const short = (hhmm: string) => (hhmm.endsWith(':00') ? String(Number(hhmm.slice(0, 2))) : hhmm);
export const windowLabel = (w: TimeWindow) => `${short(w.from)}–${short(w.to)}`;

/** «92 · 9б», «99 · 9б ⏰14–18», «🧩96 · 9б» — загадка. */
export function placemarkName(kp: Kp): string {
  const riddle = kp.kind === 'riddle' ? '🧩' : '';
  return `${riddle}${kp.id} · ${kp.points}б${kp.window ? ` ⏰${windowLabel(kp.window)}` : ''}`;
}

const SOURCE_LABEL: Record<Loc['source'], string> = {
  map: 'по карте',
  geocode: 'по адресу',
  manual: 'вручную',
  gmaps_link: 'по ссылке',
};

/** Место КП в плане: номер по порядку (с 1) и остановка. */
export interface PlanPlace {
  n: number;
  stop: PlanStop;
  t0: string;
}

/** «07 · 92 · 9б · 12:41» — номер по порядку и приход по плану. */
export function planPlacemarkName(kp: Kp, p: PlanPlace): string {
  return `${String(p.n).padStart(2, '0')} · ${placemarkName(kp)} · ${clock(p.t0, p.stop.arriveS)}`;
}

/** Описание метки: всё, что нужно у точки, — задание, адрес, окно, откуда координаты. */
export function placemarkDescription(kp: Kp, p?: PlanPlace): string {
  const lines = [kp.title];
  if (p) {
    const wait = p.stop.departS - p.stop.arriveS;
    lines.push(
      `По плану: ${p.n}-й, приход ${clock(p.t0, p.stop.arriveS)}, уход ${clock(p.t0, p.stop.departS)} (${Math.round(wait / 60)} мин на точке)`,
    );
  }
  if (kp.address && kp.address.raw !== kp.title) lines.push(`Адрес: ${kp.address.raw}`);
  lines.push(...kp.description);
  if (kp.extraPhoto) lines.push(`+ ${kp.extraPhoto}`);
  if (kp.window) lines.push(`Работает ${windowLabel(kp.window)}`);
  if (kp.loc) {
    const alt = (kp.altLocs ?? []).map((a) => {
      const d = Math.round(haversineM([kp.loc?.lat ?? 0, kp.loc?.lon ?? 0], [a.lat, a.lon]));
      return `${SOURCE_LABEL[a.source]} — в ${d} м`;
    });
    lines.push(
      `Координаты ${SOURCE_LABEL[kp.loc.source]}${alt.length ? `; ${alt.join('; ')}` : ''}`,
    );
  }
  return lines.join('\n');
}

function placemark(name: string, description: string, color: string, loc: Loc): string {
  return [
    '    <Placemark>',
    `      <name>${xml(name)}</name>`,
    `      <description>${xml(description)}</description>`,
    `      <styleUrl>#placemark-${color}</styleUrl>`,
    `      <Point><coordinates>${loc.lon},${loc.lat}</coordinates></Point>`,
    '    </Placemark>',
  ].join('\n');
}

function folder(name: string, items: string[]): string {
  return items.length
    ? [`  <Folder>`, `    <name>${xml(name)}</name>`, ...items, `  </Folder>`].join('\n')
    : '';
}

export interface KmlOptions {
  /** Показать и недоступные КП (вело) — серым. */
  includeIneligible?: boolean;
  /** План маршрута (актуальный для этих points): линия и нумерация КП по порядку. */
  plan?: Plan;
  /** Линия маршрута по дорожкам (OSRM); нет — прямые отрезки между точками плана. */
  routePath?: { lat: number; lon: number }[];
}

export interface KmlResult {
  kml: string;
  placemarks: number;
  /** Доступные КП без координат — на карту не попали. */
  skipped: string[];
  /** КП из плана, которых нет среди доступных с координатами (план от других points). */
  planMissing: string[];
  /** Загадки без отгадки — на карту не поставить, перечислены в описании. */
  unsolved: string[];
}

function routeLine(
  name: string,
  description: string,
  locs: readonly { lat: number; lon: number }[],
): string {
  return [
    '    <Placemark>',
    `      <name>${xml(name)}</name>`,
    `      <description>${xml(description)}</description>`,
    `      <styleUrl>#${ROUTE_STYLE}</styleUrl>`,
    '      <LineString><tessellate>1</tessellate><coordinates>',
    ...locs.map((l) => `        ${l.lon},${l.lat}`),
    '      </coordinates></LineString>',
    '    </Placemark>',
  ].join('\n');
}

/**
 * points.json → KML для Organic Maps: старт/финиш и доступные КП с заданием в описании.
 * С планом — линия маршрута, КП плана по порядку («07 · 92 · 9б · 12:41»), остальные отдельно.
 */
export function buildKml(t: PointsFile, city: string, o: KmlOptions = {}): KmlResult {
  const ends: string[] = [];
  if (t.start) ends.push(placemark('СТАРТ', `Старт игры ${t.gameId}`, START_COLOR, t.start));
  if (t.finish) ends.push(placemark('ФИНИШ', `Финиш игры ${t.gameId}`, FINISH_COLOR, t.finish));

  const byId = (a: Kp, b: Kp) => a.id.localeCompare(b.id, 'ru', { numeric: true });
  const eligible = t.kps.filter((k) => k.eligible).sort(byId);
  const located = new Map(eligible.flatMap((k) => (k.loc ? [[k.id, k] as const] : [])));
  const planMissing = (o.plan?.stops ?? []).map((s) => s.kpId).filter((id) => !located.has(id));
  // План с КП, которых нет на карте, — от других points: не рисуем его вовсе.
  const plan = planMissing.length ? undefined : o.plan;
  const places = new Map<string, PlanPlace>(
    (plan?.stops ?? []).map((stop, i) => [stop.kpId, { n: i + 1, stop, t0: plan?.t0 ?? '' }]),
  );

  const kpPlacemark = (k: Kp) => {
    const p = places.get(k.id);
    const name = p ? planPlacemarkName(k, p) : placemarkName(k);
    return placemark(name, placemarkDescription(k, p), colorOf(k), k.loc as Loc);
  };
  const inPlan = plan
    ? plan.stops.flatMap((s) => {
        const k = located.get(s.kpId);
        return k ? [kpPlacemark(k)] : [];
      })
    : [];
  const kps = [...located.values()].filter((k) => !places.has(k.id)).map(kpPlacemark);

  const route: string[] = [];
  if (plan && t.start && t.finish) {
    const locs = [t.start, ...plan.stops.map((s) => located.get(s.kpId)?.loc as Loc), t.finish];
    const late = -plan.slackMin;
    const summary = `${plan.stops.length} КП · ${plan.totalPoints} б · ${(plan.distanceM / 1000).toFixed(1).replace('.', ',')} км · финиш ${clock(plan.t0, plan.finishS)}${late > 0 ? `, опоздание ${Math.ceil(late)} мин` : ''}`;
    const how = o.routePath ? 'линия по улицам (OSRM)' : 'прямые отрезки между точками';
    route.push(
      routeLine(
        `Маршрут: ${summary}`,
        `План ${plan.planId} (${plan.solver}), ${how}`,
        o.routePath ?? locs,
      ),
    );
  }
  const ineligible = o.includeIneligible
    ? t.kps
        .filter((k) => !k.eligible && k.loc)
        .sort(byId)
        .map((k) =>
          placemark(placemarkName(k), placemarkDescription(k), INELIGIBLE_COLOR, k.loc as Loc),
        )
    : [];

  const colors = [...KP_COLORS, START_COLOR, FINISH_COLOR, INELIGIBLE_COLOR];
  const styles = colors.map((c) =>
    [
      `  <Style id="placemark-${c}">`,
      '    <IconStyle>',
      `      <Icon><href>https://omaps.app/placemarks/placemark-${c}.png</href></Icon>`,
      '    </IconStyle>',
      '  </Style>',
    ].join('\n'),
  );
  if (route.length) {
    styles.push(
      [
        `  <Style id="${ROUTE_STYLE}">`,
        `    <LineStyle><color>${ROUTE_COLOR}</color><width>5</width></LineStyle>`,
        '  </Style>',
      ].join('\n'),
    );
  }

  const unsolved = eligible.filter((k) => k.kind === 'riddle' && !k.loc);
  const legend = [
    LEGEND,
    ...(route.length ? [PLAN_LEGEND] : []),
    ...(unsolved.length
      ? [`🧩 не решены: ${unsolved.map((k) => `${k.id} (${k.points} б)`).join(', ')}`]
      : []),
  ].join('\n');

  const kml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `  <name>${xml(`БГК ${city} ${t.gameId}`)}</name>`,
    `  <description>${xml(legend)}</description>`,
    ...styles,
    folder('Старт и финиш', ends),
    folder('Маршрут', route),
    folder(`План (${inPlan.length})`, inPlan),
    folder(plan ? `Не в плане (${kps.length})` : `КП (${kps.length})`, kps),
    folder('Недоступные (вело)', ineligible),
    '</Document>',
    '</kml>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    kml: `${kml}\n`,
    placemarks: ends.length + inPlan.length + kps.length + ineligible.length,
    skipped: eligible.filter((k) => !k.loc && k.kind !== 'riddle').map((k) => k.id),
    planMissing,
    unsolved: unsolved.map((k) => k.id),
  };
}
