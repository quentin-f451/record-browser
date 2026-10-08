// Captures de la page elle-même, sans enregistrer l'écran :
//   Cmd+S  capture d'écran → image-<desktop|mobile>-<n>.png
//   Cmd+E  démarre / arrête une vidéo → video-<desktop|mobile>-<n>.mp4
// Un petit son confirme chaque fichier enregistré.
// Les fichiers vont sur le Bureau. Les numéros suivent ceux déjà présents sur
// le Bureau et dans le dossier d'où `rec` a été lancé, donc un fichier déplacé
// du Bureau vers le projet n'écrase rien (noms attendus par resize-media-q.sh).
// Ni point violet, ni autorisation « Enregistrement de l'écran » : l'image
// vient directement du moteur de rendu, à la taille exacte de la page.
//
// Curseur : jamais dans les captures d'écran ni les vidéos mobiles ; toujours
// dans les vidéos bureau.
//   Vidéo bureau  : capture d'onglet de Chromium (fenêtre cachée recorder.html).
//                   Chromium y dessine lui-même le vrai curseur, mais seulement
//                   pendant que la souris bouge (il le cache après 2 s
//                   d'immobilité et ne le remontre qu'après 15 px). Dans ces
//                   moments-là, une copie identique est affichée dans la page
//                   (cursor-preload.cjs) : le curseur ne disparaît jamais.
//   Vidéo mobile  : images du moteur de rendu envoyées à ffmpeg, sans curseur
//                   (la capture d'onglet y dessinerait le rond gris du tactile).
import { app, BrowserWindow, ipcMain, Notification, screen, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareCursors, cursorSprite } from './cursors.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Mettre à false pour enregistrer dans le dossier d'où `rec` a été lancé
const SAVE_ON_DESKTOP = true

// Petit son quand un fichier est enregistré (sons du système macOS ; le
// premier qui existe). Mettre à null pour couper le son.
const SOUNDS = {
  image: ['/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif',
    '/System/Library/Sounds/Tink.aiff'],
  video: ['/System/Library/Sounds/Glass.aiff'],
}
const SOUND_VOLUME = 0.6 // 0 à 1

// Chromium étiquette ses vidéos en matrice YUV BT.709 même quand il les a
// codées en BT.601 (constaté sous Linux). À la fin de chaque vidéo bureau, on
// compare sa première image à une capture d'écran prise au même moment pour
// savoir laquelle des deux il a vraiment utilisée, et on l'écrit dans le
// fichier. Le résultat est retenu dans .video-matrix, pour les vidéos dont
// l'image de départ n'a pas assez de couleur pour trancher.
const MATRICES = ['bt709', 'smpte170m']
const H264_MATRIX = { bt709: 1, smpte170m: 6 }
const MATRIX_FILE = path.join(HERE, '.video-matrix')

// Permissions que les sites n'obtiennent pas (Electron les accorde toutes
// par défaut). Seul notre enregistreur (page locale file://) a droit à
// 'media', et seulement pendant qu'on lance un enregistrement.
const BLOCKED_FOR_SITES = new Set(['media', 'display-capture', 'geolocation',
  'notifications', 'midiSysex', 'hid', 'serial', 'usb'])

