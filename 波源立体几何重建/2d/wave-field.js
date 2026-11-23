export const SOURCES = [
  { id: 1, name: '源1 (右上)', x: 488.5, y: 318.0, z: 39.0, startTime: 11.76, interval: 10, speed: 10 },
  { id: 2, name: '源2 (中上)', x: 200.9, y: 226.3, z: -81.1, startTime: 5.65, interval: 10, speed: 10 },
  { id: 3, name: '源3 (原点)', x: 0.0, y: 0.0, z: 0.0, startTime: 0.0, interval: 10, speed: 10 },
  { id: 4, name: '源4 (中下)', x: 169.0, y: -251.1, z: 84.1, startTime: 5.83, interval: 10, speed: 10 },
  { id: 5, name: '源5 (右下)', x: 470.6, y: -287.5, z: -13.3, startTime: 15.39, interval: 10, speed: 10 },
];

export const DEFAULTS = { speed: 10, interval: 10, maxRadius: 1200 };

function firstTrue(lo, hi, predicate, resolution) {
  while (hi - lo > resolution) {
    const mid = lo + (hi - lo) / 2;
    if (mid === lo || mid === hi) break;
    if (predicate(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function createWaveField({ sources = SOURCES, maxRadius = DEFAULTS.maxRadius } = {}) {
  if (!(maxRadius >= 0) || typeof maxRadius !== 'number') {
    throw new RangeError('maxRadius must be nonnegative or Infinity');
  }

  const emitters = sources.map(source => {
    const { x, y, z, startTime, speed = DEFAULTS.speed, interval = DEFAULTS.interval } = source;
    if (![x, y, z, startTime, speed, interval].every(Number.isFinite) || speed <= 0 || interval <= 0) {
      throw new RangeError('Source coordinates and startTime must be finite, with positive speed and interval');
    }
    return { ...source, speed, interval, depth: Math.abs(z) };
  });

  function* activeEmissions(t0, t1) {
    for (const source of emitters) {
      if (source.depth > maxRadius) continue;
      const { startTime, interval, speed, depth } = source;
      const travelTime = depth / speed;
      const expiry = maxRadius / speed;
      // Keep emission, contact and expiry instants inclusive after rounding.
      const roundoff = 4 * Number.EPSILON * Math.max(1, Math.abs(t0), Math.abs(t1), Math.abs(startTime));
      const first = Math.max(0, Math.ceil((t0 - startTime - expiry - roundoff) / interval));
      const last = Math.floor((t1 - startTime - travelTime + roundoff) / interval);
      if (last < first) continue;
      if (!Number.isSafeInteger(last)) throw new RangeError('Emission index cannot be represented accurately');
      for (let emissionIndex = first; emissionIndex <= last; emissionIndex++) {
        const emittedAt = startTime + emissionIndex * interval;
        const contact = emittedAt + travelTime;
        const start = Math.max(t0, contact);
        const end = Math.min(t1, emittedAt + expiry);
        if (start > end + roundoff) continue;
        const clippedStart = Math.min(start, t1);
        yield { source, emissionIndex, emittedAt, contact, start: clippedStart, end: Math.max(clippedStart, end) };
      }
    }
  }

  function radius3D(wave, t) {
    const { depth, speed } = wave.source;
    return t <= wave.contact ? depth : Math.min(maxRadius, Math.max(depth, speed * (t - wave.emittedAt)));
  }

  function radius2D(wave, R3D) {
    const { depth } = wave.source;
    return Math.sqrt((R3D - depth) * (R3D + depth));
  }

  function circleAt(wave, t) {
    const { source, emissionIndex, emittedAt } = wave;
    const R3D = radius3D(wave, t);
    const r = radius2D(wave, R3D);
    return {
      sourceId: source.id, sourceName: source.name, emissionIndex,
      cx: source.x, cy: source.y, z: source.z, r, R3D,
      radialSpeed: r > 0 ? source.speed * (R3D / r) : Infinity,
      emittedAt,
    };
  }

  function getActiveCircles(t) {
    if (!Number.isFinite(t)) throw new RangeError('Time must be finite');
    return Array.from(activeEmissions(t, t), wave => circleAt(wave, t));
  }

  function* getEmissionsBetween(t0, t1) {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) {
      throw new RangeError('Emission queries require finite, ordered times');
    }
    for (const { source, emittedAt, contact } of activeEmissions(t0, t1)) {
      yield {
        sourceId: source.id, cx: source.x, cy: source.y, z: source.z,
        speed: source.speed, emittedAt, contact, expiry: emittedAt + maxRadius / source.speed,
      };
    }
  }

  function distanceToNearestWave(x, y, t) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError('Point coordinates must be finite');
    let distance = Infinity;
    let circle = null;
    for (const active of getActiveCircles(t)) {
      const gap = Math.abs(Math.hypot(x - active.cx, y - active.cy) - active.r);
      if (gap < distance) {
        distance = gap;
        circle = active;
      }
    }
    return { distance, circle };
  }

  function isColliding(x, y, t, tolerance = 2.0) {
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError('Tolerance must be finite and nonnegative');
    return distanceToNearestWave(x, y, t).distance <= tolerance;
  }

  // dt bounds the time refinement. Contact is solved on continuous wave intervals.
  function checkSegmentCollision(p0, p1, t0, t1, { tolerance = 2.0, dt = 0.05 } = {}) {
    if (![p0.x, p0.y, p1.x, p1.y, t0, t1, tolerance, dt].every(Number.isFinite)
        || t1 < t0 || tolerance < 0 || dt <= 0) {
      throw new RangeError('Segment requires finite inputs, increasing times, nonnegative tolerance and positive dt');
    }
    const miss = { collided: false, hitTime: null, hitPoint: null, circle: null };
    if (t0 === t1) {
      if (p0.x !== p1.x || p0.y !== p1.y) throw new RangeError('A zero-duration segment cannot move');
      const { distance, circle } = distanceToNearestWave(p0.x, p0.y, t0);
      return distance <= tolerance ? { collided: true, hitTime: t0, hitPoint: { x: p0.x, y: p0.y }, circle } : miss;
    }

    const vx = (p1.x - p0.x) / (t1 - t0);
    const vy = (p1.y - p0.y) / (t1 - t0);
    const resolution = Math.min(dt, 1e-9);
    const pointAt = t => ({ x: p0.x + vx * (t - t0), y: p0.y + vy * (t - t0) });
    let hitTime = Infinity;
    let circle = null;

    for (const wave of activeEmissions(t0, t1)) {
      const { source, start } = wave;
      if (start >= hitTime) continue;
      const end = Math.min(wave.end, hitTime);
      const distanceAt = t => Math.hypot(p0.x - source.x + vx * (t - t0), p0.y - source.y + vy * (t - t0));
      const gapAt = t => distanceAt(t) - radius2D(wave, radius3D(wave, t));
      const startGap = gapAt(start);
      const limit = tolerance + 8 * Number.EPSILON * Math.max(1, distanceAt(start), distanceAt(end), radius3D(wave, end));
      let hit;

      if (Math.abs(startGap) <= limit) {
        hit = start;
      } else if (startGap < -limit) {
        if (gapAt(end) >= -limit) hit = firstTrue(start, end, t => gapAt(t) >= -limit, resolution);
      } else if (end > start) {
        // Point-to-center distance is convex and the ring radius is concave.
        // Their difference has one minimum, even when a moving point crosses the center.
        const slope = t => {
          const dx = p0.x - source.x + vx * (t - t0);
          const dy = p0.y - source.y + vy * (t - t0);
          const distance = Math.hypot(dx, dy);
          const pointSlope = distance > 0 ? (vx * dx + vy * dy) / distance : Math.hypot(vx, vy);
          if (source.depth === 0) return pointSlope - source.speed;
          const R3D = radius3D(wave, t);
          return pointSlope - source.speed * (R3D / radius2D(wave, R3D));
        };
        let minimum = start;
        if (slope(start) < 0) {
          minimum = slope(end) < 0 ? end : firstTrue(start, end, t => slope(t) >= 0, resolution);
        }
        if (gapAt(minimum) <= limit) hit = firstTrue(start, minimum, t => gapAt(t) <= limit, resolution);
      }

      if (hit < hitTime) {
        hitTime = hit;
        circle = circleAt(wave, hit);
      }
    }

    return circle ? { collided: true, hitTime, hitPoint: pointAt(hitTime), circle } : miss;
  }

  return { getActiveCircles, getEmissionsBetween, distanceToNearestWave, isColliding, checkSegmentCollision };
}
