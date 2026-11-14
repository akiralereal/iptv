from __future__ import annotations 
import argparse 
import atexit 
import base64 
import binascii 
import collections 
import contextlib 
import dataclasses 
import datetime 
import gzip 
import hashlib 
import hmac as _hmac 
import http .client 
import http .cookiejar 
from http .server import BaseHTTPRequestHandler ,ThreadingHTTPServer 
import json 
import math 
import os 
import random 
import re 
import secrets 
import shutil 
import signal 
import socket 
import ssl 
import struct 
import sys 
import threading 
import time 
import urllib .error 
import urllib .parse 
import urllib .request 
import uuid 
from collections import deque 
urllib .request .install_opener (urllib .request .build_opener (urllib .request .ProxyHandler ({}))) 
try:
    from epg_agg import EpgAggregator
    _HAS_EPG = True
except ImportError:
    _HAS_EPG = False
    EpgAggregator = None
__version__ ='9.5.0'
AUTHOR_COMMUNITY ='https://t.me/garysclub'
AUTHOR_CHANNEL ='https://t.me/garysclubchannel'
AUTHOR_NOTICE =f'''📢 首发地址
社区：Gary's Club ({AUTHOR_COMMUNITY})
频道：Gary's Club Channel ({AUTHOR_CHANNEL})
⚠️ 其他任何分发渠道均非作者本人！'''
AK ='9f5c54c4ed0e50109b800f7e28fec205'
RSA_PUBLIC_KEY_B64 ='MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkKeLy4ywWLSnBkwRyqYgF3HMIj05V5uuh5HjyEsZOWnu1NHu3jPQv3sr32wwQNYv5qapsNXmNgLUDHtgHZxqPQAYXltjSRc0qhcD286t62wOIHId8zXS3s1Jy4rgU4qjQWzI9rp/1sE0pMsmwTaJa4zuJ5iz8VwF8Av5oJ1k+HxY+/HLnjNlW1hmWLpuDYmkZYuAoTHa1VGeHQh9FEKI8ZcL3GTQphShUoC+Kg3P1hGUVTtCYapmzPS5lkAdwebuzwvTCfGiTErYZCnPBUSeV7BVlgjtLYIi29KvF0a8FHsJMfe/UdHcyW/RihsIYOtDQcRRpFGXyPXbVrzFJse24QIDAQAB'
CLOUD_GET_URL ='https://ytpcloudws.cctv.cn/cloudps/wssapi/device/v2/get'
CLOUD_REGISTER_URL ='https://ytpcloudws.cctv.cn/cloudps/wssapi/device/v2/register'
APP_START_URL ='https://ytpaddr.cctv.cn/gsnw/api/app/start/v1/01'
DRM_CONFIG_URL ='https://ytpaddr.cctv.cn/gsnw/drm/config/obtain/v1'
VERSION_CONFIG_URL ='https://ytpaddr.cctv.cn/gsnw/version/config/obtain/v1'
DICTIONARY_URL ='https://ytpaddr.cctv.cn/gsnw/player/dictionary/obtain/v1'
INDEX_URL ='https://ytpaddr.cctv.cn/gsnw/api/index/v1/01'
REPORT_SINGLE_URL ='https://ytpdata.cctv.cn/das/app/data/message/single'
COLLECT_REPORT_URL ='https://collect.cctv.cn/cctvmobileinf/rest/cctv/receive/new/app'
LIVE_V1_01_URL ='https://ytpaddr.cctv.cn/gsnw/api/live/v1/01'
LIVE_V1_02_URL ='https://ytpaddr.cctv.cn/gsnw/api/live/v1/02'
VDN_GETSTREAM_URL ='https://ytpvdn.cctv.cn/cctvmobileinf/rest/cctv/videoliveUrl/getstream'
DEFAULT_LIVE_USER_ID ='BAEBFF2B-C516-4F34-ABC0-A824A6461CBD'
DEFAULT_DEVICE_NAME ='央视频电视投屏助手'
VDN_APP_NAME ='央视频电视投屏助手'
REPORT_APP_KEY ='1178c84d-4818-44ff-b415-02106e87e144'
COLLECT_SDK_VERSION ='1.0.0'
DEFAULT_PAGE_NAME ='com.cctv.tv.mvp.ui.activity.MainActivity'
DEFAULT_ACCEPT_LANGUAGE ='zh-CN,zh;q=0.8'
RESULT_OK =0 
RESULT_NEEDS_REGISTER =601 
RESULT_GET_MISSING_OR_INVALID =2 
RESULT_REGISTERED_ELSEWHERE =694 
RESULT_REGISTER_RETRY_LATER =695 
_SBOX =(99 ,124 ,119 ,123 ,242 ,107 ,111 ,197 ,48 ,1 ,103 ,43 ,254 ,215 ,171 ,118 ,202 ,130 ,201 ,125 ,250 ,89 ,71 ,240 ,173 ,212 ,162 ,175 ,156 ,164 ,114 ,192 ,183 ,253 ,147 ,38 ,54 ,63 ,247 ,204 ,52 ,165 ,229 ,241 ,113 ,216 ,49 ,21 ,4 ,199 ,35 ,195 ,24 ,150 ,5 ,154 ,7 ,18 ,128 ,226 ,235 ,39 ,178 ,117 ,9 ,131 ,44 ,26 ,27 ,110 ,90 ,160 ,82 ,59 ,214 ,179 ,41 ,227 ,47 ,132 ,83 ,209 ,0 ,237 ,32 ,252 ,177 ,91 ,106 ,203 ,190 ,57 ,74 ,76 ,88 ,207 ,208 ,239 ,170 ,251 ,67 ,77 ,51 ,133 ,69 ,249 ,2 ,127 ,80 ,60 ,159 ,168 ,81 ,163 ,64 ,143 ,146 ,157 ,56 ,245 ,188 ,182 ,218 ,33 ,16 ,255 ,243 ,210 ,205 ,12 ,19 ,236 ,95 ,151 ,68 ,23 ,196 ,167 ,126 ,61 ,100 ,93 ,25 ,115 ,96 ,129 ,79 ,220 ,34 ,42 ,144 ,136 ,70 ,238 ,184 ,20 ,222 ,94 ,11 ,219 ,224 ,50 ,58 ,10 ,73 ,6 ,36 ,92 ,194 ,211 ,172 ,98 ,145 ,149 ,228 ,121 ,231 ,200 ,55 ,109 ,141 ,213 ,78 ,169 ,108 ,86 ,244 ,234 ,101 ,122 ,174 ,8 ,186 ,120 ,37 ,46 ,28 ,166 ,180 ,198 ,232 ,221 ,116 ,31 ,75 ,189 ,139 ,138 ,112 ,62 ,181 ,102 ,72 ,3 ,246 ,14 ,97 ,53 ,87 ,185 ,134 ,193 ,29 ,158 ,225 ,248 ,152 ,17 ,105 ,217 ,142 ,148 ,155 ,30 ,135 ,233 ,206 ,85 ,40 ,223 ,140 ,161 ,137 ,13 ,191 ,230 ,66 ,104 ,65 ,153 ,45 ,15 ,176 ,84 ,187 ,22 )
_RCON =(1 ,2 ,4 ,8 ,16 ,32 ,64 ,128 ,27 ,54 )
def _xtime (a :int )->int :
    return (a <<1 ^283 )&255 if a &128 else a <<1 &255 
