// ===== 战局复盘（战场统计）=====
// 按真实击杀邮件的时间点回放一场会战：播放 / 暂停、倍速、拖动进度条（条上每根刻度是一次击杀，高度按损失价值）；
// 随时间更新双方已损失的舰船数与 ISK、ISK 占比，舰船组成逐格显示剩余 / 出场（刚被击毁的格子闪一下），
// 中间是击杀动态（最新在上，点开看详情——挂在击杀记录页里，沿用页面的 data-kill 点击）。
// model：{ kills: [{ id, t, ship, value, side, char, party, sys }], t0, t1, fielded: { A: Map(ship -> n), B } }
let ctx;   // IMG, typeName, partyName, systemLabel, esc, formatISK
const SPEEDS = [10, 30, 60, 120, 300];
const TILES = 24;
const FEED = 14;
const RP = { box: null, model: null, t: 0, playing: false, speed: 60, raf: 0, last: 0, idx: -1, flash: new Map() };

const clock = (sec) => new Date(sec * 1000).toISOString().slice(11, 19);
const span = (sec) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function initReplay(context) { ctx = context; }

export function stopReplay() {
  cancelAnimationFrame(RP.raf);
  RP.playing = false;
  RP.box = null;
}

export function mountReplay(box, model) {
  const same = RP.model && RP.model.key === model.key;
  stopReplay();
  RP.box = box;
  RP.model = model;
  if (!same) { RP.t = model.t0; RP.idx = -1; }
  box.innerHTML = `<section class="br-rp">
    <div class="br-rp-head">
      <h4>战局复盘</h4>
      <span class="br-rp-clock"><b id="rpClock"></b><small id="rpElapsed"></small></span>
      <div class="br-rp-ctrl">
        <button type="button" class="icon-btn" data-rp="restart" title="回到开头" aria-label="回到开头"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
        <button type="button" class="btn btn-primary br-rp-play" data-rp="play" aria-label="播放"></button>
        <div class="segmented" role="group" aria-label="播放速度">${SPEEDS.map((v) => `<button type="button" data-rp-speed="${v}" class="${RP.speed === v ? 'active' : ''}">×${v}</button>`).join('')}</div>
      </div>
      <button type="button" class="link-btn" data-br-replay-close>收起</button>
    </div>
    <div class="br-rp-track" id="rpTrack"><svg></svg><input type="range" id="rpRange" min="${model.t0}" max="${model.t1}" step="1" value="${RP.t}" aria-label="复盘进度"></div>
    <div class="br-rp-score" id="rpScore"></div>
    <div class="br-rp-body">
      <div class="br-rp-side side-a" id="rpSideA"></div>
      <div class="br-rp-feed"><h5>击杀动态</h5><div id="rpFeed"></div></div>
      <div class="br-rp-side side-b" id="rpSideB"></div>
    </div>
  </section>`;
  box.querySelector('.br-rp').addEventListener('click', onClick);
  const range = box.querySelector('#rpRange');
  range.addEventListener('input', () => { RP.t = Number(range.value); update(true); });
  drawTrack();
  update(true);
}

// 进度条上的击杀刻度：A 方损失在上半、B 方在下半，高度按价值（对数）
function drawTrack() {
  const el = RP.box?.querySelector('#rpTrack svg');
  if (!el) return;
  const { kills, t0, t1 } = RP.model;
  const W = Math.max(280, el.parentElement.clientWidth), H = 44, mid = H / 2;
  const maxV = Math.log10(Math.max(...kills.map((k) => k.value), 1e6));
  const h = (v) => 3 + (Math.log10(Math.max(v, 1e5)) - 5) / Math.max(0.5, maxV - 5) * (mid - 5);
  const x = (t) => (t - t0) / (t1 - t0) * W;
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.innerHTML = `<rect class="br-rp-done" x="0" y="0" width="0" height="${H}"/><line class="br-rp-mid" x1="0" x2="${W}" y1="${mid}" y2="${mid}"/>`
    + kills.map((k) => (k.side === 'A' ? `<rect class="a" x="${x(k.t).toFixed(1)}" y="${(mid - h(k.value)).toFixed(1)}" width="1.6" height="${h(k.value).toFixed(1)}"/>`
      : k.side === 'B' ? `<rect class="b" x="${x(k.t).toFixed(1)}" y="${mid}" width="1.6" height="${h(k.value).toFixed(1)}"/>` : '')).join('')
    + `<line class="br-rp-head-line" x1="0" x2="0" y1="0" y2="${H}"/>`;
}

function onClick(e) {
  const b = e.target.closest('[data-rp]');
  if (b?.dataset.rp === 'play') { if (RP.playing) pause(); else play(); return; }
  if (b?.dataset.rp === 'restart') { RP.t = RP.model.t0; update(true); return; }
  const sp = e.target.closest('[data-rp-speed]');
  if (sp) { RP.speed = Number(sp.dataset.rpSpeed); sp.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === sp)); }
}

function play() {
  if (RP.t >= RP.model.t1) RP.t = RP.model.t0;
  RP.playing = true;
  RP.last = performance.now();
  const step = (now) => {
    if (!RP.playing) return;
    if (!RP.box?.isConnected) { stopReplay(); return; }
    RP.t = Math.min(RP.model.t1, RP.t + (now - RP.last) / 1000 * RP.speed);
    RP.last = now;
    update(false);
    if (RP.t >= RP.model.t1) { pause(); return; }
    RP.raf = requestAnimationFrame(step);
  };
  RP.raf = requestAnimationFrame(step);
  syncPlay();
}

