import { createWaveField, DEFAULTS, SOURCES } from '../2d/wave-field.js';

const travelTime = 0.5;
const oldLifetime = 1;
const goalHold = 1;
const exactSearchExpansions = 64;
const angles = [0, 15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 120, -120, 150, -150, 180]
  .map(degrees => degrees * Math.PI / 180);
const waits = [0, 0.5, 1, 2, 3.5, 5];
const field = createWaveField({ sources: SOURCES, maxRadius: DEFAULTS.maxRadius });
const after = time => time + 32 * Number.EPSILON * Math.max(1, Math.abs(time));

function radiusAt(wave, time) {
  if (time === wave.contact) return 0;
  const depth = Math.abs(wave.z);
  const radius = wave.speed * (time - wave.emittedAt);
  return Math.sqrt(Math.max(0, (radius - depth) * (radius + depth)));
}

function measure(x, y, tStart, tEnd, waves, holeRadius, safetyMargin, endInclusive = true) {
  let margin = Infinity;
  let blockedUntil = -Infinity;
  const limit = holeRadius + safetyMargin;

  for (const wave of waves) {
    const start = Math.max(tStart, wave.contact);
    const end = Math.min(tEnd, wave.expiry);
    if (start > end || (!endInclusive && start === tEnd)) continue;

    const distance = Math.hypot(x - wave.cx, y - wave.cy);
    const inner = Math.max(0, distance - limit);
    const outer = distance + limit;
    const enter = Math.max(wave.contact, wave.emittedAt + Math.hypot(inner, wave.z) / wave.speed);
    const exit = Math.min(wave.expiry, wave.emittedAt + Math.hypot(outer, wave.z) / wave.speed);
    if (enter <= exit && exit >= tStart && (enter < tEnd || (endInclusive && enter === tEnd))) {
      blockedUntil = Math.max(blockedUntil, exit);
    }
    // The ring radius grows monotonically, so the endpoints bound every radial gap.
    const gap = Math.max(distance - radiusAt(wave, end), radiusAt(wave, start) - distance, 0);
    margin = Math.min(margin, gap - holeRadius);
  }
  return { safe: blockedUntil === -Infinity, margin, blockedUntil };
}

export function isHoleSafeDuring(x, y, tStart, tEnd, waveField, holeRadius = 1, safetyMargin = 0) {
  if (![x, y, tStart, tEnd, holeRadius, safetyMargin].every(Number.isFinite)
      || tStart > tEnd || holeRadius < 0 || safetyMargin < 0) {
    throw new RangeError('需要有限坐标、有效时间区间与非负半径和裕度');
  }
  const { safe, margin } = measure(x, y, tStart, tEnd, waveField.getEmissionsBetween(tStart, tEnd), holeRadius, safetyMargin);
  return { safe, margin };
}

function preferred(a, b) {
  return a.arrivalBound < b.arrivalBound || (a.arrivalBound === b.arrivalBound
    && (a.arrive > b.arrive
      || (a.arrive === b.arrive && (a.margin > b.margin
        || (a.margin === b.margin && a.estimate < b.estimate)))));
}

class OpenSet {
  nodes = [];
  compare = preferred;

  guideByProgress() {
    this.compare = (a, b) => a.guidedEstimate < b.guidedEstimate
      || (a.guidedEstimate === b.guidedEstimate && preferred(a, b));
    const pending = this.nodes;
    this.nodes = [];
    for (const node of pending) this.push(node);
  }

  push(node) {
    const nodes = this.nodes;
    let index = nodes.length;
    nodes.push(node);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.compare(node, nodes[parent])) break;
      nodes[index] = nodes[parent];
      index = parent;
    }
    nodes[index] = node;
  }

  pop() {
    const nodes = this.nodes;
    const first = nodes[0];
    const last = nodes.pop();
    if (!nodes.length) return first;
    let index = 0;
    while (index * 2 + 1 < nodes.length) {
      let child = index * 2 + 1;
      if (child + 1 < nodes.length && this.compare(nodes[child + 1], nodes[child])) child++;
      if (!this.compare(nodes[child], last)) break;
      nodes[index] = nodes[child];
      index = child;
    }
    nodes[index] = last;
    return first;
  }
}

