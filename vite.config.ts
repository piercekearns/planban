import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  server: {
    host: "127.0.0.1",
    port: 4318,
    strictPort: false,
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
