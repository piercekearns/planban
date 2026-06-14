import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "src/site",
  server: {
    host: "127.0.0.1",
    port: 4320,
    strictPort: false,
  },
  build: {
    outDir: "../../dist/site",
    emptyOutDir: true,
  },
});