export function findSafePath({
  xStart, goalRadius = 50, maxStep = 50, holeRadius = 1, safetyMargin = 0.2,
  maxTime, maxExpansions = 120000,
} = {}) {
  const started = performance.now();
  if (![xStart, goalRadius, maxStep, holeRadius, safetyMargin].every(Number.isFinite)
      || xStart <= 50 || goalRadius < 0 || maxStep <= 0 || holeRadius <= 0 || safetyMargin < 0
      || !Number.isSafeInteger(maxExpansions) || maxExpansions < 0) {
    throw new RangeError('需要大于 50 m 的有限起点，以及有效的目标半径、步长、洞半径和搜索参数');
  }
  const heuristic = (x, y) => Math.max(0, Math.hypot(x, y) - goalRadius) / maxStep * travelTime;
  const directJumps = Math.ceil(heuristic(xStart, 0) / travelTime);
  const earliestFinish = directJumps * travelTime + goalHold;
  // Keep the ordinary 120 s horizon with room to detour for starts near or beyond it.
  const deadline = maxTime ?? Math.max(120, earliestFinish + 10);
  if (!Number.isFinite(deadline) || deadline <= 0) throw new RangeError('maxTime 必须为有限正数');

  let expandedNodes = 0;
  function finish(node, terminalMargin, reason) {
    const steps = [];
    const totalTime = node ? node.arrive + goalHold : null;
    for (let next = null; node; next = node, node = node.parent) {
      steps.push({
        index: node.index, x: node.x, y: node.y, tOpen: node.open, tArrive: node.arrive,
        tExpire: next ? next.arrive + oldLifetime : null,
        waitTime: node.parent ? node.open - node.parent.arrive : 0,
        stepDist: node.parent ? Math.hypot(node.x - node.parent.x, node.y - node.parent.y) : 0,
        minMargin: next ? next.previousMargin : terminalMargin,
      });
    }
    steps.reverse();
    const holesTimeline = steps.map(({ index, x, y, tOpen, tArrive, tExpire }) => ({
      index, x, y, tOpen, tArrive, tExpire,
    }));
    return {
      found: steps.length > 0,
      stats: {
        totalTime, jumps: Math.max(0, steps.length - 1),
        minSafetyMargin: steps.length ? steps.reduce((min, step) => Math.min(min, step.minMargin), Infinity) : null,
        computeMs: performance.now() - started, expandedNodes,
      },
      steps, holesTimeline, ...(reason ? { reason } : {}),
    };
  }

  if (!Number.isSafeInteger(directJumps) || directJumps >= 2 ** 32 - 1
      || (directJumps > 0 && xStart - maxStep === xStart)) {
    return finish(null, null, '路径超出可完整生成的步数或坐标精度');
  }
  if (earliestFinish > deadline) return finish(null, null, '时限短于最早可能完成的时间');

  const waveCache = new Map();
  function inspect(point, start, end, inclusive = true) {
    const from = Math.floor(start);
    const to = Math.ceil(end);
    const key = `${from}/${to}`;
    let waves = waveCache.get(key);
    if (!waves) {
      waves = Array.from(field.getEmissionsBetween(from, to));
      if (waveCache.size >= 64) waveCache.delete(waveCache.keys().next().value);
      waveCache.set(key, waves);
    }
    return measure(point.x, point.y, start, end, waves, holeRadius, safetyMargin, inclusive);
  }

  const root = { x: xStart, y: 0, index: 0, open: 0, arrive: 0, historyMargin: Infinity, margin: Infinity };
  function advance(node, point, open, previous, upcoming) {
    const arrive = open + travelTime;
    const historyMargin = Math.min(node.historyMargin, previous.margin);
    return {
      ...point, open, arrive, index: node.index + 1, parent: node, historyMargin,
      previousMargin: previous.margin, margin: Math.min(historyMargin, upcoming.margin),
      estimate: arrive + heuristic(point.x, point.y),
    };
  }

  let seed = root;
  while (seed.x - maxStep > goalRadius && seed.arrive + travelTime + goalHold <= deadline) {
    let nextX = seed.x - maxStep;
    if (seed.x - nextX > maxStep) nextX += after(seed.x) - seed.x;
    if (nextX >= seed.x) break;
    const point = { x: nextX, y: 0 };
    const open = seed.arrive;
    const previous = inspect(seed, seed.open, open + travelTime + oldLifetime, false);
    const upcoming = inspect(point, open, open + 2 * travelTime + oldLifetime, false);
    // The older holes' entire lifetimes were certified when they were superseded.
    if (!previous.safe || !upcoming.safe || Math.min(previous.margin, upcoming.margin) <= Math.max(50, safetyMargin)) break;
    seed = advance(seed, point, open, previous, upcoming);
  }

  const openSet = new OpenSet();
  const best = new Map();
  const cellSize = Math.min(8, maxStep / 4);
  function enqueue(node) {
    const key = `${Math.round(node.x / cellSize)}/${Math.round(node.y / cellSize)}/${Math.round(node.arrive * 2)}`;
    const previous = best.get(key);
    if (previous && (previous.arrive < node.arrive
        || (previous.arrive === node.arrive && previous.estimate <= node.estimate && previous.margin >= node.margin))) return;
    // The continuous heuristic can be rounded up to whole jumps, even after a fractional wait.
    const remaining = heuristic(node.x, node.y);
    node.arrivalBound = node.arrive + Math.ceil(Math.max(0, remaining / travelTime - 1e-12)) * travelTime;
    node.guidedEstimate = node.estimate + 0.25 * remaining;
    node.key = key;
    best.set(key, node);
    openSet.push(node);
  }

  seed.estimate = seed.arrive + heuristic(seed.x, seed.y);
  enqueue(seed);
  while (openSet.nodes.length && expandedNodes < maxExpansions) {
    // Re-rank a difficult frontier to favor progress through dense wave crossings.
    if (expandedNodes === exactSearchExpansions && openSet.compare === preferred) openSet.guideByProgress();
    const node = openSet.pop();
    if (best.get(node.key) !== node) continue;
    expandedNodes++;

    const distance = Math.hypot(node.x, node.y);
    if (distance <= goalRadius) {
      const terminal = inspect(node, node.open, node.arrive + goalHold);
      if (terminal.safe) return finish(node, terminal.margin);
    }

    const latest = deadline - travelTime - goalHold;
    if (node.arrive > latest) continue;
    // Once a wave reaches the occupied hole, all later departure times are invalid.
    const departures = new Map();
    function departure(open) {
      if (!departures.has(open)) departures.set(open, inspect(node, node.open, open + travelTime + oldLifetime, false));
      return departures.get(open);
    }
    if (!departure(node.arrive).safe) continue;

    const heading = Math.atan2(-node.y, -node.x);
    const lengths = [maxStep, maxStep * 0.8, maxStep * 0.5];
    // Include the shortest inward landing and a landing at the origin when reachable.
    const goalStep = distance - goalRadius;
    if (goalStep > 0 && goalStep < maxStep) lengths.push(Math.min(maxStep, after(goalStep)));
    if (distance > 0 && distance <= maxStep) lengths.push(distance);
    for (const [angleIndex, offset] of angles.entries()) {
      const direction = heading + offset;
      const dx = Math.cos(direction);
      const dy = Math.sin(direction);
      for (const [lengthIndex, length] of lengths.entries()) {
        if (lengthIndex >= 3 && angleIndex !== 0) break;
        const point = length === distance && angleIndex === 0 ? { x: 0, y: 0 } : {
          x: node.x + dx * length, y: node.y + (Math.abs(dy) < 1e-15 ? 0 : dy * length),
        };
        let stepDist = Math.hypot(point.x - node.x, point.y - node.y);
        if (stepDist > maxStep && stepDist <= after(maxStep)) {
          const inset = 8 * Number.EPSILON * Math.max(distance, maxStep);
          point.x -= dx * inset;
          point.y -= dy * inset;
          stepDist = Math.hypot(point.x - node.x, point.y - node.y);
        }
        if (stepDist === 0 || stepDist > maxStep) continue;
        const goal = Math.hypot(point.x, point.y) <= goalRadius;
        const life = travelTime + (goal ? goalHold : travelTime + oldLifetime);
        const lastOpen = Math.min(latest, deadline - travelTime - goalHold - heuristic(point.x, point.y));
        let windowFound = false;
        for (const wait of waits) {
          let open = node.arrive + wait;
          while (open <= lastOpen) {
            const previous = departure(open);
            if (!previous.safe) break;
            const upcoming = inspect(point, open, open + life, goal);
            if (upcoming.safe) {
              enqueue(advance(node, point, open, previous, upcoming));
              windowFound = true;
              break;
            }
            if (wait !== 0) break;
            open = after(upcoming.blockedUntil);
          }
          if (goal && windowFound) break;
        }
      }
    }
  }

  return finish(null, null, expandedNodes >= maxExpansions ? '已达到搜索节点上限' : '在搜索范围内未找到安全路线');
}

