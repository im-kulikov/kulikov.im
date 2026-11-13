# Git workflow для AI-агентов (обязательный)

Действует для любой задачи, меняющей файлы репозитория. Read-only-задачи
(аудит, review, ответы на вопросы) ограничений на worktree не имеют.
Основано на инцидентах 2026-11: разработка в `main`, ошибки рабочего
каталога (`git pull` не из того дерева), накопление устаревших worktrees.

## Размещение разработки

1. Основной working tree (`/Users/kulikov/Projects/home/kulikov.im`) —
   только `main`, синхронизация и административные Git-операции. Разработка
   в нём запрещена.
2. Любая разработка, тесты изменений и commits — в отдельном Git worktree
   на feature-ветке от актуального `origin/main`.
3. Worktrees живут **внутри** репозитория: `tmp/worktree/<branch-dir>`.
   `tmp/` — в `.gitignore` (gitignored), рядом с репозиторием или в
   системном `/tmp` worktrees не создавать (исключение — только по явному
   разрешению владельца).
4. Имя каталога = имя ветки с `/` → `-` (`docs/git-workflow` →
   `tmp/worktree/docs-git-workflow`). Перед созданием проверять занятость и
   каталога (`git worktree list`), и имени ветки (`git branch --list`) —
   `docs/git-workflow` и `docs-git-workflow` разные ветки с одним каталогом;
   при коллизии — согласовать имя с владельцем, не придумывать суффиксы молча.
5. Существующие незакоммиченные изменения (свои и чужие) при создании
   worktree никогда не удаляются и не перезаписываются. Перенос изменений в
   worktree — копированием проверенных файлов (`cp` + `cmp`), не
   стэш-эм/checkout-фокусами.

## Защита Git-контекста

Перед любой операцией, меняющей Git-состояние, проверить:

- абсолютный путь рабочего каталога (`pwd`);
- текущую ветку (`git branch --show-current`);
- repo root;
- незакоммиченные изменения (`git status --short`);
- ожидаемую ветку и worktree.

Команды — по возможности через `git -C <absolute-path>`. Обновление `main`
— всегда из абсолютного пути основного репозитория, не из текущего shell
cwd (инцидент: `git pull` из worktree fast-forward'нул feature-ветку
вместо `main`). Полагаться на то, что терминал «уже в нужном каталоге»,
запрещено.

Разрушительные операции (`git reset --hard`, `git clean`, `git branch -D`,
`git worktree remove --force`, force-push) — только по отдельному явному
разрешению владельца, не как часть «обычной» уборки.

## Lifecycle задачи

### Start

1. Убедиться, что основное дерево чистое (`git status --short` — пусто).
2. `git fetch origin`.
3. `git -C /Users/kulikov/Projects/home/kulikov.im worktree add -b <branch> /Users/kulikov/Projects/home/kulikov.im/tmp/worktree/<branch-dir> origin/main`.
4. Дальнейшая работа — только внутри worktree.

### Development

1. Файлы, тесты, сборка — только в feature worktree. Локальный Hugo-бинарник
   живёт в основном дереве (gitignored `tmp/bin/`) — в worktree указывать
   абсолютный путь: `HUGO_BIN=/Users/kulikov/Projects/home/kulikov.im/tmp/bin/hugo`.
   `node_modules` в worktree — реальная копия основного дерева (`cp -R`), не
   симлинк: симлинк ломает Tailwind в fixture-тестах (`searchindex.test.mjs`).
2. Атомарные commits (одно логическое изменение = один commit).
3. Push feature branch, PR в `main`, контроль CI.

### Merge

Только по явному разрешению владельца. После merge:

1. PR → `MERGED`; коммиты ветки присутствуют в `origin/main`.
2. Дождаться deployment (workflow на push в `main`), если предусмотрен.
3. Синхронизировать локальный `main`: `git -C /Users/kulikov/Projects/home/kulikov.im pull --ff-only origin main`.
4. Проверить `main == origin/main` и чистоту дерева.

### Cleanup

Только для worktree/ветки текущей завершённой задачи:

1. `git worktree list --porcelain` — статус всех деревьев.
2. Feature worktree чист, включая untracked.
3. Feature branch полностью merged (`git branch --merged origin/main` —
   устойчиво к несинхронизированному локальному `main`).
4. Нет незавершённых операций и ценных локальных данных (если есть —
   backup вне репозитория и согласование).
5. `git worktree remove <abs-path>` — **без** `--force`.
6. `git branch -d <branch>` — только если Git подтвердил безопасность.
7. Финальный `git worktree list` + `git branch -vv`.

Git отказал в безопасном удалении → остановиться, принудительные варианты
запрещены. Чужие worktrees, другие локальные ветки, backups (`~/Projects/home/kulikov.im-backup-*`)
и материалы других задач не трогать.

## Разрешения

| Действие                                | Уровень допуска                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| Создание feature worktree, работа в нём | в рамках согласованной задачи                                                     |
| Commit / push / открытие PR             | по явно согласованному scope задачи                                               |
| Merge, deployment                       | только явное разрешение владельца                                                 |
| Cleanup после merge                     | стандартный финал, если владелец разрешил полный lifecycle задачи включая cleanup |

«Разрешил merge» ≠ «разрешил удалить worktree». При неопределённости —
запросить подтверждение.

## Checklists агента

- **Перед задачей:** main чист → `fetch` → worktree от `origin/main` → работа только в нём.
- **Перед Git write:** pwd/ветка/repo root/status → `git -C <abs>`.
- **Перед PR:** diff vs `origin/main` содержит только файлы scope; тесты зелёные в worktree.
- **После merge:** PR MERGED → deployment ок → `main` fast-forward из корня → `main == origin/main`, дерево чисто.
- **Перед cleanup:** worktree чист, ветка merged, данных не теряем → `worktree remove` (без force) → `branch -d`.
