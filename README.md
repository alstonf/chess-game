## README — Quick deploy (Render server + Netlify client)

1. **Push this repo to GitHub** with the `server/` and `client/` folders.

2. **Server (Render)**
   - In Render, create a **Web Service**, point to the `server/` folder.
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Ensure environment allows WebSocket traffic.
   - After deploy, note the URL: `https://<your-render-app>.onrender.com`. Use `wss://<your-render-app>.onrender.com` in the client `wsUrl`.

3. **Client (Netlify)**
   - Create a Netlify site from GitHub and select the `client/` folder.
   - Build command: `npm install && npm run build`
   - Publish directory: `dist`

4. **Fix common issues**
   - If Netlify fails with a missing `styles.css`, ensure `client/src/styles.css` exists (it does in this repo).
   - If `chess.js` ETARGET occurs, use `chess.js@^1.4.0` (this repo uses that).

---

## Notes & next steps
- **Clocks**: current implementation doesn’t enforce server clocks. If you need rated games / enforced clocks, add server-side clock tracking (the server must tick and deduct seconds to prevent cheating).
- **Persistence**: you can persist PGN and rooms to a database (SQLite, Supabase, etc.) for replays.
- **Authentication**: currently players are anonymous names. Add OAuth or simple accounts for identity.
- **Improved reconnection**: for robust reconnection across IPs, store client ids and reassign sockets; this implementation uses a fresh UUID per WS session (improvements possible).
