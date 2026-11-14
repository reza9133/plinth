# Plinth front end

Static, multi-page site for the Plinth contract on GenLayer Studionet.

- Contract: `0xcef1d3Fc0638070C097bbceDDD0d362BFD09912A` (set once, in `js/core.js`)
- Pages: `index`, `slots`, `slot?id=N`, `create`, `account`, `docs`
- Wallet: EIP-6963 discovery, connect, real disconnect, switch/add Studionet (chain 61999)
- Reads and writes: `genlayer-js` (loaded from esm.sh), no build step, no server

Run locally (modules do not load from `file://`):

    npx serve .        # or: python3 -m http.server 8080

Deploy: upload this folder to any static host (Cloudflare Pages, GitHub Pages, Netlify).

Repo: https://github.com/reza9133/plinth · X: https://x.com/amirhp771
