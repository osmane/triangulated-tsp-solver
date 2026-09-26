# Triangulated TSP Solver

An experimental solver and visualizer for the Euclidean Traveling Salesman Problem (TSP) that runs entirely in the browser.
You load or generate a set of points, draw a starting tour, and then improve it with tour-improvement moves:
k-opt, double bridge, geometric repair, 4-opt, DBWC and Region Reversal. Small instances can also be solved exactly with
**Exact TSP**.

This is a research prototype. Apart from Exact TSP, no method is guaranteed to find the optimal tour.

**Live demo:** https://osmane.github.io/triangulated-tsp-solver/

![A 150-point tour drawn over the triangle mesh](screenshot.png)

## How it works

The points are inserted into a custom triangle mesh. It is not a Delaunay triangulation. When a move needs to know
which points can be connected without crossing the tour, the solver does not test the new edge against every tour edge.
It walks through the mesh from triangle to triangle and finds which points are visible from each other. Moves only use
connections found this way, which removes most of the segment-intersection tests. **DBWC** (Delaunay Balanced Window Chain)
works on the tour directly with Delaunay candidate edges. **DBWC Quality** starts from the result of the mesh-based moves.
DBWC, Region Reversal and Exact TSP run in a Web Worker, so the page stays responsive while they search.

## Usage

1. Pick an instance from **Example**, paste points as XML into **XML Coordinates**, or tick
   **Generate Random Vertices** and set **Count**.
2. Click **Draw Raw Route**. This builds the mesh and draws the starting tour. Picking an example does this step for you.
3. Click **DBWC Quality** (or another improvement button). The report at the bottom of the left panel shows the tour
   length and details of the run.

The first line of the report gives the tour length in two ways. *screen* is the length on the canvas. A tiny fixed jitter
is added to every point there for numerical robustness. *metric* is the length on the X/Y values you entered.
If the XML has `MetricX`/`MetricY`, the length in those coordinates is shown as well.

### Input format

```xml
<Points>
  <P X="300" Y="200" />
  <P X="500" Y="300" />
  <P X="700" Y="220" />
  <P X="680" Y="600" />
  <P X="500" Y="480" />
  <P X="320" Y="560" />
</Points>
```

| Attribute | Meaning |
|---|---|
| `X`, `Y` | Required. Position in canvas pixels. The canvas is 1501 × 851; keep the points inside it. The origin is the top-left corner and Y grows downward. |
| `NoktaNo` | Optional. A unique integer ID for the point ("nokta no" is Turkish for "point number"). Give it on every point or on none; without it the points are numbered 1, 2, 3, … in file order. **Copy Points** writes it out. |
| `PolyNo` | Optional. Defaults to `0`; keep it `0` for a TSP tour. |
| `MetricX`, `MetricY` | Optional. Original coordinates, for example from a TSPLIB file. Only used for the extra length shown in the report. |

A `<P>` element whose `X` or `Y` is missing or not a number is skipped, and the report says how many were skipped.
Tour-improvement moves need at least 4 points; with 3 points the tour is already optimal.

The order of the `<P>` elements is the starting tour. Random points are ordered by their angle around the center of the
point set.

### Closed tour, no self-intersections

The TSP solvers work only on a closed tour that does not cross itself. Two tours do not qualify:

- **A self-intersecting tour** (a polygon whose edges cross each other). The solvers do not work on it. Load or draw a
  tour whose edges do not cross.
- **An open tour.** If you draw the tour by hand (click on the canvas with **Connect Points** off), each click adds a
  point and connects it to the previous one. The tour is not complete until the last point is connected back to the
  first one: finish by clicking on the first point again.

If you run a solver on such a tour, an alert explains the problem and the solver does not start. **Exact TSP** and
**DBWC Fast** with XML or random input are the exception: they only use the points and build their own tour.

**Copy Points** copies the current points to the clipboard as XML. **Paste Points** pastes XML from the clipboard into
the text box.

### Examples

The **Example** list loads an XML file from [examples/](examples/) into the text box and draws its route.

- **TSPLIB:** berlin52, pr76, tsp225, pcb442 and pr1002, each in two versions. *start* is a starting tour ordered by
  angle around the center of the point set. *optimal* is an optimal tour. Load *start*, run **DBWC Quality**, then load
  *optimal* to compare. The coordinates are scaled to the canvas; `MetricX`/`MetricY` hold the original TSPLIB coordinates.
- **Random:** uniform and clustered point sets without `MetricX`/`MetricY`, in angular order.

The tours look different from the same instances drawn by other plotting or math tools, because the scale and the
coordinate system are different. Each instance is scaled to fit the 1501 × 851 canvas (the aspect ratio is kept). The
canvas uses screen coordinates: the origin is at the top-left corner and Y grows downward. Most plotting tools put Y
upward, so a tour here appears mirrored top to bottom compared with those plots. Lengths on the canvas are in pixels;
the `MetricX`/`MetricY` length in the report is in the original TSPLIB units.

The number in an *optimal* entry is the optimal length published in TSPLIB. TSPLIB rounds every edge length to the
nearest integer, so the unrounded `MetricX`/`MetricY` length in the report can be slightly different.

## Controls

The left panel is split into sections. **Input**, **Main Flow** and **Object Occlusion** are open by default; the others
start collapsed. Click a section title to open or close it. The browser remembers which sections you left open.
The report appears below the sections and grows downward; scroll the page to read a long report.

### Input

