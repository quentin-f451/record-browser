// Navigateur de capture pour le portfolio.
// Bureau : la page couvre exactement l'écran, sans barre de titre ni coins
// arrondis, et la barre des menus et le Dock se masquent.
// Mobile : fenêtre sans bordure à la taille demandée, avec écran tactile émulé.
// Cmd+S : capture d'écran · Cmd+E : démarrer / arrêter une vidéo (capture.mjs)
import { app, BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, DESKTOP } from './args.mjs'
import { setupCapture, notify } from './capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const { url, size, out } = parseArgs(process.argv.slice(2))

// Rendu en sRGB : captures et vidéos ont les mêmes valeurs de couleur que
// les CSS et les images du site (sinon Chromium rend dans l'espace couleur
// de l'écran, P3 sur un Mac récent, et les fichiers n'ont pas de profil)
app.commandLine.appendSwitch('force-color-profile', 'srgb')

// Émule un écran tactile, comme le mode appareil des DevTools : la souris
// devient un doigt. La déplacer ne déclenche plus de survol (:hover), un clic
// devient un tap (le survol reste alors sur l'élément touché, comme sur un
// téléphone), et le site se croit sur un appareil tactile ('ontouchstart',
// navigator.maxTouchPoints, @media (hover: none) et (pointer: coarse)).
// Le défilement au trackpad marche toujours ; cliquer-glisser fait défiler
// comme un doigt.
async function emulateTouch(contents) {
  const cdp = contents.debugger
  cdp.attach('1.3')
  await cdp.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })
  // À chaque page chargée, la souris « vue » par la page est placée hors de
  // la fenêtre, pour qu'aucun élément ne démarre en état de survol
  contents.on('did-finish-load', () => {
    cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: -100, y: -100 })
      .catch(() => {})
  })
}

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay()
  const screenBounds = display.bounds // en points

  // La page a toujours la même taille, quel que soit l'écran : 1680×1050 pt
  // en bureau, 506×900 pt en mobile (3360×2100 et 1012×1800 px sur un écran
  // Retina). Si l'écran fait exactement 1680×1050, le bureau occupe tout
  // l'écran ; sinon la fenêtre est centrée.
  const page = size || DESKTOP
  const fillsScreen = !size && screenBounds.width === DESKTOP.width && screenBounds.height === DESKTOP.height
  const bounds = {
    width: page.width,
    height: page.height,
    x: screenBounds.x + Math.max(0, Math.round((screenBounds.width - page.width) / 2)),
    // mobile : 60 pt sous le haut de l'écran (sous la barre des menus) ;
    // bureau : centré verticalement
    y: screenBounds.y + (size ? 60 : Math.max(0, Math.round((screenBounds.height - page.height) / 2))),
  }

  const win = new BrowserWindow({
    ...bounds,
    frame: false,                 // pas de barre de titre
    roundedCorners: false,        // fenêtre « borderless » : coins carrés
    enableLargerThanScreen: true, // la fenêtre va exactement où on la place
    backgroundColor: '#fff',
    // bureau : copie du curseur dans la page pendant les vidéos (capture.mjs)
    webPreferences: size ? {} : { preload: path.join(HERE, 'cursor-preload.cjs') },
  })

  // Bureau sur un écran 1680×1050 : plein écran « simple » (façon pré-Lion).
  // La barre des menus et le Dock se masquent tant que la fenêtre est au
  // premier plan, sans nouvel espace ni bande de titre cachée.
  if (fillsScreen) win.setSimpleFullScreen(true)

  // Prévenir si les captures n'auront pas la taille habituelle
  const [contentWidth, contentHeight] = win.getContentSize()
  const sf = display.scaleFactor
  const expected = `${page.width * 2}×${page.height * 2}`
  const actual = `${contentWidth * sf}×${contentHeight * sf}`
  const tooSmall = bounds.x + bounds.width > screenBounds.x + screenBounds.width ||
    bounds.y + bounds.height > screenBounds.y + screenBounds.height
  const advice = 'Choisissez « Plus d\'espace » dans Réglages Système > Moniteurs.'
  if (actual !== expected) {
    notify('Taille de capture différente', `Les captures feront ${actual} px au lieu de ${expected}` +
      (sf !== 2 ? ' (écran non Retina).' : ` (écran de ${screenBounds.width}×${screenBounds.height} pt). ${advice}`))
  } else if (tooSmall) {
    notify('Écran trop petit', `La page (${page.width}×${page.height} pt) dépasse de l'écran ` +
      `(${screenBounds.width}×${screenBounds.height} pt) : les captures sont justes, mais une partie ` +
      `de la page n'est pas visible. ${advice}`)
  }

  // Captures sur le Bureau, numérotées à la suite du dossier d'où `rec` a été lancé
  setupCapture({ win, outDir: out || process.cwd(), type: size ? 'mobile' : 'desktop' })

  // Masque les barres de défilement
  win.webContents.on('dom-ready', () => {
    win.webContents.insertCSS(
      'html { scrollbar-width: none } ::-webkit-scrollbar { display: none }'
    )
  })

  if (size) {
    // Le débogueur a besoin d'une page déjà chargée : on charge une page vide,
    // on active le tactile, puis on charge le site (l'émulation est conservée)
    await win.loadURL('about:blank')
    await emulateTouch(win.webContents)
      .catch(error => console.error('Émulation tactile impossible :', error))
  }

  // Les liens target="_blank" s'ouvrent dans la même fenêtre (pages web
  // seulement : un site ne peut pas faire ouvrir un fichier local)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) win.loadURL(url)
    return { action: 'deny' }
  })

  // Cmd+[ / Cmd+] : page précédente / suivante (Cmd+R recharge, Cmd+Q quitte)
  win.webContents.on('before-input-event', (event, input) => {
    if (!input.meta || input.type !== 'keyDown') return
    const nav = win.webContents.navigationHistory
    if (input.key === '[') { nav.goBack(); event.preventDefault() }
    if (input.key === ']') { nav.goForward(); event.preventDefault() }
  })

  win.loadURL(url)
})

app.on('window-all-closed', () => app.quit())
