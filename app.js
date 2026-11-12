(() => {
  'use strict';

  /* ------------------------------------------------------------------
     STATUS SAFI
     Video engine: single-thread FFmpeg core (WebAssembly) running inside
     a same-origin Web Worker that is created from a Blob. Running the
     worker from our own origin is what fixes the "stuck at 10%" problem:
     browsers (Safari especially) silently refuse to start a Worker whose
     script lives on another origin such as a CDN.
  ------------------------------------------------------------------- */

  const CORE_VERSION = '0.12.10';
  const CORE_SOURCES = [
    `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`,
    `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`
  ];
  const PART_SECONDS = 60;
  const MAX_VIDEO_BYTES = 700 * 1024 * 1024;
  const ENGINE_APPROX_BYTES = 32 * 1024 * 1024;
  const INPUT_DIR = '/input';
  const INPUT_NAME = 'input_video';

  const $ = (id) => document.getElementById(id);
  const pages = [...document.querySelectorAll('.page')];

  let videoFile = null;
  let photoFile = null;
  let videoURL = null;
  let photoURL = null;
  let outputFiles = [];
  let outputURLs = [];
  let toastTimer = null;
  let processing = false;
  let wakeLock = null;

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
    toast('Choose a video or photo, then follow the steps on screen. Your files are processed on your device and never uploaded.', 7000));

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return 'Duration unavailable';
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
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

  const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

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
      const value = Math.max(0, Math.min(100, percent));
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

  const engine = { worker: null, ready: false, loading: null, seq: 0, pending: new Map(), onProgress: null, onLog: null };

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
      if (data.type === 'log') { if (engine.onLog) engine.onLog(data.message); return; }
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

  /* ----------------------------- Video flow -------------------------- */

  $('videoInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) return toast('Please choose a valid video file.');
    videoFile = file;
    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = URL.createObjectURL(file);
    const video = $('videoPreview');
    video.onloadedmetadata = () => {
      $('videoMeta').textContent = `${formatSize(file.size)} • ${formatTime(video.duration)} • ${video.videoWidth}×${video.videoHeight}`;
    };
    video.onerror = () => toast('This browser cannot read that video. Try another file or use Safari.');
    video.src = videoURL;
    $('videoName').textContent = file.name;
    $('videoMeta').textContent = formatSize(file.size);
    $('videoInfo').classList.remove('is-hidden');
    $('videoResults').classList.add('is-hidden');
    $('videoProgress').classList.add('is-hidden');
    clearOutputs();
  });

  function clearOutputs() {
    outputURLs.forEach((url) => URL.revokeObjectURL(url));
    outputURLs = [];
    outputFiles = [];
  }

  async function transcodeParts(file, duration, crf) {
    await ensureEngine();

    setProgress(0, 'Step 2 of 2: Reading your video…', 'Preparing the original file for processing.');
    const inputFile = new File([file], INPUT_NAME, { type: file.type || 'video/mp4' });
    let inputPath = `${INPUT_DIR}/${INPUT_NAME}`;
    try {
      await engineCall('mount', { dir: INPUT_DIR, file: inputFile }, { timeout: 30000, timeoutMessage: 'Reading the video timed out.' });
    } catch (mountError) {
      console.warn('[STATUS SAFI] Direct file access unavailable, copying into memory.', mountError);
      inputPath = INPUT_NAME;
      const bytes = new Uint8Array(await file.arrayBuffer());
      await engineCall('write', { path: INPUT_NAME, data: bytes }, { transfer: [bytes.buffer] });
    }

    const partCount = Math.max(1, Math.ceil((duration - 0.25) / PART_SECONDS));
    const baseName = safeName(file.name);
    const results = [];

    try {
      for (let index = 0; index < partCount; index++) {
        const start = index * PART_SECONDS;
        const length = Math.min(PART_SECONDS, duration - start);
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
        engine.onLog = (message) => {
          const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message || '');
          if (!match) return;
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          fraction = Math.max(fraction, clamp01(seconds / length));
          report();
        };
        report();

        const args = [
          '-ss', String(start), '-i', inputPath, '-t', String(length),
          '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast',
          '-crf', String(crf), '-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', outputName
        ];
        const code = await engineCall('exec', { args });
        if (typeof code === 'number' && code !== 0) {
          throw new Error(`The video could not be converted (code ${code}).`);
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
      try {
        await engineCall('cleanup', { dir: INPUT_DIR, path: inputPath }, { timeout: 10000 });
      } catch (cleanupError) { /* not critical */ }
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
      share.addEventListener('click', () => shareFiles([item.file]));
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'chip-button ghost';
      save.textContent = 'Save';
      save.addEventListener('click', () => saveFile(item.file));
      actions.append(share, save);

      row.append(info, actions);
      list.append(row);
    });
  }

  async function shareFiles(files) {
    if (!navigator.share || !navigator.canShare || !navigator.canShare({ files })) {
      toast('Sharing is not supported in this browser. Use Save, or open this page in Safari (iPhone) or Chrome (Android).');
      return false;
    }
    try {
      await navigator.share({ files, title: 'STATUS SAFI' });
      return true;
    } catch (error) {
      if (error && error.name !== 'AbortError') toast('Could not open the share menu. Please try again.');
      return false;
    }
  }

  function describeError(error) {
    const raw = String((error && error.message) || error || 'Unknown error');
    const logs = error && error.logs && error.logs.length ? ` | ${error.logs.slice(-2).join(' ').trim()}` : '';
    let friendly;
    if (/download|stalled|network|failed to fetch|load failed|http \d/i.test(raw)) {
      friendly = 'The video engine could not be downloaded. Check your internet connection and try again.';
    } else if (/memory|allocate|out of bounds|aborted|oom/i.test(raw)) {
      friendly = 'Your device ran out of memory. Try a shorter or smaller video, close other apps and try again.';
    } else if (/worker|did not start|not compatible|initialise|workerfs/i.test(raw)) {
      friendly = 'The video engine could not start in this browser. Update your browser (on iPhone use Safari) and try again.';
    } else {
      friendly = 'Something went wrong while preparing the video. Please try again.';
    }
    return { friendly, detail: `${raw}${logs}`.slice(0, 280) };
  }

  async function runVideo() {
    if (processing) return;
    if (!videoFile) return toast('Please choose a video first.');
    const video = $('videoPreview');
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      return toast('The video length could not be read. Please choose another video.');
    }
    if (videoFile.size > MAX_VIDEO_BYTES) {
      return toast('This video is too large for reliable processing on a phone. Please choose a smaller file.');
    }
    const button = $('processVideoBtn');
    processing = true;
    button.disabled = true;
    button.textContent = 'Processing…';
    $('videoProgress').classList.remove('is-hidden', 'is-error');
    $('videoResults').classList.add('is-hidden');
    clearOutputs();
    startTicker();
    keepAwake(true);
    setProgress(0, 'Getting ready…', 'The first run downloads the video engine. Keep this page open.');
    $('videoProgress').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      outputFiles = await transcodeParts(videoFile, video.duration, Number($('qualitySelect').value));
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
  $('shareAllVideosBtn').addEventListener('click', () => shareFiles(outputFiles.map((item) => item.file)));

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

  $('processPhotoBtn').addEventListener('click', async () => {
    if (!photoFile) return toast('Please choose a photo first.');
    await shareFiles([photoFile]);
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
