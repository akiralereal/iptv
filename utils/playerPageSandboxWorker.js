/**
 * 播放器页沙箱（worker 线程侧）。
 *
 * 在 node:vm 里按文档顺序跑页面脚本，把脚本交给播放器（new Player({url}) / hls.loadSource(url) …）
 * 或写进 DOM（document.write / innerHTML / video.src …）的直播地址收集起来。协议见 playerPageSandbox.js。
 *
 * 安全边界：页面脚本是站点给的（多为 jsjiami / obfuscator.io 混淆），只当数据，不给任何宿主对象——
 * 沙箱里的 window / document / atob / Player 等全部由「沙箱内」的引导代码定义，脚本拿到的每个函数
 * 的 constructor 都是沙箱 realm 的 Function，够不到宿主的 process / require。宿主与沙箱之间只传
 * 字符串（脚本源码进、JSON 结果出）。同步死循环由 vm 的 timeout 截断；吃内存（obfuscator.io 的
 * 「完整性校验失败就无限 push」惩罚）由主线程给这个 worker 设的 resourceLimits 兜住，只会挂掉
 * worker，不会拖死主进程。
 */
import { parentPort } from 'node:worker_threads'
import vm from 'node:vm'

/** 单段脚本 / 一次收尾（触发 load 回调与定时器）允许的同步执行时间 */
const SCRIPT_TIMEOUT_MS = 3000

/**
 * 沙箱内的引导代码：用纯 JS 搭一个够播放器脚本跑起来的假浏览器环境。
 * 所有东西都在沙箱 realm 里创建；`__page` / `__ua` 由主线程以 JSON 字符串形式注入。
 */
