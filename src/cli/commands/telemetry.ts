import { loadConfigOrDefaults } from "../../shared/config.js";
import { readSpool, trackDistribution } from "../../telemetry/spool.js";
import { archiveSpool, gateStats, shipToFile, tddStats } from "../../telemetry/ship.js";
import { fail, heading, info, line, ok, rows } from "../output.js";

/**
 * `keel telemetry <show|ship|clear>`.
 *
 * `ship` rolls the spool up into a local bundle, and that is the whole of it.
 * Local-only is the decision (docs/decisions.md §16), not a stage on the way to
 * a remote sink: the data exists to answer "which gates actually fire", and a
 * person reading `keel telemetry show` in their own repo answers that without
 * anyone's telemetry leaving their machine.
 */
export function telemetry(
  repoRoot: string,
  subcommand: string | null,
  destination: string | null,
): number {
  const { config } = loadConfigOrDefaults(repoRoot);
  const events = readSpool(repoRoot, config);

  switch (subcommand) {
    case "show":
    case null: {
      heading("Telemetry");
      rows([
        ["sink", config.telemetry.sink],
        ["path", config.telemetry.path],
        ["events", String(events.length)],
      ]);

      if (events.length === 0) {
        info("nothing recorded yet");
        line();
        return 0;
      }

      const distribution = trackDistribution(events);
      if (distribution.total > 0) {
        heading("Tracks");
        rows([
          ["quick", `${distribution.quick} (${(distribution.quickShare * 100).toFixed(0)}%)`],
          ["standard", String(distribution.standard)],
          ["full", String(distribution.full)],
        ]);
      }

      const gates = gateStats(events);
      if (gates.length > 0) {
        heading("Gates");
        rows(gates.map((g) => [g.pack, `${g.failures}/${g.runs}`]));
      }

      const tdd = tddStats(events);
      if (tdd.length > 0) {
        heading("TDD gates");
        rows(tdd.map((t) => [t.gate, `${t.trips} trips, ${t.overrides} overridden`]));
      }

      line();
      return 0;
    }

    case "ship": {
      heading("Ship");
      const result = shipToFile(repoRoot, config, destination ?? undefined);
      if (!result.ok) {
        fail(result.error);
        line();
        return 1;
      }

      ok(`wrote ${result.value.events} events to ${result.value.bundlePath}`);
      info("local only, by design — nothing is sent anywhere");
      line();
      return 0;
    }

    case "clear": {
      heading("Clear");
      const archived = archiveSpool(repoRoot, config);
      if (!archived.ok) {
        fail(archived.error);
        line();
        return 1;
      }
      ok(`archived ${archived.value} spool file${archived.value === 1 ? "" : "s"}`);
      line();
      return 0;
    }

    default:
      fail(`unknown subcommand \`${subcommand}\` — expected show, ship or clear`);
      return 1;
  }
}
