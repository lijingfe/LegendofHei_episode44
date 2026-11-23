import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { gzipSync, gunzipSync } from 'node:zlib';

// Fusion search from check_5k_10k_unified.mjs. The batch driver sweeps the
// lifetime bounds used by scan_2d_unified.mjs and emits full verified timelines.
import { createWaveField, SOURCES } from '../../波源立体几何重建/2d/wave-field.js';
import { isHoleSafeDuring } from '../pathfinding/solver.js';

const HYPOTHESES = {
  H_fix_60_90: { id: 'H_fix_60_90', dynamic: false, two: 60, three: 90 },
  H_fix_45_90: { id: 'H_fix_45_90', dynamic: false, two: 45, three: 90 },
  H_fix_30_60: { id: 'H_fix_30_60', dynamic: false, two: 30, three: 60 },
};
const instruction = (label, turn, distance, wait) => ({ label, turn, distance, wait });
const FRONT = [
  instruction('左三', -3, 43), instruction('一号位', 0, 50), instruction('左三', -3, 45),
  instruction('右三', 3, 30), instruction('右三', 3, 47), instruction('左三', -3, 40),
  instruction('一号位·二段跳 1', 0, 30), instruction('一号位·二段跳 2', 0, 30, 0.4),
  instruction('左二', -2, 46),
];
const END = [
  instruction('左二', -2, 53), instruction('右二', 2, 40), instruction('一号位', 0, 20),
  instruction('左二', -2, 30), instruction('右二', 2, 45),
];

const field = createWaveField({ sources: SOURCES, maxRadius: Infinity });
const dt = 0.1;
const endHold = 10;
const marginRequired = 1.0;
const geomEpsilon = 1e-9;
const maxWait = 40;
const period = 10;
const phaseCount = Math.round(period / dt);
const goalRadius = 50;
const radians = Math.PI / 180;
const radius = ({ x, y }) => Math.hypot(x, y);
const range = (min, max, step) => Array.from({ length: Math.floor((max - min) / step + 1e-9) + 1 }, (_, i) => min + i * step);

const radii = range(100, 260, 5);
const bearings = range(-90, 90, 5);
const backtracks = [0, 1, 2];
const maxEndRadius = radii.at(-1) + END.reduce((sum, jump) => sum + jump.distance, 0);
const phaseAnchor = Math.ceil(Math.max(...SOURCES.map(source => source.startTime
  + Math.hypot(radius(source) + maxEndRadius + 2, source.z) / source.speed + period)) / period) * period;
const anchorTick = Math.round(phaseAnchor / dt);
const indexedRings = SOURCES.map(source => ({ source, rings: [] }));

function landmarks(hypothesis, start, commands) {
  const points = [{ x: start.x, y: start.y }];
  for (const command of commands) {
    const point = points.at(-1);
    const slot = Math.abs(command.turn);
    const offset = (slot === 2 ? hypothesis.two : slot === 3 ? hypothesis.three : 0) * radians;
    const cos = Math.abs(offset) === Math.PI / 2 ? 0 : Math.cos(offset);
    const sin = Math.sign(command.turn) * Math.sin(offset);
    points.push({ x: point.x - command.distance * cos, y: point.y + command.distance * sin });
  }
  return points;
}

function* nearestEmissions(point, t0, t1) {
  for (const { source, rings } of indexedRings) {
    const depth = Math.abs(source.z);
    const delay = Math.hypot(point.x - source.x, point.y - source.y, depth) / source.speed;
    // Include all crossings and the nearest ring on either side. Earlier and later
    // rings from the same source are strictly farther throughout this interval.
    const first = Math.max(0, Math.floor((t0 - delay - source.startTime) / source.interval) - 1);
    const last = Math.max(0, Math.ceil((t1 - delay - source.startTime) / source.interval) + 1);
    for (let i = first; i <= last; i++) {
      if (!rings[i]) {
        const emittedAt = source.startTime + i * source.interval;
        rings[i] = {
          cx: source.x, cy: source.y, z: source.z, speed: source.speed, emittedAt,
          contact: emittedAt + depth / source.speed, expiry: Infinity,
        };
      }
      if (rings[i].contact > t1) break;
      yield rings[i];
    }
  }
}

