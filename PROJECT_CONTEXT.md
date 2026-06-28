# Steam Family Calculator - AI Context Document

This document is intended for any future AI assistants (or developers) working on this project. It provides a comprehensive overview of the architecture, tech stack, API behaviors, and known quirks to ensure smooth continuation of development.

## 1. Project Overview
**Name**: Steam Family Calculator (Steam Family Calcu)
**Purpose**: Allows users to input multiple Steam IDs (or profile URLs), merges their game libraries to find shared and unique games, calculates the total library value (current and historic low), and provides filtering/sorting mechanisms.
**Deployment**: Hosted on Vercel as a Node.js serverless application.

## 2. Tech Stack & Architecture
- **Frontend**: Vanilla HTML5, CSS3, JavaScript (ES6+). No frontend frameworks (React/Vue) are used.
- **Backend**: Node.js with Express.js.
- **Hosting**: Vercel. 
  - `vercel.json` rewrites all API traffic (`/api/(.*)`) to `server.js` and serves static files from the `/public` directory.
- **Caching**: `node-cache` is heavily utilized on the backend to cache API responses (Steam API, HowLongToBeat, CheapShark) to minimize rate limiting and speed up subsequent requests.

## 3. Directory Structure
```text
/
├── public/
│   ├── index.html     # Main frontend UI structure
│   ├── style.css      # Custom UI styles (Glassmorphism, macOS-like aesthetic)
│   └── app.js         # Frontend logic (DOM manipulation, fetching APIs, rendering games)
├── server.js          # Express backend server (handles all proxying and API aggregation)
├── vercel.json        # Vercel deployment configuration
├── package.json       # Node.js dependencies
└── PROJECT_CONTEXT.md # This file
```

## 4. Key Backend API Routes (`server.js`)
The backend acts as a proxy to bypass CORS restrictions and aggregate data from external APIs.

1. **`GET /api/games?steamids=...`**
   - Fetches owned games from Steam (`IPlayerService/GetOwnedGames`).
   - Merges libraries from multiple users, groups duplicates, and returns a unified array of games with owner metadata.
2. **`POST /api/prices`**
   - **Important**: Accepts an array of `appids` and an optional `cc` (currency code, e.g., 'th', 'us').
   - Fetches current prices using Steam's `appdetails` endpoint. 
   - *Quirk*: Steam strictly restricts batch fetching. It queries 100 appids per batch using **ONLY** `filters=price_overview`. Adding other filters will cause a `400 Bad Request`.
3. **`GET /api/game-details?appid=...&cc=...`**
   - Fetches extended details for a **single** game (PC Requirements, Package Groups) using `filters=price_overview,pc_requirements,package_groups`.
   - Used for lazy-loading data when a user clicks on a game to view its modal.
4. **`GET /api/deal?appid=...`**
   - Queries CheapShark API to find the absolute cheapest historical price (Historic Low).
5. **`GET /api/hltb?name=...`**
   - Queries the HowLongToBeat API (via `howlongtobeat` npm package) to fetch gameplay duration (Main Story vs Completionist).

## 5. Frontend Logic (`public/app.js`)
- **State Management**: Data is stored in global variables (`games`, `users`, `prices`, `deals`, `currency`, `currentCurrencyCode`).
- **Rendering**: The UI is re-rendered dynamically by calling `renderGames()` whenever filters, sorts, or search terms change.
- **Image Fallbacks**: Steam's primary image CDN occasionally fails for older games. The `handleImgError` function recursively attempts 4 different CDN URLs (`shared.akamai...`, `cdn.akamai...`, `steamcdn-a.akamaihd...`, and `capsule_231x87.jpg`) before falling back to a blank grey box.

## 6. Known Quirks & Rules for Future Development
1. **Steam API Rate Limits**: Steam API is highly sensitive. Always utilize the backend `node-cache` and chunk API requests (e.g., 100 appids max per `appdetails` batch).
2. **Batch Price Fetching (`server.js`)**: Do **NOT** add additional comma-separated filters to the `appdetails` API call when querying multiple `appids`. It will result in an empty object or HTTP 400. Extended details must be fetched individually per game via `/api/game-details`.
3. **Vanilla JS Maintenance**: The user prefers to keep the frontend as Vanilla JS/CSS. Avoid installing heavy frontend frameworks or altering the core UI aesthetics unless explicitly requested.
4. **CORS Restrictions**: Never fetch Steam or CheapShark APIs directly from `app.js`. Always route requests through `server.js`.
5. **Currency Switching**: Currency changes are triggered from the frontend dropdown, which re-invokes `/api/prices` with the new `cc` code. The backend cache is keyed by this `cc` code to prevent cross-currency cache poisoning.
6. **AI Matchmaker Removed**: The project previously contained a Gemini AI matchmaker feature, but it was fully stripped out to save costs and reduce complexity. Do not attempt to re-integrate unless the user asks.

## 7. Useful Commands
- **Run Local Server**: `npm run start` or `node server.js`
- **Deploy to Production**: `git push origin main` (Vercel automatically triggers a build).
