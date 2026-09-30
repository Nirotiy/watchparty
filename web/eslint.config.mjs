import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-approval-check/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated third-party Worker/WASM assets, rebuilt by prepare:jassub.
    "public/vendor/**",
  ]),
]);

export default eslintConfig;
