# Фирменный визуальный стиль «Домашнего прода»

Утверждён владельцем; задан референсом `brand-reference.webp` (исходное
изображение владельца, формат WebP; НЕ перегенерировать). Референс: дом,
терминал `>_`, серверная стойка, спящий чёрный кот, blueprint-сетка,
круговая инженерная разметка, cyan/mint палитра, тёмный фон.

## Базовый блок стиля (включать в каждый промпт дословно)

```text
Modern engineering illustration in a cozy homelab setting, dark graphite,
almost black background (#0b0f14). Neon mint and teal accents (#2dd4bf,
#38bdf8) with a soft glow and clean thin outlines. Subtle blueprint
elements: fine grid lines, schematic contours, precise connectors.
Warm home accents where the story allows: a desk lamp, a window with
evening light, a mug. A recurring character — an engineer cat in tiny
glasses, calm and focused — only when it fits the story naturally.
Minimal or no text inside the image. No random pseudo-labels, no fake
interfaces, no made-up numbers or metrics.
```

## Правила

- Иллюстрация раскрывает **сюжет конкретной статьи**, не «просто сервер с котом».
- Кот-инженер — повторяющийся персонаж, но не в каждом кадре; reference
  задаёт стиль, а не обязательный набор объектов.
- Тёплые акценты — дозированно (1–2 на изображение).
- Минимум текста; никаких псевдо-надписей, выдуманных интерфейсов и показателей.
- Один визуальный сюжет внутри концепции: 3:2 (Telegram) и 16:9 (cover) —
  две АДАПТАЦИИ композиции (пересобирается под формат, не растягивается и не кропится).
- Между концепциями — РАЗНЫЕ метафоры (см. `prompts/image.md` §1).

## Форматы и бюджеты (фактические требования сайта)

| Назначение | Пропорции | Размер | Формат | Бюджет |
|---|---|---|---|---|
| Telegram-иллюстрация | **3:2** | 1200×800 | PNG | ≤ 5 МБ |
| Обложка статьи (`cover.webp`, og:image) | 16:9 | ≥ 1280×720 | WebP | ≤ 150 КБ |
| Превью карточки списка | 16:9 | 800×450 | WebP | ≤ 150 КБ |

Суммарный бюджет обработанных webp на сайт — ≤ 3 МБ (CI `tests/images.test.mjs`);
og:image ≤ 300 КБ перекрывается лимитом обложки. Сайт сам ресайзит обложку
из page bundle для карточки (`layouts/partials/blog/cover.html`), поэтому
в бандл попадает только выбранная обложка.

Изменение бюджетов — только по согласованию с владельцем: сначала примеры
(вес/качество), потом предложение.

## Обработка (детерминированная, `scripts/images.mjs`)

- Кроп до точных пропорций: `crop <src> 1280x720` / `crop <src> 800x450`.
- Ресайз по ширине (пропорции сохраняются): `convert <src> <width>`.
- Проверка концепций: `check <images-dir>` (пропорции, ширины, веса).
- Конвертация — Chrome OffscreenCanvas (системный sips в окружении сломан).
