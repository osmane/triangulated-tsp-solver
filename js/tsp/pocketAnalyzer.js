(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    Object.assign(root, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function canonicalRouteEdgeKey(a, b) {
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    function buildCurrentMeshEdgeClasses(world, outside) {
        const masks = new Map();
        world.totalUcgenList.forEach((triangle, triangleId) => {
            if (triangle.disabled) return;
            const sideMask = outside.has(triangleId) ? 1 : 2;
            for (const edge of triangle.kenarList) {
                const key = canonicalRouteEdgeKey(edge.uc1NoktaNo, edge.uc2NoktaNo);
                masks.set(key, (masks.get(key) || 0) | sideMask);
            }
        });
        const classes = new Map();
        for (const [key, mask] of masks) {
            classes.set(key, mask === 1 ? "exterior" : mask === 2 ? "interior" : "boundary");
        }
        return classes;
    }

    function canCross(edge) {
        return edge && !edge.disKenar && Number.isInteger(edge.komsuNo) && edge.komsuNo >= 0;
    }

    function markOutsideTriangles(world) {
        const triangles = world?.totalUcgenList;
        if (!Array.isArray(triangles)) throw new TypeError("world.totalUcgenList is required");
        const outside = new Set();
        const queue = [];
        triangles.forEach((triangle, triangleId) => {
            if (triangle?.disabled) return;
            if (triangle.kenarList.some(edge => edge.komsuNo < 0 && !edge.disKenar)) {
                outside.add(triangleId);
                queue.push(triangleId);
            }
        });
        for (let head = 0; head < queue.length; head++) {
            const triangleId = queue[head];
            for (const edge of triangles[triangleId].kenarList) {
                if (!canCross(edge) || outside.has(edge.komsuNo) || triangles[edge.komsuNo]?.disabled) continue;
                outside.add(edge.komsuNo);
                queue.push(edge.komsuNo);
            }
        }
        return outside;
    }

    function buildOutsideDual(world, outside = markOutsideTriangles(world)) {
        const adjacency = Array.from({ length: world.totalUcgenList.length }, () => null);
        for (const triangleId of outside) adjacency[triangleId] = new Set();
        let edgeCount = 0;
        for (const triangleId of outside) {
            for (const edge of world.totalUcgenList[triangleId].kenarList) {
                if (!canCross(edge) || !outside.has(edge.komsuNo)) continue;
                adjacency[triangleId].add(edge.komsuNo);
                if (triangleId < edge.komsuNo) edgeCount++;
            }
        }
        return { adjacency, nodes: new Set(outside), edgeCount };
    }

    function peelToTwoCore(dual) {
        const degree = new Int32Array(dual.adjacency.length);
        const removed = new Uint8Array(dual.adjacency.length);
        const queue = [];
        for (const node of dual.nodes) {
            degree[node] = dual.adjacency[node].size;
            if (degree[node] < 2) queue.push(node);
        }
        const peelOrder = [];
        for (let head = 0; head < queue.length; head++) {
            const node = queue[head];
            if (removed[node]) continue;
            removed[node] = 1;
            peelOrder.push(node);
            for (const neighbor of dual.adjacency[node]) {
                if (!removed[neighbor] && --degree[neighbor] < 2) queue.push(neighbor);
            }
        }
        const core = new Set([...dual.nodes].filter(node => !removed[node]));
        return { core, degree, removed, peelOrder };
    }

    function sharedEdge(world, a, b) {
        return world.totalUcgenList[a].kenarList.find(edge => edge.komsuNo === b) || null;
    }

    function buildPocketForest(world, dual, coreResult) {
        const count = world.totalUcgenList.length;
        const pocketId = new Int32Array(count).fill(-1);
        const parentTri = new Int32Array(count).fill(-1);
        const depth = new Int32Array(count).fill(-1);
        const rootCoreTri = new Int32Array(count).fill(-1);
        const discoveryEpoch = new Int32Array(count).fill(-1);
        const pockets = [];
        let epoch = 0;

        for (const coreTriangle of coreResult.core) {
            depth[coreTriangle] = 0;
            rootCoreTri[coreTriangle] = coreTriangle;
            for (const rootTriangle of dual.adjacency[coreTriangle]) {
                if (coreResult.core.has(rootTriangle) || pocketId[rootTriangle] !== -1) continue;
                const id = pockets.length;
                const queue = [rootTriangle];
                const triangles = [];
                let maxDepth = 0;
                pocketId[rootTriangle] = id;
                parentTri[rootTriangle] = coreTriangle;
                depth[rootTriangle] = 1;
                rootCoreTri[rootTriangle] = coreTriangle;
                discoveryEpoch[rootTriangle] = epoch++;

                for (let head = 0; head < queue.length; head++) {
                    const node = queue[head];
                    triangles.push(node);
                    maxDepth = Math.max(maxDepth, depth[node]);
                    for (const neighbor of dual.adjacency[node]) {
                        if (coreResult.core.has(neighbor) || pocketId[neighbor] !== -1) continue;
                        pocketId[neighbor] = id;
                        parentTri[neighbor] = node;
                        depth[neighbor] = depth[node] + 1;
                        rootCoreTri[neighbor] = coreTriangle;
                        discoveryEpoch[neighbor] = epoch++;
                        queue.push(neighbor);
                    }
                }
                pockets.push({
                    id,
                    rootCoreTriangleId: coreTriangle,
                    rootTriangleId: rootTriangle,
                    mouthEdge: sharedEdge(world, rootTriangle, coreTriangle),
                    triangles,
                    size: triangles.length,
                    maxDepth
                });
            }
        }
        return { pockets, pocketId, parentTri, depth, rootCoreTri, discoveryEpoch };
    }

    function isTriangleAncestor(context, ancestorId, triangleId) {
        if (!Number.isInteger(ancestorId) || !Number.isInteger(triangleId)) return false;
        const tin = context.tin;
        const tout = context.tout;
        return tin[ancestorId] >= 0
            && tin[ancestorId] <= tin[triangleId]
            && tout[triangleId] <= tout[ancestorId];
    }

    function isTriangleInLeafForbiddenCorridor(context, leafRecord, triangleId) {
        if (!leafRecord || context.forest.pocketId[triangleId] !== leafRecord.treeId) return false;
        if (!isTriangleAncestor(context, triangleId, leafRecord.triangleId)) return false;
        const triangleDepth = context.forest.depth[triangleId];
        const anchorDepth = context.forest.depth[leafRecord.exitAnchorTriangleId];
        return leafRecord.firstBranchPointTriangleId >= 0
            ? triangleDepth > anchorDepth
            : triangleDepth >= anchorDepth;
    }

    function regionContainsTriangle(context, regionId, triangleId) {
        const region = context.regions.get(regionId);
        if (!region || !Number.isInteger(triangleId)) return false;
        return context.forest.pocketId[triangleId] === region.treeId
            && isTriangleAncestor(context, region.entryTriangleId, triangleId);
    }

    function regionContainsRegion(context, outerRegionId, innerRegionId) {
        const inner = context.regions.get(innerRegionId);
        return !!inner && regionContainsTriangle(context, outerRegionId, inner.entryTriangleId);
    }

    function buildChildren(forest) {
        const childrenByTriangle = Array.from({ length: forest.parentTri.length }, () => []);
        for (let triangleId = 0; triangleId < forest.parentTri.length; triangleId++) {
            const parentId = forest.parentTri[triangleId];
            if (parentId < 0 || forest.depth[triangleId] < 1) continue;
            childrenByTriangle[parentId].push(triangleId);
        }
        childrenByTriangle.forEach(children => children.sort((a, b) => a - b));
        return childrenByTriangle;
    }

    function buildRegions(forest, childrenByTriangle) {
        const exactRegionByTriangle = Array(forest.parentTri.length).fill(null);
        const tin = new Int32Array(forest.parentTri.length).fill(-1);
        const tout = new Int32Array(forest.parentTri.length).fill(-1);
        const regions = new Map();
        let clock = 0;

        const visit = (triangleId, regionId) => {
            exactRegionByTriangle[triangleId] = regionId;
            tin[triangleId] = clock++;
            const children = childrenByTriangle[triangleId];
            for (const childId of children) {
                let childRegionId = regionId;
                if (children.length >= 2) {
                    childRegionId = `branch:${triangleId}:${childId}`;
                    regions.set(childRegionId, {
                        id: childRegionId,
                        kind: "branch",
                        treeId: forest.pocketId[triangleId],
                        entryTriangleId: childId,
                        exitAnchorTriangleId: triangleId,
                        parentRegionId: regionId
                    });
                }
                visit(childId, childRegionId);
            }
            tout[triangleId] = clock - 1;
        };

        const orderedPockets = forest.pockets.slice()
            .sort((left, right) => left.rootTriangleId - right.rootTriangleId || left.id - right.id);
        for (const pocket of orderedPockets) {
            const regionId = `root:${pocket.id}`;
            pocket.rootRegionId = regionId;
            regions.set(regionId, {
                id: regionId,
                kind: "root",
                treeId: pocket.id,
                entryTriangleId: pocket.rootTriangleId,
                exitAnchorTriangleId: pocket.rootTriangleId,
                parentRegionId: null
            });
            visit(pocket.rootTriangleId, regionId);
        }
        return { exactRegionByTriangle, tin, tout, regions, orderedPockets };
    }

    function buildRouteSideIndex(world, order, forest, exactRegionByTriangle) {
        if (!Array.isArray(order) || order.length < 4) throw new TypeError("A current route order is required");
        const routeEdges = [];
        const routeEdgeByKey = new Map();
        const pointRouteEdges = Array.from({ length: world.totalNoktaList.length }, () => []);
        for (let index = 0; index < order.length; index++) {
            const from = order[index];
            const to = order[(index + 1) % order.length];
            const record = {
                index,
                from,
                to,
                key: canonicalRouteEdgeKey(from, to),
                ownerTriangleId: -1,
                treeId: -1,
                regionId: null,
                runId: -1,
                runOffset: -1
            };
            routeEdges.push(record);
            routeEdgeByKey.set(record.key, record);
            pointRouteEdges[from].push(record);
            pointRouteEdges[to].push(record);
        }
        pointRouteEdges.forEach(records => records.sort((a, b) => a.index - b.index));

        for (const pocket of forest.pockets) {
            for (const triangleId of pocket.triangles) {
                for (const edge of world.totalUcgenList[triangleId].kenarList) {
                    if (!edge.disKenar) continue;
                    const record = routeEdgeByKey.get(canonicalRouteEdgeKey(edge.uc1NoktaNo, edge.uc2NoktaNo));
                    if (!record) continue;
                    if (record.ownerTriangleId >= 0 && record.ownerTriangleId !== triangleId) {
                        throw new Error(`Route edge ${record.key} has multiple outside-tree owners`);
                    }
                    record.ownerTriangleId = triangleId;
                    record.treeId = pocket.id;
                    record.regionId = exactRegionByTriangle[triangleId];
                }
            }
        }
        return { routeEdges, routeEdgeByKey, pointRouteEdges };
    }

    function regionRelation(regions, selectedRegionId, adjacentRegionId) {
        if (!adjacentRegionId) return "core";
        if (adjacentRegionId === selectedRegionId) return "same";
        let cursor = regions.get(selectedRegionId)?.parentRegionId || null;
        while (cursor) {
            if (cursor === adjacentRegionId) return "parent";
            cursor = regions.get(cursor)?.parentRegionId || null;
        }
        cursor = regions.get(adjacentRegionId)?.parentRegionId || null;
        while (cursor) {
            if (cursor === selectedRegionId) return "child";
            cursor = regions.get(cursor)?.parentRegionId || null;
        }
        return regions.get(adjacentRegionId)?.treeId === regions.get(selectedRegionId)?.treeId
            ? "sibling"
            : "other-tree";
    }

    function buildRegionRuns(routeEdges, regions) {
        const count = routeEdges.length;
        const runs = [];
        const treewardWalks = new Map();
        if (count === 0) return { runs, treewardWalks };
        let start = 0;
        for (let index = 0; index < count; index++) {
            const previous = (index - 1 + count) % count;
            if (routeEdges[index].regionId !== routeEdges[previous].regionId) {
                start = index;
                break;
            }
        }

        let consumed = 0;
        while (consumed < count) {
            const firstIndex = (start + consumed) % count;
            const regionId = routeEdges[firstIndex].regionId;
            const edgeIndices = [];
            while (consumed < count) {
                const edgeIndex = (start + consumed) % count;
                if (routeEdges[edgeIndex].regionId !== regionId && edgeIndices.length) break;
                edgeIndices.push(edgeIndex);
                consumed++;
                if (consumed === count) break;
            }
            const beforeIndex = (edgeIndices[0] - 1 + count) % count;
            const afterIndex = (edgeIndices[edgeIndices.length - 1] + 1) % count;
            const run = {
                id: runs.length,
                regionId,
                edgeIndices,
                beforeRegionId: edgeIndices.length === count ? regionId : routeEdges[beforeIndex].regionId,
                afterRegionId: edgeIndices.length === count ? regionId : routeEdges[afterIndex].regionId
            };
            run.beforeRelation = regionRelation(regions, regionId, run.beforeRegionId);
            run.afterRelation = regionRelation(regions, regionId, run.afterRegionId);
            edgeIndices.forEach((edgeIndex, offset) => {
                routeEdges[edgeIndex].runId = run.id;
                routeEdges[edgeIndex].runOffset = offset;
            });
            runs.push(run);
        }

        return { runs, treewardWalks };
    }

    function triangleCornerIds(world, triangleId) {
        const edge = world.totalUcgenList[triangleId]?.kenarList?.[0];
        return edge ? [edge.uc1NoktaNo, edge.uc2NoktaNo, edge.karsiNoktaNo] : null;
    }

    /**
     * Üçgen, jitter'sız KAYNAK koordinatlarda tam doğrusal mı?
     *
     * Loader ekran koordinatlarına jitter uygular; ızgara tabanlı örneklerde (tsp225,
     * pcb442, u1817 ...) tam doğrusal üçlüler bu yüzden gerçek üçgen gibi görünür.
     * `metricPosition` jitter'sız kaynağı taşıdığı için karar eşiksiz ve tamdır;
     * kaynak yoksa (elle konmuş noktalar) `kendiYeri`'ye düşer ve pratikte hiç
     * tetiklenmez.
     */
    function isSourceDegenerateTriangle(world, triangleId) {
        const corners = triangleCornerIds(world, triangleId);
        if (!corners) return false;
        const places = corners.map(pointId => {
            const point = world.totalNoktaList[pointId];
            return point ? (point.metricPosition || point.kendiYeri) : null;
        });
        if (places.some(place => !place)) return false;
        const [a, b, c] = places;
        return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y) === 0;
    }

    function createLeafRecord(world, forest, childrenByTriangle, pocket, triangleId, routeEdgeByKey, exactRegionByTriangle) {
        let cursor = forest.parentTri[triangleId];
        let firstBranchPointTriangleId = -1;
        while (cursor >= 0 && forest.depth[cursor] >= 1) {
            if (childrenByTriangle[cursor].length >= 2) {
                firstBranchPointTriangleId = cursor;
                break;
            }
            if (cursor === pocket.rootTriangleId) break;
            cursor = forest.parentTri[cursor];
        }
        const exitAnchorTriangleId = firstBranchPointTriangleId >= 0
            ? firstBranchPointTriangleId
            : pocket.rootTriangleId;
        const bridgeTestEdges = world.totalUcgenList[triangleId].kenarList
            .filter(edge => edge.disKenar)
            .map(edge => routeEdgeByKey.get(canonicalRouteEdgeKey(edge.uc1NoktaNo, edge.uc2NoktaNo)))
            .filter(Boolean)
            .sort((left, right) => left.index - right.index);
        return {
            treeId: pocket.id,
            triangleId,
            regionId: exactRegionByTriangle[triangleId],
            firstBranchPointTriangleId,
            exitAnchorTriangleId,
            bridgeTestEdges
        };
    }

    /**
     * Dejenere yaprağın üstündeki ilk gerçek atayı da giriş noktası olarak ekler (R3b).
     *
     * Sahte bir sliver düğüm, gerçek üçgeni yapraklıktan düşürüp rota kenarını
     * `bridgeTestEdges` giriş kümesinden çıkarıyor; double bridge adayı bu yüzden
     * hiç üretilmiyordu. Tırmanma yalnız EKLER — mevcut yaprak kayıtlarına dokunmaz,
     * hiçbir düğümü kaldırmaz.
     */
    function collectDegenerateLeafAncestors(world, forest, childrenByTriangle, pocket, leafTriangleIds) {
        const ancestors = [];
        const seen = new Set();
        for (const triangleId of leafTriangleIds) {
            if (!isSourceDegenerateTriangle(world, triangleId)) continue;
            let cursor = forest.parentTri[triangleId];
            while (cursor >= 0 && forest.depth[cursor] >= 1 && isSourceDegenerateTriangle(world, cursor)) {
                if (cursor === pocket.rootTriangleId) break;
                cursor = forest.parentTri[cursor];
            }
            if (cursor < 0 || isSourceDegenerateTriangle(world, cursor)) continue;
            if (childrenByTriangle[cursor].length === 0 || seen.has(cursor)) continue;
            seen.add(cursor);
            ancestors.push(cursor);
        }
        return ancestors.sort((a, b) => a - b);
    }

    function buildLeafRecords(world, forest, childrenByTriangle, orderedPockets, routeEdgeByKey, exactRegionByTriangle) {
        const leaves = [];
        for (const pocket of orderedPockets) {
            const triangleIds = pocket.triangles.slice().sort((a, b) => a - b);
            const leafTriangleIds = triangleIds.filter(triangleId => childrenByTriangle[triangleId].length === 0);
            const extraTriangleIds = collectDegenerateLeafAncestors(
                world, forest, childrenByTriangle, pocket, leafTriangleIds
            );
            for (const triangleId of leafTriangleIds.concat(extraTriangleIds)) {
                leaves.push(createLeafRecord(
                    world, forest, childrenByTriangle, pocket, triangleId, routeEdgeByKey, exactRegionByTriangle
                ));
            }
        }
        return leaves;
    }

    function buildBranchedBridgeRoundContext(world, order) {
        const outside = markOutsideTriangles(world);
        const dual = buildOutsideDual(world, outside);
        const coreResult = peelToTwoCore(dual);
        const forest = buildPocketForest(world, dual, coreResult);
        const childrenByTriangle = buildChildren(forest);
        const regionData = buildRegions(forest, childrenByTriangle);
        const routeData = buildRouteSideIndex(world, order, forest, regionData.exactRegionByTriangle);
        const runData = buildRegionRuns(routeData.routeEdges, regionData.regions);
        const leaves = buildLeafRecords(
            world,
            forest,
            childrenByTriangle,
            regionData.orderedPockets,
            routeData.routeEdgeByKey,
            regionData.exactRegionByTriangle
        );
        return {
            order: order.slice(),
            outside,
            dual,
            coreResult,
            forest,
            childrenByTriangle,
            regions: regionData.regions,
            exactRegionByTriangle: regionData.exactRegionByTriangle,
            tin: regionData.tin,
            tout: regionData.tout,
            orderedPockets: regionData.orderedPockets,
            routeEdges: routeData.routeEdges,
            routeEdgeByKey: routeData.routeEdgeByKey,
            pointRouteEdges: routeData.pointRouteEdges,
            meshEdgeClasses: buildCurrentMeshEdgeClasses(world, outside),
            raySideCache: new Map(),
            visibleRouteEdgeCache: new Map(),
            fixedFirstCounterCache: new Map(),
            visibleRouteEdgeTreeCache: new Map(),
            secondCutDeltaLowerBoundCache: new Map(),
            secondTargetBoundSeriesCache: new Map(),
            fourCutReconnectionCache: new Map(),
            regionRuns: runData.runs,
            treewardWalks: runData.treewardWalks,
            rootTreeWalks: new Map(),
            leaves
        };
    }

    function getTreewardPocketWalk(context, cutIndex, selectedRegionId = null) {
        const cut = context.routeEdges[cutIndex];
        const regionId = selectedRegionId || cut?.regionId;
        if (!cut || !regionId || cut.regionId !== regionId) return null;
        const cacheKey = `${regionId}|${cutIndex}`;
        if (context.treewardWalks.has(cacheKey)) return context.treewardWalks.get(cacheKey);
        const region = context.regions.get(regionId);
        if (!region) return null;
        const count = context.routeEdges.length;
        const distanceToAnchor = edge => {
            if (!edge || edge.ownerTriangleId < 0) return 0;
            if (context.forest.pocketId[edge.ownerTriangleId]
                !== context.forest.pocketId[region.exitAnchorTriangleId]) return 0;
            return Math.max(
                0,
                context.forest.depth[edge.ownerTriangleId]
                    - context.forest.depth[region.exitAnchorTriangleId]
            );
        };
        const previousIndex = (cutIndex - 1 + count) % count;
        const nextIndex = (cutIndex + 1) % count;
        const isTreewardRegion = edge => !!edge?.regionId
            && edge.treeId === cut.treeId
            && (edge.regionId === regionId
                || regionContainsRegion(context, edge.regionId, regionId));
        const previousEligible = isTreewardRegion(context.routeEdges[previousIndex]);
        const nextEligible = isTreewardRegion(context.routeEdges[nextIndex]);
        const direction = previousEligible !== nextEligible
            ? previousEligible ? -1 : 1
            : distanceToAnchor(context.routeEdges[previousIndex])
                <= distanceToAnchor(context.routeEdges[nextIndex]) ? -1 : 1;
        const edgeIndices = [];
        for (let step = 1; step < count; step++) {
            const edgeIndex = (cutIndex + direction * step + count) % count;
            const edge = context.routeEdges[edgeIndex];
            if (!isTreewardRegion(edge)) break;
            edgeIndices.push(edgeIndex);
        }
        const entryEdge = edgeIndices.length ? context.routeEdges[edgeIndices[0]] : null;
        const walk = Object.freeze({
            cutIndex,
            regionId,
            treeId: cut.treeId,
            exitAnchorTriangleId: region.exitAnchorTriangleId,
            direction,
            k1PointId: direction < 0 ? cut.from : cut.to,
            y1PointId: !entryEdge ? null : direction < 0 ? entryEdge.from : entryEdge.to,
            entryEdgeIndex: edgeIndices[0] ?? null,
            segmentEdgeIndices: Object.freeze(edgeIndices),
            testEdgeIndices: Object.freeze(edgeIndices.slice(1))
        });
        context.treewardWalks.set(cacheKey, walk);
        return walk;
    }

    function getRootTreeWalk(context, cutIndex, direction) {
        if (direction !== -1 && direction !== 1) {
            throw new RangeError("Root-tree walk direction must be -1 or 1");
        }
        const cut = context.routeEdges[cutIndex];
        if (!cut || cut.treeId < 0) return null;
        const cacheKey = `${cutIndex}|${direction}`;
        if (context.rootTreeWalks.has(cacheKey)) return context.rootTreeWalks.get(cacheKey);

        const count = context.routeEdges.length;
        const edgeIndices = [];
        for (let step = 1; step < count; step++) {
            const edgeIndex = (cutIndex + direction * step + count) % count;
            const edge = context.routeEdges[edgeIndex];
            if (!edge || edge.treeId !== cut.treeId) break;
            edgeIndices.push(edgeIndex);
        }
        const entryEdge = edgeIndices.length ? context.routeEdges[edgeIndices[0]] : null;
        const walk = Object.freeze({
            cutIndex,
            regionId: cut.regionId,
            treeId: cut.treeId,
            direction,
            k1PointId: direction < 0 ? cut.from : cut.to,
            y1PointId: !entryEdge ? null : direction < 0 ? entryEdge.from : entryEdge.to,
            entryEdgeIndex: edgeIndices[0] ?? null,
            segmentEdgeIndices: Object.freeze(edgeIndices),
            testEdgeIndices: Object.freeze(edgeIndices.slice(1))
        });
        context.rootTreeWalks.set(cacheKey, walk);
        return walk;
    }

    function triangleCentroid(world, triangleId) {
        const triangle = world.totalUcgenList[triangleId];
        if (!triangle?.kenarList?.[0]) return null;
        const edge = triangle.kenarList[0];
        const p1 = world.totalNoktaList[edge.uc1NoktaNo]?.kendiYeri;
        const p2 = world.totalNoktaList[edge.uc2NoktaNo]?.kendiYeri;
        const p3 = world.totalNoktaList[edge.karsiNoktaNo]?.kendiYeri;
        if (!p1 || !p2 || !p3) return null;
        return {
            x: (p1.x + p2.x + p3.x) / 3,
            y: (p1.y + p2.y + p3.y) / 3
        };
    }

    function buildPocketTreeOverlay(world, context) {
        if (!context?.forest || !context?.childrenByTriangle) {
            throw new TypeError("A current branched bridge round context is required");
        }
        const forest = context.forest;
        const childrenByTriangle = context.childrenByTriangle;
        const toneByNode = new Int32Array(forest.parentTri.length).fill(-1);
        const queue = [];
        for (const pocket of context.orderedPockets) {
            toneByNode[pocket.rootTriangleId] = 0;
            queue.push(pocket.rootTriangleId);
        }
        for (let head = 0; head < queue.length; head++) {
            const nodeId = queue[head];
            const children = childrenByTriangle[nodeId];
            const childTone = children.length >= 2 ? toneByNode[nodeId] + 1 : toneByNode[nodeId];
            for (const childId of children) {
                toneByNode[childId] = childTone;
                queue.push(childId);
            }
        }

        const segments = [];
        let maxTone = 0;
        let maxDepth = 1;
        for (let triangleId = 0; triangleId < forest.parentTri.length; triangleId++) {
            const parentId = forest.parentTri[triangleId];
            if (parentId < 0 || forest.depth[triangleId] < 1) continue;
            const from = triangleCentroid(world, parentId);
            const to = triangleCentroid(world, triangleId);
            if (!from || !to) continue;
            const tone = Math.max(0, toneByNode[triangleId]);
            maxTone = Math.max(maxTone, tone);
            maxDepth = Math.max(maxDepth, forest.depth[triangleId]);
            segments.push({
                x1: from.x,
                y1: from.y,
                x2: to.x,
                y2: to.y,
                depth: forest.depth[triangleId],
                tone
            });
        }
        return {
            maxDepth,
            maxTone,
            segments,
            pocketCount: forest.pockets.length
        };
    }

    return {
        canonicalRouteEdgeKey,
        markOutsideTriangles,
        buildOutsideDual,
        peelToTwoCore,
        buildPocketForest,
        buildBranchedBridgeRoundContext,
        isSourceDegenerateTriangle,
        isTriangleAncestor,
        isTriangleInLeafForbiddenCorridor,
        regionContainsTriangle,
        regionContainsRegion,
        getTreewardPocketWalk,
        getRootTreeWalk,
        triangleCentroid,
        buildPocketTreeOverlay
    };
});