function clearance(point, from, to, endInclusive = false) {
  const query = { getEmissionsBetween: (t0, t1) => nearestEmissions(point, t0, t1) };
  return isHoleSafeDuring(point.x, point.y, from * dt, to * dt, query, 1, marginRequired, { endInclusive }).margin;
}

function schedule(points, commands, travelTicks, oldTicks, { initialTravel = 0, hold = endHold, phasePeriod = 0 } = {}) {
  const cacheByHole = points.map(() => ({ ranges: new Map(), moments: new Map(), paths: new Map() }));
  const key = tick => phasePeriod ? tick % phasePeriod : tick;
  function cachedMargin(index, tick, instant = false) {
    const cache = instant ? cacheByHole[index].moments : cacheByHole[index].ranges;
    const id = key(tick);
    if (!cache.has(id)) cache.set(id, clearance(points[index], tick, tick + (instant ? 0 : 1), instant));
    return cache.get(id);
  }
  function solve(index, tick) {
    const cache = cacheByHole[index].paths;
    const id = key(tick);
    if (cache.has(id)) return cache.get(id);
    const openToArrive = index === 0 ? initialTravel : travelTicks;
    let best = null, local = Infinity;
    if (index === commands.length) {
      const finish = openToArrive + hold;
      for (let offset = 0; offset < finish; offset++) local = Math.min(local, cachedMargin(index, tick + offset));
      local = Math.min(local, cachedMargin(index, tick + finish, true));
      if (local >= marginRequired) best = { margin: local, local, finish };
    } else {
      const fixedWait = commands[index].wait;
      const firstWait = fixedWait === undefined ? 0 : Math.round(fixedWait / dt);
      const lastWait = fixedWait === undefined ? maxWait : firstWait;
      let checked = 0;
      for (let wait = firstWait; wait <= lastWait; wait++) {
        const departure = openToArrive + wait;
        const expiry = departure + travelTicks + oldTicks;
        while (checked < expiry && local >= marginRequired) local = Math.min(local, cachedMargin(index, tick + checked++));
        if (local < marginRequired) break;
        const tail = solve(index + 1, tick + departure);
        if (!tail) continue;
        const margin = Math.min(local, tail.margin);
        const finish = departure + tail.finish;
        if (!best || margin > best.margin || (margin === best.margin && finish < best.finish)) best = { margin, local, finish, wait, departure };
      }
    }
    cache.set(id, best);
    return best;
  }
  function path(tick) {
    const result = solve(0, tick);
    if (!result) return null;
    const steps = [{ x: points[0].x, y: points[0].y, tOpen: tick * dt, tArrive: (tick + initialTravel) * dt, tExpire: null, waitTime: 0, stepDist: 0, label: '入口' }];
    for (const [i, command] of commands.entries()) {
      const choice = solve(i, tick);
      tick += choice.departure;
      steps.at(-1).tExpire = (tick + travelTicks + oldTicks) * dt;
      steps.push({ x: points[i + 1].x, y: points[i + 1].y, tOpen: tick * dt, tArrive: (tick + travelTicks) * dt, tExpire: null, waitTime: choice.wait * dt, stepDist: command.distance, label: command.label });
    }
    steps.at(-1).tExpire = (tick + (commands.length === 0 ? initialTravel : travelTicks) + hold) * dt;
    return { steps, minMargin: result.margin };
  }
  return { solve: startTick => solve(0, startTick), path };
}

function straightPrefix(x0, travelTicks, oldTicks, straightWait = 8) {
  const steps = [{ x: x0, y: 0, tOpen: 0, tArrive: 0, tExpire: null, waitTime: 0, stepDist: 0, label: '起点' }];
  const frontHold = travelTicks + oldTicks;
  while (steps.at(-1).x > goalRadius) {
    const current = steps.at(-1), point = { x: current.x - 50, y: 0 };
    const open = Math.round(current.tArrive / dt) + (steps.length === 1 ? 0 : straightWait);
    const oldMargin = clearance(current, Math.round(current.tOpen / dt), open + travelTicks + oldTicks);
    const nextMargin = clearance(point, open, open + travelTicks + frontHold);
    if (Math.min(oldMargin, nextMargin) < marginRequired) return { steps, blocked: { x: point.x, tOpen: open * dt } };
    current.tExpire = (open + travelTicks + oldTicks) * dt;
    steps.push({ x: point.x, y: 0, tOpen: open * dt, tArrive: (open + travelTicks) * dt, tExpire: null, waitTime: (steps.length === 1 ? 0 : straightWait) * dt, stepDist: 50, label: '一号位·直行' });
  }
  return { steps, blocked: null };
}

