import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createWaveField, SOURCES } from '../../波源立体几何重建/2d/wave-field.js';
import { isHoleSafeDuring, validatePath } from '../pathfinding/solver.js';

export const HYPOTHESES = [
  { id: 'H_dyn_30_60', dynamic: true, two: 30, three: 60 },
  { id: 'H_dyn_45_90', dynamic: true, two: 45, three: 90 },
  { id: 'H_fix_30_60', dynamic: false, two: 30, three: 60 },
  { id: 'H_fix_45_90', dynamic: false, two: 45, three: 90 },
];

const instruction = (label, turn, distance, wait) => ({ label, turn, distance, wait });
export const FRONT = [
  instruction('左三', -3, 43), instruction('一号位', 0, 50), instruction('左三', -3, 45),
  instruction('右三', 3, 30), instruction('右三', 3, 47), instruction('左三', -3, 40),
  instruction('一号位·二段跳 1', 0, 30), instruction('一号位·二段跳 2', 0, 30, 2),
];
export const END = [
  instruction('左二', -2, 53), instruction('右二', 2, 40), instruction('一号位', 0, 20),
  instruction('左二', -2, 30), instruction('右二', 2, 45),
];

export const field = createWaveField({ sources: SOURCES, maxRadius: Infinity });
const dt = 0.25;
const travel = 2; // ticks
const oldLifetime = 4;
const frontHold = travel + oldLifetime;
const endHold = 4;
const marginRequired = 1;
const geomEpsilon = 1e-9;
const maxWait = 16;
const period = 10;
const phaseCount = period / dt;
const goalRadius = 50;
const radians = Math.PI / 180;
const radius = ({ x, y }) => Math.hypot(x, y);
const bearing = ({ x, y }) => Math.atan2(y, x) / radians;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const range = (min, max, step) => Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step);
const extent = values => values.length ? [Math.min(...values), Math.max(...values)] : null;
const radii = range(100, 260, 5);
const bearings = range(-90, 90, 5);
const starts = range(10000, 30000, 200);
const backtracks = [0, 1, 2];
const maxEndRadius = radii.at(-1) + END.reduce((sum, jump) => sum + jump.distance, 0);
// Past this anchor, each source has an older surviving ring beyond the whole end grid.
const phaseAnchor = Math.ceil(Math.max(...SOURCES.map(source => source.startTime
  + Math.hypot(radius(source) + maxEndRadius + 2, source.z) / source.speed + period)) / period) * period;

export function landmarks(hypothesis, start, commands) {
  const points = [{ x: start.x, y: start.y }];
  for (const command of commands) {
    const point = points.at(-1);
    const r = radius(point);
    const inwardX = hypothesis.dynamic && r > 0 ? -point.x / r : -1;
    const inwardY = hypothesis.dynamic && r > 0 ? -point.y / r : 0;
    const slot = Math.abs(command.turn);
    const offset = (slot === 2 ? hypothesis.two : slot === 3 ? hypothesis.three : 0) * radians;
    const cos = Math.abs(offset) === Math.PI / 2 ? 0 : Math.cos(offset);
    const sin = Math.sign(command.turn) * Math.sin(offset);
    // The local right vector is +y when the forward vector is -x.
    points.push({
      x: point.x + command.distance * (inwardX * cos + inwardY * sin),
      y: point.y + command.distance * (inwardY * cos - inwardX * sin),
    });
  }
  return points;
}

function clearance(point, from, to, waveField, endInclusive = false) {
  return isHoleSafeDuring(point.x, point.y, from * dt, to * dt, waveField, 1, marginRequired, { endInclusive }).margin;
}

function hole(point, index, open, arrive, waitTime = 0, stepDist = 0, label = '入口') {
  return { ...point, index, tOpen: open * dt, tArrive: arrive * dt, tExpire: null, waitTime, stepDist, label };
}

