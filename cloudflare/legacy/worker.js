// Old link https://walkie.boboapp2020.workers.dev — kept so nothing breaks:
//  - web pages      -> forward (301) to the main link https://wormadi.boboapp2020.workers.dev
//  - /api/*         -> passed to the main Worker "wormadi" (older app versions use this address as a fallback)
//  - voice WebSocket -> straight into the same voice room (Durable Object of "wormadi"), so nobody ends up in a separate room
// No timers here (reminders / clean-up run only on the main Worker).
const MAIN = 'https://wormadi.boboapp2020.workers.dev';

export default {
  fetch(req, env) {
    const url = new URL(req.url);
    if ((req.headers.get('Upgrade') || '').toLowerCase() === 'websocket') return env.ROOM.get(env.ROOM.idFromName('main')).fetch(req);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__')) return env.APP.fetch(req);
    return Response.redirect(MAIN + url.pathname + url.search, 301);
  },
};
