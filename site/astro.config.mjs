import { defineConfig } from "astro/config";

// GitHub Pages serves a project site under /<repo>/. Both values come from the
// build environment so the same source works on Pages, on a custom domain and
// on a laptop.
export default defineConfig({
  site: process.env.PUBLIC_SITE ?? "https://example.github.io",
  base: process.env.PUBLIC_BASE ?? "/",
  trailingSlash: "ignore",
  build: { format: "file" },
});
