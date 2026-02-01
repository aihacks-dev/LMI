/* Local Market Intelligence App (LMIA)
   - Local-first PWA
   - All data stored in localStorage
   - Import/export JSON for backup
   - Arbitrage scoring + heatmap
*/

const APP_VERSION = "LMIA v0.1";
const STORAGE_KEY = "lmia_state_v1";

const DEFAULT_STATE = () => ({
  settings: {
    spotSilver: 85.00,
    spotGold: 5000.00,
    gasCostPerMile: 0.30,
    hourlyValue: 80,
    defaultQty: 10,
    // quick thresholds (tweak later)
    strongProfitPerHour: 250,
    mediumProfitPerHour: 120
  },
  // Categories: define metal + a display name
  categories: [
    { id: uid(), metal: "silver", name: "40% halves (roll $10 face)" },
    { id: uid(), metal: "silver", name: "90% junk ($1 face)" },
    { id: uid(), metal: "silver", name: "ASE (1 oz)" },
    { id: uid(), metal: "silver", name: "Generic 1 oz round" },
    { id: uid(), metal: "silver", name: "10 oz bar" },
    { id: uid(), metal: "gold", name: "1 oz Gold Eagle" },
    { id: uid(), metal: "gold", name: "1/10 oz Gold Eagle" },
    { id: uid(), metal: "gold", name: "Pre-33 $10 (approx)" }
  ],
  // Unit defs: how many troy oz per "unit" for that category (or effective oz)
  unitDefs: [
    // These are placeholders — you’ll edit to match your definitions.
    // 40% roll: 20 coins; actual ASW varies by date; use your practical average.
    { categoryName: "40% halves (roll $10 face)", ozPerUnit: 2.95 },
    { categoryName: "90% junk ($1 face)", ozPerUnit: 0.715 },
    { categoryName: "ASE (1 oz)", ozPerUnit: 1.0 },
    { categoryName: "Generic 1 oz round", ozPerUnit: 1.0 },
    { categoryName: "10 oz bar", ozPerUnit: 10.0 },
    { categoryName: "1 oz Gold Eagle", ozPerUnit: 1.0 },
    { categoryName: "1/10 oz Gold Eagle", ozPerUnit: 0.1 },
    { categoryName: "Pre-33 $10 (approx)", ozPerUnit: 0.48375 }
  ],
  markets: [
    { id: uid(), name: "Tri-Cities TN/VA", radiusMiles: 75, driveTimeHours: 1.0, active: true }
  ],
  locations: [],
  quotes: []
});

let state = loadState();

// ---------- DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function nowISO() {
  return new Date().toISOString();
}

function fmtMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function fmtNum(n, digits = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(digits);
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(1, x));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE();
    const parsed = JSON.parse(raw);
    // basic sanity
    if (!parsed.settings || !parsed.categories) return DEFAULT_STATE();
    return parsed;
  } catch {
    return DEFAULT_STATE();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderAll();
}

// ---------- PWA Service Worker ----------
window.addEventListener("load", () => {
  $("#buildInfo").textContent = `${APP_VERSION} • Local-first • ${new Date().toLocaleString()}`;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  updateNetBadge();
  window.addEventListener("online", updateNetBadge);
  window.addEventListener("offline", updateNetBadge);
});

function updateNetBadge() {
  const online = navigator.onLine;
  const el = $("#netBadge");
  el.textContent = online ? "Online" : "Offline";
  el.className = "badge";
}

// ---------- Tabs ----------
function initTabs() {
  $$(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $$(".panel").forEach(p => p.classList.remove("show"));
      $("#tab-" + tab).classList.add("show");
      if (tab === "arbitrage") presetArbInputs();
    });
  });
}

// ---------- Categories / Unit defs ----------
function categoryOptions(metal) {
  return state.categories.filter(c => c.metal === metal);
}

function getUnitOzForCategoryName(categoryName) {
  const def = state.unitDefs.find(u => u.categoryName === categoryName);
  if (!def) return null;
  const oz = Number(def.ozPerUnit);
  return Number.isFinite(oz) && oz > 0 ? oz : null;
}

function spotForMetal(metal) {
  return metal === "gold" ? Number(state.settings.spotGold) : Number(state.settings.spotSilver);
}

// Melt per unit = ozPerUnit * spot
function meltPerUnit(metal, categoryName) {
  const oz = getUnitOzForCategoryName(categoryName);
  if (!oz) return null;
  const spot = spotForMetal(metal);
  if (!Number.isFinite(spot)) return null;
  return oz * spot;
}

