# Промпт: генерация изображений (встроенный `$imagegen` или `codex exec` по подписке)

Шаги 8–10 конвейера: Image Brief → промпты → генерация (путь — §0) → проверка.
Работает ТОЛЬКО после анализа архива и подготовки статьи (brief.md + article.md):
промпты строятся из содержания статьи, а не из названия ZIP-архива.

## 0. Механизм генерации (жёсткое правило)

Пути генерации — в порядке приоритета; **платный API — НЕ путь по умолчанию**:

1. **Встроенный skill `$imagegen`** (built-in `image_gen`) — если текущий агент
   сам имеет этот инструмент (Codex-окружение).
2. **`codex exec` по подписке владельца** — основной путь из внешних агентов
   (напр., ZCode-сессии без встроенного image_gen). Проверено фактически
   2026-11-12, codex-cli 0.167.1, авторизация `codex login status` = «Logged in
   using ChatGPT» (подписка; `OPENAI_API_KEY` НЕ нужен):

   ```sh
   codex exec --skip-git-repo-check -i references/brand-reference.webp \
     "<промпт: сгенерируй РОВНО ОДНО изображение (сюжет/стиль из prompt.md,
     style follows the attached brand reference); выведи итоговый путь к файлу>"
   - `-i/--image <FILE>` — реальный флаг codex-cli 0.167.1: референс стиля
     передаётся как входное изображение (роль — style reference, см. §2 п.6/11);
   ```

   - файл появляется в `~/.codex/generated_images/<session>/<exec>.png` —
     **вызывающий копирует его** в `tmp/drafts/<id>/images/<concept>/`
     (песочница codex exec по умолчанию read-only — прямо в проект не пишет);
   - точный размер генератор НЕ гарантирует (тест: просили 1024×1024, получили
     1254×1254) — финальные размеры всегда детерминированы через `images.mjs`;
   - один вызов = одно изображение; промпт должен требовать ровно одно.

3. **Платный API-fallback (OPENAI_API_KEY)** — только с явного согласия владельца
   (скилл imagegen, CLI-режим). Отсутствие встроенного инструмента НЕ означает
   автоматический переход на платный путь — сначала путь 2.

Скрипты скилла (`images.mjs`) НЕ генерируют — они только проверяют
размеры/форматы и делают детерминированные ресайз/кроп/WebP. Запрещено:
OpenAI API как основной путь, собственный HTTP-клиент, сторонние сервисы.

Правила (независимо от пути):

1. Сформировать ВСЕ промпты заранее (три концепции, см. §2), затем вызывать.
2. Один вызов = одно изображение. Стандартная статья = **6 генераций**
   (3 концепции × [1:1 + широкая]); `blog-preview` — ресайз из cover
   (`images.mjs crop`), без генерации. Если владелец предоставил готовые
   генерации (пакетом) — использовать их, дополнительная генерация только
   по необходимости и с его ведома.
3. Вывод инструмента живёт вне проекта — **перенести файл** в
   `tmp/drafts/<id>/images/<concept>/`; проектный ассет не оставлять в
   дефолтном расположении инструмента.
4. Не перезаписывать существующие файлы молча — версионировать имена.
5. Проверить каждый результат: сюжет считывается, нет псевдо-надписей и
   выдуманных интерфейсов, стиль выдержан. Итерация — одно адресное изменение
   в промпте, затем повторная проверка. Генерация может уйти от брифа
   (проверено 2026-11-12: концепция «терминал с красной строкой» вышла
   «роботом над чертежом», а заявленный «мост» — «котом за терминалом»):
   факт расхождения фиксируется на review, решение (принять/перегенерировать)
   за владельцем.
6. Если ни один путь недоступен — **остановить этап генерации и сообщить
   точный blocker**; заглушки/чужие картинки запрещены. Не утверждать,
   что изображение создано, пока фактический файл не сохранён в concept-каталоге.

Референс стиля — `references/brand-reference.webp` (утверждён владельцем;
не перегенерировать). Передавать его во встроенный инструмент как
**reference image для стиля/настроения** (роль — style reference), когда
инструмент принимает входные изображения.

## 1. Три концепции (шаг 8: `tmp/drafts/<id>/images/brief.md`)

Image Brief пишется на основе Article Brief (раздел «Визуальные объекты») и
готовой статьи. Для статьи готовятся **три визуальные концепции** одной темы,
различающиеся композицией или визуальной метафорой, например:

- инженерная сцена — «как это выглядело в железе/консоли»;
- сюжетная иллюстрация — история глазами героя/персонажа;
- техническая blueprint-композиция — схема/разрез/чертёж явления.

Три практически одинаковые картинки — брак: концепции должны отличаться
СУЩЕСТВЕННО (разная метафора, не только ракурс). Reference задаёт стиль,
но не требует кота и серверы в каждой статье: изображение соответствует
сюжету конкретного материала.

Image Brief (шаблон):

```markdown
# Image Brief: <article-id>

## Сюжет статьи (2–3 предложения)

…из brief.md/article.md, своими словами…

## Концепция 1 — <название, метафора>

- Сцена: …
- Ключевые объекты: …
- Визуальная метафора: …

## Концепция 2 — …

## Концепция 3 — …

## Общие ограничения

(из «Ограничений и неопределённостей» brief.md: что нельзя показывать,
что не выдумывать — интерфейсы, цифры, надписи)
```

## 2. Построение промпта (каждый промпт — специфичный для статьи)

**Запрещён** один универсальный промпт с заменой заголовка. Каждый промпт
содержит ВСЕ блоки (фирменный стиль — дословно из `references/visual-style.md`):

