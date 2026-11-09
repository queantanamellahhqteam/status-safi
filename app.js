(function () {
  'use strict';

  var MB_VERSION = '1.50.8';
  var MB_URLS = [
    new URL('mediabunny.min.mjs', document.baseURI).href,
    'https://cdn.jsdelivr.net/npm/mediabunny@' + MB_VERSION + '/dist/bundles/mediabunny.min.mjs',
    'https://cdn.jsdelivr.net/npm/mediabunny@' + MB_VERSION + '/+esm',
    'https://unpkg.com/mediabunny@' + MB_VERSION + '/dist/bundles/mediabunny.min.mjs',
    'https://cdn.jsdelivr.net/npm/mediabunny@' + MB_VERSION + '/dist/bundles/mediabunny.mjs'
  ];
  var AUDIO_BPS = 128000;
  var MAX_SEGMENTS = 10;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var state = { photos: [], video: null, busy: false, cancel: false, conv: null, mbWarn: '' };

  /* ---------- helpers ---------- */
  function h(tag, props) {
    var el = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kids = [].concat(arguments[i]);
      kids.forEach(function (c) {
        if (c == null || c === false) return;
        el.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return el;
  }
  function val(name) { var el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : ''; }
  function fmtMB(b) { return (b / 1048576).toFixed(1) + ' MB'; }
  function fmtTime(s) {
    s = Math.max(0, s);
    var m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
  }
  function safeBase(name) {
    var b = String(name || '').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    return b || 'status';
  }
  var toastTimer = 0;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.textContent = ''; }, 3600);
  }

  /* ---------- status ring ---------- */
  var NS = 'http://www.w3.org/2000/svg';
  function ring(n, prog, size) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 132 132');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('aria-hidden', 'true');
    n = Math.max(1, n);
    var cx = 66, cy = 66, r = 57;
    var gap = n === 1 ? 0 : Math.min(16, (360 / n) * 0.3);
    var arc = n === 1 ? 359.9 : (360 - gap * n) / n;
    function pt(a) { var t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; }
    for (var i = 0; i < n; i++) {
      var a0 = i * (arc + gap) + gap / 2, a1 = a0 + arc;
      var p0 = pt(a0), p1 = pt(a1);
      var d = 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + (arc > 180 ? 1 : 0) + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
      var track = document.createElementNS(NS, 'path');
      track.setAttribute('d', d);
      track.setAttribute('class', 'ring-track');
      svg.appendChild(track);
      var p = (prog && prog[i]) || 0;
      if (p > 0.02) {
        var f = document.createElementNS(NS, 'path');
        f.setAttribute('d', d);
        f.setAttribute('class', 'ring-fill');
        f.setAttribute('pathLength', '100');
        f.setAttribute('stroke-dasharray', (Math.min(1, p) * 100).toFixed(1) + ' 100');
        svg.appendChild(f);
      }
    }
    return svg;
  }
  $('#mark').appendChild(ring(3, [1, 1, 0.55], 28));
  var lastRing = 0;
  function drawRing(n, prog, force) {
    var now = performance.now();
    if (!force && now - lastRing < 120) return;
    lastRing = now;
    $('#vring').replaceChildren(ring(n, prog, 96));
  }

  /* ---------- saving and sharing ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function saveItem(it) {
    try {
      var a = document.createElement('a');
      a.href = it.url;
      a.download = it.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Inahifadhiwa: ' + it.filename);
      return true;
    } catch (e) {
      toast('Haikuweza kuhifadhi. Jaribu tena.');
      return false;
    }
  }
  function toFile(it) { return new File([it.blob], it.filename, { type: it.blob.type }); }
  function sharable(it) {
    try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [toFile(it)] })); }
    catch (e) { return false; }
  }
  async function shareItem(it) {
    try {
      await navigator.share({ files: [toFile(it)] });
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('Kushiriki kumeshindikana. Tumia Hifadhi.');
    }
  }

  /* ---------- results list ---------- */
  function makeResults(box, noun) {
    box.replaceChildren();
    var count = h('strong', { text: '' });
    var saveAll = h('button', { class: 'btn small', type: 'button', text: 'Hifadhi zote' });
    var head = h('div', { class: 'rhead', hidden: true }, h('div', { class: 'rtitle' }, count), saveAll);
    var grid = h('div', { class: 'grid' });
    box.append(head, grid);
    var items = [];
    saveAll.addEventListener('click', async function () {
      saveAll.disabled = true;
      for (var i = 0; i < items.length; i++) {
        if (!saveItem(items[i])) break;
        await sleep(500);
      }
      saveAll.disabled = false;
    });
    return {
      add: function (it) {
        items.push(it);
        var media = it.kind === 'video'
          ? h('video', { src: it.url, controls: true, playsinline: true, preload: 'metadata' })
          : h('img', { src: it.url, alt: it.label });
        var acts = h('div', { class: 'iacts' },
          h('button', { class: 'btn small', type: 'button', text: 'Hifadhi', onclick: function () { saveItem(it); } })
        );
        if (sharable(it)) acts.append(h('button', { class: 'btn small', type: 'button', text: 'Shiriki', onclick: function () { shareItem(it); } }));
        grid.append(h('div', { class: 'item' },
          h('div', { class: 'thumb' }, media),
          h('div', { class: 'meta' }, h('div', { text: it.label }), h('div', { text: it.detail })),
          it.warn ? h('div', { class: 'note', text: it.warn }) : null,
          acts
        ));
        count.textContent = items.length + ' ' + noun;
        head.hidden = false;
      },
      addError: function (label, msg) {
        grid.append(h('div', { class: 'item' }, h('div', { class: 'meta' }, h('div', { text: label })), h('div', { class: 'note err', text: msg })));
      },
      revoke: function () { items.forEach(function (it) { try { URL.revokeObjectURL(it.url); } catch (e) {} }); }
    };
  }

  /* ---------- shared painting (photo + video frames) ---------- */
  function paintFrame(ctx, draw, sw, sh, W, H, mode) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    var s = mode === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh), dw = sw * s, dh = sh * s;
    draw(ctx, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  /* ---------- tabs ---------- */
  function activate(name) {
    ['photo', 'video'].forEach(function (t) {
      var on = t === name;
      var tab = $('#tab-' + t);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $('#panel-' + t).hidden = !on;
    });
  }
  $('#tab-photo').addEventListener('click', function () { activate('photo'); });
  $('#tab-video').addEventListener('click', function () { activate('video'); });
  document.querySelector('.tabs').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      var next = $('#tab-photo').getAttribute('aria-selected') === 'true' ? 'video' : 'photo';
      activate(next);
      $('#tab-' + next).focus();
    }
  });

  /* ---------- photos ---------- */
  var photoRun = 0, photoList = null;
  function toBlob(canvas, type, q) {
    return new Promise(function (res, rej) { canvas.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob')); }, type, q); });
  }
  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {}
      try { return await createImageBitmap(file); } catch (e) {}
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.src = url;
    await img.decode();
    return img;
  }
  async function processPhotos() {
    var run = ++photoRun;
    if (photoList) photoList.revoke();
    var box = $('#photoResults');
    var files = state.photos;
    photoList = makeResults(box, files.length === 1 ? 'picha imeandaliwa' : 'picha zimeandaliwa');
    if (!files.length) { box.replaceChildren(); return; }
    var W = parseInt(val('pres'), 10), H = Math.round(W * 16 / 9);
    var mode = val('pfit');
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var list = photoList;
    for (var i = 0; i < files.length; i++) {
      if (run !== photoRun) return;
      var f = files[i];
      try {
        var bmp = await loadBitmap(f);
        var sw = bmp.naturalWidth || bmp.width, sh = bmp.naturalHeight || bmp.height;
        paintFrame(ctx, function (c, x, y, w, hh) { c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(bmp, x, y, w, hh); }, sw, sh, W, H, mode);
        if (bmp.close) bmp.close();
        var q = 0.92, blob = await toBlob(canvas, 'image/jpeg', q);
        while (blob.size > 15 * 1048576 && q > 0.6) { q -= 0.08; blob = await toBlob(canvas, 'image/jpeg', q); }
        if (run !== photoRun) return;
        list.add({
          kind: 'image', blob: blob, url: URL.createObjectURL(blob),
          filename: 'status-' + safeBase(f.name) + '-' + (i + 1) + '.jpg',
          label: 'Picha ' + (i + 1), detail: W + '×' + H + ' · ' + fmtMB(blob.size)
        });
      } catch (e) {
        console.error(e);
        if (run === photoRun) list.addError('Picha ' + (i + 1), 'Muundo wa picha hii hautumiki kwenye kivinjari hiki.');
      }
    }
  }
  $('#pfile').addEventListener('change', function (e) {
    var files = Array.from(e.target.files || []).filter(function (f) { return /^image\//.test(f.type) || !f.type; }).slice(0, 20);
    e.target.value = '';
    if (!files.length) return;
    state.photos = files;
    processPhotos();
  });
  ['pfit', 'pres'].forEach(function (n) {
    document.querySelectorAll('input[name="' + n + '"]').forEach(function (el) {
      el.addEventListener('change', function () { if (state.photos.length) processPhotos(); });
    });
  });

  /* ---------- video: library ---------- */
  function loadGlobalBuild() {
    return new Promise(function (resolve) {
      if (window.Mediabunny) return resolve(window.Mediabunny);
      var tag = document.createElement('script');
      tag.src = 'https://cdn.jsdelivr.net/npm/mediabunny@' + MB_VERSION + '/dist/bundles/mediabunny.min.cjs';
      tag.onload = function () { resolve(window.Mediabunny || null); };
      tag.onerror = function () { resolve(null); };
      document.head.appendChild(tag);
    });
  }
  var mbPromise = null;
  function loadMB() {
    if (!mbPromise) {
      mbPromise = (async function () {
        for (var i = 0; i < MB_URLS.length; i++) {
          try {
            var m = await import(MB_URLS[i]);
            if (m && m.Conversion) return m;
            if (m && m.default && m.default.Conversion) return m.default;
          } catch (e) { console.warn('mediabunny load failed', MB_URLS[i], e); }
        }
        var g = await loadGlobalBuild();
        if (g && g.Conversion) return g;
        throw new Error('mediabunny-load');
      })();
      mbPromise.catch(function () { mbPromise = null; });
    }
    return mbPromise;
  }
  var canVideo = typeof window.VideoEncoder !== 'undefined' && typeof window.VideoDecoder !== 'undefined';
  if (!canVideo) {
    var n0 = $('#vnotice');
    n0.hidden = false;
    n0.textContent = 'Kivinjari hiki hakiwezi kusindika video. Tumia Chrome kwenye Android, au kivinjari kipya cha Safari au Chrome kwenye kompyuta. Picha zinafanya kazi kawaida.';
    $('#vfile').disabled = true;
  }
  async function pickAudioCodec(MB) {
    try { if (await MB.canEncodeAudio('aac')) return 'aac'; } catch (e) {}
    try { if (await MB.canEncodeAudio('opus')) return 'opus'; } catch (e) {}
    return null;
  }

  /* ---------- video: file + plan ---------- */
  function readMeta(file) {
    return new Promise(function (resolve) {
      var v = $('#vprev');
      var done = false;
      var timer = setTimeout(function () { fin(null); }, 6000);
      function fin(r) { if (done) return; done = true; clearTimeout(timer); v.onloadedmetadata = null; v.onerror = null; resolve(r); }
      v.onloadedmetadata = function () {
        if (isFinite(v.duration) && v.duration > 0 && v.videoWidth) fin({ duration: v.duration, w: v.videoWidth, h: v.videoHeight, preview: true });
        else fin(null);
      };
      v.onerror = function () { fin(null); };
      v.src = state.video.url;
    });
  }
  async function probeWithMB(file) {
    var MB = await loadMB();
    var input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    var duration = await input.computeDuration();
    var vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('novideo');
    return { duration: duration, w: vt.displayWidth || vt.codedWidth, h: vt.displayHeight || vt.codedHeight, preview: false };
  }
  function plan() {
    var v = state.video;
    var seg = parseInt(val('vseg'), 10);
    var total = Math.max(0, v.end - v.start);
    var n = Math.ceil(total / seg - 1e-6);
    var capped = n > MAX_SEGMENTS;
    n = Math.min(n, MAX_SEGMENTS);
    var segs = [], tail = false;
    for (var i = 0; i < n; i++) {
      var s = v.start + i * seg, e = Math.min(v.end, s + seg);
      if (e - s >= 1) segs.push({ s: s, e: e }); else tail = true;
    }
    return { seg: seg, total: total, segs: segs, capped: capped, tail: tail };
  }
  function effectiveFps() {
    var f = parseInt(val('vfps'), 10) || 30;
    var vs = state.video;
    return (f === 60 && vs && vs.fps && vs.fps < 50) ? 30 : f;
  }
  function bitrateFor(dur, res, q, fps) {
    var targetMB = q === 'mid' ? 8 : 15;
    var budget = targetMB * 1048576 * 0.95;
    var cap = (res === 1080 ? 9e6 : 6e6) * (fps === 60 ? 1.4 : 1);
    return Math.round(Math.max(7e5, Math.min(cap, budget * 8 / dur - AUDIO_BPS)));
  }
  function updateSummary() {
    if (!state.video || state.busy) return;
    var p = plan();
    var n = p.segs.length;
    $('#vn').textContent = String(n);
    $('#vnl').textContent = n === 1 ? 'kipande' : 'vipande';
    drawRing(Math.max(1, n), [], true);
    var sum = $('#vsum');
    sum.replaceChildren();
    if (!n) {
      sum.append(h('strong', { text: 'Chagua sehemu ya video' }), h('span', { text: 'Mwisho lazima uwe baada ya mwanzo kwa angalau sekunde 1.' }));
      $('#vgo').disabled = true;
      return;
    }
    var res = parseInt(val('vres'), 10), q = val('vq'), fps = effectiveFps();
    var first = p.segs[0], dur = first.e - first.s;
    var est = (bitrateFor(dur, res, q, fps) + AUDIO_BPS) * dur / 8;
    sum.append(
      h('strong', { text: 'Urefu wa jumla ' + fmtTime(p.total) }),
      h('span', { text: 'Kila kipande hadi sekunde ' + p.seg + ' · ≈ ' + fmtMB(est) }),
      h('span', { text: 'MP4 · H.264 · ' + fps + ' fps' })
    );
    var notes = [];
    if (parseInt(val('vfps'), 10) === 60 && fps === 30) notes.push('Video yako ina takribani fps ' + Math.round(state.video.fps) + ', kwa hiyo nitatumia 30 fps. 60 haiongezi ubora hapa.');
    if (p.capped) notes.push('Vipande ' + MAX_SEGMENTS + ' vya kwanza tu vitaandaliwa kwa mara moja. Chagua sehemu fupi kwa vingine.');
    if (p.tail) notes.push('Sehemu ya mwisho iliyo chini ya sekunde 1 imeachwa.');
    if (state.mbWarn) notes.push(state.mbWarn);
    var w = $('#vwarn');
    w.hidden = !notes.length;
    w.textContent = notes.join(' ');
    $('#vgo').disabled = false;
  }

  var videoList = null;
  function resetVideo() {
    if (state.video && state.video.url) { try { URL.revokeObjectURL(state.video.url); } catch (e) {} }
    if (videoList) videoList.revoke();
    videoList = null;
    $('#videoResults').replaceChildren();
    $('#vprog').hidden = true;
    state.video = null;
  }
  $('#vfile').addEventListener('change', async function (e) {
    var file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file || state.busy) return;
    resetVideo();
    var url = URL.createObjectURL(file);
    state.video = { file: file, url: url, duration: 0, w: 0, h: 0, start: 0, end: 0, preview: true };
    var notice = $('#vnotice');
    notice.hidden = true;
    $('#vbody').hidden = false;
    $('#vinfo').textContent = 'Inasoma video…';
    $('#vgo').disabled = true;

    var meta = await readMeta(file);
    if (!meta) {
      try { meta = await probeWithMB(file); }
      catch (err) {
        console.error(err);
        $('#vbody').hidden = true;
        notice.hidden = false;
        notice.textContent = 'Siwezi kusoma video hii. Jaribu faili la MP4 au MOV.';
        state.video = null;
        return;
      }
    }
    var v = state.video;
    v.duration = meta.duration; v.w = meta.w; v.h = meta.h; v.preview = meta.preview;
    v.start = 0; v.end = Math.round(meta.duration * 10) / 10;
    $('#vprev').hidden = !meta.preview;
    $('#vsetstart').hidden = !meta.preview;
    $('#vsetend').hidden = !meta.preview;
    $('#vinfo').textContent = file.name + ' · ' + fmtTime(meta.duration) + ' · ' + meta.w + '×' + meta.h + ' · ' + fmtMB(file.size);
    $('#vstart').value = '0';
    $('#vend').value = String(v.end);
    $('#vend').max = String(v.end);
    $('#vstart').max = String(v.end);
    state.mbWarn = '';
    updateSummary();
    // warm up the converter and learn what audio this browser can write
    try {
      var MB = await loadMB();
      var codec = await pickAudioCodec(MB);
      try {
        var inp = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
        var vt0 = await inp.getPrimaryVideoTrack();
        var st0 = vt0 && vt0.computePacketStats ? await vt0.computePacketStats(120) : null;
        if (st0 && st0.averagePacketRate && state.video && state.video.file === file) {
          state.video.fps = st0.averagePacketRate;
          $('#vinfo').textContent += ' · ' + Math.round(st0.averagePacketRate) + ' fps';
        }
      } catch (e) { console.warn('fps probe failed', e); }
      if (codec === 'opus') state.mbWarn = 'Kivinjari hiki hakiwezi kuandika sauti ya AAC, kwa hiyo sauti inawekwa kama Opus. Ikiwa haichezi kwenye WhatsApp, jaribu Chrome kwenye Android.';
      if (codec === null) state.mbWarn = 'Kivinjari hiki hakiwezi kuhifadhi sauti. Video zitatoka bila sauti.';
    } catch (err) {
      $('#vnotice').hidden = false;
      $('#vnotice').textContent = 'Maktaba ya kusindika video haikupakiwa. Angalia mtandao kisha pakia ukurasa upya.';
      $('#vgo').disabled = true;
      return;
    }
    updateSummary();
  });

  function clampRange(changed) {
    var v = state.video;
    if (!v) return;
    var s = parseFloat($('#vstart').value), en = parseFloat($('#vend').value);
    if (!isFinite(s)) s = 0;
    if (!isFinite(en)) en = v.duration;
    s = Math.min(Math.max(0, s), v.duration);
    en = Math.min(Math.max(0, en), v.duration);
    if (changed === 'start' && en - s < 1) en = Math.min(v.duration, s + 1);
    if (changed === 'end' && en - s < 1) s = Math.max(0, en - 1);
    v.start = s; v.end = en;
    $('#vstart').value = String(Math.round(s * 10) / 10);
    $('#vend').value = String(Math.round(en * 10) / 10);
    updateSummary();
  }
  $('#vstart').addEventListener('change', function () { clampRange('start'); });
  $('#vend').addEventListener('change', function () { clampRange('end'); });
  $('#vsetstart').addEventListener('click', function () { $('#vstart').value = $('#vprev').currentTime.toFixed(1); clampRange('start'); });
  $('#vsetend').addEventListener('click', function () { $('#vend').value = $('#vprev').currentTime.toFixed(1); clampRange('end'); });
  ['vseg', 'vres', 'vq', 'vfps'].forEach(function (n) {
    document.querySelectorAll('input[name="' + n + '"]').forEach(function (el) { el.addEventListener('change', updateSummary); });
  });

  /* ---------- video: conversion ---------- */
  async function convertSegment(MB, vs, seg, W, H, vb, fps, fit, audioCodec, onPr) {
    var input = new MB.Input({ source: new MB.BlobSource(vs.file), formats: MB.ALL_FORMATS });
    var output = new MB.Output({ format: new MB.Mp4OutputFormat(), target: new MB.BufferTarget() });
    var audioOpts = audioCodec ? { codec: audioCodec, bitrate: AUDIO_BPS } : { discard: true };
    var conv = await MB.Conversion.init({
      input: input, output: output,
      video: { width: W, height: H, fit: fit, frameRate: fps, bitrate: vb, keyFrameInterval: 2 },
      audio: audioOpts,
      trim: { start: seg.s, end: seg.e }
    });
    state.conv = conv;
    var droppedAudio = false;
    var discarded = conv.discardedTracks || [];
    discarded.forEach(function (d) {
      var type = d.track && d.track.type;
      if (type === 'audio' && d.reason !== 'discarded_by_user') droppedAudio = true;
    });
    var videoLost = discarded.some(function (d) { return d.track && d.track.type === 'video'; });
    if (!conv.isValid || videoLost) throw new Error('invalid-conversion');
    conv.onProgress = onPr;
    await conv.execute();
    state.conv = null;
    return { buf: output.target.buffer, droppedAudio: droppedAudio };
  }
  async function runVideo() {
    if (state.busy || !state.video) return;
    var vs = state.video;
    var p = plan();
    if (!p.segs.length) return;
    state.busy = true; state.cancel = false;
    $('#vgo').hidden = true; $('#vstop').hidden = false;
    $('#vprog').hidden = false;
    $('#vbar').style.width = '0%';
    var warn = $('#vwarn');
    if (videoList) videoList.revoke();
    videoList = makeResults($('#videoResults'), 'vipande tayari');
    var wake = null;
    try { wake = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) {}

    var n = p.segs.length, prog = new Array(n).fill(0);
    var errMsg = '';
    try {
      var MB = await loadMB();
      var res = parseInt(val('vres'), 10), W = res, H = Math.round(res * 16 / 9);
      var q = val('vq'), fps = effectiveFps(), fellBack = false;
      var fit = val('vfit') === 'cover' ? 'cover' : 'contain';
      var audioCodec = await pickAudioCodec(MB);
      var droppedAudio = false;

      for (var i = 0; i < n; i++) {
        if (state.cancel) break;
        var seg = p.segs[i], dur = seg.e - seg.s;
        var vb = bitrateFor(dur, res, q, fps);
        $('#vptxt').textContent = 'Kipande ' + (i + 1) + ' kati ya ' + n + ' · 0%';
        drawRing(n, prog, true);

        var idx = i;
        var onPr = function (pr) {
          var pp = Math.min(1, pr);
          prog[idx] = pp;
          $('#vbar').style.width = (((idx + pp) / n) * 100).toFixed(1) + '%';
          $('#vptxt').textContent = 'Kipande ' + (idx + 1) + ' kati ya ' + n + ' · ' + Math.round(pp * 100) + '%';
          drawRing(n, prog, false);
        };
        var fpsList = fps === 60 ? [60, 30] : [30];
        var buf = null, usedFps = fps;
        for (var fi = 0; fi < fpsList.length && !buf; fi++) {
          try {
            var r = await convertSegment(MB, vs, seg, W, H, vb, fpsList[fi], fit, audioCodec, onPr);
            buf = r.buf; usedFps = fpsList[fi];
            if (r.droppedAudio) droppedAudio = true;
          } catch (err) {
            state.conv = null;
            if (state.cancel || fi === fpsList.length - 1) throw err;
            console.warn('60 fps failed, retrying at 30 fps', err);
            fellBack = true; fps = 30;
            vb = bitrateFor(dur, res, q, 30);
            prog[idx] = 0;
          }
        }
        if (state.cancel) break;
        if (!buf || !buf.byteLength) throw new Error('empty-output');
        prog[i] = 1;
        drawRing(n, prog, true);
        $('#vbar').style.width = (((i + 1) / n) * 100).toFixed(1) + '%';
        var blob = new Blob([buf], { type: 'video/mp4' });
        videoList.add({
          kind: 'video', blob: blob, url: URL.createObjectURL(blob),
          filename: 'status-' + safeBase(vs.file.name) + '-' + (i + 1) + '.mp4',
          label: 'Kipande ' + (i + 1) + ' (' + fmtTime(seg.s) + ' – ' + fmtTime(seg.e) + ')',
          detail: W + '×' + H + ' · ' + usedFps + ' fps · ' + fmtMB(blob.size),
          warn: blob.size > 16 * 1048576 ? 'Kimezidi MB 16. Chagua ukubwa wa Wastani kisha ujaribu tena.' : ''
        });
      }
      var after = [];
      if (fellBack) after.push('Simu hii haikuweza kuandika 60 fps, kwa hiyo nimetumia 30 fps.');
      if (droppedAudio) after.push('Sauti ya video hii haikuweza kuhifadhiwa kwenye kivinjari hiki.');
      if (after.length) { warn.hidden = false; warn.textContent = after.join(' '); }
    } catch (err) {
      console.error(err);
      if (!state.cancel) errMsg = 'Imeshindikana kuandaa video hii. Jaribu azimio la 720p, au tumia Chrome kwenye Android.';
    } finally {
      try { if (wake && wake.release) await wake.release(); } catch (e) {}
      state.busy = false; state.conv = null;
      $('#vgo').hidden = false; $('#vstop').hidden = true;
      if (state.cancel) $('#vptxt').textContent = 'Umeacha. Vipande vilivyokamilika vinabaki hapa chini.';
      else if (errMsg) $('#vptxt').textContent = errMsg;
      else $('#vptxt').textContent = 'Tayari. Bonyeza Hifadhi kwenye kila kipande.';
      updateSummary();
    }
  }
  $('#vgo').addEventListener('click', runVideo);
  $('#vstop').addEventListener('click', function () {
    state.cancel = true;
    if (state.conv && state.conv.cancel) { try { state.conv.cancel(); } catch (e) {} }
  });

  var yr = $('#year');
  if (yr) yr.textContent = String(new Date().getFullYear());
})();
