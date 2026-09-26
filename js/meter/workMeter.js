/* Whole-call work metering: a single primitive unit ("step") for all stages.
 *
 * A step is one of:
 *   - each function/arrow/method/getter/constructor entry in the metered code,
 *   - each loop body iteration (for, for-in, for-of, while, do-while),
 *   - each element processed by native bulk operations (slice, indexOf, join, sort,
 *     spread, Set/Map constructors, JSON, Object.keys ... per the table below).
 * Between two steps the metered code does constant (O(1)) work, so steps from
 * different stages can be summed without unit conversion. Sources are instrumented
 * with acorn at load time; unmetered code counts nothing.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkMeter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const VERSION = "20260923-1";
  const HOOK = Object.freeze({
    call: "__wF", loop: "__wL", spread: "__wS", object: "__wO",
    iterable: "__wI", alloc: "__wA", callback: "__wC", arrayLike: "__wY"
  });
  const HOOK_NAMES = Object.freeze(Object.values(HOOK));

  // Geri çağırma alan yöntemler: çağrı yerinde fonksiyon literali yoksa sayan
  // sarmalayıcıyla sarılır; literal geri çağırmalar zaten kendi girişinde sayılır.
  const CALLBACK_ARG = new Map([
    ["map", 0], ["forEach", 0], ["filter", 0], ["reduce", 0], ["reduceRight", 0],
    ["some", 0], ["every", 0], ["find", 0], ["findIndex", 0], ["findLast", 0],
    ["findLastIndex", 0], ["flatMap", 0], ["sort", 0], ["toSorted", 0],
    ["from", 1], ["replace", 1], ["replaceAll", 1], ["stringify", 1], ["parse", 1]
  ]);
  const ITERABLE_CONSTRUCTORS = new Set(["Set", "Map", "WeakSet", "WeakMap"]);
  const ALLOC_CONSTRUCTORS = new Set(["Array", "Float64Array", "Float32Array", "Int8Array",
    "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
    "Uint32Array", "BigInt64Array", "BigUint64Array"]);
  const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement",
    "WhileStatement", "DoWhileStatement"]);
  const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression",
    "ArrowFunctionExpression"]);

  // Denetim sınıflandırması: ölçülen kaynaktaki her
  // yerel çağrı adı bu sınıflardan birinde olmalıdır. Aynı adın O(n) yerel
  // biçimi varsa (Object.keys ~ Map.keys, TypedArray.set ~ Map.set) ad "charged"
  // sınıfındadır ve yalnız O(n) biçimi yamalanır.
  const NATIVE_COST = Object.freeze({
    charged: Object.freeze([
      // Array / TypedArray
      "copyWithin", "fill", "join", "reverse", "splice", "shift", "unshift", "toString",
      "toLocaleString", "toReversed", "toSpliced", "with", "concat", "flat", "flatMap",
      "slice", "indexOf", "lastIndexOf", "includes", "sort", "toSorted", "from", "of", "set",
      // String
      "split", "startsWith", "endsWith", "search", "match", "matchAll", "localeCompare",
      "normalize", "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase",
      "toLocaleLowerCase", "toLocaleUpperCase", "replace", "replaceAll", "substring", "substr",
      "repeat", "padStart", "padEnd",
      // Object / JSON / Reflect / RegExp / console
      "keys", "values", "entries", "getOwnPropertyNames", "fromEntries", "assign", "freeze",
      "seal", "stringify", "parse", "ownKeys", "exec", "test", "log", "info", "warn", "error",
      "debug", "table",
      // Set cebri (Set.prototype.union ...)
      "union", "intersection", "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf",
      "isDisjointFrom",
      // Sözdizimsel kanca: fn.apply(ctx, dizi)
      "apply"
    ]),
    callback: Object.freeze([...CALLBACK_ARG.keys()]),
    constant: Object.freeze([
      "push", "pop", "at", "get", "has", "add", "delete", "clear", "next", "call", "bind",
      "max", "min", "abs", "floor", "ceil", "round", "trunc", "sign", "sqrt", "hypot", "pow",
      "atan2", "sin", "cos", "tan", "asin", "acos", "atan", "exp", "log2", "log10", "imul",
      "random", "now", "isArray", "isFinite", "isInteger", "isSafeInteger", "isNaN", "toFixed",
      "toPrecision", "charCodeAt", "codePointAt", "charAt", "fromCharCode", "subarray",
      "isView", "defineProperty", "getOwnPropertyDescriptor", "getPrototypeOf",
      "setPrototypeOf", "is", "hasOwn", "hasOwnProperty", "isFrozen", "create", "valueOf",
      "getAttribute"
    ])
  });

  // Yama kurulmadan önce yakalanan özgün yerel işlevler (ölçüm kendi işini saymaz).
  const ReflectApply = Reflect.apply;
  const ArrayFrom = Array.from;
  const ObjectKeys = Object.keys;
  const ArrayIndexOf = Array.prototype.indexOf;

  class WorkBudgetExceeded extends Error {
    constructor(limit, total) {
      super(`Whole-call work budget ran out: ${total} / ${limit} steps`);
      this.name = "WorkBudgetExceeded";
      this.workBudgetExceeded = true;
      this.limit = limit;
      this.total = total;
    }
  }

  function getAcorn(options) {
    const acorn = options && options.acorn || root.acorn;
    if (!acorn || typeof acorn.parse !== "function") throw new Error("WorkMeter requires acorn");
    return acorn;
  }

  function parse(source, options) {
    return getAcorn(options).parse(source, { ecmaVersion: "latest", sourceType: "script",
      allowHashBang: true });
  }

  function forEachChild(node, visit) {
    for (const key in node) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item.type === "string") visit(item);
      } else if (value && typeof value.type === "string") visit(value);
    }
  }

  function topLevelRest(pattern) {
    if (pattern.type === "ArrayPattern") return pattern.elements.some(item => item && item.type === "RestElement");
    if (pattern.type === "ObjectPattern") return pattern.properties.some(item => item.type === "RestElement");
    return false;
  }

  function isFunctionLiteral(node) {
    return node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
  }

  /**
   * Kaynağı adım kancalarıyla enstrümante eder. Anlam korunur: yalnız çağrı,
   * döngü ve yerel toplu işlem noktalarına sayaç eklenir.
   */
  function instrument(source, options = {}) {
    const ast = parse(source, options);
    const edits = [];
    const stats = { functions: 0, loops: 0, spreads: 0, objectSpreads: 0, iterables: 0,
      allocations: 0, callbacks: 0, applies: 0, rests: 0 };
    const unhandled = [];
    const handledPatterns = new Set();
    // order: 0 kapanış (içteki önce), 1 nokta, 2 açılış (dıştaki önce).
    const edit = (pos, text, order, depth) => edits.push({ pos, text, order, depth });
    const wrap = (node, prefix, depth, suffix = ")") => {
      edit(node.start, prefix, 2, depth);
      edit(node.end, suffix, 0, depth);
    };

    function functionEntry(fn, depth) {
      stats.functions++;
      const body = fn.body;
      if (body.type !== "BlockStatement") {
        wrap(body, `(${HOOK.call}(), `, depth);
        return;
      }
      let pos = body.start + 1, prefix = "";
      for (const statement of body.body) {
        if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") break;
        pos = statement.end;
        prefix = ";";
      }
      edit(pos, `${prefix}${HOOK.call}();`, 1, depth);
    }

    function loopBody(body, depth) {
      stats.loops++;
      if (body.type === "BlockStatement") edit(body.start + 1, `${HOOK.loop}();`, 1, depth);
      else wrap(body, `{${HOOK.loop}();`, depth, "}");
    }

    function restSource(pattern, value, depth) {
      handledPatterns.add(pattern);
      stats.rests++;
      wrap(value, `${pattern.type === "ArrayPattern" ? HOOK.spread : HOOK.object}(`, depth);
    }

    function callSite(node, depth) {
      const callee = node.callee;
      const args = node.arguments;
      if (callee.type === "Identifier" && args.length && args[0].type !== "SpreadElement") {
        if (ITERABLE_CONSTRUCTORS.has(callee.name)) {
          stats.iterables++;
          wrap(args[0], `${HOOK.iterable}(`, depth);
        } else if (ALLOC_CONSTRUCTORS.has(callee.name) && args.length === 1) {
          stats.allocations++;
          wrap(args[0], `${HOOK.alloc}(`, depth);
        }
      }
      if (node.type !== "CallExpression" || callee.type !== "MemberExpression"
          || callee.computed || callee.property.type !== "Identifier") return;
      const name = callee.property.name;
      if (name === "apply" && args.length >= 2 && args[1].type !== "SpreadElement") {
        stats.applies++;
        wrap(args[1], `${HOOK.arrayLike}(`, depth);
      }
      const index = CALLBACK_ARG.get(name);
      if (index === undefined || args.length <= index) return;
      const arg = args[index];
      if (arg.type === "SpreadElement" || isFunctionLiteral(arg)) return;
      stats.callbacks++;
      wrap(arg, `${HOOK.callback}(`, depth);
    }

    function visit(node, parent, depth) {
      if (FUNCTIONS.has(node.type)) functionEntry(node, depth);
      else if (LOOPS.has(node.type)) loopBody(node.body, depth);
      else if (node.type === "SpreadElement") {
        if (parent && parent.type === "ObjectExpression") {
          stats.objectSpreads++;
          wrap(node.argument, `${HOOK.object}(`, depth);
        } else {
          stats.spreads++;
          wrap(node.argument, `${HOOK.spread}(`, depth);
        }
      } else if (node.type === "CallExpression" || node.type === "NewExpression") callSite(node, depth);
      else if (node.type === "VariableDeclarator" && node.init && topLevelRest(node.id)) {
        restSource(node.id, node.init, depth);
      } else if (node.type === "AssignmentExpression" && topLevelRest(node.left)) {
        restSource(node.left, node.right, depth);
      } else if (node.type === "RestElement") {
        // Parametre rest'i çağrıdaki argüman sayısı kadardır; çağrı yerindeki
        // spread zaten sayılır. Başka yerdeki rest desteklenmez ve raporlanır.
        const isParam = parent && FUNCTIONS.has(parent.type);
        if (!isParam && !handledPatterns.has(parent)) {
          unhandled.push({ kind: "rest", start: node.start });
        }
      }
      forEachChild(node, child => visit(child, node, depth + 1));
    }
    visit(ast, null, 0);

    edits.sort((a, b) => a.pos - b.pos || a.order - b.order
      || (a.order === 0 ? b.depth - a.depth : a.depth - b.depth));
    let code = "", last = 0;
    for (const item of edits) {
      code += source.slice(last, item.pos) + item.text;
      last = item.pos;
    }
    code += source.slice(last);
    return { code, stats, unhandled };
  }

  /** Üst düzey fonksiyon bildirimlerinin kaynağını ada göre çıkarır. */
  function extractFunctions(source, names, options = {}) {
    const ast = parse(source, options);
    const wanted = new Set(names);
    const found = new Map();
    for (const statement of ast.body) {
      if (statement.type === "FunctionDeclaration" && wanted.has(statement.id.name)) {
        found.set(statement.id.name, source.slice(statement.start, statement.end));
      }
    }
    const missing = names.filter(name => !found.has(name));
    if (missing.length) throw new Error(`WorkMeter: function(s) not found: ${missing.join(", ")}`);
    return names.map(name => found.get(name)).join("\n");
  }

  /**
   * Statik denetim: ölçülen kaynaktaki çağrı hedeflerini toplar. Test, her hedefin
   * ölçülen kod, sabit maliyetli yerel işlem veya sayılan yerel işlem olduğunu
   * sınıflandırmak için bunu kullanır.
   */
  function auditSource(source, options = {}) {
    const ast = parse(source, options);
    const memberCalls = new Map(), globalCalls = new Map(), constructors = new Map();
    const defined = new Set();
    let computedCalls = 0;
    const bump = (map, name) => map.set(name, (map.get(name) || 0) + 1);
    const bind = pattern => {
      if (!pattern) return;
      if (pattern.type === "Identifier") defined.add(pattern.name);
      else if (pattern.type === "AssignmentPattern") bind(pattern.left);
      else if (pattern.type === "RestElement") bind(pattern.argument);
      else if (pattern.type === "ArrayPattern") pattern.elements.forEach(bind);
      else if (pattern.type === "ObjectPattern") pattern.properties.forEach(property =>
        bind(property.type === "RestElement" ? property : property.value));
    };
    function visit(node) {
      if (node.type === "FunctionDeclaration" && node.id) defined.add(node.id.name);
      if (FUNCTIONS.has(node.type)) node.params.forEach(bind);
      if (node.type === "CatchClause") bind(node.param);
      if (node.type === "ClassDeclaration" && node.id) defined.add(node.id.name);
      if (node.type === "VariableDeclarator") bind(node.id);
      if (node.type === "MethodDefinition" && node.key.type === "Identifier") defined.add(node.key.name);
      if (node.type === "PropertyDefinition" && node.key.type === "Identifier") defined.add(node.key.name);
      if (node.type === "Property" && node.key.type === "Identifier"
          && (isFunctionLiteral(node.value) || node.method || node.value.type === "Identifier")) {
        defined.add(node.key.name);
      }
      if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression"
          && !node.left.computed && isFunctionLiteral(node.right)) defined.add(node.left.property.name);
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
        const target = node.type === "NewExpression" ? constructors : null;
        if (callee.type === "Identifier") bump(target || globalCalls, callee.name);
        else if (callee.type === "MemberExpression" && !callee.computed
            && callee.property.type === "Identifier") bump(target || memberCalls, callee.property.name);
        else if (callee.type === "MemberExpression" && callee.computed) computedCalls++;
      }
      forEachChild(node, visit);
    }
    visit(ast);
    return { memberCalls, globalCalls, constructors, defined, computedCalls };
  }

  function lengthOf(value) {
    if (value == null) return 0;
    if (typeof value === "string" || typeof value.length === "number") return value.length;
    if (typeof value.size === "number") return value.size;
    return 0;
  }

  /** Tek, yenilenmeyen iş bütçeli ölçer. */
  function createMeter(options = {}) {
    const limit = options.limit === undefined || options.limit === null ? Infinity : Number(options.limit);
    if (!(limit >= 0)) throw new Error("Invalid work budget");
    const m = { limit, total: 0, calls: 0, loops: 0, native: 0, exhausted: false,
      paused: 0, stage: options.stage || "setup", stageStart: 0,
      byStage: Object.create(null), nativeByKind: Object.create(null) };

    function exceed() {
      m.exhausted = true;
      throw new WorkBudgetExceeded(m.limit, m.total);
    }
    function call() {
      m.calls++;
      if (++m.total > m.limit) exceed();
    }
    function loop() {
      m.loops++;
      if (++m.total > m.limit) exceed();
    }
    function charge(count, kind) {
      if (m.paused || !(count > 0)) return;
      m.native += count;
      if (kind) m.nativeByKind[kind] = (m.nativeByKind[kind] || 0) + count;
      m.total += count;
      if (m.total > m.limit) exceed();
    }
    function spread(value) {
      if (value == null) return value;
      if (typeof value === "string" || typeof value.length === "number"
          || typeof value.size === "number") {
        charge(lengthOf(value), "spread");
        return value;
      }
      if (typeof value[Symbol.iterator] === "function") {
        const array = ArrayFrom(value);
        charge(array.length, "spread");
        return array;
      }
      return value;
    }
    function object(value) {
      if (value != null && (typeof value === "object" || typeof value === "string")) {
        charge(typeof value === "string" ? value.length : ObjectKeys(value).length, "objectSpread");
      }
      return value;
    }
    function alloc(value) {
      if (typeof value === "number") charge(value, "alloc");
      else charge(lengthOf(value), "alloc");
      return value;
    }
    function arrayLike(value) {
      if (value != null && typeof value.length === "number") charge(value.length, "apply");
      return value;
    }
    function callback(fn) {
      if (typeof fn !== "function") return fn;
      return function () {
        m.calls++;
        if (++m.total > m.limit) exceed();
        return ReflectApply(fn, this, arguments);
      };
    }
    const hooks = Object.freeze({
      [HOOK.call]: call, [HOOK.loop]: loop, [HOOK.spread]: spread,
      [HOOK.object]: object, [HOOK.iterable]: spread, [HOOK.alloc]: alloc,
      [HOOK.callback]: callback, [HOOK.arrayLike]: arrayLike
    });

    function switchStage(name) {
      const previous = m.stage;
      m.byStage[previous] = (m.byStage[previous] || 0) + (m.total - m.stageStart);
      m.stage = name;
      m.stageStart = m.total;
      return previous;
    }
    function snapshot() {
      const byStage = {};
      for (const name of ObjectKeys(m.byStage)) if (m.byStage[name]) byStage[name] = m.byStage[name];
      const current = m.total - m.stageStart;
      if (current) byStage[m.stage] = (byStage[m.stage] || 0) + current;
      return { unit: "step", version: VERSION, limit: m.limit === Infinity ? null : m.limit,
        stage: m.stage, total: m.total, calls: m.calls, loops: m.loops, native: m.native,
        nativeByKind: { ...m.nativeByKind }, exhausted: m.exhausted, byStage };
    }
    function remaining() {
      return m.limit === Infinity ? Infinity : Math.max(0, m.limit - m.total);
    }
    /** Başka bir ölçerde aynı kodla ölçülmüş işi (ör. Worker provası) aynı kategorilerle ekler. */
    function absorb(delta) {
      const calls = delta.calls || 0, loops = delta.loops || 0, native = delta.native || 0;
      m.calls += calls;
      m.loops += loops;
      m.native += native;
      m.total += calls + loops + native;
      if (m.total > m.limit) exceed();
    }
    function pause() { m.paused++; }
    function resume() { if (m.paused > 0) m.paused--; }
    /** Ölçülmeyen (UI/çizim) kodu çalıştırırken yerel yama sayımını durdurur. */
    function unmetered(fn) {
      return function () {
        m.paused++;
        try { return ReflectApply(fn, this, arguments); } finally { m.paused--; }
      };
    }
    function installGlobals(target) {
      for (const name of HOOK_NAMES) target[name] = hooks[name];
    }

    return { state: m, hooks, charge, absorb, switchStage, snapshot, remaining, pause, resume,
      unmetered, installGlobals,
      installNatives: target => installNativeCharges(target, charge) };
  }

  /**
   * Hedef realm'in yerel toplu işlemlerini sayan yamaları kurar; kaldırma
   * işlevini döndürür. Geri çağırmalı yöntemler (map, forEach, sort(cmp), ...)
   * yamalanmaz: her geri çağırma kendi girişinde bir adım sayılır.
   */
  function installNativeCharges(target, charge) {
    const saved = [];
    function patch(owner, name, make) {
      if (!owner) return;
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (!descriptor || typeof descriptor.value !== "function") return;
      const wrapper = make(descriptor.value);
      Object.defineProperty(owner, name, { ...descriptor, value: wrapper });
      saved.push([owner, name, descriptor]);
    }
    const byThis = kind => original => function () {
      charge(lengthOf(this), kind);
      return ReflectApply(original, this, arguments);
    };
    const byResult = kind => original => function () {
      const result = ReflectApply(original, this, arguments);
      charge(lengthOf(result), kind);
      return result;
    };
    const byFirstArgument = kind => original => function (value) {
      charge(lengthOf(value), kind);
      return ReflectApply(original, this, arguments);
    };
    const indexScan = kind => original => function () {
      const index = ReflectApply(original, this, arguments);
      const length = lengthOf(this);
      charge(index < 0 ? length : index + 1, kind);
      return index;
    };
    const lastIndexScan = kind => original => function () {
      const index = ReflectApply(original, this, arguments);
      const length = lengthOf(this);
      charge(index < 0 ? length : length - index, kind);
      return index;
    };
    const includesScan = (kind, indexOf) => original => function (value) {
      const found = ReflectApply(original, this, arguments);
      const length = lengthOf(this);
      if (!found) charge(length, kind);
      else {
        const index = ReflectApply(indexOf, this, arguments);
        charge(index < 0 ? length : index + 1, kind);
      }
      return found;
    };
    const sortCharge = kind => original => function (compare) {
      if (compare === undefined) {
        const length = lengthOf(this);
        charge(length > 1 ? length * Math.ceil(Math.log2(length + 1)) : length, kind);
      }
      return ReflectApply(original, this, arguments);
    };

    const ArrayProto = target.Array && target.Array.prototype;
    // toString yamalanmaz: yerel toString (örtük dönüşüm dahil) yamalı join'i çağırır.
    for (const name of ["copyWithin", "fill", "join", "reverse", "splice", "shift", "unshift",
      "toLocaleString", "toReversed", "toSpliced", "with"]) {
      patch(ArrayProto, name, byThis(`array.${name}`));
    }
    for (const name of ["concat", "flat", "flatMap", "slice"]) patch(ArrayProto, name, byResult(`array.${name}`));
    const arrayIndexOf = ArrayProto && ArrayProto.indexOf;
    patch(ArrayProto, "indexOf", indexScan("array.indexOf"));
    patch(ArrayProto, "lastIndexOf", lastIndexScan("array.lastIndexOf"));
    patch(ArrayProto, "includes", includesScan("array.includes", arrayIndexOf || ArrayIndexOf));
    patch(ArrayProto, "sort", sortCharge("array.sort"));
    patch(ArrayProto, "toSorted", sortCharge("array.toSorted"));
    patch(target.Array, "from", byResult("array.from"));
    patch(target.Array, "of", byResult("array.of"));

    const TypedArray = target.Uint8Array && Object.getPrototypeOf(target.Uint8Array);
    const TypedProto = TypedArray && TypedArray.prototype;
    for (const name of ["fill", "join", "reverse", "copyWithin", "toReversed", "with"]) {
      patch(TypedProto, name, byThis(`typed.${name}`));
    }
    patch(TypedProto, "set", byFirstArgument("typed.set"));
    patch(TypedProto, "slice", byResult("typed.slice"));
    const typedIndexOf = TypedProto && TypedProto.indexOf;
    patch(TypedProto, "indexOf", indexScan("typed.indexOf"));
    patch(TypedProto, "lastIndexOf", lastIndexScan("typed.lastIndexOf"));
    if (typedIndexOf) patch(TypedProto, "includes", includesScan("typed.includes", typedIndexOf));
    patch(TypedProto, "sort", sortCharge("typed.sort"));
    patch(TypedProto, "toSorted", sortCharge("typed.toSorted"));
    patch(TypedArray, "from", byResult("typed.from"));
    patch(TypedArray, "of", byResult("typed.of"));

    const StringProto = target.String && target.String.prototype;
    for (const name of ["split", "indexOf", "lastIndexOf", "includes", "startsWith", "endsWith",
      "search", "match", "matchAll", "localeCompare", "normalize", "trim", "trimStart", "trimEnd",
      "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase", "replace",
      "replaceAll"]) {
      patch(StringProto, name, byThis(`string.${name}`));
    }
    for (const name of ["slice", "substring", "substr", "repeat", "padStart", "padEnd", "concat"]) {
      patch(StringProto, name, byResult(`string.${name}`));
    }

    const SetProto = target.Set && target.Set.prototype;
    for (const name of ["union", "intersection", "difference", "symmetricDifference", "isSubsetOf",
      "isSupersetOf", "isDisjointFrom"]) {
      patch(SetProto, name, original => function (other) {
        charge(lengthOf(this) + lengthOf(other), `set.${name}`);
        return ReflectApply(original, this, arguments);
      });
    }

    const ObjectCtor = target.Object;
    for (const name of ["keys", "values", "entries", "getOwnPropertyNames"]) {
      patch(ObjectCtor, name, byResult(`object.${name}`));
    }
    patch(ObjectCtor, "fromEntries", byFirstArgument("object.fromEntries"));
    patch(ObjectCtor, "assign", original => function (destination) {
      let count = 0;
      for (let at = 1; at < arguments.length; at++) {
        if (arguments[at] != null) count += ObjectKeys(arguments[at]).length;
      }
      charge(count, "object.assign");
      return ReflectApply(original, this, arguments);
    });
    for (const name of ["freeze", "seal"]) {
      patch(ObjectCtor, name, original => function (value) {
        if (value != null && typeof value === "object") charge(ObjectKeys(value).length, `object.${name}`);
        return ReflectApply(original, this, arguments);
      });
    }

    patch(target.JSON, "stringify", byResult("json.stringify"));
    patch(target.JSON, "parse", byFirstArgument("json.parse"));
    patch(target.Reflect, "ownKeys", byResult("reflect.ownKeys"));
    const RegExpProto = target.RegExp && target.RegExp.prototype;
    patch(RegExpProto, "exec", byFirstArgument("regexp.exec"));
    patch(RegExpProto, "test", byFirstArgument("regexp.test"));

    const consoleObject = target.console;
    if (consoleObject) {
      for (const name of ["log", "info", "warn", "error", "debug", "table"]) {
        patch(consoleObject, name, original => function () {
          let count = 1;
          for (let at = 0; at < arguments.length; at++) count += lengthOf(arguments[at]);
          charge(count, "console");
          return ReflectApply(original, this, arguments);
        });
      }
    }

    return function uninstall() {
      for (let at = saved.length - 1; at >= 0; at--) {
        const [owner, name, descriptor] = saved[at];
        Object.defineProperty(owner, name, descriptor);
      }
      saved.length = 0;
    };
  }

  /**
   * Ölçülen kaynakları aynı realm'de yalıtılmış bir kapsamda çalıştırır.
   * Sayfa globallerini değiştirmez: UMD modüllerinin kökü sahte nesnedir,
   * `provided` adları parametre olarak gölgelenir, `exported` adlar döner.
   * Katı (strict) dosyalardan çıkarılan fonksiyonlar kendi katı kapsamında kalır.
   */
  function evaluateIsolated(segments, provided, exported) {
    const names = ObjectKeys(provided);
    const fakeRoot = Object.create(null);
    let body = "";
    for (const segment of segments) {
      const declares = segment.declares || [];
      if (segment.strict && declares.length) {
        body += `const { ${declares.join(", ")} } = (function () { "use strict";\n${segment.code}\n`
          + `;return { ${declares.join(", ")} }; })();\n`;
      } else body += `${segment.code}\n;\n`;
    }
    body += `return { ${exported.map(name => {
      const key = JSON.stringify(name);
      return `${key}: ${key} in __isolatedRoot ? __isolatedRoot[${key}] : ${name}`;
    }).join(", ")} };`;
    // Parametreler: sağlanan adlar + UMD sarmalayıcısının gördüğü kök/modül adları.
    const factory = new Function(...names, "globalThis", "module", "require", "__isolatedRoot", body);
    return factory(...names.map(name => provided[name]), fakeRoot, undefined, undefined, fakeRoot);
  }

  return { VERSION, HOOK, HOOK_NAMES, NATIVE_COST, ITERABLE_CONSTRUCTORS, ALLOC_CONSTRUCTORS,
    WorkBudgetExceeded, instrument, extractFunctions, auditSource, createMeter,
    installNativeCharges, evaluateIsolated, lengthOf };
});
