import path from "path";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Polyfill Node.js modules for AWS SDK in browser
      util: "util",
      stream: "stream-browserify",
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      // Define global for AWS SDK
      define: {
        global: "globalThis",
      },
    },
  },
});