// Quote cost per unit for buyer perspective:
// If buyPct exists -> buyPct*melt + flatPremium
// Else if sellPct exists -> sellPct*melt + flatPremium (used as fallback)
// flatPremium can be +/-
// Returns null if insufficient info
function quotePricePerUnit(q) {
  const m = meltPerUnit(q.metal, q.category);
  if (!Number.isFinite(m)) return null;
  const flat = Number(q.flatPremium ?? 0);
  const buyPct = (q.buyPctMelt === "" || q.buyPctMelt == null) ? null : Number(q.buyPctMelt);
  const sellPct = (q.sellPctMelt === "" || q.sellPctMelt == null) ? null : Number(q.sellPctMelt);

  const pct = Number.isFinite(buyPct) ? buyPct : (Number.isFinite(sellPct) ? sellPct : null);
  if (pct == null) return null;
  return pct * m + flat;
}

// ---------- Markets ----------
function addMarketFromForm() {
  const name = $("#mName").value.trim();
  const radiusMiles = Number($("#mRadius").value);
  const driveTimeHours = Number($("#mDrive").value);
  const active = $("#mActive").value === "true";

  if (!name) return alert("Market name required.");
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) return alert("Radius must be > 0.");
  if (!Number.isFinite(driveTimeHours) || driveTimeHours <= 0) return alert("Drive time must be > 0.");

  state.markets.push({ id: uid(), name, radiusMiles, driveTimeHours, active });
  clearMarketForm();
  saveState();
}

function clearMarketForm() {
  $("#mName").value = "";
  $("#mRadius").value = 75;
  $("#mDrive").value = 1.0;
  $("#mActive").value = "true";
}

function deleteMarket(id) {
  const usedByLoc = state.locations.some(l => l.marketId === id);
  if (usedByLoc) return alert("Cannot delete: this market has locations. Delete/move locations first.");
  state.markets = state.markets.filter(m => m.id !== id);
  saveState();
}

function toggleMarketActive(id) {
  const m = state.markets.find(x => x.id === id);
  if (!m) return;
  m.active = !m.active;
  saveState();
}

// ---------- Locations ----------
function addLocationFromForm() {
  const marketId = $("#lMarket").value;
  const name = $("#lName").value.trim();
  const type = $("#lType").value;
  const city = $("#lCity").value.trim();
  const distanceMi = Number($("#lDistance").value);
  const trustScore = Number($("#lTrust").value);
  const notes = $("#lNotes").value.trim();

  if (!marketId) return alert("Pick a market.");
  if (!name) return alert("Location name required.");
  if (!Number.isFinite(distanceMi) || distanceMi < 0) return alert("Distance must be >= 0.");
  if (!Number.isFinite(trustScore) || trustScore < 1 || trustScore > 5) return alert("Trust must be 1–5.");

  state.locations.push({
    id: uid(), marketId, name, type, city,
    distanceMi, trustScore, notes
  });

  clearLocationForm();
  saveState();
}

function clearLocationForm() {
  $("#lName").value = "";
  $("#lType").value = "LCS";
  $("#lCity").value = "";
  $("#lDistance").value = 10;
  $("#lTrust").value = 4;
  $("#lNotes").value = "";
}

function deleteLocation(id) {
  const hasQuotes = state.quotes.some(q => q.locationId === id);
  if (hasQuotes) return alert("Cannot delete: this location has quotes. Delete quotes first.");
  state.locations = state.locations.filter(l => l.id !== id);
  saveState();
}

// ---------- Quotes ----------
function upsertQuoteFromForm() {
  const locationId = $("#qLocation").value;
  const metal = $("#qMetal").value;
  const category = $("#qCategory").value;

  const buyPctMelt = $("#qBuyPct").value.trim();
  const sellPctMelt = $("#qSellPct").value.trim();
  const flatPremium = $("#qFlat").value.trim();
  const notes = $("#qNotes").value.trim();

  if (!locationId) return alert("Pick a location.");
  if (!category) return alert("Pick a category.");

  // Validate pct values if provided
  const buy = buyPctMelt === "" ? null : clamp01(buyPctMelt);
  const sell = sellPctMelt === "" ? null : clamp01(sellPctMelt);
  if (buyPctMelt !== "" && buy == null) return alert("Buy % must be between 0 and 1 (e.g. 0.50).");
  if (sellPctMelt !== "" && sell == null) return alert("Sell % must be between 0 and 1 (e.g. 0.95).");

  const flat = flatPremium === "" ? 0 : Number(flatPremium);
  if (!Number.isFinite(flat)) return alert("Flat premium must be a number (e.g. -0.50 or 2.00).");

  // One quote per (location, metal, category)
  const existing = state.quotes.find(q => q.locationId === locationId && q.metal === metal && q.category === category);
  if (existing) {
    existing.buyPctMelt = buyPctMelt === "" ? "" : buy;
    existing.sellPctMelt = sellPctMelt === "" ? "" : sell;
    existing.flatPremium = flat;
    existing.notes = notes;
    existing.lastUpdated = nowISO();
  } else {
    state.quotes.push({
      id: uid(),
      locationId,
      metal,
      category,
      buyPctMelt: buyPctMelt === "" ? "" : buy,
      sellPctMelt: sellPctMelt === "" ? "" : sell,
      flatPremium: flat,
      notes,
      lastUpdated: nowISO()
    });
  }

  clearQuoteForm();
  saveState();
}

