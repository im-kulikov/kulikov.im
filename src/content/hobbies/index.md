---
title: Чем я увлекаюсь? Хобби — GitHub, Open Source, DIY и книги
keywords:
  - хобби
  - Open Source
  - GitHub
  - Go / golang
  - DIY
  - ESPHome
  - HomeAssistant
  - умный дом
  - техническая литература
  - художественная литература
  - публицистики
description: |
  Проекты на GitHub, DIY-устройства на ESPHome и Arduino, настройка умного дома, 
  а также книги технического и художественного жанра.
common:
  class: hobbies-page
  title: Моё хобби
  icon: bookmark
section:
  title: Чем я увлекаюсь?
  image: img/hobbies-01.png
  placeholder: true
  class: section pt-14 hobbies
  description: |-
    Я увлекаюсь разработкой на Go, публикую проекты на GitHub и активно участвую в Open Source-сообществе. 
    В свободное время создаю DIY-устройства на Arduino и ESPHome, развивая собственную систему умного дома. 
    Также люблю читать как художественную литературу (например, произведения Макса Фрая), 
    так и технические книги по программированию и архитектуре.
menus:
  main:
    name: "Хобби"
    identifier: "hobbies"
    weight: 4
build:
  list: always
  publishResources: false
---

{{< block name="hobbies" file="hobbies.yml" />}}