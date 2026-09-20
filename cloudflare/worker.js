/* The Worker in front of the container: it forwards every request to it and
 * keeps it awake while transfers are running.
 *
 * A container that has gone to sleep loses its ephemeral disk, so the sleep
 * window is long on purpose — and the app's own polling, every few seconds
 * while something is downloading, is what keeps it open.
 */
import { Container, getContainer } from '@cloudflare/containers';

export class TorrentContainer extends Container {
  defaultPort = 8080;
  // Long enough that a download does not die between two polls of the library.
  sleepAfter = '30m';

  envVars = {
    PORT: '8080',
    DOWNLOAD_DIR: '/data/downloads',
    ALLOWED_ORIGINS: this.env?.ALLOWED_ORIGINS ?? '*',
    AUTH_TOKEN: this.env?.AUTH_TOKEN ?? '',
  };

  onError(error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request, env) {
    // One container, one set of transfers: a second instance would be a second
    // machine with a different disk and different torrents.
    return getContainer(env.TORRENT).fetch(request);
  },
};
