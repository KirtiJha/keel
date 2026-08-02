/**
 * Recognise test commands and read failures out of their output.
 *
 * Gate 3 needs to know that a run happened and that something failed. It learns
 * this by watching the `Bash` calls a developer already makes — there is no
 * "record red" command to remember, because a step you have to remember is a
 * step an agent will skip.
 */

const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bvitest\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bplaywright\s+test\b/,
  /\bnode\s+--test\b/,
  /\bpytest\b/,
  /\bpython\s+-m\s+pytest\b/,
  /\bunittest\b/,
  /\bnpm\s+(?:run\s+)?test\b/,
  /\b(?:pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
  /\bmake\s+test\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
];

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERNS.some((re) => re.test(command));
}

export interface TestRunOutcome {
  /** Test files the output mentioned as failing. Repo-relative where possible. */
  readonly failingFiles: readonly string[];
  /** Test names the output named as failing. */
  readonly failingTests: readonly string[];
  /** True when anything failed. */
  readonly failed: boolean;
}

const FILE_LIKE = /(?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py)/;

/**
 * Parse runner output.
 *
 * Covers vitest, jest, mocha and pytest, which is what our stacks use. An
 * unrecognised format degrades to `failed` from the exit code with no named
 * files, and the caller then falls back to the test files touched this session.
 */
export function parseTestOutput(output: string, exitCode: number): TestRunOutcome {
  const failingFiles = new Set<string>();
  const failingTests = new Set<string>();

  for (const rawLine of output.split("\n")) {
    // Strip ANSI colour before matching.
    const line = rawLine.replace(/\[[0-9;]*m/g, "");

    // pytest: "FAILED tests/test_x.py::TestC::test_name - AssertionError"
    const pytest = /^\s*FAILED\s+(\S+?\.py)::([\w.:\[\]-]+)/.exec(line);
    if (pytest !== null) {
      if (pytest[1] !== undefined) failingFiles.add(pytest[1]);
      if (pytest[2] !== undefined) failingTests.add(pytest[2].split("::").pop() ?? pytest[2]);
      continue;
    }

    // pytest short summary: "tests/test_x.py::test_name FAILED"
    const pytestInline = /^\s*(\S+?\.py)::([\w.:\[\]-]+)\s+FAILED/.exec(line);
    if (pytestInline !== null) {
      if (pytestInline[1] !== undefined) failingFiles.add(pytestInline[1]);
      if (pytestInline[2] !== undefined) failingTests.add(pytestInline[2]);
      continue;
    }

    // vitest / jest file header: "FAIL  src/a.test.ts" or "FAIL src/a.test.ts > name"
    const failHeader = /^\s*(?:FAIL|✗|×|✕)\s+(.+)$/.exec(line);
    if (failHeader !== null) {
      const rest = failHeader[1] ?? "";
      const file = FILE_LIKE.exec(rest);
      if (file !== null) failingFiles.add(file[0]);
      // "src/a.test.ts > suite > test name"
      const named = rest.split(">").slice(1).join(">").trim();
      if (named !== "") failingTests.add(named);
      else if (file === null && rest.trim() !== "") failingTests.add(rest.trim());
      continue;
    }

    // jest verbose: "  ● suite › test name"
    const bullet = /^\s*●\s+(.+)$/.exec(line);
    if (bullet !== null) {
      const name = (bullet[1] ?? "").replace(/\s*›\s*/g, " > ").trim();
      if (name !== "" && !/^Console|^Test suite failed/i.test(name)) failingTests.add(name);
      continue;
    }
  }

  return {
    failingFiles: [...failingFiles],
    failingTests: [...failingTests],
    failed: exitCode !== 0 || failingFiles.size > 0 || failingTests.size > 0,
  };
}
