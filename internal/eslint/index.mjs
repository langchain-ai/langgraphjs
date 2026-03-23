import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import noInstanceof from "eslint-plugin-no-instanceof";
import prettierConfig from "eslint-config-prettier";
import reactHooksPlugin from "eslint-plugin-react-hooks";

/**
 * Shared rules used across all packages.
 */
const sharedRules = {
  "no-instanceof/no-instanceof": 2,
  "@typescript-eslint/explicit-module-boundary-types": 0,
  "@typescript-eslint/no-empty-function": 0,
  "@typescript-eslint/no-shadow": 0,
  "@typescript-eslint/no-empty-interface": 0,
  "@typescript-eslint/no-empty-object-type": 0,
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-use-before-define": ["error", "nofunc"],
  "@typescript-eslint/no-unused-vars": ["warn", { args: "none" }],
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "arrow-body-style": 0,
  camelcase: 0,
  "class-methods-use-this": 0,
  "keyword-spacing": "error",
  "max-classes-per-file": 0,
  "max-len": 0,
  "no-await-in-loop": 0,
  "no-bitwise": 0,
  "no-console": 0,
  "no-empty-function": 0,
  "no-restricted-syntax": 0,
  "no-shadow": 0,
  "no-continue": 0,
  "no-void": 0,
  "no-underscore-dangle": 0,
  "no-use-before-define": 0,
  "no-useless-constructor": 0,
  "no-return-await": 0,
  "consistent-return": 0,
  "no-else-return": 0,
  "func-names": 0,
  "no-lonely-if": 0,
  "prefer-rest-params": 0,
  "prefer-const": [
    "error",
    { destructuring: "all", ignoreReadBeforeAssign: false },
  ],
  "new-cap": ["error", { properties: false, capIsNew: false }],
};

/**
 * Create an ESLint flat config for a LangGraph package.
 *
 * @param {object} [options]
 * @param {boolean} [options.react] - Enable react-hooks plugin and rules.
 * @param {string[]} [options.ignores] - Additional ignore patterns.
 * @param {string[]} [options.testFiles] - Additional test file patterns.
 */
export function createConfig({ react = false, ignores = [], testFiles = [] } = {}) {
  return [
    ...tsPlugin.configs["flat/recommended"],
    prettierConfig,
    {
      ignores: [
        "scripts/**",
        "vitest.config.ts",
        "node_modules/**",
        "dist/**",
        "dist-cjs/**",
        "**/*.js",
        "**/*.cjs",
        "**/*.d.ts",
        ...ignores,
      ],
    },
    {
      files: ["src/**/*.ts", "src/**/*.js", "src/**/*.jsx", "src/**/*.tsx"],
      plugins: {
        "no-instanceof": noInstanceof,
        ...(react && { "react-hooks": reactHooksPlugin }),
      },
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          ecmaVersion: 12,
          project: "./tsconfig.json",
          sourceType: "module",
        },
      },
      rules: {
        ...sharedRules,
        ...(react && {
          "react-hooks/rules-of-hooks": "error",
          "react-hooks/exhaustive-deps": "warn",
        }),
      },
    },
    {
      files: [
        "src/tests/**/*.ts",
        "src/**/tests/**/*.ts",
        "src/tests/**/*.tsx",
        ...testFiles,
      ],
      rules: {
        "no-instanceof/no-instanceof": 0,
        "@typescript-eslint/no-explicit-any": 0,
      },
    },
  ];
}

export default createConfig();