function verifyUnifiedPath(steps, travelSec, oldSec, holdSec) {
  let minMargin = Infinity;
  const eps = 1e-6;
  for (let i = 0; i < steps.length; i++) {
    const h = steps[i], prev = steps[i - 1], next = steps[i + 1];
    if (prev) {
      if (h.tOpen + eps < prev.tArrive) return { valid: false };
      if (Math.abs((h.tArrive - h.tOpen) - travelSec) > eps) return { valid: false };
    }
    const endT = next ? next.tArrive + oldSec : h.tArrive + holdSec;
    const res = isHoleSafeDuring(h.x, h.y, h.tOpen, endT, field, 1, marginRequired, { endInclusive: !next });
    if (!res.safe || res.margin < marginRequired) return { valid: false };
    if (res.margin < minMargin) minMargin = res.margin;
  }
  if (Math.hypot(steps.at(-1).x, steps.at(-1).y) > goalRadius + 1e-6) return { valid: false };
  return { valid: true, minMargin };
}

const H3 = Math.sqrt(3) / 2;
const DIRS_12 = [
  { label: '一号位', dx: -1, dy: 0 },
  { label: '左一', dx: -H3, dy: -0.5 }, { label: '右一', dx: -H3, dy: 0.5 },
  { label: '左二', dx: -0.5, dy: -H3 }, { label: '右二', dx: -0.5, dy: H3 },
  { label: '左三', dx: 0, dy: -1 }, { label: '右三', dx: 0, dy: 1 },
  { label: '左后二', dx: 0.5, dy: -H3 }, { label: '右后二', dx: 0.5, dy: H3 },
  { label: '左后一', dx: H3, dy: -0.5 }, { label: '右后一', dx: H3, dy: 0.5 },
  { label: '后退', dx: 1, dy: 0 },
];

class SearchQueue {
  heap = [];
  scanOrder = [];

  get length() { return this.heap.length; }

  before(a, b) {
    return a.f < b.f || (a.f === b.f && a.scanIndex < b.scanIndex);
  }

  place(index, node) {
    this.heap[index] = node;
    node.heapIndex = index;
  }

  rise(index, node) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(node, this.heap[parent])) break;
      this.place(index, this.heap[parent]);
      index = parent;
    }
    this.place(index, node);
  }

  push(node) {
    node.scanIndex = this.scanOrder.length;
    this.scanOrder.push(node);
    this.rise(this.heap.length, node);
  }

  pop() {
    const first = this.heap[0];
    const last = this.heap.pop();
    let index = 0;
    if (this.heap.length) {
      while (index * 2 + 1 < this.heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.heap.length && this.before(this.heap[child + 1], this.heap[child])) child++;
        if (!this.before(this.heap[child], last)) break;
        this.place(index, this.heap[child]);
        index = child;
      }
      this.place(index, last);
    }
    // Preserve the reference array's swap-with-last tie order.
    const moved = this.scanOrder.pop();
    if (moved !== first) {
      this.scanOrder[first.scanIndex] = moved;
      moved.scanIndex = first.scanIndex;
      this.rise(moved.heapIndex, moved);
    }
    return first;
  }
}

