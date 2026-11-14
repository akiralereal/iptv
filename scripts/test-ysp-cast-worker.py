"""No sockets, browser, credentials or official requests: exercise the worker boundary."""
import importlib.util
from pathlib import Path
import sys
import threading
import types
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'extractors/yangshipin/cast'
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('cast_worker_test', ROOT / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTest(unittest.TestCase):
    def test_device_only_routes_and_failure_bookkeeping(self):
        engine = worker.load_engine()
        pool = worker.configure(engine)
        calls = []
        state = types.SimpleNamespace(cache={}, playlist_cache={}, channel_failures={})
        resolver = types.SimpleNamespace(
            state=state, state_lock=threading.RLock(),
            is_channel_in_cooldown=lambda slug: False,
            fetch_channel_playlist=lambda slug, host, proto: calls.append(slug) or '#EXTM3U\n#EXTINF:4,\n/proxy.ts?token=test\n',
        )
        engine.resolver = resolver
        engine.resolver_ready = lambda: True
        engine.ensure_channel = lambda *args: self.fail('must never request JCE/BK fallback')
        engine.fetch_upstream_engine_playlist = lambda *args: self.fail('must never request Node fallback')
        handler = object.__new__(engine.Handler)
        handler.headers = {'Host': '127.0.0.1:12345'}
        output = []
        handler._send = lambda status, *args, **kwargs: output.append(status)
        try:
            for slug in worker.CHANNELS:
                handler.path = '/' + slug + '.m3u8'
                handler.do_GET(head_only=True)
                self.assertEqual(len(calls), 0)
            handler.path = '/cctv8k.m3u8'; handler.do_GET()
            self.assertEqual(calls, ['cctv8k']); self.assertEqual(output[-1], 200)
            for path in ['/cctv1.m3u8', '/epg.xml', '/diag', '/cctv.m3u', '/engine_proxy']:
                handler.path = path; handler.do_GET()
                self.assertEqual(output[-1], 404)
            def fail(*args):
                raise RuntimeError('private upstream information')
            resolver.fetch_channel_playlist = fail
            handler.path = '/cctv8k.m3u8'; handler.do_GET()
            self.assertEqual(output[-1], 503)
            self.assertEqual(state.channel_failures['cctv8k'][2], 1)
            resolver.is_channel_in_cooldown = lambda slug: True
            handler.do_GET()
            self.assertEqual(state.channel_failures['cctv8k'][2], 1)
        finally:
            pool.close()


if __name__ == '__main__':
    unittest.main()
