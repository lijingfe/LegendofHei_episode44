import { createWaveField, SOURCES } from '../../波源立体几何重建/2d/wave-field.js';

const waveField = createWaveField({ sources: SOURCES, maxRadius: Infinity });
const goalRadius = 50;
const holeRadius = 1;
const stages = {
  prefix: { name: '直行前奏', color: '#9bb2c7' },
  front: { name: '原片前 9 跳', color: '#79dff7' },
  middle: { name: '中段衔接', color: '#bdabf8' },
  end: { name: '原片末 5 跳', color: '#7ce7bd' },
};
const colors = {
  background: '#081322', wave: ['#73a8ff', '#a489ee', '#79dff7', '#7bddb7', '#eba6bb'],
  goal: '#7ce7bd', route: '#79dff7', old: '#ffc17a', new: '#e0faff', hit: '#ff8092',
};
const tau = 2 * Math.PI;
const byId = id => document.getElementById(id);
const canvas = byId('field');
const ctx = canvas.getContext('2d', { alpha: false });
const timeInput = byId('time');
const clock = byId('clock');
const speed = byId('speed');
const play = byId('play');
const restart = byId('restart');
const stepsList = byId('steps');
const stageNav = byId('stage-nav');
const selectors = [byId('travel'), byId('lifetime'), byId('start')];
const angleButtons = [...document.querySelectorAll('.angle-switch button')];
const btButtons = [...document.querySelectorAll('.bt-switch button')];
const angleSubtitle = byId('angle-subtitle');
const favToggle = byId('fav-toggle');
const favList = byId('favorites-list');
const favCount = byId('fav-count');
const solution = byId('solution');
const mapStatus = byId('map-status');
const scaleBar = byId('scale-bar');
const scaleLength = byId('scale-length');

let paths = [];
let activeHypothesis = 'H_fix_60_90';
let activeBt = 'all';
let activePath = null;
let route = [];
const FAV_STORAGE_KEY = 'ep44_canon_favorites_v1';
let favorites = [];
try {
  favorites = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '[]');
  if (!Array.isArray(favorites)) favorites = [];
} catch {
  favorites = [];
}
let oldLifetime = 1;
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
let selectedStage;
let stepButtons = [];
const stageButtons = new Map();

