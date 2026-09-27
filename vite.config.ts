import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = process.env.CODEX_CLOUD_DEV_API_ORIGIN || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": apiOrigin,
      "/healthz": apiOrigin,
    },
  },
});
