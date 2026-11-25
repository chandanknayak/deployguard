import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindConfig from "./tailwind.config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: tailwindConfig || path.resolve(__dirname, "tailwind.config.js") },
    autoprefixer: {},
  },
};