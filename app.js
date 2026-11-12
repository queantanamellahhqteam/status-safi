const $ = (id) => document.getElementById(id);
const pages = [...document.querySelectorAll('.page')];
let videoFile = null, photoFile = null, ffmpeg = null, ffmpegReady = false;
let videoURL = null, photoURL = null, outputFiles = [], toastTimer;

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}
function showPage(id) {
  pages.forEach(page => page.classList.toggle('active', page.id === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.open)));
document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => showPage('homePage')));
$('helpBtn').addEventListener('click', () => toast('Choose a video or photo, then follow the on-screen steps. Your files are processed on your device.'));

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return 'Duration unavailable';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']; let value = bytes, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}
function setProgress(percent, label, hint) {
  $('progressBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('progressPercent').textContent = `${Math.round(percent)}%`;
  $('progressText').textContent = label;
  if (hint) $('progressHint').textContent = hint;
}
function safeName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]/gi, '_').slice(0, 42) || 'status_video';
}

$('videoInput').addEventListener('change', event => {
  const file = event.target.files?.[0]; if (!file) return;
  if (!file.type.startsWith('video/')) return toast('Please choose a valid video file.');
  videoFile = file;
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(file);
  $('videoPreview').src = videoURL;
  $('videoName').textContent = file.name;
  $('videoMeta').textContent = formatSize(file.size);
  $('videoInfo').classList.remove('is-hidden');
  $('videoResults').classList.add('is-hidden');
  outputFiles = [];
  $('videoPreview').onloadedmetadata = () => {
    const video = $('videoPreview');
    $('videoMeta').textContent = `${formatSize(file.size)} • ${formatTime(video.duration)} • ${video.videoWidth}×${video.videoHeight}`;
  };
});

async function loadFFmpeg() {
  if (ffmpegReady) return;
  setProgress(2, 'Connecting to video engine…', 'The video engine is being downloaded for the first use. Keep this page open and maintain an internet connection.');
  // FFmpeg.wasm is loaded from its official npm CDN packages. Single-thread core avoids SharedArrayBuffer requirements.
  const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js'),
    import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js')
  ]);
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => console.debug('[STATUS SAFI FFmpeg]', message));
  ffmpeg.on('progress', ({ progress }) => {
    const safe = Math.max(0, Math.min(1, Number(progress) || 0));
    setProgress(12 + safe * 82, 'Optimizing video…', 'Your video is being processed locally. Large videos may take several minutes on a phone.');
  });
  const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  setProgress(5, 'Downloading video engine…', 'Downloading the video processing engine. The first download may take a little time.');
  const [coreURL, wasmURL] = await Promise.all([
    toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm')
  ]);
  setProgress(10, 'Starting video engine…', 'The engine is being initialized. Keep Safari open and do not lock your phone.');
  await ffmpeg.load({ coreURL, wasmURL });
  ffmpegReady = true;
}

async function transcodeParts(file, duration, crf) {
  await loadFFmpeg();
  setProgress(12, 'Reading your video…', 'Preparing the original file for processing.');
  const inputName = 'status_safi_input';
  await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
  const partCount = Math.ceil(duration / 60);
  const baseName = safeName(file.name);
  const results = [];
  for (let index = 0; index < partCount; index++) {
    const start = index * 60;
    const length = Math.min(60, duration - start);
    const outputName = `${baseName}_part_${String(index + 1).padStart(2, '0')}.mp4`;
    setProgress(12 + (index / partCount) * 82, `Creating part ${index + 1} of ${partCount}…`, 'Please keep this page open. Each part is prepared in sequence with no intentional gaps.');
    const args = [
      '-ss', String(start), '-i', inputName, '-t', String(length),
      '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-crf', String(crf), '-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', outputName
    ];
    await ffmpeg.exec(args);
    const data = await ffmpeg.readFile(outputName);
    const blob = new Blob([data], { type: 'video/mp4' });
    results.push({ name: outputName, file: new File([blob], outputName, { type: 'video/mp4' }), size: blob.size });
    await ffmpeg.deleteFile(outputName);
  }
  await ffmpeg.deleteFile(inputName);
  return results;
}

function renderVideoResults(items) {
  const list = $('videoDownloads'); list.innerHTML = '';
  items.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'download-item';
    const info = document.createElement('div');
    const name = document.createElement('b'); name.textContent = `Part ${index + 1}: ${item.name}`;
    const meta = document.createElement('small'); meta.textContent = formatSize(item.size);
    info.append(name, meta);
    const share = document.createElement('button'); share.className = 'share-part'; share.textContent = 'Share';
    share.addEventListener('click', () => shareFiles([item.file]));
    row.append(info, share); list.append(row);
  });
}
async function shareFiles(files) {
  if (!navigator.share || !navigator.canShare || !navigator.canShare({ files })) {
    toast('File sharing is not supported here. Open this website in Safari on your iPhone or use a supported browser.');
    return;
  }
  try { await navigator.share({ files, title: 'STATUS SAFI' }); }
  catch (error) { if (error.name !== 'AbortError') toast('Unable to open the share menu. Please try again.'); }
}

async function runVideo() {
  if (!videoFile) return toast('Please choose a video first.');
  const video = $('videoPreview');
  if (!Number.isFinite(video.duration) || video.duration <= 0) return toast('The video duration could not be read. Please choose another video.');
  const button = $('processVideoBtn');
  button.disabled = true; button.textContent = 'Processing…';
  $('videoProgress').classList.remove('is-hidden'); $('videoResults').classList.add('is-hidden');
  setProgress(0, 'Preparing video…', 'The first run downloads the video engine. Keep Safari open and connected to the internet.');
  try {
    outputFiles = await transcodeParts(videoFile, video.duration, Number($('qualitySelect').value));
    renderVideoResults(outputFiles);
    $('videoResults').classList.remove('is-hidden');
    setProgress(100, 'Completed successfully', 'Your video is ready. Share each part to WhatsApp in the correct order.');
    toast(outputFiles.length > 1 ? `Done. Your video was split into ${outputFiles.length} parts.` : 'Done. Your video is ready to share.');
  } catch (error) {
    console.error(error);
    let message = error?.message || 'An unexpected error occurred.';
    if (/memory|allocate|abort/i.test(message)) message = 'Your phone may not have enough free memory for this video. Try a shorter or smaller file.';
    else if (/fetch|network|load|wasm|import/i.test(message)) message = 'The video engine could not load. Check your internet connection, reload the page and try again.';
    setProgress(0, 'Processing could not start', message);
    toast(message);
  } finally { button.disabled = false; button.textContent = 'Prepare video'; }
}
$('processVideoBtn').addEventListener('click', runVideo);
$('shareAllVideosBtn').addEventListener('click', () => shareFiles(outputFiles.map(item => item.file)));

$('photoInput').addEventListener('change', event => {
  const file = event.target.files?.[0]; if (!file) return;
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

// Reveal the app when the animated intro finishes; keep a fallback for mobile Safari.
(() => {
  const intro = $('intro'), app = $('app');
  if (!intro || !app) return;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    app.classList.remove('is-hidden');
    app.style.animation = 'appEnter .7s ease both';
    intro.remove();
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) requestAnimationFrame(finish);
  else {
    intro.addEventListener('animationend', event => { if (event.animationName === 'introOut') finish(); });
    window.setTimeout(finish, 5000);
  }
})();