export function straightPrefix(x0, waveField = field) {
  const steps = [hole({ x: x0, y: 0 }, 0, 0, 0, 0, 0, '起点')];
  while (steps.at(-1).x > goalRadius) {
    const current = steps.at(-1);
    const point = { x: current.x - 50, y: 0 };
    const open = current.tArrive / dt;
    const oldMargin = clearance(current, current.tOpen / dt, open + travel + oldLifetime, waveField);
    const nextMargin = clearance(point, open, open + travel + frontHold, waveField);
    if (Math.min(oldMargin, nextMargin) < marginRequired) {
      return { steps, blocked: { x: point.x, tOpen: open * dt, oldMargin, nextMargin } };
    }
    current.tExpire = (open + travel + oldLifetime) * dt;
    current.minMargin = oldMargin;
    steps.push(hole(point, steps.length, open, open + travel, 0, 50, '一号位·直行'));
  }
  return { steps, blocked: null };
}

export function schedule(points, commands, {
  waveField = field, initialTravel = 0, hold = endHold, phasePeriod = 0,
} = {}) {
  const cacheByHole = points.map(() => ({ ranges: new Map(), moments: new Map(), paths: new Map() }));
  const key = tick => phasePeriod ? tick % phasePeriod : tick;

  function cachedMargin(index, tick, instant = false) {
    const cache = instant ? cacheByHole[index].moments : cacheByHole[index].ranges;
    const id = key(tick);
    if (!cache.has(id)) cache.set(id, clearance(points[index], tick, tick + (instant ? 0 : 1), waveField, instant));
    return cache.get(id);
  }

  function solve(index, tick) {
    const cache = cacheByHole[index].paths;
    const id = key(tick);
    if (cache.has(id)) return cache.get(id);
    const openToArrive = index === 0 ? initialTravel : travel;
    let best = null;
    let local = Infinity;
    if (index === commands.length) {
      const finish = openToArrive + hold;
      for (let offset = 0; offset < finish; offset++) local = Math.min(local, cachedMargin(index, tick + offset));
      local = Math.min(local, cachedMargin(index, tick + finish, true));
      if (local >= marginRequired) best = { margin: local, local, finish };
    } else {
      const fixedWait = commands[index].wait;
      const firstWait = fixedWait === undefined ? 0 : fixedWait / dt;
      const lastWait = fixedWait === undefined ? maxWait : firstWait;
      let checked = 0;
      for (let wait = firstWait; wait <= lastWait; wait++) {
        const departure = openToArrive + wait;
        const expiry = departure + travel + oldLifetime;
        // Extending one hole lifetime can only lower its minimum margin.
        while (checked < expiry && local >= marginRequired) {
          local = Math.min(local, cachedMargin(index, tick + checked++));
        }
        if (local < marginRequired) break;
        const tail = solve(index + 1, tick + departure);
        if (!tail) continue;
        const margin = Math.min(local, tail.margin);
        const finish = departure + tail.finish;
        if (!best || margin > best.margin || (margin === best.margin && finish < best.finish)) {
          best = { margin, local, finish, wait, departure };
        }
      }
    }
    cache.set(id, best);
    return best;
  }

  function path(tick) {
    const result = solve(0, tick);
    if (!result) return null;
    const steps = [hole(points[0], 0, tick, tick + initialTravel)];
    for (const [i, command] of commands.entries()) {
      const choice = solve(i, tick);
      tick += choice.departure;
      steps.at(-1).tExpire = (tick + travel + oldLifetime) * dt;
      steps.at(-1).minMargin = choice.local;
      steps.push(hole(points[i + 1], i + 1, tick, tick + travel, choice.wait * dt, command.distance, command.label));
    }
    const terminal = solve(commands.length, tick);
    steps.at(-1).minMargin = terminal.local;
    return { steps, minMargin: result.margin, finishTime: steps.at(-1).tArrive + hold * dt };
  }

  return { solve: startTick => solve(0, startTick), path };
}

function scanFront(hypothesis, prefixes) {
  const hits = [];
  for (const { x0, steps, blocked } of prefixes) {
    if (!blocked) continue;
    for (const backtrack of backtracks) {
      const cutIndex = steps.length - 1 - backtrack;
      if (cutIndex < 0) continue;
      const entry = steps[cutIndex];
      const points = landmarks(hypothesis, entry, FRONT);
      const result = schedule(points, FRONT, { initialTravel: (entry.tArrive - entry.tOpen) / dt, hold: frontHold })
        .path(entry.tOpen / dt);
      if (result) hits.push({ x0, cutIndex, backtrack, prefix: steps, rejectedStraight: blocked, ...result });
    }
  }
  return hits;
}

