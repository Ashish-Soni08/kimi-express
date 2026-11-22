import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Built into app/dist, which the Kimi Express server (server/server.mjs) serves on :5177.
// `npm run dev` proxies the API to a running server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": "http://127.0.0.1:5177" } },
  build: { outDir: "dist", emptyOutDir: true },
});
