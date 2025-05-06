---
title: "Услуги — проектирование и архитектура, инженерная культура, выстраивание процессов"
keywords:
  - услуги
  - архитектура
  - CI/CD
  - инженерная культура
  - запуск MVP
  - аудит
  - системный подход
  - разработка сервисов
description: |
  Помогаю командам запускать и масштабировать сервисы: архитектура, аудит, процессы, культура, кризисные задачи. 
  Быстрый старт и системный подход.
section:
  class: section pt-14 services
  title: Чем могу помочь?
  image: /img/services-01.png
  description: |
    Проектирование устойчивых и масштабируемых сервисов, архитектурный аудит, 
    внедрение инженерной культуры, CI/CD и DDD. Помогаю командам запускать MVP, 
    выстраивать процессы и решать кризисные технические задачи.
menus:
  main:
    name: Услуги
    identifier: "services"
    weight: 2
common:
  class: services-page
  title: "Услуги"
  icon: "bookmark"
build:
  list: always
  publishResources: false
  render: always
---

{{< block name="services" file="services.yml" />}}
