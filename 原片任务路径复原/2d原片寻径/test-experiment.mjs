import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWaveField } from '../../波源立体几何重建/2d/wave-field.js';
import { isHoleSafeDuring, validatePath } from '../pathfinding/solver.js';
import { END, FRONT, HYPOTHESES, field, landmarks, schedule, straightPrefix } from './canon-experiment.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-9, `${actual} != ${expected}`);
const point = (x, y = 0) => ({ x, y });
const source = (x, startTime = 0) => ({ id: 1, x, y: 0, z: 0, speed: 10, interval: 10, startTime });
const waveAt = (x, time) => createWaveField({ sources: [source(x, time)], maxRadius: Infinity });

test('四种假说的左、右、二、三及动态更新方向', () => {
  for (const hypothesis of HYPOTHESES) {
    for (const slot of [2, 3]) {
      const angle = (slot === 2 ? hypothesis.two : hypothesis.three) * Math.PI / 180;
      for (const side of [-1, 1]) {
        const [, landing] = landmarks(hypothesis, point(200), [{ turn: side * slot, distance: 10 }]);
        close(landing.x, 200 - 10 * Math.cos(angle));
        close(landing.y, side * 10 * Math.sin(angle));
      }
    }
    const [, after] = landmarks(hypothesis, point(30, 40), [{ turn: 0, distance: 10 }]);
    close(after.x, hypothesis.dynamic ? 24 : 20);
    close(after.y, hypothesis.dynamic ? 32 : 40);

    for (const commands of [FRONT, END]) {
      const points = landmarks(hypothesis, point(205), commands);
      commands.forEach(({ distance }, i) => close(Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y), distance));
    }
  }
  assert.deepEqual(FRONT.map(jump => jump.distance), [43, 50, 45, 30, 47, 40, 30, 30]);
  assert.deepEqual(END.map(jump => jump.distance), [53, 40, 20, 30, 45]);
});

test('第七步二段跳从第一跳抵达起严格等待两秒', () => {
  const points = landmarks(HYPOTHESES[0], point(1000), FRONT);
  const empty = createWaveField({ sources: [], maxRadius: Infinity });
  const route = schedule(points, FRONT, { waveField: empty }).path(0);
  assert.equal(route.steps.length, 9);
  assert.equal(route.steps[8].waitTime, 2);
  assert.equal(route.steps[8].tOpen - route.steps[7].tArrive, 2);
  assert.equal(route.steps[8].tArrive - route.steps[8].tOpen, 0.5);
  for (let index = 0; index < route.steps.length - 1; index++) {
    assert.equal(route.steps[index].tExpire, route.steps[index + 1].tArrive + 1);
  }

  const twoJumps = [{ ...FRONT[6], wait: 0 }, FRONT[7]];
  const hazards = { waveField: waveAt(100, 2) };
  assert.equal(schedule([point(150), point(100), point(50)], twoJumps, hazards).path(0), null);
  assert.ok(schedule([point(150), point(100), point(50)], [twoJumps[0], { ...twoJumps[1], wait: 0 }], hazards).path(0));
});

test('动态规划在允许的等待网格内最大化最小裕度', () => {
  const route = schedule([point(100), point(50)], [{ ...FRONT[1] }], { waveField: waveAt(0, 0) }).path(16);
  assert.equal(route.steps[1].waitTime, 2.75);
  assert.equal(route.steps[1].tOpen, 6.75);
  assert.equal(route.minMargin, 16.5);
});

test('旧洞消失边界和 1 m 裕度等号由共享校验器处理', () => {
  const commands = [{ ...FRONT[1], wait: 0 }];
  const hazards = waveAt(100, 1.5);
  assert.equal(isHoleSafeDuring(100, 0, 0, 1.5, hazards).safe, false);
  assert.equal(isHoleSafeDuring(100, 0, 0, 1.5, hazards, 1, 1, { endInclusive: false }).safe, true);
  const route = schedule([point(100), point(50)], commands, { waveField: hazards }).path(0);
  assert.equal(route.steps[0].tExpire, 1.5);
  assert.equal(validatePath(route.steps, hazards, { safetyMargin: 1, allowEqualMargin: true }).valid, true);
  assert.equal(schedule([point(100), point(50)], commands, { waveField: waveAt(100, 1.49) }).path(0), null);

  const start = { ...point(72), index: 0, tOpen: 7, tArrive: 7, tExpire: null };
  const options = { start, goalRadius: 72, holdTime: 0, safetyMargin: 1 };
  assert.equal(validatePath([start], waveAt(0, 0), options).valid, false);
  assert.equal(validatePath([start], waveAt(0, 0), { ...options, allowEqualMargin: true }).valid, true);
});

test('直行在首个不安全候选前切入，保留所有旧洞寿命', () => {
  const { steps, blocked } = straightPrefix(10000);
  assert.ok(blocked);
  assert.ok(Math.min(blocked.oldMargin, blocked.nextMargin) < 1);
  assert.equal(blocked.x, steps.at(-1).x - 50);
  for (let i = 0; i < steps.length - 1; i++) {
    assert.equal(steps[i + 1].x, steps[i].x - 50);
    assert.equal(steps[i + 1].tOpen, steps[i].tArrive);
    assert.equal(steps[i].tExpire, steps[i + 1].tArrive + 1);
    assert.ok(steps[i].minMargin >= 1);
  }
});

test('相位缓存与全时间求解一致，末段保留 53 m 原片跳距', () => {
  const points = landmarks(HYPOTHESES[2], point(205), END);
  const periodic = schedule(points, END, { phasePeriod: 40 });
  const absolute = schedule(points, END);
  for (let phase = 0; phase < 40; phase++) {
    const before = periodic.solve(520 + phase);
    const after = absolute.solve(560 + phase);
    assert.equal(Boolean(before), Boolean(after));
    if (before) close(before.margin, after.margin);
  }
  const { steps } = absolute.path(540);
  assert.equal(steps[1].stepDist, 53);
  assert.equal(validatePath(steps, field, { start: steps[0], safetyMargin: 1, allowEqualMargin: true }).valid, false);
  assert.equal(validatePath(steps, field, { start: steps[0], maxStep: 53 + 1e-9, safetyMargin: 1, allowEqualMargin: true }).valid, true);
});
