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
  const WM_NAME = 'wm.png';
  const FRAME_NAME = 'frame.png';
  const NUMBER_KEY = 'statusSafiNumber';
  const FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Color Emoji", sans-serif';
  const EMOJIS = ['😂', '🤣', '😍', '🥰', '😎', '🤩', '😭', '🥳', '😘', '😅', '🙏', '👏', '🙌', '💪', '👍', '🤝', '❤️', '💯', '🔥', '✨', '🌟', '🎉', '🎶', '💥', '🏆', '⚽', '🚀', '☀️', '🌙', '🌸', '🇹🇿', '😉'];

  /* @pure-start  (no DOM access in this block: it is unit-tested with a real ffmpeg) */

  const PART_SECONDS = 60;
  const PHOTO_MIN_SECONDS = 3;
  const PHOTO_MAX_SECONDS = 30;
  const PHOTO_DEFAULT_SECONDS = 7;
  const WATERMARK_TEXT = 'STATUS SAFI';

  /* `short` is the length of the output's shorter side in pixels.
     "ultrafast" is used everywhere: WhatsApp compresses a Status again anyway, and
     in a single-thread WebAssembly encoder the slower presets only cost minutes. */
  const QUALITY = {
    hd:   { short: 720,  crf: 22, maxrate: '4M', bufsize: '8M',  preset: 'ultrafast' },
    fast: { short: 540,  crf: 25, maxrate: '2M', bufsize: '4M',  preset: 'ultrafast' },
    max:  { short: 1080, crf: 21, maxrate: '8M', bufsize: '16M', preset: 'ultrafast' }
  };
  /* A photo becomes a still video: the frame is drawn once, so a larger size costs almost nothing. */
  const PHOTO_QUALITY = { short: 1080, crf: 20, preset: 'ultrafast' };
  const ASPECTS = { orig: 0, '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1 };
  const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

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

  /* Size and margins of the small "STATUS SAFI" mark. It sits at the bottom right, a little above
     the very edge so that WhatsApp's own reply bar does not cover it. */
  function watermarkMetrics(W, H) {
    const base = Math.min(W, H);
    const fs = Math.max(14, Math.round(base * 0.034));
    return {
      fs,
      padX: Math.round(fs * 0.62),
      padY: Math.round(fs * 0.36),
      marginR: Math.round(W * 0.035),
      marginB: Math.round(H * (H > W ? 0.07 : 0.045))
    };
  }

  function watermarkPos(W, H, w, h) {
    const m = watermarkMetrics(W, H);
    const even = (n) => Math.max(0, Math.floor(n / 2) * 2);
    return { x: even(W - w - m.marginR), y: even(H - h - m.marginB) };
  }

  /* Where in the song the audio must start for a part of the video that begins `partOffset` seconds in. */
  function musicOffsetFor(startAt, partOffset, songLength) {
    const t = Math.max(0, startAt) + partOffset;
    return Number.isFinite(songLength) && songLength > 0 ? t % songLength : t;
  }

  /* The sound track: the song (starting at music.offset, looped), optionally mixed with the video's own sound. */
  function songChain(idx, music) {
    const trim = music.offset > 0.01 ? `atrim=start=${fmtSec(music.offset)},asetpts=PTS-STARTPTS,` : '';
    return `[${idx}:a]${trim}${AUDIO_FORMAT},volume=${fmtNum(music.volume)}`;
  }

  /* Builds the complete ffmpeg argument list for one part of a video. */
  function buildArgs(p) {
    const { out, quality } = p;
    const args = ['-ss', fmtSec(p.start), '-i', p.inputPath];
    let next = 1;
    let overlayIdx = -1;
    let wmIdx = -1;
    let musicIdx = -1;
    if (p.overlayPath) { args.push('-i', p.overlayPath); overlayIdx = next++; }
    if (p.wm) { args.push('-i', p.wm.path); wmIdx = next++; }
    if (p.music) { args.push('-stream_loop', '-1', '-i', p.music.path); musicIdx = next++; }

    const fps = p.fps > 31 ? 'fps=30,' : '';
    const chains = [];
    if (out.fit) {
      const bw = evenRound(out.W / 8);
      const bh = evenRound(out.H / 8);
      chains.push(`[0:v]${fps}split=2[a][b]`);
      chains.push(`[a]scale=${bw}:${bh}:flags=bilinear:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=3:2,scale=${out.W}:${out.H}:flags=bilinear[bg]`);
      chains.push(`[b]scale=${out.W}:${out.H}:flags=bilinear:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]`);
      chains.push('[bg][fg]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,setsar=1[v0]');
    } else {
      const c = out.crop;
      const cropFilter = out.cropped ? `crop=${c.w}:${c.h}:${c.x}:${c.y},` : '';
      chains.push(`[0:v]${fps}${cropFilter}scale=${out.W}:${out.H}:flags=bilinear,setsar=1[v0]`);
    }
    let last = 'v0';
    if (overlayIdx >= 0) {
      chains.push(`[${last}][${overlayIdx}:v]overlay=0:0:format=auto[v1]`);
      last = 'v1';
    }
    if (wmIdx >= 0) {
      chains.push(`[${last}][${wmIdx}:v]overlay=${p.wm.x}:${p.wm.y}:format=auto[v2]`);
      last = 'v2';
    }
    chains.push(`[${last}]format=yuv420p[v]`);

    const maps = ['-map', '[v]'];
    if (p.music) {
      const fade = p.fadeOut && p.length > 1.5 ? `,afade=t=out:st=${fmtSec(p.length - 0.7)}:d=0.7` : '';
      if (p.music.mode === 'mix' && p.hasAudio) {
        chains.push(`[0:a]${AUDIO_FORMAT}[oa]`);
        chains.push(`${songChain(musicIdx, p.music)}[ma]`);
        chains.push(`[oa][ma]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95${fade}[a]`);
      } else {
        chains.push(`${songChain(musicIdx, p.music)}${fade}[a]`);
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

  /* A photo (already drawn at its final size, with text, stickers and mark) becomes a still video. */
  function buildPhotoArgs(p) {
    const fps = 30;
    const args = ['-loop', '1', '-framerate', String(fps), '-t', fmtSec(p.length), '-i', p.framePath];
    const chains = ['[0:v]scale=out_color_matrix=bt709:out_range=tv:flags=bicubic,format=yuv420p[v]'];
    const maps = ['-map', '[v]'];
    if (p.music) {
      args.push('-stream_loop', '-1', '-i', p.music.path);
      const fade = p.length > 1.5 ? `,afade=t=out:st=${fmtSec(p.length - 0.7)}:d=0.7` : '';
      chains.push(`${songChain(1, p.music)}${fade}[a]`);
      maps.push('-map', '[a]');
    }
    args.push(
      '-filter_complex', chains.join(';'),
      ...maps,
      '-c:v', 'libx264', '-preset', p.quality.preset, '-tune', 'stillimage', '-crf', String(p.quality.crf),
      '-r', String(fps), '-pix_fmt', 'yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
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
  const photoEl = $('photoPreview');
  const photoBg = $('photoBg');
  const overlay = $('overlayCanvas');
  const stage = $('stage');

  let kind = 'video';
  let mediaFile = null;
  let mediaURL = null;
  let src = null;
  let edit = null;
  let selectedId = null;
  let activeTool = null;
  let outputFiles = [];
  let returnPage = 'homePage';
  let toastTimer = null;
  let wakeLock = null;
  let processing = false;
  let refreshQueued = false;
  let musicEl = null;
  let musicURL = null;
  let peaks = null;
  let playing = false;
  let photoRel = 0;
  let photoT0 = 0;
  let rafId = 0;
  let snippetTimer = 0;
  let stageRatio = 9 / 16;

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
    toast('Choose a video or photo and edit it. When it is ready, send it to your own WhatsApp chat (You), then forward it to My Status. Your files are processed on your device and never uploaded.', 9000));

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

  const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

  /* ------------------- Overlay: text, stickers and the mark ---------- */

  const selectedItem = () => (edit ? edit.items.find((item) => item.id === selectedId) || null : null);

  function measureItem(ctx, item, W) {
    const px = Math.max(8, Math.round(W * item.size));
    if (item.type === 'emoji') {
      ctx.font = `${px}px ${FONT_STACK}`;
      const side = Math.round(px * 1.2);
      return { px, w: side, h: side };
    }
    ctx.font = `800 ${px}px ${FONT_STACK}`;
    const lines = wrapLines(ctx, item.text || ' ', W * 0.84);
    const lineHeight = Math.round(px * 1.28);
    const widest = Math.max(px * 0.6, ...lines.map((line) => ctx.measureText(line).width));
    const padX = item.box ? px * 0.45 : px * 0.15;
    const padY = item.box ? px * 0.3 : px * 0.1;
    return { px, lines, lineHeight, w: Math.min(W, widest + padX * 2), h: lines.length * lineHeight + padY * 2 };
  }

  function drawItem(ctx, item, W, H) {
    const m = measureItem(ctx, item, W);
    const cx = m.w >= W ? W / 2 : clamp(item.x * W, m.w / 2, W - m.w / 2);
    const cy = m.h >= H ? H / 2 : clamp(item.y * H, m.h / 2, H - m.h / 2);
    item._box = { x: cx - m.w / 2, y: cy - m.h / 2, w: m.w, h: m.h };
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (item.type === 'emoji') {
      ctx.font = `${m.px}px ${FONT_STACK}`;
      ctx.fillText(item.text, cx, cy + m.px * 0.04);
      ctx.restore();
      return;
    }
    ctx.font = `800 ${m.px}px ${FONT_STACK}`;
    const dark = item.color.toLowerCase() === '#000000';
    if (item.box) {
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.62)';
      roundedRect(ctx, item._box.x, item._box.y, item._box.w, item._box.h, m.px * 0.4);
      ctx.fill();
    } else {
      ctx.shadowColor = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = m.px * 0.2;
      ctx.shadowOffsetY = m.px * 0.05;
    }
    ctx.fillStyle = item.color;
    const top = cy - (m.lines.length * m.lineHeight) / 2;
    m.lines.forEach((line, index) => ctx.fillText(line, cx, top + m.lineHeight * (index + 0.5)));
    ctx.restore();
  }

  function drawItems(ctx, W, H, withSelection) {
    edit.items.forEach((item) => drawItem(ctx, item, W, H));
    const item = withSelection ? selectedItem() : null;
    if (item && item._box) {
      const pad = Math.round(W * 0.012);
      const b = item._box;
      ctx.save();
      ctx.lineWidth = Math.max(3, W * 0.005);
      ctx.setLineDash([W * 0.02, W * 0.014]);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeRect(b.x - pad + 1.5, b.y - pad + 1.5, b.w + pad * 2, b.h + pad * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      ctx.restore();
    }
  }

  function measureWatermark(ctx, W, H) {
    const m = watermarkMetrics(W, H);
    ctx.font = `800 ${m.fs}px ${FONT_STACK}`;
    const first = ctx.measureText('STATUS ').width;
    const second = ctx.measureText('SAFI').width;
    return { m, first, w: Math.round(first + second + m.padX * 2), h: Math.round(m.fs + m.padY * 2) };
  }

  function paintWatermark(ctx, x, y, size) {
    const { m, first, w, h } = size;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    roundedRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.font = `800 ${m.fs}px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = m.fs * 0.15;
    const ty = y + h / 2 + m.fs * 0.04;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('STATUS ', x + m.padX, ty);
    ctx.fillStyle = '#8de6b3';
    ctx.fillText('SAFI', x + m.padX + first, ty);
    ctx.restore();
  }

  function drawWatermark(ctx, W, H) {
    const size = measureWatermark(ctx, W, H);
    const pos = watermarkPos(W, H, size.w, size.h);
    paintWatermark(ctx, pos.x, pos.y, size);
  }

  /* The mark as its own small picture: cheap for the video engine to place on every frame. */
  async function watermarkPNG(W, H) {
    const size = measureWatermark(document.createElement('canvas').getContext('2d'), W, H);
    const pos = watermarkPos(W, H, size.w, size.h);
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    paintWatermark(canvas.getContext('2d'), 0, 0, size);
    return { blob: await toBlob(canvas), x: pos.x, y: pos.y };
  }

  /* Text and stickers as a full-size transparent picture (null when there are none). */
  async function overlayPNG(W, H) {
    if (!edit.items.length) return null;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    drawItems(canvas.getContext('2d'), W, H, false);
    return toBlob(canvas);
  }

  function drawPreviewOverlay(out) {
    if (overlay.width !== out.W || overlay.height !== out.H) {
      overlay.width = out.W;
      overlay.height = out.H;
    }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, out.W, out.H);
    drawItems(ctx, out.W, out.H, true);
    drawWatermark(ctx, out.W, out.H);
  }

  /* A photo drawn exactly as it will appear in the video (crop or blurred sides, text, stickers, mark). */
  async function composePhotoFrame(out) {
    const canvas = document.createElement('canvas');
    canvas.width = out.W;
    canvas.height = out.H;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (out.fit) {
      const tiny = document.createElement('canvas');
      tiny.width = Math.max(16, Math.round(out.W / 12));
      tiny.height = Math.max(16, Math.round(out.H / 12));
      const tctx = tiny.getContext('2d');
      const cover = Math.max(tiny.width / src.w, tiny.height / src.h);
      const cw = src.w * cover;
      const ch = src.h * cover;
      tctx.drawImage(photoEl, (tiny.width - cw) / 2, (tiny.height - ch) / 2, cw, ch);
      ctx.drawImage(tiny, 0, 0, out.W, out.H);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(0, 0, out.W, out.H);
      const s = Math.min(out.W / src.w, out.H / src.h);
      const dw = Math.round(src.w * s);
      const dh = Math.round(src.h * s);
      ctx.drawImage(photoEl, Math.round((out.W - dw) / 2), Math.round((out.H - dh) / 2), dw, dh);
    } else {
      const c = out.crop;
      ctx.drawImage(photoEl, c.x, c.y, c.w, c.h, 0, 0, out.W, out.H);
    }
    drawItems(ctx, out.W, out.H, false);
    drawWatermark(ctx, out.W, out.H);
    return toBlob(canvas);
  }

  /* ----------------------------- Editor state ------------------------ */

  const defaults = (mediaKind) => ({
    aspect: mediaKind === 'photo' ? '9:16' : 'orig',
    fit: mediaKind === 'photo' ? 'fit' : 'fill',
    pos: 0.5,
    trimStart: 0,
    trimEnd: 0,
    items: [],
    nextId: 1,
    musicFile: null,
    musicDuration: NaN,
    musicStart: 0,
    musicMode: 'mix',
    musicVol: 0.7,
    caption: '',
    quality: 'hd'
  });

  const currentQuality = () => (kind === 'photo' ? PHOTO_QUALITY : QUALITY[edit.quality] || QUALITY.hd);
  const trimLength = () => Math.max(0, edit.trimEnd - edit.trimStart);
  const partCountFor = (length) => Math.max(1, Math.ceil((length - 0.25) / PART_SECONDS));

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

  function layoutStage() {
    const wrap = $('stageWrap');
    const style = getComputedStyle(wrap);
    const availW = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const availH = wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (availW <= 0 || availH <= 0) return;
    const w = Math.min(availW, availH * stageRatio);
    stage.style.width = `${Math.floor(w)}px`;
    stage.style.height = `${Math.floor(w / stageRatio)}px`;
  }

  function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshQueued = false; refresh(); });
  }

  function updateDual() {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    $('dual').style.setProperty('--a', `${(edit.trimStart / duration) * 100}%`);
    $('dual').style.setProperty('--b', `${(edit.trimEnd / duration) * 100}%`);
  }

  function refresh() {
    if (!src || !edit) return;
    const out = computeOutput(src, edit, currentQuality());
    stageRatio = targetAspect(src, edit);
    const media = kind === 'photo' ? photoEl : video;
    const bg = kind === 'photo' ? photoBg : bgVideo;
    media.style.objectFit = out.fit || edit.aspect === 'orig' ? 'contain' : 'cover';
    const horizontal = src.w / src.h > stageRatio;
    media.style.objectPosition = horizontal ? `${edit.pos * 100}% 50%` : `50% ${edit.pos * 100}%`;
    bg.classList.toggle('is-hidden', !out.fit);
    if (out.fit && kind === 'video') syncBackground();

    $('fitGroup').classList.toggle('is-hidden', edit.aspect === 'orig');
    $('posGroup').classList.toggle('is-hidden', edit.aspect === 'orig' || out.fit || !out.cropped);
    $('posAxis').textContent = horizontal ? '(left / right)' : '(up / down)';

    layoutStage();
    drawPreviewOverlay(out);

    const length = trimLength();
    const parts = kind === 'video' ? partCountFor(length) : 1;
    $('trimStartLabel').textContent = formatTimeTenths(edit.trimStart);
    $('trimEndLabel').textContent = formatTimeTenths(edit.trimEnd);
    $('trimSummary').textContent = `Selected length: ${formatTime(length)}${length > PART_SECONDS ? ` (${parts} parts of up to 60 s)` : ''}`;
    $('photoLenLabel').textContent = `${Math.round(length)} s`;
    $('edTotal').textContent = formatTime(length);
    const scrub = $('edScrub');
    if (scrub.max !== String(length)) scrub.max = String(length);
    updateDual();
    updatePlayerUI();
    drawWaveform();
  }

  /* ------------------------------- Playback -------------------------- */

  function relTime() {
    if (!edit) return 0;
    if (kind === 'photo') return clamp(photoRel, 0, trimLength());
    return clamp(video.currentTime - edit.trimStart, 0, trimLength());
  }

  function setPlayIcon(isPlaying) {
    $('iconPlay').classList.toggle('is-hidden', isPlaying);
    $('iconPause').classList.toggle('is-hidden', !isPlaying);
    $('edPlay').setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  }

  function updatePlayerUI() {
    const rel = relTime();
    $('edScrub').value = String(rel);
    $('edTime').textContent = formatTime(rel);
  }

  function syncBackground() {
    if (kind !== 'video' || !bgVideo.src) return;
    try {
      if (Math.abs(bgVideo.currentTime - video.currentTime) > 0.3) bgVideo.currentTime = video.currentTime;
      if (video.paused) bgVideo.pause(); else bgVideo.play().catch(() => {});
    } catch (error) { /* cosmetic only */ }
  }

  function syncMusic(play) {
    if (!musicEl) return;
    musicEl.volume = clamp01(edit.musicVol);
    if (kind === 'video') video.muted = edit.musicMode === 'replace';
    if (!play) { musicEl.pause(); return; }
    try { musicEl.currentTime = musicOffsetFor(edit.musicStart, relTime(), edit.musicDuration); } catch (error) { /* not seekable yet */ }
    const started = musicEl.play();
    if (started && started.catch) started.catch(() => {});
  }

  function tick() {
    if (!playing) return;
    if (kind === 'photo') photoRel = (performance.now() - photoT0) / 1000;
    if (relTime() >= trimLength() - 0.03 || (kind === 'video' && video.ended)) { stopPlayback(true); return; }
    updatePlayerUI();
    rafId = requestAnimationFrame(tick);
  }

  function startPlayback() {
    if (!src || !edit) return;
    clearTimeout(snippetTimer);
    let rel = relTime();
    /* Near the end (for example right after moving the end handle): start again from the beginning. */
    if (trimLength() - rel < Math.min(1, trimLength() / 2)) rel = 0;
    playing = true;
    if (kind === 'video') {
      try { video.currentTime = edit.trimStart + rel; } catch (error) { /* ignore */ }
      video.muted = !!musicEl && edit.musicMode === 'replace';
      const started = video.play();
      if (started && started.catch) started.catch(() => { playing = false; setPlayIcon(false); });
    } else {
      photoRel = rel;
      photoT0 = performance.now() - rel * 1000;
    }
    syncMusic(true);
    syncBackground();
    setPlayIcon(true);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function stopPlayback(rewind) {
    playing = false;
    cancelAnimationFrame(rafId);
    if (!edit) return;
    if (kind === 'video') {
      video.pause();
      if (rewind) { try { video.currentTime = edit.trimStart; } catch (error) { /* ignore */ } }
    } else if (rewind) {
      photoRel = 0;
    }
    if (musicEl) musicEl.pause();
    syncBackground();
    setPlayIcon(false);
    updatePlayerUI();
  }

  function seekTo(rel) {
    const t = clamp(rel, 0, trimLength());
    if (kind === 'video') {
      try { video.currentTime = edit.trimStart + t; } catch (error) { /* ignore */ }
    } else {
      photoRel = t;
      if (playing) photoT0 = performance.now() - t * 1000;
    }
    syncBackground();
    if (playing) syncMusic(true);
    updatePlayerUI();
  }

  $('edPlay').addEventListener('click', () => { if (playing) stopPlayback(false); else startPlayback(); });
  $('edScrub').addEventListener('input', (event) => seekTo(Number(event.target.value)));
  video.addEventListener('ended', () => { if (playing) stopPlayback(true); });

  /* ------------------------------- Music ----------------------------- */

  function playSnippet() {
    if (!musicEl || playing) return;
    musicEl.volume = clamp01(edit.musicVol);
    try { musicEl.currentTime = edit.musicStart; } catch (error) { /* ignore */ }
    const started = musicEl.play();
    if (started && started.catch) started.catch(() => {});
    clearTimeout(snippetTimer);
    snippetTimer = setTimeout(() => { if (!playing && musicEl) musicEl.pause(); }, 3000);
  }

  function setMusicStart(seconds) {
    const length = edit.musicDuration;
    const max = Number.isFinite(length) ? Math.max(0, length - 0.5) : 0;
    edit.musicStart = clamp(seconds, 0, max);
    $('musicStart').value = String(edit.musicStart);
    $('musicStartLabel').textContent = formatTimeTenths(edit.musicStart);
    drawWaveform();
    if (playing) syncMusic(true);
  }

  function drawWaveform() {
    const canvas = $('waveCanvas');
    if (!edit || !edit.musicFile || !canvas.clientWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const song = edit.musicDuration;
    const known = Number.isFinite(song) && song > 0;
    const from = known ? edit.musicStart / song : 0;
    const to = known ? Math.min(1, (edit.musicStart + trimLength()) / song) : 1;
    const wrapTo = known ? Math.min(1, Math.max(0, (edit.musicStart + trimLength()) / song - 1)) : 0;
    const bars = peaks ? peaks.length : 96;
    const barW = w / bars;
    for (let i = 0; i < bars; i++) {
      const pos = (i + 0.5) / bars;
      const inside = (pos >= from && pos <= to) || pos <= wrapTo;
      const amp = peaks ? Math.max(0.05, peaks[i]) : 0.22;
      const barH = Math.max(2 * dpr, amp * h * 0.92);
      ctx.fillStyle = inside ? '#7cffb2' : '#4b525e';
      ctx.fillRect(i * barW + barW * 0.18, (h - barH) / 2, Math.max(1, barW * 0.64), barH);
    }
  }

  /* A rough picture of the song. Decoded at a very low sample rate so it stays light on memory. */
  async function loadPeaks(file, element) {
    try {
      const AudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AudioCtx || file.size > 40 * 1024 * 1024) return;
      const data = await file.arrayBuffer();
      let context;
      try { context = new AudioCtx(1, 1, 8000); } catch (error) { context = new AudioCtx(1, 1, 22050); }
      const audio = await new Promise((resolve, reject) => {
        const result = context.decodeAudioData(data, resolve, reject);
        if (result && result.then) result.then(resolve, reject);
      });
      if (musicEl !== element) return;
      const samples = audio.getChannelData(0);
      const buckets = 160;
      const per = Math.max(1, Math.floor(samples.length / buckets));
      const found = new Float32Array(buckets);
      let loudest = 0;
      for (let b = 0; b < buckets; b++) {
        let peak = 0;
        const end = Math.min(samples.length, (b + 1) * per);
        for (let i = b * per; i < end; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
        found[b] = peak;
        if (peak > loudest) loudest = peak;
      }
      if (loudest > 0) for (let b = 0; b < buckets; b++) found[b] /= loudest;
      peaks = found;
      drawWaveform();
    } catch (error) {
      console.warn('[STATUS SAFI] Waveform not available, using the plain slider.', error);
    }
  }

  function setMusic(file) {
    if (musicEl) { musicEl.pause(); musicEl.removeAttribute('src'); musicEl.load(); }
    if (musicURL) URL.revokeObjectURL(musicURL);
    musicEl = null;
    musicURL = null;
    peaks = null;
    edit.musicFile = file || null;
    edit.musicDuration = NaN;
    edit.musicStart = 0;
    if (kind === 'video') video.muted = false;
    $('musicInfo').classList.toggle('is-hidden', !file);
    $('musicOptions').classList.toggle('is-hidden', !file);
    $('musicStart').max = '0';
    $('musicStart').value = '0';
    $('musicStart').disabled = true;
    $('musicStartLabel').textContent = '0:00.0';
    if (!file) { scheduleRefresh(); return; }
    $('musicName').textContent = `${file.name} • ${formatSize(file.size)}`;
    musicURL = URL.createObjectURL(file);
    const element = new Audio();
    element.preload = 'auto';
    element.loop = true;
    musicEl = element;
    element.onloadedmetadata = () => {
      if (musicEl !== element) return;
      edit.musicDuration = element.duration;
      const slider = $('musicStart');
      slider.max = String(Math.max(0, element.duration - 0.5));
      slider.step = '0.1';
      slider.disabled = !(element.duration > 1);
      scheduleRefresh();
    };
    element.onerror = () => {
      if (musicEl !== element) return;
      toast('This browser cannot read that audio file. Try an MP3, M4A or WAV saved in your Files app.');
      setMusic(null);
    };
    element.src = musicURL;
    if (kind === 'video') video.muted = edit.musicMode === 'replace';
    loadPeaks(file, element);
    scheduleRefresh();
  }

  $('musicInput').addEventListener('click', (event) => { event.target.value = ''; });
  $('musicInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(file.name)) {
      toast('Please choose an audio file (MP3, M4A, WAV).');
      return;
    }
    stopPlayback(false);
    setMusic(file);
  });
  $('musicRemove').addEventListener('click', () => { stopPlayback(false); setMusic(null); });
  bindChipGroup('musicModeGroup', 'data-music-mode', (value) => {
    edit.musicMode = value;
    if (musicEl && kind === 'video') video.muted = value === 'replace';
  });
  $('musicVol').addEventListener('input', (event) => {
    edit.musicVol = Number(event.target.value) / 100;
    if (musicEl) musicEl.volume = clamp01(edit.musicVol);
  });
  $('musicStart').addEventListener('input', (event) => setMusicStart(Number(event.target.value)));
  $('musicStart').addEventListener('change', playSnippet);

  const wave = $('waveCanvas');
  let waveDrag = false;
  const waveSeek = (event) => {
    if (!Number.isFinite(edit.musicDuration)) return;
    const rect = wave.getBoundingClientRect();
    setMusicStart(clamp((event.clientX - rect.left) / rect.width, 0, 1) * edit.musicDuration);
  };
  wave.addEventListener('pointerdown', (event) => {
    if (!edit.musicFile) return;
    waveDrag = true;
    wave.setPointerCapture(event.pointerId);
    waveSeek(event);
  });
  wave.addEventListener('pointermove', (event) => { if (waveDrag) waveSeek(event); });
  wave.addEventListener('pointerup', () => { if (waveDrag) { waveDrag = false; playSnippet(); } });
  wave.addEventListener('pointercancel', () => { waveDrag = false; });

  /* ------------------------ Crop, trim, quality, caption ------------- */

  bindChipGroup('aspectGroup', 'data-aspect', (value) => { edit.aspect = value; scheduleRefresh(); });
  bindChipGroup('fitChips', 'data-fit', (value) => { edit.fit = value; scheduleRefresh(); });
  bindChipGroup('qualityGroup', 'data-quality', (value) => { edit.quality = value; scheduleRefresh(); });
  $('cropPos').addEventListener('input', (event) => { edit.pos = clamp01(Number(event.target.value) / 100); scheduleRefresh(); });

  function setupTrim() {
    if (kind === 'photo') {
      edit.trimStart = 0;
      edit.trimEnd = PHOTO_DEFAULT_SECONDS;
      $('photoLen').value = String(PHOTO_DEFAULT_SECONDS);
      return;
    }
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
    stopPlayback(false);
    edit.trimStart = clamp(Number(event.target.value), 0, Math.max(0, edit.trimEnd - trimGap()));
    event.target.value = String(edit.trimStart);
    try { video.currentTime = edit.trimStart; } catch (error) { /* ignore */ }
    syncBackground();
    scheduleRefresh();
  });
  $('trimEnd').addEventListener('input', (event) => {
    stopPlayback(false);
    const duration = Number.isFinite(video.duration) ? video.duration : edit.trimEnd;
    edit.trimEnd = clamp(Number(event.target.value), Math.min(duration, edit.trimStart + trimGap()), duration);
    event.target.value = String(edit.trimEnd);
    try { video.currentTime = Math.max(edit.trimStart, edit.trimEnd - 0.5); } catch (error) { /* ignore */ }
    syncBackground();
    scheduleRefresh();
  });
  $('photoLen').addEventListener('input', (event) => {
    stopPlayback(false);
    edit.trimEnd = clamp(Number(event.target.value), PHOTO_MIN_SECONDS, PHOTO_MAX_SECONDS);
    scheduleRefresh();
  });

  $('captionInput').addEventListener('input', (event) => { edit.caption = event.target.value; });
  $('copyCaptionBtn').addEventListener('click', () => copyText(edit.caption));

  /* --------------------------- Text and stickers --------------------- */

  function syncItemControls() {
    const item = selectedItem();
    const isText = !!item && item.type === 'text';
    const isEmoji = !!item && item.type === 'emoji';
    $('textEdit').classList.toggle('is-hidden', !isText);
    $('stickerEdit').classList.toggle('is-hidden', !isEmoji);
    if (isText) {
      $('textInput').value = item.text;
      $('textBox').checked = item.box;
      $('textSize').value = String(Math.round(item.size * 100));
      setChipGroup($('colorGroup'), 'data-color', item.color);
    }
    if (isEmoji) $('stickerSize').value = String(Math.round(item.size * 100));
  }

  function select(id) {
    selectedId = id;
    syncItemControls();
    scheduleRefresh();
  }

  function addText() {
    const item = { id: edit.nextId++, type: 'text', text: 'Your text', color: '#ffffff', box: false, size: 0.08, x: 0.5, y: 0.74 };
    edit.items.push(item);
    select(item.id);
    const input = $('textInput');
    input.focus();
    input.select();
  }

  function addEmoji(emoji) {
    const count = edit.items.filter((item) => item.type === 'emoji').length;
    edit.items.push({ id: edit.nextId++, type: 'emoji', text: emoji, size: 0.22, x: 0.5, y: Math.min(0.85, 0.38 + (count % 4) * 0.07) });
    select(edit.items[edit.items.length - 1].id);
  }

  function removeSelected() {
    edit.items = edit.items.filter((item) => item.id !== selectedId);
    select(null);
  }

  const withText = (change) => {
    const item = selectedItem();
    if (item && item.type === 'text') { change(item); scheduleRefresh(); }
  };
  $('addTextBtn').addEventListener('click', addText);
  $('textInput').addEventListener('input', (event) => withText((item) => { item.text = event.target.value; }));
  $('textSize').addEventListener('input', (event) => withText((item) => { item.size = Number(event.target.value) / 100; }));
  $('textBox').addEventListener('change', (event) => withText((item) => { item.box = event.target.checked; }));
  bindChipGroup('colorGroup', 'data-color', (value) => withText((item) => { item.color = value; }));
  $('deleteTextBtn').addEventListener('click', removeSelected);
  $('stickerSize').addEventListener('input', (event) => {
    const item = selectedItem();
    if (item && item.type === 'emoji') { item.size = Number(event.target.value) / 100; scheduleRefresh(); }
  });
  $('deleteStickerBtn').addEventListener('click', removeSelected);

  EMOJIS.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emoji';
    button.textContent = emoji;
    button.setAttribute('aria-label', `Add sticker ${emoji}`);
    button.addEventListener('click', () => addEmoji(emoji));
    $('emojiGrid').append(button);
  });

  /* Drag text and stickers on the picture. */
  let drag = null;
  const toOutput = (event) => {
    const rect = overlay.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * overlay.width, y: ((event.clientY - rect.top) / rect.height) * overlay.height };
  };
  function hitTest(point) {
    const pad = overlay.width * 0.02;
    for (let i = edit.items.length - 1; i >= 0; i--) {
      const box = edit.items[i]._box;
      if (box && point.x >= box.x - pad && point.x <= box.x + box.w + pad && point.y >= box.y - pad && point.y <= box.y + box.h + pad) return edit.items[i];
    }
    return null;
  }
  overlay.addEventListener('pointerdown', (event) => {
    if (!edit) return;
    const point = toOutput(event);
    const hit = hitTest(point);
    if (!hit) { if (selectedId !== null) select(null); return; }
    event.preventDefault();
    overlay.setPointerCapture(event.pointerId);
    drag = { id: hit.id, dx: point.x - hit.x * overlay.width, dy: point.y - hit.y * overlay.height };
    if (activeTool !== (hit.type === 'text' ? 'text' : 'sticker')) showTool(hit.type === 'text' ? 'text' : 'sticker');
    select(hit.id);
  });
  overlay.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const item = edit.items.find((candidate) => candidate.id === drag.id);
    if (!item) return;
    const point = toOutput(event);
    item.x = clamp((point.x - drag.dx) / overlay.width, 0.02, 0.98);
    item.y = clamp((point.y - drag.dy) / overlay.height, 0.02, 0.98);
    scheduleRefresh();
  });
  overlay.addEventListener('pointerup', () => { drag = null; });
  overlay.addEventListener('pointercancel', () => { drag = null; });

  /* ------------------------------ Tools tray ------------------------- */

  function showTool(name) {
    activeTool = name;
    document.querySelectorAll('.ed-tool').forEach((button) => {
      const on = button.dataset.tool === name;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('.tool-panel').forEach((panel) => panel.classList.toggle('is-hidden', panel.dataset.panel !== name));
    $('edSheet').classList.toggle('is-hidden', !name);
    syncItemControls();
    layoutStage();
    if (name === 'music') requestAnimationFrame(drawWaveform);
  }

  document.querySelectorAll('.ed-tool').forEach((button) =>
    button.addEventListener('click', () => showTool(activeTool === button.dataset.tool ? null : button.dataset.tool)));

  const stageWrap = $('stageWrap');
  if (window.ResizeObserver) new ResizeObserver(() => { layoutStage(); drawWaveform(); }).observe(stageWrap);
  window.addEventListener('resize', () => { layoutStage(); drawWaveform(); });

  /* ---------------------------- Open and close ----------------------- */

  function resetControls() {
    setChipGroup($('aspectGroup'), 'data-aspect', edit.aspect);
    setChipGroup($('fitChips'), 'data-fit', edit.fit);
    setChipGroup($('musicModeGroup'), 'data-music-mode', edit.musicMode);
    setChipGroup($('qualityGroup'), 'data-quality', edit.quality);
    $('cropPos').value = '50';
    $('musicVol').value = '70';
    $('captionInput').value = '';
    $('textInput').value = '';
    $('musicInput').value = '';
  }

  function showEditor() {
    $('editor').classList.remove('is-hidden');
    document.body.classList.add('editor-open');
    requestAnimationFrame(() => { layoutStage(); refresh(); });
  }

  function hideEditor() {
    stopPlayback(false);
    $('editor').classList.add('is-hidden');
    document.body.classList.remove('editor-open');
  }

  function openEditor(file, mediaKind) {
    stopPlayback(false);
    if (edit) setMusic(null);
    kind = mediaKind;
    mediaFile = file;
    edit = defaults(kind);
    selectedId = null;
    src = null;
    photoRel = 0;
    peaks = null;
    if (mediaURL) URL.revokeObjectURL(mediaURL);
    mediaURL = URL.createObjectURL(file);
    $('editor').dataset.kind = kind;
    $('edTitle').textContent = kind === 'photo' ? 'Edit Photo' : 'Edit Video';
    resetControls();
    setMusic(null);
    showTool(null);
    setPlayIcon(false);
    returnPage = kind === 'photo' ? 'photoPage' : 'videoPage';
    showEditor();

    if (kind === 'video') {
      video.onloadedmetadata = () => {
        src = { w: video.videoWidth, h: video.videoHeight };
        setupTrim();
        try { video.currentTime = 0.05; } catch (error) { /* ignore */ }
        refresh();
      };
      video.onerror = () => { toast('This browser cannot read that video. Try another file or use Safari.'); hideEditor(); };
      video.muted = false;
      video.src = mediaURL;
      bgVideo.src = mediaURL;
      photoEl.removeAttribute('src');
    } else {
      photoEl.onload = () => {
        src = { w: photoEl.naturalWidth, h: photoEl.naturalHeight };
        setupTrim();
        refresh();
      };
      photoEl.onerror = () => { toast('This browser cannot read that photo. Try a JPG or PNG.'); hideEditor(); };
      photoEl.src = mediaURL;
      photoBg.src = mediaURL;
      video.removeAttribute('src');
      bgVideo.removeAttribute('src');
    }
  }

  $('edCancel').addEventListener('click', () => { hideEditor(); showPage(returnPage); });
  $('edDone').addEventListener('click', () => {
    if (!src) return toast('Still loading. Please wait a moment.');
    if (kind === 'video') {
      if (trimLength() < 0.3) return toast('The selected part is too short. Move the trim handles apart.');
      if (mediaFile.size > MAX_VIDEO_BYTES) return toast('This video is too large for reliable processing on a phone. Please choose a smaller file.');
    }
    hideEditor();
    runExport();
  });

  $('videoInput').addEventListener('click', (event) => { event.target.value = ''; });
  $('photoInput').addEventListener('click', (event) => { event.target.value = ''; });
  $('videoInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) return toast('Please choose a valid video file.');
    openEditor(file, 'video');
  });
  $('photoInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Please choose a valid image file.');
    $('originalPhotoBox').classList.remove('is-hidden');
    openEditor(file, 'photo');
  });
  $('shareOriginalPhotoBtn').addEventListener('click', () => {
    if (mediaFile && kind === 'photo') shareFiles([mediaFile], '');
  });

  /* ------------------------------- Export ---------------------------- */

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

  async function writeBlob(path, blob, attached) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await engineCall('write', { path, data: bytes }, { transfer: [bytes.buffer] });
    attached.push({ dir: null, path });
  }

  async function cleanupAttached(attached) {
    for (const item of attached) {
      try {
        if (item.dir) await engineCall('cleanup', { dir: item.dir, path: item.path }, { timeout: 10000 });
        else await engineCall('remove', { path: item.path }, { timeout: 10000 });
      } catch (cleanupError) { /* not critical */ }
    }
  }

  function etaText(overall, startedAt) {
    const elapsed = (Date.now() - startedAt) / 1000;
    if (overall < 0.05 || elapsed < 6) return '';
    return ` About ${formatTime((elapsed * (1 - overall)) / overall)} left.`;
  }

  async function transcodeParts(file) {
    await ensureEngine();

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
      const overlayBlob = await overlayPNG(out.W, out.H);
      if (overlayBlob) { await writeBlob(OVERLAY_NAME, overlayBlob, attached); overlayPath = OVERLAY_NAME; }

      const mark = await watermarkPNG(out.W, out.H);
      await writeBlob(WM_NAME, mark.blob, attached);

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

      const startedAt = Date.now();
      for (let index = 0; index < partCount; index++) {
        const offset = index * PART_SECONDS;
        const start = edit.trimStart + offset;
        const length = Math.min(PART_SECONDS, edit.trimEnd - start);
        const outputName = `${baseName}_part_${String(index + 1).padStart(2, '0')}.mp4`;
        const label = partCount > 1
          ? `Step 2 of 2: Optimizing part ${index + 1} of ${partCount}`
          : 'Step 2 of 2: Optimizing video';

        let fraction = 0;
        const report = () => {
          const overall = (index + Math.min(fraction, 0.99)) / partCount;
          setProgress(overall * 100, label, `Keep this page open and your screen on.${etaText(overall, startedAt)}`);
        };
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

        const args = buildArgs({
          inputPath, outputName, out, quality, start, length,
          fps: info.fps,
          hasAudio: info.hasAudio !== false,
          overlayPath,
          wm: { path: WM_NAME, x: mark.x, y: mark.y },
          fadeOut: index === partCount - 1,
          music: musicPath ? {
            path: musicPath,
            mode: edit.musicMode,
            volume: clamp01(edit.musicVol),
            offset: musicOffsetFor(edit.musicStart, offset, edit.musicDuration)
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
        setProgress(((index + 1) / partCount) * 100, label);
      }
    } finally {
      engine.onProgress = null;
      engine.onLog = null;
      await cleanupAttached(attached);
    }
    return results;
  }

  async function transcodePhoto() {
    await ensureEngine();

    const out = computeOutput(src, edit, PHOTO_QUALITY);
    const length = trimLength();
    const attached = [];
    setProgress(0, 'Step 2 of 2: Preparing your photo…', 'Drawing the picture.');
    try {
      const frame = await composePhotoFrame(out);
      if (!frame) throw new Error('The photo could not be prepared.');
      await writeBlob(FRAME_NAME, frame, attached);

      let musicPath = null;
      if (edit.musicFile) musicPath = await attachFile(MUSIC_DIR, MUSIC_NAME, edit.musicFile, attached);

      const outputName = `${safeName(mediaFile.name)}_status.mp4`;
      const startedAt = Date.now();
      let fraction = 0;
      const report = () => setProgress(Math.min(fraction, 0.99) * 100, 'Step 2 of 2: Making your video',
        `Keep this page open and your screen on.${etaText(fraction, startedAt)}`);
      engine.onProgress = ({ progress, time }) => {
        const fromTime = Number.isFinite(time) && time > 0 ? time / 1e6 / length : null;
        fraction = Math.max(fraction, clamp01(fromTime !== null ? fromTime : progress));
        report();
      };
      engine.onLog = (line) => {
        const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line || '');
        if (!match) return;
        fraction = Math.max(fraction, clamp01((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) / length));
        report();
      };
      report();

      const args = buildPhotoArgs({
        framePath: FRAME_NAME, outputName, length, quality: PHOTO_QUALITY,
        music: musicPath ? {
          path: musicPath,
          mode: 'replace',
          volume: clamp01(edit.musicVol),
          offset: musicOffsetFor(edit.musicStart, 0, edit.musicDuration)
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
      setProgress(100, 'Step 2 of 2: Making your video');
      return [{ name: outputName, file: new File([blob], outputName, { type: 'video/mp4' }), size: blob.size }];
    } finally {
      engine.onProgress = null;
      engine.onLog = null;
      await cleanupAttached(attached);
    }
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

  function renderResults(items) {
    const list = $('videoDownloads');
    list.innerHTML = '';
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'download-item';

      const info = document.createElement('div');
      info.className = 'download-info';
      const name = document.createElement('b');
      name.textContent = items.length > 1 ? `Part ${index + 1} of ${items.length}` : (kind === 'photo' ? 'Your photo video' : 'Your video');
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
    $('resultsHeading').textContent = items.length > 1 ? `Your ${items.length} videos are ready` : 'Your video is ready';
    $('sendMeBtn').textContent = items.length > 1 ? 'Send all parts to my WhatsApp' : 'Send to my WhatsApp';
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
      friendly = 'Your device ran out of memory. Try a shorter or smaller video, choose "Fast" under More, close other apps and try again.';
    } else if (/worker|did not start|not compatible|initialise|workerfs/i.test(raw)) {
      friendly = 'The video engine could not start in this browser. Update your browser (on iPhone use Safari) and try again.';
    } else if (/could not be converted/i.test(raw)) {
      friendly = 'The video could not be converted. Try again without music or text, or choose another file.';
    } else {
      friendly = 'Something went wrong while preparing the video. Please try again.';
    }
    return { friendly, detail: `${raw}${logs}`.slice(0, 300) };
  }

  async function runExport() {
    if (processing) return;
    processing = true;
    outputFiles = [];
    showPage('resultPage');
    $('resultTitle').textContent = kind === 'photo' ? 'Making your video' : 'Preparing your video';
    $('videoProgress').classList.remove('is-hidden', 'is-error');
    $('videoResults').classList.add('is-hidden');
    $('progressEditBtn').classList.add('is-hidden');
    startTicker();
    keepAwake(true);
    setProgress(0, 'Getting ready…', 'The first run downloads the video engine. Keep this page open.');
    try {
      outputFiles = kind === 'photo' ? await transcodePhoto() : await transcodeParts(mediaFile);
      stopTicker();
      renderResults(outputFiles);
      $('videoProgress').classList.add('is-hidden');
      $('videoResults').classList.remove('is-hidden');
      $('resultTitle').textContent = 'All done';
      toast(outputFiles.length > 1 ? `Done. Your video was split into ${outputFiles.length} parts.` : 'Done. Your video is ready to send.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      console.error(error);
      stopTicker();
      const { friendly, detail } = describeError(error);
      $('videoProgress').classList.add('is-error');
      $('progressEditBtn').classList.remove('is-hidden');
      $('resultTitle').textContent = 'Something went wrong';
      setProgress(0, 'Could not prepare the video', `${friendly} (Details: ${detail})`);
      toast(friendly);
    } finally {
      processing = false;
      stopTicker();
      keepAwake(false);
    }
  }

  $('sendMeBtn').addEventListener('click', () => shareFiles(outputFiles.map((item) => item.file), edit.caption));
  $('copyResultCaptionBtn').addEventListener('click', () => copyText(edit.caption));
  const backToEditor = () => { returnPage = 'resultPage'; showEditor(); };
  $('editAgainBtn').addEventListener('click', backToEditor);
  $('progressEditBtn').addEventListener('click', backToEditor);
  $('anotherBtn').addEventListener('click', () => showPage(kind === 'photo' ? 'photoPage' : 'videoPage'));

  /* --------------------------- My WhatsApp number -------------------- */

  const digitsOf = (value) => String(value || '').replace(/\D/g, '').replace(/^00/, '');

  function updateMeLink() {
    const digits = digitsOf($('meNumber').value);
    const ok = digits.length >= 9 && digits[0] !== '0';
    const link = $('openMeChat');
    link.classList.toggle('is-disabled', !ok);
    link.setAttribute('aria-disabled', String(!ok));
    link.href = ok ? `https://wa.me/${digits}` : '#';
    if (ok) { try { localStorage.setItem(NUMBER_KEY, digits); } catch (error) { /* private mode */ } }
  }

  $('meNumber').addEventListener('input', updateMeLink);
  $('openMeChat').addEventListener('click', (event) => {
    if ($('openMeChat').classList.contains('is-disabled')) {
      event.preventDefault();
      toast('Type your number with the country code first, for example +255 7XX XXX XXX.');
    }
  });

  (() => {
    let saved = '';
    try { saved = localStorage.getItem(NUMBER_KEY) || ''; } catch (error) { /* private mode */ }
    try {
      const fromLink = digitsOf(new URLSearchParams(window.location.search).get('me'));
      if (fromLink.length >= 9) {
        saved = fromLink;
        try { localStorage.setItem(NUMBER_KEY, saved); } catch (error) { /* private mode */ }
        window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      }
    } catch (error) { /* old browser */ }
    $('meNumber').value = saved ? `+${saved}` : '';
    updateMeLink();
  })();

  /* ------------------------------ Splash ----------------------------- */

  (() => {
    const splash = $('splash');
    if (!splash) return;
    const hide = () => { if (splash.parentNode) splash.remove(); };
    splash.addEventListener('animationend', hide);
    window.setTimeout(hide, 2600);
  })();
})();