def _aes256_key_schedule (key :bytes ):
    assert len (key )==32 
    w =[int .from_bytes (key [i :i +4 ],'big')for i in range (0 ,32 ,4 )]
    for i in range (8 ,60 ):
        temp =w [i -1 ]
        if i %8 ==0 :
            temp =_SBOX [temp >>16 &255 ]<<24 |_SBOX [temp >>8 &255 ]<<16 |_SBOX [temp &255 ]<<8 |_SBOX [temp >>24 &255 ]
            temp ^=_RCON [i //8 -1 ]<<24 
        elif i %8 ==4 :
            temp =_SBOX [temp >>24 &255 ]<<24 |_SBOX [temp >>16 &255 ]<<16 |_SBOX [temp >>8 &255 ]<<8 |_SBOX [temp &255 ]
        w .append (w [i -8 ]^temp )
    return [b''.join ((word .to_bytes (4 ,'big')for word in w [i :i +4 ]))for i in range (0 ,60 ,4 )]
def _add_round_key (state ,rk :bytes ):
    for i in range (16 ):
        state [i ]^=rk [i ]
def _sub_bytes (state ):
    for i in range (16 ):
        state [i ]=_SBOX [state [i ]]
def _shift_rows (s ):
    s [1 ],s [5 ],s [9 ],s [13 ]=(s [5 ],s [9 ],s [13 ],s [1 ])
    s [2 ],s [6 ],s [10 ],s [14 ]=(s [10 ],s [14 ],s [2 ],s [6 ])
    s [3 ],s [7 ],s [11 ],s [15 ]=(s [15 ],s [3 ],s [7 ],s [11 ])
def _mix_columns (s ):
    for c in range (4 ):
        a0 ,a1 ,a2 ,a3 =(s [4 *c ],s [4 *c +1 ],s [4 *c +2 ],s [4 *c +3 ])
        s [4 *c ]=_xtime (a0 )^(_xtime (a1 )^a1 )^a2 ^a3 
        s [4 *c +1 ]=a0 ^_xtime (a1 )^(_xtime (a2 )^a2 )^a3 
        s [4 *c +2 ]=a0 ^a1 ^_xtime (a2 )^(_xtime (a3 )^a3 )
        s [4 *c +3 ]=_xtime (a0 )^a0 ^a1 ^a2 ^_xtime (a3 )
def _aes256_encrypt_block_rk (rk :list ,block :bytes )->bytes :
    s =bytearray (block )
    _add_round_key (s ,rk [0 ])
    for rnd in range (1 ,14 ):
        _sub_bytes (s )
        _shift_rows (s )
        _mix_columns (s )
        _add_round_key (s ,rk [rnd ])
    _sub_bytes (s )
    _shift_rows (s )
    _add_round_key (s ,rk [14 ])
    return bytes (s )
def aes256_encrypt_block (key :bytes ,block :bytes )->bytes :
    return _aes256_encrypt_block_rk (_aes256_key_schedule (key ),block )
def _gf_mult (x :int ,y :int )->int :
    r =299076299051606071403356588563077529600 
    z =0 
    v =y 
    for _ in range (128 ):
        if x &170141183460469231731687303715884105728 :
            z ^=v 
        if v &1 :
            v =v >>1 ^r 
        else :
            v >>=1 
        x =x <<1 &340282366920938463463374607431768211455 
    return z 
def _ghash (h :int ,aad :bytes ,ct :bytes )->int :
    x =0 
    def _blocks (data :bytes ):
        for i in range (0 ,len (data ),16 ):
            blk =data [i :i +16 ]
            if len (blk )<16 :
                blk =blk +b'\x00'*(16 -len (blk ))
            yield int .from_bytes (blk ,'big')
    for b in _blocks (aad ):
        x =_gf_mult (x ^b ,h )
    for b in _blocks (ct ):
        x =_gf_mult (x ^b ,h )
    lens =len (aad )*8 <<64 |len (ct )*8 
    x =_gf_mult (x ^lens ,h )
    return x 
def _inc32 (block :bytes )->bytes :
    ctr =int .from_bytes (block [12 :],'big')
    return block [:12 ]+(ctr +1 &4294967295 ).to_bytes (4 ,'big')
def _gctr_rk (rk :list ,icb :bytes ,data :bytes )->bytes :
    out =bytearray ()
    cb =icb 
    for i in range (0 ,len (data ),16 ):
        ks =_aes256_encrypt_block_rk (rk ,cb )
        chunk =data [i :i +16 ]
        out +=bytes ((a ^b for a ,b in zip (chunk ,ks )))
        cb =_inc32 (cb )
    return bytes (out )
def _gctr (key :bytes ,icb :bytes ,data :bytes )->bytes :
    return _gctr_rk (_aes256_key_schedule (key ),icb ,data )
def aes_gcm_encrypt (key :bytes ,nonce :bytes ,plaintext :bytes ,aad :bytes =b'')->bytes :
    assert len (key )==32 and len (nonce )==12 
    rk =_aes256_key_schedule (key )
    h =int .from_bytes (_aes256_encrypt_block_rk (rk ,b'\x00'*16 ),'big')
    j0 =nonce +b'\x00\x00\x00\x01'
    ct =_gctr_rk (rk ,_inc32 (j0 ),plaintext )
    s =_ghash (h ,aad ,ct ).to_bytes (16 ,'big')
    tag =bytes ((a ^b for a ,b in zip (_aes256_encrypt_block_rk (rk ,j0 ),s )))
    return ct +tag 
def aes_gcm_decrypt (key :bytes ,nonce :bytes ,ct_and_tag :bytes ,aad :bytes =b'')->bytes :
    if len (ct_and_tag )<16 :
        raise ValueError ('AES-GCM payload too short')
    ct ,tag =(ct_and_tag [:-16 ],ct_and_tag [-16 :])
    rk =_aes256_key_schedule (key )
    h =int .from_bytes (_aes256_encrypt_block_rk (rk ,b'\x00'*16 ),'big')
    j0 =nonce +b'\x00\x00\x00\x01'
    s =_ghash (h ,aad ,ct ).to_bytes (16 ,'big')
    expect =bytes ((a ^b for a ,b in zip (_aes256_encrypt_block_rk (rk ,j0 ),s )))
    if not _hmac .compare_digest (tag ,expect ):
        raise ValueError ('AES-GCM decrypt failed')
    return _gctr_rk (rk ,_inc32 (j0 ),ct )
def _mgf1_sha256 (seed :bytes ,length :int )->bytes :
    out =bytearray ()
    counter =0 
    while len (out )<length :
        out +=hashlib .sha256 (seed +counter .to_bytes (4 ,'big')).digest ()
        counter +=1 
    return bytes (out [:length ])
def _oaep_encode_sha256 (message :bytes ,k :int ,seed :bytes )->bytes :
    hlen =32 
    if len (message )>k -2 *hlen -2 :
        raise ValueError ('OAEP message too long')
    lhash =hashlib .sha256 (b'').digest ()
    ps =b'\x00'*(k -len (message )-2 *hlen -2 )
    db =lhash +ps +b'\x01'+message 
    db_mask =_mgf1_sha256 (seed ,k -hlen -1 )
    masked_db =bytes ((a ^b for a ,b in zip (db ,db_mask )))
    seed_mask =_mgf1_sha256 (masked_db ,hlen )
    masked_seed =bytes ((a ^b for a ,b in zip (seed ,seed_mask )))
    return b'\x00'+masked_seed +masked_db 
def _der_read_tlv (der :bytes ,pos :int ):
    assert der [pos ]==48 ,'expected SEQUENCE'
    pos +=1 
    ln ,pos =_der_read_len (der ,pos )
    end =pos +ln 
    items =[]
    while pos <end :
        tag =der [pos ]
        pos +=1 
        ln2 ,pos =_der_read_len (der ,pos )
        items .append ((tag ,der [pos :pos +ln2 ]))
        pos +=ln2 
    return items 
def _der_read_len (der :bytes ,pos :int ):
    first =der [pos ]
    pos +=1 
    if first &128 ==0 :
        return (first ,pos )
    n =first &127 
    return (int .from_bytes (der [pos :pos +n ],'big'),pos +n )
def _der_read_int (raw :bytes )->int :
    return int .from_bytes (raw ,'big')
def parse_spki_rsa_pubkey (der :bytes ):
    outer =_der_read_tlv (der ,0 )
    bitstring =outer [1 ][1 ]
    assert bitstring [0 ]==0 
    inner =_der_read_tlv (bitstring [1 :],0 )
    n =_der_read_int (inner [0 ][1 ])
    e =_der_read_int (inner [1 ][1 ])
    return (n ,e )
def rsa_oaep_sha256_encrypt (der :bytes ,message :bytes ,seed :bytes )->bytes :
    n ,e =parse_spki_rsa_pubkey (der )
    k =(n .bit_length ()+7 )//8 
    em =_oaep_encode_sha256 (message ,k ,seed )
    m =int .from_bytes (em ,'big')
    c =pow (m ,e ,n )
    return c .to_bytes (k ,'big')
class YsptpError (Exception ):
    pass 
def now_f64 ()->float :
    return time .time ()
def current_time_ms ()->int :
    return int (now_f64 ()*1000.0 )
def rust_round (x :float )->float :
    return math .floor (x +0.5 )
def sha1_upper (value :str )->str :
    return hashlib .sha1 (value .encode ('utf-8')).hexdigest ().upper ()
def sha256_hex (value :str )->str :
    return hashlib .sha256 (value .encode ('utf-8')).hexdigest ()
def md5_hex (value :str )->str :
    return hashlib .md5 (value .encode ('utf-8')).hexdigest ()
global_log_ring =collections .deque (maxlen =120 )
_log_lock =threading .Lock ()
_last_log_times ={}
def log (msg ,min_interval =0.0 ):
    now =time .time ()
    clean_msg =str (msg ).strip ()
    if not clean_msg :
        return 
    with _log_lock :
        interval =min_interval if min_interval >0.0 else 1.5 
        last_t =_last_log_times .get (clean_msg ,0.0 )
        if now -last_t <interval :
            return 
        _last_log_times [clean_msg ]=now 
        if len (_last_log_times )>600 :
            _last_log_times .clear ()
        line ='[%s] %s'%(time .strftime ('%H:%M:%S'),clean_msg )
        global_log_ring .append (line )
    print (line ,flush =True )
def java_string_hashcode (value :str )->int :
    h =0 
    for ch in value :
        h =h *31 +ord (ch )&4294967295 
    return h -4294967296 if h &2147483648 else h 
def java_uuid_from_hashes (msb_hash :int ,lsb_hash :int )->str :
    msb =msb_hash &18446744073709551615 
    lsb =lsb_hash &18446744073709551615 
    return f'{msb <<64 |lsb :032x}'
def native_day0_ms (now_s :int )->int :
    return 86400000 *((now_s +28800 )//86400 )-28800000 
def compute_fingerprint (x_uid :str ,now_ms :int ):
    day0_ms =native_day0_ms (now_ms //1000 )
    first =sha256_hex (f'{AK }{x_uid }{now_ms }{day0_ms }')
    return (sha256_hex (first ),now_ms ,day0_ms )
def random_hex_string (length :int )->str :
    return ''.join ((secrets .choice ('0123456789abcdef')for _ in range (length )))
def random_mac_address ()->str :
    raw =bytearray (secrets .token_bytes (6 ))
    raw [0 ]=(raw [0 ]|2 )&254 
    return ':'.join ((f'{b :02x}'for b in raw ))
def sanitize_profile_id (value :str )->str :
    out =[]
    last_underscore =False 
    for ch in value :
        if ch .isascii ()and ch .isalnum ():
            out .append (ch .lower ())
            last_underscore =False 
        elif not last_underscore :
            out .append ('_')
            last_underscore =True 
    return ''.join (out ).strip ('_')
def resolution_from_screen_param (screen_param :str )->str :
    parts =screen_param .split ('-')
    if len (parts )>=2 and parts [0 ]and parts [1 ]:
        return f'{parts [0 ]}*{parts [1 ]}'
    return '3840*2160'
def channels ():
    return [('cctv1','Live1717729995180256'),('cctv2','Live1718261577870260'),('cctv3','Live1718261955077261'),('cctv4','Live1718276148119264'),('cctv5','Live1719474204987287'),('cctv5p','Live1719473996025286'),('cctv7','Live1718276412224269'),('cctv8','Live1718276458899270'),('cctv9','Live1718276503187272'),('cctv10','Live1718276550002273'),('cctv11','Live1718276603690275'),('cctv12','Live1718276623932276'),('cctv13','Live1718276575708274'),('cctv14','Live1718276498748271'),('cctv15','Live1718276319614267'),('cctv16','Live1718276256572265'),('cctv17','Live1718276138318263'),('cctv4k','Live1767871224782105'),('cctv8k','Live1688400593818102'),('cctv164k','Live1704966749996185'),('cgtn','Live1719392219423280'),('cgtnfr','Live1719392670442283'),('cgtnru','Live1719392779653284'),('cgtnar','Live1719392885692285'),('cgtnes','Live1719392560433282'),('cgtndoc','Live1719392360336281')]
def channel_by_name (name :str ):
    for c ,live_id in channels ():
        if c ==name :
            return live_id 
    return None 
def has_http_400 (lower :str )->bool :
    return 'http 400'in lower or 'status=400'in lower 
def is_session_core_http_400 (lower :str )->bool :
    return has_http_400 (lower )and any ((needle in lower for needle in ('app/start','live/v1/01','live/v1/02','vdn','heartbeat')))
def is_control_plane_http_400 (lower :str )->bool :
    return has_http_400 (lower )and any ((needle in lower for needle in ('app/start','dictionary','app event','page event','cloud_get','cloud get','cloud_register','cloud register','device info','heartbeat','index','drm config','version config','live/v1/01','live/v1/02','vdn','collect report')))
def is_session_invalidating_error (message :str )->bool :
    lower =message .lower ()
    return 'app/start'in lower or 'decrypt'in lower or 'session_key'in lower or ('missing encrypted session key'in lower )or is_session_core_http_400 (lower )or ('live/v1/01 http 400'in lower )or ('live/v1/01 http 401'in lower )or ('live/v1/01 http 403'in lower )or ('live/v1/02 http 400'in lower )or ('live/v1/02 http 401'in lower )or ('live/v1/02 http 403'in lower )or ('vdn http 400'in lower )or ('vdn http 401'in lower )or ('vdn http 403'in lower )or ('内部错误'in lower )or ('no usable url'in lower )or ('missing videos'in lower )
def is_identity_recoverable_error (message :str )->bool :
    lower =message .lower ()
    return is_session_invalidating_error (message )or is_control_plane_http_400 (lower )or 'upstream m3u8 http 400'in lower or ('upstream m3u8 http 401'in lower )or ('upstream m3u8 http 403'in lower )or ('upstream m3u8 http 404'in lower )or ('playlist response missing'in lower )or ('invalid playlist status'in lower )or ('connection reset'in lower )or ('connection refused'in lower )or ('operation timed out'in lower )or ('timed out'in lower )or ('network is unreachable'in lower )or ('nodename nor servname'in lower )or ('failed to lookup address'in lower )
def normalize_channel (raw :str )->str :
    key =raw .strip ().strip ('/').lower ()
    if key .endswith ('.m3u8'):
        key =key [:-len ('.m3u8')]
    if key in ('cctv16-4k','cctv16_4k','cctv16/4k','cctv16(4k)'):
        return 'cctv164k'
    return key 
TRUE_4K_CHANNELS ={'cctv4k','cctv8k','cctv164k'}
@dataclasses .dataclass 
class DeviceProfile :
    android_id :str =''
    mac :str =''
    hardware :str =''
    board :str =''
    brand :str =''
    device :str =''
    manufacturer :str =''
    model :str =''
    product :str =''
    tags :str =''
    build_type :str =''
    user :str =''
    resolution :str =''
    display :str =''
    version_id :str =''
    host :str =''
    fingerprint :str =''
    report_model :str =''
    @classmethod 
    def from_dict (cls ,d :dict )->'DeviceProfile':
        return cls (**{f .name :str (d .get (f .name ,''))for f in dataclasses .fields (cls )})
@dataclasses .dataclass 
class DeviceState :
    schema_version :int =1 
    profile_source :str =''
    profile :DeviceProfile =dataclasses .field (default_factory =DeviceProfile )
    screen_param :str =''
    cast_model :str =''
    x_uid :str =''
    cloud_guid :str =''
    registered_at :float =0.0 
    updated_at :float =0.0 
@dataclasses .dataclass 
class Identity :
    x_uid :str =''
    x_fingerprint :str =''
    fingerprint_timestamp_ms :int =0 
    headers :dict =dataclasses .field (default_factory =dict )
@dataclasses .dataclass 
class ChannelEntry :
    channel :str =''
    live_id :str =''
    final_url :str =''
    playback_headers :dict =dataclasses .field (default_factory =dict )
    android_id :str =''
    x_uid :str =''
    rate :str =''
    rate_name :str =''
    raw_live_host :str =''
    final_host :str =''
    refreshed_at :float =0.0 
    expires_at :float =0.0 
    generation :int =0 
    last_refresh_error :str =''
    last_refresh_failed_at :float =0.0 
    session_generation :int =0 
    def fresh (self ,now :float )->bool :
        return bool (self .final_url )and now <self .expires_at 
    def stale_usable (self ,now :float ,ttl :float )->bool :
        return bool (self .final_url )and ttl >0.0 and (now <self .expires_at +ttl )
    @classmethod 
    def from_dict (cls ,d :dict )->'ChannelEntry':
        kwargs ={}
        for f in dataclasses .fields (cls ):
            v =d .get (f .name ,f .default if f .default is not dataclasses .MISSING else None )
            if f .name =='playback_headers':
                v =dict (v )if isinstance (v ,dict )else {}
            kwargs [f .name ]=v 
        return cls (**kwargs )
@dataclasses .dataclass 
class PlaylistCacheEntry :
    body :str =''
    content_type :str =''
    cached_at :float =0.0 
    expires_at :float =0.0 
    final_url :str =''
    android_id :str =''
    proxy_origin :str =''
    proxy_prefix :str =''
@dataclasses .dataclass 
class PlaylistCacheProbe :
    state :str =''
    age_ms :int |None =None 
@dataclasses .dataclass 
class AppStartResult :
    session_key :str =''
@dataclasses .dataclass 
class Live01Result :
    live_url :str =''
    rate :str =''
    rate_name :str =''
@dataclasses .dataclass 
class VdnGetStreamResult :
    final_url :str =''
    app_sign :str =''
    app_random_str :str =''
def inspect_playlist_cache (cached ,entry :ChannelEntry ,proxy_origin :str ,proxy_prefix ,now :float )->PlaylistCacheProbe :
    if cached is None :
        return PlaylistCacheProbe (state ='miss:not_found',age_ms =None )
    age_ms =int (rust_round (max (0.0 ,now -cached .cached_at )*1000.0 ))
    fresh =now <cached .expires_at 
    same_final_url =cached .final_url ==entry .final_url 
    same_android_id =cached .android_id ==entry .android_id 
    same_origin =cached .proxy_origin ==proxy_origin 
    same_prefix =cached .proxy_prefix ==(proxy_prefix or '')
    if fresh and same_final_url and same_android_id and same_origin and same_prefix :
        return PlaylistCacheProbe (state ='hit',age_ms =age_ms )
    reasons =[]
    if not fresh :
        reasons .append ('expired')
    if not same_final_url :
        reasons .append ('final_url_changed')
    if not same_android_id :
        reasons .append ('android_id_changed')
    if not same_origin :
        reasons .append ('origin_changed')
    if not same_prefix :
        reasons .append ('prefix_changed')
    if not reasons :
        reasons .append ('unknown')
    return PlaylistCacheProbe (state ='miss:'+'+'.join (reasons ),age_ms =age_ms )
DEVICE_PROFILE_POOL =[{'source':'sony_8k_pool.XR-85Z9K','brand':'Sony','manufacturer':'Sony','model':'XR-85Z9K','report_model':'XR85Z9K','hardware':'mt5895','board':'mt5895','version_id':'SONYTV.2022.XR_85Z9K','screen_param':'7680-4320-280','cast_model':'XR-85Z9K'},{'source':'sony_8k_pool.XR-75Z9K','brand':'Sony','manufacturer':'Sony','model':'XR-75Z9K','report_model':'XR75Z9K','hardware':'mt5895','board':'mt5895','version_id':'SONYTV.2022.XR_75Z9K','screen_param':'7680-4320-260','cast_model':'XR-75Z9K'},{'source':'sony_8k_pool.XR-85Z9J','brand':'Sony','manufacturer':'Sony','model':'XR-85Z9J','report_model':'XR85Z9J','hardware':'mt5895','board':'mt5895','version_id':'SONYTV.2021.XR_85Z9J','screen_param':'7680-4320-280','cast_model':'XR-85Z9J'},{'source':'sony_8k_pool.XR-75Z9J','brand':'Sony','manufacturer':'Sony','model':'XR-75Z9J','report_model':'XR75Z9J','hardware':'mt5895','board':'mt5895','version_id':'SONYTV.2021.XR_75Z9J','screen_param':'7680-4320-260','cast_model':'XR-75Z9J'},{'source':'sony_8k_pool.KD-98ZG9','brand':'Sony','manufacturer':'Sony','model':'KD-98ZG9','report_model':'KD98ZG9','hardware':'mt5893','board':'mt5893','version_id':'SONYTV.2019.KD_98ZG9','screen_param':'7680-4320-320','cast_model':'KD-98ZG9'},{'source':'sony_8k_pool.KD-85ZG9','brand':'Sony','manufacturer':'Sony','model':'KD-85ZG9','report_model':'KD85ZG9','hardware':'mt5893','board':'mt5893','version_id':'SONYTV.2019.KD_85ZG9','screen_param':'7680-4320-280','cast_model':'KD-85ZG9'},{'source':'sony_8k_pool.KD-85ZH8','brand':'Sony','manufacturer':'Sony','model':'KD-85ZH8','report_model':'KD85ZH8','hardware':'mt5893','board':'mt5893','version_id':'SONYTV.2020.KD_85ZH8','screen_param':'7680-4320-280','cast_model':'KD-85ZH8'},{'source':'sony_8k_pool.KD-75ZH8','brand':'Sony','manufacturer':'Sony','model':'KD-75ZH8','report_model':'KD75ZH8','hardware':'mt5893','board':'mt5893','version_id':'SONYTV.2020.KD_75ZH8','screen_param':'7680-4320-260','cast_model':'KD-75ZH8'},{'source':'samsung_8k_pool.QA85QN900A','brand':'Samsung','manufacturer':'Samsung','model':'QA85QN900A','report_model':'QA85QN900A','hardware':'s5e9925','board':'neo8k','version_id':'SAMSUNGTV.2021.QN900A','screen_param':'7680-4320-280','cast_model':'QA85QN900A'},{'source':'samsung_8k_pool.QA75QN900A','brand':'Samsung','manufacturer':'Samsung','model':'QA75QN900A','report_model':'QA75QN900A','hardware':'s5e9925','board':'neo8k','version_id':'SAMSUNGTV.2021.QN900A','screen_param':'7680-4320-260','cast_model':'QA75QN900A'},{'source':'samsung_8k_pool.QA85QN900B','brand':'Samsung','manufacturer':'Samsung','model':'QA85QN900B','report_model':'QA85QN900B','hardware':'s5e9925','board':'neo8k','version_id':'SAMSUNGTV.2022.QN900B','screen_param':'7680-4320-280','cast_model':'QA85QN900B'},{'source':'samsung_8k_pool.QA75QN900B','brand':'Samsung','manufacturer':'Samsung','model':'QA75QN900B','report_model':'QA75QN900B','hardware':'s5e9925','board':'neo8k','version_id':'SAMSUNGTV.2022.QN900B','screen_param':'7680-4320-260','cast_model':'QA75QN900B'},{'source':'samsung_8k_pool.QA85QN900C','brand':'Samsung','manufacturer':'Samsung','model':'QA85QN900C','report_model':'QA85QN900C','hardware':'s5e9935','board':'neo8k','version_id':'SAMSUNGTV.2023.QN900C','screen_param':'7680-4320-280','cast_model':'QA85QN900C'},{'source':'samsung_8k_pool.QA75QN900C','brand':'Samsung','manufacturer':'Samsung','model':'QA75QN900C','report_model':'QA75QN900C','hardware':'s5e9935','board':'neo8k','version_id':'SAMSUNGTV.2023.QN900C','screen_param':'7680-4320-260','cast_model':'QA75QN900C'},{'source':'samsung_8k_pool.QA85QN900D','brand':'Samsung','manufacturer':'Samsung','model':'QA85QN900D','report_model':'QA85QN900D','hardware':'s5e9945','board':'neo8k','version_id':'SAMSUNGTV.2024.QN900D','screen_param':'7680-4320-280','cast_model':'QA85QN900D'},{'source':'samsung_8k_pool.QA98QN990C','brand':'Samsung','manufacturer':'Samsung','model':'QA98QN990C','report_model':'QA98QN990C','hardware':'s5e9935','board':'neo8k','version_id':'SAMSUNGTV.2023.QN990C','screen_param':'7680-4320-320','cast_model':'QA98QN990C'},{'source':'samsung_8k_pool.QA85QN800C','brand':'Samsung','manufacturer':'Samsung','model':'QA85QN800C','report_model':'QA85QN800C','hardware':'s5e9935','board':'neo8k','version_id':'SAMSUNGTV.2023.QN800C','screen_param':'7680-4320-280','cast_model':'QA85QN800C'},{'source':'samsung_8k_pool.QA75QN800D','brand':'Samsung','manufacturer':'Samsung','model':'QA75QN800D','report_model':'QA75QN800D','hardware':'s5e9945','board':'neo8k','version_id':'SAMSUNGTV.2024.QN800D','screen_param':'7680-4320-260','cast_model':'QA75QN800D'},{'source':'lg_8k_pool.OLED88Z1PCA','brand':'LG','manufacturer':'LGE','model':'OLED88Z1PCA','report_model':'OLED88Z1PCA','hardware':'alpha9gen4','board':'lg8k','version_id':'LGTV.2021.OLED88Z1','screen_param':'7680-4320-320','cast_model':'OLED88Z1PCA'},{'source':'lg_8k_pool.OLED77Z1PCA','brand':'LG','manufacturer':'LGE','model':'OLED77Z1PCA','report_model':'OLED77Z1PCA','hardware':'alpha9gen4','board':'lg8k','version_id':'LGTV.2021.OLED77Z1','screen_param':'7680-4320-260','cast_model':'OLED77Z1PCA'},{'source':'lg_8k_pool.OLED88Z2PCA','brand':'LG','manufacturer':'LGE','model':'OLED88Z2PCA','report_model':'OLED88Z2PCA','hardware':'alpha9gen5','board':'lg8k','version_id':'LGTV.2022.OLED88Z2','screen_param':'7680-4320-320','cast_model':'OLED88Z2PCA'},{'source':'lg_8k_pool.OLED77Z2PCA','brand':'LG','manufacturer':'LGE','model':'OLED77Z2PCA','report_model':'OLED77Z2PCA','hardware':'alpha9gen5','board':'lg8k','version_id':'LGTV.2022.OLED77Z2','screen_param':'7680-4320-260','cast_model':'OLED77Z2PCA'},{'source':'lg_8k_pool.OLED88Z3PCA','brand':'LG','manufacturer':'LGE','model':'OLED88Z3PCA','report_model':'OLED88Z3PCA','hardware':'alpha9gen6','board':'lg8k','version_id':'LGTV.2023.OLED88Z3','screen_param':'7680-4320-320','cast_model':'OLED88Z3PCA'},{'source':'lg_8k_pool.OLED77Z3PCA','brand':'LG','manufacturer':'LGE','model':'OLED77Z3PCA','report_model':'OLED77Z3PCA','hardware':'alpha9gen6','board':'lg8k','version_id':'LGTV.2023.OLED77Z3','screen_param':'7680-4320-260','cast_model':'OLED77Z3PCA'},{'source':'lg_8k_pool.OLED88Z4PCA','brand':'LG','manufacturer':'LGE','model':'OLED88Z4PCA','report_model':'OLED88Z4PCA','hardware':'alpha9gen7','board':'lg8k','version_id':'LGTV.2024.OLED88Z4','screen_param':'7680-4320-320','cast_model':'OLED88Z4PCA'},{'source':'lg_8k_pool.86QNED99','brand':'LG','manufacturer':'LGE','model':'86QNED99','report_model':'86QNED99','hardware':'alpha9gen4','board':'lg8k','version_id':'LGTV.2021.86QNED99','screen_param':'7680-4320-300','cast_model':'86QNED99'},{'source':'sony_4k_pool.XR-85X95K','brand':'Sony','manufacturer':'Sony','model':'XR-85X95K','report_model':'XR85X95K','hardware':'mt5895','board':'mt5895','version_id':'SONYTV.2022.XR_85X95K','screen_param':'3840-2160-300','cast_model':'XR-85X95K'},{'source':'sony_4k_pool.XR-75X95K','brand':'Sony','manufacturer':'Sony','model':'XR-75X95K','report_model':'XR75X95K','hardware':'mt5895','board':'mt5895','version_id':'SONYTV.2022.XR_75X95K','screen_param':'3840-2160-280','cast_model':'XR-75X95K'},{'source':'sony_4k_pool.XR-65X90K','brand':'Sony','manufacturer':'Sony','model':'XR-65X90K','report_model':'XR65X90K','hardware':'mt5895','board':'mt5895','version_id':'SONYTV.2022.XR_65X90K','screen_param':'3840-2160-260','cast_model':'XR-65X90K'},{'source':'sony_4k_pool.XR-55X90K','brand':'Sony','manufacturer':'Sony','model':'XR-55X90K','report_model':'XR55X90K','hardware':'mt5895','board':'mt5895','version_id':'SONYTV.2022.XR_55X90K','screen_param':'3840-2160-240','cast_model':'XR-55X90K'},{'source':'sony_4k_pool.XR-65A95K','brand':'Sony','manufacturer':'Sony','model':'XR-65A95K','report_model':'XR65A95K','hardware':'mt5895','board':'mt5895','version_id':'SONYTV.2022.XR_65A95K','screen_param':'3840-2160-260','cast_model':'XR-65A95K'},{'source':'samsung_4k_pool.QA85QN90C','brand':'Samsung','manufacturer':'Samsung','model':'QA85QN90C','report_model':'QA85QN90C','hardware':'s5e9935','board':'neo4k','version_id':'SAMSUNGTV.2023.QN90C','screen_param':'3840-2160-300','cast_model':'QA85QN90C'},{'source':'samsung_4k_pool.QA75QN90C','brand':'Samsung','manufacturer':'Samsung','model':'QA75QN90C','report_model':'QA75QN90C','hardware':'s5e9935','board':'neo4k','version_id':'SAMSUNGTV.2023.QN90C','screen_param':'3840-2160-280','cast_model':'QA75QN90C'},{'source':'samsung_4k_pool.QA65QN90C','brand':'Samsung','manufacturer':'Samsung','model':'QA65QN90C','report_model':'QA65QN90C','hardware':'s5e9935','board':'neo4k','version_id':'SAMSUNGTV.2023.QN90C','screen_param':'3840-2160-260','cast_model':'QA65QN90C'},{'source':'samsung_4k_pool.QA55QN90C','brand':'Samsung','manufacturer':'Samsung','model':'QA55QN90C','report_model':'QA55QN90C','hardware':'s5e9935','board':'neo4k','version_id':'SAMSUNGTV.2023.QN90C','screen_param':'3840-2160-240','cast_model':'QA55QN90C'},{'source':'samsung_4k_pool.QA65S95C','brand':'Samsung','manufacturer':'Samsung','model':'QA65S95C','report_model':'QA65S95C','hardware':'s5e9935','board':'oled4k','version_id':'SAMSUNGTV.2023.S95C','screen_param':'3840-2160-260','cast_model':'QA65S95C'},{'source':'lg_4k_pool.OLED83C3PCA','brand':'LG','manufacturer':'LGE','model':'OLED83C3PCA','report_model':'OLED83C3PCA','hardware':'alpha9gen6','board':'lg4k','version_id':'LGTV.2023.OLED83C3','screen_param':'3840-2160-300','cast_model':'OLED83C3PCA'},{'source':'lg_4k_pool.OLED77C3PCA','brand':'LG','manufacturer':'LGE','model':'OLED77C3PCA','report_model':'OLED77C3PCA','hardware':'alpha9gen6','board':'lg4k','version_id':'LGTV.2023.OLED77C3','screen_param':'3840-2160-280','cast_model':'OLED77C3PCA'},{'source':'lg_4k_pool.OLED65C3PCA','brand':'LG','manufacturer':'LGE','model':'OLED65C3PCA','report_model':'OLED65C3PCA','hardware':'alpha9gen6','board':'lg4k','version_id':'LGTV.2023.OLED65C3','screen_param':'3840-2160-260','cast_model':'OLED65C3PCA'},{'source':'lg_4k_pool.OLED55C3PCA','brand':'LG','manufacturer':'LGE','model':'OLED55C3PCA','report_model':'OLED55C3PCA','hardware':'alpha9gen6','board':'lg4k','version_id':'LGTV.2023.OLED55C3','screen_param':'3840-2160-240','cast_model':'OLED55C3PCA'},{'source':'lg_4k_pool.86QNED90','brand':'LG','manufacturer':'LGE','model':'86QNED90','report_model':'86QNED90','hardware':'alpha7gen5','board':'lg4k','version_id':'LGTV.2022.86QNED90','screen_param':'3840-2160-300','cast_model':'86QNED90'},{'source':'tcl_8k_pool.85X925PRO','brand':'TCL','manufacturer':'TCL','model':'85X925 PRO','report_model':'85X925PRO','hardware':'mt9615','board':'tcl8k','version_id':'TCLTV.2021.X925PRO','screen_param':'7680-4320-280','cast_model':'85X925 PRO'},{'source':'tcl_8k_pool.75X925PRO','brand':'TCL','manufacturer':'TCL','model':'75X925 PRO','report_model':'75X925PRO','hardware':'mt9615','board':'tcl8k','version_id':'TCLTV.2021.X925PRO','screen_param':'7680-4320-260','cast_model':'75X925 PRO'},{'source':'tcl_4k_pool.85C845','brand':'TCL','manufacturer':'TCL','model':'85C845','report_model':'85C845','hardware':'mt9615','board':'tcl4k','version_id':'TCLTV.2023.C845','screen_param':'3840-2160-300','cast_model':'85C845'},{'source':'tcl_4k_pool.75C845','brand':'TCL','manufacturer':'TCL','model':'75C845','report_model':'75C845','hardware':'mt9615','board':'tcl4k','version_id':'TCLTV.2023.C845','screen_param':'3840-2160-280','cast_model':'75C845'},{'source':'tcl_4k_pool.65C845','brand':'TCL','manufacturer':'TCL','model':'65C845','report_model':'65C845','hardware':'mt9615','board':'tcl4k','version_id':'TCLTV.2023.C845','screen_param':'3840-2160-260','cast_model':'65C845'},{'source':'tcl_4k_pool.75C745','brand':'TCL','manufacturer':'TCL','model':'75C745','report_model':'75C745','hardware':'mt9615','board':'tcl4k','version_id':'TCLTV.2023.C745','screen_param':'3840-2160-280','cast_model':'75C745'},{'source':'tcl_4k_pool.65C745','brand':'TCL','manufacturer':'TCL','model':'65C745','report_model':'65C745','hardware':'mt9615','board':'tcl4k','version_id':'TCLTV.2023.C745','screen_param':'3840-2160-260','cast_model':'65C745'},{'source':'changhong_4k_pool.U65G7','brand':'CHANGHONG','manufacturer':'CHANGHONG','model':'U65G7','report_model':'U65G7','hardware':'mt9632','board':'changhong4k','version_id':'CHANGHONGTV.2022.U65G7','screen_param':'3840-2160-260','cast_model':'U65G7'},{'source':'changhong_4k_pool.U55G7','brand':'CHANGHONG','manufacturer':'CHANGHONG','model':'U55G7','report_model':'U55G7','hardware':'mt9632','board':'changhong4k','version_id':'CHANGHONGTV.2022.U55G7','screen_param':'3840-2160-240','cast_model':'U55G7'},{'source':'changhong_4k_pool.L55QCN1','brand':'CHANGHONG','manufacturer':'CHANGHONG','model':'L55QCN1','report_model':'L55QCN1','hardware':'mt9632','board':'changhong4k','version_id':'CHANGHONGTV.2021.L55QCN1','screen_param':'3840-2160-240','cast_model':'L55QCN1'},{'source':'changhong_4k_pool.U43QCN1','brand':'CHANGHONG','manufacturer':'CHANGHONG','model':'U43QCN1','report_model':'U43QCN1','hardware':'mt9632','board':'changhong4k','version_id':'CHANGHONGTV.2021.U43QCN1','screen_param':'3840-2160-220','cast_model':'U43QCN1'},{'source':'changhong_4k_pool.UD65YC5500UA','brand':'CHANGHONG','manufacturer':'CHANGHONG','model':'UD65YC5500UA','report_model':'UD65YC5500UA','hardware':'mt9632','board':'changhong4k','version_id':'CHANGHONGTV.2020.UD65YC5500UA','screen_param':'3840-2160-260','cast_model':'UD65YC5500UA'}]
def random_device_template ()->dict :
    pool_8k =[t for t in DEVICE_PROFILE_POOL if '8k'in t .get ('source','')]
    return secrets .choice (pool_8k if pool_8k else DEVICE_PROFILE_POOL )
def device_profile_from_template (template :dict ,android_id :str ,mac :str )->DeviceProfile :
    brand_id =sanitize_profile_id (template ['brand'])
    model_id =sanitize_profile_id (template ['model'])
    device =f'{brand_id }_{model_id }'
    product =f'{brand_id }_{model_id }'
    return DeviceProfile (android_id =android_id ,mac =mac ,hardware =template ['hardware'],board =template ['board'],brand =template ['brand'],device =device ,manufacturer =template ['manufacturer'],model =template ['model'],product =product ,tags ='release-keys',build_type ='user',user ='build',resolution =resolution_from_screen_param (template ['screen_param']),display =f"{template ['model']}-user 13 {template ['version_id']} 2024 release-keys",version_id =template ['version_id'],host =f'{brand_id }-tv-build',fingerprint =f"{template ['manufacturer']}/{product }/{device }:13/{template ['version_id']}/2024:user/release-keys",report_model =template ['report_model'])
def default_device_state ()->DeviceState :
    template =random_device_template ()
    profile =device_profile_from_template (template ,random_hex_string (16 ),random_mac_address ())
    return DeviceState (schema_version =1 ,profile_source =template ['source'],profile =profile ,screen_param =template ['screen_param'],cast_model =template ['cast_model'],x_uid =compute_x_uid (profile ),cloud_guid ='',registered_at =0.0 ,updated_at =now_f64 ())
def create_and_save_new_device (path :str )->DeviceState :
    new_state =default_device_state ()
    new_state .updated_at =now_f64 ()
    try :
        save_device_state (path ,new_state )
    except OSError :
        pass 
    return new_state 
def binary_dir ()->str :
    return os .path .dirname (os .path .abspath (__file__ ))or '.'
def load_device_state (path :str ):
    try :
        with open (path ,encoding ='utf-8')as f :
            text =f .read ()
    except OSError :
        return (default_device_state (),False )
    try :
        data =json .loads (text )
    except ValueError :
        return (default_device_state (),False )
    try :
        profile =DeviceProfile .from_dict (data .get ('profile',{}))
        state =DeviceState (schema_version =int (data .get ('schema_version',1 )),profile_source =str (data .get ('profile_source','')),profile =profile ,screen_param =str (data .get ('screen_param','')),cast_model =str (data .get ('cast_model','')),x_uid =str (data .get ('x_uid','')),cloud_guid =str (data .get ('cloud_guid','')),registered_at =float (data .get ('registered_at',0.0 )),updated_at =float (data .get ('updated_at',0.0 )))
    except (ValueError ,TypeError ,AttributeError ):
        return (default_device_state (),False )
    if len (state .profile .android_id )!=16 or not state .profile .mac :
        return (default_device_state (),False )
    state .x_uid =compute_x_uid (state .profile )
    if not state .screen_param :
        state .screen_param ='7680-4320-280'
    if not state .cast_model :
        state .cast_model =state .profile .model 
    return (state ,True )
def save_device_state (path :str ,state :DeviceState )->None :
    tmp_path =path +f'.tmp.{os .getpid ()}'
    try :
        parent =os .path .dirname (os .path .abspath (path ))
        if parent :
            os .makedirs (parent ,exist_ok =True )
        with open (tmp_path ,'w',encoding ='utf-8')as f :
            f .write (json .dumps (dataclasses .asdict (state ),indent =2 ,ensure_ascii =False ,sort_keys =True )+'\n')
            f .flush ()
            os .fsync (f .fileno ())
        os .replace (tmp_path ,path )
    except OSError :
        try :
            if os .path .exists (tmp_path ):
                os .remove (tmp_path )
        except OSError :
            pass 
def infer_os_version (profile :DeviceProfile )->str :
    if ':'in profile .fingerprint :
        tail =profile .fingerprint .split (':',1 )[1 ]
        if '/'in tail :
            return tail .split ('/',1 )[0 ]
    return ''
def infer_sdk_int (profile :DeviceProfile )->str :
    major =infer_os_version (profile ).split ('.')[0 ]if infer_os_version (profile )else ''
    return {'13':'33','12':'31','11':'30','10':'29','9':'28','8':'26','7':'24','6':'23'}.get (major ,'')
def compute_x_uid (profile :DeviceProfile )->str :
    build_identity_str ='1698'+profile .hardware +profile .board +profile .brand +profile .device +profile .manufacturer +profile .model +profile .product +profile .tags +profile .build_type +profile .user +profile .resolution +profile .mac 
    uuid_part =java_uuid_from_hashes (java_string_hashcode (build_identity_str ),java_string_hashcode (profile .model ))
    return sha1_upper (f'{profile .android_id }|{uuid_part }')
def build_identity (profile :DeviceProfile ,app_channel :str ,version :str )->Identity :
    x_uid =compute_x_uid (profile )
    x_fingerprint ,ts ,_day0 =compute_fingerprint (x_uid ,current_time_ms ())
    headers ={'Accept':'application/json','Accept-Language':DEFAULT_ACCEPT_LANGUAGE ,'Referer':'api.cctv.cn','User-Agent':'cctv_app_tv','UID':profile .android_id ,'appChannel':app_channel ,'X-Uid':x_uid ,'X-Fingerprint':x_fingerprint ,'X-Version':version ,'Content-Type':'application/json; charset=utf-8','Connection':'Keep-Alive','Accept-Encoding':'gzip','Cache-Control':'no-cache'}
    return Identity (x_uid =x_uid ,x_fingerprint =x_fingerprint ,fingerprint_timestamp_ms =ts ,headers =headers )
def next_request_timestamp_ms ()->int :
    return current_time_ms ()
def fresh_headers (template :dict ,content_type :str ,accept =None ,force_ts =None )->dict :
    headers ={}
    if accept is not None :
        headers ['Accept']=accept 
    req_ts =force_ts if force_ts is not None else next_request_timestamp_ms ()
    headers ['X-Timestamp']=str (req_ts )
    headers ['X-Nonce']=str (uuid .uuid4 ())
    for key in ('Accept-Language', 'Referer', 'User-Agent', 'UID', 'appChannel', 'X-Uid', 'X-Fingerprint', 'X-Version'):
        if key in template:
            headers[key] = template[key]
    if content_type :
        headers ['Content-Type']=content_type 
    for key in ('Connection','Accept-Encoding','Cache-Control'):
        if key in template :
            headers [key ]=template [key ]
    return headers 
def compact_json_bytes (value ,escape_forward_slashes :bool )->bytes :
    text =json .dumps (value ,separators =(',',':'),ensure_ascii =False ,sort_keys =True )
    if escape_forward_slashes :
        text =text .replace ('/','\\/')
    return text .encode ('utf-8')
def normalize_aes_key (value :str )->bytes :
    raw =value .encode ('utf-8')
    return (raw +b'\x00'*32 )[:32 ]
def aes_gcm_decrypt_b64 (value :str ,key :str )->str :
    try :
        raw =base64 .b64decode (value ,validate =True )
    except (binascii .Error ,ValueError )as e :
        raise YsptpError (f'base64 decode failed: {e }')
    if len (raw )<=12 :
        raise YsptpError ('AES-GCM payload too short')
    try :
        plain =aes_gcm_decrypt (normalize_aes_key (key ),raw [:12 ],raw [12 :])
    except ValueError :
        raise YsptpError ('AES-GCM decrypt failed')
    try :
        return plain .decode ('utf-8')
    except UnicodeDecodeError as e :
        raise YsptpError (f'AES-GCM plaintext is not UTF-8: {e }')
def aes_gcm_encrypt_b64 (value :str ,key :str )->str :
    nonce =secrets .token_bytes (12 )
    try :
        encrypted =aes_gcm_encrypt (normalize_aes_key (key ),nonce ,value .encode ('utf-8'))
    except ValueError :
        raise YsptpError ('AES-GCM encrypt failed')
    return base64 .b64encode (nonce +encrypted ).decode ('ascii')
def rsa_encrypt_device_id (device_id :str )->str :
    try :
        der =base64 .b64decode (RSA_PUBLIC_KEY_B64 ,validate =True )
    except (binascii .Error ,ValueError )as e :
        raise YsptpError (f'RSA public key base64 decode failed: {e }')
    n ,e =parse_spki_rsa_pubkey (der )
    k =(n .bit_length ()+7 )//8 
    hlen =32 
    chunk_size =k -2 *hlen -2 
    out =bytearray ()
    data =device_id .encode ('utf-8')
    for i in range (0 ,len (data ),chunk_size ):
        chunk =data [i :i +chunk_size ]
        out +=rsa_oaep_sha256_encrypt (der ,chunk ,secrets .token_bytes (hlen ))
    return base64 .b64encode (bytes (out )).decode ('ascii')
def report_model_from_build (profile :DeviceProfile )->str :
    return profile .model .replace (profile .manufacturer ,'').replace (' ','')
def app_start_field (value ,limit :int )->str :
    return str (value )[:limit ]if limit >=0 else str (value )
def build_report_common_value (profile :DeviceProfile ,x_uid :str ,app_channel :str ,version :str ,sdk_version :str ,data_time_ms :int )->dict :
    model =profile .report_model or report_model_from_build (profile )
    return {'cctv_id':app_start_field (x_uid ,64 ),'device_id':app_start_field (profile .android_id ,64 ),'idfa':'','idfv':'','user_id':'','app_key':app_start_field (REPORT_APP_KEY ,64 ),'imei':'','android_id':app_start_field (profile .android_id ,64 ),'mac':app_start_field (profile .mac ,64 ),'device_builder_type':app_start_field (profile .build_type ,64 ),'device_hardware':app_start_field (profile .hardware ,64 ),'device_board':app_start_field (profile .board ,64 ),'device_brand':app_start_field (profile .brand ,64 ),'device_params':app_start_field (profile .device ,64 ),'device_display':app_start_field (profile .display ,64 ),'device_version_id':app_start_field (profile .version_id ,64 ),'device_host':app_start_field (profile .host ,128 ),'device_product':app_start_field (profile .product ,64 ),'device_tags':app_start_field (profile .tags ,64 ),'device_user':app_start_field (profile .user ,30 ),'device_fingerprint':app_start_field (profile .fingerprint ,128 ),'device_manufacturer':app_start_field (profile .manufacturer ,64 ),'device_model':app_start_field (model ,50 ),'device_resolution':app_start_field (profile .resolution ,20 ),'system_type':'Android','device_type':'TV','app_language':'CHINESE','app_version':app_start_field (version ,30 ),'sdk_version':app_start_field (sdk_version ,30 ),'os_version':app_start_field (infer_os_version (profile ),20 ),'app_channel':app_start_field (app_channel ,50 ),'data_time':app_start_field (data_time_ms ,13 )}
def build_app_start_body (profile :DeviceProfile ,x_uid :str ,app_channel :str ,version :str ,data_time_ms :int )->dict :
    return {'key':'app_start_d1','value':build_report_common_value (profile ,x_uid ,app_channel ,version ,'',data_time_ms )}
def build_collect_headers (profile :DeviceProfile )->dict :
    release =infer_os_version (profile )
    return {'Content-type':'application/x-www-form-urlencoded','Charset':'UTF-8','User-Agent':'Dalvik/2.1.0 (Linux; U; Android '+(release if release else 'Android')+f'; {profile .model } Build/{profile .version_id })','Connection':'Keep-Alive','Accept-Encoding':'gzip'}
def parse_result_code (value )->int |None :
    if isinstance (value ,dict ):
        for key in ('result','code','errCode','errcode','ret'):
            if key in value :
                raw =value [key ]
                if isinstance (raw ,bool ):
                    continue 
                if isinstance (raw ,int ):
                    return raw 
                if isinstance (raw ,str ):
                    try :
                        return int (raw )
                    except ValueError :
                        pass 
        for key in ('data','error','response'):
            if key in value :
                found =parse_result_code (value [key ])
                if found is not None :
                    return found 
    return None 
def extract_guid (value )->str :
    if isinstance (value ,dict ):
        data =value .get ('data')
        if isinstance (data ,dict ):
            guid =data .get ('guid')
            if isinstance (guid ,str ):
                return guid 
    return ''
def root_headers (version :str )->dict :
    return {'X-Uid':'ROOT','X-Fingerprint':'ROOT','X-Nonce':str (uuid .uuid4 ()),'X-Timestamp':str (next_request_timestamp_ms ()),'X-Version':version ,'UID':'ROOT','Referer':'api.cctv.cn','User-Agent':'cctv_app_tv','appChannel':'ROOT','Connection':'Keep-Alive','Accept-Encoding':'gzip'}
def build_vdn_appcommon (version :str )->str :
    return json .dumps ({'adid':'','av':version ,'an':VDN_APP_NAME ,'ap':'cctv_app_tv'},separators =(',',':'),ensure_ascii =False ,sort_keys =True )
def url_host (url :str )->str :
    try :
        return urllib .parse .urlsplit (url ).hostname or ''
    except ValueError :
        return ''
def live_playback_host_needs_signed_headers (host :str )->bool :
    lower =host .lower ()
    return 'liveali'in lower or 'liveten'in lower 
def default_cctv_playback_headers (uid :str )->dict :
    return {'UID':uid ,'APPID':AK ,'Referer':'api.cctv.cn','User-Agent':'cctv_app_tv'}
def cctv_playback_headers_for_entry (entry :ChannelEntry )->dict :
    headers =default_cctv_playback_headers (entry .android_id )
    for key in ('UID','APPID','APPRANDOMSTR','Referer','User-Agent','APPSIGN'):
        value =entry .playback_headers .get (key )
        if value :
            headers [key ]=value 
    return headers 
def entry_missing_signed_playback_headers (entry :ChannelEntry )->bool :
    host =entry .final_host or url_host (entry .final_url )
    if not live_playback_host_needs_signed_headers (host ):
        return False 
    for key in ('APPID','APPSIGN','APPRANDOMSTR'):
        value =entry .playback_headers .get (key ,'')
        if not value .strip ():
            return True 
    return False 
def ts_path_matches_final_url (ts_path :str ,final_url :str )->bool :
    try :
        parsed =urllib .parse .urlsplit (final_url )
    except ValueError :
        return False 
    prefix =parsed .path 
    if prefix .endswith ('.m3u8'):
        prefix =prefix [:-len ('.m3u8')]
    return bool (prefix )and ts_path .startswith (prefix )
def generate_app_random_str ()->str :
    return f'{secrets .randbits (32 ):08x}-0000-{secrets .randbits (32 )&65535 :04x}-0000-00000000{secrets .randbits (32 )&65535 :04x}'
def compute_vdn_code (app_secret :str ,random_str =None ):
    r =random_str if random_str is not None else generate_app_random_str ()
    return (md5_hex (f'{AK }{app_secret }{r }'),r )
def is_ts_url (value :str )->bool :
    try :
        path =urllib .parse .urlsplit (value ).path 
    except ValueError :
        return False 
    return path .lower ().endswith ('.ts')
def _rs_lines (text :str ):
    norm =text .replace ('\r\n','\n')
    lines =norm .split ('\n')
    if norm .endswith ('\n'):
        lines .pop ()
    return [ln [:-1 ]if ln .endswith ('\r')else ln for ln in lines ]
def rewrite_playlist_urls (text :str ,base_url :str )->str :
    try :
        parts =urllib .parse .urlsplit (base_url )
        has_base =bool (parts .scheme and parts .netloc )
    except ValueError :
        has_base =False 
    out =[]
    for line in _rs_lines (text ):
        stripped =line .strip ()
        if not stripped or stripped .startswith ('#'):
            out .append (line )
        elif has_base :
            out .append (urllib .parse .urljoin (base_url ,stripped ))
        else :
            out .append (stripped )
    return ''.join ((ln +'\n'for ln in out ))
def header_value_clean (value :str )->str :
    return value .replace ('\r','').replace ('\n','')
def form_urlencode_value (s :str )->str :
    out =[]
    for byte in s .encode ('utf-8'):
        ch =chr (byte )
        if ch .isascii ()and (ch .isalnum ()or ch in '*-._'):
            out .append (ch )
        elif byte ==32 :
            out .append ('+')
        else :
            out .append (f'%{byte :02X}')
    return ''.join (out )
def form_encode (pairs )->bytes :
    return '&'.join ((f'{form_urlencode_value (k )}={form_urlencode_value (v )}'for k ,v in pairs )).encode ('utf-8')
def _normalize_network_error (e :Exception )->str :
    if isinstance (e ,ConnectionRefusedError ):
        return f'connection refused: {e }'
    if isinstance (e ,ConnectionResetError ):
        return f'connection reset by peer: {e }'
    if isinstance (e ,(socket .timeout ,TimeoutError )):
        return f'operation timed out: {e }'
    if isinstance (e ,socket .gaierror ):
        return f'failed to lookup address: {e }'
    if isinstance (e ,urllib .error .URLError ):
        reason =e .reason 
        if isinstance (reason ,Exception ):
            return _normalize_network_error (reason )
        return f'network error: {e }'
    return f'network error: {e }'
class HttpResponse :
    def __init__ (self ,status :int ,reason :str ,headers :dict ,body :bytes ):
        self .status =status 
        self .reason =reason 
        self .headers =headers 
        self .body =body 
    def text (self )->str :
        return self .body .decode ('utf-8',errors ='replace')
class HttpClient :
    def __init__ (self ,timeout :float ,insecure_tls :bool ):
        self ._timeout =max (timeout ,0.1 )
        if insecure_tls :
            self ._ctx =ssl ._create_unverified_context ()
        else :
            self ._ctx =ssl .create_default_context ()
        jar =http .cookiejar .CookieJar ()
        https_handler =urllib .request .HTTPSHandler (context =self ._ctx )
        self ._opener =urllib .request .build_opener (urllib .request .ProxyHandler ({}),urllib .request .HTTPCookieProcessor (jar ),https_handler )
        self ._jar =jar 
    def _send (self ,method :str ,url :str ,headers :dict ,data :bytes |None )->HttpResponse :
        req =urllib .request .Request (url ,data =data ,method =method )
        for k ,v in headers .items ():
            req .add_header (k ,v )
        try :
            try :
                with self ._opener .open (req ,timeout =self ._timeout )as resp :
                    status =resp .status 
                    reason =resp .reason or ''
                    hdrs ={k .lower ():v for k ,v in resp .headers .items ()}
                    body =resp .read ()
            except urllib .error .HTTPError as e :
                status =e .code 
                reason =e .reason or ''
                try :
                    hdrs ={k .lower ():v for k ,v in e .headers .items ()}if e .headers else {}
                except Exception :
                    hdrs ={}
                try :
                    body =e .read ()
                except Exception :
                    body =b''
        except Exception as e :
            raise YsptpError (_normalize_network_error (e ))
        if 'gzip'in hdrs .get ('content-encoding','').lower ():
            try :
                body =gzip .decompress (body )
            except (OSError ,EOFError ):
                pass 
        return HttpResponse (status ,reason ,hdrs ,body )
    def get (self ,url :str ,headers :dict )->HttpResponse :
        return self ._send ('GET',url ,headers ,None )
    def post_bytes (self ,url :str ,headers :dict ,data :bytes )->HttpResponse :
        return self ._send ('POST',url ,headers ,data )
    def post_json (self ,url :str ,headers :dict ,body )->HttpResponse :
        data =json .dumps (body ,separators =(',',':'),ensure_ascii =False ,sort_keys =True ).encode ('utf-8')
        return self ._send ('POST',url ,headers ,data )
    def post_form (self ,url :str ,headers :dict ,pairs )->HttpResponse :
        return self ._send ('POST',url ,headers ,form_encode (pairs ))
def response_json (resp :HttpResponse ):
    status =resp .status 
    text =resp .text ()
    try :
        value =json .loads (text )
    except ValueError :
        value =None 
    return (status ,text ,value )
def http_status_text (status :int ,reason :str )->str :
    return f'{status } {reason }'.strip ()if reason else str (status )
class ResolverState :
    def __init__ (self ):
        self .cache :dict [str ,ChannelEntry ]={}
        self .playlist_cache :dict [str ,PlaylistCacheEntry ]={}
        self .background_refreshing :dict [str ,float ]={}
        self .channel_failures :dict [str ,tuple [float ,str ,int ]]={}
        self .generation =0 
        self .session_generation =0 
        self .sessions :dict [int ,AppSession ]={}
        self .channel_slot_map :dict [str ,int ]={}
        self .slot_last_reset :dict [int ,float ]={}
        self .last_control_request_at =0.0 
        self .last_business_end_at =0.0 
        self .refreshing_channel =''
        self .last_error =''
        self .last_error_at =0.0 
        self .identity_reset_error_count =0 
        self .channel_last_access :dict [str ,float ]={}
        self .identity_reset_count =0 
        self .last_identity_reset_at =0.0 
        self .last_identity_reset_reason =''
        self .ad_display =False 
        self .zap_channel =''
        self .zap_time =0.0 
        self .zap_pending =''
        self .zap_generation =0 
        self .zap_times :dict [str ,float ]={}
        self .zap_pending_channels :set [str ]=set ()
        self .zap_generations :dict [str ,int ]={}
        self .last_device_wipe_at =0.0 
        self .device_wipe_day =''
        self .device_wipe_count =0 
    @property 
    def app_session (self ):
        return self .sessions .get (0 )or (list (self .sessions .values ())[0 ]if self .sessions else None )
    @app_session .setter 
    def app_session (self ,val ):
        if val is not None :
            self .sessions [0 ]=val 
        else :
            self .sessions .pop (0 ,None )
@dataclasses .dataclass 
class AppSession :
    profile :DeviceProfile 
    identity :Identity 
    client :HttpClient 
    session_key :str 
    cloud_guid :str 
    version :str 
    screen_param :str 
    cast_model :str 
    created_at :float 
    generation :int 
    last_heartbeat_at :float 
    heartbeat_count :int 
    last_heartbeat_result :str 
    last_heartbeat_error :str 
    linked_channels :set =dataclasses .field (default_factory =set )
class RefreshQueue :
    def __init__ (self ):
        self .cond =threading .Condition ()
        self .queued :collections .deque [str ]=collections .deque ()
        self .queued_channels :dict [str ,float ]={}
        self .running_channel =''
        self .running_started_at =0.0 
        self .enqueued_total =0 
        self .dropped_total =0 
        self .completed_total =0 
        self .failed_total =0 
        self .last_enqueued_at =0.0 
        self .last_finished_at =0.0 
        self .last_dropped_at =0.0 
        self .last_drop_reason =''
class HttpQueue :
    def __init__ (self ):
        self .cond =threading .Condition ()
        self .queued :collections .deque =collections .deque ()
        self .active_workers =0 
        self .enqueued_total =0 
        self .rejected_total =0 
        self .completed_total =0 
        self .panicked_total =0 
        self .last_enqueued_at =0.0 
        self .last_completed_at =0.0 
        self .last_rejected_at =0.0 
class Resolver :
    def __init__ (self ,args :argparse .Namespace ):
        self .args =args 
        self .generic_client =HttpClient (args .timeout ,args .insecure_tls )
        self .state =ResolverState ()
        self .state_lock =threading .Lock ()
        self .control_lock =threading .RLock ()
        self .playlist_locks_lock =threading .Lock ()
        self .playlist_locks :dict [str ,threading .Lock ]={}
        self .refresh_queue =RefreshQueue ()
        self .http_queue =HttpQueue ()
        self .state .cache =load_cache (args .meta_json )
    def start_heartbeat (self ):
        def loop ():
            while True :
                time .sleep (max (self .args .heartbeat_interval ,1.0 ))
                try :
                    self .send_heartbeat ()
                except Exception :
                    pass 
        t =threading .Thread (target =loop ,daemon =True ,name ='heartbeat-keeper')
        t .start ()
    def start_refresh_worker (self ):
        t =threading .Thread (target =self .refresh_worker_loop ,daemon =True ,name ='refresh-worker')
        t .start ()
    def enqueue_background_refresh (self ,channel :str ):
        now =now_f64 ()
        q =self .refresh_queue 
        with q .cond :
            if q .running_channel ==channel or channel in q .queued_channels :
                return ('already_active','')
            limit =int (self .args .background_refresh_queue_limit )
            if limit ==0 or len (q .queued )>=limit :
                q .dropped_total +=1 
                q .last_dropped_at =now 
                if limit ==0 :
                    q .last_drop_reason =f'background refresh queue disabled; channel={channel }'
                else :
                    q .last_drop_reason =f'background refresh queue full ({len (q .queued )}/{limit }); channel={channel }'
                return ('rejected',q .last_drop_reason )
            q .queued .append (channel )
            q .queued_channels [channel ]=now 
            q .enqueued_total +=1 
            q .last_enqueued_at =now 
            q .cond .notify ()
            return ('enqueued','')
    def refresh_worker_loop (self ):
        q =self .refresh_queue 
        while True :
            with q .cond :
                while not q .queued :
                    q .cond .wait ()
                channel =q .queued .popleft ()
                q .queued_channels .pop (channel ,None )
                q .running_channel =channel 
                q .running_started_at =now_f64 ()
            ok =self .refresh_channel_background (channel )
            with q .cond :
                q .running_channel =''
                q .running_started_at =0.0 
                q .last_finished_at =now_f64 ()
                if ok :
                    q .completed_total +=1 
                else :
                    q .failed_total +=1 
    @contextlib .contextmanager 
    def control_request_slot (self ,_label :str ):
        min_interval =max (0.0 ,float (self .args .refresh_interval ))
        while True :
            with self .state_lock :
                last =self .state .last_control_request_at 
                wait =0.0 if last <=0.0 else min_interval -(now_f64 ()-last )
            if wait <=0.0 :
                break 
            time .sleep (wait )
        jitter =self .control_step_jitter_duration ()
        if jitter is not None :
            time .sleep (jitter )
        try :
            yield 
        finally :
            with self .state_lock :
                self .state .last_control_request_at =now_f64 ()
    def control_step_jitter_duration (self ):
        min_ms =int (self .args .control_step_jitter_min_ms )
        max_ms =int (self .args .control_step_jitter_max_ms )
        if max_ms ==0 :
            return None 
        upper =max (max_ms ,min_ms )
        span =upper -min_ms 
        extra =secrets .randbelow (span +1 )if span else 0 
        return (min_ms +extra )/1000.0 
    def app_session_fresh (self ,sess :AppSession )->bool :
        return float (self .args .session_ttl )<=0.0 or now_f64 ()-sess .created_at <float (self .args .session_ttl )
    def app_session_ttl_remaining (self ,sess :AppSession ):
        if float (self .args .session_ttl )<=0.0 :
            return None 
        return float (self .args .session_ttl )-(now_f64 ()-sess .created_at )
    def slot_device_json_path (self ,slot :int )->str :
        base =self .args .device_json 
        if slot ==0 :
            return base 
        root ,ext =os .path .splitext (base )
        return f'{root }-slot{slot }{ext }'
    def evict_idle_links (self ,app_session ,idle_sec =15.0 ):
        now =now_f64 ()
        with self .state_lock :
            last =dict (self .state .channel_last_access )
        for ch_slug in list (app_session .linked_channels ):
            if now -last .get (ch_slug ,0.0 )>idle_sec :
                app_session .linked_channels .discard (ch_slug )
    def zap_debounced (self ,channel :str )->bool :
        if channel in TRUE_4K_CHANNELS :
            return False 
        try :
            debounce =float (getattr (self .args ,'zap_debounce',10.0 ))
        except (TypeError ,ValueError ):
            debounce =10.0 
        if debounce <=0.0 :
            return False 
        now =now_f64 ()
        with self .state_lock :
            entry =self .state .cache .get (channel )
            if entry is not None and entry .fresh (now )and not entry_missing_signed_playback_headers (entry ):
                return False 
            sess =self .state .sessions .get (0 )
            if sess is not None and channel in sess .linked_channels and entry is not None and (now -entry .expires_at <30.0 ):
                return False 
            self .state .zap_channel =channel 
            if channel in self .state .zap_pending_channels :
                return True 
            ch_zap_time =self .state .zap_times .get (channel ,0.0 )
            if ch_zap_time <=0.0 or (now -ch_zap_time >max (debounce *3.0 ,30.0 )):
                ch_zap_time =now 
                self .state .zap_times [channel ]=now 
                self .state .zap_time =now 
            if now -ch_zap_time <debounce :
                self .state .zap_pending =channel 
                self .state .zap_pending_channels .add (channel )
                self .state .zap_generation +=1 
                gen =self .state .zap_generations .get (channel ,0 )+1 
                self .state .zap_generations [channel ]=gen 
                delay =max (0.1 ,debounce -(now -ch_zap_time ))
                threading .Thread (target =self ._zap_resolve_worker ,args =(channel ,gen ,delay ),daemon =True ).start ()
                return True 
            return False 
    def _zap_resolve_worker (self ,channel :str ,gen :int ,delay :float ):
        time .sleep (delay )
        now =now_f64 ()
        with self .state_lock :
            if gen !=self .state .zap_generations .get (channel ,0 ):
                self .state .zap_pending_channels .discard (channel )
                return 
            last_acc =self .state .channel_last_access .get (channel ,0.0 )
            if (now -last_acc >max (delay +2.0 ,12.0 ))or (self .state .zap_channel !=channel and now -last_acc >5.0 ):
                self .state .zap_pending_channels .discard (channel )
                self .state .zap_times .pop (channel ,None )
                if self .state .zap_pending ==channel :
                    self .state .zap_pending =''
                return 
        try :
            self .ensure_channel (channel ,force =True )
            log (f'[{channel }] 高码率后台预取完成, 继续停留将自动升级',min_interval =10.0 )
        except Exception as e :
            log (f'[{channel }] 高码率后台预取失败: {e }, 继续 1080p',min_interval =10.0 )
        finally :
            with self .state_lock :
                self .state .zap_pending_channels .discard (channel )
                if self .state .zap_pending ==channel :
                    self .state .zap_pending =''
    def rotate_device_on_400 (self ,reason :str )->bool :
        now =now_f64 ()
        with self .state_lock :
            if now -self .state .last_device_wipe_at <300.0 :
                return False 
            day =time .strftime ('%Y-%m-%d',time .localtime (now ))
            if self .state .device_wipe_day !=day :
                self .state .device_wipe_day =day 
                self .state .device_wipe_count =0 
            if self .state .device_wipe_count >=5 :
                log ('[设备] 24小时内已自动换新身份 5 次，停止自动更换，请手动检查网络或设备',min_interval =60.0 )
                return False 
            self .state .last_device_wipe_at =now 
            self .state .device_wipe_day =day 
            self .state .device_wipe_count +=1 
            wipe_no =self .state .device_wipe_count 
            target =self .slot_device_json_path (0 )
            self .state .sessions .pop (0 ,None )
            self .state .cache .clear ()
            self .state .playlist_cache .clear ()
            self .state .channel_failures .clear ()
            self .state .channel_last_access .clear ()
        create_and_save_new_device (target )
        log (f'[设备] 检测到 400 ({reason })，旧身份已废弃，换新设备身份 (5分钟内仅一次，今日第 {wipe_no } 次)')
        return True 
    def get_slot_for_channel (self ,channel :str )->int :
        return 0 
    def ensure_slot_session (self ,slot :int )->AppSession :
        with self .state_lock :
            sess =self .state .sessions .get (slot )
            if sess is not None and self .app_session_fresh (sess ):
                rem =self .app_session_ttl_remaining (sess )
                if rem is None or rem >300.0 :
                    return sess 
        self .control_lock .acquire ()
        try :
            with self .state_lock :
                sess =self .state .sessions .get (slot )
                if sess is not None and self .app_session_fresh (sess ):
                    rem =self .app_session_ttl_remaining (sess )
                    if rem is None or rem >300.0 :
                        return sess 
            with self .state_lock :
                self .state .session_generation +=1 
                gen =self .state .session_generation 
            target_json =self .slot_device_json_path (slot )
        finally :
            self .control_lock .release ()
        sess =self .bootstrap_session (gen ,save_to_disk =True ,fast =True ,device_json =target_json )
        self .control_lock .acquire ()
        try :
            with self .state_lock :
                cur =self .state .sessions .get (slot )
                if cur is None or not self .app_session_fresh (cur )or cur .generation <gen :
                    self .state .sessions [slot ]=sess 
                else :
                    sess =cur 
        finally :
            self .control_lock .release ()
        return sess 
    def record_recoverable_error (self ,reason :str )->bool :
        if not is_identity_recoverable_error (reason ):
            return False 
        threshold =int (self .args .identity_reset_error_threshold )
        if threshold ==0 :
            return False 
        with self .state_lock :
            if self .state .last_identity_reset_at >0.0 and now_f64 ()-self .state .last_identity_reset_at <float (self .args .identity_reset_cooldown ):
                return False 
            self .state .identity_reset_error_count =min (self .state .identity_reset_error_count +1 ,2 **31 -1 )
            should_reset =self .state .identity_reset_error_count >=threshold 
        try :
            self .write_meta ()
        except Exception :
            pass 
        return False 
    def clear_recoverable_error_count (self ):
        with self .state_lock :
            self .state .identity_reset_error_count =0 
    def is_channel_in_cooldown (self ,channel :str )->bool :
        with self .state_lock :
            fail =self .state .channel_failures .get (channel )
            if fail is None :
                return False 
            failed_at ,_ ,fail_count =fail 
            if fail_count <=1 :
                cooldown =15.0 
            elif fail_count ==2 :
                cooldown =60.0 
            else :
                cooldown =120.0 
            return (now_f64 ()-failed_at )<cooldown 
    def get_channel_failure_info (self ,channel :str ):
        with self .state_lock :
            return self .state .channel_failures .get (channel )
    def clear_channel_cooldown (self ,channel :str ):
        with self .state_lock :
            self .state .channel_failures .pop (channel ,None )
    def ensure_channel (self ,channel :str ,force :bool =False )->ChannelEntry :
        now =now_f64 ()
        if not force :
            with self .state_lock :
                entry =self .state .cache .get (channel )
                if entry is not None :
                    if entry .fresh (now )and (not entry_missing_signed_playback_headers (entry )):
                        return entry 
                    if entry .stale_usable (now ,float (self .args .stale_while_refresh_ttl ))and (not entry_missing_signed_playback_headers (entry )):
                        retry_at =entry .last_refresh_failed_at +float (self .args .refresh_error_cooldown )
                        started =self .state .background_refreshing .get (channel )
                        should_refresh =now >=retry_at and (started is None or now -started >300.0 )
                        clone =entry 
                        if should_refresh :
                            self .state .background_refreshing [channel ]=now 
                            status ,reason =self .enqueue_background_refresh (channel )
                            if status =='rejected':
                                self .state .background_refreshing .pop (channel ,None )
                                e2 =self .state .cache .get (channel )
                                if e2 is not None :
                                    e2 .last_refresh_error =reason 
                                    e2 .last_refresh_failed_at =now 
                        return clone 
                fail =self .state .channel_failures .get (channel )
                if fail is not None :
                    failed_at ,err_msg ,fail_count =fail 
                    if fail_count <=1 :
                        cooldown =15.0 
                    elif fail_count ==2 :
                        cooldown =60.0 
                    else :
                        cooldown =120.0 
                    elapsed =now -failed_at 
                    if elapsed <cooldown :
                        raise YsptpError (f'channel {channel } in cooldown ({int (elapsed )}s/{int (cooldown )}s): {err_msg }')
        with self .control_lock :
            now =now_f64 ()
            if not force :
                with self .state_lock :
                    entry =self .state .cache .get (channel )
                    if entry is not None and entry .fresh (now )and (not entry_missing_signed_playback_headers (entry )):
                        return entry 
            try :
                entry =self .refresh_channel_controlled (channel )
            except YsptpError as err :
                err_text =str (err )
                if 'HTTP 400'in err_text and self .rotate_device_on_400 (channel +':'+err_text [:60 ]):
                    try :
                        entry =self .refresh_channel_controlled (channel )
                    except Exception :
                        pass 
                    else :
                        self .clear_recoverable_error_count ()
                        try :
                            self .write_meta ()
                        except Exception :
                            pass 
                        return entry 
                with self .state_lock :
                    self .state .last_error =err_text 
                    self .state .last_error_at =now_f64 ()
                    last_error =self .state .last_error 
                    last_error_at =self .state .last_error_at 
                    prev =self .state .channel_failures .get (channel )
                    fail_cnt =(prev [2 ]+1 )if prev else 1 
                    self .state .channel_failures [channel ]=(last_error_at ,last_error ,fail_cnt )
                    entry =self .state .cache .get (channel )
                    if entry is not None and entry .final_url and entry .stale_usable (last_error_at ,float (self .args .stale_while_refresh_ttl )):
                        entry .last_refresh_error =last_error 
                        entry .last_refresh_failed_at =last_error_at 
                        clone =entry 
                    else :
                        clone =None 
                did_reset =self .record_recoverable_error (err_text )
                if not did_reset :
                    try :
                        self .write_meta ()
                    except Exception :
                        pass 
                if did_reset or clone is None :
                    raise 
                return clone 
            self .clear_recoverable_error_count ()
            try :
                self .write_meta ()
            except Exception :
                pass 
            return entry 
    def refresh_channel_background (self ,channel :str )->bool :
        try :
            with self .control_lock :
                now =now_f64 ()
                with self .state_lock :
                    entry =self .state .cache .get (channel )
                    if (
                    entry is not None 
                    and entry .fresh (now )
                    and (entry .expires_at -now >180.0 )
                    and (not entry_missing_signed_playback_headers (entry ))
                    ):
                        return True 
                self .refresh_channel_controlled (channel )
                try :
                    self .write_meta ()
                except Exception :
                    pass 
            ok =True 
        except YsptpError as err :
            err_text =str (err )
            with self .state_lock :
                self .state .last_error =err_text 
                self .state .last_error_at =now_f64 ()
                last_error =self .state .last_error 
                last_error_at =self .state .last_error_at 
                prev =self .state .channel_failures .get (channel )
                fail_cnt =(prev [2 ]+1 )if prev else 1 
                self .state .channel_failures [channel ]=(last_error_at ,last_error ,fail_cnt )
                entry =self .state .cache .get (channel )
                if entry is not None :
                    entry .last_refresh_error =last_error 
                    entry .last_refresh_failed_at =last_error_at 
                if is_session_invalidating_error (err_text ):
                    self .state .app_session =None 
            did_reset =self .record_recoverable_error (err_text )
            if not did_reset :
                try :
                    self .write_meta ()
                except Exception :
                    pass 
            ok =False 
        with self .state_lock :
            self .state .background_refreshing .pop (channel ,None )
        return ok 
    def refresh_channel_controlled (self ,channel :str )->ChannelEntry :
        with self .state_lock :
            wait =float (self .args .refresh_interval )-(now_f64 ()-self .state .last_business_end_at )
        if wait >0.0 :
            time .sleep (wait )
        with self .state_lock :
            self .state .refreshing_channel =channel 
            self .state .generation +=1 
            generation =self .state .generation 
        log (f'[{channel }] 正在向央视频协议引擎请求直播源…',min_interval =10.0 )
        try :
            slot =self .get_slot_for_channel (channel )
            limit =int (getattr (self .args ,'links_per_device',6 ))
            app_session =self .ensure_slot_session (slot )
            if limit >0 and channel not in app_session .linked_channels and len (app_session .linked_channels )>=limit :
                self .evict_idle_links (app_session ,LINK_IDLE_TIMEOUT )
                if len (app_session .linked_channels )>=limit :
                    raise YsptpError (f'device link quota reached ({limit }), fallback to 1080p')
            live_id =channel_by_name (channel )
            if live_id is None :
                raise YsptpError (f'unknown channel {channel }')
            entry =self .resolve_channel_once (app_session ,channel ,live_id ,generation )
            app_session .linked_channels .add (channel )
        except YsptpError as err :
            with self .state_lock :
                self .state .last_business_end_at =now_f64 ()
                self .state .refreshing_channel =''
            raise 
        with self .state_lock :
            self .state .last_business_end_at =now_f64 ()
            self .state .refreshing_channel =''
            self .state .cache [channel ]=entry 
            self .state .playlist_cache .pop (channel ,None )
            self .state .channel_failures .pop (channel ,None )
            self .state .identity_reset_error_count =0 
            self .state .last_error =''
            if channel in ('cctv4k','cctv164k','cctv8k'):
                rate_label ='4K超高清 (36M超高码率)'if entry .rate =='36p'else ('4K (10M码率)'if entry .rate =='10p'else '4K超高清')
            elif entry .rate =='10p':
                rate_label ='高码率 (10M码率)'
            elif entry .rate =='36p':
                rate_label ='超高码率 (36M码率)'
            else :
                rate_label =entry .rate_name or entry .rate or '高码率'
            if channel in ('cctv4k','cctv164k','cctv8k')and '8K'in rate_label :
                rate_label ='4K超高清 (36M超高码率)'
            log (f'[{channel }] 直播源获取成功 (清晰度: {rate_label })',min_interval =10.0 )
        return entry 
    def new_ytpaddr_client (self )->HttpClient :
        return HttpClient (float (self .args .timeout ),bool (self .args .insecure_tls ))
    def bootstrap_session (self ,generation :int ,device_state :DeviceState |None =None ,save_to_disk :bool =True ,fast :bool =False ,device_json :str ='' )->AppSession :
        target_json =device_json or self .args .device_json 
        if device_state is None :
            device_state ,existed =load_device_state (target_json )
            if (not existed or device_state .registered_at <=0.0 )and save_to_disk :
                device_state =default_device_state ()
                device_state .updated_at =now_f64 ()
                try :
                    save_device_state (target_json ,device_state )
                except OSError :
                    pass 
        profile =device_state .profile 
        app_channel ='dangbei'
        version ='1.4.1'
        identity =build_identity (profile ,app_channel ,version )
        device_state .x_uid =identity .x_uid 
        client =self .new_ytpaddr_client ()
        app_start =self .app_start_flow (client ,profile ,identity ,app_channel ,version )
        session_key =app_start .session_key 
        try :
            cloud_guid =self .cloud_registration_flow (identity ,identity .x_uid )
        except YsptpError as reg_err :
            raise YsptpError (f'cloud device registration failed: {reg_err }')
        if not cloud_guid and device_state .cloud_guid :
            cloud_guid =device_state .cloud_guid 
        if not cloud_guid :
            raise YsptpError ('cloud device registration failed: empty guid, fallback to 1080p')
        now =now_f64 ()
        device_state .x_uid =identity .x_uid 
        device_state .updated_at =now 
        if cloud_guid :
            device_state .cloud_guid =cloud_guid 
            if device_state .registered_at <=0.0 :
                device_state .registered_at =now 
        if save_to_disk :
            try :
                save_device_state (target_json ,device_state )
            except OSError :
                pass 
        hb =self .heartbeat_flow (profile ,identity ,app_channel ,version ,cloud_guid )
        def _bg_telemetry ():
            try :
                self .collect_report (profile ,{'key':'app_start_d1','value':build_report_common_value (profile ,identity .x_uid ,app_channel ,version ,COLLECT_SDK_VERSION ,current_time_ms ())})
            except Exception :
                pass 
            try :
                self .dictionary_obtain (version )
            except Exception :
                pass 
            if cloud_guid :
                try :
                    self .device_info_report_flow (profile ,identity ,app_channel ,version ,cloud_guid )
                except Exception :
                    pass 
            try :
                self .index_flow (client ,identity ,app_channel )
            except Exception :
                pass 
            try :
                self .warmup_flow (client ,identity ,version )
            except Exception :
                pass 
        threading .Thread (target =_bg_telemetry ,daemon =True ,name ='telemetry-worker').start ()
        return AppSession (profile =profile ,identity =identity ,client =client ,session_key =session_key ,cloud_guid =cloud_guid ,version =version ,screen_param =device_state .screen_param ,cast_model =device_state .cast_model ,created_at =now_f64 (),generation =generation ,last_heartbeat_at =now_f64 (),heartbeat_count =1 ,last_heartbeat_result =hb ,last_heartbeat_error ='')
    def collect_report (self ,profile :DeviceProfile ,body :dict )->None :
        headers =build_collect_headers (profile )
        resp =self .generic_client .post_form (COLLECT_REPORT_URL ,headers ,[('info',json .dumps (body ,separators =(',',':'),ensure_ascii =False ,sort_keys =True ))])
        if not 200 <=resp .status <300 :
            raise YsptpError (f'collect report HTTP {http_status_text (resp .status ,resp .reason )}')
    def dictionary_obtain (self ,version :str )->None :
        with self .control_request_slot ('dictionary_obtain'):
            resp =self .generic_client .post_bytes (DICTIONARY_URL ,root_headers (version ),b'')
        if not 200 <=resp .status <300 :
            raise YsptpError (f'dictionary HTTP {http_status_text (resp .status ,resp .reason )}')
    def app_start_flow (self ,client :HttpClient ,profile :DeviceProfile ,identity :Identity ,app_channel :str ,version :str )->AppStartResult :
        last =''
        for attempt in range (1 ,3 ):
            if attempt >1 :
                time .sleep (float (attempt -1 ))
            with self .control_request_slot ('app_start'):
                token_time =current_time_ms ()
                xfp ,ts ,_day0 =compute_fingerprint (identity .x_uid ,token_time )
                identity .x_fingerprint =xfp 
                identity .fingerprint_timestamp_ms =ts 
                identity .headers ['X-Fingerprint']=xfp 
                body =build_app_start_body (profile ,identity .x_uid ,app_channel ,version ,current_time_ms ())
                payload =compact_json_bytes (body ,True )
                headers =fresh_headers (identity .headers ,'application/json','application/json',ts )
                headers ['UID']=''
                resp =client .post_bytes (APP_START_URL ,headers ,payload )
                status ,text ,value =response_json (resp )
                if 200 <=status <300 :
                    data =value .get ('data')if isinstance (value ,dict )else None 
                    encrypted =''
                    if isinstance (data ,dict ):
                        key_val =data .get ('key',data )
                        encrypted =key_val if isinstance (key_val ,str )else ''
                    elif isinstance (data ,str ):
                        encrypted =data 
                    if encrypted :
                        session_key =aes_gcm_decrypt_b64 (encrypted ,xfp [:32 ])
                        return AppStartResult (session_key =session_key )
                last =f'app/start HTTP {status }: {text [:300 ]}'
        raise YsptpError (last )
    def cloud_registration_flow (self ,identity :Identity ,cloud_device_id :str )->str :
        body ={'device_name':DEFAULT_DEVICE_NAME ,'device_id':rsa_encrypt_device_id (cloud_device_id )}
        with self .control_request_slot ('cloud_get'):
            resp =self .generic_client .post_json (CLOUD_GET_URL ,fresh_headers (identity .headers ,'application/json','application/json',None ),body )
        _ ,_ ,value =response_json (resp )
        result =parse_result_code (value )
        if result ==RESULT_OK :
            return extract_guid (value )
        if result !=RESULT_NEEDS_REGISTER and result !=RESULT_GET_MISSING_OR_INVALID :
            return ''
        last_result =None 
        guid =''
        for _ in range (2 ):
            with self .control_request_slot ('cloud_register'):
                resp =self .generic_client .post_json (CLOUD_REGISTER_URL ,fresh_headers (identity .headers ,'application/json','application/json',None ),body )
            _ ,_ ,value =response_json (resp )
            last_result =parse_result_code (value )
            guid =extract_guid (value )
            if guid or last_result !=RESULT_REGISTER_RETRY_LATER :
                break 
        if guid :
            return guid 
        if last_result in (RESULT_OK ,RESULT_REGISTERED_ELSEWHERE ,RESULT_GET_MISSING_OR_INVALID ):
            with self .control_request_slot ('cloud_get_after_register'):
                resp =self .generic_client .post_json (CLOUD_GET_URL ,fresh_headers (identity .headers ,'application/json','application/json',None ),body )
            _ ,_ ,value =response_json (resp )
            return extract_guid (value )
        return ''
    def device_info_report_flow (self ,profile :DeviceProfile ,identity :Identity ,app_channel :str ,version :str ,cloud_guid :str )->None :
        with self .control_request_slot ('device_info_report'):
            value =build_report_common_value (profile ,identity .x_uid ,app_channel ,version ,'',current_time_ms ())
            sdk_int =infer_sdk_int (profile )
            system_info =infer_os_version (profile )
            if sdk_int :
                system_info =sdk_int if not system_info else f'{system_info }/{sdk_int }'
            value ['version']=version 
            value ['network_status']='WiFi'
            value ['device_info']=f'{profile .brand }-{profile .model }'
            value ['manufacturer']=profile .manufacturer 
            value ['cpu_info']=''
            value ['chip_info']=profile .hardware 
            value ['ram_info']=''
            value ['memory_info']=''
            value ['system_info']=system_info 
            value ['guid']=cloud_guid 
            body ={'key':'app_device_info','value':value }
            resp =self .generic_client .post_json (REPORT_SINGLE_URL ,fresh_headers (identity .headers ,'application/json','application/json',None ),body )
            if not 200 <=resp .status <300 :
                raise YsptpError (f'device info HTTP {http_status_text (resp .status ,resp .reason )}')
    def heartbeat_flow (self ,profile :DeviceProfile ,identity :Identity ,app_channel :str ,version :str ,cloud_guid :str )->str :
        with self .control_request_slot ('heartbeat'):
            value =build_report_common_value (profile ,identity .x_uid ,app_channel ,version ,'',current_time_ms ())
            value ['network_type']='WiFi'
            value ['guid']=cloud_guid 
            value ['other']=''
            body ={'key':'app_heartbeat','value':value }
            resp =self .generic_client .post_json (REPORT_SINGLE_URL ,fresh_headers (identity .headers ,'application/json','application/json',None ),body )
            status ,_text ,value =response_json (resp )
            if not 200 <=status <300 :
                raise YsptpError (f'heartbeat HTTP {status }')
            code =parse_result_code (value )
            return ''if code is None else str (code )
    def index_flow (self ,client :HttpClient ,identity :Identity ,app_channel :str )->None :
        body ={'channel':app_channel ,'source':'application'}
        with self .control_request_slot ('index'):
            resp =client .post_json (INDEX_URL ,fresh_headers (identity .headers ,'application/json','application/json',None ),body )
            if not 200 <=resp .status <300 :
                raise YsptpError (f'index HTTP {http_status_text (resp .status ,resp .reason )}')
    def warmup_flow (self ,client :HttpClient ,identity :Identity ,version :str )->None :
        appcommon =build_vdn_appcommon (version )
        with self .control_request_slot ('drm_config'):
            resp =client .post_form (DRM_CONFIG_URL ,fresh_headers (identity .headers ,'application/x-www-form-urlencoded',None ,None ),[('appcommon',appcommon )])
            if not 200 <=resp .status <300 :
                raise YsptpError (f'drm config HTTP {http_status_text (resp .status ,resp .reason )}')
        url =f'{VERSION_CONFIG_URL }?appcommon={form_urlencode_value (appcommon )}'
        with self .control_request_slot ('version_config'):
            headers =fresh_headers (identity .headers ,'',None ,None )
            headers .pop ('Content-Type',None )
            resp =client .get (url ,headers )
            if not 200 <=resp .status <300 :
                raise YsptpError (f'version config HTTP {http_status_text (resp .status ,resp .reason )}')
    def resolve_channel_once (self ,sess :AppSession ,channel :str ,live_id :str ,generation :int )->ChannelEntry :
        live01 =self .live_v1_01_flow (sess ,live_id )
        app_secret =self .live_v1_02_flow (sess )
        vdn =self .vdn_getstream_flow (sess .identity ,sess .version ,live01 .live_url ,app_secret )
        now =now_f64 ()
        playback_headers =default_cctv_playback_headers (sess .profile .android_id )
        playback_headers ['APPRANDOMSTR']=vdn .app_random_str 
        playback_headers ['APPSIGN']=vdn .app_sign 
        sess .linked_channels .add (channel )
        display_rate_name =live01 .rate_name or '高码率'
        if channel in ('cctv4k','cctv164k','cctv8k'):
            if '8K'in display_rate_name or display_rate_name in ('8K高清','8K超高清'):
                display_rate_name ='4K超高清'
        elif display_rate_name in ('8K高清','4K高清','8K超高清','4K超高清'):
            display_rate_name ='高码率'
        return ChannelEntry (channel =channel ,live_id =live_id ,final_url =vdn .final_url ,playback_headers =playback_headers ,android_id =sess .profile .android_id ,x_uid =sess .identity .x_uid ,rate =live01 .rate ,rate_name =display_rate_name ,raw_live_host =url_host (live01 .live_url ),final_host =url_host (vdn .final_url ),refreshed_at =now ,expires_at =now +float (self .args .cache_ttl ),generation =generation ,last_refresh_error ='',last_refresh_failed_at =0.0 ,session_generation =sess .generation )
    def live_v1_01_flow (self ,sess :AppSession ,live_id :str )->Live01Result :
        body ={'screenParam':sess .screen_param ,'rate':'','systemType':'ios','model':sess .cast_model ,'id':live_id ,'userId':DEFAULT_LIVE_USER_ID ,'clientSign':'cctvVideo','deviceId':{'serial':'','imei':'','android_id':''}}
        with self .control_request_slot ('live_v1_01'):
            resp =sess .client .post_json (LIVE_V1_01_URL ,fresh_headers (sess .identity .headers ,'application/json','application/json',None ),body )
        status ,text ,value =response_json (resp )
        if not 200 <=status <300 :
            raise YsptpError (f'live/v1/01 HTTP {status }: {text [:300 ]}')
        videos =None 
        if isinstance (value ,dict ):
            data =value .get ('data')
            if isinstance (data ,dict ):
                videos =data .get ('videoList')or data .get ('videos')
        if not isinstance (videos ,list ):
            raise YsptpError ('live/v1/01 missing videos')
        selected =None 
        fallback =None 
        for item in videos :
            if not isinstance (item ,dict ):
                continue 
            url =item .get ('url')
            if not isinstance (url ,str )or not url :
                continue 
            if fallback is None :
                fallback =item 
            if item .get ('rate')=='36p':
                selected =item 
                break 
        video =selected if selected is not None else fallback 
        if video is None :
            raise YsptpError ('live/v1/01 no usable URL')
        raw_url =video .get ('url','')
        if raw_url .startswith ('http://')or raw_url .startswith ('https://'):
            live_url =raw_url 
        else :
            live_url =aes_gcm_decrypt_b64 (raw_url ,sess .session_key )
        rate =video .get ('rate')
        rate_name =video .get ('rateName')
        return Live01Result (live_url =live_url ,rate =rate if isinstance (rate ,str )else '',rate_name =rate_name if isinstance (rate_name ,str )else '')
    def live_v1_02_flow (self ,sess :AppSession )->str :
        with self .control_request_slot ('live_v1_02'):
            encrypted_guid =aes_gcm_encrypt_b64 ('',sess .session_key )
            body ={'guid':encrypted_guid }
            resp =sess .client .post_json (LIVE_V1_02_URL ,fresh_headers (sess .identity .headers ,'application/json','application/json',None ),body )
        status ,text ,value =response_json (resp )
        if not 200 <=status <300 :
            raise YsptpError (f'live/v1/02 HTTP {status }: {text [:300 ]}')
        encrypted =None 
        if isinstance (value ,dict ):
            data =value .get ('data')
            if isinstance (data ,dict ):
                for key in ('appSecret','app_secret'):
                    v =data .get (key )
                    if isinstance (v ,str ):
                        encrypted =v 
                        break 
            if encrypted is None and isinstance (data ,str ):
                encrypted =data 
        if encrypted is None :
            raise YsptpError ('live/v1/02 missing appSecret')
        return aes_gcm_decrypt_b64 (encrypted ,sess .session_key )
    def vdn_getstream_flow (self ,identity :Identity ,version :str ,live_url :str ,app_secret :str )->VdnGetStreamResult :
        with self .control_request_slot ('vdn_getstream'):
            app_sign ,random_str =compute_vdn_code (app_secret ,None )
            headers =fresh_headers (identity .headers ,'application/x-www-form-urlencoded',None ,None )
            headers ['APPID']=AK 
            headers ['APPSIGN']=app_sign 
            headers ['APPRANDOMSTR']=random_str 
            appcommon =build_vdn_appcommon (version )
            resp =self .generic_client .post_form (VDN_GETSTREAM_URL ,headers ,[('appcommon',appcommon ),('url',live_url )])
        status ,text ,value =response_json (resp )
        if not 200 <=status <300 :
            raise YsptpError (f'VDN HTTP {status }: {text [:300 ]}')
        if isinstance (value ,dict ):
            succeed =value .get ('succeed')
            succeed_str =succeed .strip ('"')if isinstance (succeed ,str )else json .dumps (succeed ,separators =(',',':'),ensure_ascii =False ).strip ('"')if succeed is not None else ''
            if succeed_str =='1':
                url =value .get ('url')
                if isinstance (url ,str ):
                    return VdnGetStreamResult (final_url =url ,app_sign =app_sign ,app_random_str =random_str )
        raise YsptpError (f'VDN did not return final URL: {text [:400 ]}')
    def send_heartbeat (self )->None :
        if not self .control_lock .acquire (blocking =False ):
            return 
        try :
            with self .state_lock :
                slots =list (self .state .sessions .keys ())
            if not slots :
                return 
            for slot in slots :
                try :
                    with self .state_lock :
                        s_curr =self .state .sessions .get (slot )
                    if s_curr is None :
                        continue 
                    self .evict_idle_links (s_curr ,LINK_IDLE_TIMEOUT )
                    rem_ttl =self .app_session_ttl_remaining (s_curr )
                    if not self .app_session_fresh (s_curr )or (rem_ttl is not None and rem_ttl <=300.0 ):
                        s_curr =self .ensure_slot_session (slot )
                        continue 
                    with self .state_lock :
                        wait =float (self .args .refresh_interval )-(now_f64 ()-self .state .last_business_end_at )
                    if wait >0.0 :
                        time .sleep (wait )
                    code =self .heartbeat_flow (s_curr .profile ,s_curr .identity ,'dangbei',s_curr .version ,s_curr .cloud_guid )
                    with self .state_lock :
                        self .state .last_business_end_at =now_f64 ()
                        s_curr .last_heartbeat_at =now_f64 ()
                        s_curr .heartbeat_count +=1 
                        s_curr .last_heartbeat_result =code 
                        s_curr .last_heartbeat_error =''
                except YsptpError as err :
                    err_text =str (err )
                    with self .state_lock :
                        s_curr =self .state .sessions .get (slot )
                        if s_curr is not None :
                            s_curr .last_heartbeat_error =err_text 
                        self .state .last_error =f'heartbeat failed on slot {slot }: {err_text }'
                        self .state .last_error_at =now_f64 ()
                except Exception :
                    pass 
            set_resolver_ready (True )
        finally :
            self .control_lock .release ()
    def proxy_playlist_ts_urls (self ,playlist :str ,proxy_origin :str ,proxy_prefix =None )->str :
        origin =(proxy_prefix or proxy_origin ).rstrip ('/')
        proxy_query ='/proxy?ts='if proxy_prefix is not None else '/proxy.ts?='
        out =[]
        for line in _rs_lines (playlist ):
            stripped =line .strip ()
            if not stripped or stripped .startswith ('#'):
                out .append (line )
            elif is_ts_url (stripped ):
                encoded =base64 .urlsafe_b64encode (stripped .encode ('utf-8')).rstrip (b'=')
                out .append (f"{origin }{proxy_query }{encoded .decode ('ascii')}")
            else :
                out .append (line )
        return ''.join ((ln +'\n'for ln in out ))
    def playback_headers_for_ts_url (self ,real_url :str )->dict :
        try :
            parsed =urllib .parse .urlsplit (real_url )
        except ValueError as e :
            raise YsptpError (f'invalid proxy ts URL: {e }')
        host =parsed .hostname 
        if not host :
            raise YsptpError ('proxy ts URL missing host')
        ts_path =parsed .path 
        same_host_headers =None 
        with self .state_lock :
            for entry in self .state .cache .values ():
                if entry_missing_signed_playback_headers (entry ):
                    continue 
                entry_host =entry .final_host or url_host (entry .final_url )
                if entry_host .lower ()!=host .lower ():
                    continue 
                headers =cctv_playback_headers_for_entry (entry )
                if ts_path_matches_final_url (ts_path ,entry .final_url ):
                    return headers 
                if same_host_headers is None :
                    same_host_headers =headers 
        if same_host_headers is not None :
            return same_host_headers 
        if live_playback_host_needs_signed_headers (host ):
            raise YsptpError (f'missing cached signed playback headers for {host }')
        uid =current_cctv_android_id (self )
        return default_cctv_playback_headers (uid )
    def fetch_playlist (self ,entry :ChannelEntry ,proxy_origin :str ,proxy_prefix =None ):
        now =now_f64 ()
        with self .state_lock :
            probe =inspect_playlist_cache (self .state .playlist_cache .get (entry .channel ),entry ,proxy_origin ,proxy_prefix ,now )
            if probe .state =='hit':
                cached =self .state .playlist_cache [entry .channel ]
                return (cached .body ,cached .content_type ,probe )
        with self .playlist_locks_lock :
            lock =self .playlist_locks .get (entry .channel )
            if lock is None :
                lock =threading .Lock ()
                self .playlist_locks [entry .channel ]=lock 
        with lock :
            now =now_f64 ()
            with self .state_lock :
                probe =inspect_playlist_cache (self .state .playlist_cache .get (entry .channel ),entry ,proxy_origin ,proxy_prefix ,now )
                if probe .state =='hit':
                    cached =self .state .playlist_cache [entry .channel ]
                    return (cached .body ,cached .content_type ,probe )
                miss_probe =probe 
            playback_headers =cctv_playback_headers_for_entry (entry )
            try :
                status ,content_type ,text =fetch_playlist_http1 (entry .final_url ,playback_headers )
            except YsptpError as err :
                self .record_recoverable_error (str (err ))
                with self .state_lock :
                    cached =self .state .playlist_cache .get (entry .channel )
                if cached and (now_f64 ()-cached .cached_at <20.0 ):
                    return (cached .body ,cached .content_type ,miss_probe )
                raise 
            if not 200 <=status <300 :
                err =YsptpError (f'upstream m3u8 HTTP {status }: {text [:300 ]}')
                self .record_recoverable_error (str (err ))
                with self .state_lock :
                    cached =self .state .playlist_cache .get (entry .channel )
                if cached and (now_f64 ()-cached .cached_at <20.0 ):
                    return (cached .body ,cached .content_type ,miss_probe )
                raise err 
            self .clear_recoverable_error_count ()
            body =rewrite_playlist_urls (text ,entry .final_url )
            body =self .proxy_playlist_ts_urls (body ,proxy_origin ,proxy_prefix )
            if float (self .args .playlist_cache_ttl )>0.0 :
                now =now_f64 ()
                cached =PlaylistCacheEntry (body =body ,content_type =content_type ,cached_at =now ,expires_at =now +float (self .args .playlist_cache_ttl ),final_url =entry .final_url ,android_id =entry .android_id ,proxy_origin =proxy_origin ,proxy_prefix =proxy_prefix or '')
                with self .state_lock :
                    self .state .playlist_cache [entry .channel ]=cached 
            return (body ,content_type ,miss_probe )
    def fetch_channel_playlist (self ,channel :str ,host_header :str ,proto :str ='http')->str :
        with self .state_lock :
            self .state .channel_last_access [channel ]=now_f64 ()
        if self .zap_debounced (channel ):
            log (f'[{channel }] 换台防抖: 先出 1080p, 停留后自动升码率',min_interval =10.0 )
            return None 
        host =host_header .strip ()if host_header else f'localhost:{server_port }'
        scheme =proto if proto in ('http','https')else 'http'
        proxy_origin =f'{scheme }://{host }'
        entry =self .ensure_channel (channel )
        for attempt in range (2 ):
            try :
                body ,_content_type ,_probe =self .fetch_playlist (entry ,proxy_origin )
                self .clear_channel_cooldown (channel )
                return body 
            except YsptpError as e :
                err_str =str (e )
                is_expiry ='HTTP 403'in err_str or 'HTTP 404'in err_str or 'HTTP 401'in err_str or 'upstream m3u8'in err_str 
                if is_expiry and attempt ==0 :
                    log (f'[{channel }] 高码率播放地址已过期，正在极速重取新地址…',min_interval =4.0 )
                    with self .state_lock :
                        self .state .cache .pop (channel ,None )
                        self .state .playlist_cache .pop (channel ,None )
                    entry =self .ensure_channel (channel ,force =True )
                    continue 
                raise 
    def status_json (self )->dict :
        with self .state_lock :
            state_snapshot ={'refreshing_channel':self .state .refreshing_channel ,'last_business_end_at':self .state .last_business_end_at ,'last_error':self .state .last_error ,'identity_reset_error_count':self .state .identity_reset_error_count ,'identity_reset_count':self .state .identity_reset_count ,'last_identity_reset_at':self .state .last_identity_reset_at ,'last_identity_reset_reason':self .state .last_identity_reset_reason ,'ad_display':self .state .ad_display ,'generation':self .state .generation ,'session_generation':self .state .session_generation ,'cache':dict (self .state .cache ),'playlist_cache':dict (self .state .playlist_cache ),'background_refreshing':dict (self .state .background_refreshing ),'app_session':self .state .app_session }
        now =now_f64 ()
        if os .path .exists (self .args .device_json ):
            loaded ,existed =load_device_state (self .args .device_json )
            device_state ={'exists':existed ,'android_id':loaded .profile .android_id ,'mac':loaded .profile .mac ,'brand':loaded .profile .brand ,'model':loaded .profile .model ,'screen_param':loaded .screen_param ,'x_uid':loaded .x_uid ,'cloud_guid_present':bool (loaded .cloud_guid ),'registered_at':loaded .registered_at ,'updated_at':loaded .updated_at }
        else :
            device_state ={'exists':False }
        cache ={}
        for k ,v in state_snapshot ['cache'].items ():
            cache [k ]={'live_id':v .live_id ,'fresh':v .fresh (now ),'age_seconds':rust_round ((now -v .refreshed_at )*1000.0 )/1000.0 ,'expires_in_seconds':rust_round ((v .expires_at -now )*1000.0 )/1000.0 ,'rate':v .rate ,'rate_name':v .rate_name ,'final_host':v .final_host ,'generation':v .generation ,'session_generation':v .session_generation ,'last_refresh_error':v .last_refresh_error }
        playlist_cache ={}
        for k ,v in state_snapshot ['playlist_cache'].items ():
            playlist_cache [k ]={'fresh':now <v .expires_at ,'age_seconds':rust_round ((now -v .cached_at )*1000.0 )/1000.0 ,'expires_in_seconds':rust_round ((v .expires_at -now )*1000.0 )/1000.0 ,'bytes':len (v .body .encode ('utf-8')),'content_type':v .content_type ,'proxy_origin':v .proxy_origin ,'proxy_prefix':v .proxy_prefix }
        sess =state_snapshot ['app_session']
        if sess is not None :
            expires_in =float (self .args .session_ttl )-(now -sess .created_at )if float (self .args .session_ttl )>0.0 else None 
            app_session ={'active':True ,'generation':sess .generation ,'age_seconds':rust_round ((now -sess .created_at )*1000.0 )/1000.0 ,'fresh':self .app_session_fresh (sess ),'expires_in_seconds':expires_in ,'android_id':sess .profile .android_id ,'mac':sess .profile .mac ,'brand':sess .profile .brand ,'model':sess .profile .model ,'screen_param':sess .screen_param ,'cast_model':sess .cast_model ,'x_uid':sess .identity .x_uid ,'cloud_guid_present':bool (sess .cloud_guid ),'fingerprint_timestamp_ms':sess .identity .fingerprint_timestamp_ms ,'heartbeat_count':sess .heartbeat_count ,'last_heartbeat_age_seconds':rust_round ((now -sess .last_heartbeat_at )*1000.0 )/1000.0 ,'last_heartbeat_result':sess .last_heartbeat_result ,'last_heartbeat_error':sess .last_heartbeat_error }
        else :
            app_session ={'active':False ,'generation':state_snapshot ['session_generation']}
        rq =self .refresh_queue 
        with rq .cond :
            refresh_queue ={'limit':int (self .args .background_refresh_queue_limit ),'queued_depth':len (rq .queued ),'queued_channels':list (rq .queued ),'running_channel':rq .running_channel ,'running_age_seconds':rust_round ((now -rq .running_started_at )*1000.0 )/1000.0 if rq .running_started_at >0.0 else None ,'enqueued_total':rq .enqueued_total ,'dropped_total':rq .dropped_total ,'completed_total':rq .completed_total ,'failed_total':rq .failed_total ,'last_enqueued_age_seconds':rust_round ((now -rq .last_enqueued_at )*1000.0 )/1000.0 if rq .last_enqueued_at >0.0 else None ,'last_finished_age_seconds':rust_round ((now -rq .last_finished_at )*1000.0 )/1000.0 if rq .last_finished_at >0.0 else None ,'last_dropped_age_seconds':rust_round ((now -rq .last_dropped_at )*1000.0 )/1000.0 if rq .last_dropped_at >0.0 else None ,'last_drop_reason':rq .last_drop_reason }
        hq =self .http_queue 
        with hq .cond :
            http_queue ={'workers':max (1 ,int (self .args .http_workers )),'limit':int (self .args .http_queue_limit ),'queued_depth':len (hq .queued ),'active_workers':hq .active_workers ,'enqueued_total':hq .enqueued_total ,'rejected_total':hq .rejected_total ,'completed_total':hq .completed_total ,'panicked_total':hq .panicked_total ,'last_enqueued_age_seconds':rust_round ((now -hq .last_enqueued_at )*1000.0 )/1000.0 if hq .last_enqueued_at >0.0 else None ,'last_completed_age_seconds':rust_round ((now -hq .last_completed_at )*1000.0 )/1000.0 if hq .last_completed_at >0.0 else None ,'last_rejected_age_seconds':rust_round ((now -hq .last_rejected_at )*1000.0 )/1000.0 if hq .last_rejected_at >0.0 else None }
        return {'channels':[c for c ,_ in channels ()],'cache_ttl_seconds':float (self .args .cache_ttl ),'stale_while_refresh_ttl_seconds':float (self .args .stale_while_refresh_ttl ),'refresh_error_cooldown_seconds':float (self .args .refresh_error_cooldown ),'playlist_cache_ttl_seconds':float (self .args .playlist_cache_ttl ),'background_refresh_queue_limit':int (self .args .background_refresh_queue_limit ),'http_workers':max (1 ,int (self .args .http_workers )),'http_queue_limit':int (self .args .http_queue_limit ),'identity_reset_error_threshold':int (self .args .identity_reset_error_threshold ),'identity_reset_cooldown_seconds':float (self .args .identity_reset_cooldown ),'refresh_interval_seconds':float (self .args .refresh_interval ),'control_step_jitter_min_ms':int (self .args .control_step_jitter_min_ms ),'control_step_jitter_max_ms':int (self .args .control_step_jitter_max_ms ),'heartbeat_interval_seconds':float (self .args .heartbeat_interval ),'heartbeat_ttl_guard_seconds':float (self .args .heartbeat_ttl_guard ),'session_ttl_seconds':float (self .args .session_ttl ),'meta_json':self .args .meta_json ,'device_json':self .args .device_json ,'device_state':device_state ,'refreshing_channel':state_snapshot ['refreshing_channel'],'background_refreshing':list (state_snapshot ['background_refreshing'].keys ()),'background_refresh_queue':refresh_queue ,'http_queue':http_queue ,'generation':state_snapshot ['generation'],'app_session':app_session ,'last_business_end_at':state_snapshot ['last_business_end_at'],'last_error':state_snapshot ['last_error'],'identity_reset_error_count':state_snapshot ['identity_reset_error_count'],'identity_reset_count':state_snapshot ['identity_reset_count'],'last_identity_reset_at':state_snapshot ['last_identity_reset_at'],'last_identity_reset_reason':state_snapshot ['last_identity_reset_reason'],'ad_display':state_snapshot ['ad_display'],'device_profile_pool_size':len (DEVICE_PROFILE_POOL ),'cache':cache ,'playlist_cache':playlist_cache }
    def write_meta (self )->None :
        try :
            payload =self .status_json ()
            with self .state_lock :
                cache_detail ={k :dataclasses .asdict (v )for k ,v in self .state .cache .items ()}
            payload ['cache_detail']=cache_detail 
            payload ['session_detail_note']='Session secrets are intentionally not persisted for reuse; Python process keeps live session in memory only.'
            payload ['device_state_note']='Randomized TV device identity is persisted in device-state-rs.json after cloud registration succeeds; a new identity reset creates a new profile and MAC.'
            parent =os .path .dirname (os .path .abspath (self .args .meta_json ))
            if parent :
                os .makedirs (parent ,exist_ok =True )
            tmp_path =self .args .meta_json +f'.tmp.{os .getpid ()}'
            with open (tmp_path ,'w',encoding ='utf-8')as f :
                f .write (json .dumps (payload ,indent =2 ,ensure_ascii =False ,sort_keys =True )+'\n')
                f .flush ()
                os .fsync (f .fileno ())
            os .replace (tmp_path ,self .args .meta_json )
        except Exception :
            try :
                if 'tmp_path'in locals ()and os .path .exists (tmp_path ):
                    os .remove (tmp_path )
            except OSError :
                pass 
def load_cache (path :str )->dict :
    try :
        with open (path ,encoding ='utf-8')as f :
            value =json .load (f )
    except (OSError ,ValueError ):
        return {}
    detail =value .get ('cache_detail')if isinstance (value ,dict )else None 
    if not isinstance (detail ,dict ):
        return {}
    try :
        return {k :ChannelEntry .from_dict (v )for k ,v in detail .items ()if isinstance (v ,dict )}
    except (ValueError ,TypeError ):
        return {}
def _playback_request_headers (playback_headers :dict ,extra :dict |None =None )->dict :
    headers ={}
    for key in ('UID','APPID','APPRANDOMSTR','Referer','User-Agent','APPSIGN'):
        value =playback_headers .get (key )
        if value is not None and str (value ).strip ():
            headers [key ]=header_value_clean (str (value ))
    headers ['Accept']='*/*'
    headers ['Accept-Encoding']='identity'
    headers ['Connection']='close'
    if extra :
        headers .update (extra )
    return headers 
def fetch_playlist_http1 (final_url :str ,playback_headers :dict ):
    current_url =final_url 
    for _ in range (4 ):
        try :
            parts =urllib .parse .urlsplit (current_url )
        except ValueError as e :
            raise YsptpError (f'invalid final URL: {e }')
        if parts .scheme not in ('http','https'):
            raise YsptpError (f'manual playlist fetch currently expects http or https URL, got {parts .scheme }')
        host =parts .hostname 
        if not host :
            raise YsptpError ('final URL missing host')
        is_https =(parts .scheme =='https')
        port =parts .port or (443 if is_https else 80 )
        host_header =f'{host }:{parts .port }'if parts .port else host 
        target =parts .path or '/'
        if parts .query :
            target +='?'+parts .query 
        headers =_playback_request_headers (playback_headers )
        headers ['Host']=host_header 
        if is_https :
            conn =http .client .HTTPSConnection (host ,port ,timeout =20 ,context =ssl .create_default_context ())
        else :
            conn =http .client .HTTPConnection (host ,port ,timeout =20 )
        try :
            try :
                conn .request ('GET',target ,headers =headers )
                resp =conn .getresponse ()
            except Exception as e :
                raise YsptpError (_normalize_network_error (e ))
            status =resp .status 
            loc =resp .getheader ('Location')
            content_type =resp .getheader ('Content-Type')or 'application/vnd.apple.mpegurl'
            try :
                body =resp .read ()
            except Exception as e :
                raise YsptpError (_normalize_network_error (e ))
        finally :
            conn .close ()
        if status in (301 ,302 ,303 ,307 ,308 )and loc :
            current_url =urllib .parse .urljoin (current_url ,loc )
            continue 
        return (status ,content_type ,body .decode ('utf-8',errors ='replace'))
    raise YsptpError ('too many redirects fetching playlist')
def query_param (url :str ,name :str ):
    if '?'not in url :
        return None 
    _ ,query =url .split ('?',1 )
    for pair in query .split ('&'):
        key ,_ ,value =pair .partition ('=')
        if key ==name :
            return value 
    return None 
def proxy_ts_token (url :str ):
    if '?'not in url :
        return None 
    _ ,query =url .split ('?',1 )
    if query .startswith ('='):
        token =query [1 :]
        return token or None 
    token =query_param (url ,'ts')
    if token :
        return token 
    token =query_param (url ,'url')
    if token :
        return token 
    if query and '='not in query :
        return query 
    return None 
def decode_proxy_ts_url (token :str )->str :
    padded =token +'='*(-len (token )%4 )
    try :
        raw =base64 .urlsafe_b64decode (padded .encode ('ascii'))
    except (binascii .Error ,ValueError )as e :
        raise YsptpError (f'invalid proxy ts token: {e }')
    try :
        value =raw .decode ('utf-8')
    except UnicodeDecodeError as e :
        raise YsptpError (f'proxy ts token is not UTF-8: {e }')
    try :
        parsed =urllib .parse .urlsplit (value )
    except ValueError as e :
        raise YsptpError (f'proxy ts token is not a URL: {e }')
    if parsed .scheme not in ('http','https'):
        raise YsptpError (f'proxy ts currently requires http or https URL, got {parsed .scheme }')
    if not parsed .path .lower ().endswith ('.ts'):
        raise YsptpError ('proxy ts URL is not a .ts segment')
    return value 
def current_cctv_android_id (resolver :Resolver )->str :
    if os .path .exists (resolver .args .device_json ):
        loaded ,_ =load_device_state (resolver .args .device_json )
        if loaded .profile .android_id :
            return loaded .profile .android_id 
    with resolver .state_lock :
        sess =resolver .state .app_session 
        if sess is not None and sess .profile .android_id :
            return sess .profile .android_id 
        for entry in resolver .state .cache .values ():
            if entry .android_id :
                return entry .android_id 
    raise YsptpError ('missing cctv android_id')
def resolve_paths (args :argparse .Namespace )->None :
    d =binary_dir ()
    if not args .meta_json .strip ():
        args .meta_json =os .path .join (d ,'proxy-cache-state-rs.json')
    if not args .device_json .strip ():
        args .device_json =os .path .join (d ,'device-state-rs.json')
class W :
    def __init__ (self ):
        self .b =bytearray ()
    def head (self ,typ ,tag ):
        if tag <15 :
            self .b .append ((tag &15 )<<4 |typ &15 )
        else :
            self .b .append (240 |typ &15 )
            self .b .append (tag )
    def byte (self ,v ,tag ):
        v =int (v )
        if v ==0 :
            self .head (12 ,tag )
        else :
            self .head (0 ,tag )
            self .b +=struct .pack ('>b',v )
    def short (self ,v ,tag ):
        v =int (v )
        if -128 <=v <=127 :
            self .byte (v ,tag )
        else :
            self .head (1 ,tag )
            self .b +=struct .pack ('>h',v )
    def int (self ,v ,tag ):
        v =int (v )
        if -32768 <=v <=32767 :
            self .short (v ,tag )
        else :
            self .head (2 ,tag )
            self .b +=struct .pack ('>i',v )
    def long (self ,v ,tag ):
        v =int (v )
        if -2147483648 <=v <=2147483647 :
            self .int (v ,tag )
        else :
            self .head (3 ,tag )
            self .b +=struct .pack ('>q',v )
    def float (self ,v ,tag ):
        self .head (4 ,tag )
        self .b +=struct .pack ('>f',float (v ))
    def double (self ,v ,tag ):
        self .head (5 ,tag )
        self .b +=struct .pack ('>d',float (v ))
    def string (self ,s ,tag ):
        if s is None :
            return 
        data =str (s ).encode ('utf-8')
        if len (data )>255 :
            self .head (7 ,tag )
            self .b +=struct .pack ('>i',len (data ))
            self .b +=data 
        else :
            self .head (6 ,tag )
            self .b .append (len (data ))
            self .b +=data 
    def bytes (self ,data ,tag ):
        data =bytes (data )
        self .head (13 ,tag )
        self .head (0 ,0 )
        self .int (len (data ),0 )
        self .b +=data 
    def struct (self ,fn ,tag ):
        self .head (10 ,tag )
        fn (self )
        self .head (11 ,0 )
    def list (self ,items ,tag ,wf ):
        self .head (9 ,tag )
        self .int (len (items ),0 )
        if wf is not None :
            for item in items :
                wf (self ,item )
    def out (self ):
        return bytes (self .b )
class R :
    def __init__ (self ,data ):
        self .d =memoryview (data )
        self .p =0 
    def rem (self ):
        return len (self .d )-self .p 
    def get (self ,n ):
        if self .p +n >len (self .d ):
            raise EOFError 
        b =self .d [self .p :self .p +n ].tobytes ()
        self .p +=n 
        return b 
    def u8 (self ):
        return self .get (1 )[0 ]
    def head (self ):
        b =self .u8 ()
        typ =b &15 
        tag =(b &240 )>>4 
        if tag ==15 :
            tag =self .u8 ()
        return (typ ,tag )
    def value (self ,typ ):
        if typ ==0 :
            return struct .unpack ('>b',self .get (1 ))[0 ]
        if typ ==1 :
            return struct .unpack ('>h',self .get (2 ))[0 ]
        if typ ==2 :
            return struct .unpack ('>i',self .get (4 ))[0 ]
        if typ ==3 :
            return struct .unpack ('>q',self .get (8 ))[0 ]
        if typ ==4 :
            return struct .unpack ('>f',self .get (4 ))[0 ]
        if typ ==5 :
            return struct .unpack ('>d',self .get (8 ))[0 ]
        if typ ==6 :
            n =self .u8 ()
            return self .get (n ).decode ('utf-8','replace')
        if typ ==7 :
            n =struct .unpack ('>i',self .get (4 ))[0 ]
            return self .get (n ).decode ('utf-8','replace')
        if typ ==8 :
            n =self ._int ()
            return {self ._fv ():self ._fv ()for _ in range (n )}
        if typ ==9 :
            n =self ._int ()
            return [self ._fv ()for _ in range (n )]
        if typ ==10 :
            return self .struct ()
        if typ ==11 :
            return None 
        if typ ==12 :
            return 0 
        if typ ==13 :
            t ,_ =self .head ()
            n =self ._int ()
            return self .get (n )
        raise ValueError ('type %d'%typ )
    def _fv (self ):
        t ,_ =self .head ()
        return self .value (t )
    def _int (self ):
        t ,_ =self .head ()
        return int (self .value (t ))
    def struct (self ):
        m ={}
        while self .rem ()>0 :
            t ,tag =self .head ()
            if t ==11 :
                break 
            m [tag ]=self .value (t )
        return m 
VER_NAME ,VER_CODE =('3.2.7.26212','302070')
APP_ID ,QMF_APP_ID ,QMF_PLATFORM ,BIZ_ID =('1200013',10012 ,1 ,0 )
CHAN_ID ='10070'
GUID =''.join ((random .choice ('0123456789abcdef')for _ in range (32 )))
def _qua (w ):
    w .string (VER_NAME ,0 )
    w .string (VER_CODE ,1 )
    w .int (1080 ,2 )
    w .int (2400 ,3 )
    w .int (3 ,4 )
    w .string ('12',5 )
    w .int (1 ,6 )
    w .int (1 ,7 )
    w .int (420 ,8 )
    w .string (CHAN_ID ,9 )
    for i in range (10 ,15 ):
        w .string ('',i )
    w .struct (lambda ww :(ww .int (0 ,0 ),ww .byte (0 ,1 ),ww .string ('',2 )),15 )
    w .string ('',16 )
    w .string ('',17 )
    w .string ('',18 )
    w .struct (lambda ww :(ww .int (0 ,0 ),ww .float (0 ,1 ),ww .float (0 ,2 ),ww .double (0 ,3 )),19 )
    w .string (GUID [:16 ],20 )
    w .string ('Pixel 6',21 )
    w .int (1 ,22 )
    for i in range (23 ,27 ):
        w .int (0 ,i )
    w .string ('',27 )
    w .string ('',28 )
    w .string (GUID ,29 )
def _head (w ,cmd ,reqid ):
    w .int (reqid ,0 )
    w .int (cmd ,1 )
    w .struct (lambda ww :_qua (ww ),2 )
    w .string (APP_ID ,3 )
    w .string (GUID ,4 )
    w .list ([],5 ,None )
    w .struct (lambda ww :None ,6 )
    w .list ([],7 ,None )
    w .int (0 ,8 )
    w .int (0 ,9 )
    w .int (0 ,10 )
def _wrap (cmd ,body ,reqid ):
    w =W ()
    w .struct (lambda ww :_head (ww ,cmd ,reqid ),0 )
    w .bytes (body ,1 )
    reqcmd =w .out ()
    inner =bytearray ([38 ])+struct .pack ('>i',len (reqcmd )+17 )+bytes ([1 ])+b'\x00'*10 +reqcmd +bytes ([40 ])
    comp =gzip .compress (bytes (inner ))
    out =bytearray ([19 ])+struct .pack ('>i',0 )+struct .pack ('>H',2 )+struct .pack ('>H',65281 )
    out +=struct .pack ('>H',cmd )+struct .pack ('>H',0 )+struct .pack ('>q',reqid )
    out +=struct .pack ('>i',531 )+struct .pack ('>i',QMF_APP_ID )+struct .pack ('>q',BIZ_ID )
    g =GUID .encode ()[:32 ]
    out +=g +b'\x00'*(32 -len (g ))
    out +=struct .pack ('>b',QMF_PLATFORM )+struct .pack ('>i',int (VER_CODE ))+b'\x00'*6 
    out +=bytes ([0 ])+struct .pack ('>H',0 )+struct .pack ('>H',0 )
    out +=struct .pack ('>i',len (inner ))+comp +bytes ([3 ])
    struct .pack_into ('>i',out ,1 ,len (out ))
    return bytes (out )
def _unwrap (data ):
    if data [:1 ]!=b'\x13'or len (data )<90 :
        return None 
    flags =struct .unpack ('>i',data [21 :25 ])[0 ]
    payload =data [89 :-1 ]
    if flags &2 :
        payload =gzip .decompress (payload )
    if payload [:1 ]!=b'&'or payload [-1 :]!=b'(':
        return None 
    rc =R (payload [16 :-1 ]).struct ()
    return rc .get (1 )or b''
class DeadHostError (RuntimeError ):
    pass 
def jce_timeshift_url (pid ,sid ,start ,end ,stream ='fhd'):
    w =W ()
    w .string (pid ,0 )
    w .string (sid ,1 )
    w .long (start ,2 )
    w .long (end ,3 )
    w .string (stream ,4 )
    body =w .out ()
    CMD =25312 
    reqid =int (time .time ()*1000 )&2147483647 
    packet =_wrap (CMD ,body ,reqid )
    req =urllib .request .Request ('https://jacc.ysp.cctv.cn',data =packet ,method ='POST')
    req .add_header ('Content-Type','application/octet-stream')
    with urllib .request .urlopen (req ,timeout =15 )as resp :
        raw =resp .read ()
    resp_body =_unwrap (raw )
    if not resp_body :
        raise RuntimeError ('bad response')
    m =R (resp_body ).struct ()
    err =m .get (0 ,0 )
    if err !=0 :
        raise RuntimeError (m .get (1 ,'errCode=%s'%err ))
    url =m .get (2 ,'')
    if not url :
        raise RuntimeError ('empty m3u8')
    if 'liverecord.video.cloud.cctv.com'in url :
        raise DeadHostError ('dead cdn host')
    return url 
_CK_PLATFORM =4330403 
_CK_APPVER ='V8.22.1035.3031'
_CK_TEA =bytes .fromhex ('59b2f7cf725ef43c34fdd7c123411ed3')
_CK_GTEA =bytes .fromhex ('110DBEC10C23E7D2E56A1CAD6914EF1B')
_CK_XOR =bytes ([132 ,46 ,237 ,8 ,240 ,102 ,230 ,234 ,72 ,180 ,202 ,169 ,145 ,237 ,111 ,243 ])
_CK_GXOR =bytes ([179 ,201 ,83 ,160 ,105 ,19 ,173 ,77 ])
def _u32 (v ):
    return v &4294967295 
def _tea_blk (blk ,key ):
    y ,z =struct .unpack ('>2I',blk )
    k =struct .unpack ('>4I',key )
    s =0 
    for _ in range (16 ):
        s =_u32 (s +2654435769 )
        y =_u32 (y +_u32 (_u32 (_u32 (z <<4 )+k [0 ])^_u32 (z +s )^_u32 ((z >>5 )+k [1 ])))
        z =_u32 (z +_u32 (_u32 (_u32 (y <<4 )+k [2 ])^_u32 (y +s )^_u32 ((y >>5 )+k [3 ])))
    return struct .pack ('>2I',y ,z )
def _cksum (buf ):
    v =0 
    for b in buf :
        v =131 *v +b &2147483647 
    return v 
def _tea_pkt (data ,key ):
    pad =(8 -(len (data )+10 )%8 )%8 
    plain =bytes ([os .urandom (1 )[0 ]&248 |pad ])+os .urandom (pad )+os .urandom (2 )+data +bytes (7 )
    out ,pp ,pc =(b'',bytes (8 ),bytes (8 ))
    for off in range (0 ,len (plain ),8 ):
        mixed =bytes ((a ^b for a ,b in zip (plain [off :off +8 ],pc )))
        enc =_tea_blk (mixed ,key )
        cipher =bytes ((a ^b for a ,b in zip (enc ,pp )))
        out +=cipher 
        pp ,pc =(mixed ,cipher )
    return out 
def _lp (s ):
    d =s .encode ()if isinstance (s ,str )else s 
    return struct .pack ('>H',len (d ))+d 
def _ck_guard (ts ,guid ):
    def tail (v ):
        t =str (v )
        return t [-5 :]if len (t )>=5 else ''
    body =struct .pack ('>I',ts )+_lp (tail (guid ))+_lp (tail ('null'))+_lp (tail ('null'))+_lp ('-1')
    plain =_lp (body )
    enc =_tea_pkt (plain ,_CK_GTEA )+struct .pack ('>I',_cksum (plain ))
    enc =bytes ((a ^_CK_GXOR [i &7 ]for i ,a in enumerate (enc )))
    return enc .hex ().upper ()
def _ckey (channel_id ):
    ts =int (time .time ())
    guid =os .urandom (16 ).hex ()
    guard =_ck_guard (ts ,guid )
    uid =os .urandom (4 ).hex ().upper ()
    body =bytes .fromhex ('0000004200000004000004d2')+struct .pack ('>I',_CK_PLATFORM )+struct .pack ('>I',0 )+struct .pack ('>I',ts )+_lp ('dcgh')+_lp ('_zj1A5Gh6QYcxWjIUGos2w==')+_lp (_CK_APPVER )+_lp (str (channel_id ))+_lp (guid )+struct .pack ('>I',1 )+struct .pack ('>I',1 )+_lp (uid )+_lp ('nil')+_lp ('57eab0c4-2c58-44c6-8ae9-dd2757525dc5')+_lp ('nil')+_lp ('v0.1.000')+_lp ('com.cctv.yangshipin.app.iphone')+_lp (str (_CK_PLATFORM ))+_lp ('ex_json_bus')+_lp ('ex_json_vs')+_lp (guard )
    pkt =bytearray (struct .pack ('>H',len (body ))+body )
    pkt [18 :22 ]=struct .pack ('>I',_cksum (bytes (pkt )))
    pkt =bytes (pkt )
    enc =_tea_pkt (pkt ,_CK_TEA )+struct .pack ('>I',_cksum (pkt ))
    enc =bytes ((a ^_CK_XOR [i &15 ]for i ,a in enumerate (enc )))
    b64 =base64 .b64encode (enc ).decode ().replace ('+','_').replace ('/','-').rstrip ('=')
    return {'cKey':'--01'+b64 ,'guid':guid ,'ts':ts ,'flowId':'%s_%d'%(uuid .uuid4 ().hex .upper (),_CK_PLATFORM )}
_BK_H264 =base64 .b64encode (b'H(30:1080,60:1080|30:1080,60:1080)').decode ()
def bk_playurls (channel_id ,live_pid ,defn ='fhd'):
    _uhd_flag ='1'if defn =='uhd'else '0'
    t =_ckey (channel_id )
    q =urllib .parse .urlencode ({'atime':'120','livepid':live_pid ,'cnlid':channel_id ,'appVer':_CK_APPVER ,'app_version':'300090','caplv':'1','cmd':'2','defn':defn ,'device':'iPhone','encryptVer':'4.2','getpreviewinfo':'0','hevclv':'0','lang':'zh-Hans_CN','livequeue':'0','logintype':'1','nettype':'1','newnettype':'1','newplatform':str (_CK_PLATFORM ),'platform':str (_CK_PLATFORM ),'sdtfrom':'v3021','spacode':'23','spaudio':'1','spdemuxer':'6','spdrm':'2','spdynamicrange':'1','spflv':'1','spflvaudio':'1','sphdrfps':'60','sphttps':'1','spvcode':_BK_H264 ,'spvideo':'4','stream':'1','system':'1','sysver':'ios18.2.1','uhd_flag':_uhd_flag,'cKey':t ['cKey'],'guid':t ['guid'],'fntick':str (t ['ts']),'flowid':t ['flowId'],'playbacktime':'0'})
    req =urllib .request .Request ('https://bkliveinfo.ysp.cctv.cn/?'+q ,headers ={'User-Agent':'qqlive','Accept':'application/json'})
    with urllib .request .urlopen (req ,timeout =5 )as r :
        p =json .loads (r .read ().decode ())
    if int (p .get ('iretcode',-1 ))!=0 :
        raise RuntimeError ('iretcode=%s %s'%(p .get ('iretcode'),p .get ('errinfo','')))
    urls =[]
    if p .get ('playurl'):
        urls .append (p ['playurl'])
    bu =p .get ('backurl_list')or p .get ('backurlList')or p .get ('backurl')
    if isinstance (bu ,list ):
        for it in bu :
            urls .append (it if isinstance (it ,str )else it .get ('url')or it .get ('playurl')or '')
    elif isinstance (bu ,str ):
        urls +=[x for x in re .split ('[;,]',bu )if x .strip ()]
    urls =[u for u in dict .fromkeys (urls )if u and '.cctv.'in u ]
    if not urls :
        raise RuntimeError ('no playurl')
    urls .sort (key =lambda u :(0 if 'bklive-'in u else 1 ,u ))
    return urls 
def fetch_abs_playlist (url ,depth =0 ):
    req =urllib .request .Request (url ,headers ={'User-Agent':'qqlive','Referer':'https://live.cctv.cn/','Accept':'application/vnd.apple.mpegurl,application/json,*/*'})
    with urllib .request .urlopen (req ,timeout =10 )as r :
        text =r .read ().decode ('utf-8','replace')
        final =r .geturl ()
    if depth <2 :
        lines =text .splitlines ()
        for i ,ln in enumerate (lines ):
            if ln .strip ().startswith ('#EXT-X-STREAM-INF'):
                for j in range (i +1 ,len (lines )):
                    s =lines [j ].strip ()
                    if s and (not s .startswith ('#')):
                        return fetch_abs_playlist (urllib .parse .urljoin (final ,s ),depth +1 )
                break 
    out =[]
    for ln in text .splitlines ():
        s =ln .strip ()
        if s and (not s .startswith ('#')):
            out .append (urllib .parse .urljoin (final ,s ))
        else :
            out .append (ln )
    return '\n'.join (out )
DEFAULT_CHANNELS =[('cctv1','CCTV-1 综合','2024078201','600001859','fhd'),
('cctv2','CCTV-2 财经','2024075401','600001800','fhd'),
('cctv3','CCTV-3 综艺','2024068501','600001801','fhd'),
('cctv4','CCTV-4 中文国际','2029797101','600001814','fhd'),
('cctv5','CCTV-5 体育','2024078401','600001818','fhd'),
('cctv5p','CCTV-5+ 体育赛事','2024078001','600001817','fhd'),
('cctv6','CCTV-6 电影','2013693901','600108442','fhd'),
('cctv7','CCTV-7 国防军事','2024072001','600004092','fhd'),
('cctv8','CCTV-8 电视剧','2029793001','600001803','fhd'),
('cctv9','CCTV-9 纪录','2024078601','600004078','fhd'),
('cctv10','CCTV-10 科教','2024078701','600001805','fhd'),
('cctv11','CCTV-11 戏曲','2027248701','600001806','fhd'),
('cctv12','CCTV-12 社会与法','2027248801','600001807','fhd'),
('cctv13','CCTV-13 新闻','2029797201','600001811','fhd'),
('cctv14','CCTV-14 少儿','2027248901','600001809','fhd'),
('cctv15','CCTV-15 音乐','2027249001','600001815','fhd'),
('cctv16','CCTV-16 奥林匹克','2027249101','600098637','fhd'),
('cctv164k','CCTV-16 4K','2027249301','600099502','uhd'),
('cctv17','CCTV-17 农业农村','2027249401','600001810','fhd'),
('cctv4k','CCTV-4K 超高清','2029810301','600002264','uhd'),
('cctv8k','CCTV-8K 超高清','2026774101','600156816','uhd'),
('cgtn','CGTN','2024181701','600014550','fhd'),
('cgtnfr','CGTN 法语','2024181801','600084704','fhd'),
('cgtnru','CGTN 俄语','2024181901','600084758','fhd'),
('cgtnar','CGTN 阿拉伯语','2024182001','600084782','fhd'),
('cgtnes','CGTN 西班牙语','2024182101','600084744','fhd'),
('cgtndoc','CGTN 纪录','2024182301','600084781','fhd'),
('cctvfyjc','CCTV 风云剧场','2025637102','600099658','shd'),
('cctvdyjc','CCTV 第一剧场','2026874202','600099655','shd'),
('cctvhjjc','CCTV 怀旧剧场','2026874302','600099620','shd'),
]
ALIAS_MAP ={
'anhuiws':'ahws','beijingws':'bjws','cctv16hd':'cctv16','cctv5plus':'cctv5p',
'cctvdiyijuchang':'cctvdyjc','cctvfengyunjuchang':'cctvfyjc','cctvhuaijiujuchang':'cctvhjjc',
'cgtnalaboyu':'cgtnar','cgtneyu':'cgtnru','cgtnfayu':'cgtnfr','cgtnwaiyujilu':'cgtndoc',
'cgtnxibanyayu':'cgtnes','chongqingws':'cqws','dongfangws':'dfws','fujiandongnanws':'dnws',
'guangdongws':'gdws','guangxiws':'gxws','guizhouws':'gzws','hebeiws':'hebws',
'heilongjiangws':'hljws','hubeiws':'hbws','hunanws':'hnws','jiangsuws':'jsws',
'jiangxiws':'jxws','jilinws':'jlws','liaoningws':'lnws','neimengguws':'nmgws',
'ningxiaws':'nxws','qinghaiws':'qhws','shandongws':'sdws','shannxiws':'saxws',
'shenzhenws':'szws','sichuanws':'scws','tianjinws':'tjws','xinjiangws':'xjws',
'yunnanws':'ynws','zhejiangws':'zjws'
}
TVG_IDS ={
'cctv1':'CCTV1','cctv2':'CCTV2','cctv3':'CCTV3','cctv4':'CCTV4',
'cctv5':'CCTV5','cctv5p':'CCTV5+','cctv6':'CCTV6','cctv7':'CCTV7',
'cctv8':'CCTV8','cctv9':'CCTV9','cctv10':'CCTV10','cctv11':'CCTV11',
'cctv12':'CCTV12','cctv13':'CCTV13','cctv14':'CCTV14','cctv15':'CCTV15',
'cctv16':'CCTV16','cctv164k':'CCTV16','cctv17':'CCTV17','cctv4k':'CCTV4K',
'cctv8k':'CCTV-8K','cgtn':'CGTN英语','cgtnfr':'CGTN法语','cgtnru':'CGTN俄语',
'cgtnar':'CGTN阿语','cgtnes':'CGTN西语','cgtndoc':'CGTN纪录',
'cctvdyjc':'CCTV第一剧场','cctvfyjc':'CCTV风云剧场','cctvhjjc':'CCTV怀旧剧场',
'cetv1':'CETV1','bjws':'北京卫视','jsws':'江苏卫视','dfws':'东方卫视',
'zjws':'浙江卫视','hnws':'湖南卫视','hbws':'湖北卫视','gdws':'广东卫视',
'gxws':'广西卫视','hljws':'黑龙江卫视','hainanws':'海南卫视','cqws':'重庆卫视',
'szws':'深圳卫视','scws':'四川卫视','henanws':'河南卫视','dnws':'东南卫视',
'gzws':'贵州卫视','jxws':'江西卫视','lnws':'辽宁卫视','ahws':'安徽卫视',
'hebws':'河北卫视','sdws':'山东卫视','tjws':'天津卫视','jlws':'吉林卫视',
'saxws':'陕西卫视','nxws':'宁夏卫视','nmgws':'内蒙古卫视','ynws':'云南卫视',
'shanxiws':'山西卫视','qhws':'青海卫视','xizangws':'西藏卫视','xjws':'新疆卫视',
'gsws':'甘肃卫视','guoxue':'国学'
}
LOGO_BASE ='https://garysclub.sharewithyou.dpdns.org/logos/ysp-live-logos'
UA ='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
REFRESH_INTERVAL =10 
IDLE_TIMEOUT =120 
LINK_IDLE_TIMEOUT =15.0 
WINDOW =300 
MAX_SEGS =120 
BK_URL_TTL =300 
BACKEND_CHANNELS ={
'cctv1','cctv2','cctv3','cctv4','cctv5','cctv5p','cctv7','cctv8',
'cctv9','cctv10','cctv11','cctv12','cctv13','cctv14','cctv15',
'cctv16','cctv17','cctv4k','cctv8k','cctv164k','cgtn','cgtnfr',
'cgtnru','cgtnar','cgtnes','cgtndoc'
}
TRUE_4K_CHANNELS ={'cctv4k','cctv8k','cctv164k'}
active_backend_channels =set (BACKEND_CHANNELS )
TIMESHIFT_SUPPORTED ={
"cctv1","cctv2","cctv3","cctv4","cctv5","cctv5p","cctv6","cctv7","cctv8","cctv9","cctv10","cctv13","cctv8k","cgtn","cgtnfr","cgtnru","cgtnar","cgtnes","cgtndoc"
}
def get_channel_group (slug :str )->str :
    s =ALIAS_MAP .get (slug .lower (),slug .lower ())
    if s .startswith ("cgtn"):
        return "CGTN"
    if s in ("cctv4k","cctv8k","cctv164k"):
        return "央视UHD"
    if s .startswith ("cctv"):
        return "央视FHD"
    return "其他"
def parse_catchup_time_val (val_str :str |None )->int |None :
    if not val_str :
        return None 
    val =val_str .strip ()
    if not val :
        return None 
    cst =datetime .timezone (datetime .timedelta (hours =8 ))
    if 'T'in val or ('-'in val and ':'in val ):
        try :
            iso_val =val [:-1 ]+'+00:00'if val .upper ().endswith ('Z')else val 
            dt =datetime .datetime .fromisoformat (iso_val )
            if dt .tzinfo is None :
                dt =dt .replace (tzinfo =cst )
            return int (dt .timestamp ())
        except Exception :
            pass 
    is_utc =val .upper ().endswith ('Z')
    clean_val =re .sub (r'\.\d+','',val )
    digits ="".join (c for c in clean_val if c .isdigit ())
    if not digits :
        return None 
    if len (digits )==10 :
        return int (digits )
    if len (digits )==13 :
        return int (int (digits )/1000 )
    tz =datetime .timezone .utc if is_utc else cst 
    if len (digits )>=14 :
        try :
            dt =datetime .datetime .strptime (digits [:14 ],"%Y%m%d%H%M%S").replace (tzinfo =tz )
            return int (dt .timestamp ())
        except Exception :
            pass 
    if len (digits )==12 :
        try :
            dt =datetime .datetime .strptime (digits ,"%Y%m%d%H%M").replace (tzinfo =tz )
            return int (dt .timestamp ())
        except Exception :
            pass 
    return None 
def parse_catchup_query (query_str :str )->tuple [int ,int ]|None :
    if not query_str :
        return None 
    qs =urllib .parse .parse_qs (query_str )
    now =int (time .time ())
    start_ts =None 
    end_ts =None 
    if "playseek"in qs :
        ps =qs ["playseek"][0 ]
        if "-"in ps :
            parts =ps .split ("-",1 )
            start_ts =parse_catchup_time_val (parts [0 ])
            end_ts =parse_catchup_time_val (parts [1 ])
        else :
            start_ts =parse_catchup_time_val (ps )
    if not start_ts and "start"in qs :
        start_ts =parse_catchup_time_val (qs ["start"][0 ])
    if not end_ts and "end"in qs :
        end_ts =parse_catchup_time_val (qs ["end"][0 ])
    if not start_ts and "utc"in qs :
        start_ts =parse_catchup_time_val (qs ["utc"][0 ])
    if not end_ts and "lutc"in qs :
        end_ts =parse_catchup_time_val (qs ["lutc"][0 ])
    if not start_ts and "starttime"in qs :
        start_ts =parse_catchup_time_val (qs ["starttime"][0 ])
    if not end_ts and "endtime"in qs :
        end_ts =parse_catchup_time_val (qs ["endtime"][0 ])
    if start_ts is not None :
        if end_ts is None or end_ts <=start_ts :
            end_ts =max (start_ts +60 ,min (start_ts +7200 ,now ))
        return start_ts ,end_ts 
    return None 
_inflight_refresh :dict [str ,threading .Event ]={}
_inflight_lock =threading .Lock ()
def coalesce_refresh (slug :str ,refresh_fn ,timeout =None ):
    with _inflight_lock :
        if slug in _inflight_refresh :
            ev =_inflight_refresh [slug ]
            wait =True 
        else :
            ev =threading .Event ()
            _inflight_refresh [slug ]=ev 
            wait =False 
    if wait :
        ev .wait (timeout =6.0 if timeout is None else timeout )
        return 
    def _run ():
        try :
            refresh_fn ()
        finally :
            with _inflight_lock :
                _inflight_refresh .pop (slug ,None )
            ev .set ()
    t =threading .Thread (target =_run ,daemon =True )
    t .start ()
    if timeout is not None :
        ev .wait (timeout =timeout )
    else :
        t .join ()
class ApiFlowLimiter :
    def __init__ (self ,min_interval_ms :int =700 ,jitter_ms :int =250 ):
        self .min_interval =min_interval_ms /1000.0 
        self .jitter =jitter_ms /1000.0 
        self .lock =threading .Lock ()
        self .last_call =0.0 
    def wait_slot (self ):
        with self .lock :
            now =time .time ()
            target_delay =self .min_interval +random .uniform (0.0 ,self .jitter )
            diff =now -self .last_call 
            if diff <target_delay :
                time .sleep (target_delay -diff )
            self .last_call =time .time ()
global_flow_limiter =ApiFlowLimiter ()
class TsSegmentCache :
    def __init__ (self ,max_mb :int =100 ,max_age_sec :int =180 ):
        self .max_bytes =max_mb *1024 *1024 
        self .max_age =max_age_sec 
        self .lock =threading .Lock ()
        self .cache :dict [str ,tuple [bytes ,dict ,float ]]={}
        self .order =collections .deque ()
        self .curr_bytes =0 
        self .hits =0 
        self .misses =0 
    def get (self ,key :str )->tuple [bytes ,dict ]|None :
        with self .lock :
            item =self .cache .get (key )
            if not item :
                self .misses +=1 
                return None 
            data ,headers ,expire_at =item 
            if time .time ()>expire_at :
                self .cache .pop (key ,None )
                try :
                    self .order .remove (key )
                except ValueError :
                    pass 
                self .curr_bytes -=len (data )
                self .misses +=1 
                return None 
            self .hits +=1 
            return data ,headers 
    def set (self ,key :str ,data :bytes ,headers :dict ):
        with self .lock :
            if len (data )>self .max_bytes :
                return 
            if key in self .cache :
                old =self .cache .pop (key )
                self .curr_bytes -=len (old [0 ])
                try :
                    self .order .remove (key )
                except ValueError :
                    pass 
            now =time .time ()
            while (self .curr_bytes +len (data )>self .max_bytes )and self .order :
                old_key =self .order .popleft ()
                old_val =self .cache .pop (old_key ,None )
                if old_val :
                    self .curr_bytes -=len (old_val [0 ])
            self .cache [key ]=(data ,headers ,now +self .max_age )
            self .order .append (key )
            self .curr_bytes +=len (data )
    def stats (self )->dict :
        with self .lock :
            total =max (1 ,self .hits +self .misses )
            return {
            'count':len (self .cache ),
            'size_mb':round (self .curr_bytes /(1024 *1024 ),2 ),
            'hits':self .hits ,
            'misses':self .misses ,
            'hit_rate':f"{round (self .hits /total *100 ,1 )}%"
            }
global_ts_cache =TsSegmentCache (max_mb =200 )
class ChannelDirectory :
    def __init__ (self ):
        self .lock =threading .Lock ()
        self .channels_meta :dict [str ,dict ]={}
        self .canonical_slugs :list [str ]=[]
        self .load_defaults ()
    def load_defaults (self ):
        self .canonical_slugs .clear ()
        for slug ,name ,sid ,pid ,defn in DEFAULT_CHANNELS :
            grp =get_channel_group (slug )
            tid =TVG_IDS .get (slug ,slug .upper ())
            logo =f"{LOGO_BASE }/{slug }.png"
            self .channels_meta [slug ]={
            'slug':slug ,'name':name ,'sid':sid ,'pid':pid ,'defn':defn ,
            'logo':logo ,'group':grp ,'tvg_id':tid 
            }
            self .canonical_slugs .append (slug )
    def get_meta (self ,slug :str )->dict |None :
        slug =ALIAS_MAP .get (slug .lower (),slug .lower ())
        with self .lock :
            return self .channels_meta .get (slug )
    def all_channels (self )->list [dict ]:
        return self .unique_channels ()
    def unique_channels (self )->list [dict ]:
        with self .lock :
            return [self .channels_meta [s ]for s in self .canonical_slugs if s in self .channels_meta ]
global_channel_dir =ChannelDirectory ()
_EPG_WANTED_IDS = {TVG_IDS.get(s, s.upper()) for s in global_channel_dir.canonical_slugs if s in TVG_IDS}
epg_aggregator = EpgAggregator(_EPG_WANTED_IDS) if _HAS_EPG else None
class Channel :
    def __init__ (self ,slug ,name ,sid ,pid ,defn ):
        self .slug ,self .name ,self .sid ,self .pid ,self .defn =(slug ,name ,sid ,pid ,defn )
        self .lock =threading .Lock ()
        self .segments ={}
        self .order =deque ()
        self .seen_keys =deque (maxlen =MAX_SEGS *2 )
        self .seq =0 
        self .last_access =0.0 
        self .thread =None 
        self .last_error =''
        self .last_ok =0.0 
        self .mode ='jce'
        self .last_pdt =''
        self .bk_urls =[]
        self .bk_urls_time =0.0 
        self .bk_playlist =''
        self ._starting =False 
        self .last_built_playlist =''
        self .last_built_time =0.0 
def seg_key (url ,pdt ):
    if pdt :
        return 'pdt:'+pdt 
    p =urllib .parse .urlsplit (url )
    return p .scheme +'://'+p .netloc +p .path 
def jce_fetch (ch ):
    global_flow_limiter .wait_slot ()
    now =int (time .time ())
    m3u8_url =jce_timeshift_url (ch .pid ,ch .sid ,now -WINDOW ,now ,ch .defn )
    req =urllib .request .Request (m3u8_url ,headers ={'User-Agent':UA })
    with urllib .request .urlopen (req ,timeout =20 )as r :
        text =r .read ().decode ('utf-8','replace')
    segs ,dur ,pdt =([],6.0 ,'')
    for line in text .splitlines ():
        line =line .strip ()
        if line .startswith ('#EXTINF:'):
            try :
                dur =float (line [len ('#EXTINF:'):].split (',')[0 ])
            except ValueError :
                dur =6.0 
        elif line .startswith ('#EXT-X-PROGRAM-DATE-TIME:'):
            pdt =line [len ('#EXT-X-PROGRAM-DATE-TIME:'):]
        elif line and (not line .startswith ('#')):
            segs .append ((dur ,pdt ,urllib .parse .urljoin (m3u8_url ,line )))
            pdt =''
    if not segs :
        raise RuntimeError ('empty playlist')
    return segs 
def defn_label (defn ):
    d =(defn or '').strip ().lower ()
    if d =='fhd':
        return '1080p'
    if d =='shd':
        return '720p'
    return defn or '1080p'
def jce_refresh (ch ):
    segs =jce_fetch (ch )
    with ch .lock :
        added =0 
        is_init =not ch .order 
        if is_init :
            for _ ,pdt ,url in segs :
                k =seg_key (url ,pdt )
                if k not in ch .seen_keys :
                    ch .seen_keys .append (k )
            init_segs =segs [-25 :]if len (segs )>25 else segs 
            for dur ,pdt ,url in init_segs :
                key =seg_key (url ,pdt )
                ch .seq +=1 
                ch .segments [key ]=[ch .seq ,dur ,pdt ,url ]
                ch .order .append (key )
                added +=1 
                if pdt :
                    ch .last_pdt =pdt 
        else :
            for dur ,pdt ,url in segs :
                if pdt and ch .last_pdt and pdt <=ch .last_pdt :
                    continue 
                key =seg_key (url ,pdt )
                if key in ch .segments :
                    ch .segments [key ][3 ]=url 
                    continue 
                if key in ch .seen_keys :
                    continue 
                ch .seen_keys .append (key )
                ch .seq +=1 
                ch .segments [key ]=[ch .seq ,dur ,pdt ,url ]
                ch .order .append (key )
                if pdt :
                    ch .last_pdt =pdt 
                added +=1 
        while len (ch .order )>MAX_SEGS :
            ch .segments .pop (ch .order .popleft (),None )
        ch .last_error =''
    if is_init and added :
        log (f'[{ch .slug }] {defn_label (ch .defn )} 备用流缓冲就绪 ({len (ch .segments )} 片)')
    return True 
def bk_refresh (ch ):
    global_flow_limiter .wait_slot ()
    now =time .time ()
    if now -ch .bk_urls_time >BK_URL_TTL or not ch .bk_urls :
        ch .bk_urls =bk_playurls (ch .sid ,ch .pid ,ch .defn )
        ch .bk_urls_time =now 
        log (f'[{ch .slug }] bkliveinfo 备用通道就绪 ({len (ch .bk_urls )} 地址)',min_interval =60.0 )
    last_err =''
    for attempt in range (2 ):
        for u in list (ch .bk_urls ):
            try :
                pl =fetch_abs_playlist (u )
                if '#EXTM3U'not in pl :
                    continue 
                with ch .lock :
                    ch .bk_playlist =pl 
                    ch .last_error =''
                return True 
            except urllib .error .HTTPError as e :
                last_err ='HTTPError: HTTP %s'%e .code 
                continue 
            except Exception as e :
                last_err ='%s: %s'%(type (e ).__name__ ,e )
        if attempt ==0 :
            try :
                ch .bk_urls =bk_playurls (ch .sid ,ch .pid ,ch .defn )
                ch .bk_urls_time =time .time ()
                log (f'[{ch .slug }] {defn_label (ch .defn )} 地址已过期，已重新拉取',min_interval =10.0 )
            except Exception :
                pass 
    ch .bk_urls =[]
    ch .bk_urls_time =0 
    raise RuntimeError (last_err [:120 ]or 'bk playlist failed')
def refresh_once (ch ):
    try :
        if ch .mode =='bk':
            ok =bk_refresh (ch )
        else :
            try :
                ok =jce_refresh (ch )
            except DeadHostError :
                ch .mode ='bk'
                log (f'[{ch .slug }] JCE 域名受限，自动切换 bkliveinfo 备用通道',min_interval =10.0 )
                ok =bk_refresh (ch )
        if ok :
            ch .last_ok =time .time ()
        return ok 
    except Exception as e :
        ch .last_error =('%s: %s'%(type (e ).__name__ ,e ))[:120 ]
        log (f'[{ch .slug }] {defn_label (ch .defn )} 刷新异常: {ch .last_error }',min_interval =15.0 )
        return False 
def refresh_loop (ch ):
    log (f'[{ch .slug }] {defn_label (ch .defn )} 后台拉取启动 [{ch .mode }]',min_interval =10.0 )
    fails =0 
    if time .time ()-ch .last_ok <REFRESH_INTERVAL :
        build_playlist (ch ,holdback =True )
        time .sleep (REFRESH_INTERVAL )
    while time .time ()-ch .last_access <IDLE_TIMEOUT :
        ok =refresh_once (ch )
        if ok :
            build_playlist (ch ,holdback =True )
        fails =0 if ok else fails +1 
        time .sleep (REFRESH_INTERVAL if fails <3 else 30 )
    log (f'[{ch .slug }] 空闲超时，已停止后台拉取',min_interval =10.0 )
def ensure_channel (ch ):
    now =time .time ()
    ch .last_access =now 
    wait_only =False 
    with ch .lock :
        if ch ._starting :
            wait_only =True 
        else :
            thread_dead =ch .thread is None or not ch .thread .is_alive ()
            cache_stale =now -ch .last_ok >IDLE_TIMEOUT or (not ch .segments and (not ch .bk_playlist ))
            if cache_stale :
                ch .segments .clear ()
                ch .order .clear ()
                ch .seen_keys .clear ()
                ch .last_pdt =''
                ch .bk_playlist =''
                need_fetch =True 
            else :
                need_fetch =False 
            if need_fetch or thread_dead :
                ch ._starting =True 
            else :
                return 
    if wait_only :
        coalesce_refresh (ch .slug ,lambda :refresh_once (ch ),timeout =5.0 )
        return 
    try :
        if need_fetch :
            coalesce_refresh (ch .slug ,lambda :refresh_once (ch ),timeout =5.0 )
        if thread_dead :
            ch .thread =threading .Thread (target =refresh_loop ,args =(ch ,),daemon =True )
            ch .thread .start ()
    finally :
        with ch .lock :
            ch ._starting =False 
def build_playlist (ch ,holdback :bool =True ):
    with ch .lock :
        if ch .mode =='bk':
            res =ch .bk_playlist or None 
            if res :
                ch .last_built_playlist =res 
                ch .last_built_time =time .time ()
            return res 
        keys =list (ch .order )[-15 :]
        segs =[ch .segments [k ]for k in keys if k in ch .segments ]
    if not segs :
        return None 
    if holdback and len (segs )>=4 :
        display_segs =segs [:-1 ]
    else :
        display_segs =segs 
    target =max (6 ,max ((int (s [1 ]+0.5 )for s in display_segs )))
    out =['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:%d'%target ,'#EXT-X-MEDIA-SEQUENCE:%d'%display_segs [0 ][0 ]]
    for _ ,dur ,pdt ,url in display_segs :
        if pdt :
            out .append ('#EXT-X-PROGRAM-DATE-TIME:'+pdt )
        out .append ('#EXTINF:%.3f,'%dur )
        out .append (url )
    res ='\n'.join (out )+'\n'
    with ch .lock :
        ch .last_built_playlist =res 
        ch .last_built_time =time .time ()
    return res 
def trigger_background_refresh (ch ):
    with _inflight_lock :
        if ch .slug in _inflight_refresh :
            return 
    def _do ():
        if refresh_once (ch ):
            build_playlist (ch ,holdback =True )
    threading .Thread (target =coalesce_refresh ,args =(ch .slug ,_do ),daemon =True ).start ()
CHANNEL_MAP :dict [str ,Channel ]={c [0 ]:Channel (*c )for c in DEFAULT_CHANNELS }
FORCE_BK ={'cctv11','cctv12','cctv14','cctv15','cctv16','cctv17','cctvfyjc','cctvdyjc','cctvhjjc'}
for _s in FORCE_BK :
    if _s in CHANNEL_MAP :
        CHANNEL_MAP [_s ].mode ='bk'
server_port :int =8767 
server_start_time =time .time ()
resolver :Resolver |None =None 
_resolver_ready :bool =False 
_resolver_lock =threading .Lock ()
def resolver_ready ()->bool :
    with _resolver_lock :
        return _resolver_ready 
def set_resolver_ready (ready :bool )->None :
    global _resolver_ready 
    with _resolver_lock :
        _resolver_ready =ready 
_last_channel_request :dict [str ,float ]={}
_last_channel_request_lock =threading .Lock ()
def get_channel_instance (slug :str )->Channel |None :
    slug =normalize_channel (slug )
    canonical =ALIAS_MAP .get (slug ,slug )
    if canonical in CHANNEL_MAP :
        return CHANNEL_MAP [canonical ]
    meta =global_channel_dir .get_meta (canonical )
    if meta :
        ch =Channel (meta ['slug'],meta ['name'],meta ['sid'],meta ['pid'],meta ['defn'])
        if canonical in FORCE_BK :
            ch .mode ='bk'
        CHANNEL_MAP [canonical ]=ch 
        return ch 
    return None 
engine_port =8787 
ALLOWED_ENGINE_PROXY_SUFFIXES =('.cctv.cn','.cctv.com','.yangshipin.cn','.cntv.cn','.cntv.com','.myqcloud.com','.qqlive.com','.gtimg.cn','.alicdn.com','.alikunlun.com')
def _is_safe_engine_proxy_url (target :str ,_depth :int =0 )->bool :
    if _depth >2 :
        return False 
    try :
        parsed =urllib .parse .urlsplit (target )
    except ValueError :
        return False 
    if parsed .scheme not in ('http','https'):
        return False 
    host =(parsed .hostname or '').lower ()
    if not host :
        return False 
    if host in ('127.0.0.1','localhost'):
        if parsed .port !=engine_port or not parsed .path .startswith ('/segment'):
            return False 
        qs =urllib .parse .parse_qs (parsed .query )
        inner =qs .get ('url',[None ])[0 ]
        return bool (inner )and _is_safe_engine_proxy_url (inner ,_depth +1 )
    return any ((host ==s [1 :]or host .endswith (s )for s in ALLOWED_ENGINE_PROXY_SUFFIXES ))
def inject_hls_discontinuity (pl :str )->str :
    if '#EXT-X-DISCONTINUITY'in pl :
        return pl 
    lines =pl .splitlines ()
    out =[]
    inserted =False 
    for line in lines :
        s =line .strip ()
        if not inserted and (s .startswith ('#EXT-X-PROGRAM-DATE-TIME:')or s .startswith ('#EXTINF:')or (s and not s .startswith ('#'))):
            out .append ('#EXT-X-DISCONTINUITY')
            inserted =True 
        out .append (line )
    if not inserted :
        return pl 
    return '\n'.join (out )+('\n'if pl .endswith ('\n')else '')
def fetch_upstream_engine_playlist (canonical :str ,host :str ,proto :str ='http')->str |None :
    global engine_port 
    scheme =proto if proto in ('http','https')else 'http'
    for u in (f'http://127.0.0.1:{engine_port }/live/{canonical }.m3u8',f'http://127.0.0.1:{engine_port }/{canonical }.m3u8'):
        try :
            req =urllib .request .Request (u ,headers ={'User-Agent':UA })
            with urllib .request .urlopen (req ,timeout =10.0 )as resp :
                if resp .status ==200 :
                    text =resp .read ().decode ('utf-8',errors ='ignore')
                    if '#EXTM3U'in text :
                        base_prefix =f'{scheme }://{host }/engine_proxy?url='
                        out_lines =[]
                        for line in text .splitlines ():
                            line_str =line .strip ()
                            if not line_str :
                                continue 
                            if line_str .startswith ('#'):
                                out_lines .append (line_str )
                            else :
                                if line_str .startswith ('http://')or line_str .startswith ('https://'):
                                    full_target =line_str 
                                else :
                                    full_target =urllib .parse .urljoin (u ,line_str )
                                out_lines .append (base_prefix +urllib .parse .quote (full_target ,safe =''))
                        return '\n'.join (out_lines )+'\n'
        except Exception :
            pass 
    return None 
class Handler (BaseHTTPRequestHandler ):
    server_version ='ysp-live/9.5.0'
    def log_message (self ,fmt ,*args ):
        pass 
    def _send (self ,code ,body ,ctype ='text/plain; charset=utf-8',head_only =False ,extra_headers =None ):
        data =body .encode ('utf-8')if isinstance (body ,str )else body 
        try :
            self .send_response (code )
            self .send_header ('Content-Type',ctype )
            self .send_header ('Content-Length',str (len (data )))
            self .send_header ('Access-Control-Allow-Origin','*')
            self .send_header ('Cache-Control','no-cache, no-store, max-age=0')
            if extra_headers :
                for k ,v in extra_headers .items ():
                    self .send_header (k ,v )
            self .end_headers ()
            if not head_only :
                self .wfile .write (data )
        except (BrokenPipeError ,ConnectionResetError ):
            pass 
    def do_HEAD (self ):
        self .do_GET (head_only =True )
    def do_GET (self ,head_only =False ):
        parts =urllib .parse .urlsplit (self .path )
        path =parts .path 
        catchup_times =parse_catchup_query (parts .query )
        if path in ('/','/index.html'):
            host =self .headers .get ('Host',f'localhost:{server_port }')
            text =(
            f"====================================================\n"
            f"ysp-live IPTV 直播网关运行中 (端口: {server_port })\n"
            f"📢 官方发布社区: {AUTHOR_COMMUNITY}\n"
            f"📢 官方发布频道: {AUTHOR_CHANNEL}\n"
            f"⚠️ 严正声明: 其他任何渠道均非作者发布！\n"
            f"====================================================\n\n"
            f"全频道订阅: http://{host }/cctv.m3u\n"
            f"节目单: http://{host }/epg.xml\n"
            f"系统健康度: http://{host }/health\n"
            f"实时诊断日志: http://{host }/diag\n"
            )
            self ._send (200 ,text ,'text/plain; charset=utf-8',head_only =head_only )
            return 
        if path =='/favicon.ico':
            fav ='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📺</text></svg>'
            self ._send (200 ,fav ,'image/svg+xml',head_only =head_only )
            return 
        if path =='/health':
            now =time .time ()
            sess =resolver .state .app_session if resolver else None 
            engine_ready =resolver_ready ()
            cache_info =global_ts_cache .stats ()
            active_slots =len ([s for s in (resolver .state .sessions .values ()if resolver else [])if s and resolver .app_session_fresh (s )])
            health_data ={
            "ok":True ,
            "version":"9.5.0",
            "author_community":AUTHOR_COMMUNITY ,
            "author_channel":AUTHOR_CHANNEL ,
            "notice":"其他渠道均非作者发布！",
            "uptime_sec":int (now -server_start_time ),
            "engine":{
            "ready":engine_ready ,
            "active_device_slots":active_slots ,
            "session_valid":bool (sess and resolver and resolver .app_session_fresh (sess )),
            "heartbeat_count":sess .heartbeat_count if sess else 0 ,
            "guid":sess .cloud_guid if sess else ""
            },
            "channels":len (global_channel_dir .unique_channels ()),
            "ts_cache":cache_info ,
            "routes":["/","/cctv.m3u","/epg.xml","/diag","/health","/<channel>.m3u8","/proxy.ts"]
            }
            self ._send (200 ,json .dumps (health_data ,ensure_ascii =False ,indent =2 ),'application/json; charset=utf-8',head_only =head_only )
            return 
        if path =='/cctv.m3u':
            host =self .headers .get ('Host',f'localhost:{server_port }')
            proto =self .headers .get ('X-Forwarded-Proto','http').split (',')[0 ].strip ().lower ()or 'http'
            qs =urllib .parse .parse_qs (parts .query )
            target_group =qs .get ('group',[None ])[0 ]
            k4_val =qs .get ('k4',['0'])[0 ].lower ()
            only_4k =k4_val in ('1','true','yes')
            lines =[
            f'#EXTM3U url-tvg="{proto}://{host}/epg.xml"',
            '#EXT-X-APTV-PREVIEW: FALSE',
            '#EXT-X-APTV-LATENCY: FALSE',
            '#EXT-X-APTV-LOGO: FALSE'
            ]
            for ch_meta in global_channel_dir .unique_channels ():
                slug =ch_meta ['slug']
                name =ch_meta ['name']
                grp =ch_meta ['group']
                logo =ch_meta ['logo']
                tid =ch_meta ['tvg_id']
                if target_group and target_group not in grp :
                    continue 
                if only_4k and (slug not in TRUE_4K_CHANNELS ):
                    continue 
                attrs =f' tvg-id="{tid }" tvg-name="{name }" tvg-logo="{logo }" group-title="{grp }"'
                if slug in TIMESHIFT_SUPPORTED :
                    attrs +=' catchup="append" catchup-days="7" catchup-source="?playseek=${(b)yyyyMMddHHmmss}-${(e)yyyyMMddHHmmss}"'
                lines .append (f'#EXTINF:-1{attrs },{name }')
                lines .append (f'{proto }://{host }/{slug }.m3u8')
            self ._send (200 ,'\n'.join (lines )+'\n','application/vnd.apple.mpegurl',head_only =head_only )
            return 
        if path =='/epg.xml':
            if epg_aggregator is None:
                self ._send (503 ,'EPG aggregator not available\n',head_only =head_only )
                return 
            xml =epg_aggregator .get_xml ()
            if xml is None:
                if epg_aggregator .refresh_now ():
                    xml =epg_aggregator .get_xml ()
            if xml is None:
                err =epg_aggregator .last_error ()or 'unknown'
                self ._send (502 ,f'EPG fetch failed: {err }\n',head_only =head_only )
                return 
            self ._send (200 ,xml ,'application/xml; charset=utf-8',head_only =head_only )
            return 
        if path =='/diag':
            info =[]
            now =time .time ()
            info .append ("====================================================")
            info .append (f"ysp-live v9.5 诊断报告 (运行时间: {int (now -server_start_time )}s)")
            info .append ("📢 首发地址")
            info .append (f"社区：Gary's Club ({AUTHOR_COMMUNITY})")
            info .append (f"频道：Gary's Club Channel ({AUTHOR_CHANNEL})")
            info .append ("⚠️ 其他任何分发渠道均非作者本人！")
            info .append ("====================================================")
            engine_status ='就绪'if resolver_ready ()else '未就绪(1080p自动回退)'
            s0 =resolver .state .sessions .get (0 )if resolver else None 
            if s0 and resolver :
                resolver .evict_idle_links (s0 ,LINK_IDLE_TIMEOUT )
            links_limit_cfg =getattr (resolver .args ,'links_per_device',6 )if resolver else 6 
            pool_ch_count =len (active_backend_channels )
            info .append (f"单设备并发池状态: {engine_status }")
            info .append (f"高码率设备状态 ({pool_ch_count } 路共用): {('有效'if s0 and resolver and resolver .app_session_fresh (s0 )else '未就绪')}, 占用={len (s0 .linked_channels )if s0 else 0 }/{links_limit_cfg }, 心跳={(s0 .heartbeat_count if s0 else 0 )}, GUID={(s0 .cloud_guid if s0 else '无')}")
            if s0 and s0 .last_heartbeat_error :
                info .append (f'Slot 0 心跳日志: {s0 .last_heartbeat_error }')
            c_stats =global_ts_cache .stats ()
            info .append (f"分片内存缓存: 条目={c_stats ['count']}, 占用={c_stats ['size_mb']}MB, 命中率={c_stats ['hit_rate']} (命中:{c_stats ['hits']}/未中:{c_stats ['misses']})")
            info .append ('--- 频道状态列表 ---')
            for ch_meta in global_channel_dir .unique_channels ():
                slug =ch_meta ['slug']
                ch =CHANNEL_MAP .get (slug )
                age ='%ds前'%int (now -ch .last_ok )if ch and ch .last_ok else '从未拉取'
                mode_str ='4K/高码率'if slug in active_backend_channels and resolver_ready ()else (ch .mode if ch else 'idle')
                cooldown_str =''
                if resolver and resolver .is_channel_in_cooldown (slug ):
                    fail_info =resolver .get_channel_failure_info (slug )
                    if fail_info :
                        cd =15.0 if fail_info [2 ]<=1 else (60.0 if fail_info [2 ]==2 else 120.0 )
                        rem_sec =max (0 ,int (cd -(now -fail_info [0 ])))
                        cooldown_str =f' [高码冷却剩{rem_sec }s]'
                err_msg =ch .last_error if ch else '无'
                info .append (f"{slug } ({ch_meta ['name']}) 模式={mode_str }{cooldown_str } 上次刷新={age } 错误={err_msg or '无'}")
            if global_log_ring :
                info .append ('--- 最近运行事件 (最新 30 条) ---')
                clean_logs = [re.sub(r'\033\[[0-9;]*m', '', line) for line in list(global_log_ring)[-30:]]
                info .extend (clean_logs)
            self ._send (200 ,'\n'.join (info )+'\n',head_only =head_only )
            return 
        if path in ('/proxy.ts','/proxy'):
            token =proxy_ts_token (self .path )
            if not token :
                self ._send (400 ,'missing proxy ts token\n',head_only =head_only )
                return 
            try :
                real_url =decode_proxy_ts_url (token )
            except YsptpError as err :
                self ._send (400 ,f'{err }\n',head_only =head_only )
                return 
            range_header =self .headers .get ('Range')
            cached_item =global_ts_cache .get (real_url )if not range_header else None 
            if cached_item is not None :
                cached_bytes ,cached_headers =cached_item 
                try :
                    self .send_response (200 )
                    for k ,v in cached_headers .items ():
                        self .send_header (k ,v )
                    self .send_header ('X-Cache','HIT-RAM')
                    self .send_header ('Access-Control-Allow-Origin','*')
                    self .send_header ('Cache-Control','public, max-age=300')
                    self .end_headers ()
                    if not head_only :
                        self .wfile .write (cached_bytes )
                    return 
                except (BrokenPipeError ,ConnectionResetError ):
                    return 
            try :
                playback_headers =resolver .playback_headers_for_ts_url (real_url )if resolver else {}
            except YsptpError as err :
                self ._send (500 ,f'{err }\n',head_only =head_only )
                return 
            try :
                parts_url =urllib .parse .urlsplit (real_url )
                host =parts_url .hostname 
                if not host :
                    self ._send (400 ,'invalid ts host\n',head_only =head_only )
                    return 
                is_https =(parts_url .scheme =='https')
                port =parts_url .port or (443 if is_https else 80 )
                host_header =f'{host }:{parts_url .port }'if parts_url .port else host 
                target =parts_url .path or '/'
                if parts_url .query :
                    target +='?'+parts_url .query 
                extra ={}
                if range_header :
                    extra ['Range']=header_value_clean (range_header )
                headers =_playback_request_headers (playback_headers ,extra )
                headers ['Host']=host_header 
                if is_https :
                    conn =http .client .HTTPSConnection (host ,port ,timeout =30 ,context =ssl .create_default_context ())
                else :
                    conn =http .client .HTTPConnection (host ,port ,timeout =30 )
                try :
                    req_method ='HEAD'if head_only else 'GET'
                    conn .request (req_method ,target ,headers =headers )
                    resp =conn .getresponse ()
                    resp_headers_to_pass ={}
                    for k ,v in resp .getheaders ():
                        kl =k .lower ()
                        if kl in ('content-type','content-range','accept-ranges','content-length','location'):
                            resp_headers_to_pass [k ]=v 
                    self .send_response (resp .status )
                    for k ,v in resp_headers_to_pass .items ():
                        self .send_header (k ,v )
                    self .send_header ('X-Cache','MISS-UPSTREAM')
                    self .send_header ('Access-Control-Allow-Origin','*')
                    self .send_header ('Cache-Control','public, max-age=300')
                    self .end_headers ()
                    if not head_only :
                        body_buffer =bytearray ()
                        is_oversized =False 
                        expected_len =None 
                        cl_val =resp_headers_to_pass .get ('Content-Length')or resp_headers_to_pass .get ('content-length')
                        if cl_val :
                            try :
                                expected_len =int (cl_val )
                                if expected_len >35 *1024 *1024 :
                                    is_oversized =True 
                            except ValueError :
                                pass 
                        while True :
                            chunk =resp .read (262144 )
                            if not chunk :
                                break 
                            self .wfile .write (chunk )
                            if resp .status ==200 and not is_oversized :
                                if len (body_buffer )+len (chunk )<=35 *1024 *1024 :
                                    body_buffer .extend (chunk )
                                else :
                                    is_oversized =True 
                                    body_buffer .clear ()
                        if resp .status ==200 and not is_oversized and body_buffer :
                            if expected_len is None or len (body_buffer )==expected_len :
                                global_ts_cache .set (real_url ,bytes (body_buffer ),resp_headers_to_pass )
                finally :
                    conn .close ()
            except (BrokenPipeError ,ConnectionResetError ):
                pass 
            except Exception as e :
                try :
                    self .send_error (502 ,f'Upstream CDN error: {e }')
                except Exception :
                    pass 
            return 
        if path =='/engine_proxy':
            qs =urllib .parse .parse_qs (parts .query )
            target =qs .get ('url',[''])[0 ]
            if not target :
                self ._send (400 ,'missing url\n',head_only =head_only )
                return 
            if not _is_safe_engine_proxy_url (target ):
                self ._send (403 ,'forbidden url\n',head_only =head_only )
                return 
            try :
                req =urllib .request .Request (target ,headers ={'User-Agent':UA ,'Accept':'*/*'})
                with urllib .request .urlopen (req ,timeout =10.0 )as resp :
                    data =resp .read (35 *1024 *1024 +1 )
                    if len (data )>35 *1024 *1024 :
                        self ._send (502 ,'upstream segment too large\n',head_only =head_only )
                        return 
                    self ._send (resp .status ,data ,resp .headers .get ('Content-Type','video/mp2t'),head_only =head_only )
            except Exception as e :
                self ._send (502 ,f'engine proxy error: {e }\n',head_only =head_only )
            return 
        m =re .match (r'^/([\w-]+)\.m3u8$',path )
        if m :
            raw_slug =normalize_channel (m .group (1 ))
            canonical =ALIAS_MAP .get (raw_slug ,raw_slug )
            ch =get_channel_instance (canonical )
            if not ch :
                self ._send (404 ,'未知频道\n',head_only =head_only )
                return 
            proto =self .headers .get ('X-Forwarded-Proto','http').split (',')[0 ].strip ().lower ()or 'http'
            if catchup_times and (canonical in TIMESHIFT_SUPPORTED ):
                start_ts ,end_ts =catchup_times 
                try :
                    m3u8_url =jce_timeshift_url (ch .pid ,ch .sid ,start_ts ,end_ts ,ch .defn )
                    pl =fetch_abs_playlist (m3u8_url )
                    self ._send (200 ,pl ,'application/vnd.apple.mpegurl',head_only =head_only )
                    return 
                except Exception as e :
                    log (f'[{canonical }] 时移获取失败: {e }，回退直播',min_interval =10.0 )
            if canonical in active_backend_channels and resolver_ready ()and (resolver is not None ):
                if not resolver .is_channel_in_cooldown (canonical ):
                    try :
                        host =self .headers .get ('Host',f'localhost:{server_port }')
                        pl =resolver .fetch_channel_playlist (canonical ,host ,proto )
                        if pl and '#EXTM3U'in pl :
                            with ch .lock :
                                prev_src =getattr (ch ,'last_m3u8_source',None )
                                ch .last_m3u8_source ='device'
                                ch .last_built_playlist =''
                                ch .last_built_time =0.0 
                            if prev_src =='bk':
                                pl =inject_hls_discontinuity (pl )
                            self ._send (200 ,pl ,'application/vnd.apple.mpegurl',head_only =head_only )
                            return 
                    except Exception as e :
                        with resolver .state_lock :
                            resolver .state .cache .pop (canonical ,None )
                            resolver .state .playlist_cache .pop (canonical ,None )
                            prev =resolver .state .channel_failures .get (canonical )
                            fail_cnt =(prev [2 ]+1 )if prev else 1 
                            resolver .state .channel_failures [canonical ]=(now_f64 (),str (e ),fail_cnt )
                        fail_info =resolver .get_channel_failure_info (canonical )if resolver else None 
                        fail_cnt =fail_info [2 ]if fail_info else 1 
                        if fail_cnt <=1 :
                            cd_sec =15 
                        elif fail_cnt ==2 :
                            cd_sec =60 
                        else :
                            cd_sec =120 
                        clean_err =str (e ).strip ()
                        log (f'[{canonical }] 高码率播放暂时受限 ({clean_err })，平滑回退 1080p (冷却 {cd_sec }s)',min_interval =5.0 )
            now_ts =time .time ()
            ch .last_access =now_ts 
            with ch .lock :
                cached_pl =ch .last_built_playlist 
                cached_age =now_ts -ch .last_built_time 
            if cached_pl and cached_age <15.0 and ('#EXTM3U'in cached_pl ):
                with ch .lock :
                    prev_src =getattr (ch ,'last_m3u8_source',None )
                    ch .last_m3u8_source ='bk'
                if prev_src =='device':
                    cached_pl =inject_hls_discontinuity (cached_pl )
                self ._send (200 ,cached_pl ,'application/vnd.apple.mpegurl',head_only =head_only ,extra_headers ={'X-SWR':'HIT'})
                if cached_age >6.0 :
                    trigger_background_refresh (ch )
                return 
            ensure_channel (ch )
            pl =build_playlist (ch ,holdback =True )
            if pl and '#EXTM3U'in pl :
                with ch .lock :
                    prev_src =getattr (ch ,'last_m3u8_source',None )
                    ch .last_m3u8_source ='bk'
                if prev_src =='device':
                    pl =inject_hls_discontinuity (pl )
                self ._send (200 ,pl ,'application/vnd.apple.mpegurl',head_only =head_only )
                return 
            upstream_pl =fetch_upstream_engine_playlist (canonical ,self .headers .get ('Host',f'localhost:{server_port }'),proto )
            if upstream_pl and '#EXTM3U'in upstream_pl :
                self ._send (200 ,upstream_pl ,'application/vnd.apple.mpegurl',head_only =head_only )
                return 
            self ._send (503 ,'频道 %s 暂无数据 (%s), 请稍后重试\n'%(ch .name ,ch .last_error or '拉取中'),head_only =head_only )
            return 
        self ._send (404 ,'not found\n',head_only =head_only )
def init_resolver ():
    if resolver is None :
        return 
    log ('[系统] 正在初始化设备协议并发池…')
    retry_count =0 
    while True :
        try :
            resolver .ensure_slot_session (0 )
            set_resolver_ready (True )
            log (f'[系统] 设备身份就绪，高码率并发池已激活 (全部 {len (active_backend_channels )} 路按需解析)')
            break 
        except Exception as e :
            retry_count +=1 
            log (f'[系统] 设备协议初始化第 {retry_count } 次重试中: {e }，4K/高码率频道暂走 1080p 回退',min_interval =10.0 )
            set_resolver_ready (False )
            if 'HTTP 400'in str (e ):
                resolver .rotate_device_on_400 ('init:'+str (e )[:60 ])
            backoff =min (15.0 * (1.5 ** min (retry_count - 1 ,4 )),60.0 )
            time .sleep (backoff )
companion_proc =None 
def is_port_listening (port :int ,host :str ='127.0.0.1')->bool :
    try :
        with socket .socket (socket .AF_INET ,socket .SOCK_STREAM )as s :
            s .settimeout (0.5 )
            return s .connect_ex ((host ,port ))==0 
    except Exception :
        return False 
def start_companion_engine (script_dir :str ,port :int =8787 ):
    global companion_proc 
    if is_port_listening (port ):
        log (f'[引擎] Web WASM 引擎已就绪: 端口 {port } 已处于运行状态')
        return 
    candidates =[
        os .path .join (script_dir ,'ysp-engine.js'),
        os .path .join (os .getcwd (),'ysp-engine.js'),
        '/app/ysp-engine.js'
    ]
    engine_file =None 
    for p in candidates :
        if os .path .isfile (p ):
            engine_file =p 
            break 
    if not engine_file :
        log ('[引擎] 未找到 ysp-engine.js，Web WASM 伴生引擎未启用')
        return 
    node_bin =shutil .which ('node')
    if not node_bin :
        log ('[引擎] 未检测到 node 可执行程序，Web WASM 伴生引擎未启用 (走设备协议/1080p 回退)')
        return 
    try :
        subp =__import__ ('subprocess')
        companion_proc =subp .Popen (
            [node_bin ,engine_file ,str (port )],
            stdout =subp .DEVNULL ,
            stderr =subp .DEVNULL 
        )
        for _ in range (30 ):
            if is_port_listening (port ):
                log (f'[引擎] Web WASM 伴生引擎 (Node.js) 自动启动成功: 端口 {port }')
                return 
            time .sleep (0.1 )
        if companion_proc .poll ()is not None :
            log ('[引擎] 警告: Web WASM 伴生引擎启动异常退出')
            companion_proc =None 
        else :
            log (f'[引擎] Web WASM 伴生引擎已在后台启动 (端口 {port })')
    except Exception as e :
        log (f'[引擎] Web WASM 伴生引擎启动失败: {e }')
        companion_proc =None 
def stop_companion_engine ():
    global companion_proc 
    if companion_proc is not None :
        p =companion_proc 
        companion_proc =None 
        try :
            if p .poll ()is None :
                p .terminate ()
                try :
                    p .wait (timeout =2.0 )
                except Exception :
                    p .kill ()
            log ('[引擎] Web WASM 伴生引擎 (Node.js) 已停止')
        except Exception :
            pass 
atexit .register (stop_companion_engine )
def _handle_sigterm (signum ,frame ):
    stop_companion_engine ()
    sys .exit (0 )
try :
    signal .signal (signal .SIGTERM ,_handle_sigterm )
except Exception :
    pass 
def main ():
    global resolver ,server_port ,engine_port ,global_channel_dir ,global_ts_cache 
    if os.name == 'nt':
        os.system('') 
    ap =argparse .ArgumentParser (description ='央视频全频道直播代理（ysp-live v9.5）')
    ap .add_argument ('port',nargs ='?',type =int ,default =8767 ,help ='监听端口 (默认 8767)')
    ap .add_argument ('--bind',default ='0.0.0.0',help ='监听地址 (默认 0.0.0.0)')
    ap .add_argument ('--data-dir',default =os .environ .get ('YSP_DATA_DIR',''),help ='数据持久化目录 (默认由 YSP_DATA_DIR 环境变量或脚本所在目录决定)')
    ap .add_argument ('--cache-mb',type =int ,default =200 ,help ='TS 分片内存缓存大小 (MB, 默认 200)')
    ap .add_argument ('--no-4k',action ='store_true',help ='不启动设备协议 (仅走 1080p JCE/bkliveinfo)')
    ap .add_argument ('--only-4k',action ='store_true',help ='仅 4K/8K 频道走设备协议 (默认全部 26 个高码率频道走设备协议)')
    ap .add_argument ('--links-per-device',type =int ,default =int (os .environ .get ('YSP_LINKS_PER_DEVICE','6')),help ='单设备高码率链接配额上限 (默认 6, 设为 0 关闭主动轮换)')
    ap .add_argument ('--zap-debounce',type =float ,default =float (os .environ .get ('YSP_ZAP_DEBOUNCE','10.0')),help ='换台防抖秒数: 切台后先出 1080p, 停留超过该秒数才后台请求高码率 (默认 10.0, 设为 0 关闭)')
    ap .add_argument ('--engine-port',type =int ,default =8787 ,help ='Web WASM 引擎端口 (默认 8787)')
    ap .add_argument ('--timeout',type =float ,default =10.0 ,help ='设备协议 HTTP 超时秒数 (默认 10, 注册失败时更快回退 1080p)')
    ap .add_argument ('--no-engine',action ='store_true',help ='不启动 Web WASM 伴生引擎')
    args =ap .parse_args ()
    server_port =args .port 
    engine_port =args .engine_port 
    if args .cache_mb >0 :
        global_ts_cache =TsSegmentCache (max_mb =args .cache_mb )
    here =os .path .dirname (os .path .abspath (__file__ ))
    if not args .no_engine :
        start_companion_engine (here ,engine_port )
    data_dir =args .data_dir or os .environ .get ('YSP_DATA_DIR',here )
    if data_dir and not os .path .exists (data_dir ):
        try :
            os .makedirs (data_dir ,exist_ok =True )
        except OSError :
            data_dir =here 
    test_file =os .path .join (data_dir ,f'.perm_test_{os .getpid ()}')
    try :
        with open (test_file ,'w')as f :
            f .write ('ok')
        os .remove (test_file )
        log (f'[系统] 持久化存储目录: {data_dir } (读写权限正常)')
    except OSError as e :
        log (f'[系统] 警告: 持久化目录 {data_dir } 写入受限 ({e })，状态将保持内存模式')
    global active_backend_channels 
    only_4k_mode =args .only_4k or (os .environ .get ('YSP_ONLY_4K_DEVICE','').lower ()in ('1','true','yes'))
    links_limit =max (0 ,int (args .links_per_device ))
    if args .no_4k :
        active_backend_channels =set ()
        log ('[系统] 高码率模式: 已禁用 (--no-4k)，全频道走 1080p JCE/bkliveinfo')
    elif only_4k_mode :
        active_backend_channels =set (TRUE_4K_CHANNELS )
        log ('[系统] 高码率模式: 仅 4K/8K 频道走设备协议 (其余走 1080p JCE/bkliveinfo)')
    else :
        active_backend_channels =set (BACKEND_CHANNELS )
        log (f'[系统] 高码率模式: 全部 26 个高码率频道走单设备并发池 (1 台设备, 高码率并发上限: {links_limit } 路, 空闲超 {LINK_IDLE_TIMEOUT }s 释放配额, 换台防抖: {float (args .zap_debounce )}s)')
    engine_args =argparse .Namespace (
    host =args .bind ,port =args .port ,timeout =float (args .timeout ),insecure_tls =False ,cache_ttl =60.0 ,
    stale_while_refresh_ttl =0.0 ,refresh_error_cooldown =5.0 ,playlist_cache_ttl =2.0 ,
    background_refresh_queue_limit =4 ,http_workers =16 ,http_queue_limit =1000 ,
    identity_reset_error_threshold =0 ,identity_reset_cooldown =300.0 ,refresh_interval =1.0 ,
    control_step_jitter_min_ms =0 ,control_step_jitter_max_ms =0 ,heartbeat_interval =30.0 ,
    heartbeat_ttl_guard =60.0 ,session_ttl =7200.0 ,
    meta_json =os .path .join (data_dir ,'proxy-cache-state-rs.json'),
    device_json =os .path .join (data_dir ,'device-state-rs.json'),
    links_per_device =links_limit ,
    zap_debounce =float (args .zap_debounce )
    )
    resolve_paths (engine_args )
    resolver =Resolver (engine_args )
    if not args .no_4k :
        resolver .start_heartbeat ()
        resolver .start_refresh_worker ()
        threading .Thread (target =init_resolver ,daemon =True ,name ='engine-init').start ()
    srv =ThreadingHTTPServer ((args .bind ,args .port ),Handler )
    channels_count =len (global_channel_dir .unique_channels ())
    c_fhd =len ([c for c in global_channel_dir .unique_channels ()if c ['group']=='央视FHD'])
    c_uhd =len ([c for c in global_channel_dir .unique_channels ()if c ['group']=='央视UHD'])
    c_cgtn =len ([c for c in global_channel_dir .unique_channels ()if c ['group']=='CGTN'])
    RED_BOLD = '\033[1;31m'
    RESET = '\033[0m'

    log ('====================================================================')
    log (f'ysp-live v9.5 启动成功: {channels_count } 个独立频道 (央视FHD {c_fhd } 路, 央视UHD {c_uhd } 路, CGTN {c_cgtn } 路)')
    log (f'全频道订阅:   http://localhost:{args .port }/cctv.m3u')
    log (f'节目单:       http://localhost:{args .port }/epg.xml')
    log (f'系统健康度:   http://localhost:{args .port }/health')
    log (f'实时诊断日志: http://localhost:{args .port }/diag')
    log (f'{RED_BOLD}--------------------------------------------------------------------{RESET}')
    log (f'{RED_BOLD}📢 首发地址{RESET}')
    log (f'{RED_BOLD}社区：Gary\'s Club ({AUTHOR_COMMUNITY}){RESET}')
    log (f'{RED_BOLD}频道：Gary\'s Club Channel ({AUTHOR_CHANNEL}){RESET}')
    log (f'{RED_BOLD}⚠️ 其他任何分发渠道均非作者本人！{RESET}')
    log (f'{RED_BOLD}===================================================================={RESET}')
    try :
        srv .serve_forever ()
    except KeyboardInterrupt :
        log ('[系统] 服务已停止')
    finally :
        stop_companion_engine ()
if __name__ =='__main__':
    main ()
