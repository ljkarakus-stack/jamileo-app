"use strict";

const STORE_KEY = "jamileo-kalorien-check-v1";
// share: part of the daily calorie goal suggested for the meal
const SLOTS = [
  { id: "fruehstueck", name: "Frühstück", emoji: "☕", share: 0.30 },
  { id: "mittag", name: "Mittagessen", emoji: "🍝", share: 0.35 },
  { id: "abend", name: "Abendessen", emoji: "🥗", share: 0.25 },
  { id: "snack", name: "Snacks", emoji: "🍎", share: 0.10 },
];
const GLASS_ML = 250;
// Default clock time per meal when logging for another day
const SLOT_TIMES = { fruehstueck: "08:00", mittag: "12:30", snack: "16:00", abend: "19:00" };

// ---------- State ----------

function blankState() {
  return {
    goals: null, profile: null, days: {}, weights: {}, custom: [], recent: [], amounts: {},
    journal: {}, measures: {}, settings: {}, recipes: [], challenges: [], favorites: [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return Object.assign(blankState(), JSON.parse(raw));
  } catch (e) { /* storage blocked or corrupt: start fresh */ }
  return blankState();
}

let state = load();

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast("Speichern nicht möglich (privater Modus?)"); }
}

let currentDay = todayKey();
let view = "today";

