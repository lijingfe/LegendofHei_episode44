import assert from 'node:assert/strict';
import { createWaveField, SOURCES } from './wave-field.js';

const field = createWaveField();
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);
const point = (x, y = 0) => ({ x, y });
const samples = [
  [0, [[3, 0, 0]]],
  [18.45, [[1, 0, 54.356], [2, 0, 99.029], [3, 0, 184.5], [3, 1, 84.5], [4, 0, 94.094], [5, 0, 27.558]]],
  [30, [[1, 0, 178.182], [1, 1, 72.586], [2, 0, 229.598], [2, 1, 118.385], [3, 0, 300], [3, 1, 200],
    [3, 2, 100], [3, 3, 0], [4, 0, 226.597], [4, 1, 114.044], [5, 0, 145.493], [5, 1, 44.14]]],
];

assert.deepEqual(SOURCES.map(({ z }) => z), [39, -81.1, 0, 84.1, -13.3]);
assert.deepEqual(field.distanceToNearestWave(0, 0, -1), { distance: Infinity, circle: null });
assert.equal(field.isColliding(2, 0, 0), true);
assert.equal(field.isColliding(2.001, 0, 0), false);

for (const [time, expected] of samples) {
  const circles = field.getActiveCircles(time);
  assert.deepEqual(circles.map(({ sourceId, emissionIndex, r }) => [sourceId, emissionIndex, Number(r.toFixed(3))]), expected);
  for (const circle of circles) {
    const { cx, cy, r, R3D, radialSpeed, z } = circle;
    near(r * r + z * z, R3D * R3D);
    if (r === 0) assert.equal(radialSpeed, Infinity);
    else near(radialSpeed, 10 * R3D / r);
    near(field.distanceToNearestWave(cx + r, cy, time).distance, 0);
    assert.equal(field.isColliding(cx + r, cy, time), true);
  }
  assert.equal(field.isColliding(10000, 10000, time), false);
  console.log(`t = ${time.toFixed(2)} s: ${circles.length} circles passed`);
}

const origin = { ...SOURCES[2], interval: 100 };
const single = createWaveField({ sources: [origin] });
const miss = { collided: false, hitTime: null, hitPoint: null, circle: null };
assert.deepEqual(single.checkSegmentCollision(point(100), point(200), 0, 0.5), miss);
assert.equal(single.checkSegmentCollision(point(0), point(0), 0, 0).hitTime, 0);

const crossing = single.checkSegmentCollision(point(-100), point(100), 5, 5.04, { tolerance: 0, dt: 0.05 });
assert.equal(crossing.collided, true);
near(crossing.hitTime, 5 + 50 / 5010);
near(crossing.hitPoint.x, -crossing.circle.r, 0.00001);
near(single.checkSegmentCollision(point(0), point(100), 5, 6, { tolerance: 0 }).hitTime, 5 + 50 / 90);
near(single.checkSegmentCollision(point(10), point(10), 0.5, 1.5).hitTime, 0.8);
near(single.checkSegmentCollision(point(0, 50), point(60, 30), 4, 6, { tolerance: 0 }).hitTime, 5, 0.000001);

const lower = createWaveField({ sources: [SOURCES[1]] });
const center = point(SOURCES[1].x, SOURCES[1].y);
const contact = lower.checkSegmentCollision(center, center, 13.75, 13.8, { tolerance: 0 });
near(contact.hitTime, 13.76);
assert.equal(contact.circle.r, 0);

assert.equal(single.getActiveCircles(120)[0].R3D, 1200);
assert.equal(single.getActiveCircles(120.01)[0].emissionIndex, 1);
assert.equal(createWaveField({ sources: [origin], maxRadius: Infinity }).getActiveCircles(150)[0].R3D, 1500);
assert.deepEqual(createWaveField({ sources: [origin], maxRadius: 45 }).checkSegmentCollision(point(50), point(50), 4, 6, { tolerance: 0 }), miss);
assert.equal(createWaveField({ sources: [{ ...origin, interval: 0.1 }] }).getActiveCircles(0.3).at(-1).emissionIndex, 3);
console.log('Collision, tangency, cutoff and signed calibration checks passed.');