function polarGrid() {
  return radii.flatMap(r => bearings.map(phi => {
    const inner = Math.max(radii[0], r - 2.5);
    const outer = Math.min(radii.at(-1), r + 2.5);
    const angle = Math.min(bearings.at(-1), phi + 2.5) - Math.max(bearings[0], phi - 2.5);
    return {
      r, phi, x: r * Math.cos(phi * radians), y: r * Math.sin(phi * radians),
      area: (outer ** 2 - inner ** 2) * angle * radians / 2,
    };
  }));
}

function scanEnd(hypothesis, grid) {
  const hits = [];
  let geometricCells = 0;
  let feasibleTriples = 0;
  let feasibleArea = 0;
  let meanPhaseArea = 0;
  for (const entry of grid) {
    const points = landmarks(hypothesis, entry, END);
    if (radius(points.at(-1)) > goalRadius + geomEpsilon) continue;
    geometricCells++;
    const planner = schedule(points, END, { phasePeriod: phaseCount });
    const phases = [];
    for (let phase = 0; phase < phaseCount; phase++) {
      const result = planner.solve(phaseAnchor / dt + phase);
      if (result) phases.push({ phase: phase * dt, minMargin: result.margin, duration: result.finish * dt });
    }
    if (!phases.length) continue;
    feasibleTriples += phases.length;
    feasibleArea += entry.area;
    meanPhaseArea += entry.area * phases.length / phaseCount;
    hits.push({ entry, points, phases, maxMargin: Math.max(...phases.map(phase => phase.minMargin)) });
  }
  return { hits, geometricCells, feasibleTriples, feasibleArea, meanPhaseArea };
}

function matchSegments(front, end) {
  const nearest = [];
  let best = null;
  for (const route of front) {
    if (!end.length) break;
    const last = route.steps.at(-1);
    let closest = null;
    for (const target of end) {
      const gap = distance(last, target.entry);
      const margin = Math.min(route.minMargin, target.maxMargin);
      if (!closest || gap < closest.gap || (gap === closest.gap && margin > closest.margin)) {
        closest = { route, target, gap, margin, bearingGap: Math.abs(bearing(last) - target.entry.phi) };
      }
    }
    nearest.push(closest.gap);
    if (!best || closest.gap < best.gap || (closest.gap === best.gap && closest.margin > best.margin)) best = closest;
  }
  nearest.sort((a, b) => a - b);
  return {
    best,
    medianGap: nearest.length ? (nearest[Math.floor((nearest.length - 1) / 2)] + nearest[Math.floor(nearest.length / 2)]) / 2 : null,
  };
}

function bestBy(items, score) {
  return items.reduce((best, item) => best === null || score(item) > score(best) ? item : best, null);
}

function verified(steps, options) {
  const result = validatePath(steps, field, { safetyMargin: marginRequired, allowEqualMargin: true, ...options });
  if (!result.valid) throw new Error(`独立复核失败: ${JSON.stringify(result)}`);
  return result.samples;
}

function frontReport(route) {
  const steps = [...route.prefix.slice(0, route.cutIndex), ...route.steps]
    .map((step, index) => ({ ...step, index, ...(index === route.cutIndex ? { label: '前段切入' } : {}) }));
  const entry = steps[route.cutIndex];
  return {
    x0: route.x0, straightJumps: route.cutIndex, backtrack: route.backtrack,
    entry: { x: entry.x, y: entry.y, tArrive: entry.tArrive },
    autoEntry: { x: route.prefix.at(-1).x, tArrive: route.prefix.at(-1).tArrive },
    rejectedStraight: route.rejectedStraight,
    minMargin: route.minMargin, prefixAndFrontMargin: Math.min(...steps.map(step => step.minMargin)),
    finishTime: route.finishTime,
    samples: verified(steps, { xStart: route.x0, goalRadius: radius(steps.at(-1)), holdTime: frontHold * dt, maxStep: 50 + geomEpsilon }),
    steps,
  };
}

