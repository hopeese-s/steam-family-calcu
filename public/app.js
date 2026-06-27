/* ────────────────────────────────────────────────
   Steam Family Dashboard — App Logic
   ──────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── State ─────────────────────────────────────
  let games      = [];        // All aggregated game objects
  let users      = {};        // steamid → player summary
  let prices     = {};        // appid  → steam price_overview
  let deals      = {};        // appid  → cheapest historic price (string, USD)
  let currency   = 'THB';
  let currentCurrencyCode = 'th';
  let activeFilter = 'all';   // all | unique | duplicates
  let advancedFilter = 'all'; // all | free | gems
  let activeOwner  = null;    // steamid or null
  let searchTerm   = '';
  let sortMode     = 'price-desc';

  let totalCurrentCents = 0;  // Sum of initial prices (cents)
  let totalHistoricUSD  = 0;  // Sum of historic lows (USD float)

  // ── DOM refs ──────────────────────────────────
  const setupView    = document.getElementById('setup-view');
  const libraryView  = document.getElementById('library-view');
  const gamesGrid    = document.getElementById('games-grid');
  const fetchBtn     = document.getElementById('fetch-btn');
  const btnText      = document.getElementById('btn-text');
  const btnLoader    = document.getElementById('btn-loader');
  const searchInput  = document.getElementById('search-input');
  const currencySelect = document.getElementById('currency-select');
  const sortSelect   = document.getElementById('sort-select');
  const filterSelect = document.getElementById('filter-select');
  const loadingMore  = document.getElementById('loading-more');

  // Sidebar stats & toggles
  const elStatValue    = document.getElementById('stat-value');
  const elStatHistoric = document.getElementById('stat-historic');
  const elStatTotal    = document.getElementById('stat-total');
  const elCountAll     = document.getElementById('count-all');
  const elCountUnique  = document.getElementById('count-unique');
  const elCountDup     = document.getElementById('count-duplicates');
  
  const toggleHistoric = document.getElementById('toggle-historic');
  const toggleTags     = document.getElementById('toggle-tags');
  let allowHistoricFetch = false;
  let allowTagsFetch     = false;

  const modalOverlay = document.getElementById('modal-overlay');

  // ── Build member input grid ────────────────────
  const memberLabels = ['You', 'Member 2', 'Member 3', 'Member 4', 'Member 5', 'Member 6'];
  const inputsGrid   = document.getElementById('member-inputs');
  
  let savedMembers = [];
  try {
      savedMembers = JSON.parse(localStorage.getItem('steamFamilyMembers')) || [];
  } catch (e) { /* ignore */ }

  memberLabels.forEach((label, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'member-input-group';
    const savedVal = savedMembers[i] || '';
    wrap.innerHTML = `
      <label class="member-input-label" for="m${i}">${label}</label>
      <input id="m${i}" class="member-input" type="text" value="${savedVal}" placeholder="username, ID, or URL" autocomplete="off" spellcheck="false">
    `;
    inputsGrid.appendChild(wrap);
  });

  // Auto-strip Steam profile URLs on paste/input
  document.querySelectorAll('.member-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const v = e.target.value.trim();
      if (v.includes('steamcommunity.com')) {
        const parts = v.split('/').filter(Boolean);
        if (v.includes('/id/')) {
          e.target.value = parts[parts.indexOf('id') + 1] || v;
        } else if (v.includes('/profiles/')) {
          e.target.value = parts[parts.indexOf('profiles') + 1] || v;
        }
      }
    });
  });

  // ── Main Fetch Flow ────────────────────────────
  fetchBtn.addEventListener('click', async () => {
    const rawInputsInputs = Array.from(document.querySelectorAll('.member-input')).map(i => i.value.trim());
    const rawInputs = rawInputsInputs.filter(Boolean);

    if (!rawInputs.length) { alert('Enter at least one Steam username, ID, or profile URL.'); return; }
    
    // Save to local storage
    try {
        localStorage.setItem('steamFamilyMembers', JSON.stringify(rawInputsInputs));
    } catch (e) { /* ignore */ }

    setLoading(true, 'Resolving profiles…');

    try {
      // 1. Resolve every input to a 64-bit SteamID
      const steamIds = await resolveAllInputs(rawInputs);
      if (!steamIds.length) { alert('Could not resolve any profiles. Check your inputs.'); return; }

      setLoading(true, 'Fetching profiles…');
      const idsParam = steamIds.join(',');

      // 2. User summaries
      const usersRes  = await fetch(`/api/users?steamids=${idsParam}`);
      const usersData = await usersRes.json();
      users = {};
      usersData.forEach(u => (users[u.steamid] = u));

      // 3. Owned games
      setLoading(true, 'Analyzing libraries…');
      const gamesRes  = await fetch(`/api/games?steamids=${idsParam}`);
      games = await gamesRes.json();

      // 4. Current prices
      setLoading(true, 'Calculating value…');
      const pricesRes = await fetch('/api/prices', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ appids: games.map(g => g.appid), cc: currentCurrencyCode })
      });
      prices = await pricesRes.json();

      // Detect currency
      for (const k in prices) {
        if (prices[k]?.currency) { currency = prices[k].currency; break; }
      }

      // Calculate totals — sum unique game prices only (not multiplied by owner count)
      totalCurrentCents = 0;
      games.forEach(g => {
        if (prices[g.appid]) totalCurrentCents += prices[g.appid].initial;
      });

      // Render
      switchToLibrary();
      updateSidebar();
      renderGames();

      // 5. Historic lows (async, non-blocking)
      fetchHistoricLowsInBackground();

    } catch (err) {
      console.error(err);
      alert('Something went wrong. Check console for details.');
    } finally {
      setLoading(false, 'Analyze Library');
    }
  });
  
  // ── Input Listeners ────────────────────────────
  searchInput.addEventListener('input', e => {
      searchTerm = e.target.value.trim();
      renderGames();
  });

  sortSelect.addEventListener('change', e => {
      sortMode = e.target.value;
      renderGames();
  });

  if (filterSelect) {
      filterSelect.addEventListener('change', e => {
          advancedFilter = e.target.value;
          renderGames();
      });
  }

  toggleHistoric.addEventListener('change', e => {
      allowHistoricFetch = e.target.checked;
      if (allowHistoricFetch) fetchHistoricLowsInBackground();
  });

  toggleTags.addEventListener('change', e => {
      allowTagsFetch = e.target.checked;
      if (allowTagsFetch) fetchTagsInBackground();
  });

  // Share Link
  const btnShare = document.getElementById('btn-share-link');
  if (btnShare) {
      btnShare.addEventListener('click', () => {
          const steamIds = Object.keys(users).join(',');
          if (!steamIds) return alert('Analyze a library first!');
          const url = new URL(window.location.href);
          url.searchParams.set('users', steamIds);
          navigator.clipboard.writeText(url.toString());
          btnShare.textContent = '✅ Copied!';
          setTimeout(() => btnShare.textContent = '🔗 Copy Share Link', 2000);
      });
  }

  // ── Resolve inputs ─────────────────────────────
  async function resolveAllInputs(rawInputs) {
    const ids = [];
    for (const raw of rawInputs) {
      let parsed = raw;
      if (raw.includes('steamcommunity.com')) {
        const parts = raw.split('/').filter(Boolean);
        parsed = raw.includes('/id/')
          ? (parts[parts.indexOf('id') + 1] ?? raw)
          : (parts[parts.indexOf('profiles') + 1] ?? raw);
      }
      if (/^7656\d{13}$/.test(parsed)) {
        ids.push(parsed);
      } else {
        try {
          const r = await fetch(`/api/resolve?vanityurl=${encodeURIComponent(parsed)}`);
          if (r.ok) { const d = await r.json(); if (d.steamid) ids.push(d.steamid); }
        } catch (_) { /* ignore */ }
      }
    }
    return ids;
  }

  // ── Historic lows fetcher ──────────────────────
  // Fetch sequentially with 1 second delay to bypass strict Rate Limits
  async function fetchHistoricLowsInBackground() {
    if (!allowHistoricFetch) return;
    loadingMore.style.display = 'flex';
    loadingMore.querySelector('span').textContent = 'Fetching historic prices…';
    totalHistoricUSD = 0;
    
    for (const game of games) {
      if (!allowHistoricFetch) break; // stop if user toggles off

      try {
        const r = await fetch(`/api/deal?appid=${game.appid}`);
        if (r.status === 429) {
            console.warn('Rate limited by CheapShark. Pausing 5 seconds...');
            await sleep(5000);
            continue;
        }
        const d = await r.json();
        if (d && d.cheapest != null) {
          deals[game.appid] = parseFloat(d.cheapest);
          totalHistoricUSD += deals[game.appid];
          
          const el = document.getElementById(`low-${game.appid}`);
          if (el) { el.textContent = `$${d.cheapest}`; el.style.display = ''; }
        }
      } catch (_) { /* ignore */ }
      
      updateStatsDisplay();
      if (sortMode.includes('low')) renderGames(); // Re-render if currently sorted by low
      
      await sleep(1200); // 1.2s delay to prevent 429 Too Many Requests
    }
    loadingMore.style.display = 'none';
  }

  // ── Tags fetcher ───────────────────────────────
  async function fetchTagsInBackground() {
      if (!allowTagsFetch) return;
      loadingMore.style.display = 'flex';
      loadingMore.querySelector('span').textContent = 'Fetching tags & genres…';
      
      for (const game of games) {
          if (!allowTagsFetch) break;
          // Steam Store API rate limit is very strict (max ~200 per 5 mins).
          // We will wait 1.5s per request.
          try {
              if (game.genres) continue; // already fetched
              const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${game.appid}&filters=categories,genres,metacritic,recommendations`);
              const d = await r.json();
              if (d && d[game.appid]?.success) {
                  const data = d[game.appid].data;
                  game.genres = data.genres?.map(g => g.description) || [];
                  game.categories = data.categories?.map(c => c.description) || [];
                  game.metacritic = data.metacritic?.score || null;
                  game.recommendations = data.recommendations?.total || 0;
                  
                  // Re-render only if filtering by gems
                  if (advancedFilter === 'gems') renderGames();
              }
          } catch (_) { /* ignore */ }
          
          await sleep(1500);
      }
      loadingMore.style.display = 'none';
  }

  // ── Sidebar ────────────────────────────────────
  function updateSidebar() {
    const unique = games.filter(g => g.owners.length === 1).length;
    const dups   = games.filter(g => g.owners.length  > 1).length;

    elCountAll.textContent    = games.length;
    elCountUnique.textContent = unique;
    elCountDup.textContent    = dups;
    elStatTotal.textContent   = games.reduce((s, g) => s + g.owners.length, 0).toLocaleString();
    updateStatsDisplay();

    // Members
    const memberEl = document.getElementById('sidebar-members');
    memberEl.innerHTML = '';
    Object.values(users).forEach(u => {
      const ownCount = games.filter(g => g.owners.includes(u.steamid)).length;
      const item = document.createElement('div');
      item.className = `sidebar-member ${activeOwner === u.steamid ? 'active' : ''}`;
      item.innerHTML = `
        <img src="${u.avatar}" alt="${u.personaname}">
        <div class="sidebar-member-info">
          <div class="sidebar-member-name">${u.personaname}</div>
          <div class="sidebar-member-count">${ownCount} games</div>
        </div>
      `;
      item.onclick = () => {
        activeOwner = activeOwner === u.steamid ? null : u.steamid;
        document.querySelectorAll('.sidebar-member').forEach(m => m.classList.remove('active'));
        if (activeOwner) item.classList.add('active');
        renderGames();
      };
      memberEl.appendChild(item);
    });
  }

  function updateStatsDisplay() {
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    elStatValue.textContent    = fmt.format(totalCurrentCents / 100);
    elStatHistoric.textContent = totalHistoricUSD
      ? `$${totalHistoricUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';
      
    const totalPlaytimeMins = games.reduce((sum, g) => sum + (g.playtime_forever || 0), 0);
    const totalPlaytimeHrs = (totalPlaytimeMins / 60).toLocaleString(undefined, { maximumFractionDigits: 0 });
    
    // We will reuse elStatTotal to show Total Games AND Playtime
    elStatTotal.innerHTML = `${games.length} <span style="font-size:0.7rem; color:var(--mac-label-3); display:block; font-weight:normal">${totalPlaytimeHrs} hrs total</span>`;
  }

  // ── Filter nav ─────────────────────────────────
  window.setFilter = function (f) {
    activeFilter = f;
    document.querySelectorAll('.sidebar-item[id^="nav-"]').forEach(el => el.classList.remove('active'));
    document.getElementById(`nav-${f}`)?.classList.add('active');
    renderGames();
  };

  // ── Render Games ───────────────────────────────
  const RENDER_CHUNK = 50;
  let currentFilteredGames = [];
  let renderedCount = 0;
  const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) renderNextChunk();
  }, { rootMargin: '200px' });

  function renderGames() {
    const term = searchTerm.toLowerCase();

    let filtered = games.filter(g => {
      if (term && !g.name.toLowerCase().includes(term)) return false;
      if (activeFilter === 'unique'     && g.owners.length !== 1) return false;
      if (activeFilter === 'duplicates' && g.owners.length  < 2) return false;
      if (activeOwner && !g.owners.includes(activeOwner)) return false;
      
      const priceData = prices[g.appid];
      if (advancedFilter === 'free' && priceData) return false;
      if (advancedFilter === 'gems') {
          if (!priceData) return false; // paid games only
          if (g.playtime_forever > 120) return false; // less than 2 hours across family
          if (!g.metacritic || g.metacritic < 80) return false; // high rated
      }
      
      return true;
    });

    // Sort
    filtered.sort((a, b) => {
      const pa = prices[a.appid]?.initial ?? 0;
      const pb = prices[b.appid]?.initial ?? 0;
      const lowA = deals[a.appid] ?? 0;
      const lowB = deals[b.appid] ?? 0;

      if (sortMode === 'price-desc')  return pb - pa;
      if (sortMode === 'price-asc')   return pa - pb;
      if (sortMode === 'low-desc')    return lowB - lowA;
      if (sortMode === 'low-asc')     return lowA - lowB;
      if (sortMode === 'owners-desc') return b.owners.length - a.owners.length;
      if (sortMode === 'owners-asc')  return a.owners.length - b.owners.length;
      if (sortMode === 'playtime-desc') return b.playtime_forever - a.playtime_forever;
      if (sortMode === 'name-asc')    return a.name.localeCompare(b.name);
      return 0;
    });

    currentFilteredGames = filtered;
    renderedCount = 0;
    gamesGrid.innerHTML = '';
    renderNextChunk();
  }

  function renderNextChunk() {
    if (renderedCount >= currentFilteredGames.length) return;
    
    const chunk = currentFilteredGames.slice(renderedCount, renderedCount + RENDER_CHUNK);
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });

    chunk.forEach(game => {
      const priceData = prices[game.appid];
      const isDup     = game.owners.length > 1;
      const isFree    = !priceData;

      let basePriceStr = 'Free';
      let currentPriceStr = '';
      
      if (priceData) {
          basePriceStr = fmt.format(priceData.initial / 100);
          if (priceData.initial !== priceData.final) {
              currentPriceStr = fmt.format(priceData.final / 100);
          }
      }

      const lowStr   = deals[game.appid] ? `$${deals[game.appid]}` : null;
      const imgSrc   = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.appid}/header.jpg`;

      const card = document.createElement('div');
      card.className = 'game-card';
      card.dataset.appid = game.appid;

      const avatarsHtml = game.owners
        .map(sid => users[sid] ? `<img class="game-owner-avatar" src="${users[sid].avatar}" title="${users[sid].personaname}" alt="">` : '')
        .join('');

      let badgeHtml = '';
      if (isDup)  badgeHtml = `<div class="game-badge badge-dup">${game.owners.length}×</div>`;
      if (isFree) badgeHtml = `<div class="game-badge badge-free">Free</div>`;
      
      let metaHtml = '';
      if (game.metacritic) {
          metaHtml = `<div class="game-badge" style="background:var(--steam-green); color:#fff; position:absolute; top:8px; right:8px; font-weight:700;">${game.metacritic}</div>`;
      }

      // Build price row
      let pricesHtml = `<span class="game-price-base ${currentPriceStr ? 'strikethrough' : ''}">${basePriceStr}</span>`;
      if (currentPriceStr) {
          pricesHtml += `<span class="game-price-current">${currentPriceStr}</span>`;
      }
      pricesHtml += `<span class="game-price-low" id="low-${game.appid}" style="${lowStr ? '' : 'display:none'}">${lowStr ?? ''}</span>`;
      
      const playtimeHrs = (game.playtime_forever / 60).toFixed(1);
      const playtimeHtml = game.playtime_forever > 0 ? `<span class="game-playtime">${playtimeHrs} hrs</span>` : '';

      card.innerHTML = `
        ${badgeHtml}
        ${metaHtml}
        <img class="game-thumb" src="${imgSrc}" alt="${game.name}" loading="lazy"
          onerror="handleImgError(this, ${game.appid}, '#3a3a3c')">
        <div class="game-body">
          <div class="game-name" title="${game.name}">${game.name}</div>
          <div class="game-prices">
            ${pricesHtml}
            ${playtimeHtml}
          </div>
          <div class="game-footer">
            <div class="game-owners-avatars">${avatarsHtml}</div>
          </div>
        </div>
      `;

      card.addEventListener('click', () => openModal(game));
      gamesGrid.appendChild(card);
    });
    
    renderedCount += chunk.length;
    
    const sentinel = document.createElement('div');
    gamesGrid.appendChild(sentinel);
    observer.observe(sentinel);
  }

  // ── Modal ──────────────────────────────────────
  function openModal(game) {
    const priceData = prices[game.appid];
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    
    let basePriceStr = 'Free';
    let currentPriceStr = '';
    
    if (priceData) {
        basePriceStr = fmt.format(priceData.initial / 100);
        if (priceData.initial !== priceData.final) {
            currentPriceStr = fmt.format(priceData.final / 100);
        }
    }
    
    const lowStr = deals[game.appid] ? `$${deals[game.appid]}` : '';

    const headerImg = document.getElementById('modal-header-img');
    headerImg.dataset.retry = '';
    headerImg.style.background = '';
    headerImg.style.display = 'block'; // Ensure it's visible initially
    headerImg.src = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.appid}/header.jpg`;
    headerImg.onerror = function() {
        handleImgError(this, game.appid, '#2c2c2e', true);
    };

    document.getElementById('modal-name').textContent    = game.name;
    const modalPrices = document.getElementById('modal-prices');
    const playtimeHrs = (game.playtime_forever / 60).toFixed(1);
    
    let metaHtml = '';
    if (game.metacritic) {
        metaHtml = `<span style="display:inline-block; background:var(--steam-green); color:#fff; padding:2px 6px; border-radius:4px; font-weight:700; font-size:0.85rem; margin-top:8px">Metacritic: ${game.metacritic}</span>`;
    }
    
    modalPrices.innerHTML = `
      <span style="font-weight:600; color:#fff ${currentPriceStr ? '; text-decoration:line-through; color:var(--mac-label-3); font-size:0.85rem' : ''}">${basePriceStr}</span>
      ${currentPriceStr ? `<span style="font-weight:700; color:#ffd60a; margin-left:8px">${currentPriceStr}</span>` : ''}
      <br>
      <span style="font-size:0.85rem; color:var(--mac-label-3)">${lowStr ? `Historic Low: ${lowStr}` : ''}</span>
      <br>
      <span style="font-size:0.85rem; color:#0a84ff">${game.playtime_forever > 0 ? `Playtime: ${playtimeHrs} hrs` : ''}</span>
      <br>
      ${metaHtml}
    `;

    document.getElementById('modal-link-steam').href   = `https://store.steampowered.com/app/${game.appid}/`;
    document.getElementById('modal-link-steamdb').href = `https://steamdb.info/app/${game.appid}/`;

    const ownersEl = document.getElementById('modal-owners');
    
    // Sort owners by playtime
    const sortedOwners = [...game.owners].sort((a, b) => {
        const ptA = game.playtimes && game.playtimes[a] ? game.playtimes[a] : 0;
        const ptB = game.playtimes && game.playtimes[b] ? game.playtimes[b] : 0;
        return ptB - ptA;
    });
    
    ownersEl.innerHTML = sortedOwners.map((sid, index) => {
      const u = users[sid];
      if (!u) return '';
      
      const pt = game.playtimes && game.playtimes[sid] ? (game.playtimes[sid] / 60).toFixed(1) : 0;
      const isMVP = index === 0 && pt > 0;
      
      return `
        <div class="modal-owner-chip" style="${isMVP ? 'border: 1px solid #ffd60a;' : ''}">
          <img src="${u.avatar}" alt="${u.personaname}">
          <div style="display:flex; flex-direction:column;">
              <span style="font-weight:${isMVP ? 'bold' : 'normal'}; ${isMVP ? 'color:#ffd60a' : ''}">${u.personaname} ${isMVP ? '👑' : ''}</span>
              <span style="font-size:0.7rem; color:var(--mac-label-3)">${pt > 0 ? pt + ' hrs' : 'Never played'}</span>
          </div>
        </div>`;
    }).join('');
    
    // Tags
    const tagsSection = document.getElementById('modal-tags-section');
    const tagsList    = document.getElementById('modal-tags-list');
    if (game.tags && game.tags.length > 0) {
        tagsList.innerHTML = game.tags.map(t => `<span class="tag-chip">${t}</span>`).join('');
        tagsSection.style.display = 'block';
    } else {
        tagsSection.style.display = 'none';
    }
    
    // PC Specs
    const specsSection = document.getElementById('modal-specs-section');
    const specsEl = document.getElementById('modal-specs');
    specsSection.style.display = 'block';
    specsEl.innerHTML = '<i>Fetching PC requirements...</i>';
    
    fetch(`/api/game-details?appid=${game.appid}&cc=${currentCurrencyCode}`)
      .then(r => r.json())
      .then(data => {
          if (data && data.pc_requirements && data.pc_requirements.minimum) {
              specsEl.innerHTML = data.pc_requirements.minimum + (data.pc_requirements.recommended || '');
          } else {
              specsSection.style.display = 'none';
          }
      }).catch(() => {
          specsSection.style.display = 'none';
      });

    // HLTB Fetch
    const hltbSection = document.getElementById('modal-hltb-section');
    const hltbEl = document.getElementById('modal-hltb');
    hltbSection.style.display = 'block';
    hltbEl.innerHTML = '<i>Fetching times...</i>';
    
    fetch(`/api/hltb?game=${encodeURIComponent(game.name)}`)
      .then(r => r.json())
      .then(data => {
          if (data) {
              hltbEl.innerHTML = `<b>Main Story:</b> ${data.gameplayMain} Hrs <br> <b>Completionist:</b> ${data.gameplayCompletionist} Hrs`;
          } else {
              hltbEl.innerHTML = 'No data found.';
          }
      }).catch(() => {
          hltbSection.style.display = 'none';
      });

    modalOverlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  window.closeModal = function () {
    modalOverlay.style.display = 'none';
    document.body.style.overflow = '';
  };

  modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeModal();
  });

  document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
  });

  // URL Params initialization
  window.addEventListener('DOMContentLoaded', () => {
      const urlParams = new URLSearchParams(window.location.search);
      const usersParam = urlParams.get('users');
      if (usersParam) {
          const userList = usersParam.split(',');
          const inputs = document.querySelectorAll('.member-input');
          userList.forEach((u, i) => {
              if (inputs[i]) inputs[i].value = u;
          });
          fetchBtn.click();
      }
  });

  // ── Controls ───────────────────────────────────
  searchInput.addEventListener('input', e => { searchTerm = e.target.value; renderGames(); });
  sortSelect.addEventListener('change', e => { sortMode = e.target.value; renderGames(); });

  // ── View switcher ──────────────────────────────
  function switchToLibrary() {
    setupView.style.display  = 'none';
    libraryView.style.display = 'flex';
  }

  window.resetSetup = function () {
    setupView.style.display   = 'flex';
    libraryView.style.display = 'none';
    games = []; users = {}; prices = {}; deals = {};
    gamesGrid.innerHTML = '';
    activeFilter = 'all'; activeOwner = null; searchTerm = '';
    document.querySelectorAll('.sidebar-item[id^="nav-"]').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-all')?.classList.add('active');
  };

  function setLoading(state, text) {
    fetchBtn.disabled          = state;
    btnText.textContent        = text;
    btnLoader.style.display    = state ? 'block' : 'none';
  }

  // ── Utils ──────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  window.handleImgError = function(img, appid, bgColor, isModal = false) {
    if (!img.dataset.retry) {
      img.dataset.retry = '1';
      img.src = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`;
    } else {
      img.onerror = null;
      if (isModal) {
          // For modal, if there's no image, just hide the img tag completely
          // The modal-header has a clean dark background and the text is overlaid.
          img.style.display = 'none';
      } else {
          // For grid cards, load a transparent pixel to maintain aspect ratio
          img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
          img.style.background = bgColor || '#3a3a3c';
      }
    }
  };

})();
