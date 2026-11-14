(() => {
  'use strict';

  /* ------------------------------------------------------------------
     STATUS SAFI
     Video engine: single-thread FFmpeg core (WebAssembly) running inside
     a same-origin Web Worker that is created from a Blob. Running the
     worker from our own origin is what avoids the "stuck at 10%" problem:
     browsers (Safari especially) silently refuse to start a Worker whose
     script lives on another origin such as a CDN.
  ------------------------------------------------------------------- */

  const CORE_VERSION = '0.12.10';
  const CORE_SOURCES = [
    `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`,
    `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`
  ];
  const MAX_VIDEO_BYTES = 700 * 1024 * 1024;
  const ENGINE_APPROX_BYTES = 32 * 1024 * 1024;
  const INPUT_DIR = '/input';
  const INPUT_NAME = 'input_video';
  const MUSIC_DIR = '/music';
  const MUSIC_NAME = 'music_input';
  const OVERLAY_NAME = 'overlay.png';
  const FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Color Emoji", sans-serif';

  /* @pure-start  (no DOM access in this block: it is unit-tested with a real ffmpeg) */

  const PART_SECONDS = 60;

  /* `short` is the length of the output's shorter side in pixels. */
  const QUALITY = {
    hd:   { short: 720,  crf: 21, maxrate: '4M',    bufsize: '8M',  preset: 'superfast' },
    fast: { short: 540,  crf: 24, maxrate: '2500k', bufsize: '5M',  preset: 'ultrafast' },
    max:  { short: 1080, crf: 20, maxrate: '8M',    bufsize: '16M', preset: 'ultrafast' }
  };
  const ASPECTS = { orig: 0, '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1 };

  const evenFloor = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const evenRound = (n) => Math.max(2, Math.round(n / 2) * 2);
  const fmtSec = (n) => (Math.round(Math.max(0, n) * 1000) / 1000).toFixed(3);
  const fmtNum = (n) => String(Math.round(n * 1000) / 1000);

  function targetAspect(src, edit) {
    return ASPECTS[edit.aspect] || src.w / src.h;
  }

  /* Works out the output size, and the crop rectangle in source pixels. Never upscales. */
  function computeOutput(src, edit, quality) {
    const aspect = targetAspect(src, edit);
    const fit = edit.aspect !== 'orig' && edit.fit === 'fit';
    let W;
    let H;
    if (aspect < 1) { W = quality.short; H = quality.short / aspect; }
    else { H = quality.short; W = quality.short * aspect; }

    const crop = { w: src.w, h: src.h, x: 0, y: 0 };
    if (edit.aspect !== 'orig' && !fit) {
      if (src.w / src.h > aspect) {
        crop.w = src.h * aspect;
        crop.x = (src.w - crop.w) * edit.pos;
      } else {
        crop.h = src.w / aspect;
        crop.y = (src.h - crop.h) * edit.pos;
      }
    }

    const scale = fit ? Math.min(W / src.w, H / src.h) : W / crop.w;
    if (scale > 1) { W /= scale; H /= scale; }

    const cw = Math.min(evenFloor(crop.w), evenFloor(src.w));
    const ch = Math.min(evenFloor(crop.h), evenFloor(src.h));
    let cx = Math.max(0, Math.min(Math.floor(crop.x), src.w - cw));
    let cy = Math.max(0, Math.min(Math.floor(crop.y), src.h - ch));
    cx -= cx % 2;
    cy -= cy % 2;

    return {
      W: evenRound(W),
      H: evenRound(H),
      fit,
      cropped: cw < src.w || ch < src.h,
      crop: { w: cw, h: ch, x: cx, y: cy }
    };
  }

  /* Builds the complete ffmpeg argument list for one part. */
  function buildArgs(p) {
    const { out, quality } = p;
    const args = ['-ss', fmtSec(p.start), '-i', p.inputPath];
    let next = 1;
    let overlayIdx = -1;
    let musicIdx = -1;
    if (p.overlayPath) { args.push('-i', p.overlayPath); overlayIdx = next++; }
    if (p.music) {
      args.push('-stream_loop', '-1', '-ss', fmtSec(p.music.offset), '-i', p.music.path);
      musicIdx = next++;
    }

    const fps = p.fps > 31 ? 'fps=30,' : '';
    const chains = [];
    if (out.fit) {
      const bw = evenRound(out.W / 8);
      const bh = evenRound(out.H / 8);
      chains.push(`[0:v]${fps}split=2[a][b]`);
      chains.push(`[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=3:2,scale=${out.W}:${out.H}:flags=bilinear[bg]`);
      chains.push(`[b]scale=${out.W}:${out.H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]`);
      chains.push('[bg][fg]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,setsar=1[v0]');
    } else {
      const c = out.crop;
      const cropFilter = out.cropped ? `crop=${c.w}:${c.h}:${c.x}:${c.y},` : '';
      chains.push(`[0:v]${fps}${cropFilter}scale=${out.W}:${out.H},setsar=1[v0]`);
    }
    chains.push(overlayIdx >= 0
      ? `[v0][${overlayIdx}:v]overlay=0:0:format=auto,format=yuv420p[v]`
      : '[v0]format=yuv420p[v]');

    const maps = ['-map', '[v]'];
    if (p.music) {
      const audioFormat = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
      const vol = fmtNum(p.music.volume);
      if (p.music.mode === 'mix' && p.hasAudio) {
        chains.push(`[0:a]${audioFormat}[oa]`);
        chains.push(`[${musicIdx}:a]${audioFormat},volume=${vol}[ma]`);
        chains.push('[oa][ma]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95[a]');
      } else {
        chains.push(`[${musicIdx}:a]${audioFormat},volume=${vol}[a]`);
      }
      maps.push('-map', '[a]');
    } else {
      maps.push('-map', '0:a?');
    }

    args.push(
      '-filter_complex', chains.join(';'),
      ...maps,
      '-c:v', 'libx264', '-preset', quality.preset, '-crf', String(quality.crf),
      '-maxrate', quality.maxrate, '-bufsize', quality.bufsize, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero',
      '-t', fmtSec(p.length), p.outputName
    );
    return args;
  }

  /* Reads what `ffmpeg -i file` prints: frame rate and whether there is an audio track. */
  function parseProbe(text) {
    const info = { found: /Input #0/.test(text), fps: 0, hasAudio: null };
    const video = /Stream #0:\d+[^\n]*?Video:[^\n]*?(\d+(?:\.\d+)?) fps/.exec(text);
    if (video) info.fps = parseFloat(video[1]);
    if (info.found) info.hasAudio = /Stream #0:\d+[^\n]*?Audio:/.test(text);
    return info;
  }

  /* @pure-end */

  const $ = (id) => document.getElementById(id);
  const pages = [...document.querySelectorAll('.page')];
  const video = $('videoPreview');
  const bgVideo = $('videoBg');

  const defaults = () => ({
    aspect: 'orig', fit: 'fill', pos: 0.5,
    trimStart: 0, trimEnd: 0,
    text: '', color: '#ffffff', box: false, size: 0.08, textY: 0.78,
    musicFile: null, musicDuration: NaN, musicMode: 'mix', musicVol: 0.7,
    caption: ''
  });

  let edit = defaults();
  let videoFile = null;
  let photoFile = null;
  let videoURL = null;
  let photoURL = null;
  let outputFiles = [];
  let toastTimer = null;
  let processing = false;
  let wakeLock = null;
  let musicEl = null;
  let musicURL = null;
  let refreshQueued = false;

  /* ---------------------------- UI helpers --------------------------- */

  function toast(message, ms = 5200) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function showPage(id) {
    pages.forEach((page) => page.classList.toggle('active', page.id === id));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.querySelectorAll('[data-open]').forEach((button) =>
    button.addEventListener('click', () => showPage(button.dataset.open)));
  document.querySelectorAll('[data-back]').forEach((button) =>
    button.addEventListener('click', () => showPage('homePage')));
  $('helpBtn').addEventListener('click', () =>
    toast('Choose a video or photo, edit it, then tap Share and pick WhatsApp > My Status. Your files are processed on your device and never uploaded.', 8000));

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return 'Duration unavailable';
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function formatTimeTenths(seconds) {
    const s = Math.max(0, seconds);
    const whole = Math.floor(s);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${Math.floor((s - whole) * 10)}`;
  }

  function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function safeName(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]/gi, '_').slice(0, 42) || 'status_video';
  }

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const clamp01 = (value) => clamp(Number(value) || 0, 0, 1);

  /* Progress panel. `percent === null` shows an animated "working" bar. */
  let progressHint = '';
  let tickTimer = null;
  let tickStart = 0;

  function renderHint() {
    const el = $('progressHint');
    if (tickTimer) {
      const seconds = Math.floor((Date.now() - tickStart) / 1000);
      el.textContent = `${progressHint} Time elapsed: ${formatTime(seconds)}.`;
    } else {
      el.textContent = progressHint;
    }
  }

  function setProgress(percent, label, hint) {
    const track = $('progressTrack');
    const bar = $('progressBar');
    if (percent === null) {
      track.classList.add('indeterminate');
      bar.style.width = '';
      $('progressPercent').textContent = '…';
      track.setAttribute('aria-valuenow', '0');
    } else {
      const value = clamp(percent, 0, 100);
      track.classList.remove('indeterminate');
      bar.style.width = `${value}%`;
      $('progressPercent').textContent = `${Math.floor(value)}%`;
      track.setAttribute('aria-valuenow', String(Math.floor(value)));
    }
    if (label) $('progressText').textContent = label;
    if (hint !== undefined) progressHint = hint;
    renderHint();
  }

  function startTicker() {
    stopTicker();
    tickStart = Date.now();
    tickTimer = setInterval(renderHint, 1000);
  }
  function stopTicker() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  async function keepAwake(on) {
    try {
      if (on) {
        if ('wakeLock' in navigator && !wakeLock) {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
      } else if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (error) { /* optional feature */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && processing) keepAwake(true);
  });

  async function copyText(text) {
    if (!text.trim()) { toast('Write a caption first.'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast('Caption copied. Paste it in the caption box in WhatsApp.');
    } catch (error) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); toast('Caption copied. Paste it in the caption box in WhatsApp.'); }
      catch (copyError) { toast('Could not copy automatically. Select the text and copy it.'); }
      area.remove();
    }
  }

  /* ---------------------- Worker (runs inside the Blob) -------------- */
  /* This function is serialised with toString(), so it must be fully
     self-contained: no references to anything outside of it. */
  function engineWorkerMain() {
    'use strict';
    let core = null;
    const recentLogs = [];
    const send = (message, transfer) => self.postMessage(message, transfer || []);

    const handlers = {
      async load({ coreURL, wasmURL }) {
        importScripts(coreURL);
        if (typeof self.createFFmpegCore !== 'function') {
          throw new Error('The video engine script did not initialise.');
        }
        core = await self.createFFmpegCore({
          mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL: wasmURL, workerURL: coreURL })),
          locateFile: (path, prefix) => (/\.wasm$/.test(path) ? wasmURL : (prefix || '') + path)
        });
        if (!core || typeof core.exec !== 'function' || !core.FS) {
          throw new Error('The video engine is not compatible with this build.');
        }
        if (typeof core.setLogger === 'function') {
          core.setLogger((event) => {
            const message = String(event && event.message !== undefined ? event.message : event);
            recentLogs.push(message);
            if (recentLogs.length > 14) recentLogs.shift();
            send({ type: 'log', message: message });
          });
        }
        if (typeof core.setProgress === 'function') {
          core.setProgress((event) => send({
            type: 'progress',
            progress: event && event.progress,
            time: event && event.time
          }));
        }
        return true;
      },

      mount({ dir, file }) {
        const FS = core.FS;
        const fs = FS.filesystems && FS.filesystems.WORKERFS;
        if (!fs) throw new Error('WORKERFS is not available in this video engine.');
        try { FS.mkdir(dir); } catch (error) { /* already exists */ }
        FS.mount(fs, { files: [file] }, dir);
        return true;
      },

      write({ path, data }) {
        core.FS.writeFile(path, data);
        return true;
      },

      exec({ args }) {
        if (typeof core.setTimeout === 'function') core.setTimeout(-1);
        core.exec(...args);
        const ret = core.ret;
        if (typeof core.reset === 'function') core.reset();
        return ret;
      },

      read({ path }) {
        let data = core.FS.readFile(path);
        const heap = core.HEAPU8 && core.HEAPU8.buffer;
        const ownsBuffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && data.buffer !== heap;
        if (!ownsBuffer) data = data.slice();
        return { data: data };
      },

      remove({ path }) {
        try { core.FS.unlink(path); } catch (error) { /* ignore */ }
        return true;
      },

      cleanup({ dir, path }) {
        try { core.FS.unlink(path); } catch (error) { /* ignore */ }
        try { core.FS.unmount(dir); } catch (error) { /* ignore */ }
        try { core.FS.rmdir(dir); } catch (error) { /* ignore */ }
        return true;
      }
    };

    self.onmessage = async (event) => {
      const message = event.data || {};
      try {
        const handler = handlers[message.type];
        if (!handler) throw new Error('Unknown request: ' + message.type);
        const result = await handler(message);
        const transfer = result && result.data instanceof Uint8Array ? [result.data.buffer] : [];
        send({ id: message.id, ok: true, result: result }, transfer);
      } catch (error) {
        send({
          id: message.id,
          ok: false,
          error: String((error && error.message) || error),
          logs: recentLogs.slice(-6)
        });
      }
    };
  }

  /* --------------------- Engine (main-thread side) ------------------- */

  const engine = {
    worker: null, ready: false, loading: null, seq: 0,
    pending: new Map(), onProgress: null, onLog: null, recentLogs: []
  };

  function remoteError(data) {
    const error = new Error(data.error || 'Unknown video engine error.');
    error.logs = data.logs || [];
    return error;
  }

  function failEngine(error) {
    engine.pending.forEach((entry) => entry.reject(error));
    engine.pending.clear();
    if (engine.worker) engine.worker.terminate();
    engine.worker = null;
    engine.ready = false;
  }

  function startWorker() {
    const source = `(${engineWorkerMain.toString()})();`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'log') {
        engine.recentLogs.push(data.message);
        if (engine.recentLogs.length > 14) engine.recentLogs.shift();
        if (engine.onLog) engine.onLog(data.message);
        return;
      }
      if (data.type === 'progress') { if (engine.onProgress) engine.onProgress(data); return; }
      const entry = engine.pending.get(data.id);
      if (!entry) return;
      engine.pending.delete(data.id);
      if (data.ok) entry.resolve(data.result); else entry.reject(remoteError(data));
    };
    worker.onerror = (event) => {
      if (event && event.preventDefault) event.preventDefault();
      failEngine(new Error(`Video worker error: ${(event && event.message) || 'it could not start'}`));
    };
    worker.onmessageerror = () => failEngine(new Error('Video worker error: message could not be read.'));
    engine.worker = worker;
  }

  function engineCall(type, payload = {}, options = {}) {
    const { transfer = [], timeout = 0, timeoutMessage = 'The video engine did not respond.' } = options;
    return new Promise((resolve, reject) => {
      if (!engine.worker) { reject(new Error('Video worker error: the engine is not running.')); return; }
      const id = ++engine.seq;
      let timer = null;
      if (timeout) {
        timer = setTimeout(() => {
          engine.pending.delete(id);
          reject(new Error(timeoutMessage));
        }, timeout);
      }
      engine.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      engine.worker.postMessage({ id, type, ...payload }, transfer);
    });
  }

  /* Download a file with progress. Aborts if no bytes arrive for `stallMs`. */
  async function fetchBlob(url, type, onBytes, stallMs = 30000) {
    const controller = new AbortController();
    let timer = null;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), stallMs); };
    arm();
    try {
      const response = await fetch(url, { signal: controller.signal, mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
      const total = Number(response.headers.get('content-length')) || 0;
      if (!response.body || !response.body.getReader) {
        const blob = await response.blob();
        onBytes(blob.size, total || blob.size);
        return new Blob([blob], { type });
      }
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onBytes(received, total);
        arm();
      }
      return new Blob(chunks, { type });
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('Download stalled: no data received.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function downloadEngine() {
    let lastError = null;
    for (let index = 0; index < CORE_SOURCES.length; index++) {
      const base = CORE_SOURCES[index];
      try {
        let jsBytes = 0;
        let wasmBytes = 0;
        let wasmTotal = 0;
        const update = () => {
          const expected = (wasmTotal || ENGINE_APPROX_BYTES) + 200 * 1024;
          const percent = Math.min(99, ((jsBytes + wasmBytes) / expected) * 100);
          setProgress(percent, 'Step 1 of 2: Downloading video engine',
            `One-time download (${formatSize(jsBytes + wasmBytes)} so far). Keep this page open.`);
        };
        update();
        const coreBlob = await fetchBlob(`${base}/ffmpeg-core.js`, 'text/javascript', (received) => { jsBytes = received; update(); });
        const wasmBlob = await fetchBlob(`${base}/ffmpeg-core.wasm`, 'application/wasm', (received, total) => { wasmBytes = received; wasmTotal = total; update(); });
        return { coreURL: URL.createObjectURL(coreBlob), wasmURL: URL.createObjectURL(wasmBlob) };
      } catch (error) {
        lastError = error;
        console.warn('[STATUS SAFI] Engine download failed from', base, error);
        if (index < CORE_SOURCES.length - 1) {
          setProgress(0, 'Step 1 of 2: Trying another server…', 'The first server did not respond.');
        }
      }
    }
    throw new Error(`Download failed: ${(lastError && lastError.message) || 'network error'}`);
  }

  async function ensureEngine() {
    if (engine.ready && engine.worker) return;
    if (engine.loading) return engine.loading;
    engine.loading = (async () => {
      try {
        const { coreURL, wasmURL } = await downloadEngine();
        setProgress(null, 'Step 1 of 2: Starting video engine…', 'Setting up the video processor on this device.');
        startWorker();
        await engineCall('load', { coreURL, wasmURL }, {
          timeout: 90000,
          timeoutMessage: 'Video engine did not start within 90 seconds.'
        });
        engine.ready = true;
      } catch (error) {
        failEngine(error);
        throw error;
      } finally {
        engine.loading = null;
      }
    })();
    return engine.loading;
  }

  /* ------------------------- Text overlay (canvas) ------------------- */

  function wrapLines(ctx, text, maxWidth) {
    const lines = [];
    text.split(/\r?\n/).forEach((paragraph) => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); return; }
      let line = '';
      words.forEach((word) => {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width <= maxWidth) { line = test; return; }
        if (line) lines.push(line);
        line = '';
        if (ctx.measureText(word).width <= maxWidth) { line = word; return; }
        let chunk = '';
        for (const ch of word) {
          if (chunk && ctx.measureText(chunk + ch).width > maxWidth) { lines.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
      });
      if (line) lines.push(line);
    });
    return lines;
  }

  function roundedRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /* Draws the caption text on a transparent canvas of the final output size. Returns false if empty. */
  function drawTextOverlay(canvas, W, H) {
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const text = edit.text.trim();
    if (!text) return false;

    const fontSize = Math.round(W * edit.size);
    ctx.font = `800 ${fontSize}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrapLines(ctx, text, W * 0.84);
    const lineHeight = Math.round(fontSize * 1.28);
    const blockHeight = lines.length * lineHeight;
    const pad = Math.round(fontSize * 0.35);
    const margin = Math.round(H * 0.03);
    const half = blockHeight / 2 + pad;
    const centerY = clamp(H * edit.textY, margin + half, Math.max(margin + half, H - margin - half));
    const top = centerY - blockHeight / 2;

    if (edit.box) {
      const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
      const boxW = Math.min(W * 0.94, widest + fontSize * 0.9);
      const boxH = blockHeight + pad * 1.4;
      const dark = edit.color.toLowerCase() === '#000000';
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.62)';
      roundedRect(ctx, (W - boxW) / 2, centerY - boxH / 2, boxW, boxH, fontSize * 0.4);
      ctx.fill();
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = fontSize * 0.2;
      ctx.shadowOffsetY = fontSize * 0.05;
    }
    ctx.fillStyle = edit.color;
    lines.forEach((line, index) => ctx.fillText(line, W / 2, top + lineHeight * (index + 0.5)));
    return true;
  }

  /* ----------------------------- Editor state ------------------------ */

  function currentSrc() {
    const w = video.videoWidth;
    const h = video.videoHeight;
    return w > 0 && h > 0 ? { w, h } : null;
  }

  function currentQuality() {
    return QUALITY[$('qualitySelect').value] || QUALITY.hd;
  }

  function trimLength() {
    return Math.max(0, edit.trimEnd - edit.trimStart);
  }

  function partCountFor(length) {
    return Math.max(1, Math.ceil((length - 0.25) / PART_SECONDS));
  }

  function setChipGroup(group, attr, value) {
    group.querySelectorAll(`[${attr}]`).forEach((button) => {
      const on = button.getAttribute(attr) === value;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
    });
  }

  function bindChipGroup(groupId, attr, onChange) {
    const group = $(groupId);
    group.querySelectorAll(`[${attr}]`).forEach((button) => {
      button.addEventListener('click', () => {
        const value = button.getAttribute(attr);
        setChipGroup(group, attr, value);
        onChange(value);
      });
    });
  }

  function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshQueued = false; refresh(); });
  }

  function refresh() {
    const src = currentSrc();
    if (!src) return;
    const out = computeOutput(src, edit, currentQuality());
    const aspect = targetAspect(src, edit);
    $('stage').style.setProperty('--ratio', String(aspect));

    const fit = out.fit;
    video.style.objectFit = fit || edit.aspect === 'orig' ? 'contain' : 'cover';
    const horizontal = src.w / src.h > aspect;
    video.style.objectPosition = horizontal ? `${edit.pos * 100}% 50%` : `50% ${edit.pos * 100}%`;
    bgVideo.classList.toggle('is-hidden', !fit);
    if (fit && bgVideo.src) { syncBackground(); }

    $('fitGroup').classList.toggle('is-hidden', edit.aspect === 'orig');
    $('posGroup').classList.toggle('is-hidden', edit.aspect === 'orig' || fit || !out.cropped);
    $('posAxis').textContent = horizontal ? '(left / right)' : '(up / down)';

    drawTextOverlay($('textCanvas'), out.W, out.H);

    const length = trimLength();
    const parts = partCountFor(length);
    $('trimStartLabel').textContent = formatTimeTenths(edit.trimStart);
    $('trimEndLabel').textContent = formatTimeTenths(edit.trimEnd);
    $('trimSummary').textContent = `Selected length: ${formatTime(length)}${length > PART_SECONDS ? ` (${parts} parts of up to 60 s)` : ''}`;
    $('outputSummary').textContent = `Output: ${out.W}×${out.H} • ${parts === 1 ? '1 video' : `${parts} parts`}${edit.musicFile ? ' • with music' : ''}`;
  }

  function syncBackground() {
    if (!bgVideo.src) return;
    try {
      if (Math.abs(bgVideo.currentTime - video.currentTime) > 0.3) bgVideo.currentTime = video.currentTime;
      if (video.paused) bgVideo.pause(); else bgVideo.play().catch(() => {});
    } catch (error) { /* cosmetic only */ }
  }

  /* ----------------------------- Music preview ----------------------- */

  function syncMusic(play) {
    if (!musicEl) return;
    video.muted = edit.musicMode === 'replace';
    musicEl.volume = clamp01(edit.musicVol);
    if (play) {
      const d = musicEl.duration;
      const t = Math.max(0, video.currentTime - edit.trimStart);
      try { musicEl.currentTime = Number.isFinite(d) && d > 0 ? t % d : 0; } catch (error) { /* not seekable yet */ }
      musicEl.play().catch(() => {});
    } else {
      musicEl.pause();
    }
  }

  function setMusic(file) {
    if (musicEl) { musicEl.pause(); musicEl.removeAttribute('src'); musicEl.load(); }
    if (musicURL) URL.revokeObjectURL(musicURL);
    musicEl = null;
    musicURL = null;
    edit.musicFile = file || null;
    edit.musicDuration = NaN;
    video.muted = false;
    $('musicInfo').classList.toggle('is-hidden', !file);
    $('musicOptions').classList.toggle('is-hidden', !file);
    if (file) {
      $('musicName').textContent = `${file.name} • ${formatSize(file.size)}`;
      musicURL = URL.createObjectURL(file);
      musicEl = new Audio();
      musicEl.preload = 'auto';
      musicEl.loop = true;
      musicEl.onloadedmetadata = () => { edit.musicDuration = musicEl ? musicEl.duration : NaN; };
      musicEl.onerror = () => {
        toast('This browser cannot read that audio file. Try an MP3, M4A or WAV saved in your Files app.');
        setMusic(null);
        scheduleRefresh();
      };
      musicEl.src = musicURL;
      video.muted = edit.musicMode === 'replace';
    }
  }

  video.addEventListener('play', () => { syncMusic(true); syncBackground(); });
  video.addEventListener('pause', () => { syncMusic(false); syncBackground(); });
  video.addEventListener('ended', () => { syncMusic(false); syncBackground(); });
  video.addEventListener('seeked', () => { if (!video.paused) syncMusic(true); syncBackground(); });
  video.addEventListener('timeupdate', () => {
    if (edit.trimEnd > 0 && video.currentTime >= edit.trimEnd - 0.05 && !video.paused) {
      video.pause();
      video.currentTime = edit.trimStart;
    }
  });

  /* ----------------------------- Editor controls --------------------- */

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((other) => {
        const on = other === tab;
        other.classList.toggle('is-active', on);
        other.setAttribute('aria-selected', String(on));
        $(other.dataset.tab).classList.toggle('is-hidden', !on);
      });
    });
  });

  bindChipGroup('aspectGroup', 'data-aspect', (value) => { edit.aspect = value; scheduleRefresh(); });
  bindChipGroup('fitChips', 'data-fit', (value) => { edit.fit = value; scheduleRefresh(); });
  $('cropPos').addEventListener('input', (event) => { edit.pos = clamp01(Number(event.target.value) / 100); scheduleRefresh(); });

  function setupTrimSliders() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    edit.trimStart = 0;
    edit.trimEnd = duration;
    ['trimStart', 'trimEnd'].forEach((id) => {
      const input = $(id);
      input.min = '0';
      input.max = String(duration);
      input.step = '0.1';
      input.disabled = duration < 1.2;
    });
    $('trimStart').value = '0';
    $('trimEnd').value = String(duration);
  }

  const trimGap = () => Math.min(1, Math.max(0.2, (Number.isFinite(video.duration) ? video.duration : 1) / 2));

  $('trimStart').addEventListener('input', (event) => {
    edit.trimStart = clamp(Number(event.target.value), 0, Math.max(0, edit.trimEnd - trimGap()));
    event.target.value = String(edit.trimStart);
    try { video.currentTime = edit.trimStart; } catch (error) { /* ignore */ }
    scheduleRefresh();
  });
  $('trimEnd').addEventListener('input', (event) => {
    const duration = Number.isFinite(video.duration) ? video.duration : edit.trimEnd;
    edit.trimEnd = clamp(Number(event.target.value), Math.min(duration, edit.trimStart + trimGap()), duration);
    event.target.value = String(edit.trimEnd);
    try { video.currentTime = Math.max(edit.trimStart, edit.trimEnd - 0.5); } catch (error) { /* ignore */ }
    scheduleRefresh();
  });

  $('textInput').addEventListener('input', (event) => { edit.text = event.target.value; scheduleRefresh(); });
  $('textSize').addEventListener('input', (event) => { edit.size = Number(event.target.value) / 100; scheduleRefresh(); });
  $('textY').addEventListener('input', (event) => { edit.textY = Number(event.target.value) / 100; scheduleRefresh(); });
  $('textBox').addEventListener('change', (event) => { edit.box = event.target.checked; scheduleRefresh(); });
  bindChipGroup('colorGroup', 'data-color', (value) => { edit.color = value; scheduleRefresh(); });
  bindChipGroup('textPosGroup', 'data-ypos', (value) => {
    edit.textY = Number(value) / 100;
    $('textY').value = String(Math.round(edit.textY * 100));
    scheduleRefresh();
  });

  $('musicInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(file.name)) {
      toast('Please choose an audio file (MP3, M4A, WAV).');
      return;
    }
    setMusic(file);
    scheduleRefresh();
  });
  $('musicRemove').addEventListener('click', () => { setMusic(null); $('musicInput').value = ''; scheduleRefresh(); });
  bindChipGroup('musicModeGroup', 'data-music-mode', (value) => {
    edit.musicMode = value;
    if (musicEl) video.muted = value === 'replace';
  });
  $('musicVol').addEventListener('input', (event) => {
    edit.musicVol = Number(event.target.value) / 100;
    if (musicEl) musicEl.volume = clamp01(edit.musicVol);
  });

  $('captionInput').addEventListener('input', (event) => { edit.caption = event.target.value; });
  $('copyCaptionBtn').addEventListener('click', () => copyText(edit.caption));
  $('qualitySelect').addEventListener('change', scheduleRefresh);

  function resetEditorUI() {
    edit = defaults();
    setMusic(null);
    $('musicInput').value = '';
    setChipGroup($('aspectGroup'), 'data-aspect', 'orig');
    setChipGroup($('fitChips'), 'data-fit', 'fill');
    setChipGroup($('colorGroup'), 'data-color', '#ffffff');
    setChipGroup($('musicModeGroup'), 'data-music-mode', 'mix');
    setChipGroup($('textPosGroup'), 'data-ypos', '78');
    $('cropPos').value = '50';
    $('textInput').value = '';
    $('textSize').value = '8';
    $('textY').value = '78';
    $('textBox').checked = false;
    $('musicVol').value = '70';
    $('captionInput').value = '';
  }

  /* ----------------------------- Video flow -------------------------- */

  $('videoInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) return toast('Please choose a valid video file.');
    videoFile = file;
    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = URL.createObjectURL(file);
    resetEditorUI();
    video.onloadedmetadata = () => {
      setupTrimSliders();
      $('videoMeta').textContent = `${formatSize(file.size)} • ${formatTime(video.duration)} • ${video.videoWidth}×${video.videoHeight}`;
      refresh();
    };
    video.onerror = () => toast('This browser cannot read that video. Try another file or use Safari.');
    video.src = videoURL;
    bgVideo.src = videoURL;
    bgVideo.muted = true;
    $('videoName').textContent = file.name;
    $('videoMeta').textContent = formatSize(file.size);
    $('videoInfo').classList.remove('is-hidden');
    $('videoResults').classList.add('is-hidden');
    $('videoProgress').classList.add('is-hidden');
    outputFiles = [];
  });

  /* Gives the worker access to a file, without copying it when the engine supports that. */
  async function attachFile(dir, name, file, attached) {
    const renamed = new File([file], name, { type: file.type || 'application/octet-stream' });
    try {
      await engineCall('mount', { dir, file: renamed }, { timeout: 30000, timeoutMessage: 'Reading the file timed out.' });
      attached.push({ dir, path: `${dir}/${name}` });
      return `${dir}/${name}`;
    } catch (mountError) {
      if (!engine.worker) throw mountError;
      console.warn('[STATUS SAFI] Direct file access unavailable, copying into memory.', mountError);
      const bytes = new Uint8Array(await file.arrayBuffer());
      await engineCall('write', { path: name, data: bytes }, { transfer: [bytes.buffer] });
      attached.push({ dir: null, path: name });
      return name;
    }
  }

  async function transcodeParts(file) {
    await ensureEngine();

    const src = currentSrc();
    if (!src) throw new Error('The video size could not be read.');
    const quality = currentQuality();
    const out = computeOutput(src, edit, quality);
    const total = trimLength();
    const partCount = partCountFor(total);
    const baseName = safeName(file.name);
    const attached = [];
    const results = [];

    setProgress(0, 'Step 2 of 2: Reading your video…', 'Preparing the original file for processing.');
    try {
      const inputPath = await attachFile(INPUT_DIR, INPUT_NAME, file, attached);

      let overlayPath = null;
      if (edit.text.trim()) {
        const canvas = document.createElement('canvas');
        if (drawTextOverlay(canvas, out.W, out.H)) {
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          if (!blob) throw new Error('The text could not be prepared.');
          const bytes = new Uint8Array(await blob.arrayBuffer());
          await engineCall('write', { path: OVERLAY_NAME, data: bytes }, { transfer: [bytes.buffer] });
          attached.push({ dir: null, path: OVERLAY_NAME });
          overlayPath = OVERLAY_NAME;
        }
      }

      let musicPath = null;
      if (edit.musicFile) musicPath = await attachFile(MUSIC_DIR, MUSIC_NAME, edit.musicFile, attached);

      /* Look at the file first: frame rate and whether it has sound. */
      let probeText = '';
      engine.onLog = (line) => { probeText += `${line}\n`; };
      try {
        await engineCall('exec', { args: ['-i', inputPath] }, { timeout: 60000, timeoutMessage: 'Reading the video details timed out.' });
      } catch (probeError) {
        if (!engine.worker) throw probeError;
      }
      engine.onLog = null;
      const info = parseProbe(probeText);

      for (let index = 0; index < partCount; index++) {
        const offset = index * PART_SECONDS;
        const start = edit.trimStart + offset;
        const length = Math.min(PART_SECONDS, edit.trimEnd - start);
        const outputName = `${baseName}_part_${String(index + 1).padStart(2, '0')}.mp4`;
        const label = partCount > 1
          ? `Step 2 of 2: Optimizing part ${index + 1} of ${partCount}`
          : 'Step 2 of 2: Optimizing video';
        const hint = 'Large videos can take several minutes. Keep this page open and your screen on.';

        let fraction = 0;
        const report = () => setProgress(((index + Math.min(fraction, 0.99)) / partCount) * 100, label, hint);
        engine.onProgress = ({ progress, time }) => {
          const fromTime = Number.isFinite(time) && time > 0 ? time / 1e6 / length : null;
          fraction = Math.max(fraction, clamp01(fromTime !== null ? fromTime : progress));
          report();
        };
        engine.onLog = (line) => {
          const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line || '');
          if (!match) return;
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          fraction = Math.max(fraction, clamp01(seconds / length));
          report();
        };
        report();

        const musicLength = edit.musicDuration;
        const args = buildArgs({
          inputPath, outputName, out, quality, start, length,
          fps: info.fps,
          hasAudio: info.hasAudio !== false,
          overlayPath,
          music: musicPath ? {
            path: musicPath,
            mode: edit.musicMode,
            volume: clamp01(edit.musicVol),
            offset: Number.isFinite(musicLength) && musicLength > 0 ? offset % musicLength : 0
          } : null
        });

        engine.recentLogs = [];
        const code = await engineCall('exec', { args });
        if (typeof code === 'number' && code !== 0) {
          const failure = new Error(`The video could not be converted (code ${code}).`);
          failure.logs = engine.recentLogs.slice(-3);
          throw failure;
        }
        const { data } = await engineCall('read', { path: outputName });
        await engineCall('remove', { path: outputName });

        const blob = new Blob([data], { type: 'video/mp4' });
        results.push({ name: outputName, file: new File([blob], outputName, { type: 'video/mp4' }), size: blob.size });
        setProgress(((index + 1) / partCount) * 100, label, hint);
      }
    } finally {
      engine.onProgress = null;
      engine.onLog = null;
      for (const item of attached) {
        try {
          if (item.dir) await engineCall('cleanup', { dir: item.dir, path: item.path }, { timeout: 10000 });
          else await engineCall('remove', { path: item.path }, { timeout: 10000 });
        } catch (cleanupError) { /* not critical */ }
      }
    }
    return results;
  }

  function saveFile(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function renderVideoResults(items) {
    const list = $('videoDownloads');
    list.innerHTML = '';
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'download-item';

      const info = document.createElement('div');
      info.className = 'download-info';
      const name = document.createElement('b');
      name.textContent = items.length > 1 ? `Part ${index + 1} of ${items.length}` : 'Your video';
      const meta = document.createElement('small');
      meta.textContent = `${item.name} • ${formatSize(item.size)}`;
      info.append(name, meta);

      const actions = document.createElement('div');
      actions.className = 'download-actions';
      const share = document.createElement('button');
      share.type = 'button';
      share.className = 'chip-button';
      share.textContent = 'Share';
      share.addEventListener('click', () => shareFiles([item.file], edit.caption));
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'chip-button ghost';
      save.textContent = 'Save';
      save.addEventListener('click', () => saveFile(item.file));
      actions.append(share, save);

      row.append(info, actions);
      list.append(row);
    });
    $('resultCaptionRow').classList.toggle('is-hidden', !edit.caption.trim());
  }

  async function shareFiles(files, text) {
    if (!navigator.share || !navigator.canShare || !navigator.canShare({ files })) {
      toast('Sharing is not supported in this browser. Use Save, or open this page in Safari (iPhone) or Chrome (Android).');
      return false;
    }
    const data = { files };
    if (text && text.trim()) data.text = text.trim();
    try {
      await navigator.share(data);
      return true;
    } catch (error) {
      if (error && error.name !== 'AbortError') toast('Could not open the share menu. Please try again.');
      return false;
    }
  }

  function describeError(error) {
    const raw = String((error && error.message) || error || 'Unknown error');
    const logs = error && error.logs && error.logs.length
      ? ` | ${error.logs.slice(-2).map((line) => String(line).trim().slice(0, 120)).join(' / ')}`
      : '';
    let friendly;
    if (/download|stalled|network|failed to fetch|load failed|http \d/i.test(raw)) {
      friendly = 'The video engine could not be downloaded. Check your internet connection and try again.';
    } else if (/memory|allocate|out of bounds|aborted|oom/i.test(raw)) {
      friendly = 'Your device ran out of memory. Try a shorter or smaller video, choose "Fast", close other apps and try again.';
    } else if (/worker|did not start|not compatible|initialise|workerfs/i.test(raw)) {
      friendly = 'The video engine could not start in this browser. Update your browser (on iPhone use Safari) and try again.';
    } else if (/could not be converted/i.test(raw)) {
      friendly = 'The video could not be converted. Try again without music or text, or choose another video.';
    } else {
      friendly = 'Something went wrong while preparing the video. Please try again.';
    }
    return { friendly, detail: `${raw}${logs}`.slice(0, 300) };
  }

  async function runVideo() {
    if (processing) return;
    if (!videoFile) return toast('Please choose a video first.');
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      return toast('The video length could not be read. Please choose another video.');
    }
    if (trimLength() < 0.3) return toast('The selected part is too short. Move the trim handles apart.');
    if (videoFile.size > MAX_VIDEO_BYTES) {
      return toast('This video is too large for reliable processing on a phone. Please choose a smaller file.');
    }
    const button = $('processVideoBtn');
    processing = true;
    video.pause();
    button.disabled = true;
    button.textContent = 'Processing…';
    $('videoProgress').classList.remove('is-hidden', 'is-error');
    $('videoResults').classList.add('is-hidden');
    outputFiles = [];
    startTicker();
    keepAwake(true);
    setProgress(0, 'Getting ready…', 'The first run downloads the video engine. Keep this page open.');
    $('videoProgress').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      outputFiles = await transcodeParts(videoFile);
      stopTicker();
      renderVideoResults(outputFiles);
      $('videoResults').classList.remove('is-hidden');
      setProgress(100, 'Completed successfully', 'Your video is ready. Share each part to WhatsApp in order.');
      toast(outputFiles.length > 1 ? `Done. Your video was split into ${outputFiles.length} parts.` : 'Done. Your video is ready to share.');
      $('videoResults').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      console.error(error);
      stopTicker();
      const { friendly, detail } = describeError(error);
      $('videoProgress').classList.add('is-error');
      setProgress(0, 'Could not prepare the video', `${friendly} (Details: ${detail})`);
      toast(friendly);
    } finally {
      processing = false;
      stopTicker();
      keepAwake(false);
      button.disabled = false;
      button.textContent = 'Prepare video';
    }
  }

  $('processVideoBtn').addEventListener('click', runVideo);
  $('shareAllVideosBtn').addEventListener('click', () => shareFiles(outputFiles.map((item) => item.file), edit.caption));
  $('copyResultCaptionBtn').addEventListener('click', () => copyText(edit.caption));

  /* ----------------------------- Photo flow -------------------------- */

  $('photoInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Please choose a valid image file.');
    photoFile = file;
    if (photoURL) URL.revokeObjectURL(photoURL);
    photoURL = URL.createObjectURL(file);
    $('photoPreview').src = photoURL;
    $('photoName').textContent = file.name;
    $('photoMeta').textContent = formatSize(file.size);
    $('photoInfo').classList.remove('is-hidden');
  });

  $('copyPhotoCaptionBtn').addEventListener('click', () => copyText($('photoCaption').value));
  $('processPhotoBtn').addEventListener('click', async () => {
    if (!photoFile) return toast('Please choose a photo first.');
    await shareFiles([photoFile], $('photoCaption').value);
  });

  /* ------------------------------ Splash ----------------------------- */

  (() => {
    const splash = $('splash');
    if (!splash) return;
    const hide = () => { if (splash.parentNode) splash.remove(); };
    splash.addEventListener('animationend', hide);
    window.setTimeout(hide, 2600);
  })();
})();
