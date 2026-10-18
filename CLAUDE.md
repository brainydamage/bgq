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
- **UI — Preact 10 + Vite** (без `@preact/preset-vite`: JSX через `oxc.jsx.importSource`). PWA (`apps/pwa`) — тот же стек, service worker свой (без Workbox/vite-plugin-pwa). Офлайн — только по HTTPS или localhost, поэтому оболочка PWA на GitHub Pages, а данные игры — файлом.
- **Docker Desktop** — OSRM (`ghcr.io/project-osrm/osrm-backend:v26.9.0-debian`) для пешеходной матрицы; без Docker `./bgq matrix` считает по прямой × 1,3. Тест с настоящим OSRM пропускается, если нет Docker или графа.
- **Солвер — Python 3.14 + OR-Tools 9.15** в `solver/` через **uv** (`brew install uv`), **ruff** (линтер и форматтер), **pytest**. `[tool.uv] exclude-newer = "1 week"` — аналог `minimumReleaseAge`, не обходить. Контракт с TS — только `schemas/*.v1.schema.json`.
- **osmium-tool** (`brew install osmium-tool`) — системная утилита для разбора выгрузки OSM (.osm.pbf); нужна `./bgq osm`. Тест с osmium пропускается, если утилиты нет.

## Структура
- `packages/core` — типы, схемы, правило баллов, нормализация id, загадки (`riddles.ts`: разбор расшифровки листков и координат отгадки), состояние из событий (`state.ts`: `projectState`, включая галочку «переписано» `copied`), данные для телефона (`phone.ts` → `phone.json`: задания, доступные КП, свежий план).
- `packages/ingest` — парсер Notion-markdown, overrides, CLI (`src/cli.ts`).
- `packages/geo` — справочник адресов OSM (выгрузка Geofabrik + osmium), нечёткий поиск адресов, оценка против эталона, CLI (`src/cli.ts`).
- `packages/routing` — граф OSRM, матрица расстояний, сборка `Problem` для солвера, запуск солвера и сводка плана (`src/solve.ts`), свежесть `plan.json` (`src/plan-file.ts`: `freshPlan` — для kml и pwa), CLI (`src/cli.ts`).
- `packages/export` — экспорт `points.json` (+ `plan.json`: линия маршрута, номера по порядку) → KML для Organic Maps, CLI (`src/cli.ts`).
- `solver/` — Python-солвер OR-Tools: `src/bgq_solver/model.py` (модель, портфель стратегий), `improve.py` (доработка после OR-Tools: «взять один — убрать два», relocate, 2-opt, ILS), `plan.py` (времена прямым проходом → `Plan`), `cli.py` (`bgq-solve`); тесты в `solver/tests/`.
- `packages/table` — таблица точек: kps + geo + map + overrides → `points.json` (координаты: ручная правка → карта → адрес), CLI (`src/cli.ts`).
- `packages/georef` — математика привязки фото карты: гомография, RANSAC, местная поправка, leave-one-out. Без DOM — работает в Node и браузере.
- `apps/digitizer` — веб-приложение разметки кружков на фото карты (Vite + Preact). `server/` — запуск и API к каталогу игры (плагин Vite), `src/` — UI; `src/compute.ts` — расчёт координат (тестируется в Node). Свой `tsconfig.json` (DOM + JSX).
- `apps/pwa` — PWA для телефона (Vite + Preact, IndexedDB, свой service worker `src/sw.ts`, собирается плагином в `vite.config.ts`). Экраны — вкладки «Маршрут · Штурман · Задания · Книжка» + карточка КП, экран в `location.hash` (`src/router.ts`); `App.tsx` — оболочка (загрузка игры, вкладки), `RouteView`/`KpCard`/`NavView`/`TasksView`/`BookView.tsx` — экраны. Логика (тестируется в Node, данные 10.10 — `test/fixture.ts`): `src/route.ts` (порядок плана, следующие точки, запас и отставание, `geo:`), `src/checklist.ts` (задания без места), `src/book.ts` (книжка ответов: строки по номерам, подсветка 0 б / нет ответа, «переписать заново» по снимку в `copied`); ответ/заметка при вводе — `src/autosave.ts`; события — `src/events.ts`, хранилище — `src/db.ts`. `server/cli.ts` — `./bgq pwa`. Свой `tsconfig.json` (DOM + JSX). Оболочка — на GitHub Pages (`.github/workflows/pwa.yml`, `base: './'`), данных игры в сборке нет.
- `games/` — рабочая папка, **в git не идёт ничего, кроме `games/_template/game.json`**:
  - `games/<дата>/` — игра: `game.json`, `overrides.yaml`, экспорт, генерируемые `kps.json`/`report.json`/`geo.json`/`points.json`/`phone.json`, фото карты `photos/` и разметка `map.json`, загадки `riddles.json` и фото листков `riddles/`. Играми считаются только папки-даты.
  - `games/_template/game.json` — образец конфига; `./bgq init` берёт его, если прошлых игр нет.
  - `games/osm/` — выгрузка OSM Сербии и справочники городов (кэш).
