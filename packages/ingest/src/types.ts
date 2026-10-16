import type { Kp } from '@bgq/core';

/** critical — ломает маршрут (id, баллы, категория), правим на старте; cosmetic — нет. */
export type Severity = 'critical' | 'cosmetic';

export type IssueCode =
  | 'no_kps'
  | 'bad_kp_id'
  | 'duplicate_id'
  | 'unknown_section'
  | 'unknown_note'
  | 'possible_missed_header'
  | 'override_unknown_id'
  | 'override_invalid'
  | 'schema_invalid'
  | 'empty_body'
  | 'finish_missing'
  | 'finish_field_missing';

export interface Issue {
  severity: Severity;
  code: IssueCode;
  message: string;
  kpId?: string;
  /** Номер строки в исходном .md (с 1). */
  line?: number;
}

export interface Finish {
  /** Текст заголовка без «Финиш.»: "Кафе La Gioia Улица Короля Петра Первого дом 15". */
  place: string;
  address?: string;
  deadline?: string;
  graceMin?: number;
  penaltyPerMin?: number;
  line: number;
}

export interface Stats {
  kps: number;
  eligible: number;
  /** Сумма баллов доступных КП. */
  points: number;
  /** Адрес с номером дома (или альтернативным адресом в скобках) — можно геокодить. */
  withHouseNumber: number;
  withMapsLink: number;
  preambleLines: number;
}

export interface IngestResult {
  kps: Kp[];
  finish?: Finish;
  issues: Issue[];
  stats: Stats;
  /** id КП → строка заголовка в .md. */
  sourceLines: Record<string, number>;
}