function connectMiddle(frontLast, endTargets, travelTicks, oldTicks) {
  const bestTarget = endTargets[0].entry;
  function trySnap(cur, target, targetPhases) {
    const dx = target.entry.x - cur.x, dy = target.entry.y - cur.y;
    if (Math.abs(dx) > 55 || Math.abs(dy) > 55) return null;
    const d1 = Math.abs(dx), d2 = Math.abs(dy), jumps = [];
    if (d1 > 0.01) jumps.push({ label: dx < 0 ? '一号位·衔接' : '后退·衔接', x: cur.x + dx, y: cur.y, dist: d1 });
    if (d2 > 0.01) { const prev = jumps.length ? jumps.at(-1) : cur; jumps.push({ label: dy < 0 ? '左三·衔接' : '右三·衔接', x: prev.x, y: target.entry.y, dist: d2 }); }
    if (jumps.length === 0) return null;
    const curOpenTick = Math.round(cur.tOpen / dt), curArriveTick = Math.round(cur.tArrive / dt);
    const phaseSet = new Set(targetPhases.map(p => Math.round(p.phase / dt)));
    if (jumps.length === 1) {
      for (let w = 0; w <= maxWait; w += 1) {
        const openTick = curArriveTick + w, p = openTick % phaseCount;
        if (!phaseSet.has(p)) continue;
        if (clearance(cur, curOpenTick, openTick + travelTicks + oldTicks) < marginRequired) break;
        if (clearance(jumps[0], openTick, openTick + travelTicks + oldTicks) >= marginRequired) {
          return { steps: [{ x: jumps[0].x, y: jumps[0].y, tOpen: openTick * dt, tArrive: (openTick + travelTicks) * dt, tExpire: null, waitTime: w * dt, stepDist: jumps[0].dist, label: jumps[0].label }], target, phaseTick: p, openTick };
        }
      }
      return null;
    }
    for (let w0 = 0; w0 <= maxWait; w0 += 1) {
      const open0 = curArriveTick + w0;
      if (clearance(cur, curOpenTick, open0 + travelTicks + oldTicks) < marginRequired) break;
      const arr0 = open0 + travelTicks;
      for (let w1 = 0; w1 <= maxWait; w1 += 1) {
        const open1 = arr0 + w1, p = open1 % phaseCount;
        if (!phaseSet.has(p)) continue;
        if (clearance(jumps[0], open0, open1 + travelTicks + oldTicks) < marginRequired) break;
        if (clearance(jumps[1], open1, open1 + travelTicks + oldTicks) >= marginRequired) {
          return { steps: [
            { x: jumps[0].x, y: jumps[0].y, tOpen: open0 * dt, tArrive: arr0 * dt, tExpire: (open1 + travelTicks + oldTicks) * dt, waitTime: w0 * dt, stepDist: jumps[0].dist, label: jumps[0].label },
            { x: jumps[1].x, y: jumps[1].y, tOpen: open1 * dt, tArrive: (open1 + travelTicks) * dt, tExpire: null, waitTime: w1 * dt, stepDist: jumps[1].dist, label: jumps[1].label },
          ], target, phaseTick: p, openTick: open1 };
        }
      }
    }
    return null;
  }

  const startNode = { x: frontLast.x, y: frontLast.y, tOpen: frontLast.tOpen, tArrive: frontLast.tArrive, g: frontLast.tArrive, h: Math.hypot(frontLast.x - bestTarget.x, frontLast.y - bestTarget.y) / 50 * 0.85 };
  startNode.f = startNode.g + 3.0 * startNode.h;
  const open = new SearchQueue();
  const visited = new Set();
  open.push(startNode);
  let expansions = 0;
  while (open.length > 0 && expansions < 12000) {
    const cur = open.pop();
    expansions++;
    for (const t of endTargets) {
      if (Math.abs(cur.x - t.entry.x) <= 55 && Math.abs(cur.y - t.entry.y) <= 55) {
        const snap = trySnap(cur, t, t.phases);
        if (snap) {
          const steps = [];
          for (let node = cur; node.parent; node = node.parent) steps.push(node.step);
          return { middleSteps: [...steps.reverse(), ...snap.steps], target: t, phaseTick: snap.phaseTick, snapOpenTick: snap.openTick };
        }
      }
    }
    const curOpenTick = Math.round(cur.tOpen / dt), curArriveTick = Math.round(cur.tArrive / dt);
    let guide = bestTarget, bestD = Infinity;
    for (const t of endTargets) { const d = Math.hypot(cur.x - t.entry.x, cur.y - t.entry.y); if (d < bestD) { bestD = d; guide = t.entry; } }
    const distsToTry = cur.x > 350 ? [50, 25] : [50, 30, 15, 5];
    const waitsToTry = cur.x > 350 ? [0, 2, 4, 6, 8, 12, 16, 24] : Array.from({ length: maxWait + 1 }, (_, i) => i);
    const waits = [];
    for (const w of waitsToTry) {
      if (clearance(cur, curOpenTick, curArriveTick + w + travelTicks + oldTicks) < marginRequired) break;
      waits.push(w);
    }
    for (const dir of DIRS_12) for (const dist of distsToTry) {
      const nx = cur.x + dist * dir.dx, ny = cur.y + dist * dir.dy;
      if (nx < 50 || nx > frontLast.x + 200 || Math.abs(ny) > 350) continue;
      for (const w of waits) {
        const openTick = curArriveTick + w;
        if (clearance({ x: nx, y: ny }, openTick, openTick + travelTicks + oldTicks) < marginRequired) continue;
        const arrTick = openTick + travelTicks;
        const vKey = `${Math.round(nx / 10)},${Math.round(ny / 10)},${arrTick}`;
        if (visited.has(vKey)) continue;
        visited.add(vKey);
        const h = Math.hypot(nx - guide.x, ny - guide.y) / 50 * 0.85;
        const step = { x: nx, y: ny, tOpen: openTick * dt, tArrive: arrTick * dt, tExpire: null,
          waitTime: w * dt, stepDist: dist, label: `${dir.label}·中段` };
        open.push({ ...step, step, parent: cur, f: arrTick * dt + 3.0 * h });
      }
    }
  }
  return null;
}