export function validatePath(steps, waveField = field, {
  xStart = steps?.[0]?.x, goalRadius = 50, maxStep = 50, holeRadius = 1, safetyMargin = 0, maxTime = Infinity,
} = {}) {
  const fail = (reason, index = null, time = null) => ({ valid: false, reason, index, time });
  if (!Array.isArray(steps) || !steps.length || steps.some(step => !step || typeof step !== 'object')) {
    return fail('路径为空或洞记录无效');
  }
  if (![xStart, goalRadius, maxStep, holeRadius, safetyMargin].every(Number.isFinite)
      || !(maxTime > 0) || goalRadius < 0 || maxStep <= 0 || holeRadius <= 0 || safetyMargin < 0) {
    return fail('校验参数无效');
  }
  const first = steps[0];
  const last = steps.at(-1);
  if (first.x !== xStart || !(xStart > 50) || first.y !== 0 || first.tOpen !== 0 || first.tArrive !== 0) {
    return fail('初始洞位置或时刻错误', 0);
  }
  const end = last.tArrive + goalHold;
  if (!Number.isFinite(end) || end > maxTime || Math.hypot(last.x, last.y) > goalRadius) {
    return fail('终点或留守时限错误', steps.length - 1);
  }

  for (const [index, hole] of steps.entries()) {
    const previous = steps[index - 1];
    const next = steps[index + 1];
    if (![hole.x, hole.y, hole.tOpen, hole.tArrive].every(Number.isFinite) || hole.index !== index
        || hole.tExpire !== (next ? next.tArrive + oldLifetime : null)
        || (previous && (hole.tOpen < previous.tArrive || hole.tArrive !== hole.tOpen + travelTime
          || Math.hypot(hole.x - previous.x, hole.y - previous.y) > maxStep))) {
      return fail('开洞、抵达、消失或步长不符合规则', index, hole.tOpen);
    }
  }

  const tolerance = holeRadius + safetyMargin;
  const events = [...new Set(steps.flatMap(({ tOpen, tArrive, tExpire }) => (
    tExpire === null ? [tOpen, tArrive, end] : [tOpen, tArrive, tExpire]
  )))].sort((a, b) => a - b);
  let nextHole = 0;
  let active = [];
  let samples = 0;
  function sample(time) {
    while (nextHole < steps.length && steps[nextHole].tOpen <= time) active.push(steps[nextHole++]);
    active = active.filter(hole => hole.tExpire === null || time < hole.tExpire);
    const circles = waveField.getActiveCircles(time);
    samples++;
    for (const hole of active) {
      for (const wave of circles) {
        if (Math.abs(Math.hypot(hole.x - wave.cx, hole.y - wave.cy) - wave.r) <= tolerance) {
          return fail('采样复核检测到波环触洞', hole.index, time);
        }
      }
    }
  }

  let tick = 0;
  for (const event of events) {
    while (tick * 0.02 < event) {
      const hit = sample(tick++ * 0.02);
      if (hit) return hit;
    }
    const hit = sample(event);
    if (hit) return hit;
    if (tick * 0.02 === event) tick++;
  }
  // Check between samples as well, including short-lived or tangent contacts.
  for (const hole of steps) {
    const close = hole.tExpire ?? end;
    const check = measure(hole.x, hole.y, hole.tOpen, close, waveField.getEmissionsBetween(hole.tOpen, close),
      holeRadius, safetyMargin, hole.tExpire === null);
    if (!check.safe) return fail('连续区间复核检测到波环触洞', hole.index);
  }
  return { valid: true, samples };
}
