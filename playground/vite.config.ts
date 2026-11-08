import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser-only examples import the library's wallet entry straight from ../src, the one source
// of truth. One copy of the chain library in the page: the connector's.
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["@ckb-ccc/core", "react", "react-dom"] },
  server: { proxy: { "/api": "http://localhost:8080" }, fs: { allow: [".."] } },
});