function bootstrapSource(page, ua) {
  return `
'use strict';
var __page = ${JSON.stringify(page)};
var __ua = ${JSON.stringify(ua)};
var __found = [];
var __written = [];      // document.write 写进来的 HTML（主线程从中挑同源 <script src> 再跑一轮）
var __timers = [];
var __timerSeq = 0;
var __listeners = { document: {}, window: {} };
var __M3U8_RE = /https?:\\/\\/[^\\s"'<>\\\\]+\\.m3u8[^\\s"'<>\\\\]*/g;

function __note(v) {
  if (typeof v !== 'string' || v.indexOf('.m3u8') === -1) return;
  var m = v.match(__M3U8_RE);
  if (!m) return;
  for (var i = 0; i < m.length; i++) if (__found.indexOf(m[i]) === -1) __found.push(m[i]);
}
// 把播放器配置整体序列化后扫一遍：url / src / file / video.url / sources[0].src… 一网打尽
function __noteObj(o) {
  if (o == null) return;
  if (typeof o === 'string') return __note(o);
  var seen = [];
  try {
    __note(JSON.stringify(o, function (k, val) {
      if (typeof val === 'function') return undefined;
      if (val && typeof val === 'object') { if (seen.indexOf(val) !== -1) return undefined; if (seen.length > 2000) return undefined; seen.push(val); }
      return val;
    }));
  } catch (e) {}
}
function __on(bucket, type, fn) {
  if (typeof fn !== 'function') return;
  (__listeners[bucket][type] = __listeners[bucket][type] || []).push(fn);
}
function __noop() {}
function __self() { return this; }

// ---------- 元素 ----------
function __makeElement(tag, id) {
  var el = {
    tagName: String(tag || 'div').toUpperCase(), id: id || '', className: '', style: {}, dataset: {},
    children: [], childNodes: [], attributes: [], parentNode: null, parentElement: null, firstChild: null, lastChild: null, nextSibling: null,
    offsetWidth: 800, offsetHeight: 450, clientWidth: 800, clientHeight: 450, scrollWidth: 800, scrollHeight: 450, offsetTop: 0, offsetLeft: 0,
    textContent: '', innerText: '', value: '', currentTime: 0, duration: 0, paused: true, muted: false, volume: 1, readyState: 0, error: null,
    _src: '', _html: '',
    get src() { return this._src; }, set src(v) { this._src = String(v); __note(this._src); },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); __note(this._html); __written.push(this._html); },
    get outerHTML() { return this._html; },
    set href(v) { __note(String(v)); }, get href() { return ''; },
    setAttribute: function (n, v) { __note(String(v)); if (n === 'src') this._src = String(v); },
    getAttribute: function (n) { return n === 'src' ? this._src || null : null; },
    hasAttribute: function () { return false; }, removeAttribute: __noop,
    appendChild: function (c) { if (c && c._src) __note(c._src); if (c && c._html) __note(c._html); if (c && c.tagName === 'SCRIPT' && c._src) __written.push('<script src="' + c._src + '"></script>'); this.children.push(c); return c; },
    insertBefore: function (c) { return this.appendChild(c); }, removeChild: function (c) { return c; }, replaceChild: function (c) { return c; },
    append: function () { for (var i = 0; i < arguments.length; i++) this.appendChild(arguments[i]); }, remove: __noop,
    insertAdjacentHTML: function (p, h) { __note(String(h)); __written.push(String(h)); },
    addEventListener: __noop, removeEventListener: __noop, dispatchEvent: function () { return true; },
    querySelector: function () { return __makeElement('div'); }, querySelectorAll: function () { return []; },
    getElementsByTagName: function () { return []; }, getElementsByClassName: function () { return []; },
    getBoundingClientRect: function () { return { top: 0, left: 0, right: 800, bottom: 450, width: 800, height: 450, x: 0, y: 0 }; },
    getContext: function () { return null; }, contains: function () { return false; }, matches: function () { return false; }, closest: function () { return null; },
    focus: __noop, blur: __noop, click: __noop, load: __noop, pause: __noop, canPlayType: function () { return 'maybe'; },
    play: function () { return { then: function () { return this; }, catch: function () { return this; } }; },
    requestFullscreen: __noop, cloneNode: function () { return __makeElement(this.tagName); },
    classList: { add: __noop, remove: __noop, toggle: __noop, contains: function () { return false; } },
  };
  return el;
}

// ---------- document / window ----------
var __byId = {};
var document = {
  location: __page, URL: __page.href, documentURI: __page.href, domain: __page.hostname, referrer: '', title: '', cookie: '',
  readyState: 'loading', hidden: false, visibilityState: 'visible', currentScript: null, characterSet: 'UTF-8', compatMode: 'CSS1Compat',
  body: __makeElement('body'), head: __makeElement('head'), documentElement: __makeElement('html'), scripts: [], forms: [], images: [],
  getElementById: function (id) { return __byId[id] || (__byId[id] = __makeElement('div', id)); },
  querySelector: function (s) { return __makeElement('div'); }, querySelectorAll: function () { return []; },
  getElementsByTagName: function () { return []; }, getElementsByClassName: function () { return []; }, getElementsByName: function () { return []; },
  createElement: function (t) { return __makeElement(t); }, createTextNode: function (t) { return { textContent: String(t) }; },
  createEvent: function () { return { initEvent: __noop }; }, createDocumentFragment: function () { return __makeElement('fragment'); },
  write: function (s) { s = String(s); __note(s); __written.push(s); }, writeln: function (s) { document.write(s); }, open: __noop, close: __noop,
  addEventListener: function (t, fn) { __on('document', t, fn); }, removeEventListener: __noop, dispatchEvent: function () { return true; },
  hasFocus: function () { return true; }, execCommand: function () { return false; },
};
var navigator = {
  userAgent: __ua, appVersion: __ua.replace(/^Mozilla\\//, ''), appName: 'Netscape', appCodeName: 'Mozilla', product: 'Gecko', vendor: 'Google Inc.',
  platform: 'Win32', language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'], maxTouchPoints: 0, plugins: [], mimeTypes: [],
  cookieEnabled: true, onLine: true, hardwareConcurrency: 4, deviceMemory: 8, webdriver: false, doNotTrack: null,
  sendBeacon: function () { return true; }, javaEnabled: function () { return false; },
};
var screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary' } };
var location = __page;
__page.toString = function () { return __page.href; };
__page.reload = __noop; __page.assign = function (u) { __note(String(u)); }; __page.replace = function (u) { __note(String(u)); };
var history = { length: 1, state: null, pushState: __noop, replaceState: __noop, back: __noop, forward: __noop, go: __noop };
function __storage() { var d = {}; return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; }, setItem: function (k, v) { d[k] = String(v); }, removeItem: function (k) { delete d[k]; }, clear: function () { d = {}; }, key: function (i) { return Object.keys(d)[i] || null; }, get length() { return Object.keys(d).length; } }; }
var localStorage = __storage();
var sessionStorage = __storage();
var console = {};
['log', 'warn', 'error', 'info', 'debug', 'trace', 'table', 'dir', 'group', 'groupEnd', 'groupCollapsed', 'time', 'timeEnd', 'timeLog', 'clear', 'exception', 'assert', 'count'].forEach(function (k) { console[k] = __noop; });
var performance = { now: function () { return Date.now() - __t0; }, timing: {}, mark: __noop, measure: __noop, getEntriesByType: function () { return []; } };
var __t0 = Date.now();
var innerWidth = 1280, innerHeight = 720, outerWidth = 1280, outerHeight = 800, devicePixelRatio = 1, pageXOffset = 0, pageYOffset = 0, scrollX = 0, scrollY = 0;

// ---------- 定时器：先记下来，脚本都跑完后由 __finish 触发一次（只跑短延时的） ----------
function setTimeout(fn, ms) { var id = ++__timerSeq; __timers.push({ id: id, fn: fn, ms: Number(ms) || 0, args: Array.prototype.slice.call(arguments, 2) }); return id; }
function setInterval(fn, ms) { return setTimeout.apply(null, arguments); }
function clearTimeout(id) { for (var i = 0; i < __timers.length; i++) if (__timers[i].id === id) { __timers.splice(i, 1); return; } }
function clearInterval(id) { clearTimeout(id); }
function requestAnimationFrame(fn) { return setTimeout(fn, 16); }
function cancelAnimationFrame(id) { clearTimeout(id); }
function requestIdleCallback(fn) { return setTimeout(fn, 0); }
function queueMicrotask(fn) { setTimeout(fn, 0); }
function addEventListener(t, fn) { __on('window', t, fn); }
function removeEventListener() {}
function dispatchEvent() { return true; }
function alert() {} function confirm() { return true; } function prompt() { return null; }
function scrollTo() {} function scroll() {} function scrollBy() {} function focus() {} function blur() {} function open() { return null; } function close() {}
function getComputedStyle() { return { getPropertyValue: function () { return ''; } }; }
function matchMedia() { return { matches: false, media: '', addListener: __noop, removeListener: __noop, addEventListener: __noop, removeEventListener: __noop }; }
function getSelection() { return { toString: function () { return ''; }, removeAllRanges: __noop }; }
function postMessage() {}
function fetch() { return new Promise(function () {}); }   // 沙箱不联网：永远 pending，不触发回调
function __b64chars() { return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; }
function btoa(s) {
  s = String(s); var c = __b64chars(), out = '', i = 0;
  for (; i < s.length; i += 3) {
    var a = s.charCodeAt(i), b = s.charCodeAt(i + 1), d = s.charCodeAt(i + 2);
    if (a > 255 || b > 255 || d > 255) throw new Error('InvalidCharacterError');
    var n = (a << 16) | ((b || 0) << 8) | (d || 0);
    out += c[(n >> 18) & 63] + c[(n >> 12) & 63] + (isNaN(b) ? '=' : c[(n >> 6) & 63]) + (isNaN(d) ? '=' : c[n & 63]);
  }
  return out;
}
function atob(s) {
  s = String(s).replace(/[\\t\\n\\f\\r ]+/g, ''); var c = __b64chars(), out = '', bits = 0, acc = 0;
  if (s.length % 4 === 1 || /[^A-Za-z0-9+\\/=]/.test(s)) throw new Error('InvalidCharacterError');
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '=') break;
    acc = (acc << 6) | c.indexOf(s[i]); bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); }
  }
  return out;
}
function unescape(s) { return String(s).replace(/%u([0-9a-fA-F]{4})|%([0-9a-fA-F]{2})/g, function (m, u, h) { return String.fromCharCode(parseInt(u || h, 16)); }); }
function escape(s) { return encodeURIComponent(String(s)); }

// ---------- 浏览器 API 桩 ----------
class XMLHttpRequest { constructor() { this.readyState = 0; this.status = 0; this.responseText = ''; this.response = ''; } open(m, u) { __note(String(u)); } send() {} abort() {} setRequestHeader() {} getResponseHeader() { return null; } getAllResponseHeaders() { return ''; } addEventListener() {} removeEventListener() {} overrideMimeType() {} }
class Event { constructor(type) { this.type = type; } preventDefault() {} stopPropagation() {} stopImmediatePropagation() {} initEvent() {} }
class CustomEvent extends Event { constructor(type, init) { super(type); this.detail = init && init.detail; } }
class MessageEvent extends Event {}
class ErrorEvent extends Event {}
class MutationObserver { observe() {} disconnect() {} takeRecords() { return []; } }
class IntersectionObserver { observe() {} unobserve() {} disconnect() {} }
class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
class Image { constructor() { return __makeElement('img'); } }
class Audio { constructor(src) { var el = __makeElement('audio'); if (src) el.src = src; return el; } }
class WebSocket { constructor(u) { this.url = String(u); this.readyState = 0; } send() {} close() {} addEventListener() {} removeEventListener() {} }
class Worker { constructor() {} postMessage() {} terminate() {} addEventListener() {} }
class MediaSource { static isTypeSupported() { return true; } addSourceBuffer() { return { appendBuffer: __noop, addEventListener: __noop }; } addEventListener() {} }
class Notification { static requestPermission() { return Promise.resolve('denied'); } }
class URLSearchParams {
  constructor(init) { this._m = {}; var s = String(init == null ? '' : init).replace(/^\\?/, ''); if (s) s.split('&').forEach(function (kv) { var i = kv.indexOf('='); var k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\\+/g, ' ')); var v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\\+/g, ' ')); this._m[k] = v; }, this); }
  get(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; } has(k) { return this.get(k) !== null; } set(k, v) { this._m[k] = String(v); } toString() { var self = this; return Object.keys(this._m).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(self._m[k]); }).join('&'); }
}
class URL {
  constructor(u, base) {
    var s = String(u); if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) { var b = String(base || __page.href); var bo = b.match(/^([a-z][a-z0-9+.-]*:\\/\\/[^\\/?#]*)([^?#]*)/i); s = s.charAt(0) === '/' ? (s.charAt(1) === '/' ? bo[1].split('//')[0] + s : bo[1] + s) : bo[1] + bo[2].replace(/[^\\/]*$/, '') + s; }
    var m = s.match(/^([a-z][a-z0-9+.-]*:)\\/\\/([^\\/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/i); if (!m) throw new TypeError('Invalid URL');
    this.href = s; this.protocol = m[1].toLowerCase(); this.host = m[2]; this.hostname = m[2].replace(/:\\d+$/, ''); this.port = (m[2].match(/:(\\d+)$/) || [, ''])[1]; this.pathname = m[3] || '/'; this.search = m[4] || ''; this.hash = m[5] || ''; this.origin = this.protocol + '//' + this.host; this.searchParams = new URLSearchParams(this.search);
  }
  toString() { return this.href; }
}
var crypto = { getRandomValues: function (a) { for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; }, randomUUID: function () { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); } };

// ---------- 常见播放器桩：只记地址，不播 ----------
function __chain() { return this; }
class Player {
  constructor(cfg) { __noteObj(cfg); this.config = cfg; this.video = __makeElement('video'); this.root = __makeElement('div'); }
  on() { return this; } once() { return this; } off() { return this; } emit() { return this; } play() {} pause() {} destroy() {} reload() {} switchURL(u) { __note(String(u)); } playNext(c) { __noteObj(c); }
  get src() { return ''; } set src(u) { __note(String(u)); } get url() { return ''; } set url(u) { __note(String(u)); }
  static install() {} static use() {} static isSupported() { return true; } static registerPlugin() {} static defaultPreset() {}
}
Player.Events = {}; Player.Util = {}; Player.util = {}; Player.plugins = {}; Player.Plugin = class {};
class HlsPlayer extends Player {} class HlsJsPlayer extends Player {} class FlvPlayer extends Player {} class FlvJsPlayer extends Player {} class Mp4Player extends Player {} class HlsPlugin extends Player {}
class DPlayer extends Player {} class Artplayer extends Player {} class Playerjs extends Player {} class ckplayer extends Player {} class CKobject extends Player {} class Clappr { static get Player() { return Player; } }
class Hls { constructor(cfg) { __noteObj(cfg); } loadSource(u) { __note(String(u)); } attachMedia() {} detachMedia() {} on() {} once() {} off() {} destroy() {} startLoad() {} stopLoad() {} recoverMediaError() {} static isSupported() { return true; } }
Hls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' }; Hls.ErrorTypes = {}; Hls.ErrorDetails = {};
var flvjs = { isSupported: function () { return true; }, createPlayer: function (cfg) { __noteObj(cfg); return { attachMediaElement: __noop, detachMediaElement: __noop, load: __noop, unload: __noop, play: __noop, pause: __noop, destroy: __noop, on: __noop, off: __noop }; }, Events: {}, ErrorTypes: {} };
var mpegts = flvjs;
function videojs(id, opts, ready) { __noteObj(opts); var p = { src: function (s) { __noteObj(s); return p; }, play: __noop, pause: __noop, on: function () { return p; }, one: function () { return p; }, off: function () { return p; }, ready: function (fn) { if (typeof fn === 'function') setTimeout(fn, 0); return p; }, dispose: __noop, el: function () { return __makeElement('div'); }, currentTime: function () { return 0; }, muted: function () { return p; }, volume: function () { return p; }, poster: function () { return p; }, addClass: function () { return p; }, removeClass: function () { return p; }, controls: function () { return p; }, autoplay: function () { return p; } }; if (typeof ready === 'function') setTimeout(ready, 0); return p; }
videojs.getPlayer = function () { return videojs(); }; videojs.registerPlugin = __noop; videojs.hook = __noop; videojs.options = {}; videojs.browser = {};
function jwplayer() { var p = { setup: function (cfg) { __noteObj(cfg); return p; }, on: function () { return p; }, once: function () { return p; }, play: __noop, pause: __noop, remove: __noop, load: function (c) { __noteObj(c); return p; }, setMute: function () { return p; }, setVolume: function () { return p; } }; return p; }
jwplayer.key = '';
function __jq(arg) {
  if (typeof arg === 'function') { __on('document', 'DOMContentLoaded', arg); return __jqObj; }
  return __jqObj;
}
var __jqObj = { length: 0, ready: function (fn) { __on('document', 'DOMContentLoaded', fn); return __jqObj; }, on: __chain, one: __chain, off: __chain, bind: __chain, click: __chain, each: __chain, find: __chain, eq: __chain, first: __chain, last: __chain, parent: __chain, parents: __chain, children: __chain, closest: __chain, siblings: __chain, next: __chain, prev: __chain, filter: __chain, not: __chain, end: __chain, show: __chain, hide: __chain, toggle: __chain, fadeIn: __chain, fadeOut: __chain, css: __chain, addClass: __chain, removeClass: __chain, toggleClass: __chain, hasClass: function () { return false; }, animate: __chain, stop: __chain, remove: __chain, empty: __chain, trigger: __chain, data: function () { return undefined; }, prop: function () { return undefined; }, width: function () { return 800; }, height: function () { return 450; }, offset: function () { return { top: 0, left: 0 }; }, scrollTop: function () { return 0; }, val: function () { return ''; }, text: function (s) { if (s !== undefined) { __note(String(s)); return __jqObj; } return ''; }, html: function (s) { if (s !== undefined) { __note(String(s)); __written.push(String(s)); return __jqObj; } return ''; }, attr: function (n, v) { if (v !== undefined) { __note(String(v)); return __jqObj; } return undefined; }, append: function (s) { __noteObj(s); if (typeof s === 'string') __written.push(s); return __jqObj; }, prepend: function (s) { __noteObj(s); return __jqObj; }, after: function (s) { __noteObj(s); return __jqObj; }, before: function (s) { __noteObj(s); return __jqObj; }, get: function () { return __makeElement('div'); }, toArray: function () { return []; } };
__jq.fn = __jqObj; __jq.ajax = function (o) { __noteObj(o); return __jqObj; }; __jq.get = __jq.ajax; __jq.post = __jq.ajax; __jq.getJSON = __jq.ajax; __jq.getScript = function (u) { __written.push('<script src="' + u + '"></script>'); return __jqObj; }; __jq.each = function (o, fn) { if (Array.isArray(o)) o.forEach(function (v, i) { fn.call(v, i, v); }); else if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { fn.call(o[k], k, o[k]); }); }; __jq.extend = function () { var t = arguments[0] || {}; for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) Object.keys(s).forEach(function (k) { t[k] = s[k]; }); } return t; }; __jq.trim = function (s) { return String(s).trim(); }; __jq.isFunction = function (f) { return typeof f === 'function'; }; __jq.noop = __noop; __jq.cookie = function () { return undefined; }; __jq.support = {}; __jq.browser = {};
var $ = __jq; var jQuery = __jq;

// class / function 声明不会自动成为 window 的属性，页面脚本常写 window.Player / window.Hls，显式挂上
[['Player', Player], ['HlsPlayer', HlsPlayer], ['HlsJsPlayer', HlsJsPlayer], ['FlvPlayer', FlvPlayer], ['FlvJsPlayer', FlvJsPlayer], ['Mp4Player', Mp4Player], ['HlsPlugin', HlsPlugin],
 ['DPlayer', DPlayer], ['Artplayer', Artplayer], ['Playerjs', Playerjs], ['ckplayer', ckplayer], ['CKobject', CKobject], ['Clappr', Clappr], ['Hls', Hls],
 ['XMLHttpRequest', XMLHttpRequest], ['Event', Event], ['CustomEvent', CustomEvent], ['MessageEvent', MessageEvent], ['ErrorEvent', ErrorEvent],
 ['MutationObserver', MutationObserver], ['IntersectionObserver', IntersectionObserver], ['ResizeObserver', ResizeObserver], ['Image', Image], ['Audio', Audio],
 ['WebSocket', WebSocket], ['Worker', Worker], ['MediaSource', MediaSource], ['Notification', Notification], ['URLSearchParams', URLSearchParams], ['URL', URL]
].forEach(function (pair) { globalThis[pair[0]] = pair[1]; });

// ---------- 收尾：触发 DOMContentLoaded / load 与短延时定时器，再扫一遍全局字符串变量 ----------
function __runQuietly(fn, args) { try { fn.apply(null, args || []); } catch (e) {} }
function __finish() {
  document.readyState = 'interactive';
  (__listeners.document.DOMContentLoaded || []).forEach(function (fn) { __runQuietly(fn, [new Event('DOMContentLoaded')]); });
  if (typeof document.onreadystatechange === 'function') __runQuietly(document.onreadystatechange);
  document.readyState = 'complete';
  (__listeners.window.load || []).forEach(function (fn) { __runQuietly(fn, [new Event('load')]); });
  if (typeof globalThis.onload === 'function') __runQuietly(globalThis.onload);
  // 定时器只跑短延时的、且每个只跑一次（setInterval 也只一次），跑的过程里新加的也算，但总数封顶
  var ran = 0;
  while (__timers.length && ran < 200) {
    var t = __timers.shift();
    if (t.ms > 2000) continue;
    ran++;
    __runQuietly(t.fn, t.args);
  }
  // 顶层 var 声明的全局字符串（如 var playUrl = '…m3u8'）也扫一遍
  var names = Object.getOwnPropertyNames(globalThis);
  for (var i = 0; i < names.length; i++) {
    if (names[i].indexOf('__') === 0) continue;
    try { var v = globalThis[names[i]]; if (typeof v === 'string') __note(v); } catch (e) {}
  }
}
function __result() {
  var out = { found: __found.slice(), written: __written.splice(0, __written.length) };
  return JSON.stringify(out);
}
`
}

