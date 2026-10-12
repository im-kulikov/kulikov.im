---
title: Проекты — платформы, микросервисы, CRM, аудит
keywords:
  - портфолио
  - реализованные проекты
  - кейсы
  - микросервисы
  - платформенные решения
  - технический аудит
  - Go / Golang
  - Open Source
description: |
  Реализованные проекты: платформенные и микросервисные системы, CRM и e-commerce,
  технический аудит, Open Source. Роль, задача и результат по каждому проекту.
common:
  class: projects-page
  title: Проекты
  icon: bookmark
section:
  class: projects
  eyebrow: Проекты
  title: Что я уже сделал?
  image: img/projects-hero.webp
  description: |
    Избранные проекты: от CMS и CRM до платформенных систем и технического аудита.
menus:
  main:
    name: Проекты
    identifier: "projects"
    weight: 2
build:
  list: always
  publishResources: false
  render: always
---

{{< block name="projects" file="projects.yml" />}}