- Данные прошлой игры для тестов (в т.ч. её `game.json`, `overrides.yaml`, `problem.json`, план солвера `plan.json` и итоги по протоколу `result.yaml`) — в `fixtures/<дата>/`.
- `fixtures/<дата>/` — эталонные данные прошлых игр для тестов; руками не править.

## Команды
- `./bgq init --start ЧЧ:ММ` — сразу после пролога: экспорт Notion (.zip/.md), положенный в `games/`, → `games/<сегодня>/` + первый прогон. `--start` — время старта пролога (у каждой команды своё): дедлайн = старт + 9 ч (`durationMin`), `start.depart` = сейчас (получили комплект).
- `./bgq parse` — прогон последней игры с пересчётом при каждом сохранении.
- `./bgq osm <город>` — накануне игры: выгрузка Сербии с Geofabrik (если её нет; `--refresh` — заново) → справочник `games/osm/<город>.json` и пешеходный граф OSRM `games/osm/osrm-<город>/` (Docker).
- `./bgq geo` — координаты адресных КП → `games/<дата>/geo.json` (`--reference <yaml>` — сверка с эталоном).
- `./bgq map` — digitizer в браузере: фото карты → кружки КП → `games/<дата>/map.json` (автосохранение). Страница `/riddles` — загадки (вставка расшифровки листков, заметки, отгадки координатами) и задания без места с баллами (чек-лист для поля) → `riddles.json`; `--lan` — открыть для второго ноутбука.
- `./bgq pwa` — `game.json` + `riddles.json` + `points.json` + свежий `plan.json` (устаревший не кладётся, как у kml) → `games/<дата>/phone.json` для телефона (AirDrop → «Сохранить в Файлы» → в приложении «Загрузить игру»). `dev` — приложение на ноутбуке (`?load=phone.json` подгружает игру); `build` — сборка в `apps/pwa/dist`; `preview` — сборка + localhost с service worker (проверка офлайна). `--lan` — по http, **без офлайна**: только посмотреть с телефона.
- `./bgq route` — после отгадки или правки карты: table → matrix → problem → solve → kml (~17 с).
- `./bgq table` — kps + geo + map → `games/<дата>/points.json` (вход для маршрута); код выхода 1 — доступный КП без координат или нет старта/финиша.
- `./bgq kml` — `points.json` → `games/<дата>/points.kml` для Organic Maps (`--all` — и недоступные); со свежим `plan.json` — ещё линия маршрута по улицам (OSRM в Docker; без него или `--straight` — прямые) и КП по порядку.
- `./bgq matrix` — расстояния пешком между точками (OSRM; `--haversine` — по прямой) → `matrix.json`.
- `./bgq problem` — `points.json` + `matrix.json` + `params.json` → `problem.json` для солвера; время — от выхода после пролога (`start.depart` в `game.json`, иначе от старта).
- `./bgq solve` — `problem.json` → `plan.json` (OR-Tools + доработка, ~14 с) + сводка; выход по умолчанию — в день игры «сейчас + 2 мин», иначе от получения комплекта; `--depart ЧЧ:ММ` — явно, `--time С` — лимит поиска.
- `corepack pnpm check` — типы + линтер + vitest + ruff + pytest (нужен uv); `check:py` — только Python; `corepack pnpm format` — автоформат (Biome + ruff).
