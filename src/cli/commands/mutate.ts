import { loadConfigOrDefaults } from "../../shared/config.js";
import { runMutation, type MutationReport } from "../../mutation/runner.js";
import { record } from "../../telemetry/spool.js";
import { bold, detail, dim, fail, heading, info, line, ok, rows, warn } from "../output.js";

/**
 * `keel mutate` — diff-only mutation testing, gated on score.
 *
 * Rule of the road 4: mutation score, never coverage. Coverage targets produce
 * tests that execute code without checking anything; a surviving mutant is
 * direct evidence of exactly that.
 */

export interface MutateOptions {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  readonly against: string | null;
  readonly json: boolean;
  /** Report without failing. For establishing a baseline before ratcheting. */
  readonly report: boolean;
}

function renderSurvivors(report: MutationReport): void {
  const survivors = report.results.filter((r) => r.outcome === "survived");
  if (survivors.length === 0) return;

  heading("Survivors");
  line(
    `  ${dim("Each line below can be broken without any test noticing.")}`,
  );
  line();

  for (const { mutant } of survivors) {
    line(`  ${bold(`${mutant.file}:${mutant.line}`)}  ${dim(mutant.operator)}`);
    detail(`${mutant.original}  →  ${mutant.replacement}`);
  }
}

export async function mutate(options: MutateOptions): Promise<number> {
  const { config } = loadConfigOrDefaults(options.repoRoot);

  if (!config.mutation.enabled) {
    heading("Mutation testing");
    info("disabled in keel.config.yaml (`mutation.enabled: false`)");
    line();
    return 0;
  }

  if (!options.json) {
    heading("Mutation testing");
    info("diff-only: mutants are confined to the lines this change touched");
  }

  const report = await runMutation({
    root: options.repoRoot,
    pluginRoot: options.pluginRoot,
    config,
    against: options.against,
    ...(options.json
      ? {}
      : {
          onProgress: (done, total, result) => {
            const mark =
              result.outcome === "killed" ? "✓" : result.outcome === "survived" ? "✗" : "!";
            process.stdout.write(
              `\r  ${mark} ${done}/${total}  ${result.mutant.file}:${result.mutant.line}`.padEnd(78),
            );
          },
        }),
  });

  if (!options.json) process.stdout.write("\r".padEnd(80) + "\r");

  // Score and counts only — no source, no mutant text.
  record(options.repoRoot, config, {
    kind: "mutation",
    score: Math.round(report.score * 1000) / 1000,
    killed: report.killed,
    survived: report.survived,
    total: report.total,
    passed: report.passed || options.report,
    duration_ms: report.durationMs,
  });

  if (options.json) {
    line(
      JSON.stringify({
        score: report.score,
        minScore: report.minScore,
        killed: report.killed,
        survived: report.survived,
        errored: report.errored,
        total: report.total,
        passed: report.passed,
        durationMs: report.durationMs,
        ...(report.note === undefined ? {} : { note: report.note }),
        survivors: report.results
          .filter((r) => r.outcome === "survived")
          .map((r) => ({
            file: r.mutant.file,
            line: r.mutant.line,
            operator: r.mutant.operator,
          })),
      }),
    );
    return report.passed || options.report ? 0 : 1;
  }

  if (report.total === 0) {
    info(report.note ?? "nothing to mutate");
    line();
    // A change with no mutable logic passes. Docs and config are not untested.
    return report.passed ? 0 : 1;
  }

  heading("Result");
  rows([
    ["command", report.testCommand],
    ["mutants", String(report.total)],
    ["killed", String(report.killed)],
    ["survived", String(report.survived)],
    ...(report.errored > 0 ? ([["errored", String(report.errored)]] as const) : []),
    ["score", `${(report.score * 100).toFixed(1)}%`],
    ["floor", `${(report.minScore * 100).toFixed(0)}%`],
    ["took", `${(report.durationMs / 1000).toFixed(1)}s`],
  ]);

  renderSurvivors(report);

  heading("Summary");
  if (report.note !== undefined && report.total === 0) {
    info(report.note);
    line();
    return 0;
  }

  if (report.passed) {
    ok(`mutation score ${(report.score * 100).toFixed(1)}% is at or above the ${(report.minScore * 100).toFixed(0)}% floor`);
    line();
    return 0;
  }

  if (options.report) {
    warn(
      `mutation score ${(report.score * 100).toFixed(1)}% is below the ${(report.minScore * 100).toFixed(0)}% floor (reporting only)`,
    );
    line();
    return 0;
  }

  fail(`mutation score ${(report.score * 100).toFixed(1)}% is below the ${(report.minScore * 100).toFixed(0)}% floor`);
  detail("each survivor above is a changed line no test constrains — assert on the behaviour, do not add coverage");
  line();
  return 1;
}
