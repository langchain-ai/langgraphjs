import nextConfig from "eslint-config-next";

export default [
  ...nextConfig,
  {
    files: ["src/pages/api/**/*.ts", "src/pages/api/**/*.tsx"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
];