export function setupCapture({ win, outDir, type }) {
  let recorder = null // fenêtre cachée qui fait tourner MediaRecorder (bureau)
  let rec = null      // enregistrement en cours
  const saveDir = SAVE_ON_DESKTOP ? app.getPath('desktop') : outDir

  const isRecorder = contents => !!recorder && !recorder.isDestroyed() && contents === recorder.webContents
  // La demande de capture d'onglet arrive au nom de la page filmée, mais avec
  // l'origine de l'enregistreur (file://)
  const allowed = (permission, origin) => !BLOCKED_FOR_SITES.has(permission) ||
    (permission === 'media' && rec?.state === 'starting' && String(origin).startsWith('file://'))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(isRecorder(contents) || allowed(permission, details?.securityOrigin)))
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) =>
    isRecorder(contents) || allowed(permission, origin))

  // ---- Raccourcis (seulement quand la fenêtre est au premier plan)
  win.webContents.on('before-input-event', (event, input) => {
    if (!input.meta || input.shift || input.alt || input.control || input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 's') { event.preventDefault(); screenshot() }
    if (key === 'e') { event.preventDefault(); toggleRecording() }
  })

  // ---- Copie du curseur pour les vidéos bureau
  const cursor = type === 'desktop' ? cursorCopy(win) : null

  // ---- Capture d'écran (jamais de curseur)
  async function screenshot() {
    try {
      await cursor?.hideForScreenshot()
      const image = await withTimeout(win.webContents.capturePage(), 5000)
      cursor?.restore()
      const file = nextFile('image', 'png', saveDir)
      fs.writeFileSync(file, image.toPNG())
      playSound('image')
      const { width, height } = image.getSize()
      notify('Capture enregistrée', `${path.basename(file)} · ${width}×${height}`)
    } catch (error) {
      cursor?.restore()
      notify('Capture impossible', String(error.message || error))
    }
  }

  // ---- Vidéo
  function toggleRecording() {
    if (!rec) (type === 'mobile' ? startFrames() : startTabCapture())
    else if (rec.state === 'recording') stopRecording()
  }

  function stopRecording() {
    rec.state = 'stopping'
    if (rec.mode === 'frames') stopFrames()
    else recorder.webContents.send('rec:stop')
  }

  function recordingStarted(file) {
    app.dock?.setBadge('●')
    notify('Enregistrement…', `${path.basename(file)} · Cmd+E pour arrêter`)
  }

  function recordingDone(r, error) {
    rec = null
    app.dock?.setBadge('')
    const seconds = ((Date.now() - r.started) / 1000).toFixed(1)
    if (error) notify('Vidéo : problème', `${path.basename(r.file)} · ${error.split('\n')[0]}`)
    else {
      playSound('video')
      notify('Vidéo enregistrée', `${path.basename(r.file)} · ${r.width}×${r.height} · ${seconds} s`)
    }
    r.onDone?.()
  }

  // ---- Mobile : chaque image du moteur de rendu part vers ffmpeg
  function startFrames() {
    const file = nextFile('video', 'mp4', saveDir)
    const r = rec = {
      mode: 'frames', state: 'recording', file, width: 0, height: 0,
      tmp: path.join(saveDir, `.${path.basename(file)}.part`), started: Date.now(),
      ffmpeg: null, last: null, stderr: '',
    }
    recordingStarted(file)
    win.webContents.beginFrameSubscription(false, image => {
      if (rec !== r || r.state !== 'recording') return
      const { width, height } = image.getSize()
      if (!r.ffmpeg) {
        r.width = width
        r.height = height
        r.ffmpeg = spawn(findFfmpeg(), frameEncoderArgs(width, height, r.tmp), { stdio: ['pipe', 'ignore', 'pipe'] })
        r.ffmpeg.stderr.on('data', chunk => { r.stderr += chunk })
        r.ffmpeg.stdin.on('error', () => {})
        r.exited = new Promise(resolve => {
          r.ffmpeg.on('exit', code => resolve(code))
          r.ffmpeg.on('error', error => { r.stderr += `ffmpeg introuvable : ${error.message}`; resolve(-1) })
        })
      }
      if (width !== r.width || height !== r.height) return
      r.last = image.toBitmap()
      // ffmpeg en retard : on saute l'image plutôt que d'accumuler en mémoire
      if (!r.ffmpeg.stdin.writableNeedDrain) r.ffmpeg.stdin.write(r.last)
    })
    // Page immobile : Chromium n'envoie d'image qu'au prochain changement
    win.webContents.invalidate()
  }

  async function stopFrames() {
    const r = rec
    win.webContents.endFrameSubscription()
    let error = null
    if (!r.ffmpeg) error = 'aucune image reçue'
    else {
      if (r.last) r.ffmpeg.stdin.write(r.last) // dernière image tenue jusqu'à l'arrêt
      r.ffmpeg.stdin.end()
      const code = await r.exited
      if (code === 0) fs.renameSync(r.tmp, r.file)
      else error = r.stderr.trim() || `ffmpeg a échoué (${code})`
    }
    recordingDone(r, error)
  }

  // ---- Bureau : capture d'onglet dans la fenêtre cachée recorder.html
  async function startTabCapture() {
    const sf = screen.getDisplayMatching(win.getBounds()).scaleFactor
    const [w, h] = win.getContentSize()
    const width = Math.round(w * sf)
    const height = Math.round(h * sf)
    rec = { mode: 'tab', state: 'starting', width, height }
    cursor?.start() // présente dès la première image
    try {
      if (!recorder || recorder.isDestroyed()) {
        recorder = new BrowserWindow({
          show: false,
          webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
        })
        // Elle a accès à Node : elle ne doit jamais afficher autre chose
        recorder.webContents.on('will-navigate', event => event.preventDefault())
        recorder.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        await recorder.loadFile(path.join(HERE, 'recorder.html'))
      }
      recorder.webContents.send('rec:start', {
        sourceId: win.webContents.getMediaSourceId(recorder.webContents),
        width,
        height,
        // ~0,12 bit par pixel à 60 i/s : ≈ 50 Mb/s en 3360×2100, au moins 20 Mb/s
        bitrate: bitrateFor(width, height),
      })
    } catch (error) {
      cursor?.stop()
      rec = null
      notify('Enregistrement impossible', String(error.message || error))
    }
  }

  ipcMain.on('rec:started', async (event, mimeType) => {
    if (!isRecorder(event.sender) || !rec) return
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
    rec.file = nextFile('video', ext, saveDir)
    rec.tmp = path.join(saveDir, `.${path.basename(rec.file)}.part`)
    rec.stream = fs.createWriteStream(rec.tmp)
    rec.started = Date.now()
    rec.state = 'recording'
    recordingStarted(rec.file)
    // Image de référence pour reconnaître la matrice YUV (voir detectMatrix)
    const reference = await win.webContents.capturePage().catch(() => null)
    if (rec) rec.reference = reference
  })

  ipcMain.on('rec:chunk', (event, data) => {
    if (isRecorder(event.sender) && rec?.stream) rec.stream.write(Buffer.from(data))
  })

  ipcMain.on('rec:stopped', event => {
    if (isRecorder(event.sender) && rec?.stream) rec.stream.end(() => finishTabCapture())
  })

  ipcMain.on('rec:error', (event, message) => {
    if (!isRecorder(event.sender)) return
    cursor?.stop()
    rec?.stream?.destroy()
    rec = null
    app.dock?.setBadge('')
    notify('Enregistrement impossible', message)
  })

  // Remet le fichier d'aplomb : MP4 classique (non fragmenté, qui commence
  // à 0) et bonnes étiquettes de couleur (valeurs sRGB)
  async function finishTabCapture() {
    cursor?.stop()
    const r = rec
    let matrix = r.reference && await detectMatrix(r.tmp, r.reference).catch(() => null)
    if (matrix) fs.writeFileSync(MATRIX_FILE, matrix)
    else matrix = readMatrix()
    const error = await remux(r.tmp, r.file, matrix)
    if (error) fs.renameSync(r.tmp, r.file)
    else fs.unlinkSync(r.tmp)
    recordingDone(r, error && `couleurs non étiquetées (${error})`)
  }

  // Quitter pendant un enregistrement : on termine proprement d'abord
  app.on('before-quit', event => {
    if (!rec) return
    event.preventDefault()
    rec.onDone = () => app.quit()
    if (rec.state === 'recording') stopRecording()
  })

  // ---- Outils
  // Prochain numéro libre, en regardant le dossier et le Bureau
  function nextFile(kind, ext, saveDir) {
    const pattern = new RegExp(`^${kind}-${type}-(\\d+)\\.`)
    let max = 0
    for (const dir of new Set([outDir, app.getPath('desktop'), saveDir])) {
      let names = []
      try { names = fs.readdirSync(dir) } catch {}
      for (const name of names) {
        const match = name.match(pattern)
        if (match) max = Math.max(max, Number(match[1]))
      }
    }
    return path.join(saveDir, `${kind}-${type}-${max + 1}.${ext}`)
  }
}

