# TTSForX

https://github.com/user-attachments/assets/7249ef03-bd47-49cc-be41-46d8ea82a5ec

TTSForX reads posts on X aloud in your browser. It uses the official
[Supertonic 3](https://huggingface.co/Supertone/supertonic-3) model through
WebGPU. Speech, generated audio, and caption timing stay on your device.

## What it does

- Includes all ten Supertonic 3 voices.
- Reads regular posts, long posts, Notes, and Articles.
- Lets you change the voice, speed, volume, and generation quality.
- Supports pause, resume, restart, voice previews, and switching voices while
  a post is playing.
- Can start at any word in a post.
- Shows karaoke captions that follow the generated audio.

The caption timing comes from audio alignment, not a character-count estimate.
Whisper Tiny aligns the known words to the generated PCM, and the captions
follow the browser's audio clock during playback.

## Install

1. Download `tts-for-x-0.2.0-chrome.zip` from the
   [latest release](https://github.com/1trymes/TTSForX/releases/latest).
2. Extract the ZIP.
3. Open `chrome://extensions`.
4. Turn on Developer mode.
5. Click Load unpacked and choose the extracted folder.

The first use downloads the pinned model files from Hugging Face. Chrome caches
them for later sessions. You need a Chromium browser with WebGPU support.

## Build from source

```bash
npm install
npm run typecheck
npm test
npm run build
```

Load `.output/chrome-mv3` from `chrome://extensions`. For local development,
run `npm run dev`.

The build check verifies the extension policy, packaged WebAssembly runtime,
icons, and WebGPU-only inference setup.

## Privacy and licenses

The [privacy policy](PRIVACY.md) explains what the extension reads and stores.
You can report problems through
[GitHub Issues](https://github.com/1trymes/TTSForX/issues) or support the
project on [Ko-fi](https://ko-fi.com/trymes).

The extension source uses the [MIT License](LICENSE). The Supertonic 3 model
uses OpenRAIL-M. Other dependency licenses are listed in
[THIRD_PARTY_NOTICES.txt](public/THIRD_PARTY_NOTICES.txt).
