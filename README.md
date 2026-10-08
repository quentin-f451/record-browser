# rec

A small browser for capturing websites for a portfolio: screenshots and videos at
a fixed size, with no browser interface, no macOS recording indicator, and a
cursor only where you want one.

```bash
rec tectoniques.com        # desktop: 1680×1050 pt page → 3360×2100 px captures
rec -m tectoniques.com     # mobile: 506×900 pt page → 1012×1800 px, touch screen
```

In the window, **Cmd+S** takes a screenshot and **Cmd+E** starts or stops a
video. Files land on the Desktop, with a sound and a notification for each one.

## Install

You need a Mac with a Retina screen, [Node.js](https://nodejs.org) 20 or later,
[pnpm](https://pnpm.io) and [ffmpeg](https://ffmpeg.org) (for videos).

```bash
brew install ffmpeg
git clone <this repository> record
cd record
pnpm install
pnpm link --global          # pnpm 11 and later: pnpm add -g .
```

`pnpm install` downloads Electron (about 100 MB). It's allowed to run its install
script by `pnpm-workspace.yaml`; if pnpm still says *Ignored build scripts*,
run `pnpm approve-builds`, pick electron, then `pnpm rebuild electron`.

If `pnpm link --global` can't find a global bin directory, run `pnpm setup` once
and open a new terminal. `npm link` works too.

The `rec` command points to this folder: after a `git pull` or an edit, the next
`rec` uses the new code. If you move the folder, run the link step again.

## Use

```bash
rec <url>                  # desktop
rec -m <url>               # mobile (506×900 pt)
rec 393x852 <url>          # any page size, in points (mobile behaviour)
rec ./page.html            # a local file works too
```

`https://` is added when missing. The command returns straight away; the window
runs on its own.

| Shortcut      | Action                                  |
| ------------- | --------------------------------------- |
| Cmd+S         | Screenshot                              |
| Cmd+E         | Start / stop a video                    |
| Cmd+[ / Cmd+] | Back / forward                          |
| Cmd+R         | Reload                                  |
| Cmd+Q         | Quit (a running video is saved first)   |

### Files

Captures are saved on the Desktop as `image-desktop-1.png`, `video-mobile-3.mp4`,
and so on. The number continues from the files already on the Desktop **and**
in the folder you ran `rec` from, so you can `cd` into a project folder, capture,
and move the files in without overwriting anything.

| Mode    | Page size  | Captures (Retina) |
| ------- | ---------- | ----------------- |
| desktop | 1680×1050 pt | 3360×2100 px    |
| mobile  | 506×900 pt   | 1012×1800 px    |

The page always has this size, whatever the screen. If the screen is too small or
not Retina, a notification says what size the captures will be; on a smaller
MacBook, choose **More Space** in System Settings › Displays.

### Desktop and mobile

- **Desktop**: on a 1680×1050 screen the page fills the screen and the menu bar
  and Dock hide while the window is in front. On a bigger screen the window is
  centred.
- **Mobile**: the mouse acts like a finger (Chrome DevTools' touch emulation).
  Moving it doesn't trigger hover effects, a click is a tap, click-and-drag
  scrolls, and the site sees a touch device (`ontouchstart`,
  `(hover: none)`, `(pointer: coarse)`). Trackpad scrolling works as usual.

### Cursor

|              | Screenshot | Video  |
| ------------ | ---------- | ------ |
| Desktop      | no         | yes    |
| Mobile       | no         | no     |

## How it works

Captures come from the browser's own rendering, not from recording the screen,
so there is no purple recording dot, no Screen Recording permission, and the
size is always exact.

- **Screenshots**: `webContents.capturePage()`.
- **Desktop videos**: Chromium's tab capture, recorded with `MediaRecorder` in a
  hidden window (`recorder.html`), then remuxed by ffmpeg (clean MP4, correct
  colour tags). Chromium draws the real cursor into this capture while the
  mouse moves, and hides it after 2 s without movement; at those moments a copy
  of the cursor is shown in the page (`cursor-preload.cjs`), so it never
  disappears. The cursor images are the Mac's own, exported once into
  `.cursors/`.
- **Mobile videos**: the page's frames (`beginFrameSubscription`) piped to
  ffmpeg, which avoids the grey touch circle that tab capture would draw.
- **Colours**: everything is rendered and tagged as sRGB, so videos match the
  screenshots and the site's CSS. Chromium mislabels the YUV matrix of its tab
  captures, so each desktop video is checked against a screenshot taken when it
  starts and tagged with the right one (remembered in `.video-matrix`).
  `test-couleurs.html` is a page of known colours to check this.
- Websites opened in `rec` can't use the camera, microphone, location or
  notifications (Electron allows them by default).

## Settings

At the top of `capture.mjs`:

- `SAVE_ON_DESKTOP`: `false` saves in the folder you ran `rec` from.
- `SOUNDS`, `SOUND_VOLUME`: the confirmation sounds (`SOUNDS = null` for silence).

Page sizes are in `args.mjs` (`DESKTOP`, `MOBILE`).

## Files

| File                 | Role                                                     |
| -------------------- | -------------------------------------------------------- |
| `cli.mjs`            | The `rec` command: launches Electron in the background   |
| `args.mjs`           | Command-line arguments, page sizes                       |
| `rec.mjs`            | The window: size, full screen, touch emulation           |
| `capture.mjs`        | Shortcuts, screenshots, videos, cursor, sounds           |
| `recorder.html`      | Hidden window that records desktop videos                |
| `cursor-preload.cjs` | Draws the cursor copy inside the page (desktop videos)   |
| `cursors.mjs`        | macOS cursor images, with drawn fallbacks                |
| `test-couleurs.html` | Colour test page                                         |

`.cursors/` and `.video-matrix` are caches built on each Mac; they are not in git.

## Troubleshooting

- **`Electron failed to install correctly`**: Electron's install script didn't
  run. `pnpm approve-builds` (pick electron), then `pnpm rebuild electron`.
- **`sandbox_extension_issue_file failed …` in the terminal**: harmless Chromium
  log line (`rec` hides it; you only see it with `pnpm rec`).
- **Nothing happens on Cmd+S / Cmd+E**: the `rec` window must be in front.
- **"couleurs non étiquetées" in a notification**: ffmpeg wasn't found;
  `brew install ffmpeg`.
- **To see errors**, run Electron in the foreground from this folder:
  `pnpm rec <url>`.
