const $ = (id) => document.getElementById(id);
const pages = [...document.querySelectorAll('.page')];
const saved = [];
let videoFile = null, splitFile = null, photoFile = null, ffmpeg = null, ffmpegUtil = null, ffmpegReady = false;
let videoURL = null, splitURL = null, photoURL = null;
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
  const bar = $(`${prefix}ProgressBar`), pct = $(`${prefix}ProgressPercent`), txt = $(`${prefix}ProgressText`);
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

function readVideo(file, type) {
  if (!file) return;
  const isSplit=type==='split';
  if (isSplit) {
    splitFile=file; if(splitURL) URL.revokeObjectURL(splitURL); splitURL=URL.createObjectURL(file);
    $('splitPreview').src=splitURL; $('splitName').textContent=file.name; $('splitMeta').textContent=fmtSize(file.size);
    $('splitInfo').classList.remove('is-hidden'); $('splitResults').classList.add('is-hidden');
    $('splitPreview').onloadedmetadata=()=>updateEstimate($('splitPreview').duration);
  } else {
    videoFile=file; if(videoURL) URL.revokeObjectURL(videoURL); videoURL=URL.createObjectURL(file);
    $('videoPreview').src=videoURL; $('videoName').textContent=file.name; $('videoMeta').textContent=fmtSize(file.size);
    $('videoInfo').classList.remove('is-hidden'); $('videoResults').classList.add('is-hidden');
    $('videoPreview').onloadedmetadata=()=>{$('videoMeta').textContent=`${fmtSize(file.size)} • ${fmtTime($('videoPreview').duration)} • ${$('videoPreview').videoWidth}×${$('videoPreview').videoHeight}`;};
  }
}
$('videoInput').addEventListener('change',e=>readVideo(e.target.files[0],'video'));
$('splitInput').addEventListener('change',e=>readVideo(e.target.files[0],'split'));
function updateEstimate(duration) {
  if(!Number.isFinite(duration)) return;
  const limit=Number($('splitLimit').value), count=Math.ceil(duration/limit);
  $('partsEstimate').textContent=`Video hii itakuwa na sehemu ${count}. Kila sehemu itakuwa na hadi sekunde ${limit}, na sehemu ya mwisho itahifadhi muda uliobaki.`;
}
$('splitLimit').addEventListener('change',()=>updateEstimate($('splitPreview').duration));

