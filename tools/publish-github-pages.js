// Publish the app's screens (server/public) to GitHub Pages — the second link for networks that block some Cloudflare addresses.
//   node tools/publish-github-pages.js
// Needs a PUBLIC repo https://github.com/boboapp2020-design/wormadi-app (empty) with
// Settings -> Pages -> Source: "Deploy from a branch", branch "main", folder "/ (root)".
// Only the screens go there (no server code, no employee data). Login, voice and data still use the Cloudflare server.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = process.env.PAGES_REPO || 'https://github.com/boboapp2020-design/wormadi-app.git';
const src = path.join(__dirname, '..', 'server', 'public');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wormadi-pages-'));
fs.cpSync(src, dir, { recursive: true });
fs.writeFileSync(path.join(dir, '.nojekyll'), '');                 // serve files as they are
fs.writeFileSync(path.join(dir, '404.html'), fs.readFileSync(path.join(src, 'index.html')));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'inherit' });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=WORMADI', '-c', 'user.email=wormadi@users.noreply.github.com', 'commit', '-q', '-m', 'Publish WORMADI web app');
git('push', '-f', REPO, 'main');
console.log('\n✓ ส่งขึ้น GitHub Pages แล้ว: https://boboapp2020-design.github.io/wormadi-app/ (รอ 1–2 นาที)');