// ---------- Helpers ----------

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (x, d = 0) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString("de-DE", { maximumFractionDigits: d });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function keyToDate(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function shiftKey(k, days) {
  const d = keyToDate(k);
  d.setDate(d.getDate() + days);
  return todayKey(d);
}

function day(k = currentDay) {
  return state.days[k] || { entries: [], water: 0 };
}
function ensureDay(k = currentDay) {
  if (!state.days[k]) state.days[k] = { entries: [], water: 0 };
  return state.days[k];
}
function totals(k) {
  return day(k).entries.reduce((t, e) => ({
    kcal: t.kcal + e.kcal, p: t.p + e.p, kh: t.kh + e.kh, f: t.f + e.f, fib: t.fib + (e.fib || 0),
  }), { kcal: 0, p: 0, kh: 0, f: 0, fib: 0 });
}

function allFoods() {
  return [...state.custom, ...FOODS];
}
function foodById(id) {
  const idea = id.startsWith("idee-") && ideaById(id.slice(5));
  if (idea) return ideaFood(idea);
  const recipe = id.startsWith("rez-") && (state.recipes || []).find(r => "rez-" + r.id === id);
  if (recipe) return recipeFood(recipe);
  return allFoods().find(f => f.id === id);
}
// Nutrients for an amount: grams for per-100 g foods, count for portion foods
function scale(food, amount) {
  const factor = food.portion ? amount : amount / 100;
  return { kcal: food.kcal * factor, p: food.p * factor, kh: food.kh * factor, f: food.f * factor, fib: (food.fib || 0) * factor };
}
function unitOf(food) {
  return food.ml ? "ml" : "g";
}
function baseLabel(food) {
  return food.portion ? `pro ${food.portion}` : `pro 100 ${unitOf(food)}`;
}
// Household units for a food (Stück, Scheibe, EL …) followed by the base unit (g / ml / portion)
function unitsOf(food) {
  if (food.portion) return [{ label: food.portion, size: 1 }];
  const extra = [food.piece, ...(food.units || [])].filter(Boolean).map(([label, size]) => ({ label, size }));
  return [...extra, { label: unitOf(food), size: 1 }];
}
const PLURALS = {
  Scheibe: "Scheiben", Hälfte: "Hälften", Zehe: "Zehen", Kugel: "Kugeln", Keks: "Kekse", Tasse: "Tassen",
  Dose: "Dosen", "kleine Dose": "kleine Dosen", Flasche: "Flaschen", "kleine Flasche": "kleine Flaschen",
  Packung: "Packungen", Filet: "Filets", Glas: "Gläser", Schüssel: "Schüsseln", Portion: "Portionen",
  Shake: "Shakes", Pizza: "Pizzen", "großer Becher": "große Becher",
};
function unitText(label, n) {
  return n === 1 ? label : PLURALS[label] || label;
}
// Last used unit and count, or one piece / 100 g
function defaultPick(food) {
  const units = unitsOf(food);
  const pref = state.amounts[food.id];
  if (pref && typeof pref === "object" && units.some(u => u.label === pref.u)) return pref;
  if (typeof pref === "number") return { u: units[units.length - 1].label, n: pref };
  return { u: units[0].label, n: units[0].size === 1 && !food.portion ? 100 : 1 };
}
// Lowercase and fold umlauts so "haehnchen" finds "Hähnchen"
function fold(str) {
  return str.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- Goals ----------

// Mifflin-St Jeor resting rate × activity factor, then ±7700 kcal per kg at the chosen pace.
// Protein 1.6 g per kg, fat 30 % of calories, carbs the rest.
const KCAL_PER_KG = 7700;
function calcBreakdown({ sex, age, height, weight, activity, goal, pace = 0.5 }) {
  const base = 10 * weight + 6.25 * height - 5 * age;
  const bmr = sex === "m" ? base + 5 : sex === "w" ? base - 161 : base - 78;
  const tdee = bmr * activity;
  const delta = goal === "keep" ? 0 : (goal === "lose" ? -1 : 1) * pace * KCAL_PER_KG / 7;
  const floor = sex === "m" ? 1500 : 1200;
  const kcal = Math.max(floor, Math.round((tdee + delta) / 50) * 50);
  return { bmr, tdee, delta, floor, kcal, floored: tdee + delta < floor, realDelta: kcal - tdee };
}

function calcGoals(profile) {
  const { weight } = profile;
  const { kcal } = calcBreakdown(profile);
  const p = Math.round(weight * 1.6 / 5) * 5;
  const f = Math.round(kcal * 0.3 / 9);
  const kh = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
  const water = Math.round(weight * 35 / GLASS_ML) * GLASS_ML;
  return { kcal, p, kh, f, fib: 30, water };
}

// ---------- Rendering: Heute ----------

// ---------- Refeed day ----------

// Settings: { on, weekday (0 = Sonntag), every (1 or 2 weeks), extra kcal, anchor (a refeed date for the 2-week rhythm) }
function refeedSettings() {
  return state.settings?.refeed || null;
}
function isRefeed(k) {
  const r = refeedSettings();
  if (!r?.on || (state.refeedSkip || {})[k]) return false;
  if (keyToDate(k).getDay() !== r.weekday) return false;
  if (r.every !== 2) return true;
  const weeks = Math.round((keyToDate(k) - keyToDate(r.anchor)) / (7 * 86400000));
  return weeks % 2 === 0;
}
// Suggested extra calories: back up to maintenance, between 200 and 800 kcal
function refeedSuggestion() {
  if (!state.profile) return 500;
  const b = calcBreakdown({ pace: 0.5, ...state.profile });
  return Math.min(800, Math.max(200, Math.round((b.tdee - state.goals.kcal) / 50) * 50));
}
// Goals for a given day: on refeed days the extra calories come as carbohydrates
function dayGoals(k) {
  const g = { fib: 30, ...state.goals };
  if (!isRefeed(k)) return g;
  const extra = refeedSettings().extra || refeedSuggestion();
  return { ...g, kcal: g.kcal + extra, kh: g.kh + Math.round(extra / 4), refeed: extra };
}

function renderRefeedBanner() {
  const el = $("#refeed-banner");
  const r = refeedSettings();
  if (!r?.on) { el.hidden = true; return; }
  const g = dayGoals(currentDay);
  const skipped = (state.refeedSkip || {})[currentDay];
  if (g.refeed) {
    el.innerHTML = `<b>🍝 Refeed Day</b><p>Dein Ziel heute: <b>${num(g.kcal)} kcal</b> (+${num(g.refeed)}). Die Extra-Kalorien am besten aus Kohlenhydraten: Reis, Kartoffeln, Nudeln, Obst. Protein wie immer, Fett eher normal.</p>
      <button class="btn ghost small-btn" data-refeed-skip>Heute doch nicht</button>`;
  } else if (skipped) {
    el.innerHTML = `<b>🍝 Refeed Day ausgelassen</b><p>Normales Ziel heute.</p><button class="btn ghost small-btn" data-refeed-skip>Doch Refeed Day</button>`;
  } else if (isRefeed(shiftKey(currentDay, 1))) {
    el.innerHTML = `<b>🍝 Morgen ist Refeed Day</b><p>Plan schon mal etwas mehr Kohlenhydrate ein, z. B. Pasta oder Reis.</p>`;
  } else { el.hidden = true; return; }
  el.hidden = false;
}

function renderToday() {
  const g = dayGoals(currentDay);
  const t = totals(currentDay);
  const d = keyToDate(currentDay);
  const diff = Math.round((keyToDate(currentDay) - keyToDate(todayKey())) / 86400000);
  $("#day-name").textContent = diff === 0 ? "Heute" : diff === -1 ? "Gestern" : diff === 1 ? "Morgen" : d.toLocaleDateString("de-DE", { weekday: "long" });
  $("#day-date").textContent = d.toLocaleDateString("de-DE", { day: "numeric", month: "long" });

  const left = g.kcal - t.kcal;
  $("#kcal-left").textContent = num(Math.abs(left));
  $("#kcal-left-label").textContent = left >= 0 ? "kcal übrig" : "kcal drüber";
  $("#kcal-eaten").textContent = `${num(t.kcal)} kcal`;
  $("#kcal-goal").textContent = `${num(g.kcal)} kcal`;
  const C = 2 * Math.PI * 52;
  const ring = $("#ring-fg");
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - Math.min(1, t.kcal / g.kcal));
  ring.classList.toggle("over", left < 0);
  renderDeficit(left);
  renderRefeedBanner();
  renderJournal();

  const macros = [
    ["💪", "Protein", t.p, g.p],
    ["🌾", "Kohlenhydrate", t.kh, g.kh],
    ["🫒", "Fett", t.f, g.f],
    ["🥦", "Ballaststoffe", t.fib, g.fib ?? 30],
  ];
  $("#macros").innerHTML = macros.map(([e, name, v, goal]) => {
    const pct = goal ? Math.min(100, v / goal * 100) : 0;
    // Going over protein or fibre is fine; over carbs or fat is flagged
    const over = (name === "Kohlenhydrate" || name === "Fett") && v > goal * 1.05;
    return `<div><div class="macro-top"><span><span class="emoji">${e}</span> ${name}</span><span><b>${num(v)}</b> / ${num(goal)} g</span></div>
      <div class="bar"><i class="${over ? "over" : ""}" style="width:${pct}%"></i></div></div>`;
  }).join("");

  const glasses = Math.max(8, Math.ceil(g.water / GLASS_ML));
  const drunk = day().water;
  $("#water-text").textContent = `${num(drunk / 1000, 2)} / ${num(g.water / 1000, 2)} l`;
  $("#glasses").innerHTML = Array.from({ length: glasses }, (_, i) =>
    `<button class="glass ${i < drunk / GLASS_ML ? "full" : ""}" data-glass="${i}" aria-label="${(i + 1) * GLASS_ML} ml"></button>`).join("");

  // One compact row per meal; tapping it opens the meal with all its entries
  $("#meals").innerHTML = SLOTS.map(s => {
    const list = slotEntries(s.id);
    const kcal = list.reduce((a, e) => a + e.kcal, 0);
    const target = g.kcal * s.share;
    const C = 2 * Math.PI * 22;
    return `<div class="meal-row">
      <button class="meal-open" data-meal="${s.id}">
        <span class="meal-ring">
          <svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="22" class="ring-bg"/>
            <circle cx="26" cy="26" r="22" class="ring-fg ${kcal > target * 1.1 ? "over" : ""}" style="stroke-dasharray:${C};stroke-dashoffset:${C * (1 - Math.min(1, kcal / target))}"/></svg>
          <span class="emoji">${s.emoji}</span>
        </span>
        <span class="meal-info">
          <b>${s.name} <span class="arrow">›</span></b>
          <span class="meal-kcal">${num(kcal)} / ${num(target)} kcal</span>
          ${list.length ? `<span class="meal-items">${esc(list.map(e => e.name).join(", "))}</span>` : ""}
        </span>
      </button>
      <button class="meal-plus" data-add-slot="${s.id}" aria-label="${s.name} hinzufügen">+</button>
    </div>`;
  }).join("");
  if (openMeal) renderMeal();
  const prevAll = day(shiftKey(currentDay, -1)).entries;
  $("#copy-day").hidden = !!day().entries.length || !prevAll.length;
  $("#copy-day").textContent = `↺ Ganzen Tag von ${prevLabel()} übernehmen (${num(prevAll.reduce((a, e) => a + e.kcal, 0))} kcal)`;
}

function slotEntries(slot, k = currentDay) {
  return day(k).entries.filter(e => e.slot === slot).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
}

// ---------- Meal detail ----------

let openMeal = null;

function showMeal(slot) {
  openMeal = slot;
  $("#meal-sheet").hidden = false;
  renderMeal();
}

function closeMeal() {
  openMeal = null;
  $("#meal-sheet").hidden = true;
}

function renderMeal() {
  const s = SLOTS.find(x => x.id === openMeal);
  const list = slotEntries(s.id);
  const t = addUp(list);
  const target = dayGoals(currentDay).kcal * s.share;
  $("#meal-title").textContent = s.name;
  $("#meal-sub").textContent = `${$("#day-name").textContent}, ${$("#day-date").textContent} · Richtwert ${num(target)} kcal`;
  const stat = (v, unit, label) => `<div><b>${num(v, unit === "kcal" ? 0 : 1)} ${unit}</b><span>${label}</span></div>`;
  $("#meal-stats").innerHTML = stat(t.kcal, "kcal", "Kalorien") + stat(t.p, "g", "Protein")
    + stat(t.kh, "g", "Kohlenhydrate") + stat(t.f, "g", "Fett")
    + `<p class="meal-fib muted">Ballaststoffe ${num(t.fib, 1)} g</p>`;
  const prev = prevSlot(s.id);
  $("#meal-list").innerHTML = list.length
    ? list.map(e => `<button class="entry" data-entry="${e.id}">
        <span class="n">${esc(e.name)}</span><span class="k">${num(e.kcal)} kcal ›</span>
        <span class="d">${e.time ? `<span class="t">${e.time}</span> · ` : ""}${esc(e.amountLabel)} · ${num(e.p, 1)} g Protein · ${num(e.kh, 1)} g KH · ${num(e.f, 1)} g Fett</span>
      </button>`).join("")
    : `<p class="empty">Noch nichts eingetragen.</p>${prev.length ? `<button class="add-line copy" data-copy-slot="${s.id}">↺ Wie ${prevLabel()}: ${prev.length} ${prev.length === 1 ? "Eintrag" : "Einträge"}, ${num(prev.reduce((a, e) => a + e.kcal, 0))} kcal</button>` : ""}`;
}

// ---------- Copy from the previous day ----------

function prevLabel() {
  return currentDay === todayKey() ? "gestern" : "Vortag";
}
function prevSlot(slot) {
  return day(shiftKey(currentDay, -1)).entries.filter(e => e.slot === slot);
}
function copyEntries(list) {
  const d = ensureDay();
  for (const e of list) d.entries.push({ ...e, id: uid() });
  save();
  renderToday();
  toast(`${list.length} ${list.length === 1 ? "Eintrag" : "Einträge"} übernommen`);
}

// ---------- Favorites ----------

function isFav(id) {
  return (state.favorites || []).includes(id);
}
function toggleFav() {
  const id = pick.food.id;
  // Online and manual foods must exist in "Eigene" to be found again
  if (!foodById(id)) state.custom.unshift(pick.food);
  state.favorites = isFav(id) ? state.favorites.filter(x => x !== id) : [id, ...(state.favorites || [])];
  save();
  renderFavButton();
  toast(isFav(id) ? "Zu Favoriten hinzugefügt ⭐" : "Aus Favoriten entfernt");
}
function renderFavButton() {
  const on = isFav(pick.food.id);
  $("#fav-toggle").textContent = on ? "★" : "☆";
  $("#fav-toggle").classList.toggle("on", on);
  $("#fav-toggle").setAttribute("aria-label", on ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen");
}

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Average daily gap to the calorie goal over the last n finished days that have entries.
// Positive = under the goal (deficit), negative = over.
function deficitStats(n, endKey = todayKey()) {
  const keys = Array.from({ length: n }, (_, i) => shiftKey(endKey, -i - 1));
  const tracked = keys.filter(k => totals(k).kcal > 0);
  if (!tracked.length) return null;
  const avg = tracked.reduce((a, k) => a + (dayGoals(k).kcal - totals(k).kcal), 0) / tracked.length;
  return { avg, days: tracked.length, total: avg * tracked.length };
}

function deficitText(v) {
  return v >= 0 ? `${num(v)} kcal unter Ziel` : `${num(-v)} kcal über Ziel`;
}

function renderDeficit(todayLeft) {
  const s7 = deficitStats(7), s30 = deficitStats(30);
  if (!s7) { $("#avg-deficit").innerHTML = ""; return; }
  const row = (label, s) => s ? `<div class="row"><span>Ø ${label} (${s.days} ${s.days === 1 ? "Tag" : "Tage"} getrackt)</span><b class="${s.avg >= 0 ? "good" : "bad"}">${deficitText(s.avg)}</b></div>` : "";
  let note = "";
  if (todayLeft < 0 && totals(currentDay).kcal > 0) {
    note = s7.avg >= 0
      ? `Heute bist du drüber, aber im 7-Tage-Schnitt trotzdem ${num(s7.avg)} kcal pro Tag unter deinem Ziel. Ein Tag macht keinen Trend.`
      : "Heute und im 7-Tage-Schnitt über dem Ziel. Vielleicht passt dein Ziel gerade nicht zu deinem Alltag?";
  } else if (s7.days >= 3) {
    note = `Das sind ca. ${num(Math.abs(s7.total))} kcal ${s7.total >= 0 ? "Defizit" : "Überschuss"} in den letzten ${s7.days} getrackten Tagen.`;
  }
  $("#avg-deficit").innerHTML = row("7 Tage", s7) + row("30 Tage", s30) + (note ? `<p>${note}</p>` : "");
}

// ---------- Rendering: Profil ----------

function renderProfile() {
  const f = $("#goals-form");
  for (const k of ["kcal", "p", "kh", "f", "water"]) f.elements[k].value = state.goals[k];
  f.elements.fib.value = state.goals.fib ?? 30;
  const sf = $("#settings-form");
  sf.elements.cycle.checked = !!state.settings?.cycle;
  fillRefeedForm();
  sf.elements.goalWeight.value = state.settings?.goalWeight ?? "";
  $("#goal-explain").innerHTML = state.profile
    ? `<details><summary>Wie wurde mein Ziel berechnet?</summary>${explainGoal({ pace: 0.5, ...state.profile }, state.settings?.goalWeight)}
       <p class="muted small">Gilt für die berechneten Werte. Hast du sie danach selbst geändert, zählen deine Werte.</p></details>`
    : "";
}

function render() {
  if (!state.goals) return;
  if (view === "today") renderToday();
  if (view === "week") renderTrends();
  if (view === "profile") renderProfile();
  if (view === "ideas") renderRecipesView();
}

function showView(v) {
  view = v;
  $$(".view").forEach(s => s.hidden = s.id !== `view-${v}`);
  $$(".tabs [data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  render();
  window.scrollTo(0, 0);
}

// ---------- Add sheet ----------

let pick = null;        // { food, amount, slot, entryId? }
let activeCat = "Alle";

function defaultSlot() {
  const h = new Date().getHours();
  return h < 11 ? "fruehstueck" : h < 15 ? "mittag" : h < 18 ? "snack" : "abend";
}

function openSheet(slot) {
  pick = { slot: slot || defaultSlot() };
  $("#sheet").hidden = false;
  $("#sheet-title").textContent = "Hinzufügen";
  $("#add-tabs").hidden = false;
  $("#search").value = "";
  onlineQuery = null;
  renderFoodList();
  // Reopen where the person left off: whoever scanned last time gets the camera straight away
  showTab(state.settings?.addTab === "scan" ? "scan" : "search");
}

function closeSheet() {
  stopScan();
  $("#sheet").hidden = true;
  pick = null;
}

function showTab(tab, chosen) {
  if (tab !== "scan") stopScan();
  if (chosen && (tab === "scan" || tab === "search") && state.settings?.addTab !== tab) {
    state.settings = { ...state.settings, addTab: tab };
    save();
  }
  $$("#sheet .tab").forEach(t => t.hidden = t.dataset.tab !== tab);
  $$("#add-tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "ideas") renderSheetRecipes();
  if (tab === "scan") startScan();
}

function renderFoodList() {
  const favs = (state.favorites || []).map(foodById).filter(Boolean);
  const cats = ["Alle", ...(favs.length ? ["Favoriten"] : []), "Zuletzt", ...(state.custom.length ? ["Eigene"] : []), ...CATEGORIES];
  if (!cats.includes(activeCat)) activeCat = "Alle";
  $("#cats").innerHTML = cats.map(c => `<button class="chip ${c === activeCat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");

  const raw = $("#search").value.trim();
  const words = fold(raw).split(/\s+/).filter(Boolean);
  let list;
  if (activeCat === "Favoriten") list = favs;
  else if (activeCat === "Zuletzt") list = state.recent.map(foodById).filter(Boolean);
  else if (activeCat === "Eigene") list = state.custom;
  else if (activeCat === "Alle") list = allFoods();
  else list = FOODS.filter(f => f.cat === activeCat);
  if (words.length) {
    list = allFoods().map(f => ({ f, r: matchRank(f.name, words) })).filter(x => x.r < 9)
      .sort((a, b) => a.r - b.r).map(x => x.f);
  }

  const row = f => `<button class="food" data-food="${esc(f.id)}">
      <span class="n">${isFav(f.id) ? "⭐ " : ""}${esc(f.name)}</span><span class="k">${num(f.kcal)} kcal</span>
      <span class="d">${baseLabel(f)} · ${num(f.p, 1)} g Protein · ${num(f.kh, 1)} g KH · ${num(f.f, 1)} g Fett</span>
    </button>`;
  // Without a search, favorites and recent foods come first for fast logging
  let quick = "";
  if (activeCat === "Alle" && !words.length) {
    const recent = state.recent.map(foodById).filter(f => f && !isFav(f.id)).slice(0, 5);
    if (favs.length) quick += `<h3 class="list-head">⭐ Favoriten</h3>${favs.slice(0, 8).map(row).join("")}`;
    if (recent.length) quick += `<h3 class="list-head">🕐 Zuletzt gegessen</h3>${recent.map(row).join("")}`;
    if (quick) quick += `<h3 class="list-head">Alle Lebensmittel</h3>`;
  }
  $("#food-list").innerHTML = list.length ? quick + list.map(row).join("")
    : `<p class="empty">${activeCat === "Zuletzt" && !words.length ? "Hier erscheinen deine zuletzt genutzten Lebensmittel." : activeCat === "Favoriten" ? "Tippe beim Eintragen auf ☆, um ein Lebensmittel zu deinen Favoriten zu machen." : words.length ? "Nicht in unserer Liste – schau unten bei den Markenprodukten." : "In der Liste nicht gefunden."}</p>`;

  clearTimeout(autoOnline);
  if (raw.length < 3) { $("#online").innerHTML = ""; onlineQuery = null; return; }
  if (onlineQuery === raw) return; // results for this exact text are already shown
  const label = `🔎 „${raw}“ online suchen`;
  const btn = $("#online [data-online-search]");
  if (btn && $("#online").children.length === 1) btn.textContent = label;
  else $("#online").innerHTML = `<button class="add-line" data-online-search>${esc(label)}</button>`;
  // Brand products come from the online database: look there by itself once the typing pauses
  autoOnline = setTimeout(() => searchOnline(false), 700);
}

// ---------- Local search: synonyms, singular/plural and small typos ----------

// Words people use for the same food; any of them finds the others
const SYNONYMS = [
  ["haehnchen", "huehnchen", "huhn", "chicken", "gefluegel"], ["joghurt", "jogurt", "yoghurt", "yogurt"],
  ["pute", "puten", "truthahn"], ["nudeln", "nudel", "pasta", "spaghetti"], ["kartoffel", "erdapfel"],
  ["karotte", "moehre", "mohrruebe", "rueebli"], ["quark", "topfen"], ["sahne", "rahm", "obers"],
  ["broetchen", "semmel", "schrippe", "weckle"], ["frikadelle", "bulette", "fleischpflanzerl"],
  ["pfannkuchen", "eierkuchen", "pancake", "palatschinke"], ["wuerstchen", "wiener", "frankfurter"],
  ["schokolade", "schoko", "schoki"], ["kaese", "cheese"], ["lachs", "salmon"], ["thunfisch", "tuna"],
  ["erdnussmus", "erdnussbutter", "peanutbutter"], ["haferflocken", "oats", "porridge"],
  ["protein", "eiweiss"], ["ei", "eier"], ["hackfleisch", "hack", "gehacktes"], ["rind", "beef"],
  ["schwein", "pork"], ["kaffee", "coffee", "latte"], ["paprika", "peperoni"], ["aubergine", "melanzani"],
  ["blumenkohl", "karfiol"], ["tomate", "paradeiser"], ["apfelschorle", "schorle"], ["pommes", "fritten"],
  ["mais", "corn"], ["beeren", "berries"], ["reis", "rice"], ["brot", "bread"], ["milch", "milk"],
];
const SYN = new Map();
for (const group of SYNONYMS) for (const w of group) SYN.set(w, group);

// Damerau-Levenshtein distance, stopping early once it exceeds max
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

// How well a food name fits the search words: 0 best ... 3 typo; 9 = no match. Every word must fit.
function matchRank(name, words) {
  const folded = fold(name);
  const tokens = folded.split(/[^a-z0-9]+/).filter(Boolean);
  let worst = 0;
  for (const [i, w] of words.entries()) {
    const stem = w.length > 4 ? w.replace(/(en|n|e|s)$/, "") : w;
    const alts = [w, stem, ...(SYN.get(w) || SYN.get(stem) || [])];
    let r = 9;
    if (tokens.includes(w)) r = 0;
    else if (tokens.some(t => t.startsWith(w))) r = 1;
    else if (alts.some(a => folded.includes(a))) r = 2;
    else if (w.length >= 4) {
      const max = w.length >= 8 ? 2 : 1;
      if (tokens.some(t => editDistance(w, t, max) <= max || (t.length > w.length && editDistance(w, t.slice(0, w.length), max) <= max))) r = 3;
    }
    if (r === 9) return 9;
    // The first word decides most of the order ("ei" → Ei before Eiklar)
    worst = Math.max(worst, i === 0 ? r : Math.min(r, 2));
  }
  return worst;
}

// ---------- Online search (Open Food Facts) ----------
// Two searches of the same database run side by side: the classic one finds brand + product
// ("milbona skyr") well but is often slow; the newer one answers fast. Results are merged.

let onlineResults = {};
let onlineQuery = null;   // text whose results (or loading state) are shown in #online
let onlineSeq = 0;        // increases with every online search, so only the latest one shows results
let autoOnline = null;
const onlineCache = new Map();

const OFF_FIELDS = "code,product_name,product_name_de,brands,nutriments";

// Brands come as "Milbona, Lidl" or ["xx:milbona"]
function firstBrand(brands) {
  const b = (Array.isArray(brands) ? brands[0] : brands?.split(",")[0])?.replace(/^[a-z]{2}:/, "").trim();
  return b ? b.charAt(0).toUpperCase() + b.slice(1) : "";
}

// Turn an Open Food Facts product into one of our foods, or null if it has no kcal value
function offFood(product, code) {
  const n = product?.nutriments;
  if (!n || n["energy-kcal_100g"] == null) return null;
  const name = [product.product_name_de || product.product_name, firstBrand(product.brands)]
    .filter(Boolean).join(" · ") || `Produkt ${code}`;
  return {
    id: "c-" + code, name, cat: "Eigene", barcode: code, portion: null,
    kcal: +n["energy-kcal_100g"] || 0, p: +n.proteins_100g || 0, kh: +n.carbohydrates_100g || 0, f: +n.fat_100g || 0, fib: +n.fiber_100g || 0,
  };
}

async function fetchJson(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function searchClassic(q) {
  const data = await fetchJson("https://world.openfoodfacts.org/cgi/search.pl?" + new URLSearchParams({
    search_terms: q, search_simple: 1, action: "process", json: 1, page_size: 30, sort_by: "unique_scans_n",
    tagtype_0: "countries", tag_contains_0: "contains", tag_0: "germany", fields: OFF_FIELDS,
  }), 15000);
  return (data.products || []).map(p => offFood(p, p.code));
}

// The fast search returns names and barcodes, but no nutrition values for most German products.
// It only finds a brand in its own field: for "iglo hähnchen" it also tries iglo and hähnchen as the brand.
async function searchFastCodes(q) {
  const words = q.replace(/["\\:]/g, " ").split(/\s+/).filter(Boolean);
  const brand = (w, rest) => `${rest.join(" ")} brands:"xx:${w.toLowerCase()}"`;
  const queries = [words.join(" ")];
  if (words.length > 1) queries.push(brand(words[0], words.slice(1)), brand(words.at(-1), words.slice(0, -1)));
  const results = await Promise.allSettled(queries.map(query => fetchJson("https://search.openfoodfacts.org/search?" + new URLSearchParams({
    q: `${query} countries:"en:germany"`, langs: "de", page_size: 20, fields: "code",
  }), 10000)));
  if (results.every(r => r.status === "rejected")) throw new Error("offline");
  // Brand matches first: they are what someone typing a brand is looking for
  return [...new Set([1, 2, 0].flatMap(i => results[i]?.value?.hits || []).map(h => h.code).filter(Boolean))];
}

// Nutrition values of one product, remembered for the session
const productCache = new Map();
function productFood(code) {
  if (!productCache.has(code)) {
    productCache.set(code, fetchJson(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_de,brands,nutriments`, 10000)
      .then(d => d.status === 1 ? offFood(d.product, code) : null)
      .catch(() => { productCache.delete(code); return null; }));
  }
  return productCache.get(code);
}

const wait = ms => new Promise(res => setTimeout(res, ms));

async function searchOnline(closeKeyboard = true) {
  const q = $("#search").value.trim();
  if (q.length < 2 || onlineQuery === q) return;
  clearTimeout(autoOnline);
  onlineQuery = q;
  const seq = ++onlineSeq;
  // Close the keyboard so the results are visible right away
  if (closeKeyboard) $("#search").blur();
  const box = $("#online");
  if (onlineCache.has(q)) return showOnline(onlineCache.get(q), false);
  box.innerHTML = `<p class="muted center loading-dots">🔎 Suche „${esc(q)}“ online</p>`;

  const current = () => seq === onlineSeq && $("#search").value.trim() === q;
  const parts = [null, null];
  let done = 0, failed = 0;
  const update = () => {
    if (!current()) return;
    const seen = new Set();
    const foods = [...(parts[0] || []), ...(parts[1] || [])]
      .filter(f => f && f.name && plausible(f) && !seen.has(f.id) && seen.add(f.id)).slice(0, 40);
    if (done === 2 && failed === 2) {
      onlineQuery = null;
      box.innerHTML = `<p class="empty center">Die Online-Suche ist gerade nicht erreichbar. Versuch es gleich nochmal.</p>
        <button class="add-line" data-online-search>Nochmal versuchen</button>`;
      return;
    }
    if (done === 2 && !failed) onlineCache.set(q, foods);
    if (foods.length || done === 2) showOnline(foods, done < 2);
  };
  const classic = searchClassic(q)
    .then(list => { parts[0] = list; return list; }, () => { failed++; return null; })
    .finally(() => { done++; update(); });
  // Fill up with the fast search when the classic one is slow, fails or finds little
  searchFastCodes(q)
    .then(async codes => {
      const early = await Promise.race([classic, wait(2500).then(() => undefined)]);
      if (early && early.filter(Boolean).length >= 10) return [];
      const have = new Set((parts[0] || []).filter(Boolean).map(f => f.id));
      const fresh = codes.filter(c => !have.has("c-" + c)).slice(0, 10);
      return (await Promise.all(fresh.map(productFood))).filter(Boolean);
    })
    .then(list => { parts[1] = list; }, () => { failed++; })
    .finally(() => { done++; update(); });
}

function showOnline(foods, more) {
  onlineResults = {};
  foods.forEach(f => onlineResults[f.id] = f);
  $("#online").innerHTML = foods.length
    ? `<h3 class="online-head">Markenprodukte (online)</h3><div class="list">${foods.map(f => `<button class="food" data-online="${esc(f.id)}">
        <span class="n">${esc(f.name)}</span><span class="k">${num(f.kcal)} kcal</span>
        <span class="d">pro 100 g · ${num(f.p, 1)} g Protein · ${num(f.kh, 1)} g KH · ${num(f.f, 1)} g Fett</span>
      </button>`).join("")}</div>
      ${more ? `<p class="muted small center loading-dots">Weitere werden gesucht</p>` : ""}
      <p class="muted small center">Daten: Open Food Facts. Bitte kurz mit der Packung vergleichen.</p>`
    : `<p class="empty center">Online nichts gefunden. Trag es unter „Manuell“ ein oder scanne die Packung.</p>`;
}

// Drop obviously broken database entries
function plausible(f) {
  return f.kcal <= 950 && f.p + f.kh + f.f <= 105;
}

function pickOnline(id) {
  const food = onlineResults[id];
  if (!food) return;
  state.custom = [food, ...state.custom.filter(f => f.id !== food.id)];
  save();
  showAmount(food, pick.slot);
}

// ---------- Ideas (recipes from @jamileo__) ----------

const ideaById = id => IDEAS.find(i => i.id === id);

function addUp(list) {
  const t = { kcal: 0, p: 0, kh: 0, f: 0, fib: 0 };
  for (const x of list) {
    t.kcal += x.kcal; t.p += x.p; t.kh += x.kh; t.f += x.f; t.fib += x.fib || 0;
  }
  return t;
}

function ideaTotals(idea) {
  if (idea.meals) return addUp(idea.meals.map(id => ideaTotals(ideaById(id))));
  if (idea.per) return { fib: 0, ...idea.per };
  return addUp(idea.items.map(([id, g]) => scale(FOODS.find(f => f.id === id), g)));
}

// A recipe is logged as one entry per portion
function ideaFood(idea) {
  return { id: "idee-" + idea.id, name: idea.title, cat: "Ideen", portion: idea.unit || "Portion", ...ideaTotals(idea) };
}

function renderIdeas(el, compact) {
  el.innerHTML = IDEAS.map(idea => {
    const t = ideaTotals(idea);
    const ingredients = idea.meals
      ? idea.meals.map(id => ideaById(id).title)
      : idea.ingredients || idea.items.map(([id, g]) => `${num(g)} ${unitOf(FOODS.find(f => f.id === id))} ${FOODS.find(f => f.id === id).name}`);
    return `<article class="card idea">
      <img src="${idea.photo}" alt="" loading="lazy">
      <div class="idea-body">
        <h3>${esc(idea.title)}</h3>
        <p class="idea-macros"><span class="emoji">🔥</span> ${num(t.kcal)} kcal · <span class="emoji">💪</span> ${num(t.p)} g Protein${idea.unit ? ` <small class="muted">pro ${esc(idea.unit)}</small>` : ""}</p>
        ${compact ? "" : `<p class="muted">${esc(idea.text)}</p>
        <details><summary>${idea.meals ? "Mahlzeiten" : "Zutaten"}</summary><ul>${ingredients.map(i => `<li>${esc(i)}</li>`).join("")}</ul></details>`}
        <button class="btn" data-idea="${idea.id}">${idea.meals ? "Ganzen Tag eintragen" : "Nachgekocht? Eintragen"}</button>
        ${!compact && idea.post ? `<a class="btn ghost" href="${idea.post}" target="_blank" rel="noopener">📱 Zum Post auf Instagram</a>` : ""}
      </div>
    </article>`;
  }).join("");
}

function cookIdea(id, fromSheet) {
  const idea = ideaById(id);
  if (idea.meals) {
    const d = ensureDay();
    for (const m of idea.meals.map(ideaById)) d.entries.push(makeEntry(ideaFood(m), 1, m.slot));
    save();
    closeSheet();
    showView("today");
    toast(`„${idea.title}“ eingetragen`);
    return;
  }
  const slot = fromSheet ? pick.slot : idea.slot;
  pick = { slot };
  $("#sheet").hidden = false;
  showAmount(ideaFood(idea), slot, null, { u: idea.unit || "Portion", n: idea.defaultN || 1 });
}

// amount is in grams/ml (or portions); unit is the household unit it was entered in, if any
function makeEntry(food, amount, slot, id, unit, time = SLOT_TIMES[slot]) {
  const s = scale(food, amount);
  let amountLabel;
  if (food.portion) amountLabel = `${num(amount, 2)} × ${food.portion}`;
  else if (unit && unit.size !== 1) amountLabel = `${num(unit.n, 2)} ${unitText(unit.label, unit.n)} (${num(amount)} ${unitOf(food)})`;
  else amountLabel = `${num(amount)} ${unitOf(food)}`;
  return {
    id: id || uid(), foodId: food.id, name: food.name, slot, time, amount, amountLabel,
    unit: unit ? { u: unit.label, n: unit.n } : null,
    kcal: s.kcal, p: s.p, kh: s.kh, f: s.f, fib: s.fib,
    // Per-unit values, so the entry stays editable even if the food is removed later
    base: { portion: food.portion || null, ml: !!food.ml, piece: food.piece, units: food.units, kcal: food.kcal, p: food.p, kh: food.kh, f: food.f, fib: food.fib || 0 },
  };
}

function showAmount(food, slot, entryId, init = defaultPick(food)) {
  const units = unitsOf(food);
  const unit = units.find(u => u.label === init.u) || units[0];
  pick = { food, slot, entryId, units, unit };
  renderFavButton();
  const existing = entryId && day().entries.find(x => x.id === entryId);
  $("#entry-time").value = existing?.time || (currentDay === todayKey() ? nowTime() : SLOT_TIMES[slot]);
  $("#add-tabs").hidden = true;
  $("#sheet-title").textContent = entryId ? "Bearbeiten" : "Menge";
  showTab("amount");
  $("#pick-name").textContent = food.name;
  $("#pick-base").textContent = `${baseLabel(food)}: ${num(food.kcal)} kcal · ${num(food.p, 1)} g Protein`;
  $("#amount-unit").innerHTML = units.map(u =>
    `<option value="${esc(u.label)}" ${u === unit ? "selected" : ""}>${esc(u.label)}${u.size !== 1 ? ` (${num(u.size)} ${unitOf(food)})` : ""}</option>`).join("");
  $("#amount-unit").disabled = units.length === 1;
  $("#amount").value = init.n;
  $("#slot").innerHTML = SLOTS.map(s => `<option value="${s.id}" ${s.id === slot ? "selected" : ""}>${s.name}</option>`).join("");
  $("#amount-submit").textContent = entryId ? "Speichern" : "Hinzufügen";
  $("#entry-delete").hidden = !entryId;
  renderQuick();
  updatePreview();
}

function renderQuick() {
  const { unit, food } = pick;
  let quick;
  if (unit.size !== 1 || food.portion) quick = food.portion ? [0.5, 1, 1.5, 2] : [0.5, 1, 2, 3];
  else quick = food.ml ? [100, 200, 250, 330, 500] : [50, 100, 150, 200, 250];
  $("#amount").step = unit.size !== 1 || food.portion ? "0.5" : "1";
  $("#quick-amounts").innerHTML = quick.map(q =>
    `<button type="button" class="chip" data-amount="${q}">${num(q, 1)} ${esc(unitText(unit.label, q))}</button>`).join("");
}

// Switching unit keeps the same real amount, e.g. 120 g egg becomes 2 Stück
function changeUnit() {
  const next = pick.units.find(u => u.label === $("#amount-unit").value);
  // Convert from the exact amount, so switching back and forth never drifts
  pick.exact = pick.exact ?? baseAmount();
  const n = pick.exact / next.size;
  $("#amount").value = next.size === 1 ? Math.round(n) : Math.round(n * 100) / 100;
  pick.unit = next;
  renderQuick();
  updatePreview();
}

function baseAmount() {
  return (parseFloat($("#amount").value) || 0) * pick.unit.size;
}

function updatePreview() {
  const s = scale(pick.food, baseAmount());
  $("#pick-preview").innerHTML = [["kcal", s.kcal, ""], ["Protein", s.p, " g"], ["KH", s.kh, " g"], ["Fett", s.f, " g"]]
    .map(([l, v, u]) => `<div><b>${num(v, l === "kcal" ? 0 : 1)}${u}</b><small>${l}</small></div>`).join("");
}

function submitAmount(e) {
  e.preventDefault();
  const n = parseFloat($("#amount").value);
  if (!(n > 0)) return toast("Bitte eine Menge eingeben");
  const slot = $("#slot").value;
  const d = ensureDay();
  const entry = makeEntry(pick.food, n * pick.unit.size, slot, pick.entryId, { label: pick.unit.label, size: pick.unit.size, n },
    $("#entry-time").value || SLOT_TIMES[slot]);
  if (pick.entryId) d.entries = d.entries.map(x => x.id === pick.entryId ? entry : x);
  else d.entries.push(entry);
  state.recent = [pick.food.id, ...state.recent.filter(id => id !== pick.food.id)].slice(0, 20);
  // Remember the amount per food as the default for next time
  state.amounts[pick.food.id] = { u: pick.unit.label, n };
  save();
  const edited = !!pick.entryId;
  closeSheet();
  render();
  toast(edited ? "Gespeichert" : `${entry.name} eingetragen`);
}

function editEntry(id) {
  const e = day().entries.find(x => x.id === id);
  if (!e) return;
  const food = foodById(e.foodId) || { id: e.foodId, name: e.name, ...e.base };
  $("#sheet").hidden = false;
  showAmount(food, e.slot, id, e.unit || { u: food.portion || unitOf(food), n: e.amount });
}

function deleteEntry() {
  const d = ensureDay();
  d.entries = d.entries.filter(x => x.id !== pick.entryId);
  save();
  closeSheet();
  render();
  toast("Eintrag gelöscht");
}

// ---------- Manual entry ----------

let manualBasis = "100";

function submitManual(e) {
  e.preventDefault();
  const f = e.target.elements;
  const food = {
    id: "c-" + uid(), name: f.name.value.trim(), cat: "Eigene",
    portion: manualBasis === "portion" ? "Portion" : null,
    kcal: +f.kcal.value || 0, p: +f.p.value || 0, kh: +f.kh.value || 0, f: +f.f.value || 0, fib: +f.fib.value || 0,
    barcode: f.barcode.value || undefined,
  };
  if (!food.name) return;
  if (f.save.checked) { state.custom.unshift(food); save(); }
  e.target.reset();
  showAmount(food, pick.slot);
}

// ---------- Barcode scanning (native BarcodeDetector, ZXing as fallback) ----------

const SCAN_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
let scan = null; // running camera session: { stream, controls, timer }
let zxingLoad = null;

function loadZXing() {
  if (window.ZXingBrowser) return Promise.resolve();
  zxingLoad = zxingLoad || new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "vendor/zxing-browser.min.js";
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });
  return zxingLoad;
}