const grid = radii.flatMap(r => bearings.map(phi => ({ r, phi, x: r * Math.cos(phi * radians), y: r * Math.sin(phi * radians) })));
const endEntriesByHypothesis = Object.fromEntries(Object.entries(HYPOTHESES).map(([id, hypo]) => [
  id,
  grid.map(entry => ({ entry, points: landmarks(hypo, entry, END) })).filter(e => radius(e.points.at(-1)) <= goalRadius + geomEpsilon),
]));

const startGrid = range(2000, 6000, 50);
const candidateLifetimes = range(5, 20, 1);
const travelGrid = range(4, 20, 1);
const asSeconds = tick => tick / 10;
const normalizeTime = time => asSeconds(Math.round(time / dt));

function exportPath(hypothesisId, x0, bt, tTicks, oTicks, prefix, front, connection, ending) {
  const travel = asSeconds(tTicks);
  const oldLifetime = asSeconds(oTicks);
  const lastMiddle = connection.middleSteps.at(-1);
  const entry = { ...ending[0], label: lastMiddle.label, waitTime: lastMiddle.waitTime, stepDist: lastMiddle.stepDist };
  const segments = [
    ['prefix', prefix],
    ['front', front.slice(1)],
    ['middle', [...connection.middleSteps.slice(0, -1), entry]],
    ['end', ending.slice(1)],
  ];
  const steps = segments.flatMap(([segment, items]) => items.map(step => ({
    ...step, segment, tOpen: normalizeTime(step.tOpen), tArrive: normalizeTime(step.tArrive),
    waitTime: normalizeTime(step.waitTime), tExpire: null,
  })));
  const finalHold = asSeconds(endHold);
  const validation = verifyUnifiedPath(steps, travel, oldLifetime, finalHold);
  if (!validation.valid) return null;
  let minMargin = Infinity;
  for (const [index, step] of steps.entries()) {
    step.index = index;
    const next = steps[index + 1];
    step.tExpire = normalizeTime(next ? next.tArrive + oldLifetime : step.tArrive + finalHold);
    // Export uses the requested closed interval, in addition to the reference verifier.
    const margin = isHoleSafeDuring(step.x, step.y, step.tOpen, step.tExpire, field, 1, marginRequired).margin;
    if (margin < marginRequired) return null;
    step.minMargin = margin;
    minMargin = Math.min(minMargin, margin);
  }
  const { r: entryR, phi: entryPhi } = connection.target.entry;
  return {
    hypothesis: hypothesisId, travel, oldLifetime, x0, bt, entryR, entryPhi, totalSteps: steps.length - 1,
    finishTime: Math.max(...steps.map(step => step.tExpire)), minMargin, steps,
  };
}

