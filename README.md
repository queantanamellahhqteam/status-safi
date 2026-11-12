# STATUS SAFI

Prepare videos and photos for WhatsApp Status, entirely on the device.

## Files

Upload all four files to the root of the GitHub Pages repository, replacing the existing ones:

- `index.html`
- `style.css`
- `app.js`
- `README.md`

Commit, then open the site in Safari (iPhone) or Chrome (Android). If an old version is still cached, reload the page or use a private tab.

## What changed in this version

**Text visibility.** The interface was redesigned with solid colours, larger type and no blur, transparency or gradients behind text. Every text/background pair is at least 4.5:1 contrast. The page declares `color-scheme: light`, so browsers' automatic dark mode cannot invert colours and hide text. Fonts come from the system, so nothing is loaded from Google Fonts.

**Stuck at 10%.** The video engine used to load FFmpeg's worker from a CDN. Browsers, Safari in particular, silently refuse to start a worker from another origin, so loading never finished. The page no longer uses the `@ffmpeg/ffmpeg` wrapper. It downloads only the FFmpeg core (`@ffmpeg/core@0.12.10`, single-thread build) and runs it in a worker created from a Blob on the site's own origin. Also new:

- real download progress for the engine (about 30 MB, one time), with an automatic fallback from jsDelivr to unpkg
- a 90-second startup timeout and a stall detector, with an error message that includes technical details
- the video file is read directly by the worker instead of being copied into memory first
- an elapsed-time counter, and the screen is kept awake while processing (where supported)
- a **Save** button next to **Share** for browsers that cannot share files

## Behaviour

- Videos over 60 seconds are split into consecutive 60-second parts, in order. The original aspect ratio and orientation are kept.
- Photos are shared as the original file, without resizing or recompression. Send them as a document in WhatsApp to avoid its image compression.
- Processing is local and needs internet only to download the video engine the first time.
- Mobile browsers have memory limits. Very large videos may fail; the page then shows a clear message.