// The phone's own barcode reader (Chrome on Android) is much faster than ZXing
async function nativeDetector() {
  if (!("BarcodeDetector" in window)) return null;
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    const formats = SCAN_FORMATS.filter(f => supported.includes(f));
    return formats.length ? new BarcodeDetector({ formats }) : null;
  } catch (e) {
    return null;
  }
}

// iPhones ask for camera permission again every time a home-screen web app turns the camera on.
// So the camera is only paused after a scan and kept for a while: scanning several products in a row
// needs a single "Allow". It is switched off for real after a few minutes, or when the app goes to the background.
const CAMERA_KEEP_MS = 3 * 60 * 1000;
let camStream = null;
let camRelease = null;

function cameraLive() {
  return camStream && camStream.getVideoTracks().some(t => t.readyState === "live");
}

async function getCamera() {
  clearTimeout(camRelease);
  if (cameraLive()) {
    camStream.getTracks().forEach(t => t.enabled = true);
    return camStream;
  }
  camStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  return camStream;
}

function parkCamera() {
  if (!camStream) return;
  camStream.getTracks().forEach(t => t.enabled = false);
  clearTimeout(camRelease);
  camRelease = setTimeout(releaseCamera, CAMERA_KEEP_MS);
}

function releaseCamera() {
  clearTimeout(camRelease);
  camStream?.getTracks().forEach(t => t.stop());
  camStream = null;
}