function scanPair(hypothesisId, tTicks, oTicks, starts = startGrid) {
  const hypothesis = HYPOTHESES[hypothesisId];
  const endTargets = [];
  for (const { entry, points } of endEntriesByHypothesis[hypothesisId]) {
    const planner = schedule(points, END, tTicks, oTicks, { initialTravel: tTicks, phasePeriod: phaseCount });
    const phases = [];
    for (let phase = 0; phase < phaseCount; phase++) {
      const result = planner.solve(anchorTick + phase);
      if (result) phases.push({ phase: phase * dt, margin: result.margin });
    }
    if (phases.length) endTargets.push({ entry, points, phases });
  }
  const paths = [];
  if (!endTargets.length) return { hypothesis: hypothesisId, tTicks, oTicks, endEntries: 0, paths };
  for (const x0 of starts) {
    const { steps, blocked } = straightPrefix(x0, tTicks, oTicks, 8);
    if (!blocked) continue;
    for (const bt of backtracks) {
      const cut = steps.length - 1 - bt;
      if (cut < 0) continue;
      const entry = steps[cut];
      const res = schedule(landmarks(hypothesis, entry, FRONT), FRONT, tTicks, oTicks, {
        initialTravel: Math.round((entry.tArrive - entry.tOpen) / dt), hold: tTicks + oTicks,
      }).path(Math.round(entry.tOpen / dt));
      if (!res) continue;
      const connection = connectMiddle(res.steps.at(-1), endTargets, tTicks, oTicks);
      if (!connection) continue;
      const ending = schedule(connection.target.points, END, tTicks, oTicks, {
        initialTravel: tTicks, phasePeriod: phaseCount,
      }).path(connection.snapOpenTick);
      if (!ending) continue;
      const path = exportPath(hypothesisId, x0, bt, tTicks, oTicks, steps.slice(0, cut + 1), res.steps, connection, ending.steps);
      if (!path) continue;
      paths.push(path);
      break;
    }
  }
  return { hypothesis: hypothesisId, tTicks, oTicks, endEntries: endTargets.length, paths };
}

function verifyExport(data) {
  const pairs = new Map();
  let checkedHoles = 0;
  for (const path of data.paths) {
    const { hypothesis = 'H_fix_45_90', steps, x0, travel, oldLifetime, bt, totalSteps, finishTime, minMargin } = path;
    const key = `${hypothesis}/${travel}/${oldLifetime}`;
    if (!pairs.has(key)) pairs.set(key, new Set());
    const starts = pairs.get(key);
    if (!startGrid.includes(x0) || starts.has(x0) || !backtracks.includes(bt) || totalSteps !== steps.length - 1
      || steps[0].x !== x0 || steps[0].y !== 0 || steps[0].tOpen !== 0 || steps[0].tArrive !== 0) {
      throw new Error(`扫描起点或路线记录有误: ${key}, ${x0}`);
    }
    starts.add(x0);
    const front = steps.findIndex(step => step.segment === 'front');
    const middle = steps.findIndex(step => step.segment === 'middle');
    const end = steps.findIndex(step => step.segment === 'end');
    if (front < 1 || middle !== front + FRONT.length || end <= middle || steps.length - end !== END.length) {
      throw new Error('导出阶段有误');
    }
    const geometry = [
      [front, FRONT, 'front'],
      [end, END, 'end'],
    ];
    for (const [start, commands, segment] of geometry) {
      const points = landmarks(HYPOTHESES[hypothesis], steps[start - 1], commands);
      commands.forEach((command, index) => {
        const step = steps[start + index];
        if (step.segment !== segment || Math.hypot(step.x - points[index + 1].x, step.y - points[index + 1].y) > 1e-6
          || (command.wait !== undefined && step.waitTime !== command.wait)) throw new Error('实际跳法与原片指令不符');
      });
    }
    let measuredMargin = Infinity;
    for (const [index, step] of steps.entries()) {
      const previous = steps[index - 1];
      const next = steps[index + 1];
      const expiry = normalizeTime(next ? next.tArrive + oldLifetime : step.tArrive + endHold * dt);
      if (step.index !== index || step.tExpire !== expiry || (previous
        && (step.tOpen < previous.tArrive || normalizeTime(step.tArrive - step.tOpen) !== travel
          || normalizeTime(step.tOpen - previous.tArrive) !== step.waitTime))) {
        throw new Error('时序或旧洞寿命有误');
      }
      if (previous && index < front && (step.x !== previous.x - 50 || step.y !== 0 || step.stepDist !== 50
        || step.segment !== 'prefix' || step.waitTime !== (index === 1 ? 0 : 0.8))) throw new Error('直行前奏有误');
      if (index >= middle && index < end) {
        const dx = step.x - previous.x;
        const dy = step.y - previous.y;
        // The reference snap ignores one axis within 0.01 m of the target.
        const alongDirection = DIRS_12.some(dir => Math.abs(dx - step.stepDist * dir.dx) <= 0.010001
          && Math.abs(dy - step.stepDist * dir.dy) <= 0.010001);
        if (step.segment !== 'middle' || step.stepDist <= 0 || step.stepDist > 55.000001 || !alongDirection) {
          throw new Error('中段步长或十二向衔接有误');
        }
      }
      const check = isHoleSafeDuring(step.x, step.y, step.tOpen, expiry, field, 1, marginRequired);
      if (check.margin < marginRequired || Math.abs(check.margin - step.minMargin) > 1e-8) throw new Error('闭区间裕度复核失败');
      checkedHoles++;
      measuredMargin = Math.min(measuredMargin, check.margin);
    }
    if (radius(steps.at(-1)) > goalRadius + geomEpsilon || measuredMargin !== minMargin
      || finishTime !== Math.max(...steps.map(step => step.tExpire))) throw new Error('终点或汇总指标复核失败');
  }
  for (const row of data.scan.pairs) {
    const h = row.hypothesis ?? 'H_fix_45_90';
    if ((pairs.get(`${h}/${row.travel}/${row.oldLifetime}`)?.size ?? 0) !== row.count) throw new Error('扫描计数有误');
  }
  return { paths: data.paths.length, checkedHoles };
}

