# Grok-authored post speaker placement

## Live evidence

Inspected the user's existing Helium tab at
<https://x.com/grok/status/2120180859093315787?s=20> on 2026-11-12.
The browser connection identifies itself as Chrome, while the native window
inventory identifies the same page as Helium.

The parent post and ordinary replies had their speaker in the top-right
actions row, immediately before Grok actions and More. The Grok-authored
status had one speaker in its engagement row, before Bookmark, rather than
in its header. A screenshot and read-only DOM inspection confirmed this:

- Both posts used `article[data-testid="tweet"]`, `tweetText`, and `caret`.
- Grok's avatar and author links had `href="/grok"` and preceded its
  `button[aria-label="Grok actions"]` in document order.
- The compact header row contained the real Grok actions button and the
  nested More button, without `User-Name` or `tweetText` descendants.

This was a misplaced control, not an author-specific text-extraction failure
or a completely absent speaker on the inspected page.

## Cause and change

`findGrokButton` scanned the entire post and returned the first link or
button whose accessible label or href contained "grok". On Grok's own
posts, this returned a profile/avatar link instead of the Grok action.
`findGrokCaretRow` could not find a compact actions-only ancestor containing
both that profile link and More: their common ancestor included `User-Name`
and was correctly rejected. Mounting therefore fell back to the engagement
row.

The lookup now searches inside each safe candidate actions row while walking
up from More. Author and body containers remain excluded. This preserves the
existing controls, modern SVG-symbol layout, compact-post fallback, and
late-header migration behavior while preventing profile links elsewhere in
the post from masking the real action.

## Verification

Added DOM regression coverage mirroring the relevant live structure:

- Grok profile/avatar links preceding its real action, with nested More
  wrappers: mount exactly one header speaker before Grok actions and dispatch
  playback with the post's own text exactly once.
- A delayed Grok action: move the speaker from the engagement row to the
  header after the control arrives, retaining exactly one speaker.
- Grok profile/mention links without a real header action: retain the
  engagement-row fallback.

Before the source fix, the first two regression cases failed at placement
assertions. After the fix:

- `npm test`: 10 files, 101 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: Chrome build and packaged runtime verification passed.

Live verification of the rebuilt extension was attempted but not completed.
The browser-control service stopped on native Helium selection because it
could not determine the current URL confidently. No extension reload or live
page mutation was performed. Playback on the installed extension was not
tested; the click-to-handler path was verified in the DOM tests. Reload the
rebuilt extension and refresh X to use the change locally.