function clearQuoteForm() {
  $("#qBuyPct").value = "";
  $("#qSellPct").value = "";
  $("#qFlat").value = "";
  $("#qNotes").value = "";
}

function deleteQuote(id) {
  state.quotes = state.quotes.filter(q => q.id !== id);
  saveState();
}

// ---------- Arbitrage ----------
function presetArbInputs() {
  $("#arbQty").value = state.settings.defaultQty ?? 10;
  fillCategorySelect("#arbCategory", $("#arbMetal").value);
  fillMarketSelect("#arbMarket", true);
}

function runArbitrage() {
  const metal = $("#arbMetal").value;
  const category = $("#arbCategory").value;
  const qty = Number($("#arbQty").value);
  const marketId = $("#arbMarket").value;

  if (!category) return alert("Pick a category.");
  if (!Number.isFinite(qty) || qty <= 0) return alert("Qty must be > 0.");

  const locations = filterLocationsByMarket(marketId);
  const quotes = state.quotes.filter(q => q.metal === metal && q.category === category)
    .filter(q => locations.some(l => l.id === q.locationId));

  const unitMelt = meltPerUnit(metal, category);
  if (!Number.isFinite(unitMelt)) {
    return alert("Missing melt/unit definition for this category. Go to Settings and set oz/unit.");
  }

  // Candidates
  const buyCandidates = quotes
    .filter(q => q.buyPctMelt !== "" && q.buyPctMelt != null)
    .map(q => ({ q, pricePerUnit: quotePricePerUnit(q) }))
    .filter(x => Number.isFinite(x.pricePerUnit));

  const sellCandidates = quotes
    .filter(q => q.sellPctMelt !== "" && q.sellPctMelt != null)
    .map(q => ({ q, pricePerUnit: quotePricePerUnit({ ...q, buyPctMelt: q.sellPctMelt }) })) // treat sellPct as the price you'd pay to buy from them if needed
    .filter(x => Number.isFinite(x.pricePerUnit));

  // For selling proceeds, we want: proceedsPerUnit = sellPct*melt + flatPremium (flatPremium can be negative/positive)
  const proceedsCandidates = quotes
    .filter(q => q.sellPctMelt !== "" && q.sellPctMelt != null)
    .map(q => {
      const m = meltPerUnit(q.metal, q.category);
      const flat = Number(q.flatPremium ?? 0);
      const pct = Number(q.sellPctMelt);
      const proceeds = (Number.isFinite(m) && Number.isFinite(pct)) ? (pct * m + flat) : null;
      return { q, proceedsPerUnit: proceeds };
    })
    .filter(x => Number.isFinite(x.proceedsPerUnit));

  if (buyCandidates.length === 0) return alert("No BUY quotes found for this category (buy %).");
  if (proceedsCandidates.length === 0) return alert("No SELL quotes found for this category (sell %).");

  // Evaluate best pair (buy from A, sell to B)
  const results = [];
  for (const b of buyCandidates) {
    const buyLoc = getLocation(b.q.locationId);
    if (!buyLoc) continue;

    for (const s of proceedsCandidates) {
      const sellLoc = getLocation(s.q.locationId);
      if (!sellLoc) continue;

      // you can buy & sell at same place; keep it but it will likely be weak
      const grossProfitPerUnit = s.proceedsPerUnit - b.pricePerUnit;
      const grossProfit = grossProfitPerUnit * qty;

      // trip model: you might do both in one loop; approximate total miles as:
      // (buy distance + sell distance) * 2 (round trip each) is too harsh; instead:
      // take max(distance) * 2 as a “single loop” baseline.
      const miles = Math.max(Number(buyLoc.distanceMi), Number(sellLoc.distanceMi)) * 2;
      const gasCost = miles * Number(state.settings.gasCostPerMile || 0);

      // time model: use market driveTimeHours as baseline; if marketId is specific use that
      const mkt = getMarket(buyLoc.marketId);
      const hours = Number(mkt?.driveTimeHours ?? 1);
      const timeCost = hours * Number(state.settings.hourlyValue || 0);

      const netProfit = grossProfit - gasCost - timeCost;
      const profitPerHour = hours > 0 ? netProfit / hours : null;

      results.push({
        buyLoc, sellLoc,
        buyPricePerUnit: b.pricePerUnit,
        sellProceedsPerUnit: s.proceedsPerUnit,
        qty,
        unitMelt,
        grossProfit,
        gasCost,
        timeCost,
        netProfit,
        profitPerHour
      });
    }
  }

  results.sort((a, b) => (b.netProfit - a.netProfit));

  renderArbResults(results, metal, category);
}

