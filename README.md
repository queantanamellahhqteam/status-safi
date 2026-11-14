# STATUS SAFI

Prepare videos and photos for WhatsApp Status, entirely on the device. Nothing is uploaded.

## Install

Upload these four files to the root of the GitHub Pages repository, replacing the existing ones:

- `index.html`
- `style.css`
- `app.js`
- `README.md`

Commit, then open the site in Safari (iPhone) or Chrome (Android). The page links to `style.css?v=4` and `app.js?v=4`, so an old cached copy is not mixed with the new page. If something still looks wrong, reload or use a private tab.

## Video editor

After choosing a video you get these tabs:

- **Crop**: Original, 9:16 Status, 4:5 or 1:1. For a shape that does not match the video you can *Fill* (crop the edges, with a slider to move the crop) or *Fit* (keep the whole picture over a blurred copy).
- **Trim**: choose the start and end of the part you want to keep.
- **Text**: type text (emoji and Swahili work), pick colour, size and position, with an optional dark box. The preview shows exactly what is burned into the video.
- **Music**: pick an MP3, M4A or WAV saved on the phone. Mix it with the original sound or replace it, and set its volume. The music repeats if it is short and continues across split parts.
- **Caption**: written here, copied with one tap, and sent along when the phone's share menu accepts it.

Output is H.264 + AAC (HD 720p by default, 540p and 1080p available), 30 fps at most, split into 60-second parts in order. Videos over 700 MB are refused because phone browsers run out of memory.

## Sharing to WhatsApp Status

A website cannot post a Status for you. The most it can do is open the phone's share menu with the finished file:

1. Tap **Share** (or **Share all parts**).
2. If the menu has **My Status**, tap it. Otherwise choose **WhatsApp**, then **My Status**.
3. WhatsApp always compresses a Status again when it is posted, so some softness can remain. The video is prepared at 720p with a controlled bitrate to keep as much detail as possible.

The caption is passed on only when WhatsApp accepts it from the share menu. If the caption box is empty in WhatsApp, use **Copy caption** and paste it.

## Photos

Photos are shared as the original file, without resizing or recompression. Send as a document if you want to avoid WhatsApp's image compression.

## How the video engine works

The page downloads only the FFmpeg core (`@ffmpeg/core@0.12.10`, single-thread build, about 30 MB, once) from jsDelivr, with unpkg as a fallback. It runs in a Web Worker created from a Blob on the site's own origin, because browsers (Safari especially) refuse to start a worker whose script is on another origin. Progress, a startup timeout, a download stall detector and readable error messages are built in.

## Known limits

- Processing is slow on phones, often several minutes for a one-minute video. Keep the page open and the screen on.
- Music from streaming apps (Spotify, Apple Music) is protected and cannot be picked; use files saved on the phone. Only use music you have the right to use.
- The editor was tested in a scripted browser with a stand-in engine, and its filter graphs were run with desktop FFmpeg. It has not yet been run with the real WebAssembly core on a phone, so report any error shown under "Details".