function pause() {
  RP.playing = false;
  cancelAnimationFrame(RP.raf);
  syncPlay();
}

function syncPlay() {
  const b = RP.box?.querySelector('[data-rp="play"]');
  if (!b) return;
  b.innerHTML = RP.playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>暂停'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>播放';
  b.setAttribute('aria-label', RP.playing ? '暂停' : '播放');
}

// 每帧更新时钟与进度；击杀数变化时才重画比分、舰船格与动态
function update(force) {
  const box = RP.box;
  if (!box) return;
  const { kills, t0, t1 } = RP.model;
  box.querySelector('#rpClock').textContent = clock(RP.t) + ' EVE';
  box.querySelector('#rpElapsed').textContent = `+${span(RP.t - t0)} / ${span(t1 - t0)}`;
  const range = box.querySelector('#rpRange');
  if (document.activeElement !== range) range.value = Math.round(RP.t);
  const svg = box.querySelector('#rpTrack svg');
  const W = Number(svg.getAttribute('viewBox').split(' ')[2]);
  const px = (RP.t - t0) / (t1 - t0) * W;
  svg.querySelector('.br-rp-done').setAttribute('width', px);
  const head = svg.querySelector('.br-rp-head-line');
  head.setAttribute('x1', px); head.setAttribute('x2', px);
  let idx = -1;
  while (idx + 1 < kills.length && kills[idx + 1].t <= RP.t) idx++;
  if (!force && idx === RP.idx) return;
  // 播放中新出现的击杀：对应舰船格闪一下
  if (!force && idx > RP.idx) for (let i = RP.idx + 1; i <= idx; i++) if (kills[i].side) RP.flash.set(kills[i].side + kills[i].ship, performance.now());
  RP.idx = idx;
  renderState(idx);
  if (!RP.playing) syncPlay();
}

function renderState(idx) {
  const { kills, fielded } = RP.model;
  const { esc, formatISK: isk, IMG } = ctx;
  const lost = { A: new Map(), B: new Map() }, n = { A: 0, B: 0 }, v = { A: 0, B: 0 };
  for (let i = 0; i <= idx; i++) {
    const k = kills[i];
    if (!k.side) continue;
    n[k.side] += 1;
    v[k.side] += k.value;
    lost[k.side].set(k.ship, (lost[k.side].get(k.ship) || 0) + 1);
  }
  const total = v.A + v.B;
  const pa = total ? v.A / total * 100 : 50;
  // 与下方损失比一致：蓝条为 A 方损失占比、红条为 B 方
  RP.box.querySelector('#rpScore').innerHTML = `
    <div class="side-a"><span class="kb-br-badge">A</span><b>${n.A}</b><small>艘 · ${isk(v.A)} ISK</small></div>
    <div class="br-rp-bar" title="ISK 损失占比"><i class="a" style="width:${pa}%"></i><i class="b" style="width:${100 - pa}%"></i></div>
    <div class="side-b"><small>${isk(v.B)} ISK · 艘</small><b>${n.B}</b><span class="kb-br-badge">B</span></div>`;
  const now = performance.now();
  for (const s of ['A', 'B']) {
    const list = [...fielded[s]].sort((a, b) => b[1] - a[1]);
    const tiles = list.slice(0, TILES).map(([ship, total]) => {
      const l = Math.min(total, lost[s].get(ship) || 0);
      const left = total - l;
      const hit = now - (RP.flash.get(s + ship) || 0) < 900;
      return `<div class="br-rp-tile${left ? '' : ' gone'}${hit ? ' hit' : ''}" title="${esc(ctx.typeName(ship))}：出场 ${total}，已损失 ${l}">
        <img src="${IMG(`types/${ship}/icon`, 32)}" alt="" width="28" height="28" loading="lazy">
        <span><b>${left}</b>/${total}</span><i style="width:${(left / total * 100).toFixed(0)}%"></i></div>`;
    }).join('');
    const rest = list.length - TILES;
    RP.box.querySelector('#rpSide' + s).innerHTML = `<h5>${s} 方舰船<small>剩余 / 出场</small></h5><div class="br-rp-tiles">${tiles}</div>${rest > 0 ? `<p class="br-rp-more">其余 ${rest} 种舰船未显示</p>` : ''}`;
  }
  const feed = [];
  for (let i = idx; i >= 0 && feed.length < FEED; i--) feed.push(kills[i]);
  RP.box.querySelector('#rpFeed').innerHTML = feed.map((k, i) => `<div class="br-rp-kill${k.side ? ' side-' + k.side.toLowerCase() : ''}${i === 0 && RP.playing ? ' new' : ''}" data-kill="${k.id}" tabindex="0">
    <small>${clock(k.t).slice(0, 8)}</small>
    <img src="${IMG(`types/${k.ship}/icon`, 32)}" alt="" width="24" height="24" loading="lazy">
    <span><b>${esc(ctx.typeName(k.ship))}</b><em>${k.char ? esc(ctx.partyName(k.char)) : ''}${k.party ? ' · ' + esc(ctx.partyName(k.party)) : ''}</em></span>
    <i>${isk(k.value)}</i>
  </div>`).join('') || '<p class="br-rp-more">还没有击杀，点「播放」开始</p>';
}

export function resizeReplay() {
  if (!RP.box?.isConnected) return;
  drawTrack();
  update(true);
}