function arbRating(profitPerHour) {
  const strong = Number(state.settings.strongProfitPerHour);
  const medium = Number(state.settings.mediumProfitPerHour);
  if (!Number.isFinite(profitPerHour)) return { cls: "bad", label: "No score" };
  if (profitPerHour >= strong) return { cls: "good", label: "Strong" };
  if (profitPerHour >= medium) return { cls: "mid", label: "Medium" };
  return { cls: "bad", label: "Noise" };
}

// ---------- Heatmap ----------
function scoreLocationCategory(locationId, metal, category) {
  const q = state.quotes.find(x => x.locationId === locationId && x.metal === metal && x.category === category);
  if (!q) return null;

  // simple heuristic:
  // - For buying opportunity: lower buyPct is better for YOU buying (e.g., 0.80 is better than 0.95 if you are sourcing)
  // - For selling opportunity: higher sellPct is better when YOU sell to them
  // We'll score both and show a blended view:
  const buyPct = q.buyPctMelt === "" ? null : Number(q.buyPctMelt);
  const sellPct = q.sellPctMelt === "" ? null : Number(q.sellPctMelt);

  // Normalize scores roughly: buyScore = (1 - buyPct) and sellScore = sellPct
  // Combined: emphasize whichever exists
  let combined = null;
  if (Number.isFinite(buyPct) && Number.isFinite(sellPct)) combined = ( (1 - buyPct) + sellPct ) / 2;
  else if (Number.isFinite(buyPct)) combined = (1 - buyPct);
  else if (Number.isFinite(sellPct)) combined = sellPct;
  else combined = null;

  if (!Number.isFinite(combined)) return null;

  // Convert to dot rating bands (tune later)
  if (combined >= 0.65) return { cls: "good", label: "Hot" };
  if (combined >= 0.50) return { cls: "mid", label: "Okay" };
  return { cls: "bad", label: "Cold" };
}

// ---------- Filters ----------
function getMarket(id) { return state.markets.find(m => m.id === id); }
function getLocation(id) { return state.locations.find(l => l.id === id); }

function filterLocationsByMarket(marketId) {
  const activeOnly = (marketId === "__active__");
  if (!marketId) return state.locations;
  if (activeOnly) {
    const activeMarketIds = state.markets.filter(m => m.active).map(m => m.id);
    return state.locations.filter(l => activeMarketIds.includes(l.marketId));
  }
  return state.locations.filter(l => l.marketId === marketId);
}

// ---------- Render ----------
function renderAll() {
  renderSettingsQuick();
  renderSnapshot();
  renderMarkets();
  renderLocationSelects();
  renderLocations();
  renderCategorySelect("#qCategory", $("#qMetal").value);
  renderQuotes();
  renderCategories();
  renderUnitDefs();
  renderHeatmap(); // keep last selections
}

// Dashboard settings
function renderSettingsQuick() {
  $("#spotSilver").value = state.settings.spotSilver ?? "";
  $("#spotGold").value = state.settings.spotGold ?? "";
  $("#gasCost").value = state.settings.gasCostPerMile ?? "";
  $("#hourValue").value = state.settings.hourlyValue ?? "";
  $("#defaultQty").value = state.settings.defaultQty ?? "";
}

function renderSnapshot() {
  const s = state.settings;
  const activeMarkets = state.markets.filter(m => m.active).length;
  const locCount = state.locations.length;
  const quoteCount = state.quotes.length;

  const html = `
    <div class="item">
      <div class="item-top">
        <div>
          <div class="item-title">Spot Inputs</div>
          <div class="item-sub">Silver ${fmtMoney(s.spotSilver)} • Gold ${fmtMoney(s.spotGold)}</div>
        </div>
        <div class="item-actions">
          <span class="pill">${activeMarkets} active markets</span>
          <span class="pill">${locCount} locations</span>
          <span class="pill">${quoteCount} quotes</span>
        </div>
      </div>
      <div class="item-sub" style="margin-top:8px;">
        Gas ${fmtMoney(s.gasCostPerMile)}/mile • Time ${fmtMoney(s.hourlyValue)}/hr • Default qty ${escapeHtml(s.defaultQty)}
      </div>
    </div>
  `;
  $("#snapshot").innerHTML = html;
}

