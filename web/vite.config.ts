import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = `http://localhost:${process.env.PORT ?? 8080}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": target,
      "/uploads": target,
      "/ws": { target, ws: true },
    },
  },
});
