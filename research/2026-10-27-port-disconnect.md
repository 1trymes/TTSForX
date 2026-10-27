# Back/forward cache port error

Helium reported `Unchecked runtime.lastError: The page keeping the extension
port is moved into back/forward cache, so the message channel is closed.`
The browser supplied no stack or context. This can happen when Chromium closes
the content connection during navigation. The disconnect listeners did not
read `runtime.lastError`, so Chromium could report the expected closure as an
unchecked error. They now acknowledge it before applying their normal cleanup.

Stopping an idle engine no longer opens a new port solely to send a cancel.
On return from the back/forward cache, prefetch can resume after a connection
loss; a new foreground request reconnects on demand. Automated tests cover
cleanup, reconnection, and resumed prefetch. The Chromium and Firefox builds
were checked. The rebuilt extension was reloaded in Helium; its controls
appeared on X and a test request reached the playing state. The cache
transition itself was not reproduced in a live extension.