// Markets
function renderMarkets() {
  const wrap = $("#marketsList");
  if (state.markets.length === 0) {
    wrap.innerHTML = `<div class="item"><div class="item-title">No markets yet</div></div>`;
    return;
  }

  wrap.innerHTML = state.markets.map(m => `
    <div class="item">
      <div class="item-top">
        <div>
          <div class="item-title">${escapeHtml(m.name)}</div>
          <div class="item-sub">Radius: ${escapeHtml(m.radiusMiles)} mi • Typical drive: ${escapeHtml(m.driveTimeHours)} hr • ${m.active ? "Active" : "Inactive"}</div>
        </div>
        <div class="item-actions">
          <button class="smallbtn" data-action="toggleMarket" data-id="${m.id}">${m.active ? "Disable" : "Enable"}</button>
          <button class="smallbtn danger" data-action="deleteMarket" data-id="${m.id}">Delete</button>
        </div>
      </div>
    </div>
  `).join("");

  // Update market dropdowns
  fillMarketSelect("#lMarket", false);
  fillMarketSelect("#locMarketFilter", false, true);
  fillMarketSelect("#quoteMarketFilter", false, true);
  fillMarketSelect("#arbMarket", true);
  fillMarketSelect("#hmMarket", true);
}

// Locations
function renderLocations() {
  const search = ($("#locSearch").value ?? "").trim().toLowerCase();
  const mFilter = $("#locMarketFilter").value;

  let locs = state.locations.slice();
  if (mFilter) locs = locs.filter(l => l.marketId === mFilter);
  if (search) {
    locs = locs.filter(l =>
      (l.name || "").toLowerCase().includes(search) ||
      (l.city || "").toLowerCase().includes(search) ||
      (l.type || "").toLowerCase().includes(search) ||
      (l.notes || "").toLowerCase().includes(search)
    );
  }

  const wrap = $("#locationsList");
  if (locs.length === 0) {
    wrap.innerHTML = `<div class="item"><div class="item-title">No locations match.</div></div>`;
    return;
  }

  wrap.innerHTML = locs.map(l => {
    const m = getMarket(l.marketId);
    const trust = "⭐".repeat(Math.max(1, Math.min(5, Number(l.trustScore || 1))));
    return `
      <div class="item">
        <div class="item-top">
          <div>
            <div class="item-title">${escapeHtml(l.name)}</div>
            <div class="item-sub">${escapeHtml(l.type)} • ${escapeHtml(l.city || "")} • ${escapeHtml(m?.name || "Unknown market")}</div>
          </div>
          <div class="item-actions">
            <span class="pill">Dist ${escapeHtml(l.distanceMi)} mi</span>
            <span class="pill">${trust}</span>
            <button class="smallbtn danger" data-action="deleteLocation" data-id="${l.id}">Delete</button>
          </div>
        </div>
        ${l.notes ? `<div class="item-sub" style="margin-top:8px;">${escapeHtml(l.notes)}</div>` : ""}
      </div>
    `;
  }).join("");
}

// Quotes
function renderQuotes() {
  const mktFilter = $("#quoteMarketFilter").value;
  const search = ($("#quoteSearch").value ?? "").trim().toLowerCase();

  let qs = state.quotes.slice();
  if (mktFilter) {
    const locIds = state.locations.filter(l => l.marketId === mktFilter).map(l => l.id);
    qs = qs.filter(q => locIds.includes(q.locationId));
  }
  if (search) {
    qs = qs.filter(q => {
      const loc = getLocation(q.locationId);
      const blob = `${q.metal} ${q.category} ${loc?.name || ""} ${loc?.city || ""} ${q.notes || ""}`.toLowerCase();
      return blob.includes(search);
    });
  }

  // Sort by most recent update
  qs.sort((a, b) => (String(b.lastUpdated).localeCompare(String(a.lastUpdated))));

  const wrap = $("#quotesList");
  if (qs.length === 0) {
    wrap.innerHTML = `<div class="item"><div class="item-title">No quotes yet.</div><div class="item-sub">Add your first quote on the left.</div></div>`;
    return;
  }

  wrap.innerHTML = qs.map(q => {
    const loc = getLocation(q.locationId);
    const m = meltPerUnit(q.metal, q.category);
    const price = quotePricePerUnit(q);
    return `
      <div class="item">
        <div class="item-top">
          <div>
            <div class="item-title">${escapeHtml(loc?.name || "Unknown")} • ${escapeHtml(q.category)}</div>
            <div class="item-sub">${escapeHtml(q.metal.toUpperCase())} • ${escapeHtml(loc?.city || "")} • Updated ${escapeHtml(new Date(q.lastUpdated).toLocaleString())}</div>
          </div>
          <div class="item-actions">
            ${q.buyPctMelt !== "" ? `<span class="pill">Buy: ${(Number(q.buyPctMelt)*100).toFixed(1)}%</span>` : ""}
            ${q.sellPctMelt !== "" ? `<span class="pill">Sell: ${(Number(q.sellPctMelt)*100).toFixed(1)}%</span>` : ""}
            <span class="pill">Flat: ${fmtMoney(q.flatPremium)}</span>
            <button class="smallbtn danger" data-action="deleteQuote" data-id="${q.id}">Delete</button>
          </div>
        </div>
        <div class="item-sub" style="margin-top:8px;">
          Melt/unit: ${fmtMoney(m)} • Approx price/unit: ${fmtMoney(price)}
        </div>
        ${q.notes ? `<div class="item-sub" style="margin-top:6px;">${escapeHtml(q.notes)}</div>` : ""}
      </div>
    `;
  }).join("");
}

