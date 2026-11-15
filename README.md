# STATUS SAFI

Prepare videos and photos for WhatsApp Status, entirely on the device. Nothing is uploaded.

## Install

Upload these four files to the root of the GitHub Pages repository, replacing the existing ones:

- `index.html`
- `style.css`
- `app.js`
- `README.md`

Commit, then open the site in Safari (iPhone) or Chrome (Android). The page links to `style.css?v=5` and `app.js?v=5`, so an old cached copy is not mixed with the new page. If something still looks wrong, reload or use a private tab.

## The editor

Choosing a video or a photo opens a full-screen dark editor in the style of WhatsApp's "Edit Video": **Cancel**, the title, **Done**, a rounded preview with a play button and a position bar, and a tool row at the bottom.

- **Trim** (video): two handles on one bar choose where the video starts and ends. For a photo this tool is **Length** (3 to 30 seconds).
- **Music**: pick an MP3, M4A or WAV saved on the phone. A waveform shows the song. Tap or drag on it to choose **where the song starts**; a 3-second preview plays when you let go, and the play button plays the video together with the song. Mix it with the original sound or replace it, and set its volume. If the song is shorter than the video it repeats, and it continues across split parts.
- **Crop**: Original, 9:16 Status, 4:5 or 1:1. For a shape that does not match the picture choose *Fill* (crop the edges, with a slider to move the crop) or *Fit* (keep the whole picture over a blurred copy).
- **Sticker**: emoji stickers, dragged on the picture, with a size slider.
- **Text**: any number of texts (emoji and Swahili work). Pick colour, size and an optional dark box, then drag the text on the picture. The preview shows exactly what is drawn into the video.
- **More**: quality (HD 720p, Fast 540p, Max 1080p) and a caption.

### Photos become short videos

A photo goes through the same editor. It is drawn once at its final size (crop or blurred sides, text, stickers) and turned into a still video with your music. A photo video is encoded from a single picture, so it is fast. **Share original photo** is still available on the photo page for an untouched copy (no music, no watermark).

### Watermark

Every video and photo video gets a small **STATUS SAFI** mark at the bottom right, slightly above the very edge so WhatsApp's own reply bar does not cover it. It is placed as a tiny separate picture, so it adds almost nothing to the processing time.

## Speed

Processing runs in a single-thread WebAssembly build of FFmpeg (GitHub Pages cannot send the headers needed for the multi-thread build). To keep it as quick as possible:

- the fastest x264 preset is used everywhere (WhatsApp compresses a Status again anyway);
- text and stickers are drawn once as one picture; the watermark is a separate small picture;
- the video is never scaled up, and frame rates above 30 are reduced to 30;
- a remaining-time estimate is shown while it works.

Decoding the original takes a large share of the time and cannot be avoided, so long 1080p or 4K clips still need patience. Choose **Fast 540p** under **More** for the quickest result.

## Sending to WhatsApp Status

A website cannot post a Status, and it cannot send a file to a chat by itself. Both would need an account-level server API and the file would have to be uploaded, which this app deliberately never does. What the page does instead:

1. Tap **Send to my WhatsApp**. The phone's share menu opens with the finished video (and the caption, if WhatsApp accepts it).
2. Choose **WhatsApp**, then your own chat (**You**). If WhatsApp offers an **HD** option, turn it on.
3. In WhatsApp, press and hold the video, tap **Forward** (or **Share**) and choose **My Status**.

Because the video is already prepared (720p, controlled bitrate), Status usually keeps more of its quality than when a large original is posted directly. This is a method reported by users, not a guarantee: WhatsApp decides how it compresses.

### Your number

The result page has a **Your WhatsApp number** box and an **Open my WhatsApp chat** button (a `wa.me` link), so your own chat opens in one tap. The number is saved on that phone only (`localStorage`). To fill it automatically, open the site once with your number in the link, for example `https://queantanamellahhqteam.github.io/status-safi/?me=255XXXXXXXXX`. The number is read, stored, and removed from the address bar. It is not written in the site's files.

## How the video engine works

The page downloads only the FFmpeg core (`@ffmpeg/core@0.12.10`, single-thread build, about 30 MB, once) from jsDelivr, with unpkg as a fallback. It runs in a Web Worker created from a Blob on the site's own origin, because browsers (Safari especially) refuse to start a worker whose script is on another origin. Progress, a startup timeout, a download stall detector and readable error messages are built in.

Output is H.264 + AAC, 30 fps at most, split into 60-second parts in order. Videos over 700 MB are refused because phone browsers run out of memory.

## Known limits

- Music from streaming apps (Spotify, Apple Music) is protected and cannot be picked; use files saved on the phone. Only use music you have the right to use.
- The waveform is skipped for audio files over 40 MB or when the browser cannot decode them; the start slider still works.
- Tested: every FFmpeg command (video, crop, blurred sides, text, watermark, music start, photo to video) was run with desktop FFmpeg and checked with ffprobe, and the whole page was driven in a scripted mobile browser with a stand-in engine. It has not yet been run with the real WebAssembly core on a phone, so report any error shown under "Details".
