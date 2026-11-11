const $ = (id) => document.getElementById(id);
const pages = [...document.querySelectorAll('.page')];
const saved = [];
let videoFile = null, photoFile = null, ffmpeg = null, ffmpegUtil = null, ffmpegReady = false;
let videoURL = null, photoURL = null;
let toastTimer;

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
function showPage(id) {
  pages.forEach(p => p.classList.toggle('active', p.id === id));
  window.scrollTo({top:0, behavior:'smooth'});
}
document.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', () => showPage(btn.dataset.open)));
document.querySelectorAll('[data-back]').forEach(btn => btn.addEventListener('click', () => showPage('homePage')));
$('helpBtn').addEventListener('click', () => toast('Chagua video au picha, kisha fuata maelekezo. Faili huchakatwa ndani ya kifaa chako.'));

function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return 'Muda haujulikani';
  const s = Math.round(seconds); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}
function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units=['B','KB','MB','GB']; let n=bytes,i=0;
  while(n>=1024 && i<units.length-1){n/=1024;i++;}
  return `${n.toFixed(i?1:0)} ${units[i]}`;
}
function setProgress(prefix, percent, label) {
  // Video kuu hutumia IDs fupi (progressBar/Percent/Text); kugawa hutumia splitProgress...
  const ids = prefix === 'video'
    ? ['progressBar', 'progressPercent', 'progressText']
    : [`${prefix}ProgressBar`, `${prefix}ProgressPercent`, `${prefix}ProgressText`];
  const [barId, pctId, txtId] = ids;
  const bar = $(barId), pct = $(pctId), txt = $(txtId);
  if (bar) bar.style.width = `${Math.max(0,Math.min(100,percent))}%`;
  if (pct) pct.textContent = `${Math.round(percent)}%`;
  if (txt && label) txt.textContent = label;
}
function rememberFile(name, url, size) {
  saved.unshift({name,url,size}); renderSaved();
}
function renderDownloads(container, items) {
  container.innerHTML = '';
  items.forEach(item => {
    const row=document.createElement('div'); row.className='download-item';
    const info=document.createElement('div'); const name=document.createElement('b'); name.textContent=item.name;
    const meta=document.createElement('small'); meta.textContent=fmtSize(item.size);
    info.append(name,meta);
    const link=document.createElement('a'); link.className='download-link'; link.href=item.url; link.download=item.name; link.textContent='Pakua';
    row.append(info,link); container.append(row);
  });
}
function renderSaved() {
  $('savedFiles').innerHTML=''; $('emptyFiles').classList.toggle('is-hidden',saved.length>0);
  renderDownloads($('savedFiles'),saved);
}

function readVideo(file) {
  if (!file) return;
  videoFile=file;
  if(videoURL) URL.revokeObjectURL(videoURL);
  videoURL=URL.createObjectURL(file);
  $('videoPreview').src=videoURL;
  $('videoName').textContent=file.name;
  $('videoMeta').textContent=fmtSize(file.size);
  $('videoInfo').classList.remove('is-hidden');
  $('videoResults').classList.add('is-hidden');
  $('videoPreview').onloadedmetadata=()=>{
    const duration=$('videoPreview').duration;
    $('videoMeta').textContent=`${fmtSize(file.size)} • ${fmtTime(duration)} • ${$('videoPreview').videoWidth}×${$('videoPreview').videoHeight}`;
    $('processVideoBtn').textContent=duration>60?'Andaa na gawa video automatic':'Andaa video';
  };
}
$('videoInput').addEventListener('change',e=>readVideo(e.target.files[0]));

