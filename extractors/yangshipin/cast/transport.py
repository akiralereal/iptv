"""Opt-in transport and pacing changes around unchanged upstream playback code."""
from __future__ import annotations
import collections
import contextlib
import hashlib
import http.cookiejar
import json
from pathlib import Path
import re
import threading
import time
import urllib.parse
import urllib.request

from pool import Pool,PooledHTTPHandler,PooledHTTPSHandler


class Ledger:
    def __init__(self,path):
        self.path=Path(path) if path else None
        if self.path:self.path.parent.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock();self.segments=collections.OrderedDict();self.published={};self.sequence=0
    def event(self,kind,**data):
        if self.path is None:return
        with self.lock:
            with self.path.open('a') as f:f.write(json.dumps({'at':time.time(),'kind':kind,**data},ensure_ascii=False)+'\n')
    def note_playlist(self,module,entry,body):
        match=re.search(r'^#EXT-X-MEDIA-SEQUENCE:(\d+)',body,re.M);sequence=int(match[1]) if match else 0
        ticket={'channel':entry.channel,'ticketGeneration':entry.generation,'ticketIssuedAt':entry.refreshed_at,
                'ticketUrlFingerprint':hashlib.sha256(entry.final_url.encode()).hexdigest()}
        with self.lock:
            for line in body.splitlines():
                if not line.strip() or line.startswith('#'):continue
                try:
                    token=module.proxy_ts_token(line)
                    if token:
                        url=module.decode_proxy_ts_url(token)
                        self.segments[hashlib.sha256(url.encode()).hexdigest()]={**ticket,'upstreamSequence':sequence}
                except (ValueError,module.YsptpError):pass
                sequence+=1
            while len(self.segments)>10000:self.segments.popitem(last=False)
    def sent(self,url,phase,size,cached,status,complete_segment=False):
        fingerprint=hashlib.sha256(url.encode()).hexdigest()
        with self.lock:
            provenance=self.segments.get(fingerprint)
            self.event('segment_http',status=status,bytes=size,cached=cached,phase=phase,
                       completeSegment=complete_segment,requestFingerprint=fingerprint,
                       provenance=provenance)
            if cached or not (status==200 or complete_segment) or not provenance or not size:return
            key=(fingerprint,provenance['ticketUrlFingerprint'])
            if key not in self.published:
                self.published[key]=self.sequence;self.sequence+=1
                self.event('published',sequence=self.published[key],family='device',**provenance)
            self.event('segment_served',sequence=self.published[key],phase=phase,bytes=size,**provenance)


