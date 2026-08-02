// @ts-check
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["node_modules/**", "scripts/**", "dist/**", "coverage/**", "tests/fixtures/**"],
  },
  {
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { project: false },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
      // Constraint 0.1: no placeholder markers anywhere in shipped source.
      "no-warning-comments": [
        "error",
        { terms: ["todo", "fixme", "xxx", "placeholder", "stub me"], location: "anywhere" },
      ],
    },
  },
  {
    // Fixtures deliberately contain violating code; tests assert on it.
    files: ["tests/**/*.ts"],
    rules: { "no-warning-comments": "off" },
  },
];
