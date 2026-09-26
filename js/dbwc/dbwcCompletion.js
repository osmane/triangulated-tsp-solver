/* Shared browser/Node completion policy. No reference tours or case-specific rules. */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./dbwcCore") : root.DBWC);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DBWCCompletion = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (DBWC) {
  "use strict";

  function complete(dbwc, sourcePoints, options) {
    const now = options.now || (() => performance.now());
    const limited = ["WORK_LIMIT", "TIME_LIMIT", "MOVE_LIMIT"].includes(dbwc.status)
      || dbwc.stats.some(stage => stage.budgetStarts > 0 || stage.patchBudgetStarts > 0);
    const report = {
      requested: dbwc.moves > 0 && limited,
      attempted: false, applied: false, reason: "NOT_REQUIRED", elapsedMs: 0,
      initialLength: dbwc.finalLength, finalLength: dbwc.finalLength,
      // Any DBWC move makes the earlier baseline result stale, even if DBWC finishes.
      baselineStale: dbwc.moves > 0
    };
    const unchanged = () => ({ tour: dbwc.tour, finalLength: dbwc.finalLength, report });
    if (!report.requested) return unchanged();
    if (dbwc.status === "TIME_LIMIT" || now() >= options.deadline) {
      report.reason = "TIME_LIMIT";
      return unchanged();
    }
    const byId = new Map(sourcePoints.map(point => [point.id, point]));
    const validate = ids => {
      if (ids.length !== byId.size || new Set(ids).size !== byId.size) throw new Error("Completion lost point identities");
      const ordered = ids.map(id => byId.get(id));
      if (ordered.some(p => !p)) throw new Error("Completion returned an unknown point");
      if (!DBWC.isSimpleTour(ordered)) throw new Error("Completion crosses in metric coordinates");
      if (!DBWC.isSimpleTour(ordered.map(p => ({ x: p.displayX ?? p.x, y: p.displayY ?? p.y })))) {
        throw new Error("Completion crosses in display coordinates");
      }
      return ordered;
    };
    const started = now();
    try {
      const input = validate(dbwc.tour.map(p => p.id));
      report.attempted = true;
      options.onStart?.();
      const result = options.runBaseline(input, options.deadline);
      // Synchronous baseline shares the outer Worker deadline; never accept an overrun.
      if (now() >= options.deadline) {
        report.reason = "TIME_LIMIT";
        return unchanged();
      }
      const tour = validate(result.tourIds);
      const length = DBWC.tourLength(tour);
      if (!Number.isFinite(result.baseline.finalLength) || Math.abs(length - result.baseline.finalLength) > 1e-6) {
        throw new Error("Completion length mismatch");
      }
      if (length > dbwc.finalLength + 1e-7) throw new Error("Completion length regressed");
      report.baseline = result.baseline;
      report.baselineStale = !result.baseline.completed;
      report.finalLength = length;
      report.applied = length < dbwc.finalLength - 1e-7;
      report.reason = report.applied ? "IMPROVED" : result.baseline.completed ? "NO_IMPROVEMENT" : "BASELINE_INCOMPLETE";
      return report.applied ? { tour, finalLength: length, report } : unchanged();
    } catch (error) {
      report.reason = "REJECTED";
      report.error = error.message;
      return unchanged();
    } finally {
      report.elapsedMs = now() - started;
    }
  }

  return { complete };
});