1. **Назначение** — telegram 1:1 / blog-cover 16:9.
2. **Краткий сюжет статьи** — 1–2 предложения.
3. **Основная сцена** — что происходит в кадре.
4. **Ключевые объекты** — перечисление из Image Brief.
5. **Визуальная метафора** — что иллюстрация «говорит» про тему.
6. **Фирменный стиль** — базовый блок visual-style.md + указание использовать
   brand reference как style reference.
7. **Композиция** — размещение объектов, свечение, куда смещён акцент
   (для 16:9 композиция пересобирается, а не растягивается).
8. **Aspect ratio** — 1:1 (1024×1024) или широкий 16:9.
9. **Ограничения** — минимум текста, тёплые акценты дозированно и т.д.
10. **Negative constraints** — no pseudo-labels, no fake interfaces,
    no made-up numbers/metrics, no watermark.
11. **Brand reference** — «style follows the attached brand reference:
    dark graphite, neon mint/teal, blueprint grid».

Фактически использованный промпт сохраняется ДОСЛОВНО в
`images/<concept>/prompt.md` (для воспроизводимости) — вместе с пометкой,
какой путь генерации (built-in `$imagegen` или `codex exec` по §0) и для какого формата применялся.

## 3. Форматы (требования сайта проверены тестами)

| Формат         | Размер                          | Файл                           | Как получается                                                     |
| -------------- | ------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `telegram`     | 1:1, 1024×1024, PNG             | `concept-NN/telegram.png`      | генерация                                                          |
| `blog-cover`   | 16:9, ≥ 1280×720, WebP ≤ 150 КБ | `concept-NN/blog-cover.webp`   | генерация (широкая) → `images.mjs crop <src> 1280x720 --quality …` |
| `blog-preview` | 16:9, 800×450, WebP ≤ 150 КБ    | `concept-NN/blog-preview.webp` | **без генерации**: `images.mjs crop <cover> 800x450`               |

Preview и cover — одна композиция и один aspect ratio, поэтому preview
получается ресайзом из cover (разрешено; отдельная генерация не нужна).
Проверка всех трёх форматов: `images.mjs check tmp/drafts/<id>/images`.

Бюджеты сайта (CI `tests/images.test.mjs`): webp ≤ 150 КБ каждый и ≤ 3 МБ
суммарно на сайт; og:image ≤ 300 КБ (перекрывается). Если 150 КБ мешают
качеству — собрать примеры (вес/качество) и ПРЕДЛОЖИТЬ владельцу изменить
бюджет; без согласования не менять. Подбирать quality без заметной потери.

## 4. Процесс (шаги 9–10)

1. Убедиться: brief.md и article.md готовы (генерация до анализа запрещена).
2. Написать Image Brief (`images/brief.md`) — три РАЗНЫЕ концепции.
3. Составить все промпты (по 2 на концепцию: 1:1 и широкая).
4. Сгенерировать по пути §0 (built-in `$imagegen` или `codex exec`);
   перенести файлы в concept-каталоги; сохранить промпты в `prompt.md`.
5. Детерминированная обработка: crop до 1280×720 → blog-cover.webp;
   crop до 800×450 → blog-preview.webp (`images.mjs`).
6. `images.mjs check …` + просмотр каждой картинки (сюжет/стиль/надписи).
7. `secrets-check.mjs` по черновикам (тексты рядом с изображениями).
8. `package.mjs` соберёт review package и откажет, если хоть одного
   обязательного файла нет — генерация «успешна» только при полном комплекте.

## 5. Пример (заполненный)

Image Brief (фрагмент) для статьи «Диагностика ошибок Telegram»:

```markdown
## Концепция 2 — «Кипящий кабель» (сюжетная иллюстрация)

- Сцена: домашний роутер ночью; из порта тянется светящийся кабель,
  уходящий в тёмный город за окном; часть импульсов по дороге гаснет.
- Ключевые объекты: роутер, патч-корд, окно с ночным городом, кот спит рядом.
- Визуальная метафора: пакеты теряются по пути — часть света не доходит.
```

Промпт для blog-cover (16:9), концепция 2:

```text
Use case: illustration-story
Asset type: blog cover 16:9 for an engineering post about diagnosing
Telegram delivery errors on a home network
Article subject: packets between a home router and Telegram servers
silently disappear; the post walks through diagnosing where they die.
Main scene: a cozy dark homelab corner at night; a home router on a shelf,
one glowing cable leaving a port and stretching out of frame through a
window into a dark city; some light pulses fade mid-cable.
Key objects: home router, single ethernet cable, night window with distant
city lights, small sleeping black cat on the shelf edge.
Visual metaphor: some pulses of light never reach the city — packets lost
in transit.
Style: modern engineering illustration, cozy homelab setting; style follows
the attached brand reference: dark graphite almost-black background
(#0b0f14), neon mint and teal accents (#2dd4bf, #38bdf8) with soft glow and
clean thin outlines, subtle blueprint grid lines and circular engineering
markings; one warm accent (desk lamp) allowed.
Composition: wide 16:9; router on the left third, cable sweeping right
through the window; glow concentrated along the cable; negative space
on the right for calm.
Aspect ratio: 16:9.
Constraints: minimal or no text inside the image; at most one warm accent;
keep the cat subtle, not the focus.
Negative constraints: no pseudo-labels, no fake interfaces or dashboards,
no made-up numbers or metrics, no watermark.
Input images: Image 1 — brand reference (style/mood only, not composition).
```

## 6. После выбора концепции (approval, этап D)

- Telegram-изображение выбранной концепции уходит в ручную публикацию как есть.
- Её `blog-cover.webp` копируется в `src/content/blog/<slug>/cover.webp`
  только после явного одобрения; фиксируется `state.mjs <id> set images.cover=…`.