async function loadFFmpeg(mode) {
  if(ffmpegReady) return;
  setProgress(mode,2,'Inaunganisha kifaa cha video…');
  toast('Kifaa cha video kinapakiwa kwa mara ya kwanza. Subiri kidogo…');
  const [{FFmpeg},{toBlobURL}] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js'),
    import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js')
  ]);
  setProgress(mode,5,'Inapakua kifaa cha video…');
  ffmpegUtil={toBlobURL}; ffmpeg=new FFmpeg();
  ffmpeg.on('progress', ({progress})=>{
    setProgress('video',Math.max(0,Math.min(99,progress*100)),'Inachakata video…');
  });
  const base='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`,'text/javascript');
  setProgress(mode,8,'Inapakia injini ya video kwenye simu…');
  const wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`,'application/wasm');
  await ffmpeg.load({coreURL, wasmURL});
  ffmpegReady=true;
  setProgress(mode,10,'Inaanza kuchakata video…');
}
function safeName(name) { return name.replace(/\.[^.]+$/,'').replace(/[^a-z0-9-_]/gi,'_').slice(0,45)||'video'; }
async function transcodeParts(file, limit, crf, mode) {
  await loadFFmpeg(mode);
  const input='input_video';
  await ffmpeg.writeFile(input,new Uint8Array(await file.arrayBuffer()));
  const duration=$('videoPreview').duration;
  if(!Number.isFinite(duration)||duration<=0) throw new Error('Muda wa video haujasomeka. Jaribu video nyingine.');
  const count=Math.ceil(duration/limit), base=safeName(file.name), outputs=[];
  for(let i=0;i<count;i++) {
    const start=i*limit, length=Math.min(limit,duration-start), output=`${base}_sehemu_${String(i+1).padStart(2,'0')}.mp4`;
    const args=['-ss',String(start),'-i',input,'-t',String(length),'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf',String(crf),'-c:a','aac','-b:a','128k','-pix_fmt','yuv420p','-movflags','+faststart','-avoid_negative_ts','make_zero',output];
    await ffmpeg.exec(args);
    const data=await ffmpeg.readFile(output); const blob=new Blob([data.buffer],{type:'video/mp4'}); const url=URL.createObjectURL(blob);
    outputs.push({name:output,url,size:blob.size});
    await ffmpeg.deleteFile(output);
    const progress=((i+1)/count)*100;
    setProgress(mode,progress,`Inatengeneza sehemu ${i+1} kati ya ${count}…`);
  }
  await ffmpeg.deleteFile(input);
  return outputs;
}
async function runVideo() {
  const file=videoFile;
  if(!file) return toast('Tafadhali chagua video kwanza.');
  const btn=$('processVideoBtn');
  const progress=$('videoProgress');
  const results=$('videoResults');
  const list=$('videoDownloads');
  const limit=60; // Kikomo cha moja kwa moja: sekunde 60 kwa kila sehemu.
  const crf=Number($('qualitySelect').value);
  btn.disabled=true; btn.textContent='Inaandaa…'; progress.classList.remove('is-hidden'); results.classList.add('is-hidden'); setProgress('video',0,'Inaanza…');
  try {
    const items=await transcodeParts(file,limit,crf,'video');
    renderDownloads(list,items); results.classList.remove('is-hidden'); setProgress('video',100,'Imekamilika!');
    toast(items.length>1?`Imekamilika. Video imegawanywa automatic katika sehemu ${items.length}.`:'Imekamilika. Video yako iko tayari.');
  } catch(err) {
    console.error(err); toast(`Imeshindikana: ${err.message||'Jaribu tena.'}`);
  } finally {btn.disabled=false;btn.textContent='Andaa video';}
}
$('processVideoBtn').addEventListener('click',runVideo);

$('photoInput').addEventListener('change',e=>{
  const file=e.target.files[0]; if(!file)return; photoFile=file;
  if(photoURL)URL.revokeObjectURL(photoURL); photoURL=URL.createObjectURL(file);
  $('photoPreview').src=photoURL; $('photoName').textContent=file.name; $('photoMeta').textContent=fmtSize(file.size);
  $('photoInfo').classList.remove('is-hidden');
});
$('processPhotoBtn').addEventListener('click',async()=>{
  if(!photoFile)return toast('Tafadhali chagua picha kwanza.');
  if(!navigator.share || !navigator.canShare || !navigator.canShare({files:[photoFile]})) {
    toast('Simu hii hairuhusu kushare faili moja kwa moja. Fungua tovuti kwenye Safari ya simu kisha jaribu tena.');
    return;
  }
  const btn=$('processPhotoBtn');
  btn.disabled=true; btn.textContent='Inafungua WhatsApp…';
  try {
    // Tuma faili asili bila kuibana, kuibadilisha format au kupunguza vipimo.
    await navigator.share({files:[photoFile], title:'Picha kutoka STATUS SAFI', text:'Picha asili kutoka STATUS SAFI'});
  } catch(err) {
    if(err.name!=='AbortError') toast('Imeshindikana kufungua sehemu ya kushare. Jaribu tena.');
  } finally {
    btn.disabled=false; btn.textContent='Tuma picha WhatsApp';
  }
});

// Intro ikimaliza, onyesha ukurasa wa mwanzo moja kwa moja.
// Hii pia huondoa is-hidden ambayo ilikuwa imeficha app kabisa.
(() => {
  const intro = $('intro');
  const app = $('app');
  if (!intro || !app) return;

  let finished = false;
  const finishIntro = () => {
    if (finished) return;
    finished = true;
    app.classList.remove('is-hidden');
    app.style.animation = 'appEnter .8s ease both';
    intro.remove();
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    intro.style.animation = 'introOut .01ms ease forwards';
    requestAnimationFrame(() => requestAnimationFrame(finishIntro));
  } else {
    intro.addEventListener('animationend', (event) => {
      if (event.animationName === 'introOut') finishIntro();
    });
    // Kinga ya ziada iwapo kivinjari hakitoi tukio la animationend.
    window.setTimeout(finishIntro, 5200);
  }
})();
