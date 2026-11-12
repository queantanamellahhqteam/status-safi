# STATUS SAFI

A mobile-first video and photo preparation website with a Modern Glass interface.

## Files
- `index.html` — English interface and page structure
- `style.css` — Modern Glass / glassmorphism styling
- `app.js` — navigation, photo sharing, FFmpeg video processing and automatic 60-second splitting

## Publish on GitHub Pages
1. Extract this ZIP.
2. Upload all four files directly into the root of your GitHub repository (not inside another folder).
3. Replace the existing files and commit the changes.
4. Open the GitHub Pages website in Safari and refresh it.

## Video processing notes
- The first video run downloads FFmpeg WebAssembly from jsDelivr, so an internet connection is required.
- Video processing runs in the browser on the user's device. Large files can exceed available mobile memory or take a long time on older phones.
- Videos longer than 60 seconds are split automatically into consecutive 60-second parts.
- Video is re-encoded using H.264/AAC. This can reduce file size, but no re-encoding process can guarantee mathematically lossless quality. WhatsApp may also recompress videos after sharing.
- The interface preserves the original aspect ratio by not forcing a fixed output width or height.

## Photo sharing notes
The original selected image file is shared without resizing or recompression by STATUS SAFI. On iOS, the system share sheet opens; select WhatsApp. To avoid WhatsApp image compression, send the image as a document where WhatsApp offers that option.

## Important
This is an original implementation inspired by common status-preparation workflows. It does not contain or copy proprietary source code from Pure Status. A browser website cannot silently send files into WhatsApp; the user must confirm sharing in the operating system's share sheet.
