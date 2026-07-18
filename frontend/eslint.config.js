import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // The valuable classic checks (rules-of-hooks, exhaustive-deps) stay on.
      // These two newer react-hooks rules flag standard, correct patterns
      // (setState in a data-fetching effect; time-based values like Date.now()
      // read during render), so they are disabled to keep `lint` signal-rich.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
    },
  }
);
