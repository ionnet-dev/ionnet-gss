import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { getThemeScript } from "@ionnet/iontronic";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const PANEL = "http://localhost:3200";
const PORT = 5200;

/**
 * Inlines Iontronic's theme bootstrap in `<head>`, so a stored dark preference applies before first paint.
 */
function themeBoot(): Plugin {
  return {
    name: "gss-theme-boot",
    transformIndexHtml: () => [{ tag: "script", children: getThemeScript(), injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  plugins: [react(), themeBoot()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${root}src/` },
      { find: /^@shared\//, replacement: `${root}../shared/` },
    ],
  },
  server: {
    port: PORT,
    strictPort: true,
    // The panel (:3200) proxies page requests here; HMR connects to Vite directly.
    hmr: { clientPort: PORT },
    // Opening :5200 directly also works: API and sockets go to the panel.
    proxy: {
      "/api": PANEL,
      "/ws": { target: PANEL.replace("http", "ws"), ws: true },
    },
    fs: { allow: [root, `${root}../shared`] },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