async function loadFFmpeg() {
  if(ffmpegReady) return;
  toast('Tunasubiri kifaa cha kuandaa video kipakie kwa mara ya kwanza…');
  const [{FFmpeg},{toBlobURL}] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js'),
    import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js')
  ]);
  ffmpegUtil={toBlobURL}; ffmpeg=new FFmpeg();
  ffmpeg.on('progress', ({progress})=>{
    const active=$('videoProgress').classList.contains('is-hidden')?'split':'video';
    const current=active==='video'?'video':'split';
    setProgress(current,Math.max(0,Math.min(99,progress*100)),'Inachakata video…');
  });
  const base='https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`,'text/javascript'),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`,'application/wasm')
  });
  ffmpegReady=true;
}
function safeName(name) { return name.replace(/\.[^.]+$/,'').replace(/[^a-z0-9-_]/gi,'_').slice(0,45)||'video'; }
async function transcodeParts(file, limit, crf, mode) {
  await loadFFmpeg();
  const input='input_video';
  await ffmpeg.writeFile(input,new Uint8Array(await file.arrayBuffer()));
  const duration=mode==='split'?$('splitPreview').duration:$('videoPreview').duration;
  if(!Number.isFinite(duration)||duration<=0) throw new Error('Muda wa video haujasomeka. Jaribu video nyingine.');
  const count=Math.ceil(duration/limit), base=safeName(file.name), outputs=[];
  for(let i=0;i<count;i++) {
    const start=i*limit, length=Math.min(limit,duration-start), output=`${base}_sehemu_${String(i+1).padStart(2,'0')}.mp4`;
    const args=['-ss',String(start),'-i',input,'-t',String(length),'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf',String(crf),'-c:a','aac','-b:a','128k','-pix_fmt','yuv420p','-movflags','+faststart','-avoid_negative_ts','make_zero',output];
    await ffmpeg.exec(args);
    const data=await ffmpeg.readFile(output); const blob=new Blob([data.buffer],{type:'video/mp4'}); const url=URL.createObjectURL(blob);
    outputs.push({name:output,url,size:blob.size}); rememberFile(output,url,blob.size);
    await ffmpeg.deleteFile(output);
    const progress=((i+1)/count)*100;
    setProgress(mode,progress,`Inatengeneza sehemu ${i+1} kati ya ${count}…`);
  }
  await ffmpeg.deleteFile(input);
  return outputs;
}
async function runVideo(mode) {
  const file=mode==='split'?splitFile:videoFile;
  if(!file) return toast('Tafadhali chagua video kwanza.');
  const btn=$(mode==='split'?'splitVideoBtn':'processVideoBtn');
  const progress=$(mode==='split'?'splitProgress':'videoProgress');
  const results=$(mode==='split'?'splitResults':'videoResults');
  const list=$(mode==='split'?'splitDownloads':'videoDownloads');
  const limit=Number($(mode==='split'?'splitLimit':'limitSelect').value);
  const crf=mode==='split'?21:Number($('qualitySelect').value);
  btn.disabled=true; btn.textContent='Inaandaa…'; progress.classList.remove('is-hidden'); results.classList.add('is-hidden'); setProgress(mode,0,'Inaanza…');
  try {
    const items=await transcodeParts(file,limit,crf,mode);
    renderDownloads(list,items); results.classList.remove('is-hidden'); setProgress(mode,100,'Imekamilika!'); toast(`Imekamilika. Sehemu ${items.length} zimetengenezwa.`);
  } catch(err) {
    console.error(err); toast(`Imeshindikana: ${err.message||'Jaribu tena.'}`);
  } finally {btn.disabled=false;btn.textContent=mode==='split'?'Gawa video sasa':'Andaa video';}
}
$('processVideoBtn').addEventListener('click',()=>runVideo('video'));
$('splitVideoBtn').addEventListener('click',()=>runVideo('split'));

$('photoInput').addEventListener('change',e=>{
  const file=e.target.files[0]; if(!file)return; photoFile=file;
  if(photoURL)URL.revokeObjectURL(photoURL); photoURL=URL.createObjectURL(file);
  $('photoPreview').src=photoURL; $('photoName').textContent=file.name; $('photoMeta').textContent=fmtSize(file.size);
  $('photoInfo').classList.remove('is-hidden'); $('photoResults').classList.add('is-hidden');
});
$('processPhotoBtn').addEventListener('click',async()=>{
  if(!photoFile)return;
  try {
    const bitmap=await createImageBitmap(photoFile); const canvas=document.createElement('canvas');
    canvas.width=bitmap.width;canvas.height=bitmap.height;
    const ctx=canvas.getContext('2d',{alpha:true});ctx.drawImage(bitmap,0,0);bitmap.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.94));
    if(!blob)throw new Error('Kivinjari hiki hakikuweza kuandaa picha ya WebP.');
    const url=URL.createObjectURL(blob),name=`${safeName(photoFile.name)}_status_safi.webp`;
    $('photoDownload').href=url;$('photoDownload').download=name;$('photoResults').classList.remove('is-hidden');
    rememberFile(name,url,blob.size);toast('Picha imeandaliwa bila kukatwa.');
  }catch(err){toast(err.message||'Imeshindikana kuboresha picha.');}
});

// Intro inajifunga yenyewe; pia tunaheshimu chaguo la kupunguza mwendo kwenye kifaa.
if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){$('intro').style.animationDuration='0.01ms';$('app').style.animationDelay='0.01ms';}
