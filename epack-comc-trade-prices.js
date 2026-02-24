// ==UserScript==
// @name         ePack Trade COMC price check
// @namespace    epack-comc-trade-prices
// @version      1.1.0
// @description  Fetch COMC prices on demand using API data.
// @match        https://www.upperdeckepack.com/*
// @grant        GM_xmlhttpRequest
// @connect      comc.com
// @connect      upperdeckepack.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Config ----------
  const REQ_DELAY_MS       = 1000;
  const REQ_DELAY_RANDOM   = 500;
  const DELAY_MS           = 250;
  const TOOLBAR_CHECK_MS   = 2000;
  const CACHE_TTL_MS       = 3 * 60 * 60 * 1000; // 3h
  const CACHE_VERSION      = 'v10';
  const FADE_DIGITAL       = true;
  const FADE_OPACITY       = 0.3;
  const LOG                = '[ePack→COMC]';
  const COMC_FEE           = 0.25;
  const PREF_INCLUDE_FEE   = 'epack-comc-include-fee';
  const TOOLBAR_ID         = 'epack-comc-toolbar';
  const ANCHOR_ID          = `${TOOLBAR_ID}-anchor`;
  const TOTALS_ID          = `${TOOLBAR_ID}-totals`;

  // DOM Selectors
  const SELECTORS = {
    TOOLBAR: `#${TOOLBAR_ID}`,
    CARD: '.trade-card .product-card-display',
    PARTNER_CONTAINER: '.collection-owner-container .user-info',
    PARTNER_USERNAME: '.collection-owner-container .user-info a.username',
    TRADE_HEADER: '.page-section.container-fluid.action-bar.collection-header.trade-detail-header.desktop-only',
    TRADE_SIDES: '.trade-detail.row .trade-side.col-sm-6',
    SIDE_BTN_ITEMS: '.side-btn-items',
    PRICE_CHIP: '.epack-price-chip',
    PHYSICAL_INDICATOR: '.epack-physical-indicator',
    PARTNER_INFO: '.epack-partner-info',
    TRADE_EDIT_BUTTONS: '.trade-edit-buttons'
  };

  // Time constants to count last login time
  const TIME = {
    SECOND: 1000,
    MINUTE: 60 * 1000,
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000,
    WEEK: 7 * 24 * 60 * 60 * 1000,
    MONTH: 30 * 24 * 60 * 60 * 1000,
    YEAR: 365 * 24 * 60 * 60 * 1000
  };

  // ---------- State Management ----------
  const state = {
    cachedTradeData: null,
    toolbarMounted: false,
    partnerInfoInjected: false,
    isCheckingToolbar: false,
    isCheckingPartnerInfo: false,
    isFetching: false,
    shouldAbort: false,
    pollingInterval: null,
    mutationObserver: null
  };

  // ---------- Utilities ----------
  /**
   * Clean and normalize whitespace in a string.
   * @param {string} s - String to clean
   * @returns {string} Cleaned string
   */
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

  /**
   * Delay execution for specified milliseconds.
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   */
  const delay = ms => new Promise(r => setTimeout(r, ms));

  /**
   * Get current timestamp.
   * @returns {number} Current timestamp in milliseconds
   */
  const now = () => Date.now();

  /**
   * Format date as relative time (e.g., "2 hours ago", "3 days ago").
   * @param {string} dateString - ISO date string to format
   * @returns {string} Formatted relative time string
   */
  function formatRelativeTime(dateString) {
    if (!dateString || dateString === '0001-01-01T00:00:00') return 'Unknown';

    // API returns UTC timestamps - ensure they're parsed as UTC by adding 'Z' if not present
    let utcDateString = dateString;
    if (!dateString.endsWith('Z') && !dateString.includes('+') && !dateString.includes('T00:00:00.000')) {
      utcDateString = dateString + 'Z';
    }

    const date = new Date(utcDateString);
    const nowDate = new Date();
    const diffMs = nowDate - date;

    if (diffMs < TIME.MINUTE) return 'Just now';

    const diffMin = Math.floor(diffMs / TIME.MINUTE);
    if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;

    const diffHr = Math.floor(diffMs / TIME.HOUR);
    if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`;

    const diffDay = Math.floor(diffMs / TIME.DAY);
    if (diffDay < 7) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;

    const diffWeek = Math.floor(diffMs / TIME.WEEK);
    if (diffWeek < 4) return `${diffWeek} week${diffWeek !== 1 ? 's' : ''} ago`;

    const diffMonth = Math.floor(diffMs / TIME.MONTH);
    if (diffMonth < 12) return `${diffMonth} month${diffMonth !== 1 ? 's' : ''} ago`;

    const diffYear = Math.floor(diffMs / TIME.YEAR);
    return `${diffYear} year${diffYear !== 1 ? 's' : ''} ago`;
  }

  /**
   * Format rating as stars (1-5 scale).
   * @param {number} rating - Rating value (0-5)
   * @returns {string} Star representation (★☆)
   */
  function formatRatingStars(rating) {
    if (!rating || rating === 0) return '';
    const fullStars = '★'.repeat(rating);
    const emptyStars = '☆'.repeat(5 - rating);
    return fullStars + emptyStars;
  }

  // ---------- API Integration ----------
  /**
   * Extract trade partner's username from the visible "Trading With" section.
   * Prioritizes href attribute over text content for reliability.
   * @returns {string|null} The username or null if not found
   */
  function getTradePartnerUsername() {
    // The element has structure: <a class="username" href="/Profile/JFRules">...</a>
    const usernameLink = document.querySelector(SELECTORS.PARTNER_USERNAME);

    if (usernameLink) {
      // First try to extract from href attribute (most reliable)
      const href = usernameLink.getAttribute('href');
      if (href && href.startsWith('/Profile/')) {
        const username = href.replace('/Profile/', '');
        return username;
      }

      // Fallback: extract text, filtering out accessibility span content
      let textContent = usernameLink.textContent || '';
      // Remove the "account - " prefix from accessibility span
      textContent = textContent.replace(/^account\s*-\s*/i, '');
      const username = clean(textContent);

      if (username) {
        return username;
      }
    }

    return null;
  }

  /**
   * Extract trade ID from current URL path.
   * @returns {string|null} Trade ID or null if not found
   */
  function extractTradeIdFromUrl() {
    const pathParts = window.location.pathname.split('/');
    const detailsIndex = pathParts.indexOf('Details');
    if (detailsIndex !== -1 && pathParts.length > detailsIndex + 1) {
      return pathParts[detailsIndex + 1];
    }
    return null;
  }

  /**
   * Check if the trade page is in edit/draft mode (counter trade or new draft).
   * In edit mode, cards added by the user may not be in the API response yet.
   * Uses container element IDs inside .trade-edit-buttons to determine mode:
   *   Normal viewing: #accept-trade and #counter-trade containers present
   *   Edit/draft: those containers absent (Submit Trade, Cancel, etc. instead)
   * @returns {boolean} True if in edit/draft mode
   */
  function isInEditMode() {
    const editButtons = document.querySelector(SELECTORS.TRADE_EDIT_BUTTONS);

    if (editButtons) {
      // Normal viewing mode has #accept-trade and #counter-trade container elements
      const isViewing = !!editButtons.querySelector('#accept-trade') ||
                        !!editButtons.querySelector('#counter-trade');
      return !isViewing;
    }

    // .trade-edit-buttons not found — check if we're on a trade page at all
    return !!document.querySelector(SELECTORS.TRADE_HEADER) ||
           document.querySelectorAll(SELECTORS.CARD).length > 0;
  }

  /**
   * Fetch trade data from ePack API.
   * @param {string} tradeId - Trade ID to fetch
   * @returns {Promise<Object>} Promise resolving to API response
   */
  function fetchTradeApi(tradeId) {
    const url = `https://www.upperdeckepack.com/api/Trading/ViewTrade?id=${tradeId}&forceLoad=false`;
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        onload: (resp) => {
          if (resp.status >= 200 && resp.status < 300) {
            try {
              const data = JSON.parse(resp.responseText);
              resolve({ ok: true, data });
            } catch (e) {
              resolve({ ok: false, error: 'Failed to parse JSON', details: e.message });
            }
          } else {
            resolve({ ok: false, status: resp.status });
          }
        },
        onerror: (e) => resolve({ ok: false, error: e?.error || 'network error' })
      });
    });
  }

  /**
   * Fetch trade data from ePack API, with caching.
   * @returns {Promise<Object|null>} Trade data object or null on error
   */
  async function getTradeData() {
    // Return cached data if available
    if (state.cachedTradeData) return state.cachedTradeData;

    const tradeId = extractTradeIdFromUrl();
    if (!tradeId) {
      console.warn(LOG, 'No trade ID found in URL');
      return null;
    }

    const resp = await fetchTradeApi(tradeId);
    if (!resp.ok) {
      console.error(LOG, 'Failed to fetch trade API:', resp);
      return null;
    }

    state.cachedTradeData = resp.data;
    return resp.data;
  }

  /**
   * Helper function to add a card to the lookup map
   * @param {Map} map - The map to add to
   * @param {Object} cardWrapper - Card data from API
   * @param {string} side - 'give' or 'get'
   */
  function addCardToMap(map, cardWrapper, side) {
    const templateId = cardWrapper.CardTemplate?.CardTemplateID;

    if (!templateId) return;

    const cardData = {
      templateId: templateId,
      side: side,
      playerName: cardWrapper.CardTemplate?.PlayerName,
      insertName: cardWrapper.CardTemplate?.InsertName,
      cardNumber: cardWrapper.CardTemplate?.CardNumber,
      isPhysical: cardWrapper.CardTemplate?.IsPhysical ?? false,
      isTransferable: cardWrapper.CardTemplate?.IsTransferable ?? false,
    };

    map.set(templateId, cardData);
  }

  /**
   * Build a lookup map from card IDs to card data from API.
   * Determines user role (Initiator/Counterparty) and maps cards to 'give'/'get' sides.
   * Includes retry logic for extracting partner username.
   * @param {Object} tradeData - Trade data from API
   * @returns {Promise<Map>} Map of card IDs to card metadata
   */
  async function buildCardLookupMap(tradeData) {
    if (!tradeData) return new Map();

    const map = new Map();

    // Try to get partner username, with retries if needed
    let partnerUsername = getTradePartnerUsername();

    // If username not found, wait a bit for DOM to settle and retry
    if (!partnerUsername) {
      await delay(500);
      partnerUsername = getTradePartnerUsername();

      if (!partnerUsername) {
        // Try one more time after a longer delay
        await delay(1000);
        partnerUsername = getTradePartnerUsername();
      }
    }

    // Determine current user's role by process of elimination
    // If partner matches Initiator, we must be Counterparty (and vice versa)
    const partnerIsInitiator = partnerUsername && tradeData.Initiator?.UserName?.toLowerCase() === partnerUsername.toLowerCase();
    const partnerIsCounterparty = partnerUsername && tradeData.Counterparty?.UserName?.toLowerCase() === partnerUsername.toLowerCase();

    const isInitiator = partnerIsCounterparty; // If partner is counterparty, we are initiator
    const isCounterparty = partnerIsInitiator; // If partner is initiator, we are counterparty

    // In the UI, current user's cards are always on the left (YOU GIVE)
    // and other user's cards are on the right (YOU GET)
    // So we need to map correctly based on the user's role

    // Process InitiatorCards
    if (tradeData.InitiatorCards && Array.isArray(tradeData.InitiatorCards)) {
      // If current user is Initiator, these are YOUR cards (give)
      // If current user is Counterparty, these are OTHER's cards (get)
      const side = isInitiator ? 'give' : 'get';
      tradeData.InitiatorCards.forEach(cardWrapper => addCardToMap(map, cardWrapper, side));
    }

    // Process CounterpartyCards
    if (tradeData.CounterpartyCards && Array.isArray(tradeData.CounterpartyCards)) {
      // If current user is Counterparty, these are YOUR cards (give)
      // If current user is Initiator, these are OTHER's cards (get)
      const side = isCounterparty ? 'give' : 'get';
      tradeData.CounterpartyCards.forEach(cardWrapper => addCardToMap(map, cardWrapper, side));
    }

    return map;
  }

  // ---------- Build COMC search query from ePack tile ----------
  /**
   * Extract card ID (UUID) from DOM element.
   * @param {HTMLElement} cardEl - Card element to extract ID from
   * @returns {string|null} Card template ID or null if not found
   */
  function extractCardIdFromDom(cardEl) {
    // data-card-template attribute should always contain the CardTemplateID
    return cardEl.getAttribute('data-card-template') || null;
  }

  /**
   * Extract card metadata from API data.
   * @param {Object|null} apiCardData - Card data from API
   * @returns {Object|null} Card metadata or null if data unavailable
   */
  function extractCardMeta(apiCardData = null) {
    // Use API data only - no HTML parsing fallback
    if (!apiCardData || !apiCardData.playerName || !apiCardData.insertName || !apiCardData.cardNumber) {
      console.warn(LOG, 'No API data available for card, skipping');
      return null;
    }

    const player = clean(apiCardData.playerName);
    const insertName = clean(apiCardData.insertName);
    const number = clean(apiCardData.cardNumber);
    const isPhysical = apiCardData.isPhysical ?? false;
    const isTransferable = apiCardData.isTransferable ?? false;

    // Build query from API data
    const query = buildQuery({ player, insertName, number });

    return {
      player,
      insertName: insertName,
      number,
      query,
      rawDetails: `${insertName}, ${number}`,
      isPhysical,
      isTransferable,
      cardId: apiCardData.templateId
    };
  }

  /**
   * Extract card metadata from DOM elements as fallback when API data is unavailable.
   * Used in edit/draft mode for newly added cards not yet in the API response.
   * Parses player name from .card-title and insert/number from .details span.
   * @param {HTMLElement} cardEl - Card DOM element (.product-card-display)
   * @returns {Object|null} Card metadata or null if extraction fails
   */
  function extractCardMetaFromDom(cardEl) {
    const titleEl = cardEl.querySelector('.name.card-title') || cardEl.querySelector('.card-title');
    const detailsEl = cardEl.querySelector('.details');

    if (!titleEl || !detailsEl) return null;

    const player = clean(titleEl.textContent);
    const rawDetails = clean(detailsEl.textContent);

    if (!player || !rawDetails) return null;

    // Parse "InsertName, CardNumber" — split on last comma
    const lastCommaIdx = rawDetails.lastIndexOf(',');
    let insertName, number;

    if (lastCommaIdx !== -1) {
      insertName = clean(rawDetails.substring(0, lastCommaIdx));
      number = clean(rawDetails.substring(lastCommaIdx + 1));
    } else {
      insertName = rawDetails;
      number = '';
    }

    // Detect physical status from card-body class
    const cardBody = cardEl.querySelector('.card-body');
    const isPhysical = cardBody ? cardBody.classList.contains('is-physical') : false;

    const query = buildQuery({ player, insertName, number });
    const cardId = extractCardIdFromDom(cardEl);

    return {
      player,
      insertName,
      number,
      query,
      rawDetails,
      isPhysical,
      isTransferable: false, // Cannot determine from DOM, default to false
      cardId
    };
  }

  /**
   * Build COMC search query from card metadata.
   * @param {Object} params - Query parameters
   * @param {string} params.player - Player name
   * @param {string} params.insertName - Insert/set name
   * @param {string} params.number - Card number
   * @returns {string} Formatted search query
   */
  function buildQuery({ player, insertName, number }) {
    // sanitize punctuation COMC tends to ignore
    const sanitize = (s) => String(s || '')
      .replace(/[""]/g, '')     // drop double/typographic quotes only
      .replace(/[\u2018\u2019]/g, "'") // normalize smart single quotes to plain apostrophe
      .replace(/\s+/g, ' ')
      .trim();

    // Clean up set names for better COMC matching
    const cleanSetName = (s) => String(s || '')
      .replace(/\bBase Set\b/gi, 'Base')           // "Base Set" → "Base"
      .replace(/\bUD\s+Series\s+\d+\b/g, 'Upper Deck')  // "UD Series 2" → "Upper Deck"
      .replace(/\bUD\b/g, 'Upper Deck')            // "UD" → "Upper Deck"
      .replace(/\bOutburst Silver\b/g, 'Outburst') // "Outburst Silver" → "Outburst"
      .replace(/\bParallel\b/gi, '')               // Remove "Parallel"
      .replace(/\bTier\s+\d+\b/g, '')              // Remove "Tier 1", "Tier 2", etc.
      .replace(/\bOracles\s*-\s*SSP\b/gi, 'Oracles Rare')  // "Oracles - SSP" → "Oracles rare"
      .replace(/\s+/g, ' ')
      .trim();

    // Clean player name and handle special cases
    const cleanPlayerName = (s) => {
      let cleaned = sanitize(s);
      // Replace "CL" at the end with "Checklist"
      cleaned = cleaned.replace(/\s+CL$/i, ' Checklist');
      return cleaned;
    };

    // Skip card number for certain insert types (e.g., Young Guns Renewed)
    const skipNumber = /Young Guns Renewed/i.test(insertName);

    const parts = [
      cleanPlayerName(player),
      cleanSetName(sanitize(insertName)),
      skipNumber ? '' : String(number || '').replace(/^#/, ''),
    ].filter(Boolean);

    return parts.join(' ').trim();
  }

  // ---------- Cache ----------
  /**
   * Generate cache key for query.
   * @param {string} q - Query string
   * @returns {string} Cache key
   */
  function key(q) { return `comc:${CACHE_VERSION}:${q.toLowerCase()}`; }

  /**
   * Get cached data for query.
   * @param {string} q - Query string
   * @returns {Object|null} Cached data or null if expired/missing
   */
  function getCached(q) {
    try {
      const raw = localStorage.getItem(key(q));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (now() - obj.ts > (obj.ttl || CACHE_TTL_MS)) {
        localStorage.removeItem(key(q));
        return null;
      }
      return obj.data;
    } catch (e) {
      console.warn(LOG, 'Cache read error:', e.message);
      return null;
    }
  }

  /**
   * Store data in cache for query.
   * @param {string} q - Query string
   * @param {Object} data - Data to cache
   */
  function setCached(q, data) {
    try {
      localStorage.setItem(key(q), JSON.stringify({ ts: now(), ttl: CACHE_TTL_MS, data }));
    } catch (e) {
      console.warn(LOG, 'Cache write error:', e.message);
    }
  }

  // ---------- Fee Toggle Preference ----------
  /**
   * Get user preference for including COMC fee in displayed prices.
   * @returns {boolean} True if COMC fee should be included (default: true)
   */
  function getIncludeFee() {
    try {
      const val = localStorage.getItem(PREF_INCLUDE_FEE);
      return val === null ? true : val === 'true';
    } catch { return true; }
  }

  /**
   * Save user preference for including COMC fee in displayed prices.
   * @param {boolean} value - True to include fee, false to exclude
   */
  function setIncludeFee(value) {
    try { localStorage.setItem(PREF_INCLUDE_FEE, String(value)); } catch {}
  }

  /**
   * Adjust a raw COMC price based on the current fee toggle preference.
   * @param {number|null} rawPrice - The original COMC price (includes fee)
   * @returns {number|null} Adjusted price, or null if input is null
   */
  function getDisplayPrice(rawPrice) {
    if (rawPrice == null) return null;
    if (getIncludeFee()) return rawPrice;
    return Math.max(0, rawPrice - COMC_FEE);
  }

  /**
   * Clear all cached COMC data for current version.
   */
  function clearCache() {
    const prefix = `comc:${CACHE_VERSION}:`;
    const keysToRemove = [];

    // Collect all keys first
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) {
        keysToRemove.push(k);
      }
    }

    // Then remove them
    keysToRemove.forEach(k => localStorage.removeItem(k));
  }

  // ---------- COMC fetch ----------
  /**
   * Build COMC search URL with proper encoding.
   * @param {string} query - Search query
   * @returns {string} Formatted COMC search URL
   */
  function comcSearchUrl(query) {
    // COMC uses non-standard URL format: /Cards,={query}
    const base = 'https://www.comc.com/Cards,=';

    // COMC uses custom encoding before standard URL encoding:
    // . (dot) → {46}
    // , (comma) → ~2c
    // Then standard encodeURIComponent handles the rest
    const comcEncoded = query
      .replace(/\./g, '{46}')  // dots become {46}
      .replace(/,/g, '~2c');   // commas become ~2c

    return base + encodeURIComponent(comcEncoded) + ',fb,aUngraded';
  }

  /**
   * Fetch COMC search results HTML.
   * @param {string} query - Search query
   * @returns {Promise<Object>} Promise resolving to response object
   */
  function fetchSearchHtml(query) {
    const url = comcSearchUrl(query);
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (resp) => resolve(resp.status >= 200 && resp.status < 300
          ? { ok: true, html: resp.responseText || '', url }
          : { ok: false, status: resp.status, url }),
        onerror: (e) => resolve({ ok: false, error: e?.error || 'network error', url })
      });
    });
  }

  // ---------- Parse COMC search ----------
  /**
   * Parse COMC search results HTML.
   * @param {string} html - HTML content to parse
   * @returns {Object} Parsed search results with items and counts
   */
  function parseSearch(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const wrappers = [...doc.querySelectorAll('.results .cardInfoWrapper')];

    const nonAuctionItems = [];
    let nonAuctionTotal = 0, auctionTotal = 0, baseCount = 0, nonBaseCount = 0;

    for (const w of wrappers) {
      const dataDiv  = w.querySelector('.carddata');
      const priceDiv = w.querySelector('.listprice');
      if (!dataDiv || !priceDiv) continue;

      const isAuction = priceDiv.classList.contains('auctionItem');
      if (isAuction) { auctionTotal++; continue; }
      nonAuctionTotal++;

      const desc   = clean(dataDiv.querySelector('.description')?.textContent || '');
      const titleA = dataDiv.querySelector('h3.title a');
      const href   = titleA?.getAttribute('href') || '';
      const link   = href ? ('https://www.comc.com' + href) : null;

      let price = null;
      const priceText = (priceDiv.querySelector('a')?.textContent || priceDiv.textContent);
      const m = priceText.match(/\$[\d,]*\.?\d{2}/);
      if (m) price = parseFloat(m[0].replace(/[$,]/g, ''));

      // Extract quantity from search results (e.g., "111 from " in .qty div)
      let quantity = null;
      const qtyDiv = priceDiv.querySelector('.qty');
      if (qtyDiv) {
        const qtyText = qtyDiv.textContent.trim();
        const qtyMatch = qtyText.match(/^(\d+)\s+from/i);
        if (qtyMatch) {
          quantity = parseInt(qtyMatch[1], 10);
        }
      }

      const isBase = /\[\s*Base\s*\](?!\s*-\s*)/i.test(desc) || /\[\s*Base\s*\]\s*#\s*\d+/i.test(desc);

      if (price != null) {
        if (isBase) baseCount++; else nonBaseCount++;
        nonAuctionItems.push({ desc, link, price, isBase, quantity });
      }
    }

    return { nonAuctionItems, counts: { nonAuctionTotal, auctionTotal, baseCount, nonBaseCount } };
  }

  // ---------- Chip UI ----------
  /**
   * Render or update price chip on card element.
   * @param {HTMLElement} cardEl - Card DOM element
   * @param {Object} payload - Chip display data
   * @param {string} payload.text - Display text
   * @param {string} [payload.title] - Tooltip title
   * @param {string|null} [payload.link] - Click URL
   * @param {boolean} [payload.isError] - Error state flag
   * @param {string} [payload.tooltip] - Additional tooltip text
   * @param {boolean|null} [payload.isPhysical] - Physical card indicator
   * @param {boolean|null} [payload.isTransferable] - Transferability flag
   * @param {number|null} [payload.quantity] - Available quantity
   */
  async function renderChip(cardEl, payload) {
    const { text, title = '', link = null, isError = false, tooltip = '', isPhysical = null, isTransferable = null, quantity = null, rawPrice = null } = payload;
    const footer = cardEl.querySelector('.card-footer') || cardEl;
    let chip = footer.querySelector(SELECTORS.PRICE_CHIP);
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'epack-price-chip';
      Object.assign(chip.style, {
        marginTop: '6px', padding: '3px 8px', border: '1px solid #ccc',
        borderRadius: '8px', fontSize: '12px', display: 'block',
        cursor: 'default', userSelect: 'none', whiteSpace: 'nowrap'
      });
      footer.appendChild(chip);
    }

    // Store raw COMC price for fee toggle recalculation
    if (rawPrice != null) {
      chip.dataset.rawPrice = String(rawPrice);
    } else {
      delete chip.dataset.rawPrice;
    }
    if (isPhysical !== null) {
      chip.dataset.isPhysical = String(isPhysical);
    }

    // Build display text — apply fee adjustment when a raw price is available
    let displayText = text;
    if (rawPrice != null) {
      const displayPrice = getDisplayPrice(rawPrice);
      displayText = `COMC: $${displayPrice.toFixed(2)}`;
    }
    if (isPhysical !== null) {
      displayText += isPhysical ? '' : ' 💿';
    }

    chip.textContent = displayText;

    // Build tooltip
    let fullTooltip = '';

    // Add transferability info to tooltip
    if (isPhysical && !isTransferable) {
      fullTooltip += 'Non-Transferable Physical Card\n';
    }
    fullTooltip += (tooltip ? (tooltip + '\n') : '') + title;

    chip.title = fullTooltip;
    chip.style.background = isError ? '#fee' : '';
    chip.style.borderColor = '#ccc';
    chip.style.cursor = link ? 'pointer' : 'default';
    chip.onclick = link ? () => window.open(link, '_blank') : null;

    // update totals whenever a chip changes
    await renderTotals();
  }

  /**
   * Remove all price chips and physical indicators from the page.
   */
  async function clearChips() {
    document.querySelectorAll(`${SELECTORS.CARD} ${SELECTORS.PRICE_CHIP}`).forEach(c => c.remove());
    document.querySelectorAll(SELECTORS.PHYSICAL_INDICATOR).forEach(i => i.remove());
    // Remove digital card styling class
    document.querySelectorAll(SELECTORS.CARD).forEach(card => {
      card.classList.remove('epack-digital-card');
    });
    await renderTotals(); // reset totals display immediately
  }

  /**
   * Recalculate all displayed chip prices based on the current fee toggle,
   * then update totals. Called when the user toggles the COMC fee preference.
   */
  async function refreshAllPrices() {
    document.querySelectorAll(SELECTORS.PRICE_CHIP).forEach(chip => {
      if (!chip.dataset.rawPrice) return;
      const rawPrice = parseFloat(chip.dataset.rawPrice);
      if (isNaN(rawPrice)) return;

      const displayPrice = getDisplayPrice(rawPrice);
      let text = `COMC: $${displayPrice.toFixed(2)}`;
      if (chip.dataset.isPhysical === 'false') text += ' 💿';
      chip.textContent = text;
    });
    await renderTotals();
  }

  /**
   * Add physical card indicators to all physical cards in the trade.
   */
  async function addPhysicalIndicators() {
    try {
      const tradeData = await getTradeData();
      if (!tradeData) {
        return;
      }

      const cardLookupMap = await buildCardLookupMap(tradeData);
      const cards = document.querySelectorAll(SELECTORS.CARD);

      if (cards.length === 0) {
        return;
      }

      let addedCount = 0;

      cards.forEach(card => {
        try {
          const domCardId = extractCardIdFromDom(card);
          if (!domCardId) return;

          const apiCardData = cardLookupMap.get(domCardId);
          let isPhysical = apiCardData?.isPhysical ?? false;
          let isTransferable = apiCardData?.isTransferable ?? false;

          // Fallback: check DOM for physical status in edit mode
          if (!apiCardData && isInEditMode()) {
            const cardBody = card.querySelector('.card-body');
            isPhysical = cardBody ? cardBody.classList.contains('is-physical') : false;
          }

          if (!isPhysical) return;

          // Find side-btn-items container
          const sideBtnItems = card.querySelector(SELECTORS.SIDE_BTN_ITEMS);
          if (!sideBtnItems) return;

          // Check if indicator already exists
          if (sideBtnItems.querySelector(SELECTORS.PHYSICAL_INDICATOR)) return;

          // Create physical indicator div (matching structure of other side buttons)
          const div = document.createElement('div');
          div.className = 'side-btn tooltip-right epack-physical-indicator';

          // Set tooltip based on transferability
          const tooltipText = isTransferable ? 'Physical Card' : 'Physical Card (NT)';
          div.setAttribute('data-tooltip', tooltipText);

          const icon = document.createElement('i');
          icon.className = 'ud ud-transfer';
          icon.style.opacity = '0.7';
          icon.style.color = isTransferable ? '#1d4fd3' : '#f89e2e';

          div.appendChild(icon);

          // Insert at the beginning of side-btn-items
          sideBtnItems.insertBefore(div, sideBtnItems.firstChild);
          addedCount++;
        } catch (e) {
          console.warn(LOG, 'Failed to add indicator for card:', e);
        }
      });

    } catch (e) {
      console.error(LOG, 'Failed to add indicators:', e);
    }
  }

  /**
   * Apply opacity styling to digital cards using CSS class.
   */
  async function applyDigitalCardStyling() {
    // Skip if feature is disabled
    if (!FADE_DIGITAL) return;

    try {
      // Inject CSS for digital cards (only once)
      if (!document.getElementById('epack-digital-card-style')) {
        const style = document.createElement('style');
        style.id = 'epack-digital-card-style';
        style.textContent = `
          .epack-digital-card {
            opacity: ${FADE_OPACITY} !important;
            transition: opacity 0.2s ease !important;
          }
          .epack-digital-card:hover {
            opacity: 1 !important;
          }
        `;
        document.head.appendChild(style);
      }

      const tradeData = await getTradeData();
      if (!tradeData) {
        return;
      }

      const cardLookupMap = await buildCardLookupMap(tradeData);
      const cards = document.querySelectorAll(SELECTORS.CARD);

      if (cards.length === 0) {
        return;
      }

      cards.forEach(card => {
        try {
          const domCardId = extractCardIdFromDom(card);
          if (!domCardId) return;

          const apiCardData = cardLookupMap.get(domCardId);
          let isPhysical;

          if (apiCardData) {
            isPhysical = apiCardData.isPhysical;
          } else if (isInEditMode()) {
            // Fallback: check DOM for physical status
            const cardBody = card.querySelector('.card-body');
            isPhysical = cardBody ? cardBody.classList.contains('is-physical') : null;
          } else {
            return;
          }

          // Add CSS class for digital cards
          if (isPhysical === false) {
            card.classList.add('epack-digital-card');
          } else {
            card.classList.remove('epack-digital-card');
          }
        } catch (e) {
          console.warn(LOG, 'Failed to apply styling for card:', e);
        }
      });

    } catch (e) {
      console.error(LOG, 'Failed to apply digital card styling:', e);
    }
  }

  // ---------- Totals helpers (YOU GET / YOU GIVE) ----------
  /**
   * Find and return the "You Get" and "You Give" container elements.
   * @returns {Object} Object with getEl and giveEl properties
   */
  function findSideContainers() {
    // Primary: order-based selection (stable on ePack)
    const sides = document.querySelectorAll(SELECTORS.TRADE_SIDES);
    if (sides.length >= 2) {
      // You get is first; You give is second
      return { getEl: sides[0], giveEl: sides[1] };
    }

    // Fallback to text-heuristic if layout differs (rare)
    const root = document.querySelector('.trade-detail.row');
    if (!root) return { getEl: null, giveEl: null };

    const leaves = [...root.querySelectorAll('*')].filter(el => el.childElementCount === 0 || /^H\d$/i.test(el.tagName));
    let getHdr = null, giveHdr = null;
    for (const el of leaves) {
      const txt = (el.textContent || '').trim().toUpperCase();
      if (!getHdr && /\bYOU\s+GET\b/.test(txt)) getHdr = el;
      if (!giveHdr && /\bYOU\s+GIVE\b/.test(txt)) giveHdr = el;
      if (getHdr && giveHdr) break;
    }
    const pickCol = (el) => el ? (el.closest('.trade-side.col-sm-6') || el.closest('[class*="col-"]') || el.closest('.row') || el.parentElement) : null;
    return { getEl: pickCol(getHdr), giveEl: pickCol(giveHdr) };
  }

  /**
   * Parse price value from chip element.
   * @param {HTMLElement|null} chipEl - Chip element containing price
   * @returns {number|null} Parsed price or null
   */
  function parseChipPrice(chipEl) {
    if (!chipEl) return null;
    const m = chipEl.textContent.match(/\$([\d,]*\.?\d{2})/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }

  /**
   * Compute totals for one side of the trade.
   * @param {HTMLElement|null} containerEl - Container element for one side
   * @returns {Promise<Object>} Totals object with sum, qty, missing, digital, total
   */
  async function computeSideTotals(containerEl) {
    if (!containerEl) return { sum: 0, qty: 0, missing: 0, digital: 0, total: 0 };

    // Get API data to check if cards are digital
    const tradeData = await getTradeData();
    const cardLookupMap = tradeData ? await buildCardLookupMap(tradeData) : new Map();

    // Each visible card tile == 1 unit
    const cards = [...containerEl.querySelectorAll(SELECTORS.CARD)];

    const editMode = isInEditMode();
    let sum = 0;
    let priced = 0;
    let digital = 0;

    for (const card of cards) {
      const chip  = card.querySelector(SELECTORS.PRICE_CHIP);
      const price = parseChipPrice(chip); // returns number or null

      // Check if card is digital
      const domCardId = extractCardIdFromDom(card);
      const apiCardData = domCardId ? cardLookupMap.get(domCardId) : null;
      let isDigital = false;

      if (apiCardData) {
        isDigital = apiCardData.isPhysical === false;
      } else if (editMode) {
        // Fallback: check DOM for physical status
        const cardBody = card.querySelector('.card-body');
        isDigital = cardBody ? !cardBody.classList.contains('is-physical') : false;
      }

      if (isDigital) {
        digital += 1;
      } else if (price != null) {
        sum += price;    // 1 per tile (no multipliers)
        priced += 1;
      }
    }

    const total = cards.length;
    const missing = total - priced - digital; // Don't count digital as missing

    return { sum, qty: priced, missing, digital, total };
  }

  /**
   * Ensure totals display row exists in DOM.
   * @returns {HTMLElement|null} Totals row element or null
   */
  function ensureTotalsRow() {
    const anchor = document.getElementById(ANCHOR_ID);
    if (!anchor) return null;

    let row = document.getElementById(TOTALS_ID);
    if (!row) {
      row = document.createElement('div');
      row.id = TOTALS_ID;
      Object.assign(row.style, {
        marginTop: '12px',
        padding: '10px 16px',
        background: '#f8f9fa',
        border: '1px solid #dee2e6',
        borderRadius: '6px',
        fontSize: '14px',
        display: 'flex',
        gap: '32px',
        alignItems: 'center',
        flexWrap: 'wrap',
        fontWeight: '500'
      });
      anchor.appendChild(row);
    }
    return row;
  }

  /**
   * Render or update totals display for both sides of trade.
   */
  async function renderTotals() {
    const row = ensureTotalsRow();
    if (!row) return;

    const { getEl, giveEl } = findSideContainers();
    const getTotals  = await computeSideTotals(getEl);   // { sum, qty, missing, digital, total }
    const giveTotals = await computeSideTotals(giveEl);  // { sum, qty, missing, digital, total }

    row.textContent = '';
    const mk = (label, t) => {
      const span = document.createElement('span');
      span.style.fontWeight = '600';
      // Build the text parts
      let text = `${label}: $${t.sum.toFixed(2)} (priced: ${t.qty}/${t.total}`;
      if (t.digital > 0) {
        text += `, digital: ${t.digital}`;
      }
      if (t.missing > 0) {
        text += `, missing: ${t.missing}`;
      }
      text += ')';
      span.textContent = text;
      return span;
    };

    row.appendChild(mk('You get total', getTotals));
    row.appendChild(mk('You give total', giveTotals));
  }

  // ---------- Fetch flow (manual trigger) ----------
  /**
   * Main workflow to fetch and display COMC prices for all cards.
   * @param {Function} [setStatus] - Optional callback to update status text
   */
  async function runFetchFlow(setStatus) {
    const cards = [...document.querySelectorAll(SELECTORS.CARD)];
    if (!cards.length) { setStatus?.('No cards'); return; }

    // Reset abort flag
    state.shouldAbort = false;
    state.isFetching = true;

    try {
      // Load trade API data first
      setStatus?.('Loading trade data...');
      const tradeData = await getTradeData();
      const cardLookupMap = await buildCardLookupMap(tradeData);
      const editMode = isInEditMode();

      let idx = 0;
      for (const card of cards) {
        // Check abort flag
        if (state.shouldAbort) {
          setStatus?.('Aborted');
          await delay(DELAY_MS);
          setStatus?.('');
          return;
        }

        const domCardId = extractCardIdFromDom(card);
        const apiCardData = domCardId ? cardLookupMap.get(domCardId) : null;

        let meta = extractCardMeta(apiCardData);
        if (!meta || !meta.query) {
          // Fallback: extract from DOM when in edit/draft mode (newly added cards)
          if (editMode) {
            meta = extractCardMetaFromDom(card);
            if (!meta || !meta.query) {
              continue;
            }
          } else {
            continue;
          }
        }

        setStatus?.(`(${++idx}/${cards.length}) ${meta.player}…`);

        // Skip COMC query for digital-only cards (no value on COMC)
        if (meta.isPhysical === false) {
          await renderChip(card, {
            text: 'COMC: N/A (Digital)',
            title: 'Digital-only card - no physical value available',
            isPhysical: meta.isPhysical
          });
          await delay(DELAY_MS);
          continue;
        }

        await renderChip(card, { text: 'COMC: …', title: `Fetching for: ${meta.query}`, isPhysical: meta.isPhysical });

        // cache
        const cached = getCached(meta.query);
        if (cached) {
          const priceTxt = cached.price != null ? `COMC: $${cached.price.toFixed(2)}` : 'COMC: —';
          await renderChip(card, {
            text: priceTxt,
            title: cached.link || 'COMC search',
            link: cached.link || null,
            tooltip: cached.tooltip || '',
            isPhysical: meta.isPhysical,
            isTransferable: meta.isTransferable,
            quantity: cached.quantity ?? null,
            rawPrice: cached.price
          });
          await delay(DELAY_MS);
          continue;
        }

        // Fetch search results
        const resp = await fetchSearchHtml(meta.query);
        if (!resp.ok) {
          await renderChip(card, { text: 'COMC: n/a', title: resp.error || ('HTTP ' + resp.status), isError: true, isPhysical: meta.isPhysical });
          console.warn(LOG, 'Fetch failed:', meta.query, resp);
          await delay(DELAY_MS);
          continue;
        }

        const parsed = parseSearch(resp.html);
        const { nonAuctionItems, counts } = parsed;

        let cheapest = null;
        if (nonAuctionItems.length) cheapest = nonAuctionItems.slice().sort((a,b) => a.price - b.price)[0];

        if (!cheapest) {
          const searchLink = comcSearchUrl(meta.query);
          const tooltip = `Search results: ${counts.nonAuctionTotal} listings`;
          setCached(meta.query, { price: null, link: searchLink, tooltip, quantity: null });
          await renderChip(card, { text: 'COMC: —', title: searchLink, link: searchLink, tooltip, isPhysical: meta.isPhysical, isTransferable: meta.isTransferable, quantity: null });
          await delay(REQ_DELAY_MS + Math.random() * REQ_DELAY_RANDOM);
          continue;
        }

        // Build result from search data only (no item page fetch needed)
        const pickedLink = cheapest.link || comcSearchUrl(meta.query);
        const tooltip = cheapest.quantity != null
          ? `${cheapest.quantity} available on COMC`
          : `Search results: ${counts.nonAuctionTotal} listings`;

        const final = {
          price: cheapest.price,
          link: pickedLink,
          quantity: cheapest.quantity ?? null,
          tooltip: tooltip
        };

        setCached(meta.query, final);

        await renderChip(card, {
          text: `COMC: $${final.price.toFixed(2)}`,
          title: pickedLink,
          link: pickedLink,
          tooltip: tooltip,
          isPhysical: meta.isPhysical,
          isTransferable: meta.isTransferable,
          quantity: final.quantity ?? null,
          rawPrice: final.price
        });

        await delay(REQ_DELAY_MS + Math.random() * REQ_DELAY_RANDOM);
      }

      setStatus?.('Done'); await delay(DELAY_MS); setStatus?.('');
      await renderTotals();
    } finally {
      state.isFetching = false;
    }
  }

  // ---------- Toolbar UI ----------
  /**
   * Get consistent button styling.
   * @returns {Object} Style object for buttons
   */
  function buttonStyle() {
    return {
      padding: '8px 16px',
      fontSize: '13px',
      borderRadius: '6px',
      border: '1px solid #007bff',
      background: '#007bff',
      color: 'white',
      cursor: 'pointer',
      fontWeight: '500',
      transition: 'all 0.2s'
    };
  }

  /**
   * Build toolbar UI with control buttons.
   * @returns {HTMLElement} Toolbar element
   */
  function buildToolbar() {
    const wrapper = document.createElement('div');
    wrapper.id = TOOLBAR_ID;
    Object.assign(wrapper.style, {
      display: 'flex',
      gap: '12px',
      alignItems: 'center',
      justifyContent: 'flex-start',
      width: '100%'
    });

    const fetchBtn   = document.createElement('button');
    const refreshBtn = document.createElement('button');
    const abortBtn   = document.createElement('button');
    const status     = document.createElement('span');

    fetchBtn.textContent = 'Fetch COMC Prices';
    refreshBtn.textContent = 'Refresh Prices';
    abortBtn.textContent = 'Abort';
    abortBtn.style.display = 'none'; // Hidden by default

    Object.assign(fetchBtn.style, buttonStyle());
    Object.assign(refreshBtn.style, {
      ...buttonStyle(),
      background: '#6c757d',
      borderColor: '#6c757d'
    });
    Object.assign(abortBtn.style, {
      ...buttonStyle(),
      background: '#dc3545',
      borderColor: '#dc3545'
    });
    Object.assign(status.style, {
      fontSize: '13px',
      color: '#555',
      fontWeight: '500',
      marginLeft: '8px'
    });

    // Fee toggle — reuses ePack's native .onoffswitch styling (persisted in localStorage)
    const feeToggleWrap = document.createElement('div');
    Object.assign(feeToggleWrap.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      marginLeft: 'auto',
      textAlign: 'right',
      fontWeight: '600',
      fontSize: '14px'
    });

    const feeLabelText = document.createElement('span');
    feeLabelText.textContent = `Incl. COMC fee ($${COMC_FEE.toFixed(2)}/card)`;

    const onoffDiv = document.createElement('div');
    onoffDiv.className = 'onoffswitch';
    onoffDiv.style.lineHeight = '1.5';
    onoffDiv.style.top = '3px';

    const onoffLabel = document.createElement('label');
    onoffLabel.className = 'onoffswitch-label';

    const feeCheckbox = document.createElement('input');
    feeCheckbox.type = 'checkbox';
    feeCheckbox.className = 'onoffswitch-checkbox';
    feeCheckbox.checked = getIncludeFee();

    const innerSpan = document.createElement('span');
    innerSpan.className = 'onoffswitch-inner';

    const switchSpan = document.createElement('span');
    switchSpan.className = 'onoffswitch-switch';

    onoffLabel.append(feeCheckbox, innerSpan, switchSpan);
    onoffDiv.appendChild(onoffLabel);

    feeToggleWrap.append(feeLabelText, onoffDiv);

    feeCheckbox.onchange = () => {
      setIncludeFee(feeCheckbox.checked);
      refreshAllPrices();
    };

    wrapper.append(fetchBtn, refreshBtn, abortBtn, status, feeToggleWrap);

    // Button hover effects
    [fetchBtn, refreshBtn, abortBtn].forEach(btn => {
      btn.onmouseenter = () => { btn.style.opacity = '0.9'; btn.style.transform = 'translateY(-1px)'; };
      btn.onmouseleave = () => { btn.style.opacity = '1'; btn.style.transform = 'translateY(0)'; };
    });

    fetchBtn.onclick = async () => {
      fetchBtn.disabled = true; refreshBtn.disabled = true;
      fetchBtn.style.opacity = '0.6'; refreshBtn.style.opacity = '0.6';
      abortBtn.style.display = 'inline-block'; // Show abort button
      status.textContent = 'Fetching…';
      try { await runFetchFlow(msg => status.textContent = msg); }
      finally {
        fetchBtn.disabled = false; refreshBtn.disabled = false;
        fetchBtn.style.opacity = '1'; refreshBtn.style.opacity = '1';
        abortBtn.style.display = 'none'; // Hide abort button
        status.textContent = '';
      }
    };

    refreshBtn.onclick = async () => {
      fetchBtn.disabled = true; refreshBtn.disabled = true;
      fetchBtn.style.opacity = '0.6'; refreshBtn.style.opacity = '0.6';
      abortBtn.style.display = 'inline-block'; // Show abort button
      status.textContent = 'Refreshing…';
      try {
        await clearChips();
        clearCache();
        state.cachedTradeData = null; // Clear cached API data
        state.partnerInfoInjected = false; // Allow re-injection of partner info
        await runFetchFlow(msg => status.textContent = msg);
        // Re-inject trade partner info after refresh
        const tradeData = await getTradeData();
        if (tradeData) {
          injectTradePartnerInfo(tradeData);
          state.partnerInfoInjected = true;
        }
        // Re-add physical indicators after refresh
        await addPhysicalIndicators();
        // Apply digital card styling
        await applyDigitalCardStyling();
      }
      finally {
        fetchBtn.disabled = false; refreshBtn.disabled = false;
        fetchBtn.style.opacity = '1'; refreshBtn.style.opacity = '1';
        abortBtn.style.display = 'none'; // Hide abort button
        status.textContent = '';
      }
    };

    abortBtn.onclick = () => {
      state.shouldAbort = true;
      status.textContent = 'Aborting…';
      abortBtn.disabled = true;
    };

    return wrapper;
  }

  /**
   * Mount toolbar UI under the trade detail header.
   * @returns {boolean} True if successfully mounted
   */
  function mountToolbarUnderTradeDetail() {
    const header = document.querySelector(SELECTORS.TRADE_HEADER);
    if (!header) {
      return false;
    }

    // Reduce spacing below header
    header.style.marginBottom = '16px';

    let anchor = document.getElementById(ANCHOR_ID);
    if (!anchor) {
      anchor = document.createElement('div');
      anchor.id = ANCHOR_ID;
      Object.assign(anchor.style, {
        marginTop: '0px',
        marginBottom: '12px',
        padding: '12px 15px',
        background: 'white',
        boxShadow: '0 1px 5px 0 rgba(0, 0, 0, .1)'
      });
      // place AFTER the header (as next sibling)
      header.insertAdjacentElement('afterend', anchor);
    }

    if (!anchor.querySelector(SELECTORS.TOOLBAR)) {
      anchor.appendChild(buildToolbar());
    }
    // ensure totals row exists (empty until we compute)
    ensureTotalsRow();
    return true;
  }

  // ---------- Trade Partner Info ----------
  /**
   * Inject trade partner's last login date and rating into the UI.
   * @param {Object} tradeData - Trade data from API
   * @returns {boolean} True if info was successfully injected
   */
  function injectTradePartnerInfo(tradeData) {
    if (!tradeData) {
      return false;
    }

    const container = document.querySelector(SELECTORS.PARTNER_CONTAINER);
    if (!container) {
      return false;
    }

    // Get trade partner's username from the visible element
    const partnerUsername = getTradePartnerUsername();
    if (!partnerUsername) {
      return false;
    }

    // Determine current user's role by process of elimination
    const partnerIsInitiator = tradeData.Initiator?.UserName?.toLowerCase() === partnerUsername.toLowerCase();
    const partnerIsCounterparty = tradeData.Counterparty?.UserName?.toLowerCase() === partnerUsername.toLowerCase();

    // Get trade partner's data
    let partnerLastLogin = null;
    let ratingTheyGave = 0; // Rating the partner gave to us

    if (partnerIsInitiator) {
      // Partner is initiator, we are counterparty
      partnerLastLogin = tradeData.Initiator?.LastLoginDate;
      ratingTheyGave = tradeData.InitiatorRating; // Rating the initiator (partner) gave
    } else if (partnerIsCounterparty) {
      // Partner is counterparty, we are initiator
      partnerLastLogin = tradeData.Counterparty?.LastLoginDate;
      ratingTheyGave = tradeData.CounterpartyRating; // Rating the counterparty (partner) gave
    }

    // Remove any existing injected info to avoid duplicates
    const existingInfo = container.querySelector(SELECTORS.PARTNER_INFO);
    if (existingInfo) existingInfo.remove();

    // Create info container
    const infoDiv = document.createElement('div');
    infoDiv.className = 'epack-partner-info';
    Object.assign(infoDiv.style, {
      display: 'inline-flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      justifyContent: 'flex-start',
      gap: '2px',
      marginLeft: '16px',
      fontSize: '12px',
      color: '#666'
    });

    // Add last login info
    if (partnerLastLogin) {
      const loginSpan = document.createElement('div');
      loginSpan.textContent = `Last seen: ${formatRelativeTime(partnerLastLogin)}`;
      infoDiv.appendChild(loginSpan);
    }

    // Add rating info (if they rated us)
    if (ratingTheyGave > 0) {
      const ratingSpan = document.createElement('div');
      const stars = formatRatingStars(ratingTheyGave);
      ratingSpan.innerHTML = `Rated you: <span style="color: #f39c12; font-size: 14px;">${stars}</span> <span style="color: #999;">(${ratingTheyGave}/5)</span>`;
      infoDiv.appendChild(ratingSpan);
    }

    // Only append if we have content
    if (infoDiv.children.length > 0) {
      container.appendChild(infoDiv);
      return true;
    }

    return false;
  }

  // ---------- DOM Monitoring ----------
  /**
   * Ensure partner info is present in the DOM, re-injecting if removed.
   * Called regularly by polling and MutationObserver to handle React re-renders.
   */
  async function ensurePartnerInfo() {
    if (state.isCheckingPartnerInfo) return;
    state.isCheckingPartnerInfo = true;

    try {
      const partnerInfoExists = document.querySelector(SELECTORS.PARTNER_INFO);
      const container = document.querySelector(SELECTORS.PARTNER_CONTAINER);

      if (!partnerInfoExists && container) {
        const wasInjected = state.partnerInfoInjected;

        try {
          if (!state.cachedTradeData) {
            state.cachedTradeData = await getTradeData();
          }

          if (state.cachedTradeData) {
            const injected = injectTradePartnerInfo(state.cachedTradeData);
            if (injected) {
              state.partnerInfoInjected = true;
            }
          }
        } catch (e) {
          console.warn(LOG, 'Failed to inject info:', e);
        }
      } else if (partnerInfoExists && !state.partnerInfoInjected) {
        state.partnerInfoInjected = true;
      }
    } finally {
      state.isCheckingPartnerInfo = false;
    }
  }

  /**
   * Check if toolbar exists and mount if needed.
   * Also ensures partner info is injected and maintained.
   */
  async function checkAndMountToolbar() {
    // Prevent concurrent execution
    if (state.isCheckingToolbar) return;
    state.isCheckingToolbar = true;

    try {
      // Verify toolbar still exists in DOM
      const anchor = document.getElementById(ANCHOR_ID);
      const toolbar = document.querySelector(SELECTORS.TOOLBAR);

      if (!anchor || !toolbar) {
        // Toolbar was removed or never mounted
        if (state.toolbarMounted) {
          state.toolbarMounted = false;
          state.partnerInfoInjected = false;
          state.cachedTradeData = null;
        }

        const mounted = mountToolbarUnderTradeDetail();
        if (mounted) {
          state.toolbarMounted = true;

          // Wait a bit for DOM to settle before adding enhancements
          await delay(300);

          // Add physical card indicators first
          try {
            await addPhysicalIndicators();
          } catch (e) {
            console.warn(LOG, 'Failed to add indicators:', e);
          }

          // Apply digital card styling
          try {
            await applyDigitalCardStyling();
          } catch (e) {
            console.warn(LOG, 'Failed to apply digital card styling:', e);
          }

          // Render totals (this may trigger React re-render)
          try {
            await renderTotals();
          } catch (e) {
            console.warn(LOG, 'Failed to render totals:', e);
          }

          // Inject trade partner info AFTER totals (to avoid being removed by React)
          await delay(500); // Extra delay for React to settle
          await ensurePartnerInfo();
        }
      } else {
        // Toolbar exists
        if (!state.toolbarMounted) {
          state.toolbarMounted = true;
        }

        // Always check and ensure partner info is present
        await ensurePartnerInfo();
      }
    } finally {
      state.isCheckingToolbar = false;
    }
  }

  /**
   * Setup MutationObserver to detect DOM changes and maintain UI elements.
   * Monitors toolbar presence and partner info injection.
   */
  function setupMutationObserver() {
    const observer = new MutationObserver(() => {
      if (state.isCheckingToolbar) return; // Prevent concurrent checks

      const hasHeader = document.querySelector(SELECTORS.TRADE_HEADER);
      const anchor = document.getElementById(ANCHOR_ID);
      const toolbar = document.querySelector(SELECTORS.TOOLBAR);

      // Case 1: Header exists but toolbar is missing (mount or remount needed)
      if (hasHeader && (!anchor || !toolbar)) {
        checkAndMountToolbar();
        return;
      }

      // Case 2: Check if partner info was removed (React re-render) and immediately re-inject
      if (state.toolbarMounted && anchor && toolbar) {
        const partnerInfoExists = document.querySelector(SELECTORS.PARTNER_INFO);
        const container = document.querySelector(SELECTORS.PARTNER_CONTAINER);
        if (!partnerInfoExists && container && !state.isCheckingPartnerInfo) {
          ensurePartnerInfo();
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Store observer for cleanup
    state.mutationObserver = observer;
  }

  /**
   * Cleanup function to disconnect observers and intervals.
   * Called on page unload.
   */
  function cleanup() {
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
      state.mutationObserver = null;
    }
    if (state.pollingInterval) {
      clearInterval(state.pollingInterval);
      state.pollingInterval = null;
    }
  }

  /**
   * Initialize the userscript.
   * Sets up observers, mounts toolbar, and starts monitoring.
   */
  function initialize() {
    // Setup MutationObserver for dynamic page changes
    setupMutationObserver();

    // Initial mount attempt - wait for React to settle
    setTimeout(() => checkAndMountToolbar(), 500);

    // Polling every 2 seconds as backup (MutationObserver handles most cases)
    state.pollingInterval = setInterval(() => {
      if (!state.isCheckingToolbar) {
        checkAndMountToolbar();
      }
    }, TOOLBAR_CHECK_MS);

    // Cleanup on page unload
    window.addEventListener('beforeunload', cleanup);
  }

  // Initialize immediately - @run-at document-idle ensures DOM is ready
  initialize();

})();
