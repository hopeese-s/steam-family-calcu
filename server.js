const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { HowLongToBeatService } = require('howlongtobeat');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const myCache = new NodeCache({ stdTTL: 900 });
const hltbService = new HowLongToBeatService();

const app = express();

// ── CORS: only allow the dashboard's own frontend ──
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.PUBLIC_URL,
].filter(Boolean);

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// ── Global rate limiter: 100 req/min per IP ──
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', globalLimiter);

// ── Stricter limiter for external-API proxy routes (prices, deals, etc.) ──
const externalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/prices', externalApiLimiter);
app.use('/api/deal', externalApiLimiter);
app.use('/api/hltb', externalApiLimiter);

const STEAM_API_KEY = process.env.STEAM_API_KEY;

const path = require('path');

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Explicitly serve index.html for the root route (Fixes "Cannot GET /" on Vercel)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Image Proxy — fetches Steam CDN images server-side to bypass browser CORS/CSP blocks
app.get('/api/img', async (req, res) => {
    const { appid } = req.query;
    if (!appid || !/^\d+$/.test(appid)) return res.status(400).end();

    const cacheKey = `img_${appid}`;
    if (myCache.has(cacheKey)) {
        const cached = myCache.get(cacheKey);
        res.set('Content-Type', cached.contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(cached.data);
    }

    const urls = [
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_616x353.jpg`,
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
        `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
        `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`,
    ];

    for (const url of urls) {
        try {
            const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
            if (r.status === 200 && r.data.length > 5000) { // >5KB = real image, not error page
                const contentType = r.headers['content-type'] || 'image/jpeg';
                myCache.set(cacheKey, { data: r.data, contentType }, 3600);
                res.set('Content-Type', contentType);
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(r.data);
            }
        } catch (_) { /* try next */ }
    }
    res.status(404).end();
});

// 1. Fetch user summaries (to get their names and avatars)
app.get('/api/users', async (req, res) => {
    try {
        const { steamids } = req.query;
        if (!steamids) return res.status(400).json({ error: 'steamids required' });

        const cacheKey = `users_${steamids}`;
        if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

        const response = await axios.get(`http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamids}`);
        myCache.set(cacheKey, response.data.response.players);
        res.json(response.data.response.players);
    } catch (error) {
        console.error('Error fetching users:', error.message);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Resolve Vanity URL to Steam64 ID
app.get('/api/resolve', async (req, res) => {
    try {
        const { vanityurl } = req.query;
        if (!vanityurl) return res.status(400).json({ error: 'vanityurl required' });

        const response = await axios.get(`http://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${STEAM_API_KEY}&vanityurl=${vanityurl}`);
        if (response.data.response.success === 1) {
            res.json({ steamid: response.data.response.steamid });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error) {
        console.error('Error resolving vanity URL:', error.message);
        res.status(500).json({ error: 'Failed to resolve vanity URL' });
    }
});

// 2. Fetch owned games for multiple users
app.get('/api/games', async (req, res) => {
    try {
        const { steamids } = req.query;
        if (!steamids) return res.status(400).json({ error: 'steamids required' });

        const ids = steamids.split(',');
        
        const cacheKey = `games_${steamids}`;
        if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

        const allGamesMap = new Map();

        // Fetch for each user
        for (const id of ids) {
            try {
                const url = `http://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${id}&include_appinfo=true&include_played_free_games=true`;
                const response = await axios.get(url);
                const games = response.data.response.games || [];

                games.forEach(game => {
                    if (!allGamesMap.has(game.appid)) {
                        allGamesMap.set(game.appid, {
                            appid: game.appid,
                            name: game.name,
                            img_icon_url: game.img_icon_url,
                            owners: [],
                            playtimes: {},
                            playtime_forever: 0
                        });
                    }
                    const g = allGamesMap.get(game.appid);
                    g.owners.push(id);
                    g.playtimes[id] = game.playtime_forever || 0;
                    g.playtime_forever += (game.playtime_forever || 0);
                });
            } catch (err) {
                console.error(`Error fetching games for ${id}:`, err.message);
                // Continue with other users even if one fails (e.g. private profile)
            }
        }

        const aggregatedGames = Array.from(allGamesMap.values());
        myCache.set(cacheKey, aggregatedGames);
        res.json(aggregatedGames);

    } catch (error) {
        console.error('Error fetching games:', error.message);
        res.status(500).json({ error: 'Failed to fetch games' });
    }
});

// 3. Fetch prices for a list of appids (in batches to avoid rate limits)
app.post('/api/prices', async (req, res) => {
    try {
        const { appids, cc = 'TH' } = req.body; // Expecting array of appids and optional cc
        if (!appids || !Array.isArray(appids)) return res.status(400).json({ error: 'appids array required' });

        // Chunk the appids array into chunks of 100
        const chunkSize = 100;
        const chunks = [];
        for (let i = 0; i < appids.length; i += chunkSize) {
            chunks.push(appids.slice(i, i + chunkSize));
        }

        const priceData = {};

        for (const chunk of chunks) {
            const idsString = chunk.join(',');
            
            const cacheKey = `prices_${cc}_${idsString}`;
            if (myCache.has(cacheKey)) {
                Object.assign(priceData, myCache.get(cacheKey));
                continue;
            }

            try {
                const response = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${idsString}&filters=price_overview&cc=${cc}`);
                const data = response.data;
                const chunkData = {};
                
                for (const appid in data) {
                    if (data[appid].success && data[appid].data && data[appid].data.price_overview) {
                        chunkData[appid] = data[appid].data.price_overview;
                    }
                }
                
                Object.assign(priceData, chunkData);
                myCache.set(cacheKey, chunkData);
            } catch (err) {
                console.error(`Error fetching prices for chunk:`, err.message);
                // Wait 1 second if rate limited, then continue (basic mitigation)
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        res.json(priceData);

    } catch (error) {
        console.error('Error fetching prices:', error.message);
        res.status(500).json({ error: 'Failed to fetch prices' });
    }
});

// 4. Fetch Historical Low from CheapShark API
app.get('/api/deal', async (req, res) => {
    try {
        const { appid } = req.query;
        if (!appid) return res.status(400).json({ error: 'appid required' });

        const cacheKey = `deal_${appid}`;
        if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

        const response = await axios.get(`https://www.cheapshark.com/api/1.0/games?steamAppID=${appid}`);
        if (response.data && response.data.length > 0) {
            myCache.set(cacheKey, { cheapest: response.data[0].cheapest });
            res.json({ cheapest: response.data[0].cheapest });
        } else {
            myCache.set(cacheKey, { cheapest: null });
            res.json({ cheapest: null });
        }
    } catch (error) {
        res.json({ cheapest: null });
    }
});

// 5. HowLongToBeat
app.get('/api/hltb', async (req, res) => {
    try {
        const { game } = req.query;
        if (!game) return res.status(400).json({ error: 'game required' });
        
        const cacheKey = `hltb_${game}`;
        if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

        const results = await hltbService.search(game);
        if (results.length > 0) {
            const bestMatch = results[0];
            const data = {
                gameplayMain: bestMatch.gameplayMain,
                gameplayCompletionist: bestMatch.gameplayCompletionist
            };
            myCache.set(cacheKey, data);
            res.json(data);
        } else {
            res.json(null);
        }
    } catch (error) {
        console.error('HLTB error:', error.message);
        res.json(null);
    }
});

// 7. Tags & Metadata — server-side proxy to Steam Store API
//    Avoids CORS issues and browser-side rate limits
app.get('/api/tags', async (req, res) => {
    try {
        const { appid } = req.query;
        if (!appid || !/^\d+$/.test(appid)) return res.status(400).json({ error: 'appid required' });

        const cacheKey = `tags_${appid}`;
        if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

        const response = await axios.get(
            `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=categories,genres,metacritic,recommendations`,
            { timeout: 8000 }
        );
        const data = response.data;

        if (data && data[appid] && data[appid].success) {
            const appData = data[appid].data;
            const result = {
                genres: (appData.genres || []).map(g => g.description),
                categories: (appData.categories || []).map(c => c.description),
                metacritic: appData.metacritic?.score || null,
                recommendations: appData.recommendations?.total || 0,
            };
            myCache.set(cacheKey, result);
            res.json(result);
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    } catch (error) {
        console.error('Error fetching tags:', error.message);
        res.status(502).json({ error: 'Failed to fetch tags' });
    }
});

// 6. Game Details (Specs, Packages)
app.get('/api/game-details', async (req, res) => {
    try {
        const { appid, cc = 'TH' } = req.query;
        if (!appid) return res.status(400).json({ error: 'appid required' });

        const cacheKey = `gamedetail_${cc}_${appid}`;
        if (myCache.has(cacheKey)) return res.json(myCache.get(cacheKey));

        const response = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=price_overview,pc_requirements,package_groups&cc=${cc}`);
        const data = response.data;

        if (data[appid] && data[appid].success && data[appid].data) {
            myCache.set(cacheKey, data[appid].data);
            res.json(data[appid].data);
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    } catch (error) {
        console.error('Error fetching game details:', error.message);
        res.status(500).json({ error: 'Failed to fetch game details' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;
