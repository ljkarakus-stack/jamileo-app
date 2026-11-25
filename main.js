"use strict";

// Loaded last, once every feature script has registered itself

// Entries logged before fibre was tracked get it from the food list, where the food is known
function backfillFibre() {
  let changed = false;
  for (const d of Object.values(state.days)) for (const e of d.entries) {
    if (e.fib != null) continue;
    const food = foodById(e.foodId);
    if (!food || food.fib == null) continue;
    e.fib = scale(food, e.amount).fib;
    if (e.base) e.base.fib = food.fib;
    changed = true;
  }
  if (changed) save();
}
backfillFibre();

// The large BLS food list loads once the app is up, so search, favorites and recent foods have it
setTimeout(loadBLS, 1500);

// Moving from the old address: the old page hands the saved data over as a code
// (#umzug=<gzip, base64url>), either inside the link or copied to the clipboard.
// On iPhones every home screen app has its own storage, so there the code is pasted by hand.
async function importMove(packed) {
  try {
    const bin = Uint8Array.from(atob(packed.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const text = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    const moved = JSON.parse(text);
    if (!moved[STORE_KEY]) return false;
    const hasData = !!state.goals || Object.keys(state.days).length > 0;
    if (hasData && !confirm("Deine Daten von der alten App übernehmen? Die Einträge auf diesem Gerät werden dabei ersetzt.")) return true;
    for (const [k, v] of Object.entries(moved)) localStorage.setItem(k, v);
    return true;
  } catch (e) {
    return false;
  }
}

async function pasteMove() {
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch (e) { /* not allowed: ask below */ }
  if (!/umzug=/.test(text)) text = prompt("Füge hier die kopierten Daten aus der alten App ein:") || "";
  const m = text.match(/umzug=([A-Za-z0-9_-]+)/);
  if (m && await importMove(m[1])) return location.replace(APP_URL);
  toast("Keine Daten gefunden. Tippe zuerst in der alten App auf „Daten kopieren“.");
}
document.addEventListener("click", e => { if (e.target.closest("[data-move-paste]")) pasteMove(); });

if (location.hash.startsWith("#umzug=")) importMove(location.hash.slice(7)).then(() => location.replace(APP_URL));
else {
  if (!state.goals) openOnboarding();
  else showView("today");

  // Recipe or challenge link opened directly
  if (location.hash && handleIncoming(location.hash)) history.replaceState(null, "", APP_URL);
}