function fit(mode = 'route') {
  if (mode === true) mode = 'route';
  if (mode === false) mode = 'field';
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  function include({ x, y }) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (mode === 'front' && route.length) {
    const frontIndices = route.reduce((acc, step, idx) => (step.segment === 'front' ? [...acc, idx] : acc), []);
    if (frontIndices.length) {
      const startIdx = Math.max(0, frontIndices[0] - 1);
      const endIdx = frontIndices.at(-1);
      for (let i = startIdx; i <= endIdx; i++) include(route[i]);
      const pad = 90;
      minX -= pad; maxX += pad; minY -= pad; maxY += pad;
    }
  }
  if (!Number.isFinite(minX)) {
    minX = -goalRadius; maxX = goalRadius; minY = -goalRadius; maxY = goalRadius;
    SOURCES.forEach(include);
    if (mode === 'route') route.forEach(include);
  }

  camera = {
    x: minX / 2 + maxX / 2, y: minY / 2 + maxY / 2,
    scale: Math.min((width - 64) / (maxX - minX), (height - 82) / (maxY - minY)),
  };
  viewMode = mode;
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
  if (viewMode) fit(viewMode);
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
  for (const [segment, stage] of Object.entries(stages)) {
    ctx.beginPath();
    for (let i = 1; i < route.length; i++) {
      if (route[i].segment !== segment) continue;
      if (route[i - 1].segment !== segment || i === 1) {
        ctx.moveTo(screenX(route[i - 1].x), screenY(route[i - 1].y));
      }
      ctx.lineTo(screenX(route[i].x), screenY(route[i].y));
    }
    ctx.setLineDash(segment === 'prefix' ? [4, 5] : []);
    ctx.strokeStyle = stage.color;
    ctx.globalAlpha = segment === 'prefix' ? 0.76 : 0.94;
    ctx.lineWidth = segment === 'prefix' ? 1.3 : 2.3;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const labelCenters = [];
  const priority = new Set([latest, 0, route.length - 1]);
  for (const [i, hole] of route.entries()) {
    const x = screenX(hole.x);
    const y = screenY(hole.y);
    if (x < 0 || x > width || y < 0 || y > height) continue;
    const change = hole.segment !== route[i - 1]?.segment;
    circle(x, y, change || i === latest ? 3 : 1.7);
    ctx.fillStyle = stages[hole.segment].color;
    ctx.fill();
    if (change) priority.add(i);
  }
  for (const i of priority) {
    const hole = route[i];
    const x = screenX(hole.x);
    const y = screenY(hole.y);
    if (x < 0 || x > width || y < 0 || y > height) continue;
    const left = Math.min(x + 5, width - 29);
    const baseline = y < 24 ? y + 21 : y - 11;
    const lane = [baseline, baseline - 14, baseline + 25].find(candidate => candidate > 12 && candidate < height - 4
      && labelCenters.every(([lx, ly]) => Math.abs(lx - left) >= 34 || Math.abs(ly - candidate) >= 12));
    if (lane === undefined) continue;
    labelCenters.push([left, lane]);
    label(`H${hole.index}`, left, lane, stages[hole.segment].color);
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
  if (!hit && condition === 'old') ctx.globalAlpha = 0.2 + 0.8 * Math.min(1, Math.max(0, remaining / oldLifetime));
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
  if (!route.length) return;

  const index = latestOpen();
  const newest = route[index];
  drawRoute(index);
  const transferring = time < newest.tArrive;
  if (transferring) drawArrow(route[index - 1], newest);
  let hit = null;
  for (let i = index; i >= 0; i--) {
    const hole = route[i];
    const final = i === route.length - 1;
    if (!final && time >= hole.tExpire) break;
    if (final && time > hole.tExpire) continue;
    const detected = collides(hole, circles);
    if (detected) hit = hole;
    drawHole(hole, i < index ? 'old' : transferring ? 'new' : 'current', detected);
  }
  const phase = stages[newest.segment].name;
  let status = `${phase} · H${index} 人物所在洞`;
  if (transferring) status = `${phase} · H${index - 1} → H${index} 穿越中`;
  else if (time >= end) status = '接应区留守完成';
  else if (index === route.length - 1) status = time <= newest.tExpire ? '接应区留守中' : '等待最后的旧洞消失';
  if (hit) status = `H${hit.index} · 被探测`;
  mapStatus.classList.toggle('warning', Boolean(hit));
  if (mapStatus.lastElementChild.textContent !== status) mapStatus.lastElementChild.textContent = status;
}

function setPlaying(playing) {
  if (animation) cancelAnimationFrame(animation);
  animation = playing ? requestAnimationFrame(frame) : 0;
  lastFrame = null;
  play.innerHTML = playing ? '<span aria-hidden="true">Ⅱ</span> 暂停' : '<span aria-hidden="true">▶</span> 播放';
}

function seek(target, jumpIndex) {
  time = Math.max(0, Math.min(end, target));
  timeInput.value = time;
  clock.textContent = `${time.toFixed(2)} / ${end.toFixed(2)} s`;
  const index = jumpIndex ?? latestOpen();
  const button = stepButtons[index - 1];
  if (selected !== button) {
    selected?.removeAttribute('aria-current');
    button?.setAttribute('aria-current', 'step');
    selected = button;
  }
  const stage = stageButtons.get(route[index]?.segment);
  if (selectedStage !== stage) {
    selectedStage?.removeAttribute('aria-current');
    stage?.setAttribute('aria-current', 'step');
    selectedStage = stage;
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

function jumpTo(hole, revealRow = false) {
  setPlaying(false);
  const previous = route[hole.index - 1] ?? hole;
  if (camera && [hole, previous].some(point => screenX(point.x) < 18 || screenX(point.x) > width - 18
    || screenY(point.y) < 18 || screenY(point.y) > height - 18)) {
    camera.x = (hole.x + previous.x) / 2;
    camera.y = (hole.y + previous.y) / 2;
    viewMode = null;
  }
  seek(hole.tOpen, hole.index);
  if (revealRow && selected) {
    const start = stepsList.getBoundingClientRect().top;
    stepsList.scrollTop += selected.getBoundingClientRect().top - start - 28;
  }
}

function showSteps() {
  const rows = document.createDocumentFragment();
  const stageLinks = document.createDocumentFragment();
  stageButtons.clear();
  stepButtons = route.slice(1).map(hole => {
    const { segment } = hole;
    if (!stageButtons.has(segment)) {
      const stageButton = document.createElement('button');
      stageButton.type = 'button';
      stageButton.textContent = stages[segment].name;
      stageButton.dataset.segment = segment;
      stageButton.title = `跳至 ${hole.tOpen.toFixed(1)} s`;
      stageButton.addEventListener('click', () => jumpTo(hole, true));
      stageButtons.set(segment, stageButton);
      stageLinks.append(stageButton);
      const heading = document.createElement('li');
      heading.className = 'stage-heading';
      heading.dataset.segment = segment;
      heading.textContent = stages[segment].name;
      rows.append(heading);
    }
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.segment = segment;
    button.dataset.open = hole.tOpen;
    const position = `(${hole.x.toFixed(1)}, ${hole.y.toFixed(1)})`;
    button.title = `H${hole.index} ${position} · 等待 ${hole.waitTime.toFixed(1)} s · 步长 ${hole.stepDist.toFixed(1)} m`;
    const detail = document.createElement('span');
    detail.className = 'jump-detail';
    function textCell(name, text) {
      const cell = document.createElement('span');
      cell.className = name;
      cell.textContent = text;
      return cell;
    }
    detail.append(textCell('jump-instruction', hole.label), textCell('jump-coords', position));
    button.append(textCell('jump-index', `H${hole.index}`), detail, textCell('jump-time', `${hole.tOpen.toFixed(1)} s`));
    button.addEventListener('click', () => jumpTo(hole));
    row.append(button);
    rows.append(row);
    return button;
  });
  stepsList.replaceChildren(rows);
  stageNav.replaceChildren(stageLinks);
  stepsList.scrollTop = 0;
}

function favKey(item) {
  return `${item.hypothesis ?? 'H_fix_60_90'}|${item.travel}|${item.oldLifetime}|${item.x0}`;
}

const ANGLE_META = {
  H_fix_60_90: { tag: '60/90', subtitle: 'Episode 44 · 一号位固定 −x，二号位 ±60°，三号位 ±90°' },
  H_fix_45_90: { tag: '45/90', subtitle: 'Episode 44 · 一号位固定 −x，二号位 ±45°，三号位 ±90°' },
  H_fix_30_60: { tag: '30/60', subtitle: 'Episode 44 · 一号位固定 −x，二号位 ±30°，三号位 ±60°' },
};

function saveFavorites() {
  try { localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(favorites)); } catch {}
}

function renderFavorites() {
  if (!favList || !favCount) return;
  favCount.textContent = favorites.length;
  const currentKey = activePath ? favKey(activePath) : null;
  if (favToggle) {
    const saved = Boolean(currentKey && favorites.some(item => favKey(item) === currentKey));
    favToggle.disabled = !activePath;
    favToggle.setAttribute('aria-pressed', String(saved));
    favToggle.textContent = saved ? '★ 已收藏' : '☆ 收藏当前';
  }
  if (!favorites.length) {
    const empty = document.createElement('li');
    empty.className = 'favorites-empty';
    empty.textContent = '暂无收藏，点击右上角 ☆ 收藏当前参数';
    favList.replaceChildren(empty);
    return;
  }
  favList.replaceChildren(...favorites.map(item => {
    const li = document.createElement('li');
    const key = favKey(item);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fav-jump';
    if (key === currentKey) btn.setAttribute('aria-current', 'true');
    const angleTag = (ANGLE_META[item.hypothesis] ?? ANGLE_META.H_fix_60_90).tag;
    btn.textContent = `[${angleTag}] t=${item.travel.toFixed(1)} old=${item.oldLifetime.toFixed(1)} x₀=${item.x0}`;
    btn.title = `安全裕度 ${item.minMargin?.toFixed(2) ?? '—'} m · 点击切换`;
    btn.addEventListener('click', () => {
      activeHypothesis = item.hypothesis ?? 'H_fix_60_90';
      activeBt = 'all';
      for (const b of angleButtons) b.setAttribute('aria-pressed', String(b.dataset.hypothesis === activeHypothesis));
      for (const b of btButtons) b.setAttribute('aria-pressed', String(b.dataset.bt === 'all'));
      if (angleSubtitle) {
        angleSubtitle.textContent = (ANGLE_META[activeHypothesis] ?? ANGLE_META.H_fix_60_90).subtitle;
      }
      selectors[0].value = item.travel;
      refreshOptions();
      selectors[1].value = item.oldLifetime;
      refreshOptions();
      selectors[2].value = item.x0;
      refreshOptions();
    });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'fav-remove';
    rm.textContent = '×';
    rm.title = '移除收藏';
    rm.addEventListener('click', () => {
      favorites = favorites.filter(f => favKey(f) !== key);
      saveFavorites();
      renderFavorites();
    });
    li.append(btn, rm);
    return li;
  }));
}

function showRoute(path, available) {
  setPlaying(false);
  activePath = path;
  route = path.steps;
  oldLifetime = path.oldLifetime;
  end = path.finishTime;
  timeInput.max = end;
  for (const input of [play, restart, timeInput]) input.disabled = false;
  byId('duration').textContent = `${end.toFixed(1)} s`;
  byId('jumps').textContent = path.totalSteps;
  byId('clearance').textContent = `${path.minMargin.toFixed(2)} m`;
  byId('backtrack').textContent = `${path.bt} 跳`;
  solution.textContent = `已验证贯通 · 当前参数有 ${available} 个起点`;
  solution.className = 'solution found';
  showSteps();
  const frontStep = route.find(step => step.segment === 'front');
  const startFocusTime = frontStep ? frontStep.tOpen : 0;
  time = startFocusTime;
  if (width) fit('front');
  seek(startFocusTime);
  renderFavorites();
}

function refreshOptions() {
  let matches = paths.filter(path => (path.hypothesis ?? 'H_fix_60_90') === activeHypothesis
    && (activeBt === 'all' || path.bt === Number(activeBt)));
  if (!matches.length) {
    for (const select of selectors) { select.replaceChildren(); select.disabled = true; }
    solution.textContent = '当前方位角与 bt 筛选下无可行贯通解';
    solution.className = 'solution';
    return;
  }
  for (const [i, key] of ['travel', 'oldLifetime', 'x0'].entries()) {
    const select = selectors[i];
    const previous = Number(select.value);
    if (i < 2) {
      const values = [...new Set(matches.map(path => path[key]))].sort((a, b) => i === 0 ? b - a : a - b);
      select.replaceChildren(...values.map(value => new Option(`${value.toFixed(1)} s`, value)));
      if (values.includes(previous)) select.value = previous;
      select.disabled = false;
      matches = matches.filter(path => path[key] === Number(select.value));
    } else {
      const sorted = [...matches].sort((a, b) => a.bt - b.bt || a.x0 - b.x0);
      select.replaceChildren(...sorted.map(path => new Option(`${path.x0.toLocaleString('en-US')} m (bt=${path.bt})`, path.x0)));
      if (sorted.some(path => path.x0 === previous)) select.value = previous;
      select.disabled = false;
    }
  }
  showRoute(matches.find(path => path.x0 === Number(selectors[2].value)), matches.length);
}

for (const select of selectors) select.addEventListener('change', refreshOptions);
for (const button of angleButtons) {
  button.addEventListener('click', () => {
    activeHypothesis = button.dataset.hypothesis;
    for (const btn of angleButtons) btn.setAttribute('aria-pressed', String(btn === button));
    if (angleSubtitle) {
      angleSubtitle.textContent = (ANGLE_META[activeHypothesis] ?? ANGLE_META.H_fix_60_90).subtitle;
    }
    refreshOptions();
  });
}
for (const button of btButtons) {
  button.addEventListener('click', () => {
    activeBt = button.dataset.bt;
    for (const btn of btButtons) btn.setAttribute('aria-pressed', String(btn === button));
    refreshOptions();
  });
}
byId('focus-front')?.addEventListener('click', () => fit('front'));
byId('focus').addEventListener('click', () => fit('route'));
byId('view-reset').addEventListener('click', () => fit('field'));
favToggle?.addEventListener('click', () => {
  if (!activePath) return;
  const key = favKey(activePath);
  if (favorites.some(item => favKey(item) === key)) {
    favorites = favorites.filter(item => favKey(item) !== key);
  } else {
    favorites.push({
      hypothesis: activePath.hypothesis ?? activeHypothesis,
      travel: activePath.travel,
      oldLifetime: activePath.oldLifetime,
      x0: activePath.x0,
      minMargin: activePath.minMargin,
    });
  }
  saveFavorites();
  renderFavorites();
});
play.addEventListener('click', () => {
  if (!end) return;
  if (!animation && time >= end) seek(0);
  setPlaying(!animation);
});
restart.addEventListener('click', () => {
  setPlaying(false);
  seek(0);
});
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

try {
  const response = await fetch('./unified_paths.json.gz');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const payload = new Response(bytes);
  // A server may already have decoded the gzip content encoding.
  const data = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? await new Response(payload.body.pipeThrough(new DecompressionStream('gzip'))).json()
    : await payload.json();
  if (!data.paths?.length) throw new Error('数据为空');
  paths = data.paths;
  refreshOptions();
} catch (error) {
  solution.className = 'solution failed';
  solution.textContent = `无法加载路线数据：${error.message}`;
  mapStatus.classList.add('warning');
  mapStatus.lastElementChild.textContent = '路线数据未加载';
}