// Copie du curseur dans la page (cursor-preload.cjs), affichée seulement
// quand Chromium ne dessine pas le sien dans la capture. On reproduit pour
// cela la règle de Chromium (MouseCursorOverlayController) : son curseur
// apparaît une fois la souris déplacée de plus de 15 pt, ou après un clic, et
// disparaît après 2 s sans mouvement. Les deux ont la même image et la même
// position, donc le passage de l'un à l'autre ne se voit pas.
function cursorCopy(win) {
  const contents = win.webContents
  const MIN_MOVE = 15     // pt
  // Chromium cache son curseur après 2 s : la copie revient un peu avant, au
  // même endroit et avec la même image, pour qu'il n'y ait aucun trou
  const IDLE = 1850       // ms
  let type = 'pointer'    // la flèche
  let custom = null
  let customId = 0
  let timer = null
  let phase = 'still'     // still → starting → moving → still
  let start = null
  let previous = null
  let lastMove = 0
  let shown = null
  let paused = false

  prepareCursors()
  contents.on('cursor-changed', (_event, cursor, image, imageScale, size, hotspot) => {
    type = cursor
    custom = cursor === 'custom' ? { id: ++customId, image, imageScale, size, hotspot } : null
    if (timer) sendSprite()
  })
  // Nouvelle page pendant un enregistrement : on y remet la copie
  contents.on('dom-ready', () => {
    if (!timer) return
    sendSprite()
    sendPosition()
    contents.send('cursor:active', true)
    shown = null
    update()
  })
  ipcMain.on('cursor:click', event => {
    if (event.sender !== contents || !timer) return
    phase = 'moving'
    lastMove = Date.now()
    update()
  })

  function sendSprite() {
    contents.send('cursor:sprite', cursorSprite(type, 1 / contents.getZoomFactor(), custom))
  }

  // Position de départ (ensuite, la page suit la souris elle-même)
  function sendPosition() {
    const point = screen.getCursorScreenPoint()
    const bounds = win.getContentBounds()
    const zoom = contents.getZoomFactor()
    contents.send('cursor:at', {
      x: (point.x - bounds.x) / zoom,
      y: (point.y - bounds.y) / zoom,
      inside: point.x >= bounds.x && point.y >= bounds.y &&
        point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height,
    })
  }

  function poll() {
    const point = screen.getCursorScreenPoint()
    const now = Date.now()
    if (previous && (point.x !== previous.x || point.y !== previous.y)) {
      if (phase === 'still') {
        phase = 'starting'
        start = point
      } else if (phase === 'starting') {
        if (Math.abs(point.x - start.x) > MIN_MOVE || Math.abs(point.y - start.y) > MIN_MOVE) {
          phase = 'moving'
          lastMove = now
        }
      } else lastMove = now
    }
    previous = point
    if (phase === 'moving' && now - lastMove > IDLE) phase = 'still'
    update()
  }

  function update() {
    const visible = !paused && phase !== 'moving'
    if (visible === shown) return
    shown = visible
    contents.send('cursor:show', visible)
  }

  return {
    start() {
      phase = 'still'
      previous = null
      shown = null
      sendSprite()
      sendPosition()
      contents.send('cursor:active', true)
      timer = setInterval(poll, 1000 / 60)
      poll()
    },
    stop() {
      clearInterval(timer)
      timer = null
      contents.send('cursor:active', false)
    },
    // Capture d'écran pendant une vidéo : la copie disparaît le temps que la
    // page affiche une image sans elle
    async hideForScreenshot() {
      if (!timer) return
      paused = true
      update()
      await contents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    },
    restore() {
      paused = false
      if (timer) update()
    },
  }
}