let context = null

function runInSandbox(code, name, timeoutMs = SCRIPT_TIMEOUT_MS) {
  const started = Date.now()
  try {
    vm.runInContext(code, context, { filename: name, timeout: timeoutMs, microtaskMode: 'afterEvaluate' })
    return { name, ms: Date.now() - started }
  } catch (err) {
    return { name, ms: Date.now() - started, error: String(err?.message || err).split('\n')[0].slice(0, 160) }
  }
}

function snapshot() {
  return JSON.parse(vm.runInContext('__result()', context, { timeout: 1000 }))
}

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'init') {
      context = vm.createContext({}, { name: 'player-page-sandbox' })
      // 让 window / self / top / parent 都指向沙箱全局；这几行必须在引导代码之前、在沙箱内执行
      vm.runInContext('var window = globalThis; var self = globalThis; var top = globalThis; var parent = globalThis; var frames = globalThis;', context)
      vm.runInContext(bootstrapSource(msg.page, msg.ua), context, { filename: 'sandbox-bootstrap.js' })
      parentPort.postMessage({ type: 'ready' })
    } else if (msg.type === 'run') {
      const ran = msg.scripts.map(s => runInSandbox(s.code, s.name))
      parentPort.postMessage({ type: 'ran', ran, ...snapshot() })
    } else if (msg.type === 'finish') {
      const fin = runInSandbox('__finish()', 'sandbox-finish')
      parentPort.postMessage({ type: 'result', ran: [fin], ...snapshot() })
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String(err?.message || err).split('\n')[0] })
  }
})
