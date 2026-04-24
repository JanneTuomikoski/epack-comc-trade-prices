// ==UserScript==
// @name         ePack Trade COMC price check
// @namespace    epack-comc-trade-prices
// @version      1.9.7
// @description  Fetch COMC prices via a comc.com worker tab. Keep one comc.com tab open — no proxy needed.
// @match        https://www.upperdeckepack.com/*
// @match        https://www.comc.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      upperdeckepack.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // COMC WORKER  (runs when this script is on a comc.com tab)
  // All instances of this script share the same GM storage, so
  // the worker and the ePack tab communicate transparently.
  // ============================================================
  if (location.hostname.includes('comc.com')) {
    const LOG = '[COMC-Worker]';
    let lastId = null;
    console.info(LOG, 'active — polling for ePack price requests');
    setInterval(async () => {
      const raw = await GM_getValue('comc_req', null);
      if (!raw) return;
      let req;
      try { req = JSON.parse(raw); } catch { return; }
      const { id, url } = req;
      if (!id || id === lastId) return;
      lastId = id;
      if (url === 'ping') {
        await GM_setValue('comc_res_' + id, JSON.stringify({ ok: true, pong: true }));
        return;
      }
      if (!url?.includes('comc.com')) return;
      console.info(LOG, 'fetching', url);
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        });
        if (resp.ok) {
          const html = await resp.text();
          console.info(LOG, 'done', id, html.length, 'bytes');
          await GM_setValue('comc_res_' + id, JSON.stringify({ ok: true, html }));
        } else {
          console.warn(LOG, 'HTTP', resp.status);
          await GM_setValue('comc_res_' + id, JSON.stringify({ ok: false, status: resp.status }));
        }
      } catch (e) {
        console.error(LOG, e.message);
        await GM_setValue('comc_res_' + id, JSON.stringify({ ok: false, error: e.message }));
      }
    }, 500);
    return; // don't run ePack UI on comc.com
  }

  // ============================================================
  // ePACK UI  (runs on upperdeckepack.com)
  // ============================================================

  // ---------- Config ----------
  const REQ_DELAY_MS     = 1500;
  const REQ_DELAY_RANDOM = 800;
  const DELAY_MS         = 250;
  const TOOLBAR_CHECK_MS = 2000;
  const CACHE_TTL_MS     = 3 * 60 * 60 * 1000;
  const CACHE_VERSION    = 'v13';
  const FADE_DIGITAL     = true;
  const FADE_OPACITY     = 0.3;
  const LOG              = '[ePack→COMC]';
  const COMC_FEE         = 0.5;
  const PREF_INCLUDE_FEE = 'epack-comc-include-fee';
  const TOOLBAR_ID       = 'epack-comc-toolbar';
  const ANCHOR_ID        = `${TOOLBAR_ID}-anchor`;
  const TOTALS_ID        = `${TOOLBAR_ID}-totals`;
  const WORKER_TIMEOUT   = 30000;  // ms to wait for worker response

  const SELECTORS = {
    TOOLBAR:           `#${TOOLBAR_ID}`,
    CARD:              '.trade-card .product-card-display',
    PARTNER_CONTAINER: '.collection-owner-container .user-info',
    PARTNER_USERNAME:  '.collection-owner-container .user-info a.username',
    TRADE_HEADER:      '.page-section.container-fluid.action-bar.collection-header.trade-detail-header.desktop-only',
    TRADE_SIDES:       '.trade-detail.row .trade-side.col-sm-6',
    SIDE_BTN_ITEMS:    '.side-btn-items',
    PRICE_CHIP:        '.epack-price-chip',
    PHYSICAL_INDICATOR:'.epack-physical-indicator',
    PARTNER_INFO:      '.epack-partner-info',
    TRADE_EDIT_BUTTONS:'.trade-edit-buttons',
    PRICE_BTN:         '.epack-price-btn',
    LIST_ROW:          '.list-view-row',
  };

  const TIME = {
    MINUTE: 60 * 1000,
    HOUR:   60 * 60 * 1000,
    DAY:    24 * 60 * 60 * 1000,
    WEEK:   7  * 24 * 60 * 60 * 1000,
    MONTH:  30 * 24 * 60 * 60 * 1000,
    YEAR:   365 * 24 * 60 * 60 * 1000,
  };

  // ---------- State ----------
  const state = {
    cachedTradeData:        null,
    toolbarMounted:         false,
    partnerInfoInjected:    false,
    isCheckingToolbar:      false,
    isCheckingPartnerInfo:  false,
    isFetching:             false,
    shouldAbort:            false,
    pollingInterval:        null,
    mutationObserver:       null,
  };

  // Worker liveness — checked once on toolbar mount, re-checked on Refresh
  const worker = { checked: false, alive: false };

  // ---------- Utilities ----------
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const now   = () => Date.now();

  function formatRelativeTime(dateString) {
    if (!dateString || dateString === '0001-01-01T00:00:00') return 'Unknown';
    let s = dateString;
    if (!s.endsWith('Z') && !s.includes('+') && !s.includes('T00:00:00.000')) s += 'Z';
    const diff = new Date() - new Date(s);
    if (diff < TIME.MINUTE) return 'Just now';
    const m = Math.floor(diff / TIME.MINUTE);   if (m  < 60) return `${m} minute${m!==1?'s':''} ago`;
    const h = Math.floor(diff / TIME.HOUR);     if (h  < 24) return `${h} hour${h!==1?'s':''} ago`;
    const d = Math.floor(diff / TIME.DAY);      if (d  <  7) return `${d} day${d!==1?'s':''} ago`;
    const w = Math.floor(diff / TIME.WEEK);     if (w  <  4) return `${w} week${w!==1?'s':''} ago`;
    const mo = Math.floor(diff / TIME.MONTH);   if (mo < 12) return `${mo} month${mo!==1?'s':''} ago`;
    const y = Math.floor(diff / TIME.YEAR);     return `${y} year${y!==1?'s':''} ago`;
  }

  function formatRatingStars(r) {
    if (!r) return '';
    return '★'.repeat(r) + '☆'.repeat(5 - r);
  }

  // ---------- Worker health check ----------
  async function checkWorker() {
    // Send a ping through the same comc_req channel the worker polls.
    const id = `ping_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await GM_setValue('comc_req', JSON.stringify({ id, url: 'ping' }));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await delay(300);
      const raw = await GM_getValue('comc_res_' + id, null);
      if (raw != null) {
        await GM_deleteValue('comc_res_' + id);
        return true;
      }
    }
    return false;
  }

  async function ensureWorkerChecked() {
    if (worker.checked) return;
    worker.alive   = await checkWorker();
    worker.checked = true;
    console.info(LOG, 'Worker', worker.alive ? 'online ✓' : 'OFFLINE ✗');
  }

  // ---------- ePack API ----------
  function getTradePartnerUsername() {
    const a = document.querySelector(SELECTORS.PARTNER_USERNAME);
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('/Profile/')) return href.replace('/Profile/', '');
    return clean((a.textContent || '').replace(/^account\s*-\s*/i, '')) || null;
  }

  function extractTradeIdFromUrl() {
    const parts = window.location.pathname.split('/');
    const i = parts.indexOf('Details');
    return (i !== -1 && parts.length > i + 1) ? parts[i + 1] : null;
  }

  function isInEditMode() {
    const eb = document.querySelector(SELECTORS.TRADE_EDIT_BUTTONS);
    if (eb) return !(eb.querySelector('#accept-trade') || eb.querySelector('#counter-trade'));
    return !!document.querySelector(SELECTORS.TRADE_HEADER) ||
           document.querySelectorAll(SELECTORS.CARD).length > 0;
  }

  function fetchTradeApi(tradeId) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://www.upperdeckepack.com/api/Trading/ViewTrade?id=${tradeId}&forceLoad=false`,
        onload: r => {
          if (r.status >= 200 && r.status < 300) {
            try   { resolve({ ok: true,  data: JSON.parse(r.responseText) }); }
            catch { resolve({ ok: false, error: 'JSON parse failed' }); }
          } else { resolve({ ok: false, status: r.status }); }
        },
        onerror: e => resolve({ ok: false, error: e?.error || 'network error' }),
      });
    });
  }

  async function getTradeData() {
    if (state.cachedTradeData) return state.cachedTradeData;
    const id = extractTradeIdFromUrl();
    if (!id) return null;
    const r = await fetchTradeApi(id);
    if (!r.ok) { console.error(LOG, 'Trade API failed:', r); return null; }
    state.cachedTradeData = r.data;
    return r.data;
  }

  function addCardToMap(map, wrap, side) {
    const id = wrap.CardTemplate?.CardTemplateID;
    if (!id) return;
    map.set(id, {
      templateId: id, side,
      playerName:     wrap.CardTemplate?.PlayerName,
      insertName:     wrap.CardTemplate?.InsertName,
      cardNumber:     wrap.CardTemplate?.CardNumber,
      isPhysical:     wrap.CardTemplate?.IsPhysical    ?? false,
      isTransferable: wrap.CardTemplate?.IsTransferable ?? false,
    });
  }

  async function buildCardLookupMap(tradeData) {
    if (!tradeData) return new Map();
    const map = new Map();
    let partner = getTradePartnerUsername();
    if (!partner) { await delay(500);  partner = getTradePartnerUsername(); }
    if (!partner) { await delay(1000); partner = getTradePartnerUsername(); }

    const pIsInit = partner && tradeData.Initiator?.UserName?.toLowerCase()    === partner.toLowerCase();
    const pIsCp   = partner && tradeData.Counterparty?.UserName?.toLowerCase() === partner.toLowerCase();

    (tradeData.InitiatorCards    || []).forEach(c => addCardToMap(map, c, pIsCp   ? 'give' : 'get'));
    (tradeData.CounterpartyCards || []).forEach(c => addCardToMap(map, c, pIsInit ? 'give' : 'get'));
    return map;
  }

  // ---------- Card metadata ----------
  function extractCardIdFromDom(el) { return el.getAttribute('data-card-template') || null; }

  function extractCardMeta(api) {
    if (!api?.playerName || !api?.insertName || !api?.cardNumber) return null;
    const player = clean(api.playerName), insertName = clean(api.insertName), number = clean(api.cardNumber);
    return { player, insertName, number, query: buildQuery({ player, insertName, number }),
             rawDetails: `${insertName}, ${number}`, isPhysical: api.isPhysical ?? false,
             isTransferable: api.isTransferable ?? false, cardId: api.templateId };
  }

  function extractCardMetaFromDom(el) {
    const titleEl   = el.querySelector('.name.card-title') || el.querySelector('.card-title');
    const detailsEl = el.querySelector('.details');
    if (!titleEl || !detailsEl) return null;
    const player = clean(titleEl.textContent), raw = clean(detailsEl.textContent);
    if (!player || !raw) return null;
    const ci = raw.lastIndexOf(',');
    const insertName = ci !== -1 ? clean(raw.substring(0, ci)) : raw;
    const number     = ci !== -1 ? clean(raw.substring(ci + 1)) : '';
    const isPhysical = el.querySelector('.card-body')?.classList.contains('is-physical') ?? false;
    return { player, insertName, number, query: buildQuery({ player, insertName, number }),
             rawDetails: raw, isPhysical, isTransferable: false, cardId: extractCardIdFromDom(el) };
  }

  function buildQuery({ player, insertName, number }) {
    const san = s => String(s||'').replace(/[""]/g,'').replace(/[\u2018\u2019]/g,"'")
                      .replace(/&/g,'').replace(/\s+/g,' ').trim();
    const cleanSet = s => String(s||'')
      .replace(/\bBase Set\b/gi,'Base').replace(/\bUD\s+Series\s+\d+\b/g,'Upper Deck')
      .replace(/\bUD\b/g,'Upper Deck').replace(/\bOutburst Silver\b/g,'Outburst')
      .replace(/\bParallel\b/gi,'').replace(/\bTier\s+\d+\b/g,'')
      .replace(/\bOracles\s*-\s*SSP\b/gi,'Oracles Rare').replace(/\s+/g,' ').trim();
    const cleanPlayer = s => san(s).replace(/\s+CL$/i,' Checklist');
    const skipNum = /Young Guns Renewed/i.test(insertName);
    return [cleanPlayer(player), cleanSet(san(insertName)),
            skipNum ? '' : String(number||'').replace(/^#/,'')]
      .filter(Boolean).join(' ').trim();
  }

  // ---------- Cache ----------
  const cacheKey = q => `comc:${CACHE_VERSION}:${q.toLowerCase()}`;

  function getCached(q) {
    try {
      const raw = localStorage.getItem(cacheKey(q));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (now() - obj.ts > (obj.ttl || CACHE_TTL_MS)) { localStorage.removeItem(cacheKey(q)); return null; }
      return obj.data;
    } catch { return null; }
  }

  function setCached(q, data) {
    try { localStorage.setItem(cacheKey(q), JSON.stringify({ ts: now(), ttl: CACHE_TTL_MS, data })); }
    catch {}
  }

  function clearCache() {
    const prefix = `comc:${CACHE_VERSION}:`;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  }

  // ---------- Fee preference ----------
  const getIncludeFee   = () => { try { const v = localStorage.getItem(PREF_INCLUDE_FEE); return v === null ? true : v === 'true'; } catch { return true; } };
  const setIncludeFee   = v  => { try { localStorage.setItem(PREF_INCLUDE_FEE, String(v)); } catch {} };
  const getDisplayPrice = p  => p == null ? null : (getIncludeFee() ? p : Math.max(0, p - COMC_FEE));

  // ---------- COMC fetch via worker ----------
  function comcSearchUrl(query) {
    const enc = query.replace(/\./g, '{46}').replace(/,/g, '~2c');
    return 'https://www.comc.com/Cards,=' + encodeURIComponent(enc) + ',fb,aUngraded';
  }

  /**
   * Send a fetch request to the comc.com worker tab via GM shared storage.
   * The worker (comc-worker.user.js) runs on any open comc.com tab and
   * fulfils the request using same-origin fetch() — no CF issues.
   */
  async function fetchSearchHtml(query) {
    const url = comcSearchUrl(query);

    if (!worker.alive) {
      return { ok: false, error: 'worker offline', workerOffline: true, url };
    }

    const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await GM_setValue('comc_req', JSON.stringify({ id, url }));

    const deadline = Date.now() + WORKER_TIMEOUT;
    while (Date.now() < deadline) {
      await delay(400);
      const raw = await GM_getValue('comc_res_' + id, null);
      if (raw != null) {
        await GM_deleteValue('comc_res_' + id);
        try {
          const result = JSON.parse(raw);
          if (result.ok) return { ok: true, html: result.html, url };
          return { ok: false, status: result.status, error: result.error, url };
        } catch {
          return { ok: false, error: 'response parse error', url };
        }
      }
    }
    return { ok: false, error: 'worker timeout', workerOffline: true, url };
  }

  // ---------- Parse COMC results ----------
  function parseSearch(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const wrappers = [...doc.querySelectorAll('.results .cardInfoWrapper')];
    const items = [];
    let nonAuctionTotal = 0, auctionTotal = 0;

    for (const w of wrappers) {
      const dataDiv  = w.querySelector('.carddata');
      const priceDiv = w.querySelector('.listprice');
      if (!dataDiv || !priceDiv) continue;
      if (priceDiv.classList.contains('auctionItem')) { auctionTotal++; continue; }
      nonAuctionTotal++;

      const desc   = clean(dataDiv.querySelector('.description')?.textContent || '');
      const href   = dataDiv.querySelector('h3.title a')?.getAttribute('href') || '';
      const link   = href ? 'https://www.comc.com' + href : null;
      const mPrice = (priceDiv.querySelector('a')?.textContent || priceDiv.textContent).match(/\$[\d,]*\.?\d{2}/);
      const price  = mPrice ? parseFloat(mPrice[0].replace(/[$,]/g, '')) : null;
      const qtyM   = priceDiv.querySelector('.qty')?.textContent.trim().match(/^(\d+)\s+from/i);
      const quantity = qtyM ? parseInt(qtyM[1], 10) : null;
      const isBase = /\[\s*Base\s*\](?!\s*-\s*)/i.test(desc) || /\[\s*Base\s*\]\s*#\s*\d+/i.test(desc);
      if (price != null) items.push({ desc, link, price, isBase, quantity });
    }
    return { items, counts: { nonAuctionTotal, auctionTotal } };
  }

  // ---------- Chip UI ----------
  async function renderChip(cardEl, payload) {
    const { text, title = '', link = null, isError = false, tooltip = '',
            isPhysical = null, isTransferable = null, rawPrice = null } = payload;
    const footer = cardEl.querySelector('.card-footer') || cardEl;
    let chip = footer.querySelector(SELECTORS.PRICE_CHIP);
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'epack-price-chip';
      Object.assign(chip.style, {
        marginTop: '6px', padding: '3px 8px', border: '1px solid #ccc',
        borderRadius: '8px', fontSize: '12px', display: 'block',
        cursor: 'default', userSelect: 'none', whiteSpace: 'nowrap',
      });
      footer.appendChild(chip);
    }

    if (rawPrice != null) chip.dataset.rawPrice = String(rawPrice);
    else delete chip.dataset.rawPrice;
    if (isPhysical !== null) chip.dataset.isPhysical = String(isPhysical);

    let displayText = text;
    if (rawPrice != null) displayText = `COMC: $${getDisplayPrice(rawPrice).toFixed(2)}`;
    if (isPhysical !== null) displayText += isPhysical ? '' : ' 💿';
    chip.textContent = displayText;

    let tt = '';
    if (isPhysical && !isTransferable) tt += 'Non-Transferable Physical Card\n';
    tt += (tooltip ? tooltip + '\n' : '') + title;
    chip.title         = tt;
    chip.style.background  = isError ? '#fee' : '';
    chip.style.borderColor = '#ccc';
    chip.style.cursor      = link ? 'pointer' : 'default';
    chip.onclick           = link ? () => window.open(link, '_blank') : null;
    await renderTotals();
  }

  async function clearChips() {
    document.querySelectorAll(`${SELECTORS.CARD} ${SELECTORS.PRICE_CHIP}`).forEach(c => c.remove());
    document.querySelectorAll(SELECTORS.PHYSICAL_INDICATOR).forEach(i => i.remove());
    document.querySelectorAll(SELECTORS.CARD).forEach(c => c.classList.remove('epack-digital-card'));
    await renderTotals();
  }

  async function refreshAllPrices() {
    document.querySelectorAll(SELECTORS.PRICE_CHIP).forEach(chip => {
      const raw = parseFloat(chip.dataset.rawPrice);
      if (isNaN(raw)) return;
      let t = `COMC: $${getDisplayPrice(raw).toFixed(2)}`;
      if (chip.dataset.isPhysical === 'false') t += ' 💿';
      chip.textContent = t;
    });
    document.querySelectorAll(SELECTORS.PRICE_BTN).forEach(btn => {
      const raw = parseFloat(btn.dataset.rawPrice);
      if (isNaN(raw)) return;
      btn.textContent = `$${getDisplayPrice(raw).toFixed(2)}`;
    });
    await renderTotals();
  }

  async function addPhysicalIndicators() {
    const tradeData = await getTradeData(); if (!tradeData) return;
    const map = await buildCardLookupMap(tradeData);
    document.querySelectorAll(SELECTORS.CARD).forEach(card => {
      try {
        const id = extractCardIdFromDom(card); if (!id) return;
        const api = map.get(id);
        const isPhysical     = api?.isPhysical ?? (isInEditMode() ? (card.querySelector('.card-body')?.classList.contains('is-physical') ?? false) : false);
        const isTransferable = api?.isTransferable ?? false;
        if (!isPhysical) return;
        const sbi = card.querySelector(SELECTORS.SIDE_BTN_ITEMS);
        if (!sbi || sbi.querySelector(SELECTORS.PHYSICAL_INDICATOR)) return;
        const div  = document.createElement('div');
        div.className = 'side-btn tooltip-right epack-physical-indicator';
        div.setAttribute('data-tooltip', isTransferable ? 'Physical Card' : 'Physical Card (NT)');
        const icon = document.createElement('i');
        icon.className = 'ud ud-transfer';
        icon.style.opacity = '0.7';
        icon.style.color   = isTransferable ? '#1d4fd3' : '#f89e2e';
        div.appendChild(icon);
        sbi.insertBefore(div, sbi.firstChild);
      } catch {}
    });
  }

  async function applyDigitalCardStyling() {
    if (!FADE_DIGITAL) return;
    if (!document.getElementById('epack-digital-card-style')) {
      const s = document.createElement('style');
      s.id = 'epack-digital-card-style';
      s.textContent = `.epack-digital-card{opacity:${FADE_OPACITY}!important;transition:opacity .2s ease!important}
                       .epack-digital-card:hover{opacity:1!important}`;
      document.head.appendChild(s);
    }
    const tradeData = await getTradeData(); if (!tradeData) return;
    const map = await buildCardLookupMap(tradeData);
    document.querySelectorAll(SELECTORS.CARD).forEach(card => {
      try {
        const id = extractCardIdFromDom(card); if (!id) return;
        const api = map.get(id);
        const isPhysical = api ? api.isPhysical
          : (isInEditMode() ? (card.querySelector('.card-body')?.classList.contains('is-physical') ?? null) : null);
        if (isPhysical === null) return;
        card.classList.toggle('epack-digital-card', isPhysical === false);
      } catch {}
    });
  }

  // ---------- Totals ----------
  function findSideContainers() {
    const sides = document.querySelectorAll(SELECTORS.TRADE_SIDES);
    if (sides.length >= 2) return { getEl: sides[0], giveEl: sides[1] };
    return { getEl: null, giveEl: null };
  }

  function parseChipPrice(chip) {
    if (!chip) return null;
    const m = chip.textContent.match(/\$([\d,]*\.?\d{2})/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }

  async function computeSideTotals(el) {
    if (!el) return { sum: 0, qty: 0, missing: 0, digital: 0, total: 0 };
    const tradeData = await getTradeData();
    const map  = tradeData ? await buildCardLookupMap(tradeData) : new Map();
    const edit = isInEditMode();
    let sum = 0, priced = 0, digital = 0;
    const cards = [...el.querySelectorAll(SELECTORS.CARD)];
    for (const card of cards) {
      const price = parseChipPrice(card.querySelector(SELECTORS.PRICE_CHIP));
      const id    = extractCardIdFromDom(card);
      const api   = id ? map.get(id) : null;
      const isDig = api ? api.isPhysical === false
        : (edit ? !(card.querySelector('.card-body')?.classList.contains('is-physical') ?? true) : false);
      if (isDig) digital++;
      else if (price != null) { sum += price; priced++; }
    }
    return { sum, qty: priced, missing: cards.length - priced - digital, digital, total: cards.length };
  }

  function ensureTotalsRow() {
    const anchor = document.getElementById(ANCHOR_ID);
    if (!anchor) return null;
    let row = document.getElementById(TOTALS_ID);
    if (!row) {
      row = document.createElement('div');
      row.id = TOTALS_ID;
      Object.assign(row.style, {
        marginTop: '12px', padding: '10px 16px', background: '#f8f9fa',
        border: '1px solid #dee2e6', borderRadius: '6px', fontSize: '14px',
        display: 'flex', gap: '32px', alignItems: 'center', flexWrap: 'wrap', fontWeight: '500',
      });
      anchor.appendChild(row);
    }
    return row;
  }

  async function renderTotals() {
    const row = ensureTotalsRow(); if (!row) return;
    const { getEl, giveEl } = findSideContainers();
    const [gt, gvt] = await Promise.all([computeSideTotals(getEl), computeSideTotals(giveEl)]);
    row.textContent = '';
    const mk = (label, t) => {
      const span = document.createElement('span');
      span.style.fontWeight = '600';
      let txt = `${label}: $${t.sum.toFixed(2)} (priced: ${t.qty}/${t.total}`;
      if (t.digital > 0) txt += `, digital: ${t.digital}`;
      if (t.missing > 0) txt += `, missing: ${t.missing}`;
      span.textContent = txt + ')';
      return span;
    };
    row.appendChild(mk('You get total', gt));
    row.appendChild(mk('You give total', gvt));
  }

  // ---------- Fetch flow ----------
  async function runFetchFlow(setStatus) {
    const cards = [...document.querySelectorAll(SELECTORS.CARD)];
    if (!cards.length) { setStatus?.('No cards'); return; }
    state.shouldAbort = false;
    state.isFetching  = true;

    try {
      setStatus?.('Loading trade data…');
      const tradeData = await getTradeData();
      const map       = await buildCardLookupMap(tradeData);
      const edit      = isInEditMode();
      let idx = 0;

      for (const card of cards) {
        if (state.shouldAbort) { setStatus?.('Aborted'); await delay(DELAY_MS); setStatus?.(''); return; }

        const id  = extractCardIdFromDom(card);
        const api = id ? map.get(id) : null;
        let meta  = extractCardMeta(api);
        if (!meta?.query) {
          if (edit) { meta = extractCardMetaFromDom(card); if (!meta?.query) continue; }
          else continue;
        }

        setStatus?.(`(${++idx}/${cards.length}) ${meta.player}…`);

        if (meta.isPhysical === false) {
          await renderChip(card, { text: 'COMC: N/A (Digital)', title: 'Digital-only card', isPhysical: false });
          await delay(DELAY_MS);
          continue;
        }

        await renderChip(card, { text: 'COMC: …', title: `Fetching: ${meta.query}`, isPhysical: meta.isPhysical });

        const cached = getCached(meta.query);
        if (cached) {
          await renderChip(card, {
            text: cached.price != null ? `COMC: $${cached.price.toFixed(2)}` : 'COMC: —',
            title: cached.link || 'COMC search', link: cached.link || null,
            tooltip: cached.tooltip || '', isPhysical: meta.isPhysical,
            isTransferable: meta.isTransferable, rawPrice: cached.price,
          });
          await delay(DELAY_MS);
          continue;
        }

        const resp = await fetchSearchHtml(meta.query);

        if (!resp.ok) {
          let text  = 'COMC: n/a';
          let title = resp.error || `HTTP ${resp.status}`;
          if (resp.workerOffline) {
            text  = 'COMC: worker offline';
            title = 'Open a comc.com tab in Chrome (with the ePack COMC Worker script installed), then click Refresh Prices.';
          }
          await renderChip(card, { text, title, isError: true, isPhysical: meta.isPhysical });
          console.warn(LOG, 'Fetch failed:', meta.query, resp);
          await delay(DELAY_MS);
          continue;
        }

        const { items, counts } = parseSearch(resp.html);
        const cheapest = items.length ? items.slice().sort((a, b) => a.price - b.price)[0] : null;

        if (!cheapest) {
          const searchLink = comcSearchUrl(meta.query);
          const tooltip    = `${counts.nonAuctionTotal} listings on COMC`;
          setCached(meta.query, { price: null, link: searchLink, tooltip });
          await renderChip(card, { text: 'COMC: —', title: searchLink, link: searchLink, tooltip,
                                   isPhysical: meta.isPhysical, isTransferable: meta.isTransferable });
        } else {
          const link    = cheapest.link || comcSearchUrl(meta.query);
          const tooltip = cheapest.quantity != null
            ? `${cheapest.quantity} available on COMC`
            : `${counts.nonAuctionTotal} listings on COMC`;
          setCached(meta.query, { price: cheapest.price, link, tooltip });
          await renderChip(card, { text: `COMC: $${cheapest.price.toFixed(2)}`, title: link, link,
                                   tooltip, isPhysical: meta.isPhysical, isTransferable: meta.isTransferable,
                                   rawPrice: cheapest.price });
        }

        await delay(REQ_DELAY_MS + Math.random() * REQ_DELAY_RANDOM);
      }

      setStatus?.('Done'); await delay(DELAY_MS); setStatus?.('');
      await renderTotals();
    } finally {
      state.isFetching = false;
    }
  }

  // ---------- Toolbar ----------
  let _workerBadgeEl = null;

  function updateWorkerBadge(alive) {
    if (!_workerBadgeEl) return;
    if (alive) {
      _workerBadgeEl.textContent = '⚡ worker ✓';
      _workerBadgeEl.title = 'COMC worker tab is active. Fetches run as same-origin requests from your comc.com tab.';
      Object.assign(_workerBadgeEl.style, { background: '#d4edda', color: '#155724', borderColor: '#c3e6cb' });
    } else {
      _workerBadgeEl.textContent = '⚠ open comc.com tab';
      _workerBadgeEl.title = 'No comc.com worker found.\nOpen a comc.com tab in Chrome with the ePack COMC Worker script installed.';
      Object.assign(_workerBadgeEl.style, { background: '#fff3cd', color: '#856404', borderColor: '#ffc107' });
    }
  }

  function buildToolbar() {
    const wrapper = document.createElement('div');
    wrapper.id = TOOLBAR_ID;
    Object.assign(wrapper.style, { display: 'flex', gap: '12px', alignItems: 'center', width: '100%' });

    const fetchBtn    = document.createElement('button');
    const refreshBtn  = document.createElement('button');
    const abortBtn    = document.createElement('button');
    const workerBadge = document.createElement('span');
    const status      = document.createElement('span');

    fetchBtn.textContent   = 'Fetch COMC Prices';
    refreshBtn.textContent = 'Refresh Prices';
    abortBtn.textContent   = 'Abort';
    abortBtn.style.display = 'none';

    const btnStyle = () => ({
      padding: '8px 16px', fontSize: '13px', borderRadius: '6px',
      border: '1px solid #007bff', background: '#007bff', color: 'white',
      cursor: 'pointer', fontWeight: '500', transition: 'all 0.2s',
    });
    Object.assign(fetchBtn.style,   btnStyle());
    Object.assign(refreshBtn.style, { ...btnStyle(), background: '#6c757d', borderColor: '#6c757d' });
    Object.assign(abortBtn.style,   { ...btnStyle(), background: '#dc3545', borderColor: '#dc3545' });
    Object.assign(status.style,     { fontSize: '13px', color: '#555', fontWeight: '500' });
    Object.assign(workerBadge.style, {
      fontSize: '11px', padding: '2px 8px', borderRadius: '10px', fontWeight: '600',
      background: '#e9ecef', color: '#6c757d', border: '1px solid #dee2e6', cursor: 'default',
    });
    workerBadge.textContent = '⏳ worker…';
    _workerBadgeEl = workerBadge;

    // Check worker asynchronously so the toolbar renders immediately
    ensureWorkerChecked().then(() => updateWorkerBadge(worker.alive));

    // Fee toggle
    const feeWrap = document.createElement('div');
    Object.assign(feeWrap.style, {
      display: 'inline-flex', alignItems: 'center', gap: '8px',
      marginLeft: 'auto', fontWeight: '600', fontSize: '14px',
    });
    const feeLabel = document.createElement('span');
    feeLabel.textContent = `Incl. COMC fee ($${COMC_FEE.toFixed(2)}/card)`;
    const onoff = document.createElement('div');
    onoff.className = 'onoffswitch'; onoff.style.lineHeight = '1.5'; onoff.style.top = '3px';
    const ol = document.createElement('label'); ol.className = 'onoffswitch-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'onoffswitch-checkbox'; cb.checked = getIncludeFee();
    const inner = document.createElement('span'); inner.className = 'onoffswitch-inner';
    const sw    = document.createElement('span'); sw.className    = 'onoffswitch-switch';
    ol.append(cb, inner, sw); onoff.appendChild(ol); feeWrap.append(feeLabel, onoff);
    cb.onchange = () => { setIncludeFee(cb.checked); refreshAllPrices(); };

    wrapper.append(fetchBtn, refreshBtn, abortBtn, workerBadge, status, feeWrap);

    [fetchBtn, refreshBtn, abortBtn].forEach(b => {
      b.onmouseenter = () => { b.style.opacity = '0.9'; b.style.transform = 'translateY(-1px)'; };
      b.onmouseleave = () => { b.style.opacity = '1';   b.style.transform = 'translateY(0)'; };
    });

    const lock = async (label, fn) => {
      fetchBtn.disabled = refreshBtn.disabled = true;
      fetchBtn.style.opacity = refreshBtn.style.opacity = '0.6';
      abortBtn.style.display = 'inline-block';
      status.textContent = label;
      try { await fn(); }
      finally {
        fetchBtn.disabled = refreshBtn.disabled = false;
        fetchBtn.style.opacity = refreshBtn.style.opacity = '1';
        abortBtn.style.display = 'none';
        status.textContent = '';
      }
    };

    fetchBtn.onclick = () => lock('Fetching…', () => runFetchFlow(m => status.textContent = m));

    refreshBtn.onclick = () => lock('Refreshing…', async () => {
      await clearChips();
      clearCache();
      state.cachedTradeData = null;
      state.partnerInfoInjected = false;
      // Re-check worker on explicit refresh
      worker.checked = false;
      await ensureWorkerChecked();
      updateWorkerBadge(worker.alive);
      await runFetchFlow(m => status.textContent = m);
      const td = await getTradeData();
      if (td) { injectTradePartnerInfo(td); state.partnerInfoInjected = true; }
      await addPhysicalIndicators();
      await applyDigitalCardStyling();
    });

    abortBtn.onclick = () => {
      state.shouldAbort = true;
      status.textContent = 'Aborting…';
      abortBtn.disabled = true;
    };

    return wrapper;
  }

  function mountToolbar() {
    const header = document.querySelector(SELECTORS.TRADE_HEADER);
    if (!header) return false;
    header.style.marginBottom = '16px';
    let anchor = document.getElementById(ANCHOR_ID);
    if (!anchor) {
      anchor = document.createElement('div');
      anchor.id = ANCHOR_ID;
      Object.assign(anchor.style, {
        marginTop: '0px', marginBottom: '12px', padding: '12px 15px',
        background: 'white', boxShadow: '0 1px 5px 0 rgba(0,0,0,.1)',
      });
      header.insertAdjacentElement('afterend', anchor);
    }
    if (!anchor.querySelector(SELECTORS.TOOLBAR)) anchor.appendChild(buildToolbar());
    ensureTotalsRow();
    return true;
  }

  // ---------- Trade partner info ----------
  function injectTradePartnerInfo(tradeData) {
    if (!tradeData) return false;
    const container = document.querySelector(SELECTORS.PARTNER_CONTAINER);
    if (!container) return false;
    const partner = getTradePartnerUsername();
    if (!partner) return false;

    const pIsInit = tradeData.Initiator?.UserName?.toLowerCase()    === partner.toLowerCase();
    const pIsCp   = tradeData.Counterparty?.UserName?.toLowerCase() === partner.toLowerCase();
    const lastLogin   = pIsInit ? tradeData.Initiator?.LastLoginDate    : (pIsCp ? tradeData.Counterparty?.LastLoginDate    : null);
    const ratingGiven = pIsInit ? tradeData.InitiatorRating             : (pIsCp ? tradeData.CounterpartyRating             : 0);

    container.querySelector(SELECTORS.PARTNER_INFO)?.remove();
    const div = document.createElement('div');
    div.className = 'epack-partner-info';
    Object.assign(div.style, {
      display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start',
      gap: '2px', marginLeft: '16px', fontSize: '12px', color: '#666',
    });
    if (lastLogin) {
      const s = document.createElement('div');
      s.textContent = `Last seen: ${formatRelativeTime(lastLogin)}`;
      div.appendChild(s);
    }
    if (ratingGiven > 0) {
      const s = document.createElement('div');
      s.innerHTML = `Rated you: <span style="color:#f39c12;font-size:14px;">${formatRatingStars(ratingGiven)}</span> <span style="color:#999;">(${ratingGiven}/5)</span>`;
      div.appendChild(s);
    }
    if (div.children.length) { container.appendChild(div); return true; }
    return false;
  }

  // ---------- DOM monitoring ----------
  async function ensurePartnerInfo() {
    if (state.isCheckingPartnerInfo) return;
    state.isCheckingPartnerInfo = true;
    try {
      const container = document.querySelector(SELECTORS.PARTNER_CONTAINER);
      if (container && !document.querySelector(SELECTORS.PARTNER_INFO)) {
        if (!state.cachedTradeData) state.cachedTradeData = await getTradeData();
        if (state.cachedTradeData && injectTradePartnerInfo(state.cachedTradeData))
          state.partnerInfoInjected = true;
      }
    } finally { state.isCheckingPartnerInfo = false; }
  }

  async function checkAndMountToolbar() {
    if (state.isCheckingToolbar) return;
    state.isCheckingToolbar = true;
    try {
      const anchor  = document.getElementById(ANCHOR_ID);
      const toolbar = document.querySelector(SELECTORS.TOOLBAR);
      if (!anchor || !toolbar) {
        if (state.toolbarMounted) {
          state.toolbarMounted = false; state.partnerInfoInjected = false;
          state.cachedTradeData = null; _workerBadgeEl = null;
        }
        if (mountToolbar()) {
          state.toolbarMounted = true;
          await delay(300);
          await addPhysicalIndicators().catch(() => {});
          await applyDigitalCardStyling().catch(() => {});
          await renderTotals().catch(() => {});
          await delay(500);
          await ensurePartnerInfo();
        }
      } else {
        if (!state.toolbarMounted) state.toolbarMounted = true;
        await ensurePartnerInfo();
      }
    } finally { state.isCheckingToolbar = false; }
  }

  function setupMutationObserver() {
    const obs = new MutationObserver(() => {
      if (state.isCheckingToolbar) return;
      const hasHeader = document.querySelector(SELECTORS.TRADE_HEADER);
      const anchor    = document.getElementById(ANCHOR_ID);
      const toolbar   = document.querySelector(SELECTORS.TOOLBAR);
      if (hasHeader && (!anchor || !toolbar)) { checkAndMountToolbar(); return; }
      if (state.toolbarMounted && anchor && toolbar) {
        const container = document.querySelector(SELECTORS.PARTNER_CONTAINER);
        if (container && !document.querySelector(SELECTORS.PARTNER_INFO) && !state.isCheckingPartnerInfo)
          ensurePartnerInfo();
      }
      if (!hasHeader && document.querySelector(SELECTORS.LIST_ROW)) scanListViewRows();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    state.mutationObserver = obs;
  }

  function cleanup() {
    state.mutationObserver?.disconnect(); state.mutationObserver = null;
    clearInterval(state.pollingInterval);  state.pollingInterval  = null;
  }

  // ============================================================
  // COLLECTION / LISTING PAGE  (per-card price icons)
  // ============================================================

  function isTradeDetailPage() {
    return !!document.querySelector(SELECTORS.TRADE_HEADER);
  }

  function extractCardMetaFromListRow(row) {
    const nameCol    = row.querySelector('.card-name');
    // Read name from a dedicated span if injected, otherwise raw text node
    const player     = clean(
      nameCol?.querySelector('.epack-card-name-text')?.textContent ||
      Array.from(nameCol?.childNodes || []).filter(n => n.nodeType === 3).map(n => n.textContent).join('') ||
      nameCol?.textContent || ''
    );
    // Read number from a dedicated span if injected, otherwise raw numCol text
    const numCol     = row.querySelector('.row.py-0.align-items-center .col-1.text-right');
    const number     = clean(numCol?.querySelector('.epack-card-num')?.textContent || numCol?.textContent || '');
    const insertName = clean(row.closest('.group')?.querySelector('.group-header')?.textContent || '');
    if (!player || !insertName) return null;
    return { player, insertName, number, isPhysical: true, isTransferable: false,
             query: buildQuery({ player, insertName, number }) };
  }

  async function handleListRowPriceClick(row, btn) {
    if (btn.dataset.loading) return;
    btn.dataset.loading = '1';
    btn.textContent = '⏳';
    btn.title = 'Fetching…';
    btn.style.pointerEvents = 'none';

    try {
      await ensureWorkerChecked();
      if (!worker.alive) {
        btn.textContent = '⚠';
        btn.title = 'Open a comc.com tab in Chrome (with the script installed), then try again.';
        btn.style.color = '#856404';
        return;
      }

      const meta = extractCardMetaFromListRow(row);
      if (!meta?.query) {
        btn.textContent = '?';
        btn.title = 'Cannot read card data from this row.';
        return;
      }

      let cached = getCached(meta.query);
      if (!cached) {
        const resp = await fetchSearchHtml(meta.query);
        if (!resp.ok) {
          btn.textContent = '✗';
          btn.title = resp.workerOffline
            ? 'Worker offline — open a comc.com tab and try again.'
            : (resp.error || `HTTP ${resp.status}`);
          btn.style.color = '#721c24';
          return;
        }
        const { items, counts } = parseSearch(resp.html);
        const cheapest = items.length ? items.slice().sort((a, b) => a.price - b.price)[0] : null;
        const link     = cheapest?.link || comcSearchUrl(meta.query);
        const tooltip  = cheapest?.quantity != null
          ? `${cheapest.quantity} available on COMC`
          : `${counts.nonAuctionTotal} listings on COMC`;
        setCached(meta.query, { price: cheapest?.price ?? null, link, tooltip });
        cached = getCached(meta.query);
      }

      const rawPrice = cached?.price ?? null;
      const link     = cached?.link   || comcSearchUrl(meta.query);
      const tooltip  = cached?.tooltip || '';

      if (rawPrice != null) {
        btn.dataset.rawPrice = String(rawPrice);
        btn.textContent = `$${getDisplayPrice(rawPrice).toFixed(2)}`;
        btn.title = (tooltip ? tooltip + '\n' : '') + 'Click to view on COMC';
        btn.style.color = '#155724';
        btn.style.fontWeight = '700';
        btn.onclick = e => { e.stopPropagation(); window.open(link, '_blank'); };
      } else {
        btn.textContent = '—';
        btn.title = (tooltip ? tooltip + '\n' : '') + 'Not found on COMC (click to search)';
        btn.style.color = '#555';
        btn.onclick = e => { e.stopPropagation(); window.open(link, '_blank'); };
      }
    } finally {
      delete btn.dataset.loading;
      btn.style.pointerEvents = '';
    }
  }

  function injectListRowPriceBtn(row) {
    const headerRow = row.querySelector('.row.py-0.align-items-center');
    if (!headerRow) return;
    if (headerRow.querySelector(SELECTORS.PRICE_BTN)) return;

    // Inject into the card number column — wrap existing number in a span first
    const numCol = headerRow.querySelector('.col-1.text-right');
    if (!numCol) return;

    const numText = numCol.textContent.trim();
    numCol.textContent = '';
    const numSpan = document.createElement('span');
    numSpan.className = 'epack-card-num';
    numSpan.textContent = numText;

    const btn = document.createElement('div');
    btn.className = 'epack-price-btn';
    btn.textContent = '$';
    btn.title = 'Check COMC price';
    Object.assign(btn.style, {
      fontSize: '14px', fontWeight: '600', cursor: 'pointer', letterSpacing: '0.5px',
      padding: '1px 5px', borderRadius: '4px', border: '1px solid #bbb',
      background: '#f4f4f4', color: '#333', display: 'inline-block',
      lineHeight: '1.5', userSelect: 'none', whiteSpace: 'nowrap',
    });
    btn.onclick = e => { e.stopPropagation(); handleListRowPriceClick(row, btn); };

    numCol.style.display = 'flex';
    numCol.style.flexDirection = 'row';
    numCol.style.alignItems = 'center';
    numCol.style.justifyContent = 'space-between';
    numCol.style.gap = '16px';
    numCol.appendChild(btn);
    numCol.appendChild(numSpan);
  }

  function isListRowPhysical(row) {
    const headerRow = row.querySelector('.row.py-0.align-items-center');
    if (!headerRow) return false;
    const physEl = headerRow.querySelector('.physical-item');
    return physEl ? physEl.textContent.includes('✓') : false;
  }

  function scanListViewRows() {
    document.querySelectorAll(SELECTORS.LIST_ROW).forEach(row => {
      if (!isListRowPhysical(row)) return;
      const headerRow = row.querySelector('.row.py-0.align-items-center');
      if (!headerRow || headerRow.querySelector(SELECTORS.PRICE_BTN)) return;
      injectListRowPriceBtn(row);
    });
  }

  // ---------- Silent transfer (Collection page only) ----------
  // Intercept .side-btn-transfer clicks in capture phase so React never sees them.
  // React's handlers run in bubble phase on document — capture fires first, letting us
  // call stopImmediatePropagation() before any Redux dispatch (and any DOM clearing) happens.
  if (location.pathname.startsWith('/Collection')) {
    const _transferredIds = new Set();

    document.addEventListener('click', function(e) {
      const btn = e.target.closest('.side-btn-transfer');
      if (!btn) return;
      e.stopImmediatePropagation();
      e.preventDefault();

      let inventoryCardId = null;
      try {
        const instKey = Object.keys(btn).find(k => k.startsWith('__reactInternalInstance'));
        const owner = btn[instKey]?._currentElement?._owner;
        inventoryCardId = owner?._instance?.props?.instance?.InventoryCardID ?? null;
      } catch (ex) { /* ignore */ }

      if (!inventoryCardId) {
        console.warn(LOG, 'silent transfer: could not read InventoryCardID');
        return;
      }

      if (_transferredIds.has(inventoryCardId)) {
        console.info(LOG, 'silent transfer: already transferred', inventoryCardId);
        return;
      }

      btn.style.opacity = '0.4';
      fetch('/api/transfer/AddToTransferCart', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([inventoryCardId]),
      }).then(r => {
        btn.style.opacity = '';
        if (r.ok) {
          const img = btn.closest('.side-btn-items')?.previousElementSibling?.querySelector('.product-card-display')
                   ?? btn.closest('[data-card-template]');
          if (img) img.style.opacity = '0.25';
          _transferredIds.add(inventoryCardId);
          btn.style.pointerEvents = 'none';
          const meatball = Array.from(document.querySelectorAll('.js-transfer-cart-icon i.ud-transfer, i.ud-transfer'))
            .find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
          if (meatball) meatball.dataset.meatballAlert = String(Number(meatball.dataset.meatballAlert || 0) + 1);
          console.info(LOG, 'silent transfer OK', inventoryCardId);
        } else {
          console.warn(LOG, 'silent transfer HTTP', r.status);
        }
      }).catch(err => {
        btn.style.opacity = '';
        console.error(LOG, 'silent transfer error', err);
      });
    }, true);
  }

  function initialize() {
    setupMutationObserver();
    setTimeout(() => checkAndMountToolbar(), 500);
    setTimeout(() => scanListViewRows(), 600);
    state.pollingInterval = setInterval(() => {
      if (!state.isCheckingToolbar) checkAndMountToolbar();
      if (!isTradeDetailPage()) scanListViewRows();
    }, TOOLBAR_CHECK_MS);
    window.addEventListener('beforeunload', cleanup);
  }

  initialize();
})();
