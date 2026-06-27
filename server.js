const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const { HowLongToBeatService } = require('howlongtobeat');
require('dotenv').config();

const myCache = new NodeCache({ stdTTL: 900 });
const hltbService = new HowLongToBeatService();

const app = express();
app.use(cors());
app.use(express.json());

const STEAM_API_KEY = process.env.STEAM_API_KEY;

const path = require('path');

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Explicitly serve index.html for the root route (Fixes "Cannot GET /" on Vercel)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
        const { appids } = req.body; // Expecting array of appids
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
            
            const cacheKey = `prices_${idsString}`;
            if (myCache.has(cacheKey)) {
                Object.assign(priceData, myCache.get(cacheKey));
                continue;
            }

            try {
                const response = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${idsString}&filters=price_overview,pc_requirements,package_groups`);
                const data = response.data;
                const chunkData = {};
                
                for (const appid in data) {
                    if (data[appid].success && data[appid].data) {
                        const appData = data[appid].data;
                        chunkData[appid] = {
                            price_overview: appData.price_overview,
                            pc_requirements: appData.pc_requirements,
                            package_groups: appData.package_groups
                        };
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;
