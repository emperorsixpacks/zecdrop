// Proves the architectural lint rules are actually switched on, by running
// ESLint itself on throwaway source text. If someone loosens eslint.config.js
// these fail, instead of the rule silently disappearing.

import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

const cwd = fileURLToPath(new URL("..", import.meta.url));
// The real project config, with only type information switched off: the
// snippets below are virtual files that the TS project service cannot see.
// The rule under test is untouched.
const eslint = new ESLint({
  cwd,
  overrideConfig: [tseslint.configs.disableTypeChecked],
});

async function lint(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: `${cwd}${filePath}` });
  return result?.messages ?? [];
}

const restricted = (messages: Awaited<ReturnType<typeof lint>>) =>
  messages.filter((m) => m.ruleId === "no-restricted-syntax");

describe("no import.meta outside src/lib/config.ts", () => {
  it("rejects import.meta.env in an ordinary module", async () => {
    const messages = await lint(
      "src/features/home/Leak.ts",
      "export const url = import.meta.env.VITE_API_URL;\n",
    );
    const hits = restricted(messages);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toMatch(/src\/lib\/config\.ts/);
  });

  it("rejects indirect access through a variable", async () => {
    const messages = await lint(
      "src/lib/other.ts",
      "const meta = import.meta;\nexport const e = meta.env;\n",
    );
    expect(restricted(messages)).toHaveLength(1);
  });

  it("rejects bracket access and import.meta.hot too", async () => {
    const messages = await lint(
      "src/components/Leak.tsx",
      'export const a = import.meta["env"];\nexport const b = import.meta.hot;\n',
    );
    expect(restricted(messages)).toHaveLength(2);
  });

  it("allows it in src/lib/config.ts", async () => {
    const messages = await lint(
      "src/lib/config.ts",
      "export const url = import.meta.env.VITE_API_URL;\n",
    );
    expect(restricted(messages)).toHaveLength(0);
  });
});
