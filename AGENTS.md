# AGENTS.md — kulikov.im

## Skills и завершение задач

- Skills проекта — в `.agents/skills/` (workspace-скоуп, версионируются
  в Git). ZCode обнаруживает их автоматически и вызывает Skill tool по
  имени; Codex — как `$<name>`; в уже открытой сессии — прочитать
  `SKILL.md` и следовать ему.
- После содержательных изменений (код, конфиги, Hugo templates, CSS,
  CI/CD, документация, `AGENTS.md`, `.agents/`) применяй skill
  **`task-completion-review`** (`.agents/skills/task-completion-review/SKILL.md`)
  ДО финального отчёта и любого коммита. Read-only-задачи и простые
  ответы — без полного review.
- Подтверждённые конвенции проекта (header, макет статей, i18n, визуальный
  стиль) — `.agents/docs/conventions.md`.

## Editorial workflow и блог

Подготовка статей блога и публикаций Telegram-канала «Домашний прод» —
только через skill **`article-production`**:
`.agents/skills/article-production/SKILL.md` (входная точка, жёсткие правила,
12 шагов конвейера, CLI). Скачивание/распаковка входящих архивов, генерация
иллюстраций (`$imagegen`), валидация и публикация — по этому скиллу.

- `tmp/` — вне Git, только материалы конкретных публикаций:
  `inbox/`, `working/`, `drafts/`, `done/` (+ `bin/` — локальный Hugo).
  Промптов, скриптов и реестров в `tmp/` нет — постоянная часть в скилле.
- Публикация и интеграция в `src/content/blog/` — только после явного
  approval владельца; commit/push/deploy — только по отдельному разрешению.
- Блог — RU-only; EN-версии раздела нет и не создаётся.

## Локальные особенности

- Hugo закреплён версией `.hugo-version` (0.167.0). Homebrew мог обновить
  бинарник — тогда тесты падают на проверке версии; используй локальный
  `HUGO_BIN=$PWD/tmp/bin/hugo` для `hugo`/`npm test`/preview.
- Превью блога: `HUGO_BIN=$PWD/tmp/bin/hugo hugo server --buildDrafts`
  (контент блога — черновики) → http://127.0.0.1:1313/blog/ .
- Dev-сервер перезаписывает `hugo_stats.json` классами черновиков; после
  остановки/правки классов регенерируй из production-сборки:
  `HUGO_ENVIRONMENT=production ./tmp/bin/hugo --gc --minify --baseURL https://kulikov.im/ --destination build/prod-stats`
  (затем удали `build/prod-stats`).