function renderArbResults(results, metal, category) {
  const wrap = $("#arbResults");
  if (!results || results.length === 0) {
    wrap.innerHTML = `<div class="item"><div class="item-title">No pairs found.</div></div>`;
    return;
  }

  const top = results.slice(0, 12);
  wrap.innerHTML = top.map(r => {
    const rating = arbRating(r.profitPerHour);
    return `
      <div class="item">
        <div class="item-top">
          <div>
            <div class="item-title">
              Buy: ${escapeHtml(r.buyLoc.name)} → Sell: ${escapeHtml(r.sellLoc.name)}
            </div>
            <div class="item-sub">
              ${escapeHtml(metal.toUpperCase())} • ${escapeHtml(category)} • Qty ${escapeHtml(r.qty)}
            </div>
          </div>
          <div class="item-actions">
            <span class="pill ${rating.cls}">${rating.label}</span>
            <span class="pill">Net/hr ${fmtMoney(r.profitPerHour)}</span>
            <span class="pill">Net ${fmtMoney(r.netProfit)}</span>
          </div>
        </div>

        <div class="item-sub" style="margin-top:8px;">
          Buy/unit ${fmtMoney(r.buyPricePerUnit)} • Sell/unit ${fmtMoney(r.sellProceedsPerUnit)} • Melt/unit ${fmtMoney(r.unitMelt)}
        </div>
        <div class="item-sub" style="margin-top:6px;">
          Gross ${fmtMoney(r.grossProfit)} • Gas ${fmtMoney(r.gasCost)} • Time ${fmtMoney(r.timeCost)}
        </div>
        <div class="item-sub" style="margin-top:6px;">
          Dist (one-way buy ${escapeHtml(r.buyLoc.distanceMi)} mi, sell ${escapeHtml(r.sellLoc.distanceMi)} mi) • Trust (buy ${escapeHtml(r.buyLoc.trustScore)}/5, sell ${escapeHtml(r.sellLoc.trustScore)}/5)
        </div>
      </div>
    `;
  }).join("");
}

