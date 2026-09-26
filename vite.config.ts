import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": process.env.CODEX_CLOUD_DEV_API_ORIGIN || "http://127.0.0.1:8787",
    },
  },
});
