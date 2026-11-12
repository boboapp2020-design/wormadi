// wormadi.pages.dev
//  - voice WebSocket -> straight into the walkie room (same Durable Object the Worker uses)
//  - everything else (pages, API) -> Worker "wormadi"
export default {
  fetch(req, env) {
    if ((req.headers.get('Upgrade') || '').toLowerCase() === 'websocket' && new URL(req.url).pathname === '/') {
      return env.ROOM.get(env.ROOM.idFromName('main')).fetch(req);
    }
    return env.APP.fetch(req);
  },
};
