"""Small HTTP/1.1 pool: exclusive leases, complete-body reuse, no POST replay."""
from __future__ import annotations
import collections
import http.client
import select
import ssl
import threading
import time
import urllib.request
import urllib.parse


class Lease:
    def __init__(self,pool,key,connection,response,url):
        self.pool,self.key,self.connection,self.raw=pool,key,connection,response
        self.url=url;self.code=response.status;self.msg=response.reason
        self.closed=False;self.failed=False;self.exhausted=response.length==0
    def __getattr__(self,name):return getattr(self.raw,name)
    def geturl(self):return self.url
    def _read(self,method,*args):
        try:
            data=getattr(self.raw,method)(*args)
            self.exhausted=self.raw.length==0 or (not data and self.raw.isclosed())
            return data
        except BaseException:
            self.failed=True;raise
    def read(self,*args):return self._read('read',*args)
    def read1(self,*args):return self._read('read1',*args)
    def close(self):
        if self.closed:return
        self.closed=True
        reusable=self.exhausted and not self.failed and not self.raw.will_close
        try:self.raw.close()
        finally:self.pool.release(self.key,self.connection,reusable)
    def __enter__(self):return self
    def __exit__(self,*unused):self.close()


class Pool:
    def __init__(self,event=lambda *a,**kw:None,idle_seconds=10,max_idle=4,max_active=8):
        self.event=event;self.idle_seconds=idle_seconds;self.max_idle=max_idle;self.max_active=max_active
        self.lock=threading.Lock();self.idle=collections.defaultdict(list);self.limits={}
        self.context=ssl.create_default_context()
    def acquire(self,key,timeout,context):
        with self.lock:limit=self.limits.setdefault(key,threading.BoundedSemaphore(self.max_active))
        if not limit.acquire(timeout=timeout):raise TimeoutError('connection_pool_busy')
        connection=None
        with self.lock:
            while self.idle[key]:
                candidate,returned=self.idle[key].pop()
                stale=time.monotonic()-returned>self.idle_seconds or candidate.sock is None
                if not stale:
                    try:stale=bool(select.select([candidate.sock],[],[],0)[0])
                    except (OSError,ValueError):stale=True
                if stale:candidate.close()
                else:connection=candidate;break
        reused=connection is not None
        if connection is None:
            scheme,host,port,_=key
            connection=http.client.HTTPSConnection(host,port,timeout=timeout,context=context) if scheme=='https' else http.client.HTTPConnection(host,port,timeout=timeout)
        connection.timeout=timeout
        if connection.sock:connection.sock.settimeout(timeout)
        return connection,reused
    def release(self,key,connection,reusable):
        with self.lock:
            if reusable and connection.sock is not None and len(self.idle[key])<self.max_idle:
                self.idle[key].append((connection,time.monotonic()))
            else:connection.close()
            self.limits[key].release()
    def open(self,url,method='GET',headers=None,data=None,timeout=20,context=None,scope='cdn'):
        parts=urllib.parse.urlsplit(url)
        if parts.scheme not in ('http','https') or not parts.hostname or parts.username or parts.password:
            raise ValueError('invalid_http_origin')
        context=context or self.context
        key=(parts.scheme,parts.hostname,parts.port or (443 if parts.scheme=='https' else 80),id(context) if parts.scheme=='https' else None)
        timeout=timeout if isinstance(timeout,(int,float)) else 20
        target=urllib.parse.urlunsplit(('', '',parts.path or '/',parts.query,''))
        outgoing={k:v for k,v in (headers or {}).items() if k.lower()!='connection'}
        outgoing['Connection']='keep-alive'
        for attempt in range(2):
            connection,reused=self.acquire(key,timeout,context);started=time.monotonic()
            try:
                connection.request(method,target,body=data,headers=outgoing)
                response=connection.getresponse()
                self.event('http_headers',scope=scope,host=parts.hostname,method=method,status=response.status,
                           connectionReused=reused,headerMs=round((time.monotonic()-started)*1000,3))
                return Lease(self,key,connection,response,url)
            except BaseException as exc:
                self.release(key,connection,False)
                self.event('http_transport_error',scope=scope,host=parts.hostname,method=method,
                           connectionReused=reused,error=type(exc).__name__)
                # Never replay an authentication/control POST of uncertain outcome.
                if not (attempt==0 and reused and method in ('GET','HEAD') and isinstance(exc,(OSError,http.client.HTTPException))):raise
        raise RuntimeError('unreachable')
    def close(self):
        with self.lock:
            for items in self.idle.values():
                for connection,_ in items:connection.close()
            self.idle.clear()


class PooledHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self,pool):super().__init__();self.pool=pool
    def http_open(self,request):
        headers=dict(request.unredirected_hdrs)
        headers.update({k:v for k,v in request.headers.items() if k not in headers})
        return self.pool.open(request.full_url,request.get_method(),headers,request.data,request.timeout,scope='control')


class PooledHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self,pool,context):super().__init__(context=context);self.pool=pool;self.context=context
    def https_open(self,request):
        headers=dict(request.unredirected_hdrs)
        headers.update({k:v for k,v in request.headers.items() if k not in headers})
        return self.pool.open(request.full_url,request.get_method(),headers,request.data,request.timeout,self.context,scope='control')
