# BeoGeoQuest route tool

Инструменты для городского квеста БеоГеоКвест: парсинг заданий, оцифровка бумажной карты, оптимальный пешеходный маршрут, PWA для двух телефонов.

**Полный контекст и решения — `docs/brief.md`. Прочитай его перед любой задачей.**
Тестовые данные прошлой игры — `fixtures/2026-10-10/`.

## Как работать со мной
- Кратко и практично. Многошаговое — списком, остальное — короткой прозой.
- Не выдумывай детали репозитория/данных; если не уверен — предложи конкретную команду поиска.
- Для утверждений о коде указывай путь файла + символ.
- Предложение изменений: план → минимальный объём диффа → тесты/проверка → риски (идемпотентность, повторы, таймауты, дубли, порядок).
- По умолчанию анализ и рекомендации; файлы правь, когда я явно прошу.
- Не меняй формат логирования без запроса.

## Стек (решено)
TypeScript/Node для всего, кроме OR-Tools солвера (Python). AWS (Lambda + DynamoDB) через Terraform. OSRM в Docker для матрицы.

Тулинг монорепо (решено 16.10.2026):
- **pnpm workspaces** через corepack (`packageManager` в `package.json`), без Turbo/Nx.
- **Node 24** запускает `.ts` напрямую (type stripping): без сборки, `exports` пакетов указывают на `src/*.ts`, импорты с расширением `.ts`, только erasable-синтаксис (без enum/namespace/parameter properties).
- **TypeScript 7**, один `tsconfig.json` в корне, `tsc -p .` только для проверки типов.
- **Vitest** — тесты в `packages/*/test/`; **Biome** — линтер и форматтер.
- **TypeBox** — схемы в `packages/core/src/schema/`; из них генерируются `schemas/*.v1.schema.json` (draft-07, контракт с Python). После правки схем: `corepack pnpm schemas`, тест проверяет актуальность файлов.
- pnpm блокирует пакеты моложе политики `minimumReleaseAge` — не обходить исключениями, брать версию постарше.
- **UI — Preact 10 + Vite** (без `@preact/preset-vite`: JSX через `oxc.jsx.importSource`). Тот же стек планируется для PWA.
- **Docker Desktop** — OSRM (`ghcr.io/project-osrm/osrm-backend:v26.9.0-debian`) для пешеходной матрицы; без Docker `./bgq matrix` считает по прямой × 1,3. Тест с настоящим OSRM пропускается, если нет Docker или графа.
- **osmium-tool** (`brew install osmium-tool`) — системная утилита для разбора выгрузки OSM (.osm.pbf); нужна `./bgq osm`. Тест с osmium пропускается, если утилиты нет.

## Структура
- `packages/core` — типы, схемы, правило баллов, нормализация id.
- `packages/ingest` — парсер Notion-markdown, overrides, CLI (`src/cli.ts`).
- `packages/geo` — справочник адресов OSM (выгрузка Geofabrik + osmium), нечёткий поиск адресов, оценка против эталона, CLI (`src/cli.ts`).
- `packages/routing` — граф OSRM, матрица расстояний, сборка `Problem` для солвера, CLI (`src/cli.ts`).
- `packages/export` — экспорт `points.json` → KML для Organic Maps, CLI (`src/cli.ts`).
- `packages/table` — таблица точек: kps + geo + map + overrides → `points.json` (координаты: ручная правка → карта → адрес), CLI (`src/cli.ts`).
- `packages/georef` — математика привязки фото карты: гомография, RANSAC, местная поправка, leave-one-out. Без DOM — работает в Node и браузере.
- `apps/digitizer` — веб-приложение разметки кружков на фото карты (Vite + Preact). `server/` — запуск и API к каталогу игры (плагин Vite), `src/` — UI; `src/compute.ts` — расчёт координат (тестируется в Node). Свой `tsconfig.json` (DOM + JSX).
- `games/` — рабочая папка, **в git не идёт ничего, кроме `games/_template/game.json`**:
  - `games/<дата>/` — игра: `game.json`, `overrides.yaml`, экспорт, генерируемые `kps.json`/`report.json`/`geo.json`/`points.json`, фото карты `photos/` и разметка `map.json`. Играми считаются только папки-даты.
  - `games/_template/game.json` — образец конфига; `./bgq init` берёт его, если прошлых игр нет.
  - `games/osm/` — выгрузка OSM Сербии и справочники городов (кэш).
- Данные прошлой игры для тестов (в т.ч. её `game.json` и `overrides.yaml`) — в `fixtures/<дата>/`.
- `fixtures/<дата>/` — эталонные данные прошлых игр для тестов; руками не править.

## Команды
- `./bgq init` — экспорт Notion (.zip/.md), положенный в `games/`, → `games/<сегодня>/` + первый прогон.
- `./bgq parse` — прогон последней игры с пересчётом при каждом сохранении.
- `./bgq osm <город>` — накануне игры: выгрузка Сербии с Geofabrik (если её нет; `--refresh` — заново) → справочник `games/osm/<город>.json` и пешеходный граф OSRM `games/osm/osrm-<город>/` (Docker).
- `./bgq geo` — координаты адресных КП → `games/<дата>/geo.json` (`--reference <yaml>` — сверка с эталоном).
- `./bgq map` — digitizer в браузере: фото карты → кружки КП → `games/<дата>/map.json` (автосохранение).
- `./bgq table` — kps + geo + map → `games/<дата>/points.json` (вход для маршрута); код выхода 1 — доступный КП без координат или нет старта/финиша.
- `./bgq kml` — `points.json` → `games/<дата>/points.kml` для Organic Maps (`--all` — и недоступные).
- `./bgq matrix` — расстояния пешком между точками (OSRM; `--haversine` — по прямой) → `matrix.json`.
- `./bgq problem` — `points.json` + `matrix.json` + `params.json` → `problem.json` для солвера.
- `corepack pnpm check` — типы + линтер + тесты; `corepack pnpm format` — автоформат.