def install(module,event_path,ticket_step_wait=1.0):
    if ticket_step_wait not in (0,1):raise ValueError('ticket step wait must be 0 or 1 second')
    ledger=Ledger(event_path);pool=Pool(ledger.event)
    original_init=module.HttpClient.__init__
    def client_init(self,timeout,insecure_tls):
        original_init(self,timeout,insecure_tls)
        self._opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(self._jar),PooledHTTPHandler(pool),PooledHTTPSHandler(pool,self._ctx))
    module.HttpClient.__init__=client_init

    original_resolver_init=module.Resolver.__init__
    def resolver_init(self,args):
        original_resolver_init(self,args)
        self._pace_lock=threading.Lock();self._pace_last_start=0;self._pace_last_end=0;self._conservative_until=0
        self._ticket_context=threading.local()
    module.Resolver.__init__=resolver_init
    @contextlib.contextmanager
    def control_slot(self,label):
        with self.control_lock,self._pace_lock:
            interval=max(0,float(self.args.refresh_interval))
            context=getattr(self,'_ticket_context',None)
            previous=getattr(context,'previous',None)
            inside=getattr(context,'active',False)
            expected={'live_v1_02':'live_v1_01','vdn_getstream':'live_v1_02'}
            conservative=time.monotonic()<self._conservative_until
            # Only shorten the two ordered gaps within this thread's ticket flow.
            # Bootstrap, heartbeat, the first step and failure backoff retain pacing.
            if inside and not conservative and expected.get(label)==previous and label in expected:
                interval=min(interval,ticket_step_wait)
            reference=self._pace_last_end if time.monotonic()<self._conservative_until else self._pace_last_start
            wait=max(0,interval-(time.monotonic()-reference)) if reference else 0
            if wait:time.sleep(wait)
            jitter=self.control_step_jitter_duration()
            if jitter:time.sleep(jitter)
            started=time.monotonic();self._pace_last_start=started
            try:yield
            except BaseException:
                self._conservative_until=time.monotonic()+60
                raise
            finally:
                self._pace_last_end=time.monotonic()
                with self.state_lock:self.state.last_control_request_at=time.time()
                if context is not None and inside:context.previous=label
                ledger.event('control_step',step=label,waitMs=round(wait*1000,3),
                             requestMs=round((time.monotonic()-started)*1000,3),
                             ticketInternalStep=bool(inside and label in expected),conservative=conservative)
    module.Resolver.control_request_slot=control_slot
    original_resolve=module.Resolver.resolve_channel_once
    def resolve(self,*args,**kwargs):
        old=(getattr(self._ticket_context,'active',False),getattr(self._ticket_context,'previous',None))
        self._ticket_context.active=True;self._ticket_context.previous=None
        try:return original_resolve(self,*args,**kwargs)
        except module.YsptpError:
            self._conservative_until=time.monotonic()+60
            ledger.event('pacing_backoff',seconds=60)
            raise
        finally:self._ticket_context.active,self._ticket_context.previous=old
    module.Resolver.resolve_channel_once=resolve

    def manifest(url,headers):
        current=url
        for _ in range(4):
            try:
                with pool.open(current,headers=module._playback_request_headers(headers),scope='manifest') as response:
                    status=response.status;location=response.getheader('Location')
                    content=response.getheader('Content-Type') or 'application/vnd.apple.mpegurl'
                    body=response.read()
            except Exception as exc:raise module.YsptpError(module._normalize_network_error(exc))
            if status in (301,302,303,307,308) and location:
                current=urllib.parse.urljoin(current,location);continue
            return status,content,body.decode('utf-8',errors='replace')
        raise module.YsptpError('too many redirects fetching playlist')
    module.fetch_playlist_http1=manifest
    original_playlist=module.Resolver.fetch_playlist
    def playlist(self,entry,*args,**kwargs):
        result=original_playlist(self,entry,*args,**kwargs)
        ledger.note_playlist(module,entry,result[0]);return result
    module.Resolver.fetch_playlist=playlist

    original_handler=module.Handler
    class Handler(original_handler):
        def do_GET(self,head_only=False):
            path=urllib.parse.urlsplit(self.path).path
            if path not in ('/proxy.ts','/proxy'):return super().do_GET(head_only)
            committed=False
            try:
                token=module.proxy_ts_token(self.path)
                if not token:return self._send(400,'missing proxy ts token\n',head_only=head_only)
                try:url=module.decode_proxy_ts_url(token)
                except module.YsptpError:return self._send(400,'invalid proxy ts token\n',head_only=head_only)
                range_value=self.headers.get('Range');phase=self.headers.get('X-TVLab-Phase','external')
                cached=module.global_ts_cache.get(url) if not range_value else None
                if cached is not None:
                    body,headers=cached
                    self.send_response(200)
                    for key,value in headers.items():self.send_header(key,value)
                    self.send_header('X-Cache','HIT-RAM');self.send_header('Access-Control-Allow-Origin','*')
                    self.send_header('Cache-Control','public, max-age=300');self.end_headers();committed=True
                    if not head_only:self.wfile.write(body);ledger.sent(url,phase,len(body),True,200)
                    return
                try:headers=module.resolver.playback_headers_for_ts_url(url) if module.resolver else {}
                except module.YsptpError:return self._send(500,'missing playback headers\n',head_only=head_only)
                extra={'Range':module.header_value_clean(range_value)} if range_value else {}
                with pool.open(url,method='HEAD' if head_only else 'GET',headers=module._playback_request_headers(headers,extra),timeout=30,scope='segment') as response:
                    passed={k:v for k,v in response.getheaders() if k.lower() in ('content-type','content-range','accept-ranges','content-length','location')}
                    self.send_response(response.status)
                    for key,value in passed.items():self.send_header(key,value)
                    self.send_header('X-Cache','MISS-UPSTREAM');self.send_header('Access-Control-Allow-Origin','*')
                    self.send_header('Cache-Control','public, max-age=300');self.end_headers();committed=True
                    if head_only:return
                    buffer=bytearray();oversized=False;size=0
                    while True:
                        chunk=response.read1(65536)
                        if not chunk:break
                        self.wfile.write(chunk);size+=len(chunk)
                        if response.status==200 and not oversized:
                            if len(buffer)+len(chunk)<=35*1024*1024:buffer.extend(chunk)
                            else:oversized=True;buffer.clear()
                    expected=response.getheader('Content-Length')
                    if expected is not None and size!=int(expected):raise OSError('incomplete_segment')
                    if response.status==200 and buffer and not oversized:
                        module.global_ts_cache.set(url,bytes(buffer),passed)
                    full_range=False
                    if response.status==206:
                        match=re.fullmatch(r'bytes 0-(\d+)/(\d+)',response.getheader('Content-Range',''))
                        full_range=bool(match and int(match[1])+1==int(match[2])==size)
                    ledger.sent(url,phase,size,False,response.status,full_range)
            except (BrokenPipeError,ConnectionResetError):
                ledger.event('client_disconnect',route='segment')
                self.close_connection=True
            except Exception as exc:
                ledger.event('segment_error',error=type(exc).__name__)
                self.close_connection=True
                if not committed:self._send(502,'upstream segment request failed\n',head_only=head_only)
    module.Handler=Handler
    ledger.event('optimization_enabled',nonTicketStepSpacingSeconds=1,ticketStepWaitSeconds=ticket_step_wait,postFailureConservativeSeconds=60,
                 changedTicketTtl=False,connectionPool=True,oldRecoveryBridge=False)
    return pool,ledger
