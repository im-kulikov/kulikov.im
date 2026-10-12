import { join } from "node:path";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const BASE = "https://kulikov.im";
export const SITE = process.env.SITE_DIR || join(ROOT, "build", "test-site");
export const BUILD_LOG = join(ROOT, "build", "test-site.build.log");
export const STATS_COPY = join(ROOT, "build", "test-site.hugo_stats.json");
