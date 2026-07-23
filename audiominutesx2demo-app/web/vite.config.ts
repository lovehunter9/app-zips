import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy forwards /api to the local App Server so the SPA is same-origin.
// Local server runs on 8090 to avoid clashing with audiostudioxdemo (8080).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8090", changeOrigin: true, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