document.addEventListener("visibilitychange", () => {
  const scanOpen = !$("#sheet").hidden && !$('#sheet .tab[data-tab="scan"]').hidden;
  if (!document.hidden) { if (scanOpen) startScan(); return; }
  stopScan();
  releaseCamera();
});

async function startScan() {
  if (scan) return;
  const status = $("#scan-status");
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = "Dein Browser erlaubt keinen Kamerazugriff. Tipp den Barcode einfach ein.";
    return;
  }
  const session = scan = {};
  $("#scan-start").hidden = true;
  status.textContent = "Kamera wird gestartet …";
  try {
    const stream = await getCamera();
    if (scan !== session) return parkCamera(); // closed meanwhile
    session.stream = stream;
    // Continuous autofocus where supported, so a close-up barcode gets sharp quickly
    const track = stream.getVideoTracks()[0];
    if (track.getCapabilities?.().focusMode?.includes("continuous")) {
      track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
    }
    const video = $("#scan-video");
    video.srcObject = stream;
    await video.play();
    status.textContent = "Halte den Barcode in den Rahmen.";

    const detector = await nativeDetector();
    if (detector) {
      const tick = async () => {
        if (scan !== session) return;
        try {
          const [hit] = await detector.detect(video);
          if (hit && scan === session) return foundBarcode(hit.rawValue);
        } catch (e) { /* frame not ready yet */ }
        session.timer = setTimeout(tick, 80);
      };
      tick();
    } else {
      await loadZXing();
      if (scan !== session) return;
      const F = ZXingBrowser.BarcodeFormat;
      // Only product barcodes (EAN/UPC): far less work per frame than trying every format
      const hints = new Map([[2 /* DecodeHintType.POSSIBLE_FORMATS */, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E]]]);
      const reader = new ZXingBrowser.BrowserMultiFormatOneDReader(hints, { delayBetweenScanAttempts: 60 });
      session.controls = await reader.decodeFromVideoElement(video, result => {
        if (result && scan === session) foundBarcode(result.getText());
      });
    }
  } catch (err) {
    if (scan !== session) return;
    stopScan();
    releaseCamera();
    status.textContent = "Kamera nicht verfügbar. Erlaube den Zugriff in den Einstellungen oder tipp den Barcode ein.";
  }
}

