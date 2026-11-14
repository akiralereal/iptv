"""Prefer an explicitly advertised native 8K rendition; inspect forwarded bytes only."""
import hashlib
import json
import re
import subprocess
import threading


def rendition_info(item):
    allowed=('rate','rateName','width','height','resolution','bitrate','bitRate','codec','videoCodec')
    return {k:v for k,v in item.items() if k in allowed and isinstance(v,(str,int,float)) and len(str(v))<=100}


def is_8k(item):
    info=rendition_info(item)
    text=' '.join(str(v) for v in info.values())
    return bool(re.search(r'8\s*[kK]|7680\s*[xX*×\-]\s*4320',text) or
                str(info.get('width'))=='7680' and str(info.get('height'))=='4320')


def choose(videos,prefer_8k):
    usable=[v for v in videos if isinstance(v,dict) and isinstance(v.get('url'),str) and v['url']]
    native=[v for v in usable if is_8k(v)] if prefer_8k else []
    if native:
        def bitrate(v):
            try:return float(v.get('bitrate') or v.get('bitRate') or re.sub(r'[^\d.]','',str(v.get('rate',''))) or 0)
            except ValueError:return 0
        return max(native,key=bitrate)
    return next((v for v in usable if v.get('rate')=='36p'),usable[0] if usable else None)


def install(module,ledger,pool):
    eightk_id=module.channel_by_name('cctv8k')
    selected_info={}
    original_log=module.log
    def log(message,*args,**kwargs):
        if '[cctv8k] 直播源获取成功' in message and selected_info:
            label=f"{selected_info.get('rateName','未知')} / {selected_info.get('rate','未知')}"
            message=f'[cctv8k] 直播源获取成功（官方档位: {label}；实际分辨率以码流检测为准）'
        return original_log(message,*args,**kwargs)
    module.log=log
    original=module.Resolver.live_v1_01_flow
    def live01(self,sess,live_id):
        if live_id!=eightk_id:return original(self,sess,live_id)
        body={'screenParam':sess.screen_param,'rate':'','systemType':'ios','model':sess.cast_model,
              'id':live_id,'userId':module.DEFAULT_LIVE_USER_ID,'clientSign':'cctvVideo',
              'deviceId':{'serial':'','imei':'','android_id':''}}
        with self.control_request_slot('live_v1_01'):
            response=sess.client.post_json(module.LIVE_V1_01_URL,
                module.fresh_headers(sess.identity.headers,'application/json','application/json',None),body)
        status,text,value=module.response_json(response)
        if not 200<=status<300:raise module.YsptpError(f'live/v1/01 HTTP {status}')
        data=value.get('data') if isinstance(value,dict) else None
        videos=(data.get('videoList') or data.get('videos')) if isinstance(data,dict) else None
        if not isinstance(videos,list):raise module.YsptpError('live/v1/01 missing videos')
        selected=choose(videos,True)
        selected_info.clear();selected_info.update(rendition_info(selected) if selected else {})
        ledger.event('quality_options',channel='cctv8k',advertised=[rendition_info(v) for v in videos if isinstance(v,dict)],
                     selected=rendition_info(selected) if selected else None,
                     native8kAdvertised=any(is_8k(v) for v in videos if isinstance(v,dict)))
        if selected is None:raise module.YsptpError('live/v1/01 no usable URL')
        url=selected['url']
        if not url.startswith(('http://','https://')):url=module.aes_gcm_decrypt_b64(url,sess.session_key)
        return module.Live01Result(live_url=url,
            rate=selected.get('rate') if isinstance(selected.get('rate'),str) else '',
            rate_name=selected.get('rateName') if isinstance(selected.get('rateName'),str) else '')
    module.Resolver.live_v1_01_flow=live01
