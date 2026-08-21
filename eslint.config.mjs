// @ts-check
import eslintJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/coverage/**", "**/dist/**", "**/node_modules/**"] },
  eslintJs.configs.recommended,
  tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      // The public API surface must stay deliberate; `any` hides contract
      // mistakes at the transport boundary where raw Yandex events arrive.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