function bitrateFor(width, height) {
  return Math.max(20e6, Math.round(width * height * 60 * 0.12))
}

// Vidéo mobile : images BGRA (valeurs sRGB) → H.264 en BT.709, étiqueté sRGB.
// Encodeur matériel sur Mac. Horodatage à l'arrivée de chaque image : une
// page immobile ne produit pas d'image, la précédente reste affichée.
function frameEncoderArgs(width, height, output) {
  const encoder = process.platform === 'darwin'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', String(bitrateFor(width, height)), '-profile:v', 'high']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14']
  return ['-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`,
    '-use_wallclock_as_timestamps', '1', '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    ...encoder,
    '-fps_mode', 'passthrough',
    '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-f', 'mp4', output]
}

function readMatrix() {
  try {
    const saved = fs.readFileSync(MATRIX_FILE, 'utf8').trim()
    if (MATRICES.includes(saved)) return saved
  } catch {}
  return 'smpte170m' // ce que Chromium fait sous Linux
}

// Décode la première image de la vidéo avec chaque matrice et garde celle qui
// redonne les couleurs de la capture d'écran. Seuls les pixels colorés
// comptent : les gris sont identiques avec les deux matrices.
async function detectMatrix(video, reference) {
  const { width, height } = reference.getSize()
  const w = 320
  const h = Math.round((height * w) / width / 2) * 2
  const ref = reference.resize({ width: w, height: h, quality: 'good' }).toBitmap() // BGRA
  const errors = {}
  for (const matrix of MATRICES) {
    const rgb = await ffmpegFrame(video, matrix, w, h)
    if (rgb.length !== w * h * 3) return null
    let sum = 0
    let count = 0
    for (let i = 0; i < w * h; i++) {
      const b = ref[i * 4], g = ref[i * 4 + 1], r = ref[i * 4 + 2]
      if (Math.max(r, g, b) - Math.min(r, g, b) < 40) continue
      sum += Math.abs(rgb[i * 3] - r) + Math.abs(rgb[i * 3 + 1] - g) + Math.abs(rgb[i * 3 + 2] - b)
      count++
    }
    if (count < 500) return null // pas assez de couleur pour trancher
    errors[matrix] = sum / count
  }
  return errors.smpte170m < errors.bt709 ? 'smpte170m' : 'bt709'
}

