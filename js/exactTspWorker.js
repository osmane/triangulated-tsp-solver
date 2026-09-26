"use strict";

// The UI owns the hard deadline and may terminate this worker even when a
// single exact-solver primitive has not reached its cooperative budget check.
importScripts("exact/exactTsp.js");

self.onmessage = event => {
    const message = event.data || {};
    if (message.type !== "run") return;
    try {
        if (!Array.isArray(message.points) || message.points.length < 3) {
            throw new Error("Exact TSP requires at least three points");
        }
        const result = solveExactTsp(message.points, {
            initialTour: message.seedTour,
            timeLimitMs: message.timeLimitMs,
            edgeElimination: true
        });
        self.postMessage({ type: "result", solution: result });
    } catch (error) {
        self.postMessage({ type: "error", message: error.message, stack: error.stack });
    }
};
