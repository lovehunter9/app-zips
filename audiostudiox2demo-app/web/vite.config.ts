import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy forwards /api to the local App Server so the SPA is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