if (!isMainThread) {
  parentPort.on('message', ([hypothesisId, travel, lifetime, starts]) => {
    parentPort.postMessage(scanPair(hypothesisId, travel, lifetime, starts));
  });
} else {
  const args = process.argv.slice(2);
  if (args[0] === '--probe') {
    const result = scanPair('H_fix_60_90', Math.round(Number(args[1]) / dt), Math.round(Number(args[2]) / dt), args.slice(3).map(Number));
    console.log(result.endEntries, result.paths.map(path => [path.x0, path.totalSteps, path.minMargin]));
  } else if (args[0] === '--verify') {
    const archive = readFileSync(new URL('./unified_paths.json.gz', import.meta.url));
    console.log(verifyExport(JSON.parse(gunzipSync(archive).toString('utf8'))));
  } else {
    const hypoIds = Object.keys(HYPOTHESES);
    const jobs = hypoIds.flatMap(id => travelGrid.flatMap(travel => candidateLifetimes.map(lifetime => [id, travel, lifetime])));
    const numberWorkers = Math.min(6, availableParallelism(), jobs.length);
    const results = [];
    await Promise.all(Array.from({ length: numberWorkers }, () => new Promise((done, fail) => {
      const worker = new Worker(new URL(import.meta.url));
      function next() {
        if (jobs.length) worker.postMessage(jobs.shift());
        else worker.terminate().then(done, fail);
      }
      worker.on('error', fail);
      worker.on('message', result => {
        results.push(result);
        console.error(`${result.hypothesis} travel=${asSeconds(result.tTicks)}, oldLifetime=${asSeconds(result.oTicks)}, 末段入口=${result.endEntries}, 贯通=${result.paths.length}/${startGrid.length}`);
        next();
      });
      next();
    })));
    results.sort((a, b) => a.hypothesis.localeCompare(b.hypothesis) || b.tTicks - a.tTicks || a.oTicks - b.oTicks);
    for (const r of results) r.paths.sort((a, b) => a.bt - b.bt || a.x0 - b.x0);
    const paths = results.flatMap(result => result.paths);
    const data = {
      hypotheses: hypoIds, dt, holeRadius: 1, marginRequired,
      scan: {
        x0: [startGrid[0], startGrid.at(-1), 50], startCount: startGrid.length,
        lifetimeSearch: [0.5, 2.0, 0.1],
        pairs: results.map(({ hypothesis, tTicks, oTicks, endEntries, paths }) => ({
          hypothesis, travel: asSeconds(tTicks), oldLifetime: asSeconds(oTicks), endEntries, count: paths.length,
        })),
      },
      paths,
    };
    const output = new URL('./unified_paths.json', import.meta.url);
    const temporary = new URL('./unified_paths.json.tmp', import.meta.url);
    const archive = new URL('./unified_paths.json.gz', import.meta.url);
    const temporaryArchive = new URL('./unified_paths.json.gz.tmp', import.meta.url);
    const json = JSON.stringify(data);
    writeFileSync(temporary, json);
    writeFileSync(temporaryArchive, gzipSync(json));
    renameSync(temporary, output);
    renameSync(temporaryArchive, archive);
    console.log(`已导出 ${paths.length} 条贯通路线。`);
  }
}