function endReport(target, minTime = phaseAnchor, sharedMargin = Infinity) {
  let choice;
  for (const option of target.phases) {
    const cycle = Math.max(0, Math.ceil((minTime - phaseAnchor - option.phase) / period));
    const entryTime = phaseAnchor + cycle * period + option.phase;
    const matchedMargin = Math.min(sharedMargin, option.minMargin);
    if (!choice || matchedMargin > choice.matchedMargin
        || (matchedMargin === choice.matchedMargin && entryTime + option.duration < choice.entryTime + choice.duration)) {
      choice = { ...option, entryTime, matchedMargin };
    }
  }
  const route = schedule(target.points, END, { phasePeriod: phaseCount }).path(choice.entryTime / dt);
  return {
    rIn: target.entry.r, phiIn: target.entry.phi, phase: choice.phase, tIn: choice.entryTime,
    minMargin: route.minMargin, finishTime: route.finishTime,
    samples: verified(route.steps, {
      start: route.steps[0], maxStep: 53 + geomEpsilon, goalRadius: goalRadius + geomEpsilon, holdTime: endHold * dt,
    }),
    steps: route.steps,
  };
}

export function runExperiment() {
  const started = performance.now();
  const prefixes = starts.map(x0 => ({ x0, ...straightPrefix(x0) }));
  const grid = polarGrid();
  const cases = [];
  for (const hypothesis of HYPOTHESES) {
    const front = scanFront(hypothesis, prefixes);
    const end = scanEnd(hypothesis, grid);
    const { best, medianGap } = matchSegments(front, end.hits);
    const bestFront = bestBy(front, route => route.minMargin);
    const bestEnd = bestBy(end.hits, target => target.maxMargin);
    const autoHits = new Set(front.filter(route => route.backtrack === 0).map(route => route.x0)).size;
    const feasibleStarts = [...new Set(front.map(route => route.x0))];
    const startHits = feasibleStarts.length;
    const minBridgeJumps = best ? Math.ceil(best.gap / 50) : null;
    const minBridgeArrival = best ? best.route.steps.at(-1).tArrive + minBridgeJumps * travel * dt : null;
    cases.push({
      hypothesis: hypothesis.id,
      front: {
        autoHits, autoHitRate: autoHits / starts.length, startHits, hitRate: startHits / starts.length,
        hitsByBacktrack: backtracks.map(backtrack => front.filter(route => route.backtrack === backtrack).length),
        maxMargin: bestFront?.minMargin ?? null, maxMarginStart: bestFront?.x0 ?? null,
        feasibleStarts, startRange: extent(feasibleStarts),
        branchXRange: extent(front.map(route => route.steps[0].x)),
        branchTimeRange: extent(front.map(route => route.steps[0].tArrive)),
        convergingCuts: front.filter(route => radius(route.steps.at(-1)) < radius(route.steps[0])).length,
      },
      end: {
        geometricCells: end.geometricCells, feasibleCells: end.hits.length, feasibleTriples: end.feasibleTriples,
        hitRate: end.feasibleTriples / (grid.length * phaseCount),
        geometricHitRate: end.geometricCells ? end.feasibleTriples / (end.geometricCells * phaseCount) : null,
        feasibleArea: end.feasibleArea, meanPhaseArea: end.meanPhaseArea, maxMargin: bestEnd?.maxMargin ?? null,
        rInRange: extent(end.hits.map(hit => hit.entry.r)),
        phiInRange: extent(end.hits.map(hit => hit.entry.phi)),
      },
      connection: {
        minGap: best?.gap ?? null, medianGap, bearingGap: best?.bearingGap ?? null,
        inwardGap: best ? radius(best.route.steps.at(-1)) - best.target.entry.r : null,
        minBridgeJumps, minBridgeArrival, matchMargin: best?.margin ?? null,
      },
      match: best ? {
        front: frontReport(best.route),
        end: endReport(best.target, minBridgeArrival, best.route.minMargin),
      } : null,
      standaloneFront: !best && bestFront ? frontReport(bestFront) : null,
      standaloneEnd: !best && bestEnd ? endReport(bestEnd) : null,
    });
  }
  const best = cases.filter(row => row.match).sort((a, b) => a.connection.minGap - b.connection.minGap
    || b.connection.matchMargin - a.connection.matchMargin)[0];
  return {
    setup: {
      xStart: [starts[0], starts.at(-1), 200], startCount: starts.length, blockedStarts: prefixes.filter(p => p.blocked).length,
      cutBacktracks: backtracks, wait: [0, maxWait * dt, dt], lockedWait: 2, holeRadius: 1, safetyMargin: marginRequired,
      phaseAnchor, phasePeriod: period, phaseStep: dt, phaseCount,
      rIn: [radii[0], radii.at(-1), 5], phiIn: [bearings[0], bearings.at(-1), 5],
      gridCells: grid.length, gridTriples: grid.length * phaseCount, gridArea: grid.reduce((sum, entry) => sum + entry.area, 0),
      frontHold: frontHold * dt, endHold: endHold * dt,
      ranking: '仅在前后段均通过的假说中，以前段终点到可行末段入口的最短直线距离选匹配；同距优先两段较小裕度更大者。',
    },
    bestHypothesis: best?.hypothesis ?? null, cases, computeMs: performance.now() - started,
  };
}

