import eslint from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.open-next/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      "node_modules/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"]
  })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  ...nextVitals.map((config) => ({
    ...config,
    files: ["apps/web/**/*.{ts,tsx}"]
  })),
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: { "@next/next/no-html-link-for-pages": "off" }
  }
);
