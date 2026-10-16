import type { Kp, Loc, PointsFile, TimeWindow } from '@bgq/core';
import { haversineM } from '@bgq/geo';

/**
 * Цвета меток из палитры Organic Maps: стиль с id «placemark-<цвет>» он показывает своим цветом
 * (проверено на iPhone 16.10). Четыре уровня по баллам с разными оттенками и яркостью —
 * жёлтый/оранжевый и синий/голубой на карте почти не различаются, их вместе не используем.
 * На 10.10: 1–3 — 31 КП, 4–5 — 21, 6–7 — 16, 8+ — 8.
 */
export function colorOf(kp: Pick<Kp, 'points'>): string {
  if (kp.points >= 8) return 'red';
  if (kp.points >= 6) return 'purple';
  if (kp.points >= 4) return 'cyan';
  return 'yellow';
}

const START_COLOR = 'green';
const FINISH_COLOR = 'brown';
const INELIGIBLE_COLOR = 'gray';
const KP_COLORS = ['red', 'purple', 'cyan', 'yellow'];

export const LEGEND =
  'красный — 8+ баллов · фиолетовый — 6–7 · бирюзовый — 4–5 · жёлтый — 1–3 · зелёный — старт · коричневый — финиш · ⏰ — окно работы';

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

/** «92 · 9б», «99 · 9б ⏰14–18». */
export function placemarkName(kp: Kp): string {
  return `${kp.id} · ${kp.points}б${kp.window ? ` ⏰${windowLabel(kp.window)}` : ''}`;
}

const SOURCE_LABEL: Record<Loc['source'], string> = {
  map: 'по карте',
  geocode: 'по адресу',
  manual: 'вручную',
  gmaps_link: 'по ссылке',
};

/** Описание метки: всё, что нужно у точки, — задание, адрес, окно, откуда координаты. */
export function placemarkDescription(kp: Kp): string {
  const lines = [kp.title];
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
}

export interface KmlResult {
  kml: string;
  placemarks: number;
  /** Доступные КП без координат — на карту не попали. */
  skipped: string[];
}

/** points.json → KML для Organic Maps: старт/финиш и доступные КП с заданием в описании. */
export function buildKml(t: PointsFile, city: string, o: KmlOptions = {}): KmlResult {
  const ends: string[] = [];
  if (t.start) ends.push(placemark('СТАРТ', `Старт игры ${t.gameId}`, START_COLOR, t.start));
  if (t.finish) ends.push(placemark('ФИНИШ', `Финиш игры ${t.gameId}`, FINISH_COLOR, t.finish));

  const byId = (a: Kp, b: Kp) => a.id.localeCompare(b.id, 'ru', { numeric: true });
  const eligible = t.kps.filter((k) => k.eligible).sort(byId);
  const kps = eligible.flatMap((k) =>
    k.loc ? [placemark(placemarkName(k), placemarkDescription(k), colorOf(k), k.loc)] : [],
  );
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

  const kml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `  <name>${xml(`БГК ${city} ${t.gameId}`)}</name>`,
    `  <description>${xml(LEGEND)}</description>`,
    ...styles,
    folder('Старт и финиш', ends),
    folder(`КП (${kps.length})`, kps),
    folder('Недоступные (вело)', ineligible),
    '</Document>',
    '</kml>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    kml: `${kml}\n`,
    placemarks: ends.length + kps.length + ineligible.length,
    skipped: eligible.filter((k) => !k.loc).map((k) => k.id),
  };
}
