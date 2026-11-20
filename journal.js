"use strict";

// Daily check-in: hunger, energy, cravings, water retention and (optional) period.
// Stored per day in state.journal; cycle phases are estimated from logged period days.

const JOURNAL_SCALES = [
  { key: "hunger", name: "Hunger", emoji: "🍽️", low: "kaum", high: "sehr" },
  { key: "energy", name: "Energie", emoji: "⚡", low: "müde", high: "fit" },
  { key: "craving", name: "Heißhunger", emoji: "🍫", low: "keiner", high: "stark" },
];
const WATER_RETENTION = ["keine", "leicht", "deutlich"];

function journalDay(k = currentDay) {
  return (state.journal || {})[k] || {};
}

function setJournal(k, patch) {
  state.journal = state.journal || {};
  const next = { ...journalDay(k), ...patch };
  for (const key of Object.keys(next)) if (next[key] === null || next[key] === undefined) delete next[key];
  if (Object.keys(next).length) state.journal[k] = next; else delete state.journal[k];
  save();
}

function cycleOn() {
  return !!state.settings?.cycle;
}

// ---------- Cycle estimation ----------

// First days of each logged period, oldest first
function periodStarts() {
  const j = state.journal || {};
  return Object.keys(j).filter(k => j[k].period && !j[shiftKey(k, -1)]?.period).sort();
}

function cycleInfo() {
  const starts = periodStarts();
  const gaps = starts.slice(1).map((k, i) => Math.round((keyToDate(k) - keyToDate(starts[i])) / 86400000))
    .filter(g => g >= 18 && g <= 45).slice(-6);
  const length = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 28;
  // Typical bleeding length from logged periods (default 5 days)
  const j = state.journal || {};
  const lens = starts.map(s => { let n = 0; while (j[shiftKey(s, n)]?.period) n++; return n; }).filter(n => n > 0).slice(-6);
  const periodLength = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 5;
  return { starts, length, periodLength, measured: gaps.length };
}

const PHASES = {
  mens: { name: "Menstruation", emoji: "🩸" },
  foll: { name: "Follikelphase", emoji: "🌱" },
  ov: { name: "Eisprung-Zeit", emoji: "🌕" },
  lut: { name: "Lutealphase", emoji: "🌙" },
};

// Estimated cycle day and phase for a date, or null without enough data
function cyclePhase(k, info = cycleInfo()) {
  const start = [...info.starts].reverse().find(s => s <= k);
  if (!start) return null;
  const day = Math.round((keyToDate(k) - keyToDate(start)) / 86400000) + 1;
  if (day > info.length + 10) return null;           // too long ago to say anything
  const ovulation = info.length - 14;
  let phase;
  if (journalDay(k).period || day <= info.periodLength) phase = "mens";
  else if (day < ovulation - 1) phase = "foll";
  else if (day <= ovulation + 1) phase = "ov";
  else phase = "lut";
  return { day, phase, ...PHASES[phase] };
}

// ---------- Rendering ----------

function renderJournal() {
  const j = journalDay();
  const scale = s => `<div class="j-row">
      <span class="j-label"><span class="emoji">${s.emoji}</span> ${s.name}</span>
      <div class="j-scale" role="group" aria-label="${s.name}">
        ${[1, 2, 3, 4, 5].map(v => `<button type="button" class="j-dot ${j[s.key] === v ? "on" : ""}" data-j="${s.key}" data-v="${v}" aria-label="${s.name} ${v} von 5">${v}</button>`).join("")}
      </div>
      <span class="j-ends"><small>${s.low}</small><small>${s.high}</small></span>
    </div>`;
  let cycle = "";
  if (cycleOn()) {
    const ph = cyclePhase(currentDay);
    cycle = `<div class="j-cycle">
      <div class="j-cycle-btns">
        <button type="button" class="chip ${j.period ? "active" : ""}" data-j-period>🩸 Periode ${currentDay === todayKey() ? "heute" : "an diesem Tag"}</button>
        <button type="button" class="chip" data-cal-open>📅 Zykluskalender</button>
      </div>
      <span class="muted">${ph ? `Zyklustag ${ph.day} · ${ph.emoji} ${ph.name} <small>(geschätzt)</small>` : "Trag deine Periode ein, dann schätzt die App deine Zyklusphase."}</span>
    </div>`;
  }
  $("#journal").innerHTML = `
    <div class="meal-head"><h3><span class="emoji">📝</span> Wie geht's dir heute?</h3><small>optional</small></div>
    ${JOURNAL_SCALES.map(scale).join("")}
    <div class="j-row">
      <span class="j-label"><span class="emoji">💧</span> Wassereinlagerung</span>
      <div class="j-choice">
        ${WATER_RETENTION.map((w, i) => `<button type="button" class="chip ${j.retention === i ? "active" : ""}" data-j="retention" data-v="${i}">${w}</button>`).join("")}
      </div>
    </div>
    ${cycle}`;
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-j], [data-j-period]");
  if (!b) return;
  if (b.hasAttribute("data-j-period")) setJournal(currentDay, { period: journalDay().period ? null : true });
  else {
    const v = +b.dataset.v;
    // Tapping the selected value again clears it
    setJournal(currentDay, { [b.dataset.j]: journalDay()[b.dataset.j] === v ? null : v });
  }
  renderToday();
});

