import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// One copy of the chain library in the page: the connector's.
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["@ckb-ccc/core", "react", "react-dom"] },
  server: { proxy: { "/api": "http://localhost:8080" } },
});
