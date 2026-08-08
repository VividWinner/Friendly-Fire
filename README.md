# Friendly Fire

A real-time multiplayer top-down arena shooter. Host or join a room with a
5-letter code, ready up with 2-4 players, and fight it out across a big
open-world map full of houses, chests, and loot — first to 15 kills (or
whoever's ahead when the 5-minute clock runs out) wins the round.

## What's in it

- **Movement + combat:** WASD/left-stick to move, mouse or right-stick to aim
  and fire — independently of each other, like a twin-stick shooter. Four
  weapons (pistol, SMG, rifle, shotgun), each with its own damage, fire rate,
  and range. The server simulates every bullet and resolves every hit —
  clients never decide their own hits.
- **Health, death, and respawn:** get shot enough and you go down for 3
  seconds, then respawn with your loadout intact. Rounds end on a kill target
  or a timer, then show a scoreboard before returning everyone to the lobby
  for a rematch.
- **World:** a 6400×4800px map with procedurally scattered houses (each with
  multiple rooms, doors that swing open as you pass), rocks, trees, and
  bushes for cover.
- **Chests + inventory:** each chest holds up to 3 items. Walk up and press E
  (or click the chest directly) to see what's inside, then take whichever
  items you want one at a time — they go into one of your 6 inventory slots
  (slot 0 is always your pistol). Ammo pickups top up a weapon you already
  have instead of taking a new slot.
- **Party lobby:** host a room, share the code (shown right there in the
  lobby), everyone readies up, round starts with a countdown.
- **Accounts:** Firebase Authentication (username/password, auto sign-in).
- **Look:** hazard-tape visual style, Bebas Neue/Space Mono type, a color
  shop so everyone can pick their own player color.

## Accounts (Firebase Authentication)

Sign-up/login/logout is handled by Firebase — no database or server secrets
needed for this part.

1. Go to https://console.firebase.google.com, create a free project.
2. In the project, go to **Build → Authentication → Get started**, then
   enable the **Email/Password** sign-in provider.
3. Go to **Project settings** (gear icon) → scroll to "Your apps" → click
   the `</>` (web) icon to register a web app → copy the `firebaseConfig`
   object it gives you.
4. Paste those values into `public/index.html`, replacing the placeholder
   `firebaseConfig` object near the top of the `<script>` section.
5. These values are safe to commit/deploy as-is — they're public identifiers,
   not secret keys, so there's nothing to add to Render's environment.

## Run it locally (test with yourself first)

1. Install [Node.js](https://nodejs.org) if you don't have it (LTS version).
2. In a terminal, inside this folder:
   ```
   npm install
   npm start
   ```
3. Open `http://localhost:3000` in a few different browser tabs — each tab
   is a "player." Host a room in one tab, join with the code in the others,
   ready up, and confirm the round starts and you can shoot each other.

## Deploy for free so friends can join over the internet (Render)

1. Put this folder in a GitHub repo (create a new repo on github.com, then
   `git init`, `git add .`, `git commit -m "base game"`, and push it).
2. Go to https://render.com and sign up (free, no credit card needed for this tier).
3. Click **New +** → **Web Service**, connect your GitHub repo.
4. Settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Create Web Service**. Render will give you a URL like
   `https://your-app-name.onrender.com`.
6. Send that URL to your friends — they open it in a browser, host/join a
   room, and you're all in the same arena.

**Note:** the free tier "sleeps" after 15 minutes with no traffic. The first
person to open the link after it's been idle will wait ~30-60 seconds for it
to wake up. After that it's fast for everyone.

## What's next
- Real Pixabay background track (swap in for the placeholder synth loop)
- More maps / map variety
- Possible team modes (2v2) alongside free-for-all

