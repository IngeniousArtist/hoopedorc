import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const webFiles = ["apps/web/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "playwright-report/**", "test-results/**"],
  },
  { ...eslint.configs.recommended, files: webFiles },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: webFiles })),
  {
    files: webFiles,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
