/* Exact point identity and both coordinate systems at pipeline boundaries. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PointSetContract = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function visit(meter) {
    if (meter) meter.pointVisits = (meter.pointVisits || 0) + 1;
  }

  function snapshot(points, phase, meter) {
    if (!Array.isArray(points)) throw new Error(`${phase}: point list is missing`);
    const byId = new Map();
    let hash = 2166136261;
    for (const point of points) {
      visit(meter);
      const id = point.id ?? point.sourcePointId;
      const metric = point.metricPosition || point;
      const display = point.loc || point;
      const coordinates = [metric.x, metric.y,
        display.displayX ?? display.x, display.displayY ?? display.y];
      if ((typeof id !== "number" && typeof id !== "string") || id === ""
          || (typeof id === "number" && !Number.isFinite(id))
          || coordinates.some(value => {
            if (meter) meter.coordinateChecks = (meter.coordinateChecks || 0) + 1;
            return !Number.isFinite(value);
          })) {
        throw new Error(`${phase}: invalid point identity or coordinates`);
      }
      if (byId.has(id)) throw new Error(`${phase}: duplicate point id ${id}`);
      byId.set(id, coordinates);
      const entry = JSON.stringify([id, ...coordinates]);
      for (let index = 0; index < entry.length; index++) {
        if (meter) meter.hashCharacterVisits = (meter.hashCharacterVisits || 0) + 1;
        hash = Math.imul(hash ^ entry.charCodeAt(index), 16777619);
      }
    }
    // A diagnostic order summary only; acceptance always uses the exact map.
    return { count: points.length, byId,
      summary: `${points.length}:${(hash >>> 0).toString(16)}` };
  }

  function assertSame(expected, points, phase, meter) {
    const actual = snapshot(points, phase, meter);
    if (actual.count !== expected.count) {
      throw new Error(`${phase}: lost or added points (${actual.count}/${expected.count})`);
    }
    for (const [id, coordinates] of expected.byId) {
      visit(meter);
      const other = actual.byId.get(id);
      if (!other || coordinates.some((value, index) => {
        if (meter) meter.coordinateComparisons = (meter.coordinateComparisons || 0) + 1;
        return !Object.is(value, other[index]);
      })) {
        throw new Error(`${phase}: point identity or coordinates changed at ${id}`);
      }
    }
    return actual;
  }

  function assertTourIds(expected, sourcePoints, ids, phase, meter) {
    if (!Array.isArray(ids)) throw new Error(`${phase}: tour is missing`);
    const source = new Map();
    for (const point of sourcePoints) {
      visit(meter);
      source.set(point.id ?? point.sourcePointId, point);
    }
    const tour = ids.map(id => {
      visit(meter);
      const point = source.get(id);
      if (!point) throw new Error(`${phase}: unknown point id ${id}`);
      return point;
    });
    assertSame(expected, tour, phase, meter);
    return tour;
  }

  // DBWC's metric-only tour deliberately drops display coordinates. Restore
  // those from the immutable input, after checking every returned metric point.
  function restoreMetricTour(expected, sourcePoints, metricTour, phase, meter) {
    if (!Array.isArray(metricTour)) throw new Error(`${phase}: tour is missing`);
    const source = new Map();
    for (const point of sourcePoints) {
      visit(meter);
      source.set(point.id ?? point.sourcePointId, point);
    }
    const restored = metricTour.map(point => {
      visit(meter);
      const original = source.get(point.id);
      if (!original) throw new Error(`${phase}: unknown point id ${point.id}`);
      const metric = original.metricPosition || original;
      if (point.x !== metric.x || point.y !== metric.y) {
        throw new Error(`${phase}: metric coordinates changed at ${point.id}`);
      }
      return original;
    });
    assertSame(expected, restored, phase, meter);
    return restored;
  }

  return { snapshot, assertSame, assertTourIds, restoreMetricTour };
});
