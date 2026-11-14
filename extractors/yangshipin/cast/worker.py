"""Private UHD-only worker. Original ticket/cache logic; no JCE/BK/EPG/Node fallback.

Listens on an ephemeral loopback port and exits when its owning Node process exits.
No login material is read. Device state belongs exclusively to this deployment.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time
import urllib.parse

from transport import install
from quality import install as install_quality

ROOT = Path(__file__).resolve().parent
CHANNELS = frozenset(('cctv4k', 'cctv164k', 'cctv8k'))


def load_engine():
    metadata = json.loads((ROOT / 'vendor/UPSTREAM.json').read_text())
    path = ROOT / 'vendor/ysp-live.py'
    if hashlib.sha256(path.read_bytes()).hexdigest() != metadata['sha256']:
        raise RuntimeError('bundled device engine checksum mismatch')
    spec = importlib.util.spec_from_file_location('ysp_cast_upstream', path)
    engine = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = engine
    spec.loader.exec_module(engine)
    return engine


def configure(engine):
    pool, ledger = install(engine, None, ticket_step_wait=0)
    install_quality(engine, ledger, pool)
    # Upstream logs can contain signed URLs and device identifiers. The public Node
    # adapter reports channel/status/timing; never forward raw upstream diagnostics.
    engine.log = lambda *args, **kwargs: None
    original_handler = engine.Handler

    class Handler(original_handler):
        def do_GET(self, head_only=False):
            path = urllib.parse.urlsplit(self.path).path
            if path == '/health':
                return self._send(200, json.dumps({'ready': engine.resolver_ready()}),
                                  'application/json', head_only=head_only)
            if path in ('/proxy', '/proxy.ts'):
                return super().do_GET(head_only)
            slug = path.removeprefix('/').removesuffix('.m3u8')
            if slug not in CHANNELS or path != '/' + slug + '.m3u8':
                return self._send(404, 'unknown channel', head_only=head_only)
            if head_only:
                return self._send(200, '', 'application/vnd.apple.mpegurl', head_only=True)
            resolver = engine.resolver
            if resolver is None or not engine.resolver_ready():
                return self._send(503, 'device service preparing')
            if resolver.is_channel_in_cooldown(slug):
                return self._send(503, 'device channel cooling down')
            try:
                playlist = resolver.fetch_channel_playlist(slug, self.headers['Host'], 'http')
                if not playlist or '#EXTM3U' not in playlist:
                    raise RuntimeError('no device playlist')
                return self._send(200, playlist, 'application/vnd.apple.mpegurl')
            except Exception:
                # Same channel-level failure bookkeeping as upstream, without starting
                # a second source. The original resolver controls recovery and tickets.
                with resolver.state_lock:
                    resolver.state.cache.pop(slug, None)
                    resolver.state.playlist_cache.pop(slug, None)
                    previous = resolver.state.channel_failures.get(slug)
                    count = previous[2] + 1 if previous else 1
                    resolver.state.channel_failures[slug] = (time.time(), 'device request failed', count)
                return self._send(503, 'device playback unavailable; retry later or select original source')

    engine.Handler = Handler
    server_class = engine.ThreadingHTTPServer

    class Server(server_class):
        def __init__(self, address, handler):
            super().__init__(address, handler)
            engine.server_port = self.server_address[1]
            print(json.dumps({'kind': 'listening', 'port': self.server_address[1]}), flush=True)

    engine.ThreadingHTTPServer = Server
    return pool


def main():
    data = Path(sys.argv[1]).resolve()
    os.umask(0o077)
    data.mkdir(parents=True, exist_ok=True)
    # stdin is a pipe held by the parent. This also handles a parent crash/SIGKILL.
    def owner_gone():
        sys.stdin.buffer.read()
        os._exit(0)
    threading.Thread(target=owner_gone, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    engine = load_engine()
    pool = configure(engine)
    sys.argv = [str(ROOT / 'vendor/ysp-live.py'), '0', '--bind', '127.0.0.1',
                '--data-dir', str(data), '--only-4k', '--no-engine', '--zap-debounce', '0']
    try:
        engine.main()
    finally:
        pool.close()


if __name__ == '__main__':
    main()
