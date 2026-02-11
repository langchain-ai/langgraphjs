module.exports = {
  extends: ["eslint:recommended"],
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "prettier"],
  rules: {
    "prettier/prettier": "error",
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
      },
    ],
    "no-undef": "off", // TypeScript handles this
    "no-redeclare": "off",
    "@typescript-eslint/no-redeclare": "error",
  },
  overrides: [
    {
      files: ["*.ts", "*.tsx"],
      rules: {},
    },
    {
      files: ["*.test.ts"],
      env: {
        jest: true,
      },
    },
  ],
  ignorePatterns: ["dist/", "node_modules/", "*.cjs", "*.js", "*.d.ts"],
};
