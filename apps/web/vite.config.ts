import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webPort = Number(process.env.HOOPEDORC_WEB_PORT ?? 5173);
const apiPort = Number(process.env.HOOPEDORC_API_PORT ?? 4317);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: process.env.HOOPEDORC_WEB_PORT !== undefined,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
});