function foundBarcode(code) {
  stopScan();
  navigator.vibrate?.(60);
  lookupBarcode(code);
}

function stopScan() {
  if (scan) {
    clearTimeout(scan.timer);
    try { scan.controls?.stop(); } catch (e) { /* already stopped */ }
    if (scan.stream) parkCamera();
    scan = null;
    $("#scan-video").srcObject = null;
  }
  $("#scan-start").hidden = false;
}

async function lookupBarcode(code) {
  code = String(code).replace(/\D/g, "");
  if (code.length < 6) return toast("Ungültiger Barcode");
  const known = state.custom.find(f => f.barcode === code);
  if (known) return showAmount(known, pick.slot);
  $("#scan-status").textContent = "Suche Produkt …";
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_de,brands,nutriments`);
    const data = await r.json();
    const food = data.status === 1 ? offFood(data.product, code) : null;
    if (!food) throw new Error("not found");
    state.custom = [food, ...state.custom.filter(f => f.barcode !== code)];
    save();
    showAmount(food, pick.slot);
  } catch (e) {
    toast("Produkt nicht gefunden, bitte Werte von der Packung eintragen");
    showTab("manual");
    $("#manual-form").elements.barcode.value = code;
    $("#scan-status").textContent = "Halte den Barcode der Packung vor die Kamera.";
  }
}

// ---------- Onboarding ----------

function openOnboarding() {
  const f = $("#onboard-form");
  if (state.profile) for (const [k, v] of Object.entries(state.profile)) if (f.elements[k]) f.elements[k].value = v;
  f.elements.goalWeight.value = state.settings?.goalWeight ?? "";
  togglePace();
  $("#onboard-preview").hidden = true;
  f.querySelector(".btn").textContent = "Ziel berechnen";
  delete f.dataset.ready;
  $("#onboard").hidden = false;
}

function submitOnboarding(e) {
  e.preventDefault();
  const f = e.target;
  const el = f.elements;
  const profile = {
    sex: el.sex.value, age: +el.age.value, height: +el.height.value,
    weight: +el.weight.value, activity: +el.activity.value, goal: el.goal.value, pace: +el.pace.value,
  };
  const goalWeight = parseFloat(el.goalWeight.value) > 0 ? parseFloat(el.goalWeight.value) : null;
  // First press shows the result, second press confirms it
  if (!f.dataset.ready) {
    const g = calcGoals(profile);
    $("#onboard-preview").innerHTML = [["kcal", g.kcal, ""], ["Protein", g.p, " g"], ["KH", g.kh, " g"], ["Fett", g.f, " g"]]
      .map(([l, v, u]) => `<div><b>${num(v)}${u}</b><small>${l}</small></div>`).join("");
    $("#onboard-preview").hidden = false;
    $("#onboard-explain").innerHTML = explainGoal(profile, goalWeight);
    $("#onboard-explain").hidden = false;
    f.querySelector(".btn").textContent = "Passt, los geht's!";
    f.dataset.ready = "1";
    return;
  }
  state.profile = profile;
  state.goals = calcGoals(profile);
  state.settings = { ...state.settings, goalWeight };
  if (!state.weights[todayKey()]) state.weights[todayKey()] = profile.weight;
  save();
  $("#onboard").hidden = true;
  showView("today");
  toast("Deine Ziele sind gespeichert. Du kannst sie im Profil ändern.");
}

// How the goal was calculated, in plain words
function explainGoal(profile, goalWeight) {
  const b = calcBreakdown(profile);
  const lines = [
    `<li><b>Grundumsatz ${num(b.bmr)} kcal</b>: Energie in völliger Ruhe, nach der Mifflin-St-Jeor-Formel aus Geschlecht, Alter, Größe und Gewicht.</li>`,
    `<li><b>× ${num(profile.activity, 3)} Aktivität = ${num(b.tdee)} kcal</b> Gesamtumsatz pro Tag.</li>`,
  ];
  if (profile.goal !== "keep") lines.push(`<li><b>${b.delta < 0 ? "−" : "+"} ${num(Math.abs(b.delta))} kcal</b> für ca. ${num(profile.pace, 2)} kg pro Woche (1 kg Körperfett ≈ 7.700 kcal).</li>`);
  lines.push(`<li><b>= ${num(b.kcal)} kcal</b> Tagesziel (auf 50 gerundet).</li>`);
  let extra = "";
  if (b.floored) extra += `<p class="hint">Rechnerisch wären es weniger als ${num(b.floor)} kcal. Darunter wird es schwer, satt und gut versorgt zu bleiben, deshalb setzt die App ${num(b.floor)} kcal an. Dein Tempo ist damit etwas langsamer: ca. ${num(Math.abs(b.realDelta) * 7 / KCAL_PER_KG, 2)} kg pro Woche.</p>`;
  if (goalWeight && profile.goal !== "keep" && Math.sign(goalWeight - profile.weight) === (profile.goal === "lose" ? -1 : 1)) {
    const perWeek = Math.abs(b.realDelta) * 7 / KCAL_PER_KG;
    if (perWeek > 0) {
      const weeks = Math.abs(goalWeight - profile.weight) / perWeek;
      const date = new Date(Date.now() + weeks * 7 * 86400000);
      extra += `<p class="hint">Bis ${num(goalWeight, 1)} kg: ca. ${num(Math.ceil(weeks))} Wochen, also etwa <b>${date.toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</b>.</p>`;
    }
  }
  return `<h4>So kommt dein Ziel zustande</h4><ul class="explain">${lines.join("")}</ul>${extra}
    <p class="muted small">Alles Schätzungen: Der echte Verbrauch kann um 10–15 % abweichen. Beobachte 2–3 Wochen deinen Gewichtstrend (7-Tage-Ø) und pass das Ziel dann an. Protein: 1,6 g pro kg Körpergewicht, Fett: 30 % der Kalorien, Rest Kohlenhydrate.</p>`;
}

function togglePace() {
  const f = $("#onboard-form").elements;
  $("#pace-row").hidden = f.goal.value === "keep";
}

// ---------- Events ----------

document.addEventListener("click", e => {
  const b = e.target.closest("button, [data-cat]");
  if (!b) return;
  if (b.dataset.view) showView(b.dataset.view);
  else if (b.dataset.day) { currentDay = shiftKey(currentDay, +b.dataset.day); renderToday(); }
  else if (b.dataset.glass !== undefined) {
    const d = ensureDay();
    const target = (+b.dataset.glass + 1) * GLASS_ML;
    d.water = d.water === target ? target - GLASS_ML : target;
    save();
    renderToday();
  }
  else if (b.dataset.addSlot) openSheet(b.dataset.addSlot);
  else if (b.dataset.meal) showMeal(b.dataset.meal);
  else if (b.dataset.entry) editEntry(b.dataset.entry);
  else if (b.dataset.tab && b.closest("#add-tabs")) showTab(b.dataset.tab, true);
  else if (b.dataset.cat) { activeCat = b.dataset.cat; $("#search").value = ""; renderFoodList(); }
  else if (b.hasAttribute("data-refeed-skip")) {
    state.refeedSkip = state.refeedSkip || {};
    if (state.refeedSkip[currentDay]) delete state.refeedSkip[currentDay]; else state.refeedSkip[currentDay] = true;
    save();
    renderToday();
  }
  else if (b.dataset.copySlot) copyEntries(prevSlot(b.dataset.copySlot));
  else if (b.id === "copy-day") copyEntries(day(shiftKey(currentDay, -1)).entries);
  else if (b.id === "fav-toggle") toggleFav();
  else if (b.dataset.food) { const f = foodById(b.dataset.food); showAmount(f, pick.slot); }
  else if (b.dataset.online) pickOnline(b.dataset.online);
  else if (b.hasAttribute("data-online-search")) { onlineQuery = null; searchOnline(); }
  else if (b.dataset.idea) cookIdea(b.dataset.idea, !!b.closest("#sheet"));
  else if (b.dataset.amount) { $("#amount").value = b.dataset.amount; pick.exact = null; updatePreview(); }
  else if (b.dataset.basis) { manualBasis = b.dataset.basis; $$("#manual-basis button").forEach(x => x.classList.toggle("active", x === b)); }
});

$("#fab").addEventListener("click", () => openSheet());
$("#sheet-close").addEventListener("click", closeSheet);
$("#sheet").addEventListener("click", e => { if (e.target.id === "sheet") closeSheet(); });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!$("#sheet").hidden) closeSheet();
  else if (openMeal) closeMeal();
});
$("#meal-close").addEventListener("click", closeMeal);
$("#meal-sheet").addEventListener("click", e => { if (e.target.id === "meal-sheet") closeMeal(); });
$("#meal-add").addEventListener("click", () => openSheet(openMeal));
// On iPhones, tapping "Suchen" first commits the keyboard's word suggestion, which fires an extra
// "input" event with the same text. Only a real change of the text may reset the online search.
let searchSubmitted = 0; // when the keyboard's search key was last pressed
$("#search").addEventListener("input", () => {
  const changed = $("#search").value.trim() !== onlineQuery;
  if (changed) onlineQuery = null;
  renderFoodList();
  // The suggestion changed the word right as "Suchen" was pressed: search the corrected word
  if (changed && Date.now() - searchSubmitted < 1500) searchOnline();
});
// Keep the keyboard open until the tap on "online suchen" has landed; closing it first moves the button
$("#online").addEventListener("mousedown", e => { if (e.target.closest("[data-online-search]")) e.preventDefault(); });
// The keyboard's search key (🔍 / "Suchen") submits the form; this works reliably on phones
$("#search-form").addEventListener("submit", e => { e.preventDefault(); searchSubmitted = Date.now(); searchOnline(); });
$("#amount").addEventListener("input", () => { pick.exact = null; updatePreview(); });
$("#amount-unit").addEventListener("change", changeUnit);
$("#amount-form").addEventListener("submit", submitAmount);
$("#entry-delete").addEventListener("click", deleteEntry);
$("#manual-form").addEventListener("submit", submitManual);
$("#scan-start").addEventListener("click", startScan);
$("#barcode-form").addEventListener("submit", e => { e.preventDefault(); lookupBarcode($("#barcode-input").value); });
$("#onboard-form").addEventListener("submit", submitOnboarding);
$("#onboard-form").addEventListener("input", () => { delete $("#onboard-form").dataset.ready; $("#onboard-form .btn").textContent = "Ziel berechnen"; $("#onboard-explain").hidden = true; });
$("#onboard-skip").addEventListener("click", () => {
  state.goals = state.goals || { kcal: 1600, p: 100, kh: 170, f: 55, fib: 30, water: 2000 };
  save();
  $("#onboard").hidden = true;
  showView("profile");
  toast("Trag deine Ziele hier ein");
});
$("#recalc").addEventListener("click", openOnboarding);
$("#onboard-form").elements.goal.addEventListener("change", togglePace);

$("#settings-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target.elements;
  const gw = parseFloat(f.goalWeight.value);
  state.settings = { ...state.settings, cycle: f.cycle.checked, goalWeight: gw > 0 ? gw : null };
  save();
  toast("Gespeichert");
});

$("#goals-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target.elements;
  state.goals = { kcal: +f.kcal.value, p: +f.p.value, kh: +f.kh.value, f: +f.f.value, fib: +f.fib.value, water: +f.water.value };
  save();
  toast("Ziele gespeichert");
});

$("#reset").addEventListener("click", () => {
  if (!confirm("Wirklich alle Einträge, Ziele und eigenen Lebensmittel löschen?")) return;
  state = blankState();
  save();
  openOnboarding();
});

// Install prompt (Android / desktop Chrome); iOS uses the share sheet
let installEvent = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installEvent = e;
  $("#install-btn").hidden = false;
});
$("#install-btn").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $("#install-btn").hidden = true;
});
if (matchMedia("(display-mode: standalone)").matches) $("#install-card").hidden = true;

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------- Keeping data safe ----------

// Ask the browser not to clear our storage under pressure (granted automatically for installed apps)
navigator.storage?.persist?.().catch(() => {});

// In-app browsers (Instagram, TikTok …) and plain browser tabs on iPhone can lose local data.
// Point people to the home screen version, where it stays put.
function storageHint() {
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) return null;
  const ua = navigator.userAgent;
  if (/Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|BytedanceWebview|Snapchat|Line\//i.test(ua)) return {
    title: "Du bist im App-Browser",
    text: "Hier können deine Einträge verloren gehen. Tippe oben rechts auf „…“ → „Im Browser öffnen“ und füge die App dann zum Home-Bildschirm hinzu.",
  };
  if (/iPhone|iPad|iPod/.test(ua)) return {
    title: "Tipp: Auf den Home-Bildschirm",
    text: "Damit deine Einträge sicher gespeichert bleiben, öffne diese Seite in Safari, tippe auf „Teilen“ und dann auf „Zum Home-Bildschirm“. Starte die App danach immer über das neue Symbol.",
  };
  return null;
}

function showStorageHint() {
  const hint = storageHint();
  let dismissed = false;
  try { dismissed = localStorage.getItem(STORE_KEY + "-hint") === "1"; } catch (e) { /* ignore */ }
  if (!hint || dismissed) return;
  $("#storage-hint-title").textContent = hint.title;
  $("#storage-hint-text").textContent = hint.text;
  $("#storage-hint").hidden = false;
}
$("#storage-hint-close").addEventListener("click", () => {
  $("#storage-hint").hidden = true;
  try { localStorage.setItem(STORE_KEY + "-hint", "1"); } catch (e) { /* ignore */ }
});
showStorageHint();

// ---------- Theme ----------

function applyTheme() {
  const t = state.settings?.theme || "light"; // light is the house style unless chosen otherwise
  $$("#theme-pick button").forEach(b => b.classList.toggle("active", b.dataset.themePick === t));
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#17100F" : "#F6EEE9";
}
applyTheme();
// Takes effect right away, no extra save button
$("#theme-pick").addEventListener("click", e => {
  const b = e.target.closest("[data-theme-pick]");
  if (!b) return;
  state.settings = { ...state.settings, theme: b.dataset.themePick };
  save();
  applyTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

// ---------- Swipe between days ----------

let swipe = null;
$("#view-today").addEventListener("touchstart", e => {
  // Not while using the rating buttons or other horizontal controls
  if (e.touches.length !== 1 || e.target.closest(".chips, input, select, textarea")) { swipe = null; return; }
  swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
$("#view-today").addEventListener("touchend", e => {
  if (!swipe) return;
  const dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  currentDay = shiftKey(currentDay, dx < 0 ? 1 : -1);
  renderToday();
  const card = $(".daynav");
  card.classList.remove("slide-l", "slide-r");
  void card.offsetWidth;
  card.classList.add(dx < 0 ? "slide-l" : "slide-r");
}, { passive: true });

// ---------- Water reminder as calendar file ----------

function reminderIcs(from, to, every) {
  const [fh, fm] = from.split(":").map(Number), [th, tm] = to.split(":").map(Number);
  const start = new Date(); start.setDate(start.getDate() + 1);
  const pad = n => String(n).padStart(2, "0");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const events = [];
  for (let m = fh * 60 + fm; m <= th * 60 + tm; m += every) {
    const dt = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}T${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
    events.push(["BEGIN:VEVENT", `UID:kc-water-${m}-${stamp}@jamileo`, `DTSTAMP:${stamp}`, `DTSTART:${dt}`, "DURATION:PT5M",
      "RRULE:FREQ=DAILY", "SUMMARY:💧 Glas Wasser trinken", "DESCRIPTION:Erinnerung aus dem jamileo Kalorien-Check",
      "TRANSP:TRANSPARENT", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:💧 Glas Wasser trinken", "TRIGGER:PT0M", "END:VALARM", "END:VEVENT"].join("\r\n"));
  }
  return { text: ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//jamileo//Kalorien-Check//DE", "CALSCALE:GREGORIAN", ...events, "END:VCALENDAR"].join("\r\n"), count: events.length };
}

$("#reminder-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target.elements;
  if (f.to.value <= f.from.value) return toast("„Bis“ muss nach „Von“ liegen");
  const { text, count } = reminderIcs(f.from.value, f.to.value, +f.every.value);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/calendar" }));
  a.download = "trink-erinnerung.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`${count} tägliche Erinnerungen: Tippe auf „Alle hinzufügen“`);
});

// ---------- Refeed settings ----------

const ICS_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Next date (from today) that falls on the weekday
function nextWeekday(wd) {
  let k = todayKey();
  while (keyToDate(k).getDay() !== wd) k = shiftKey(k, 1);
  return k;
}

function fillRefeedForm() {
  const f = $("#refeed-form").elements, r = refeedSettings();
  f.on.checked = !!r?.on;
  if (r) { f.weekday.value = r.weekday; f.every.value = r.every; }
  f.extra.value = r?.extra ?? "";
  f.extra.placeholder = refeedSuggestion();
  const next = r?.on ? [...Array(15).keys()].map(i => shiftKey(todayKey(), i)).find(isRefeed) : null;
  $("#refeed-hint").textContent = `Vorschlag: +${num(refeedSuggestion())} kcal${state.profile ? ", also etwa dein Erhaltungsbedarf" : ""}.`
    + (next ? ` Nächster Refeed Day: ${keyToDate(next).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}.` : "");
}

function readRefeedForm() {
  const f = $("#refeed-form").elements;
  const weekday = +f.weekday.value, every = +f.every.value;
  const old = refeedSettings();
  // Keep the 2-week rhythm stable unless the weekday changes
  const anchor = old?.anchor && old.weekday === weekday ? old.anchor : nextWeekday(weekday);
  const extra = parseInt(f.extra.value, 10);
  return { on: f.on.checked, weekday, every, extra: extra > 0 ? extra : null, anchor };
}

$("#refeed-form").addEventListener("submit", e => {
  e.preventDefault();
  state.settings = { ...state.settings, refeed: readRefeedForm() };
  save();
  fillRefeedForm();
  toast(state.settings.refeed.on ? "Refeed Day eingeplant 🍝" : "Refeed Day ausgeschaltet");
});

$("#refeed-ics").addEventListener("click", () => {
  const r = readRefeedForm();
  const start = r.anchor.replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const extra = r.extra || refeedSuggestion();
  const text = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//jamileo//Kalorien-Check//DE", "BEGIN:VEVENT",
    `UID:kc-refeed-${stamp}@jamileo`, `DTSTAMP:${stamp}`, `DTSTART:${start}T080000`, "DURATION:PT15M",
    `RRULE:FREQ=WEEKLY;INTERVAL=${r.every};BYDAY=${ICS_DAYS[r.weekday]}`,
    "SUMMARY:🍝 Refeed Day", `DESCRIPTION:Heute ca. ${extra} kcal mehr\, vor allem aus Kohlenhydraten. (jamileo Kalorien-Check)`,
    "TRANSP:TRANSPARENT", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:🍝 Heute ist Refeed Day", "TRIGGER:PT0M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/calendar" }));
  a.download = "refeed-day.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Tippe auf „Hinzufügen“, um die Erinnerung zu speichern");
});