// ---------- Cycle calendar (month view like a period app) ----------

let calEditing = false;

// What to show on each day: logged period, predicted period, fertile days, ovulation and cycle day
function cycleMarks(info = cycleInfo()) {
  const marks = {};
  const j = state.journal || {};
  for (const k of Object.keys(j)) if (j[k].period) marks[k] = { period: true };
  if (!info.starts.length) return { marks, next: null };
  const today = todayKey();
  // Logged starts, then predicted ones for the next few months
  const starts = info.starts.map(k => ({ k, predicted: false }));
  let next = shiftKey(info.starts.at(-1), info.length);
  if (next <= today) next = shiftKey(today, 1); // period is late: expect it from tomorrow
  const firstPredicted = next;
  for (let i = 0; i < 4; i++, next = shiftKey(next, info.length)) starts.push({ k: next, predicted: true });
  starts.forEach((c, i) => {
    const end = starts[i + 1]?.k || shiftKey(c.k, info.length);
    const len = Math.round((keyToDate(end) - keyToDate(c.k)) / 86400000);
    if (len < 15 || len > 60) return; // a gap in the log, not a real cycle
    const ov = shiftKey(end, -14);
    for (let d = 0; d < len; d++) {
      const k = shiftKey(c.k, d);
      const m = marks[k] = marks[k] || {};
      m.cd = d + 1;
      if (c.predicted && d < info.periodLength && !m.period) m.pred = true;
      if (k === ov) m.ov = true;
      else if (k >= shiftKey(ov, -5) && k <= shiftKey(ov, 1) && !m.period) m.fertile = true;
    }
  });
  return { marks, next: firstPredicted };
}

function openCycleCal() {
  calEditing = false;
  $("#cycle-sheet").hidden = false;
  renderCycleCal();
  // Start at the current month
  const box = $("#cal-months"), now = box.querySelector(".cal-month.now");
  if (now) box.scrollTop = now.offsetTop - box.offsetTop;
}

function closeCycleCal() {
  $("#cycle-sheet").hidden = true;
  renderToday();
}

function renderCycleCal() {
  const info = cycleInfo();
  const { marks, next } = cycleMarks(info);
  const today = todayKey();
  const ph = cyclePhase(today, info);
  const daysTo = next ? Math.round((keyToDate(next) - keyToDate(today)) / 86400000) : null;
  $("#cal-summary").innerHTML = info.starts.length
    ? `<b>${ph ? `Zyklustag ${ph.day} · ${ph.name}` : "Kein aktueller Zyklus"}</b>
       <span>Nächste Periode ca. ${keyToDate(next).toLocaleDateString("de-DE", { day: "numeric", month: "long" })} (in ${daysTo} ${daysTo === 1 ? "Tag" : "Tagen"})</span>
       <span class="muted small">Ø Zyklus ${info.length} Tage · Ø Periode ${info.periodLength} Tage${info.measured ? "" : " (Standardwerte, bis 2 Perioden eingetragen sind)"}</span>`
    : `<b>Noch keine Periode eingetragen</b><span class="muted">Tippe unten auf „Periode bearbeiten“ und markiere die Tage deiner letzten Periode.</span>`;

  const now = keyToDate(today);
  const months = [];
  for (let m = -3; m <= 3; m++) months.push(new Date(now.getFullYear(), now.getMonth() + m, 1));
  $("#cal-months").innerHTML = months.map(first => {
    const y = first.getFullYear(), mo = first.getMonth();
    const days = new Date(y, mo + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // Monday first
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(`<span></span>`);
    for (let d = 1; d <= days; d++) {
      const k = todayKey(new Date(y, mo, d));
      const m = marks[k] || {};
      const cls = [m.period && "period", m.pred && "pred", m.fertile && "fertile", m.ov && "ov", k === today && "today", k > today && "future"].filter(Boolean).join(" ");
      cells.push(`<button type="button" class="cal-day ${cls}" data-cal-day="${k}" ${calEditing && k > today ? "disabled" : ""}>
        <small>${m.cd && !calEditing ? m.cd : ""}</small><span>${d}</span>${k === today ? "<i>Heute</i>" : ""}</button>`);
    }
    const isNow = y === now.getFullYear() && mo === now.getMonth();
    return `<section class="cal-month ${isNow ? "now" : ""}"><h4>${first.toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</h4>
      <div class="cal-grid">${["M", "D", "M", "D", "F", "S", "S"].map(w => `<span class="cal-wd">${w}</span>`).join("")}${cells.join("")}</div></section>`;
  }).join("");
  $("#cal-months").classList.toggle("editing", calEditing);
  $("#cal-edit").textContent = calEditing ? "Fertig" : "Periode bearbeiten";
  $("#cal-hint").hidden = !calEditing;
}

document.addEventListener("click", e => {
  if (e.target.closest("[data-cal-open]")) return openCycleCal();
  const b = e.target.closest("[data-cal-day]");
  if (!b || !calEditing) return;
  const k = b.dataset.calDay;
  setJournal(k, { period: journalDay(k).period ? null : true });
  renderCycleCal();
});
$("#cal-edit").addEventListener("click", () => { calEditing = !calEditing; renderCycleCal(); });
$("#cycle-close").addEventListener("click", closeCycleCal);
$("#cycle-sheet").addEventListener("click", e => { if (e.target.id === "cycle-sheet") closeCycleCal(); });
