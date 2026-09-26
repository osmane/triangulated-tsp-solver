"use strict";

// Keep the Worker core in step with its reported counters across browser caches.
const DBWC_CORE_SOURCES = ["dbwc/dbwcCore.js", "dbwc/dbwcCompletion.js",
  "dbwc/pointSetContract.js"];
const WORK_METER_SOURCES = ["vendor/acorn.js", "meter/workMeter.js"];
// Region reversal arms: 2-factor union + exact or bounded recombination.
const RR_SOURCES = ["exact/exactTsp.js", "dbwc/regionReversal.js"];
const RR_MODES = { "rr-time": "time", "rr-bounded": "bounded" };

const APP_RUNTIME = [
  "core/classes.js", "core/helper.js", "core/query.js", "core/create.js", "core/createHelper.js",
  "core/modify.js", "tsp/convexLayers.js", "exact/exactTsp.js", "core/worldBuilder.js",
  "core/objectOcclusion.js", "core/objectOccShared.js", "tsp/doubleBridge.js", "tsp/pocketAnalyzer.js",
  "core/visibilityPatch.js", "tsp/routeTransaction.js", "tsp/k_optHelper.js", "tsp/k_optShortestRoute.js",
  "tsp/doubleBridgeOptimizer.js", "tsp/geometricRepair.js", "tsp/iterativeRandomVisibilityRepair.js",
  "tsp/kbdbGeometricRepair.js", "tsp/fourOptRepair.js"
];

// Tam çağrı iş ölçümünde bu orkestrasyon fonksiyonları da modüllerle birlikte
// enstrümante edilir; önyükleme (yükleme, mesaj, ilerleme) ölçülmez.
const METERED_FUNCTIONS = ["totalPairs", "publicResult", "optimize", "runFast",
  "runQualityBaseline", "runQualityCore", "runQuality", "runRr", "rehearseTransfer"];

let coreLoaded = false;
let runtimeLoaded = false;
let rrLoaded = false;
let workRun = null;
self.requestAnimationFrame = () => 0;
self.drawWorld = () => {};
self.showCember = false;

function loadScripts(urls) {
  if (workRun) workRun.load(urls);
  else importScripts(...urls);
}

function loadCore() {
  if (coreLoaded) return;
  loadScripts(DBWC_CORE_SOURCES);
  coreLoaded = true;
}

function loadAppRuntime() {
  if (runtimeLoaded) return;
  const previous = workStage("worker.load");
  try {
    loadScripts(APP_RUNTIME);
  } finally {
    workStage(previous);
  }
  runtimeLoaded = true;
}

function loadRr() {
  if (rrLoaded) return;
  loadScripts(RR_SOURCES);
  rrLoaded = true;
}

function report(phase, detail = {}) {
  self.postMessage({ type: "progress", phase, ...detail });
}

// Zamana bağlı ilerleme bildirimi ölçülmez: kapanış ölçülmeyen önyüklemede kurulur,
// böylece aynı girdinin adım sayısı duvar saatine bağlı olmaz.
function progressReporter(phase, detail) {
  return progress => report(phase, { ...detail, ...progress });
}

// Ölçümsüz koşuda no-op; ölçümlü koşuda düz (iç içe olmayan) aşama değiştirir ve
// önceki aşamanın adını döndürür. Aşama adımları örtüşmez, toplamları tam çağrıdır.
function workStage(name) {
  return workRun && name ? workRun.meter.switchStage(name) : null;
}

function workSubStage(suffix) {
  return workRun ? workRun.meter.switchStage(`${workRun.meter.state.stage}${suffix}`) : null;
}

function workCounters() {
  const state = workRun ? workRun.meter.state : { calls: 0, loops: 0, native: 0 };
  return { calls: state.calls, loops: state.loops, native: state.native };
}

function readSource(url) {
  if (typeof self.dbwcReadSource === "function") return self.dbwcReadSource(url);
  const request = new XMLHttpRequest();
  request.open("GET", url, false);
  request.send();
  if (request.status !== 200 && request.status !== 0) throw new Error(`Cannot load ${url} (${request.status})`);
  return request.responseText;
}