// Les fichiers de MediaRecorder peuvent contenir une « liste d'édition » qui
// cache presque toute la vidéo (constaté sur Mac) : on l'ignore partout.
function ffmpegFrame(video, matrix, w, h) {
  const filter = `scale=${w}:${h}:flags=area:in_color_matrix=${matrix === 'smpte170m' ? 'bt601' : 'bt709'}` +
    ':in_range=tv:out_range=pc,format=rgb24'
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(findFfmpeg(), ['-v', 'error', '-ignore_editlist', '1', '-i', video,
      '-frames:v', '1', '-vf', filter, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    ffmpeg.stdout.on('data', chunk => chunks.push(chunk))
    ffmpeg.on('error', reject)
    ffmpeg.on('exit', () => resolve(Buffer.concat(chunks)))
  })
}

function remux(input, output, matrix) {
  const mp4 = output.endsWith('.mp4')
  const args = ['-v', 'error', '-y', '-ignore_editlist', '1', '-i', input, '-c', 'copy',
    ...(mp4 ? ['-bsf:v', `h264_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients=${H264_MATRIX[matrix]}`] : []),
    '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', matrix,
    '-avoid_negative_ts', 'make_zero',
    ...(mp4 ? ['-use_editlist', '0', '-movflags', '+faststart'] : []),
    output]
  return new Promise(resolve => {
    const ffmpeg = spawn(findFfmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    ffmpeg.stderr.on('data', chunk => { stderr += chunk })
    ffmpeg.on('error', error => resolve(`ffmpeg introuvable : ${error.message}`))
    ffmpeg.on('exit', code => resolve(code === 0 ? null : stderr.trim() || `ffmpeg a échoué (${code})`))
  })
}

function findFfmpeg() {
  const dirs = [...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) {
    const candidate = path.join(dir, 'ffmpeg')
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch {}
  }
  return 'ffmpeg'
}

function playSound(kind) {
  if (!SOUNDS?.[kind]) return
  if (process.platform !== 'darwin') return shell.beep()
  const file = SOUNDS[kind].find(candidate => fs.existsSync(candidate))
  if (file) spawn('afplay', ['-v', String(SOUND_VOLUME), file], { stdio: 'ignore', detached: true }).unref()
}

export function notify(title, body) {
  console.log(`${title} : ${body}`)
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('la page ne répond pas')), ms))])
}
