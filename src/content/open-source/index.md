---
title: Open Source и увлечения — GitHub, Go, DIY и книги
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
  class: open-source-page
  title: Open Source и увлечения
  icon: bookmark
section:
  title: Open Source и увлечения
  image: img/hobbies-01.png
  placeholder: true
  class: open-source
  eyebrow: Open Source
  description: |-
    Я увлекаюсь разработкой на Go, публикую проекты на GitHub и активно участвую в Open Source-сообществе. 
    В свободное время создаю DIY-устройства на Arduino и ESPHome, развивая собственную систему умного дома. 
    Также люблю читать как художественную литературу (например, произведения Макса Фрая), 
    так и технические книги по программированию и архитектуре.
menus:
  main:
    name: "Open Source и увлечения"
    identifier: "open-source"
    weight: 5
aliases:
  - /hobbies.html
build:
  list: always
  publishResources: false
---

{{< block name="hobbies" file="open-source.yml" />}}