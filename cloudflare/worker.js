/* The Worker in front of the container: it forwards every request to it.
 *
 * A container that has gone to sleep loses its ephemeral disk, and the library puts it to sleep
 * once nothing has asked it anything for a while. The app's polling asks, but only while the
 * app is open; a download's own traffic with its peers never does. So before it sleeps, the
 * container asks the server whether a download is still getting anywhere (onActivityExpired).
 */
import { Container, getContainer } from '@cloudflare/containers';

// How long the container stays up with nobody asking and nothing arriving. Long, because
// sleeping takes the downloaded files with it.
const IDLE_MINUTES = 30;

export class TorrentContainer extends Container {
  defaultPort = 8080;
  sleepAfter = `${IDLE_MINUTES}m`;

  envVars = {
    PORT: '8080',
    DOWNLOAD_DIR: '/data/downloads',
    ALLOWED_ORIGINS: this.env?.ALLOWED_ORIGINS ?? '*',
    AUTH_TOKEN: this.env?.AUTH_TOKEN ?? '',
  };

  /**
   * Called once the half hour has passed with no request. The library's own answer is to stop,
   * and a phone locked mid-download would come back to nothing. A transfer that got data within
   * that half hour, still downloading or finished that recently, keeps the container up for
   * another one, so finished files stay at least half an hour. A torrent that got nothing in
   * that time does not: a dead magnet must not keep a paid machine running for ever.
   */
  async onActivityExpired() {
    // Asking a stopped container would start it.
    if (!this.container.running) return;
    // Staying up needs nothing more: the library starts the next half hour when this returns.
    if (await this.receivedLately()) return;
    await this.stop();
  }

  async receivedLately() {
    try {
      const res = await this.containerFetch(new Request('http://container/api/transfers', {
        headers: { Authorization: `Bearer ${String(this.env.AUTH_TOKEN || '').trim()}` },
      }), this.defaultPort);
      if (!res.ok) return false;
      const { transfers = [] } = await res.json();
      const since = Date.now() - IDLE_MINUTES * 60 * 1000;
      return transfers.some((t) => t.receivedAt > since);
    } catch {
      return false;
    }
  }

  onError(error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request, env) {
    // The workers.dev address is public from the moment it deploys, and ALLOWED_ORIGINS is "*"
    // here: with no token, anyone who found it, and any website, could drive the torrent
    // client. So without one the container is not started at all.
    if (!String(env.AUTH_TOKEN || '').trim()) {
      return Response.json({ error: 'no AUTH_TOKEN is set: run `npx wrangler secret put AUTH_TOKEN` in cloudflare/, then reload this page' }, { status: 503 });
    }
    // One container, one set of transfers: a second instance would be a second
    // machine with a different disk and different torrents.
    return getContainer(env.TORRENT).fetch(request);
  },
};
