import { createWaveField, SOURCES } from '../2d/wave-field.js';
import { findSafePath, validatePath } from '../pathfinding/solver.js';

const waveField = createWaveField();
const goalRadius = 50;
const holeRadius = 1;
const colors = {
  background: '#081322', wave: ['#73a8ff', '#a489ee', '#79dff7', '#7bddb7', '#eba6bb'],
  goal: '#7ce7bd', route: '#79dff7', old: '#ffc17a', new: '#e0faff', hit: '#ff8092',
};
const tau = 2 * Math.PI;
const initialHole = x => ({ index: 0, x, y: 0, tOpen: 0, tArrive: 0, tExpire: null });

if (typeof document === 'undefined') {
  self.addEventListener('message', ({ data: options }) => {
    try {
      const result = findSafePath(options);
      if (result.found) {
        const validation = validatePath(result.steps, waveField, options);
        if (!validation.valid) throw new Error(validation.reason);
      }
      self.postMessage({ result });
    } catch (error) {
      self.postMessage({ error: error.message });
    }
  });
} else {
  mount();
}

function mount() {
  const byId = id => document.getElementById(id);
  const canvas = byId('field');
  const ctx = canvas.getContext('2d', { alpha: false });
  const startInput = byId('start');
  const marginInput = byId('margin');
  const solveButton = byId('solve');
  const solution = byId('solution');
  const timeInput = byId('time');
  const clock = byId('clock');
  const speed = byId('speed');
  const play = byId('play');
  const stepsList = byId('steps');
  const compare = byId('compare');
  const mapStatus = byId('map-status');
  const scaleBar = byId('scale-bar');
  const scaleLength = byId('scale-length');
  const worker = new Worker(import.meta.url, { type: 'module' });

  let startX = startInput.valueAsNumber;
  let route = [initialHole(startX)];
  let found = false;
  let duration = 0;
  let end = 0;
  let time = 0;
  let animation = 0;
  let lastFrame = null;
  let width = 0;
  let height = 0;
  let camera;
  let viewMode = 'route';
  let drag;
  let selected;
  let stepButtons = [];

  function fit(includeRoute = true) {
    let minX = -goalRadius;
    let maxX = goalRadius;
    let minY = -goalRadius;
    let maxY = goalRadius;
    function include({ x, y }) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    SOURCES.forEach(include);
    if (includeRoute) route.forEach(include);

    camera = {
      x: minX / 2 + maxX / 2, y: minY / 2 + maxY / 2,
      scale: Math.min((width - 64) / (maxX - minX), (height - 82) / (maxY - minY)),
    };
    viewMode = includeRoute ? 'route' : 'field';
    draw();
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width < 70 || bounds.height < 90) return;
    width = bounds.width;
    height = bounds.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    if (viewMode) fit(viewMode === 'route');
    else draw();
  }

  const screenX = x => width / 2 + (x - camera.x) * camera.scale;
  const screenY = y => height / 2 - (y - camera.y) * camera.scale;
  function circle(x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, tau);
  }

  function label(text, x, y, color, font = '11px ui-monospace, monospace') {
    ctx.font = font;
    ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colors.background;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  function gridStep(target, roundDown = false) {
    const decade = 10 ** Math.floor(Math.log10(target));
    const multiplier = target / decade;
    if (roundDown) return (multiplier >= 5 ? 5 : multiplier >= 2 ? 2 : 1) * decade;
    return (multiplier <= 1 ? 1 : multiplier <= 2 ? 2 : multiplier <= 5 ? 5 : 10) * decade;
  }

  function grid() {
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);
    const minor = gridStep(20 / camera.scale);
    const major = minor * 5;
    function lines(spacing, color) {
      const interval = spacing * camera.scale;
      const xOffset = (width / 2 - (camera.x % spacing) * camera.scale) % interval;
      const yOffset = (height / 2 + (camera.y % spacing) * camera.scale) % interval;
      ctx.beginPath();
      for (let x = xOffset; x < width; x += interval) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = yOffset; y < height; y += interval) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    lines(minor, '#132438');
    lines(major, '#20384e');
    const x = screenX(0);
    const y = screenY(0);
    ctx.beginPath();
    if (x >= 0 && x <= width) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    if (y >= 0 && y <= height) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.strokeStyle = '#4a6d83';
    ctx.stroke();
    if (x >= 0 && x <= width) label('Y', Math.min(width - 18, x + 6), x < 175 ? 51 : 19, '#9ab0c5');
    if (y >= 0 && y <= height) label('X', width - 18, Math.max(15, y - 7), '#9ab0c5');

    const meters = gridStep(89 / camera.scale, true);
    scaleBar.style.width = `${meters * camera.scale}px`;
    scaleLength.textContent = `${Number(meters.toPrecision(4))} m`;
  }

  function drawWaves(circles) {
    for (const wave of circles) {
      const x = screenX(wave.cx);
      const y = screenY(wave.cy);
      const r = Math.max(0.75, wave.r * camera.scale);
      if (x + r < 0 || x - r > width || y + r < 0 || y - r > height) continue;
      circle(x, y, r);
      ctx.strokeStyle = colors.wave[wave.sourceId - 1];
      ctx.lineWidth = 3.5;
      ctx.globalAlpha = 0.15;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.69;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawGoalAndSources() {
    const x = screenX(0);
    const y = screenY(0);
    const r = goalRadius * camera.scale;
    circle(x, y, r);
    ctx.fillStyle = '#7ce7bd0d';
    ctx.fill();
    ctx.save();
    ctx.strokeStyle = colors.goal;
    ctx.shadowColor = colors.goal;
    ctx.shadowBlur = 11;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.restore();
    if (x >= -r && x <= width + r && y >= -r && y <= height + r) {
      label('目标区域 (r ≤ 50m)', Math.min(Math.max(x - r, 7), width - 126),
        Math.min(height - 10, y + Math.max(r, 21) + 18), colors.goal, '11px system-ui');
    }

    for (const source of SOURCES) {
      const sx = screenX(source.x);
      const sy = screenY(source.y);
      if (sx < 0 || sx > width || sy < 0 || sy > height) continue;
      const color = colors.wave[source.id - 1];
      circle(sx, sy, 3.2);
      ctx.fillStyle = color;
      ctx.fill();
      if (source.id !== 3 || r > 24) {
        label(`源 ${source.id}`, Math.min(sx + 7, width - 31), sy - (source.id === 3 ? 24 : 6), color, '11px system-ui');
      } else {
        label('源 3', sx + 8, sy + 17, color, '11px system-ui');
      }
    }
  }

  function drawRoute(latest) {
    if (route.length > 1) {
      ctx.beginPath();
      ctx.moveTo(screenX(route[0].x), screenY(route[0].y));
      for (let index = 1; index < route.length; index++) ctx.lineTo(screenX(route[index].x), screenY(route[index].y));
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = '#79dff79e';
      ctx.lineWidth = 1.35;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const occupied = new Set();
    function mark(hole) {
      const x = screenX(hole.x);
      const y = screenY(hole.y);
      if (x < 0 || x > width || y < 0 || y > height) return;
      const text = `H${hole.index}`;
      const textWidth = text.length * 7;
      const left = Math.min(x + 4, width - textWidth - 2);
      for (const offset of [-11, 17, -24, 30, -37, 43, -50, 56]) {
        const baseline = y + offset;
        if (baseline < 11 || baseline > height - 3) continue;
        const cells = [];
        for (let row = Math.floor((baseline - 10) / 8); row <= Math.floor((baseline + 2) / 8); row++) {
          for (let column = Math.floor((left - 2) / 7); column <= Math.floor((left + textWidth) / 7); column++) {
            cells.push(`${row}/${column}`);
          }
        }
        if (cells.some(cell => occupied.has(cell))) continue;
        cells.forEach(cell => occupied.add(cell));
        if (Math.abs(offset) > 20) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(left, baseline + (offset < 0 ? 2 : -10));
          ctx.strokeStyle = '#5c91a74d';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        label(text, left, baseline, '#b5d9e6');
        return;
      }
    }
    const highlighted = new Set([route[0], route.at(-1), ...route.slice(Math.max(0, latest - 2), latest + 1)]);
    highlighted.forEach(mark);
    for (const hole of route) {
      const x = screenX(hole.x);
      const y = screenY(hole.y);
      if (x < 0 || x > width || y < 0 || y > height) continue;
      circle(x, y, hole === route[0] || hole === route.at(-1) ? 3.6 : 2);
      ctx.fillStyle = '#6db9cc';
      ctx.fill();
      if (!highlighted.has(hole)) mark(hole);
    }
  }

  function drawArrow(from, to) {
    const x = screenX(from.x);
    const y = screenY(from.y);
    const tx = screenX(to.x);
    const ty = screenY(to.y);
    const length = Math.hypot(tx - x, ty - y);
    const angle = Math.atan2(ty - y, tx - x);
    const compact = length < 18;
    const lift = compact ? 19 : 0;
    const tipX = tx - (compact ? 0 : 7) * Math.cos(angle);
    const tipY = ty - (compact ? 0 : 7) * Math.sin(angle) - lift;
    const head = compact ? 5 : 8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    if (compact) ctx.lineTo(x - 3 * Math.cos(angle), y - lift);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(tipX - head * Math.cos(angle - 0.55), tipY - head * Math.sin(angle - 0.55));
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - head * Math.cos(angle + 0.55), tipY - head * Math.sin(angle + 0.55));
    ctx.strokeStyle = colors.new;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  const collides = ({ x, y }, circles) => circles.some(wave => (
    Math.abs(Math.hypot(x - wave.cx, y - wave.cy) - wave.r) <= holeRadius
  ));

  function drawHole(hole, condition, hit) {
    const x = screenX(hole.x);
    const y = screenY(hole.y);
    const r = holeRadius * camera.scale;
    const remaining = hole.tExpire === null ? 0 : hole.tExpire - time;
    const shade = condition === 'old' ? colors.old : condition === 'new' ? colors.new : colors.route;
    const color = hit ? colors.hit : shade;
    ctx.save();
    if (!hit && condition === 'old') ctx.globalAlpha = 0.2 + 0.8 * remaining;
    if (!hit && condition === 'new') ctx.globalAlpha = 0.65 + 0.35 * Math.cos((time - hole.tOpen) * tau * 5);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = hit || condition === 'current' ? 12 : 6;
    circle(x, y, r);
    if (condition === 'current') ctx.fill();
    else ctx.stroke();
    if (condition === 'new') ctx.setLineDash([3, 3]);
    circle(x, y, Math.max(r + 3, condition === 'old' ? 5.5 : 8));
    ctx.stroke();
    ctx.restore();
    if (hit || condition === 'old') {
      label(hit ? '被探测' : `${Math.max(0.1, remaining).toFixed(1)}s`, x + 9, y + 15, color);
    }
  }

  function latestOpen() {
    let low = 0;
    let high = route.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (route[middle].tOpen <= time) low = middle;
      else high = middle;
    }
    return low;
  }

  function draw() {
    if (!camera) return;
    const circles = waveField.getActiveCircles(time);
    grid();
    drawWaves(circles);
    drawGoalAndSources();
    const index = latestOpen();
    drawRoute(index);
    const newest = route[index];
    let hit = null;
    let state = 'H0 · 原地等待';
    if (!found || time <= duration) {
      const inTransit = time < newest.tArrive;
      if (inTransit) drawArrow(route[index - 1], newest);
      for (let i = index; i >= 0; i--) {
        const hole = route[i];
        if (hole.tExpire !== null && time >= hole.tExpire) break;
        const detected = collides(hole, circles);
        if (detected) hit = hole;
        drawHole(hole, i < index ? 'old' : inTransit ? 'new' : 'current', detected);
      }
      if (found) {
        if (inTransit) state = `H${index - 1} → H${index} · 瞬移中`;
        else if (index === route.length - 1) state = time >= duration ? '目标留守完成' : `H${index} · 目标留守中`;
        else state = `H${index} · 人物所在洞`;
      }
    } else {
      state = '目标留守完成';
    }

    const control = route[0];
    const comparisonHit = compare.checked && collides(control, circles);
    if (compare.checked && (index > 0 || time > duration)) {
      const x = screenX(control.x);
      const y = screenY(control.y);
      circle(x, y, 12);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = comparisonHit ? colors.hit : '#9ab0c5';
      ctx.lineWidth = 1.7;
      ctx.stroke();
      ctx.setLineDash([]);
      label(comparisonHit ? '对照被探测' : '原地对照', x + 14, y + 4, ctx.strokeStyle, '11px system-ui');
    }
    mapStatus.classList.toggle('warning', Boolean(hit || comparisonHit));
    const status = hit ? `H${hit.index} · 被探测` : comparisonHit ? 'H0 · 原地对照被探测' : state;
    const statusLabel = mapStatus.lastElementChild;
    if (statusLabel.textContent !== status) statusLabel.textContent = status;
  }

  function setPlaying(playing) {
    if (animation) cancelAnimationFrame(animation);
    animation = playing ? requestAnimationFrame(frame) : 0;
    lastFrame = null;
    play.innerHTML = playing ? '<span aria-hidden="true">Ⅱ</span> 暂停' : '<span aria-hidden="true">▶</span> 播放';
  }

  function seek(target, jumpIndex = null) {
    time = Math.max(0, Math.min(end, target));
    timeInput.value = time;
    clock.textContent = `${time.toFixed(2)} / ${end.toFixed(2)} s`;
    const button = stepButtons[(jumpIndex ?? latestOpen()) - 1];
    if (selected !== button) {
      selected?.removeAttribute('aria-current');
      button?.setAttribute('aria-current', 'step');
      selected = button;
    }
    draw();
  }

  function frame(now) {
    const elapsed = lastFrame === null ? 0 : (now - lastFrame) / 1000;
    seek(time + elapsed * Number(speed.value));
    lastFrame = now;
    if (time >= end) setPlaying(false);
    else animation = requestAnimationFrame(frame);
  }

  function updateEnd() {
    end = compare.checked || !found ? Math.max(duration, 120) : duration;
    timeInput.max = end;
    seek(time);
  }

  function showSteps() {
    const fragment = document.createDocumentFragment();
    stepButtons = route.slice(1).map(hole => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const position = `(${hole.x.toFixed(1)}, ${hole.y.toFixed(1)})`;
      const when = `${hole.tOpen.toFixed(2)} s`;
      button.title = `H${hole.index} ${position} · 等待 ${(hole.tOpen - route[hole.index - 1].tArrive).toFixed(2)} s`;
      for (const [className, text] of [['jump-index', `H${hole.index}`], ['jump-coords', position], ['jump-time', when]]) {
        const cell = document.createElement('span');
        cell.className = className;
        cell.textContent = text;
        button.append(cell);
      }
      button.addEventListener('click', () => {
        setPlaying(false);
        seek(hole.tOpen, hole.index);
      });
      row.append(button);
      fragment.append(row);
      return button;
    });
    if (!stepButtons.length) {
      const row = document.createElement('li');
      row.className = 'empty-steps';
      row.textContent = '暂无跳跃步骤';
      fragment.append(row);
    }
    stepsList.replaceChildren(fragment);
  }

  function metric(id, value, unit = '') {
    const element = byId(id);
    element.textContent = value;
    if (!unit) return;
    const suffix = document.createElement('span');
    suffix.textContent = ` ${unit}`;
    element.append(suffix);
  }

  function showResult({ result, error }) {
    setPlaying(false);
    found = Boolean(result?.found);
    duration = result?.stats.totalTime ?? 0;
    route = found ? result.holesTimeline : [initialHole(startX)];
    solution.className = `solution ${found ? 'found' : 'failed'}`;
    solution.textContent = found ? '已找到安全路径' : error ? `规划失败 · ${error}` : `未找到路径 · ${result.reason}`;
    metric('duration', found ? duration.toFixed(2) : '—', found ? 's' : '');
    metric('jumps', found ? result.stats.jumps : '—');
    const clearance = result?.stats.minSafetyMargin;
    metric('clearance', found ? Number.isFinite(clearance) ? clearance.toFixed(2) : '∞' : '—', found ? 'm' : '');
    metric('runtime', result ? result.stats.computeMs.toFixed(2) : '—', result ? 'ms' : '');
    showSteps();
    updateEnd();
    seek(0);
    if (width) fit();
    solveButton.disabled = false;
  }

  function solve(event) {
    event?.preventDefault();
    if (solveButton.disabled) return;
    const requestedStart = startInput.valueAsNumber;
    if (!Number.isFinite(requestedStart) || requestedStart <= 50) {
      startInput.setCustomValidity('请输入大于 50 m 的有限数值');
      startInput.reportValidity();
      return;
    }
    startX = requestedStart;
    setPlaying(false);
    seek(0);
    solveButton.disabled = true;
    solution.className = 'solution';
    solution.textContent = '正在求解…';
    worker.postMessage({ xStart: startX, safetyMargin: marginInput.valueAsNumber });
  }

  worker.addEventListener('message', ({ data }) => showResult(data));
  worker.addEventListener('error', () => showResult({ error: '无法运行求解模块' }));
  byId('planner').addEventListener('submit', solve);
  startInput.addEventListener('input', () => startInput.setCustomValidity(''));
  byId('focus').addEventListener('click', () => fit());
  byId('view-reset').addEventListener('click', () => fit(false));
  play.addEventListener('click', () => {
    if (!end) return;
    if (!animation && time >= end) seek(0);
    setPlaying(!animation);
  });
  byId('restart').addEventListener('click', () => {
    setPlaying(false);
    seek(0);
  });
  compare.addEventListener('change', updateEnd);
  timeInput.addEventListener('input', () => {
    setPlaying(false);
    seek(timeInput.valueAsNumber);
  });

  canvas.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || !camera) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-dragging');
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    camera.x -= (event.clientX - drag.x) / camera.scale;
    camera.y += (event.clientY - drag.y) / camera.scale;
    drag.x = event.clientX;
    drag.y = event.clientY;
    viewMode = null;
    draw();
  });
  canvas.addEventListener('lostpointercapture', () => {
    drag = null;
    canvas.classList.remove('is-dragging');
  });
  canvas.addEventListener('wheel', event => {
    if (!camera) return;
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left - width / 2;
    const y = height / 2 - (event.clientY - bounds.top);
    const scale = camera.scale;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    camera.scale = Math.min(40, Math.max(Math.min(0.000001, scale), scale * Math.exp(-event.deltaY * multiplier * 0.0015)));
    camera.x += x / scale - x / camera.scale;
    camera.y += y / scale - y / camera.scale;
    viewMode = null;
    draw();
  }, { passive: false });

  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('resize', resize);
  resize();
  solve();
}