function evaluateScript(code, name) {
  if (typeof self.dbwcEvaluateScript === "function") return self.dbwcEvaluateScript(code, name);
  const url = URL.createObjectURL(new Blob([`${code}\n//# sourceURL=${name}`],
    { type: "text/javascript" }));
  try {
    importScripts(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Ölçümlü koşu: bütün Worker modülleri ve orkestrasyon enstrümante yüklenir,
// tek yenilenmeyen adım bütçesi kurulur. Enstrümantasyonun kendi işi sayılmaz.
function startWorkRun(message) {
  if (!self.WorkMeter) importScripts(...WORK_METER_SOURCES);
  const meter = self.WorkMeter.createMeter({ limit: message.workBudget, stage: "worker.load" });
  meter.installGlobals(self);
  const instrumented = { files: 0, functions: 0, loops: 0, nativeSites: 0 };
  let instrumentMs = 0;
  const load = (source, name, prefix = "") => {
    meter.pause();
    const started = performance.now();
    let code;
    try {
      const output = self.WorkMeter.instrument(source, { acorn: self.acorn });
      if (output.unhandled.length) throw new Error(`Unmetered construct in ${name}`);
      code = prefix + output.code;
      instrumented.files++;
      instrumented.functions += output.stats.functions;
      instrumented.loops += output.stats.loops;
      instrumented.nativeSites += output.stats.spreads + output.stats.objectSpreads
        + output.stats.iterables + output.stats.allocations + output.stats.callbacks
        + output.stats.applies + output.stats.rests;
    } finally {
      instrumentMs += performance.now() - started;
      meter.resume();
    }
    evaluateScript(code, name);
  };
  workRun = {
    meter, instrumented, uninstallNatives: null,
    get instrumentMs() { return instrumentMs; },
    load(urls) {
      for (const url of urls) {
        meter.pause();
        let source;
        try { source = readSource(url); } finally { meter.resume(); }
        load(source, url);
      }
    }
  };
  // Orkestrasyon fonksiyonları kendi kaynağından çıkarılıp ölçülen kopyalarla değiştirilir.
  meter.pause();
  let own;
  try {
    const ownSource = readSource(self.location.href);
    own = self.WorkMeter.extractFunctions(ownSource, METERED_FUNCTIONS, { acorn: self.acorn });
  } finally { meter.resume(); }
  workRun.uninstallNatives = meter.installNatives(self);
  load(own, "dbwcWorker.metered.js", "\"use strict\";\n");
  loadCore();
  return workRun;
}

function finishWorkRun() {
  if (!workRun) return null;
  if (workRun.uninstallNatives) {
    workRun.uninstallNatives();
    workRun.uninstallNatives = null;
  }
  return { ...workRun.meter.snapshot(), scope: "worker", complete: true,
    instrumented: { ...workRun.instrumented }, instrumentMs: workRun.instrumentMs };
}

function totalPairs(result) {
  return result.stats.reduce((sum, stage) => sum + stage.pairs + stage.patchPairs, 0);
}

function publicResult(result) {
  return {
    status: result.status,
    moves: result.moves,
    initialLength: result.initialLength,
    finalLength: result.finalLength,
    elapsedMs: result.elapsedMs,
    delaunayMs: result.delaunayMs,
    work: result.work,
    workByType: result.workByType,
    preparationWork: result.preparationWork,
    pairs: totalPairs(result),
    stats: result.stats,
    log: result.log,
    simple: result.simple
  };
}

function optimize(points, stages, deadline, maxWork, phase, extra = {}, detail = {}) {
  return DBWC.optimizeDBWC(points, {
    stages,
    deadline,
    maxWork,
    chunk: 64,
    logLimit: 30,
    maxPoolRecords: 16384,
    ...extra,
    onProgress: progressReporter(phase, detail)
  });
}

function runFast(message, started, source, meter) {
  const deadline = started + message.timeLimitMs;
  const n = message.points.length;
  workStage("fast.preparation");
  const preparationStarted = performance.now();
  const preparationWork = { hilbert: {}, hilbertValidation: {},
    outputDisplayValidation: {}, selectedLength: {}, initialLength: {} };
  const hilbert = DBWC.hilbertOrder(message.points, preparationWork.hilbert);
  const hilbertSimple = DBWC.isSimpleTour(hilbert, preparationWork.hilbertValidation);
  const initial = hilbertSimple ? hilbert : message.points;
  const preparationMs = performance.now() - preparationStarted;
  const searchWorkLimit = Math.max(1000000, n * 320000);
  report("fast-warm", { pointCount: n });
  workStage("fast.warm");
  const warm = optimize(initial, DBWC.WARM_STAGES, deadline,
    Math.min(searchWorkLimit, Math.max(1000000, n * 80000)), "fast-warm");
  const remainingWork = Math.max(0, searchWorkLimit - warm.work);
  report("fast-dbwc", { pointCount: n, warmMoves: warm.moves });
  workStage("fast.dbwc");
  const dbwc = remainingWork > 0
    ? optimize(warm.tour, DBWC.V1F_STAGES, deadline, remainingWork, "fast-dbwc")
    : { tour: warm.tour, status: "WORK_LIMIT", moves: 0,
      initialLength: warm.finalLength, finalLength: warm.finalLength,
      elapsedMs: 0, delaunayMs: 0, work: 0, workByType: {},
      stats: [], log: [], simple: warm.simple };
  let selected = dbwc;
  let fallback = null;
  workStage("fast.validation");
  if (!selected.simple) {
    const candidates = [
      { name: "warm", result: warm },
      {
        name: "input",
        result: {
          tour: message.points,
          finalLength: DBWC.tourLength(message.points,
            preparationWork.fallbackLength = {}),
          simple: DBWC.isSimpleTour(message.points,
            preparationWork.fallbackSimplicity = {})
        }
      }
    ].filter(candidate => candidate.result.simple)
      .sort((a, b) => a.result.finalLength - b.result.finalLength);
    if (!candidates.length) throw new Error("Time-limited DBWC did not produce a simple fallback tour");
    selected = candidates[0].result;
    fallback = candidates[0].name;
  }
  const validationStarted = performance.now();
  const selectedFullTour = PointSetContract.restoreMetricTour(source, message.points,
    selected.tour, "fast result", meter);
  if (!Number.isFinite(selected.finalLength)
      || Math.abs(DBWC.tourLength(selectedFullTour, preparationWork.selectedLength)
        - selected.finalLength) > 1e-6) {
    throw new Error("Fast result metric length mismatch");
  }
  if (!DBWC.isSimpleTour(selectedFullTour.map(point => ({ x: point.displayX, y: point.displayY })),
      preparationWork.outputDisplayValidation)) {
    throw new Error("Fast result crosses in display coordinates");
  }
  const validationMs = performance.now() - validationStarted;
  workStage("fast.output");
  return {
    mode: "fast",
    tourIds: selectedFullTour.map(point => point.id),
    initialLength: DBWC.tourLength(initial, preparationWork.initialLength),
    finalLength: selected.finalLength,
    elapsedMs: performance.now() - started,
    simple: selected.simple,
    seedFallback: hilbertSimple ? null : "input",
    fallback,
    identity: { input: source.summary,
      output: PointSetContract.snapshot(selectedFullTour, "fast output", meter).summary },
    warm: publicResult(warm),
    dbwc: publicResult(dbwc),
    timings: { preparationMs, warmMs: warm.elapsedMs, warmDelaunayMs: warm.delaunayMs,
      dbwcMs: dbwc.elapsedMs, dbwcDelaunayMs: dbwc.delaunayMs, validationMs },
    workAccounting: { warm: warm.work, dbwc: dbwc.work,
      searchLimit: searchWorkLimit, searchUsed: warm.work + dbwc.work,
      contractPointVisits: meter.pointVisits,
      contractHashCharacterVisits: meter.hashCharacterVisits,
      contractCoordinateChecks: meter.coordinateChecks,
      contractCoordinateComparisons: meter.coordinateComparisons,
      preparationWork: { ...preparationWork, warm: warm.preparationWork,
        dbwc: dbwc.preparationWork },
      complete: false, unmetered: ["native sort/set and array work",
        "remaining Delaunay and candidate internals", "remaining validation internals",
        "UI capture and transfer", "world mesh build"] }
  };
}

function runQualityBaseline(points, source, timings, meter, stagePrefix = "quality") {
  const outerStage = workStage(`${stagePrefix}.worldBuild`);
  const validationWork = timings.validationWork || (timings.validationWork = {});
  const input = points.map(point => ({
    loc: { x: point.displayX, y: point.displayY },
    metricPosition: { x: point.x, y: point.y },
    isXmlPoint: true,
    polyNo: 0,
    sourcePointId: point.id,
    isJoinable: true
  }));
  const buildStarted = performance.now();
  const worldBuildWork = timings.worldBuildWork || (timings.worldBuildWork = {});
  self.world = buildWorldFromCollectedPoints(input, worldBuildWork);
  timings.worldBuildMs = (timings.worldBuildMs || 0) + performance.now() - buildStarted;
  try {
    PointSetContract.assertSame(source, collectRoutePoints(self.world).map(point => ({
      id: point.sourcePointId, x: point.metricPosition.x, y: point.metricPosition.y,
      displayX: point.x, displayY: point.y
    })), "quality world build", meter);
  } catch (error) {
    // World ekran koordinatında kurulur. Orada kendini kesen girdi sırası türemiş kesişim
    // noktası doğurur ve kimlik o noktaya yazılır; sözleşme hatası bunun yalnız sonucudur.
    const crossings = self.world.totalNoktaList.filter(nokta => nokta && nokta.turemis).length;
    if (crossings > 0) {
      throw new Error(`quality world build: input tour crosses itself in display coordinates `
        + `(${crossings} self-intersection points); start from a tour simple in both metric and display coordinates`);
    }
    throw error;
  }
  self.world.pocketTreeOverlay = null;
  self.world.objectOccMode = "shared";
  workStage(`${stagePrefix}.baseline`);
  const baselineStarted = performance.now();
  const baseline = optimizeKbdbGrFourOpt(self.world, {
    baselineOptions: { kbdbOptions: { bridgeOptions: { log: false } } },
    fourOptOptions: { extension: true }
  });
  const baselineMs = performance.now() - baselineStarted;
  workStage(`${stagePrefix}.baselineValidation`);
  timings.baselineMs = (timings.baselineMs || 0) + baselineMs;
  // These are distinct units from DBWC.search work. Aggregate each completed
  // baseline call, including a conditional completion call, without overlap.
  const baselineWork = timings.baselineWork || (timings.baselineWork = {
    kbdbRounds: 0, koptSegmentEvaluations: 0,
    bridgeFirstEdgeVisits: 0, bridgeSecondEdgeVisits: 0,
    bridgeCandidateChecks: 0, bridgeArcWalkSteps: 0,
    bridgeReconnections: 0, bridgeWorldCaptureObjects: 0,
    geometricRepairWork: 0, fourOptChainProbes: 0,
    fourOptValidations: 0, fourOptBridgeProbes: 0, fourOptDeepProbes: 0
  });
  for (const macro of baseline.rounds || []) {
    for (const round of macro.baseline?.rounds || []) {
      baselineWork.kbdbRounds += round.kbdb?.rounds?.length || 0;
      for (const kbdbRound of round.kbdb?.rounds || []) {
        const bridge = kbdbRound.bridge?.stats || {};
        baselineWork.koptSegmentEvaluations += kbdbRound.kopt?.segmentEvalCount || 0;
        baselineWork.bridgeFirstEdgeVisits += (bridge.firstBridgeEdgesVisited || 0)
          + (bridge.firstCounterEdgesVisited || 0);
        baselineWork.bridgeSecondEdgeVisits += (bridge.secondWalkEdgesVisited || 0)
          + (bridge.secondTargetEdgesVisited || 0);
        baselineWork.bridgeCandidateChecks += bridge.candidatesExamined || 0;
        baselineWork.bridgeArcWalkSteps += bridge.arcWalkSteps || 0;
        baselineWork.bridgeReconnections += bridge.generalizedReconnectionsEnumerated || 0;
        baselineWork.bridgeWorldCaptureObjects += bridge.worldCaptureObjectCount || 0;
      }
      baselineWork.geometricRepairWork += round.geometricRepair?.counters?.totalWorkCount || 0;
    }
    const counters = macro.fourOpt?.counters || {};
    baselineWork.fourOptChainProbes += counters.chainProbes || 0;
    baselineWork.fourOptValidations += counters.validationCount || 0;
    baselineWork.fourOptBridgeProbes += counters.extension?.bridgeProbes || 0;
    baselineWork.fourOptDeepProbes += counters.extension?.deepProbes || 0;
  }
  PointSetContract.assertSame(source, collectRoutePoints(self.world).map(point => ({
    id: point.sourcePointId, x: point.metricPosition.x, y: point.metricPosition.y,
    displayX: point.x, displayY: point.y
  })), "quality baseline world", meter);
  const order = tourOrderFromBags(self.world.totalNoktaList[4], self.world);
  const byId = new Map(points.map(point => [point.id, point]));
  const tour = order.map(index => {
    const id = self.world.totalNoktaList[index].sourcePointId;
    const point = byId.get(id);
    if (!point) throw new Error(`Baseline returned unknown point id ${id}`);
    return point;
  });
  PointSetContract.assertSame(source, tour, "quality baseline tour", meter);
  if (!Number.isFinite(baseline.finalLength)
      || Math.abs(DBWC.tourLength(tour, validationWork.baselineLength ||
        (validationWork.baselineLength = {})) - baseline.finalLength) > 1e-6) {
    throw new Error("Quality baseline metric length mismatch");
  }
  const tourIds = tour.map(point => point.id);
  workStage(outerStage);
  return {
    tour, tourIds,
    baseline: {
      status: baseline.status,
      completed: baseline.completed,
      initialLength: baseline.initialLength,
      finalLength: baseline.finalLength,
      elapsedMs: baselineMs,
      macroRoundCount: baseline.macroRoundCount,
      fourOptCommitCount: baseline.fourOptCommitCount,
      extensionCommits: baseline.extensionCommits
    }
  };
}

// Kalite hatti: temel akis B -> V4 -> kosullu kapanis.
function runQualityCore(message, deadline, source, timings, meter) {
  report("quality-baseline", { pointCount: message.points.length });
  const baseline = runQualityBaseline(message.points, source, timings, meter);
  if (performance.now() >= deadline) throw new Error("Quality time limit during baseline; live tour preserved");
  report("quality-dbwc", { pointCount: message.points.length, baselineStatus: baseline.baseline.status });
  workStage("quality.dbwc");
  const dbwc = optimize(baseline.tour, DBWC.V4_STAGES, deadline,
    Math.max(3000000, message.points.length * 600000), "quality-dbwc");
  PointSetContract.restoreMetricTour(source, message.points, dbwc.tour, "quality DBWC tour", meter);
  workStage("quality.completion");
  const completed = DBWCCompletion.complete(dbwc, message.points, {
    deadline, runBaseline: ordered => runQualityBaseline(ordered, source, timings, meter,
      "quality.completion"),
    onStart() { report("quality-completion", { pointCount: message.points.length }); }
  });
  const completedTour = PointSetContract.restoreMetricTour(source, message.points,
    completed.tour, "quality completion tour", meter);
  const validationWork = timings.validationWork || (timings.validationWork = {});
  if (!Number.isFinite(completed.finalLength)
      || Math.abs(DBWC.tourLength(completedTour, validationWork.completionLength ||
        (validationWork.completionLength = {})) - completed.finalLength) > 1e-6) {
    throw new Error("Quality result metric length mismatch");
  }
  return { baseline, dbwc, completed: { ...completed, tour: completedTour } };
}

function runQuality(message, started, source, meter) {
  const timings = {};
  const preparationWork = { outputMetricValidation: {}, outputDisplayValidation: {} };
  const loadStarted = performance.now();
  loadAppRuntime();
  timings.runtimeLoadMs = performance.now() - loadStarted;
  workStage("quality.setup");
  timings.objectOccMs = 0;
  timings.objectOccCalls = 0;
  const objectOccWork = { diagnosticCalls: 0, lookAtAttempts: 0,
    triangleSteps: 0, intersectionPredicates: 0, coneSteps: 0,
    sharedQueries: 0, reverseIndexEntries: 0, portalEntries: 0,
    seedEntries: 0, vertexChecks: 0, visibleOutputEntries: 0,
    frameQueries: 0, unresolvedQueries: 0, pathEntries: 0,
    endpointQueries: 0, endpointTriangleSteps: 0, lazyRaySets: 0,
    loadedRaySets: 0, loadedTriangleSets: 0, reverseNodeVisits: 0 };
  const originalObjectOcc = self.objectOcc;
  if (typeof originalObjectOcc === "function") {
    self.objectOcc = function (...args) {
      const outerStage = workSubStage(".objectOcc");
      const begun = performance.now();
      const target = args[0] || self.world;
      const diagnosed = target && typeof self.startObjectOccDiagnostics === "function"
        && typeof self.stopObjectOccDiagnostics === "function";
      if (diagnosed) self.startObjectOccDiagnostics(target);
      try { return originalObjectOcc.apply(this, args); }
      finally {
        if (diagnosed) {
          const diagnostic = self.stopObjectOccDiagnostics(target);
          const totals = diagnostic.totals;
          objectOccWork.diagnosticCalls += totals.callCount;
          objectOccWork.lookAtAttempts += totals.lookAtAttemptCount || 0;
          objectOccWork.triangleSteps += totals.triangleStepCount || 0;
          objectOccWork.intersectionPredicates += totals.intersectionPredicateCount || 0;
          for (const call of diagnostic.calls) {
            const shared = call.shared || {};
            objectOccWork.coneSteps += shared.coneSteps || 0;
            objectOccWork.sharedQueries += shared.sharedQueries || 0;
            objectOccWork.reverseIndexEntries += shared.reverseIndexEntries || 0;
            objectOccWork.portalEntries += shared.portals || 0;
            objectOccWork.seedEntries += shared.seeds || 0;
            objectOccWork.vertexChecks += shared.vertexChecks || 0;
            objectOccWork.visibleOutputEntries += shared.output || 0;
            objectOccWork.frameQueries += shared.frameQueries || 0;
            objectOccWork.unresolvedQueries += shared.unresolvedQueries || 0;
            objectOccWork.pathEntries += shared.pathEntries || 0;
            objectOccWork.endpointQueries += shared.endpointQueries || 0;
            objectOccWork.endpointTriangleSteps += shared.endpointTriangleSteps || 0;
            objectOccWork.lazyRaySets += shared.lazyRaySets || 0;
            objectOccWork.loadedRaySets += shared.loadedRaySets || 0;
            objectOccWork.loadedTriangleSets += shared.loadedTriangleSets || 0;
            objectOccWork.reverseNodeVisits += shared.reverseNodeVisits || 0;
          }
        }
        timings.objectOccMs += performance.now() - begun;
        timings.objectOccCalls++;
        workStage(outerStage);
      }
    };
  }
  const deadline = started + message.timeLimitMs;
  let core;
  try {
    core = runQualityCore(message, deadline, source, timings, meter);
  } finally {
    // Tanısal sarmalayıcı yalnız bu çağrıya aittir; aktarım provası sayfadaki
    // gibi sarılmamış ObjectOcc ile koşar.
    if (typeof originalObjectOcc === "function") self.objectOcc = originalObjectOcc;
  }
  const { baseline, dbwc, completed } = core;
  workStage("quality.validation");
  const validationStarted = performance.now();
  if (!DBWC.isSimpleTour(completed.tour, preparationWork.outputMetricValidation)
      || !DBWC.isSimpleTour(completed.tour.map(point => ({ x: point.displayX, y: point.displayY })),
        preparationWork.outputDisplayValidation)) {
    throw new Error("Quality result crosses in metric or display coordinates");
  }
  timings.validationMs = performance.now() - validationStarted;
  timings.dbwcMs = dbwc.elapsedMs;
  timings.dbwcDelaunayMs = dbwc.delaunayMs;
  timings.completionMs = completed.report.elapsedMs;
  workStage("quality.output");
  return {
    mode: "quality", tourIds: completed.tour.map(point => point.id),
    initialLength: DBWC.tourLength(message.points,
      timings.validationWork.inputLength = {}), finalLength: completed.finalLength,
    elapsedMs: performance.now() - started,
    simple: DBWC.isSimpleTour(completed.tour,
      preparationWork.resultSimplicity = {}),
    baseline: baseline.baseline, dbwc: publicResult(dbwc), completion: completed.report,
    identity: { input: source.summary,
      output: PointSetContract.snapshot(completed.tour, "quality output", meter).summary },
    timings,
    workAccounting: { dbwc: dbwc.work, contractPointVisits: meter.pointVisits,
      contractHashCharacterVisits: meter.hashCharacterVisits,
      contractCoordinateChecks: meter.coordinateChecks,
      contractCoordinateComparisons: meter.coordinateComparisons,
      preparationWork: { ...preparationWork, dbwc: dbwc.preparationWork },
      baselineWork: timings.baselineWork,
      objectOccWork,
      worldBuildWork: timings.worldBuildWork,
      validationWork: timings.validationWork,
      complete: false, unmetered: ["world mesh internals", "quality baseline internals",
        "ObjectOcc internals", "native sort/set and array work",
        "remaining Delaunay and candidate internals", "remaining validation internals",
        "UI capture and transfer"] }
  };
}

// Region reversal: girdi canlı turdur (DBWC Kalite gibi). "time" kolu U içinde exactTsp dal-sınırı,
// "bounded" kolu U aday grafıyla DBWC.search (toplam iş C·n^1.7). Sonuç Q'dan uzun olamaz; kabul yine
// kimlik sözleşmesi, metrik uzunluk ve iki koordinatta basitlikle doğrulanır.
function runRr(message, started, source, meter) {
  const variant = RR_MODES[message.mode];
  if (!variant) throw new Error(`Unknown alan tersleme mode ${message.mode}`);
  const stage = `rr.${variant}`;
  const n = message.points.length;
  workStage(`${stage}.load`);
  const loadStarted = performance.now();
  loadRr();
  const loadMs = performance.now() - loadStarted;
  workStage(`${stage}.input`);
  const validationWork = { inputMetric: {}, outputMetric: {}, outputDisplay: {},
    inputLength: {}, outputLength: {} };
  if (!DBWC.isSimpleTour(message.points, validationWork.inputMetric)) {
    throw new Error("Region reversal input is not a simple tour in metric coordinates; build a simple tour first (e.g. DBWC Quality)");
  }
  report(`rr-${variant}`, { pointCount: n });
  workStage(`${stage}.search`);
  const rr = RegionReversal.optimize(message.points, {
    mode: variant, deadline: started + message.timeLimitMs, now: () => performance.now(),
    onProgress: progressReporter(`rr-${variant}`, { pointCount: n })
  });
  workStage(`${stage}.validation`);
  const validationStarted = performance.now();
  const tour = PointSetContract.restoreMetricTour(source, message.points, rr.tour,
    "alan tersleme result", meter);
  const finalLength = DBWC.tourLength(tour, validationWork.outputLength);
  if (!Number.isFinite(rr.finalLength) || Math.abs(finalLength - rr.finalLength) > 1e-6) {
    throw new Error("Region reversal result metric length mismatch");
  }
  if (!DBWC.isSimpleTour(tour, validationWork.outputMetric)
      || !DBWC.isSimpleTour(tour.map(point => ({ x: point.displayX, y: point.displayY })),
        validationWork.outputDisplay)) {
    throw new Error("Region reversal result crosses in metric or display coordinates");
  }
  const validationMs = performance.now() - validationStarted;
  workStage(`${stage}.output`);
  return {
    mode: message.mode, tourIds: tour.map(point => point.id),
    initialLength: DBWC.tourLength(message.points, validationWork.inputLength), finalLength,
    elapsedMs: performance.now() - started, simple: true,
    identity: { input: source.summary,
      output: PointSetContract.snapshot(tour, "alan tersleme output", meter).summary },
    rr: { status: rr.status, improved: rr.improved, union: rr.union, settings: rr.settings,
      work: rr.work, exact: rr.exact || null, moves: rr.moves ?? null, log: rr.log || [],
      elapsedMs: rr.elapsedMs, timings: rr.timings },
    timings: { loadMs, unionMs: rr.timings.unionMs, recombineMs: rr.timings.recombineMs, validationMs },
    workAccounting: { contractPointVisits: meter.pointVisits,
      contractHashCharacterVisits: meter.hashCharacterVisits,
      contractCoordinateChecks: meter.coordinateChecks,
      contractCoordinateComparisons: meter.coordinateComparisons,
      rrWork: rr.work, validationWork,
      complete: false, unmetered: ["2-factor flow internals beyond heap/arc counters",
        "exact branch-and-bound internals", "native sort/set and array work", "UI capture and transfer"] }
  };
}

// Ölçümlü koşuda UI'nin sonuç için kuracağı world burada aynı kayıtlar ve aynı
// kodla prova edilir. UI kendi world kurmasını bu adım sayısıyla sayar ve kurduğu
// world'ün özetini provanınkiyle karşılaştırır; eşleşmezse sonuç uygulanmaz.
function rehearseTransfer(message, result) {
  const recordCount = result.tourIds.length;
  if (!(recordCount <= message.worldRebuildLimit)) return { skipped: true, recordCount, buildSteps: 0 };
  loadAppRuntime();
  workStage("transfer.rehearsal");
  const byId = new Map(message.points.map(point => [point.id, point]));
  const records = dbwcWorldRecords(result.tourIds.map(id => byId.get(id)));
  const before = workCounters();
  const world = buildWorldFromCollectedPoints(records);
  const after = workCounters();
  const build = { calls: after.calls - before.calls, loops: after.loops - before.loops,
    native: after.native - before.native };
  return { skipped: false, recordCount, buildSteps: build.calls + build.loops + build.native,
    build, digest: worldTransferDigest(world) };
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type !== "run") return;
  try {
    const started = performance.now();
    if (!Array.isArray(message.points) || message.points.length < 3) {
      throw new Error("At least three points are required");
    }
    if (!Number.isFinite(message.timeLimitMs) || message.timeLimitMs <= 0) {
      throw new Error("Invalid remaining time budget");
    }
    if (message.workMeter) {
      const budget = message.workBudget ?? null;
      if (budget !== null && !(Number.isFinite(budget) && budget >= 0)) {
        throw new Error("Invalid whole-call work budget");
      }
      startWorkRun({ workBudget: budget });
    } else {
      loadCore();
    }
    workStage("worker.input");
    if (workRun) workRun.meter.charge(message.points.length, "message.receive");
    const meter = { pointVisits: 0 };
    const source = PointSetContract.snapshot(message.points, "worker input", meter);
    const result = message.mode === "quality" ? runQuality(message, started, source, meter)
      : String(message.mode || "").startsWith("rr-") ? runRr(message, started, source, meter)
        : runFast(message, started, source, meter);
    if (workRun && message.transferRehearsal) result.transferRehearsal = rehearseTransfer(message, result);
    workStage("worker.output");
    if (workRun) workRun.meter.charge(result.tourIds.length, "message.send");
    // The mode result is assembled before its final identity snapshot; report
    // the full Worker interval, including that snapshot and result assembly.
    result.elapsedMs = performance.now() - started;
    if (performance.now() >= started + message.timeLimitMs) {
      throw new Error("DBWC whole-call time budget reached; live tour preserved");
    }
    if (workRun) {
      const whole = finishWorkRun();
      result.workAccounting = { ...result.workAccounting, complete: true, unmetered: [], whole };
    }
    self.postMessage({ type: "result", result });
  } catch (error) {
    const whole = finishWorkRun();
    const exhausted = !!(whole && whole.exhausted);
    self.postMessage({
      type: "error",
      message: exhausted
        ? `Whole-call work budget ran out in the Worker's ${whole.stage} stage (${whole.total} / ${whole.limit} steps); live tour kept`
        : error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : null,
      workBudgetExceeded: exhausted,
      work: whole
    });
  }
};