const number = (value, digits = 2) => value === null ? '—' : value.toFixed(digits);
const percentage = value => value === null ? '—' : `${number(value * 100)}%`;

function printRoute(heading, steps) {
  console.log(heading);
  console.table(steps.map(step => ({
    序号: step.index, 指令: step.label, x: number(step.x, 3), y: number(step.y, 3),
    '等待 (s)': number(step.waitTime), '开启 (s)': number(step.tOpen), '抵达 (s)': number(step.tArrive),
    '消失 (s)': number(step.tExpire), '裕度 (m)': number(step.minMargin, 3),
  })));
}

function printResults(result) {
  console.log(`起点 ${result.setup.startCount} 个，${result.setup.blockedStarts} 个自动遇波。末段每组 ${result.setup.gridCells} 点 × ${result.setup.phaseCount} 相位，相位零点 t=${result.setup.phaseAnchor} s。`);
  console.table(result.cases.map(({ hypothesis, front, end, connection }) => ({
    假说: hypothesis,
    自动切入: front.autoHits, '含提前切入': front.startHits, 前段命中率: percentage(front.hitRate),
    '前段最大裕度 (m)': number(front.maxMargin),
    几何可行点: end.geometricCells, 末段可行点: end.feasibleCells, 可行三元组: end.feasibleTriples,
    末段命中率: percentage(end.hitRate), 几何通过后命中率: percentage(end.geometricHitRate),
    '末段面积 (m²)': number(end.feasibleArea), '末段最大裕度 (m)': number(end.maxMargin),
    '最短衔接 (m)': number(connection.minGap), '衔接中位数 (m)': number(connection.medianGap),
    '入口方位差 (°)': number(connection.bearingGap),
  })));
  const best = result.cases.find(row => row.hypothesis === result.bestHypothesis);
  if (best) {
    const { front, end } = best.match;
    console.log(`最优几何匹配 ${best.hypothesis}，起点 ${front.x0} m，直行 ${front.straightJumps} 跳，t=${front.entry.tArrive} s 切入 x=${front.entry.x} m，提前 ${front.backtrack} 跳。`);
    console.log(`缺失中段至少 ${best.connection.minBridgeJumps} 跳（仅距离下界）。末段入口 r=${end.rIn} m、φ=${end.phiIn}°、相位 ${end.phase} s、t=${end.tIn} s。`);
    printRoute(`前段（独立复核 ${front.samples} 点，含上游直行）`, front.steps.slice(front.straightJumps));
    printRoute(`末段（独立复核 ${end.samples} 点）`, end.steps);
  } else {
    console.log('没有同时命中前段和末段的假说。各组独立最优走法见 JSON 输出。');
  }
  console.log(`计算及复核用时 ${number(result.computeMs, 0)} ms。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runExperiment();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else printResults(result);
}
