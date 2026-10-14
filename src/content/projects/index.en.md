---
title: Projects — platforms, microservices, CRM, audit
keywords:
  - portfolio
  - completed projects
  - case studies
  - microservices
  - platform solutions
  - technical audit
  - Go / Golang
  - Open Source
description: |
  Completed projects: platform and microservice systems, CRM and e-commerce,
  technical audit, Open Source. The role, task and outcome of each project.
common:
  class: projects-page
  title: Projects
  icon: bookmark
section:
  class: projects
  eyebrow: Projects
  title: What have I done so far?
  image: img/projects-hero.webp
  description: |
    Selected projects: from CMS and CRM to platform systems and technical audit.
menus:
  main:
    name: Projects
    identifier: "projects"
    weight: 2
build:
  list: always
  publishResources: false
  render: always
---

{{< block name="projects" file="projects.yml" />}}