// Heatmap
function renderHeatmap() {
  const marketId = $("#hmMarket")?.value || "__active__";
  const metal = $("#hmMetal")?.value || "silver";

  const locs = filterLocationsByMarket(marketId);
  const cats = state.categories.filter(c => c.metal === metal).map(c => c.name);

  const wrap = $("#heatmapWrap");
  if (locs.length === 0) {
    wrap.innerHTML = `<div class="item"><div class="item-title">No locations for this market filter.</div></div>`;
    return;
  }
  if (cats.length === 0) {
    wrap.innerHTML = `<div class="item"><div class="item-title">No categories for ${escapeHtml(metal)}.</div></div>`;
    return;
  }

  const header = `
    <table class="hm-table">
      <thead>
        <tr>
          <th style="min-width:220px;">Location</th>
          ${cats.map(c => `<th>${escapeHtml(c)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
  `;

  const rows = locs.map(l => {
    const tds = cats.map(catName => {
      const s = scoreLocationCategory(l.id, metal, catName);
      if (!s) return `<td><span class="hm-cell"><span class="dot bad"></span><span class="pill bad">—</span></span></td>`;
      return `<td><span class="hm-cell"><span class="dot ${s.cls}"></span><span class="pill ${s.cls}">${escapeHtml(s.label)}</span></span></td>`;
    }).join("");
    return `
      <tr>
        <td>
          <div style="font-weight:800;">${escapeHtml(l.name)}</div>
          <div class="item-sub">${escapeHtml(l.type)} • ${escapeHtml(l.city || "")} • ${escapeHtml(l.distanceMi)} mi</div>
        </td>
        ${tds}
      </tr>
    `;
  }).join("");

  const footer = `</tbody></table>`;
  wrap.innerHTML = header + rows + footer;
}

// Settings screen
function renderCategories() {
  const wrap = $("#categoriesList");
  wrap.innerHTML = state.categories
    .slice()
    .sort((a,b) => (a.metal + a.name).localeCompare(b.metal + b.name))
    .map(c => `
      <div class="item">
        <div class="item-top">
          <div>
            <div class="item-title">${escapeHtml(c.name)}</div>
            <div class="item-sub">${escapeHtml(c.metal.toUpperCase())}</div>
          </div>
          <div class="item-actions">
            <button class="smallbtn danger" data-action="deleteCategory" data-id="${c.id}">Delete</button>
          </div>
        </div>
      </div>
    `).join("");
}

function renderUnitDefs() {
  const wrap = $("#unitDefsList");
  const allCats = state.categories.slice().sort((a,b)=> (a.metal+a.name).localeCompare(b.metal+b.name));

  // ensure unitDefs exist for each category name
  for (const c of allCats) {
    if (!state.unitDefs.some(u => u.categoryName === c.name)) {
      state.unitDefs.push({ categoryName: c.name, ozPerUnit: (c.metal === "gold" ? 1.0 : 1.0) });
    }
  }

  wrap.innerHTML = allCats.map(c => {
    const def = state.unitDefs.find(u => u.categoryName === c.name);
    return `
      <div class="item">
        <div class="item-top">
          <div>
            <div class="item-title">${escapeHtml(c.name)}</div>
            <div class="item-sub">${escapeHtml(c.metal.toUpperCase())} • Melt/unit now: ${fmtMoney(meltPerUnit(c.metal, c.name))}</div>
          </div>
          <div class="item-actions">
            <span class="pill">oz/unit</span>
            <input class="input" style="min-width:120px; max-width:160px;" data-action="unitDef" data-name="${escapeHtml(c.name)}" value="${escapeHtml(def?.ozPerUnit ?? "")}" />
          </div>
        </div>
      </div>
    `;
  }).join("");

  // attach input handlers
  $$("#unitDefsList input[data-action='unitDef']").forEach(inp => {
    inp.addEventListener("change", () => {
      const name = inp.dataset.name;
      const v = Number(inp.value);
      if (!Number.isFinite(v) || v <= 0) return alert("oz/unit must be > 0.");
      const def = state.unitDefs.find(u => u.categoryName === name);
      if (def) def.ozPerUnit = v;
      saveState();
    });
  });
}

// ---------- Select Fillers ----------
function fillMarketSelect(sel, includeActiveOption, includeAllOption = false) {
  const el = $(sel);
  if (!el) return;
  const ms = state.markets.slice().sort((a,b)=>a.name.localeCompare(b.name));
  const opts = [];

  if (includeActiveOption) opts.push(`<option value="__active__">Active markets</option>`);
  if (includeAllOption) opts.push(`<option value="">All markets</option>`);

  for (const m of ms) {
    opts.push(`<option value="${m.id}">${escapeHtml(m.name)}${m.active ? "" : " (inactive)"}</option>`);
  }
  el.innerHTML = opts.join("");

  // Keep prior selection if still valid
  const current = el.value;
  if (current && !opts.join("").includes(`value="${current}"`)) {
    el.value = includeActiveOption ? "__active__" : (ms[0]?.id || "");
  }
}

function fillLocationSelect(sel) {
  const el = $(sel);
  if (!el) return;
  const locs = state.locations.slice().sort((a,b)=>a.name.localeCompare(b.name));
  el.innerHTML = locs.map(l => `<option value="${l.id}">${escapeHtml(l.name)} (${escapeHtml(l.city || "")})</option>`).join("");
}

function fillCategorySelect(sel, metal) {
  const el = $(sel);
  if (!el) return;
  const cats = categoryOptions(metal);
  el.innerHTML = cats.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("");
}

function renderLocationSelects() {
  fillMarketSelect("#lMarket", false);
  fillMarketSelect("#quoteMarketFilter", false, true);
  fillMarketSelect("#locMarketFilter", false, true);
  fillMarketSelect("#arbMarket", true);
  fillMarketSelect("#hmMarket", true);

  fillLocationSelect("#qLocation");

  fillCategorySelect("#qCategory", $("#qMetal").value);
  fillCategorySelect("#arbCategory", $("#arbMetal").value);
}

function renderCategorySelect(sel, metal) {
  fillCategorySelect(sel, metal);
}

// ---------- Events ----------
function initEvents() {
  // Dashboard quick save
  $("#btnSaveSettingsQuick").addEventListener("click", () => {
    const sS = Number($("#spotSilver").value);
    const sG = Number($("#spotGold").value);
    const gas = Number($("#gasCost").value);
    const hv = Number($("#hourValue").value);
    const dq = Number($("#defaultQty").value);

    if (!Number.isFinite(sS) || sS <= 0) return alert("Silver spot must be > 0.");
    if (!Number.isFinite(sG) || sG <= 0) return alert("Gold spot must be > 0.");
    if (!Number.isFinite(gas) || gas < 0) return alert("Gas cost must be >= 0.");
    if (!Number.isFinite(hv) || hv < 0) return alert("Hourly value must be >= 0.");
    if (!Number.isFinite(dq) || dq <= 0) return alert("Default qty must be > 0.");

    state.settings.spotSilver = sS;
    state.settings.spotGold = sG;
    state.settings.gasCostPerMile = gas;
    state.settings.hourlyValue = hv;
    state.settings.defaultQty = dq;
    saveState();
  });

  $("#btnGoArb").addEventListener("click", () => {
    // switch tab
    const arbTabBtn = $$(".tab").find(b => b.dataset.tab === "arbitrage");
    arbTabBtn?.click();
  });

  // Markets
  $("#btnAddMarket").addEventListener("click", addMarketFromForm);
  $("#btnClearMarketForm").addEventListener("click", clearMarketForm);

  // Locations
  $("#btnAddLocation").addEventListener("click", addLocationFromForm);
  $("#btnClearLocationForm").addEventListener("click", clearLocationForm);
  $("#locSearch").addEventListener("input", renderLocations);
  $("#locMarketFilter").addEventListener("change", renderLocations);

  // Quotes
  $("#qMetal").addEventListener("change", () => {
    fillCategorySelect("#qCategory", $("#qMetal").value);
  });
  $("#btnAddQuote").addEventListener("click", upsertQuoteFromForm);
  $("#btnClearQuoteForm").addEventListener("click", clearQuoteForm);
  $("#quoteSearch").addEventListener("input", renderQuotes);
  $("#quoteMarketFilter").addEventListener("change", renderQuotes);

  // Arbitrage controls
  $("#arbMetal").addEventListener("change", () => fillCategorySelect("#arbCategory", $("#arbMetal").value));
  $("#btnRunArb").addEventListener("click", runArbitrage);

  // Heatmap controls
  $("#btnHeatmap").addEventListener("click", renderHeatmap);
  $("#hmMarket").addEventListener("change", renderHeatmap);
  $("#hmMetal").addEventListener("change", renderHeatmap);

  // Settings: add category
  $("#btnAddCategory").addEventListener("click", () => {
    const name = $("#catName").value.trim();
    const metal = $("#catMetal").value;
    if (!name) return alert("Category name required.");
    if (state.categories.some(c => c.name.toLowerCase() === name.toLowerCase() && c.metal === metal)) {
      return alert("That category already exists for this metal.");
    }
    state.categories.push({ id: uid(), metal, name });
    $("#catName").value = "";
    saveState();
  });

  // Global delegated actions
  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === "deleteMarket") deleteMarket(id);
    if (action === "toggleMarket") toggleMarketActive(id);
    if (action === "deleteLocation") deleteLocation(id);
    if (action === "deleteQuote") deleteQuote(id);
    if (action === "deleteCategory") deleteCategory(id);
  });

  // Export / Import / Reset
  $("#btnExport").addEventListener("click", exportBackup);
  $("#fileImport").addEventListener("change", importBackup);
  $("#btnReset").addEventListener("click", () => {
    const ok = confirm("Reset ALL local data for this app? This cannot be undone.");
    if (!ok) return;
    state = DEFAULT_STATE();
    saveState();
  });
}

function deleteCategory(id) {
  const cat = state.categories.find(c => c.id === id);
  if (!cat) return;

  // Guard: deleting category would orphan quotes
  const used = state.quotes.some(q => q.category === cat.name && q.metal === cat.metal);
  if (used) return alert("Cannot delete: this category is used by quotes. Delete those quotes first.");

  state.categories = state.categories.filter(c => c.id !== id);
  state.unitDefs = state.unitDefs.filter(u => u.categoryName !== cat.name);
  saveState();
}

// ---------- Backup ----------
function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0,10);
  a.download = `lmia-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(String(reader.result || ""));
      if (!imported.settings || !imported.categories) throw new Error("Invalid backup.");
      state = imported;
      saveState();
      alert("Import complete.");
    } catch (err) {
      alert("Import failed: " + (err?.message || "unknown error"));
    } finally {
      $("#fileImport").value = "";
    }
  };
  reader.readAsText(file);
}

// ---------- Init ----------
function initDefaultsIfEmpty() {
  // Fill a few defaults to reduce friction
  if (!state.markets || state.markets.length === 0) state.markets = DEFAULT_STATE().markets;

  // Ensure unit defs for each category
  for (const c of state.categories) {
    if (!state.unitDefs.some(u => u.categoryName === c.name)) {
      state.unitDefs.push({ categoryName: c.name, ozPerUnit: 1.0 });
    }
  }
}

function boot() {
  initDefaultsIfEmpty();
  initTabs();
  initEvents();
  renderAll();
}
boot();
