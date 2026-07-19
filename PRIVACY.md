# TTSForX privacy policy

Effective: July 19, 2026

TTSForX reads text from X and turns it into speech in your browser. Post text,
generated audio, and caption timing stay on your device.

## What the extension reads

TTSForX reads the post you play. It may also read nearby visible posts so the
next one can start sooner.

The browser stores your voice, speed, volume, quality, and caption settings.
Recently generated audio may remain in memory until the extension or browser
session ends.

## Network requests

The first use downloads model files, tokenizers, configuration files, and voice
data from Hugging Face. The browser caches those files. The extension downloads
them again only if the pinned model version changes or the cache is cleared.

These requests do not include post text, generated audio, or caption timing.
TTSForX does not call a remote text-to-speech service.

## Data collection

TTSForX has no analytics, ads, accounts, or tracking. It does not collect,
transmit, sell, or share your posts, browsing history, audio, captions, or
settings.

## Storage and deletion

Your settings remain in local extension storage until you clear them or
uninstall TTSForX. Model files remain in the browser cache until you clear the
cache or uninstall the extension. Generated speech stays in a limited memory
cache and is not uploaded.

## Code and model files

The extension packages all executable JavaScript and WebAssembly. Files
downloaded from Hugging Face contain model data used by that packaged code.

## Contact

Policy changes will update the effective date above. Questions and bug reports
belong in [GitHub Issues](https://github.com/1trymes/TTSForX/issues).