| Control | What it does |
|---|---|
| Example | Loads an example point set into the text box and draws its route (see [Examples](#examples)). |
| Generate Random Vertices / Count | Generates this many random points instead of reading the XML. |
| XML Coordinates | The points as XML (see [Input format](#input-format)). |
| Draw Raw Route | Builds the mesh and draws the starting tour. |
| Copy Points / Paste Points | Copies the current points to the clipboard as XML, or pastes XML from the clipboard into the text box. |

### Pipeline Steps

The individual steps of the mesh-based pipeline that **DBWC Quality** runs before its DBWC search. They can be run one
by one on the current tour.

| Button | What it does |
|---|---|
| K-opt Start | K-opt improvement on the mesh. |
| Branched Double Bridge | Double-bridge moves, searched in branches. |
| K-opt + Branched Double Bridge | The two above in sequence. Also called KBDB. |
| Geometric Repair | Repairs the tour using the visibility data left by KBDB. On a fresh raw route it does nothing. |
| Iterative Random Visibility Repair | Exchanges of up to 6 edges between visible points, tried in random order. Stops after about 130 s at most. |
| KBDB + Geometric Repair | KBDB followed by Geometric Repair. |
| KBDB + GR + 4opt | Adds sequential 4-opt moves with a limited search depth. |
| KBDB + GR + 4opt + bridge/deep | When 4-opt stops improving, tries a bridge move and a deeper move chain. |

### Main Flow

| Control | What it does |
|---|---|
| DBWC Fast | Hilbert-curve starting tour, Lin–Kernighan-style moves on Delaunay candidate edges, then a quick DBWC search. No mesh is built; the result is drawn as a light preview. |
| DBWC Quality | The full KBDB + GR + 4-opt pipeline, then the DBWC search. Slower, shorter tours. |
| DBWC time limit (s) | Time limit for DBWC and Region Reversal runs (default 120 s). |
| Full work metering *(slow)* | Counts every step of a DBWC run in a single unit and reports the total. The code is instrumented before it runs, so the run is much slower. |
| Work budget | Stops a metered run after this many million steps. Empty means no limit. |
| Stop DBWC | Cancels a running DBWC or Region Reversal search. |

The settings and **Stop DBWC** also apply to the Experimental Flows.

**Running time of DBWC Quality (the green button).** In our tests the running time of DBWC Quality grew polynomially,
at about n^1.9 in the number of points n, and it reached the optimal tour or came close to it. For example, it finds the
optimal tour of berlin52 in under 10 seconds. The n^1.9 is a measured growth rate on our test instances, not a proven
bound. DBWC Quality is a heuristic, so it does not guarantee the optimal tour.

### Experimental Flows

| Button | What it does |
|---|---|
| Region Reversal: time-budgeted / bounded | Tries to shorten the current tour by reversing tour segments inside a region. Run DBWC Quality first. The time-budgeted version solves exactly inside a small candidate graph. The bounded version limits its total work to 5000·n^1.7 steps. |

### Exact Solver

| Button | What it does |
|---|---|
| Exact TSP (optimal tour) | Exact solver for small instances: Held-Karp dynamic programming for very small sets, otherwise 1-tree branch-and-bound. Its running time grows exponentially with the number of points. It stops after 300 s. |
| Stop Exact TSP | Cancels a running Exact TSP search. |

### Editor

| Control | What it does |
|---|---|
| Connect Points | Changes what a click on the canvas does. Off: the click adds a point and connects it to the previous one; a click on the first point closes the tour. On: the click connects the selected point. |
| Disconnect Selected Point | Disconnects the selected point (see **Selected point** below). |
| Swap Adjacent Blocks | One pass that swaps two neighbouring blocks of up to 4 points each. It applies the best swap it finds. |
| Paired Chain Repair *(slow)* | A deeper repair move built from the visibility data. It can take minutes even for about 75 points. |
| Convex Layers / Merge Layers | Builds a tour a different way: splits the points into nested convex hulls, then merges them into one tour. |

### Object Occlusion

| Control | What it does |
|---|---|
| Find Visible (Object Occlusion) | Computes which points are visible from each other in the mesh. |
| Selected point | Index of the point whose connections are drawn. A click on the canvas also sets it. The matching XML `NoktaNo` is shown next to it. |
| View Occlusion Points | Draws the visibility rays of the selected point instead of its connectable points. |

### Inspector

Shows the mouse position on the canvas and details of the mesh triangle under the cursor.

## Running locally

Web Workers need a web server, so opening `index.html` directly from disk (`file://`) does not work.
From the project folder run one of these:

```sh
npx serve .
```

```sh
python -m http.server 8000
```

Then open `http://localhost:3000` (serve) or `http://localhost:8000` (Python).

## Browser requirements

A current desktop browser with Web Worker support. Development and testing were done in Google Chrome.
Instances with thousands of points can take several minutes. Use the DBWC time limit to cap DBWC runs.

## License

Free for non-commercial use, including research and education. Commercial use is not permitted.
The full terms are in [LICENSE](LICENSE) (PolyForm Noncommercial License 1.0.0).

Copyright (c) 2026 Osman ERTAŞ

## Third-party

[Acorn](https://github.com/acornjs/acorn) (`js/vendor/acorn.js`), MIT License, see
[js/vendor/ACORN-LICENSE](js/vendor/ACORN-LICENSE). Only **Full work metering** uses it.

The TSPLIB instances in [examples/](examples/) (berlin52, pr76, tsp225, pcb442, pr1002) come from
[TSPLIB](http://comopt.ifi.uni-heidelberg.de/software/TSPLIB95/) by Gerhard Reinelt: G. Reinelt, "TSPLIB — A Traveling
Salesman Problem Library", *ORSA Journal on Computing* 3(4), 376–384, 1991. They are not covered by the license above.
