import assert from 'node:assert/strict';
import { createWaveField } from '../2d/wave-field.js';
import { findSafePath, isHoleSafeDuring, validatePath } from './solver.js';

const field = createWaveField();
const source = (x, options = {}) => ({ id: 1, x, y: 0, z: 0, speed: 10, interval: 10, startTime: 0, ...options });
const straight = (...points) => points.map((x, index) => ({
  index, x, y: 0, tOpen: index === 0 ? 0 : (index - 1) * 0.5,
  tArrive: index * 0.5, tExpire: index === points.length - 1 ? null : (index + 1) * 0.5 + 1,
}));

const grazing = createWaveField({ sources: [source(84)] });
assert.equal(isHoleSafeDuring(100, 0, 0, 1.5, grazing).safe, false);
assert.equal(validatePath(straight(100, 50), grazing).valid, true, '旧洞消失时刻不参与碰撞');
assert.equal(isHoleSafeDuring(100, 0, 0, 1.49, grazing).safe, true);
assert.equal(isHoleSafeDuring(100, 0, 0, 1.49, grazing, 1, 0.2).safe, false);
assert.equal(isHoleSafeDuring(100, 0, 0, 2, createWaveField({ sources: [source(84)], maxRadius: 14 })).safe, true);

const flash = createWaveField({ sources: [source(100, { z: -3, speed: 20, startTime: 0.011 })], maxRadius: 3.001 });
assert.equal(isHoleSafeDuring(100, 0, 0.15, 0.17, flash).safe, false, '包含半径为零的触地瞬间');
assert.equal(isHoleSafeDuring(100, 0, 0.15, 0.17, flash).margin, -1);
assert.match(validatePath(straight(100, 50), flash).reason, /连续区间/, '捕获落在时间采样之间的整段波环');

const overlap = createWaveField({ sources: [source(200, { startTime: 1.25 })] });
const overlapResult = validatePath(straight(200, 150, 100, 50), overlap);
assert.equal(overlapResult.valid, false);
assert.equal(overlapResult.index, 0, '第四个洞开启后仍要检查第一个洞');
assert.equal(overlapResult.time, 1.26, '旧洞在额外的 0.5 s 内仍会被探测');

const finalContact = createWaveField({ sources: [source(34)] });
assert.equal(validatePath(straight(100, 50), finalContact).valid, false, '终点最后一刻仍可被探测');
assert.equal(findSafePath({ xStart: 5000, maxTime: 49 }).found, false, '显式时限包含终点留守');

const options = { safetyMargin: 0.3 };
const rows = [];
for (const xStart of [120, 200, 300, 400, 500, 600, 800, 1500, 2500, 3000, 5000, 15000]) {
  const result = findSafePath({ xStart, ...options });
  const { computeMs, totalTime, jumps, minSafetyMargin, expandedNodes } = result.stats;
  const check = validatePath(result.steps, field, { xStart, ...options });
  rows.push({
    '起点 (m)': xStart, '计算 (ms)': computeMs.toFixed(2), '总用时 (s)': totalTime?.toFixed(3),
    '跳数': jumps, '最小裕度 (m)': minSafetyMargin?.toFixed(3), '展开节点': expandedNodes,
    '独立复核': check.valid ? `通过 (${check.samples} 点)` : result.reason ?? check.reason,
  });
  if (!result.found || !check.valid) process.exitCode = 1;
}
console.table(rows);
