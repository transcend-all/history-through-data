// In-browser viewer: map, playback, callouts, chronicle and chart.
// Everything year-dependent happens here, so playback never waits on the server.

const SVG_NS = "http://www.w3.org/2000/svg";
const X0 = -97, X1 = -12, Y0 = -36.5, Y1 = 7;   // map window in degrees
const W = X1 - X0, H = Y1 - Y0;
const EAST_COL_X = -32.3;   // east callouts' left edge
const WEST_COL_X = -76.6;   // west callouts' right edge
const SPLIT_LON = -47.5;    // events east of this get an Atlantic callout
const LINGER = 15;          // years a callout stays on the map
const MAX_PER_SIDE = 3;
const DWELL_MS = 2400;      // pause on event years when "linger" is on
const SPEEDS = { Leisurely: 600, Steady: 300, Brisk: 120 };  // ms per year

const el = (tag, attrs = {}, parent) => {
  const n = tag.startsWith("svg:") ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  if (parent) parent.appendChild(n);
  return n;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pctX = (lon) => ((lon - X0) / W) * 100;
const pctY = (lat) => ((Y1 - lat) / H) * 100;

export default function (component) {
  const { parentElement, data: D } = component;

  // Keep year / playback settings across remounts.
  const saved = parentElement.__viewerState || { year: D.start, speed: "Steady", linger: true };
  parentElement.querySelector(".viewer")?.remove();

  const S = { ...saved, playing: false, timer: null };
  const events = D.events.map((e, i) => ({ ...e, id: i }));
  const eventYears = new Set(events.map((e) => e.year));

  // A state can join partway through (e.g. Acre in 1903): before that it is drawn as foreign land.
  const FOREIGN = (D.theme && D.theme["--neighbor"]) || "#34518F";
  if (D.theme) for (const [k, v] of Object.entries(D.theme)) parentElement.style.setProperty(k, v);
  const stageAt = (st, year) => {
    if (st.joins && year < st.joins) return { stage: -1, since: null, note: st.foreignNote || "" };
    let r = { stage: 0, since: null, note: st.untouched };
    for (const [y, s, n] of st.timeline) {
      if (y > year) break;
      r = { stage: s, since: y, note: n };
    }
    return r;
  };
  const Y = (y) => (y > 0 ? `${y}` : (D.bc || "{y} BC").replace("{y}", -y));   // -264 → "264 BC"
  const eraAt = (year) => D.eras.find(([a, b]) => a <= year && year <= b)[2];

  // ---- skeleton ------------------------------------------------------------

  const root = el("div", { class: "viewer", tabindex: "0" }, parentElement);
  const controls = el("div", { class: "controls" }, root);
  const playBtn = el("button", { class: "play", "aria-label": "Play" }, controls);
  const seg = el("div", { class: "seg", role: "group", "aria-label": "Speed" }, controls);
  const speedBtns = Object.keys(SPEEDS).map((name) => {
    const b = el("button", { text: name, "aria-pressed": "false" }, seg);
    b.onclick = () => setSpeed(name);
    return b;
  });
  const lingerLbl = el("label", { class: "switch" }, controls);
  const lingerBox = el("input", { type: "checkbox" }, lingerLbl);
  el("span", { text: "Linger on events" }, lingerLbl);
  lingerBox.checked = S.linger;
  lingerBox.onchange = () => { S.linger = lingerBox.checked; persist(); };

  const yearbar = el("div", { class: "yearbar" }, root);
  const yearEl = el("span", { class: "year" }, yearbar);
  const eraEl = el("span", { class: "era" }, yearbar);
  const newsEl = el("span", { class: "news" }, yearbar);

  const scrub = el("div", { class: "scrub" }, root);
  const prevEv = el("button", { text: "⏮", title: "Previous event", "aria-label": "Previous event" }, scrub);
  const prevYr = el("button", { text: "◀", title: "Previous year", "aria-label": "Previous year" }, scrub);
  const slider = el("input", { type: "range", min: D.start, max: D.end, step: 1, "aria-label": "Year" }, scrub);
  const nextYr = el("button", { text: "▶", title: "Next year", "aria-label": "Next year" }, scrub);
  const nextEv = el("button", { text: "⏭", title: "Next event", "aria-label": "Next event" }, scrub);

  // ---- map -----------------------------------------------------------------

  const frame = el("div", { class: "frame" }, root);
  frame.style.backgroundImage = `url("${D.seaTile}")`;
  const map = el("div", { class: "map" }, frame);
  const svg = el("svg:svg", { viewBox: `${X0} ${-Y1} ${W} ${H}`, preserveAspectRatio: "xMidYMid meet" }, map);
  el("svg:path", { class: "neighbors", d: D.neighbors }, svg);
  const statePaths = D.states.map((st) => {
    const p = el("svg:path", { class: "state", d: st.d }, svg);
    p.__state = st;
    return p;
  });
  el("svg:path", { class: "outline", d: D.outline }, svg);
  if (D.refLine) {   // optional historical reference line (e.g. the Tordesillas meridian)
    el("svg:line", { class: "tordesillas", x1: D.refLine.lon, x2: D.refLine.lon, y1: -4.2, y2: 30.5 }, svg);
    el("svg:text", { class: "tordesillas-label", x: D.refLine.lon, y: -4.6, "text-anchor": "middle", text: D.refLine.label }, svg);
  }
  const leaderLayer = el("svg:g", {}, svg);
  const markers = events.map((e) => {
    const c = el("svg:circle", { class: "marker", cx: e.lon, cy: -e.lat, r: 0.32 }, svg);
    c.__event = e;
    return c;
  });
  const rings = events.map((e) => el("svg:circle", { class: "ring", cx: e.lon, cy: -e.lat, r: 0.8 }, svg));
  const calloutLayer = el("div", { class: "callouts" }, map);
  const tooltip = el("div", { class: "tooltip" }, map);

  // ---- legend --------------------------------------------------------------

  const legend = el("div", { class: "legend" }, root);
  legend.innerHTML =
    D.stages.map((s) => `<div class="item"><span class="sw" style="background:${s.color}"></span>
      <span><b>${esc(s.name)}</b><br><span class="desc">${esc(s.desc)}</span></span></div>`).join("") +
    (D.states.some((s) => s.joins) ? `<div class="item"><span class="sw" style="background:${FOREIGN}"></span>
      <span><b>${D.notYet || "Not yet Brazilian"}</b><br><span class="desc">${D.notYetDesc || "Territory acquired later"}</span></span></div>` : "") +
    `<div class="item"><span class="mk"></span><span><b>Event site</b><br><span class="desc">Where a milestone happened</span></span></div>` +
    (D.refLine ? `<div class="item"><span class="td"></span><span><b>${esc(D.refLine.legendTitle)}</b><br>
      <span class="desc">${esc(D.refLine.legendDesc)}</span></span></div>` : "");

  // ---- documentary footage for the current chapter ---------------------------

  const film = buildFilm();

  function buildFilm() {
    if (!D.film || !D.film.scenes.length) return null;
    const scenes = D.film.scenes;
    const box = el("div", { class: "film" }, root);
    const media = el("div", { class: "film-media" }, box);
    const vid = el("video", { playsinline: "", preload: "auto" }, media);
    vid.muted = true;
    vid.autoplay = true;
    const info = el("div", { class: "film-info" }, box);
    el("div", { class: "film-kicker", text: "From the documentary" }, info);
    const title = el("div", { class: "film-title" }, info);
    const years = el("div", { class: "film-years" }, info);
    const text = el("p", { class: "film-text" }, info);
    const link = el("a", { class: "film-link" }, info);
    link.textContent = "▶ Watch this chapter in the film";
    let current = null, idx = 0;

    // The chapter for a year: the latest-starting scene that covers it, else the last one before it.
    const sceneFor = (year) => {
      const covering = scenes.filter((s) => s.years[0] <= year && year <= s.years[1]);
      // Overlapping chapters: the most specific (shortest span) wins, then the later start.
      const span = (s) => s.years[1] - s.years[0];
      if (covering.length) return covering.reduce((a, b) =>
        span(b) < span(a) || (span(b) === span(a) && b.years[0] >= a.years[0]) ? b : a);
      const before = scenes.filter((s) => s.years[1] < year);
      return before.length ? before[before.length - 1] : scenes[0];
    };
    const play = () => {
      const sh = current.shots[idx];
      vid.poster = sh.poster || "";
      vid.src = sh.clip;
      vid.play().catch(() => {});
    };
    vid.addEventListener("ended", () => { idx = (idx + 1) % current.shots.length; play(); });

    return {
      setYear(year) {
        const sc = sceneFor(year);
        if (sc === current) return;
        current = sc;
        idx = 0;
        title.textContent = sc.title;
        years.textContent = sc.years[0] === sc.years[1] ? Y(sc.years[0]) : sc.years[0] < 0 && sc.years[1] < 0
          ? (D.bc || "{y} BC").replace("{y}", `${-sc.years[0]}–${-sc.years[1]}`) : `${Y(sc.years[0])} – ${Y(sc.years[1])}`;
        text.textContent = sc.text;
        link.href = `documentary?lang=en&fmt=youtube&t=${Math.floor(sc.start)}`;
        box.classList.remove("swap");
        void box.offsetWidth;   // restart the fade-in
        box.classList.add("swap");
        if (sc.shots.length) play();
      },
    };
  }

  // ---- lower panels --------------------------------------------------------

  const lower = el("div", { class: "lower" }, root);
  const left = el("div", {}, lower);
  el("h3", { text: "Chronicle" }, left);
  const chronicle = el("div", { class: "chronicle" }, left);
  const right = el("div", {}, lower);
  el("h3", { text: D.chartTitle || "Reach across today's territory" }, right);
  const metrics = el("div", { class: "metrics" }, right);
  const metric = (label) => {
    const m = el("div", { class: "metric" }, metrics);
    el("div", { class: "lbl", text: label }, m);
    return el("div", { class: "val" }, m);
  };
  const mStats = D.metrics.map((m) => ({ ...m, el: metric(m.label) }));
  const mMilestones = metric("Milestones so far");
  const chart = buildChart(el("div", { class: "chart" }, right));
  el("p", {
    class: "footnote",
    text: D.chartNote,
  }, right);

  // ---- share chart ---------------------------------------------------------

  function buildChart(host) {
    const VW = 640, VH = 290, ml = 44, mr = 10, mt = 10, mb = 28;
    const iw = VW - ml - mr, ih = VH - mt - mb;
    const n = D.end - D.start;
    const xs = (y) => ml + ((y - D.start) / (n + 1)) * iw;
    const ys = (v) => mt + (1 - v) * ih;
    const c = el("svg:svg", { viewBox: `0 0 ${VW} ${VH}`, role: "img", "aria-label": "Share of territory by stage over time" }, host);
    const axis = el("svg:g", { class: "axis" }, c);
    for (let v = 0; v <= 1.001; v += 0.2) {
      el("svg:line", { class: "grid", x1: ml, x2: VW - mr, y1: ys(v), y2: ys(v) }, axis);
      el("svg:text", { x: ml - 6, y: ys(v) + 4, "text-anchor": "end", text: `${Math.round(v * 100)}%` }, axis);
    }
    const tick = D.end - D.start > 200 ? 50 : 20;
    for (let y = Math.ceil(D.start / tick) * tick; y <= D.end; y += tick) {
      el("svg:text", { x: xs(y), y: VH - 8, "text-anchor": "middle", text: y }, axis);
    }
    // Stacked step areas, most-colonized at the bottom so the frontier grows upward.
    const order = D.stages.map((_, i) => i).reverse();
    const base = D.shares.map(() => 0);
    for (const stage of order) {
      const lo = base.slice();
      D.shares.forEach((row, i) => (base[i] += row[stage]));
      let top = "", bot = "";
      D.shares.forEach((_, i) => {
        const y = D.start + i;
        top += `${i ? "L" : "M"}${xs(y)},${ys(base[i])}L${xs(y + 1)},${ys(base[i])}`;
      });
      for (let i = D.shares.length - 1; i >= 0; i--) {
        const y = D.start + i;
        bot += `L${xs(y + 1)},${ys(lo[i])}L${xs(y)},${ys(lo[i])}`;
      }
      el("svg:path", { class: "area", d: top + bot + "Z", fill: D.stages[stage].color }, c);
    }
    const cursor = el("svg:line", { class: "cursor", x1: 0, x2: 0, y1: mt, y2: mt + ih }, c);
    const hover = el("svg:line", { class: "hover", x1: 0, x2: 0, y1: mt, y2: mt + ih }, c);
    const hit = el("svg:rect", { class: "hit", x: ml, y: mt, width: iw, height: ih }, c);
    const tip = el("div", { class: "tooltip" }, host);

    const yearFromEvent = (ev) => {
      const r = c.getBoundingClientRect();
      const vx = ((ev.clientX - r.left) / r.width) * VW;
      return Math.max(D.start, Math.min(D.end, Math.floor(D.start + ((vx - ml) / iw) * (n + 1))));
    };
    hit.addEventListener("mousemove", (ev) => {
      const y = yearFromEvent(ev);
      const row = D.shares[y - D.start];
      hover.setAttribute("transform", `translate(${xs(y) + (xs(y + 1) - xs(y)) / 2},0)`);
      hover.classList.add("on");
      tip.innerHTML = `<b>${y}</b>` + order.slice().reverse().map((s) =>
        `<div class="row"><span class="dot" style="background:${D.stages[s].color}"></span>` +
        `${esc(D.stages[s].name)}: ${Math.round(row[s] * 100)}%</div>`).join("") +
        `<i>Click to jump here</i>`;
      const hr = host.getBoundingClientRect();
      const x = ev.clientX - hr.left, yy = ev.clientY - hr.top;
      tip.style.left = `${Math.min(x + 14, hr.width - 190)}px`;
      tip.style.top = `${Math.max(0, yy - 40)}px`;
      tip.classList.add("on");
    });
    hit.addEventListener("mouseleave", () => { hover.classList.remove("on"); tip.classList.remove("on"); });
    hit.addEventListener("click", (ev) => { pause(); setYear(yearFromEvent(ev)); });

    return {
      setYear(y) { cursor.setAttribute("transform", `translate(${xs(y) + (xs(y + 1) - xs(y)) / 2},0)`); },
    };
  }

  // ---- callouts ------------------------------------------------------------

  const live = new Map();   // event id -> { e, side, box, leader, cur, target, leaving }

  function activeEvents(year) {
    const recent = events.filter((e) => year - e.year >= 0 && year - e.year < LINGER);
    const east = recent.filter((e) => e.lon > SPLIT_LON).slice(-MAX_PER_SIDE);
    const west = recent.filter((e) => e.lon <= SPLIT_LON).slice(-MAX_PER_SIDE);
    return [...east, ...west];
  }

  function makeCallout(e) {
    const side = e.lon > SPLIT_LON ? "east" : "west";
    const box = el("div", { class: "callout" }, calloutLayer);
    box.innerHTML = `<b><span class="y">${Y(e.year)}</span> · ${esc(e.title)}</b><br>${esc(e.text)}`;
    if (side === "east") box.style.left = `${pctX(EAST_COL_X)}%`;
    else box.style.right = `${100 - pctX(WEST_COL_X)}%`;
    const edge = side === "east" ? EAST_COL_X : WEST_COL_X;
    const leader = el("svg:g", { class: "leader" }, leaderLayer);
    for (const cls of ["case", "core"]) {
      el("svg:line", { class: cls, x1: edge, x2: e.lon, y1: -e.lat, y2: -e.lat }, leader);
    }
    return { e, side, box, leader, cur: null, target: 0, leaving: null };
  }

  function updateCallouts(year) {
    const want = new Set(activeEvents(year).map((e) => e.id));
    for (const [id, c] of live) {
      if (!want.has(id) && !c.leaving) {
        c.box.classList.remove("in");
        c.leader.classList.remove("in");
        c.leaving = setTimeout(() => { c.box.remove(); c.leader.remove(); live.delete(id); }, 700);
      }
    }
    for (const id of want) {
      let c = live.get(id);
      if (!c) { c = makeCallout(events[id]); live.set(id, c); }
      if (c.leaving) { clearTimeout(c.leaving); c.leaving = null; }
      const now = c.e.year === year;
      c.box.classList.toggle("now", now);
      c.leader.classList.toggle("now", now);
    }
    layoutCallouts();
    requestAnimationFrame(() => {
      for (const c of live.values()) if (!c.leaving) { c.box.classList.add("in"); c.leader.classList.add("in"); }
    });
  }

  // Stack each column top to bottom as close to each event's latitude as possible.
  function layoutCallouts(snap = false) {
    const mh = map.clientHeight;
    if (!mh) return;
    const gap = 8, topLim = 10, botLim = mh - 10;
    for (const side of ["east", "west"]) {
      const col = [...live.values()].filter((c) => c.side === side && !c.leaving)
        .sort((a, b) => b.e.lat - a.e.lat);
      let cursor = topLim;
      for (const c of col) {
        const h = c.box.offsetHeight;
        const want = (pctY(c.e.lat) / 100) * mh - h / 2;
        c.target = Math.max(want, cursor);
        c.h = h;
        cursor = c.target + h + gap;
      }
      const last = col[col.length - 1];
      const overflow = last ? last.target + last.h - botLim : 0;
      if (overflow > 0) for (const c of col) c.target -= overflow;
      for (const c of col) if (c.cur === null || snap) c.cur = c.target;
    }
    animateCallouts();
  }

  let rafId = null;
  function animateCallouts() {
    if (rafId) return;
    const step = () => {
      const mh = map.clientHeight;
      let moving = false;
      for (const c of live.values()) {
        const d = c.target - c.cur;
        if (Math.abs(d) > 0.4) { c.cur += d * 0.2; moving = true; } else c.cur = c.target;
        c.box.style.top = `${c.cur}px`;
        const centerLat = Y1 - ((c.cur + c.h / 2) / mh) * H;
        for (const ln of c.leader.children) ln.setAttribute("y1", -centerLat);
      }
      rafId = moving ? requestAnimationFrame(step) : null;
    };
    rafId = requestAnimationFrame(step);
  }

  const ro = new ResizeObserver(() => {
    map.style.setProperty("--callout-fs", `${Math.max(9.5, Math.min(13, map.clientWidth / 98))}px`);
    layoutCallouts(true);
  });
  ro.observe(map);

  // ---- tooltips on the map ---------------------------------------------------

  const showTip = (ev, html) => {
    tooltip.innerHTML = html;
    const r = map.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    tooltip.style.left = `${Math.min(x + 14, r.width - 270)}px`;
    tooltip.style.top = `${Math.min(y + 14, r.height - 110)}px`;
    tooltip.classList.add("on");
  };
  svg.addEventListener("mousemove", (ev) => {
    const t = ev.target;
    if (t.__state) {
      const r = stageAt(t.__state, S.year);
      const since = r.since ? ` since ${r.since}` : "";
      const name = r.stage < 0 ? (D.notYet || "Not yet Brazilian") : D.stages[r.stage].name;
      showTip(ev, `<b>${esc(t.__state.name)}</b><br>${esc(name)}${since}<br><i>${esc(r.note)}</i>`);
    } else if (t.__event) {
      showTip(ev, `<b>${Y(t.__event.year)} · ${esc(t.__event.title)}</b>`);
    } else tooltip.classList.remove("on");
  });
  svg.addEventListener("mouseleave", () => tooltip.classList.remove("on"));

  // ---- year updates --------------------------------------------------------

  let shownPast = -1;
  function render() {
    const year = S.year;
    yearEl.textContent = Y(year);
    eraEl.textContent = eraAt(year);
    const todays = events.filter((e) => e.year === year);
    newsEl.textContent = todays.map((e) => e.title).join(" · ");
    slider.value = year;
    slider.style.setProperty("--pct", `${((year - D.start) / (D.end - D.start)) * 100}%`);

    for (const p of statePaths) {
      const s = stageAt(p.__state, year).stage;
      p.style.fill = s < 0 ? FOREIGN : D.stages[s].color;
    }
    markers.forEach((m, i) => m.classList.toggle("shown", events[i].year <= year));
    rings.forEach((r, i) => r.classList.toggle("now", events[i].year === year));
    updateCallouts(year);

    const past = events.filter((e) => e.year <= year);
    const key = `${past.length}:${todays.length ? year : ""}`;
    if (key !== shownPast) {
      shownPast = key;
      chronicle.innerHTML = past.length
        ? past.slice().reverse().map((e) =>
            `<div class="entry${e.year === year ? " now" : ""}"><span class="yr">${Y(e.year)}</span>` +
            `<span class="ttl">${esc(e.title)}</span><p>${esc(e.text)}</p></div>`).join("")
        : `<p class="empty">Nothing yet.</p>`;
    }

    const row = D.shares[year - D.start];
    for (const m of mStats) m.el.textContent = `${Math.round(m.stages.reduce((a, s) => a + row[s], 0) * 100)}%`;
    mMilestones.textContent = past.length;
    chart.setYear(year);
    if (film) film.setYear(year);
  }

  function setYear(y) {
    S.year = Math.max(D.start, Math.min(D.end, y));
    persist();
    render();
  }

  // ---- playback ------------------------------------------------------------

  function tick() {
    if (!S.playing) return;
    if (S.year >= D.end) return pause();
    setYear(S.year + 1);
    const delay = S.linger && eventYears.has(S.year) ? Math.max(DWELL_MS, SPEEDS[S.speed]) : SPEEDS[S.speed];
    S.timer = setTimeout(tick, delay);
  }
  function play() {
    if (S.year >= D.end) setYear(D.start);
    S.playing = true;
    updatePlayBtn();
    S.timer = setTimeout(tick, SPEEDS[S.speed]);
  }
  function pause() {
    S.playing = false;
    clearTimeout(S.timer);
    updatePlayBtn();
  }
  function updatePlayBtn() {
    playBtn.textContent = S.playing ? "❚❚  Pause" : "▶  Play";
    playBtn.setAttribute("aria-label", S.playing ? "Pause" : "Play");
  }
  function setSpeed(name) {
    S.speed = name;
    speedBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === name)));
    // Fades never outlast a frame, so fast playback stays crisp.
    root.style.setProperty("--fade", `${Math.min(450, Math.round(SPEEDS[name] * 0.9))}ms`);
    persist();
  }
  function persist() {
    parentElement.__viewerState = { year: S.year, speed: S.speed, linger: S.linger };
  }

  const nextEventYear = () => [...eventYears].sort((a, b) => a - b).find((y) => y > S.year) ?? D.end;
  const prevEventYear = () => [...eventYears].sort((a, b) => b - a).find((y) => y < S.year) ?? D.start;

  playBtn.onclick = () => (S.playing ? pause() : play());
  slider.oninput = () => { pause(); setYear(+slider.value); };
  prevYr.onclick = () => { pause(); setYear(S.year - 1); };
  nextYr.onclick = () => { pause(); setYear(S.year + 1); };
  prevEv.onclick = () => { pause(); setYear(prevEventYear()); };
  nextEv.onclick = () => { pause(); setYear(nextEventYear()); };
  root.addEventListener("keydown", (ev) => {
    if (ev.target.tagName === "INPUT" && ev.target.type === "range") return;
    if (ev.key === " ") { ev.preventDefault(); S.playing ? pause() : play(); }
    else if (ev.key === "ArrowRight") { pause(); setYear(S.year + 1); }
    else if (ev.key === "ArrowLeft") { pause(); setYear(S.year - 1); }
  });

  setSpeed(S.speed);
  updatePlayBtn();
  render();

  return () => {
    pause();
    ro.disconnect();
    if (rafId) cancelAnimationFrame(rafId);
    for (const c of live.values()) clearTimeout(c.leaving);
  };
}
