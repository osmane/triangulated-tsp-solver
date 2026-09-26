(function (root, factory) {
    const api = factory(root);
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    "use strict";

    const KBDB_GEOMETRIC_REPAIR_EPSILON = 1e-9;

    function dependency(options, optionName, globalName) {
        const explicit = options[optionName];
        if (explicit !== undefined) {
            if (typeof explicit !== "function") throw new TypeError(`${optionName} must be a function`);
            return explicit;
        }
        const value = root?.[globalName];
        if (typeof value !== "function") throw new Error(`${globalName} is required`);
        return value;
    }

    function optimizeKbdbAndGeometricRepair(world, options = {}) {
        if (!world?.totalNoktaList?.length) throw new TypeError("A populated world is required");
        const optimizeKbdb = dependency(
            options,
            "kbdbOptimizer",
            "optimizeKoptAndBatchedBranchedDoubleBridge"
        );
        const optimizeRepair = dependency(
            options,
            "geometricRepairOptimizer",
            "optimizeGeometricRepair"
        );
        const now = options.nowFn || (() => typeof root.performance !== "undefined"
            ? root.performance.now() : Date.now());
        if (typeof now !== "function") throw new TypeError("nowFn must be a function");

        const startedAt = now();
        const rounds = [];
        let initialLength = null;
        let previousFinalLength = null;
        let totalKbdbImprovement = 0;
        let totalGeometricRepairImprovement = 0;

        while (true) {
            const kbdb = optimizeKbdb(world, options.kbdbOptions || {});
            if (!kbdb || !Number.isFinite(kbdb.initialLength) || !Number.isFinite(kbdb.finalLength)) {
                throw new Error("KBDB did not complete with finite route lengths");
            }
            if (previousFinalLength !== null && Math.abs(kbdb.initialLength - previousFinalLength) > 1e-6) {
                throw new Error("A restarted KBDB round did not begin from the previous repair tour");
            }
            if (initialLength === null) initialLength = kbdb.initialLength;

            // Her makro turda KBDB fresh ObjectOcc birakir ve Geometric Repair tam
            // bir kez calisir. Repair commit ederse bir sonraki adim yine KBDB'dir.
            const geometricRepair = optimizeRepair(world, options.geometricRepairOptions || {});
            if (!geometricRepair || typeof geometricRepair.reason !== "string") {
                throw new Error("Geometric Repair did not return a valid report");
            }

            const repairInitialLength = Number.isFinite(geometricRepair.initialLength)
                ? geometricRepair.initialLength
                : kbdb.finalLength;
            const roundFinalLength = Number.isFinite(geometricRepair.finalLength)
                ? geometricRepair.finalLength
                : kbdb.finalLength;
            if (Math.abs(repairInitialLength - kbdb.finalLength) > 1e-6) {
                throw new Error("KBDB and Geometric Repair route lengths do not meet at the stage boundary");
            }
            if (geometricRepair.committed === true
                && !(roundFinalLength < repairInitialLength - KBDB_GEOMETRIC_REPAIR_EPSILON)) {
                throw new Error("Committed Geometric Repair did not strictly shorten the route");
            }

            const status = geometricRepair.committed === true
                ? "GEOMETRIC_REPAIR_COMMITTED"
                : geometricRepair.reason === "NO_IMPROVEMENT"
                    ? "GEOMETRIC_REPAIR_NO_IMPROVEMENT"
                    : "GEOMETRIC_REPAIR_INCOMPLETE";
            const kbdbImprovement = kbdb.initialLength - kbdb.finalLength;
            const geometricRepairImprovement = repairInitialLength - roundFinalLength;
            totalKbdbImprovement += kbdbImprovement;
            totalGeometricRepairImprovement += geometricRepairImprovement;
            rounds.push(Object.freeze({
                roundIndex: rounds.length + 1,
                status,
                initialLength: kbdb.initialLength,
                afterKbdbLength: kbdb.finalLength,
                finalLength: roundFinalLength,
                kbdbImprovement,
                geometricRepairImprovement,
                visibilityInvalidatedByGeometricRepair:
                    geometricRepair.visibility?.invalidatedAfterCommit === true,
                kbdb,
                geometricRepair
            }));
            previousFinalLength = roundFinalLength;

            if (geometricRepair.committed === true) continue;

            const frozenRounds = Object.freeze(rounds.slice());
            const macroRestartCount = frozenRounds.filter(round =>
                round.status === "GEOMETRIC_REPAIR_COMMITTED").length;
            const contract = Object.freeze({
                macroRounds: frozenRounds.length,
                macroRestarts: macroRestartCount,
                kbdbCalls: frozenRounds.length,
                geometricRepairCalls: frozenRounds.length,
                geometricRepairCallsPerMacroRound: 1,
                geometricRepairSelfIterations: false,
                directObjectOccCalls: 0
            });
            return Object.freeze({
                status,
                completed: status === "GEOMETRIC_REPAIR_NO_IMPROVEMENT",
                distanceMetric: "EUCLIDEAN_RAW",
                initialLength,
                afterKbdbLength: kbdb.finalLength,
                finalLength: roundFinalLength,
                kbdbImprovement: totalKbdbImprovement,
                geometricRepairImprovement: totalGeometricRepairImprovement,
                totalImprovement: initialLength - roundFinalLength,
                geometricRepairReason: geometricRepair.reason,
                macroRoundCount: frozenRounds.length,
                macroRestartCount,
                elapsedMs: now() - startedAt,
                contract,
                rounds: frozenRounds,
                kbdb,
                geometricRepair
            });
        }
    }

    return {
        KBDB_GEOMETRIC_REPAIR_EPSILON,
        optimizeKbdbAndGeometricRepair
    };
});
