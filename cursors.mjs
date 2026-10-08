// Images du curseur pour les vidéos bureau.
// Sur Mac, on reprend les vrais curseurs du système (NSCursor) une fois pour
// toutes, via osascript, dans .cursors/ ; ailleurs, ou si ça échoue, une
// flèche et un I dessinés ici.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CACHE = path.join(HERE, '.cursors')

// Type de curseur tel que le donne Electron → curseur macOS
// ('pointer' est la flèche normale, 'hand' la main des liens)
const MAC_CURSORS = {
  pointer: 'arrowCursor',
  hand: 'pointingHandCursor',
  text: 'IBeamCursor',
  'vertical-text': 'IBeamCursorForVerticalLayout',
  crosshair: 'crosshairCursor',
  grab: 'openHandCursor',
  grabbing: 'closedHandCursor',
  move: 'openHandCursor',
  'not-allowed': 'operationNotAllowedCursor',
  nodrop: 'operationNotAllowedCursor',
  'ew-resize': 'resizeLeftRightCursor',
  'col-resize': 'resizeLeftRightCursor',
  'e-resize': 'resizeLeftRightCursor',
  'w-resize': 'resizeLeftRightCursor',
  'ns-resize': 'resizeUpDownCursor',
  'row-resize': 'resizeUpDownCursor',
  'n-resize': 'resizeUpDownCursor',
  's-resize': 'resizeUpDownCursor',
  copy: 'dragCopyCursor',
  alias: 'dragLinkCursor',
  'context-menu': 'contextualMenuCursor',
}

// Exporte chaque NSCursor en PNG (script JXA exécuté par osascript).
// Deux méthodes : dessin à 2× dans une image bitmap, sinon la représentation
// TIFF de l'image (la plus grande). Les échecs sont notés dans
// .cursors/export.json pour pouvoir comprendre ce qui coince.
const JXA = `
ObjC.import('AppKit')
function drawn(image, size) {
  const w = Math.round(size.width * 2), h = Math.round(size.height * 2)
  if (!(w > 0 && h > 0)) throw new Error('taille ' + size.width + 'x' + size.height)
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, w, h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0)
  if (!rep || rep.isNil()) throw new Error('bitmap impossible')
  rep.setSize(size)
  const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep)
  $.NSGraphicsContext.saveGraphicsState
  $.NSGraphicsContext.setCurrentContext(context)
  image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size.width, size.height), $.NSZeroRect, 2, 1)
  $.NSGraphicsContext.restoreGraphicsState
  return rep.representationUsingTypeProperties(4, $({})) // 4 = PNG
}
function fromTiff(image) {
  const reps = $.NSBitmapImageRep.imageRepsWithData(image.TIFFRepresentation)
  let best = null
  for (let i = 0; i < reps.count; i++) {
    const rep = reps.objectAtIndex(i)
    if (!best || rep.pixelsWide > best.pixelsWide) best = rep
  }
  if (!best) throw new Error('pas de TIFF')
  return best.representationUsingTypeProperties(4, $({}))
}
function run(argv) {
  const dir = argv[0], wanted = JSON.parse(argv[1]), cursors = {}, errors = {}
  for (const name of wanted) {
    const problems = []
    try {
      const cursor = $.NSCursor[name]
      if (!cursor || cursor.isNil()) throw new Error('curseur introuvable')
      const image = cursor.image, size = image.size
      let png = null
      for (const method of [drawn, fromTiff]) {
        try {
          png = method(image, size)
          if (png && !png.isNil()) break
          png = null
        } catch (e) { problems.push(method.name + ' : ' + e) }
      }
      if (!png) throw new Error('aucune image')
      png.writeToFileAtomically(dir + '/' + name + '.png', true)
      cursors[name] = { width: size.width, height: size.height, x: cursor.hotSpot.x, y: cursor.hotSpot.y }
    } catch (e) { problems.push(String(e)) }
    if (problems.length) errors[name] = problems
  }
  return JSON.stringify({ cursors, errors })
}
`

// Repli : flèche noire bordée de blanc, et I, dessinés en SVG (unités = points)
const FALLBACK = {
  default: {
    width: 17, height: 23, x: 1.5, y: 1.5,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="46" viewBox="0 0 17 23">
      <path d="M1.5 1.5v16.2l3.9-3.7 2.6 6.2 2.6-1.1-2.6-6.1h5.5z" fill="#000" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  },
  text: {
    width: 9, height: 18, x: 4.5, y: 9,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="36" viewBox="0 0 9 18">
      <path d="M1.5 1.5h2.2c.4 0 .8.3.8.8 0-.5.4-.8.8-.8h2.2M1.5 16.5h2.2c.4 0 .8-.3.8-.8 0 .5.4.8.8.8h2.2M4.5 2.3v13.4"
        fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M1.5 1.5h2.2c.4 0 .8.3.8.8 0-.5.4-.8.8-.8h2.2M1.5 16.5h2.2c.4 0 .8-.3.8-.8 0 .5.4.8.8.8h2.2M4.5 2.3v13.4"
        fill="none" stroke="#000" stroke-width="1.1" stroke-linecap="round"/></svg>`,
  },
}

let macCursors = null // { name: { width, height, x, y } } une fois exportés

// À appeler au lancement en mode bureau : prépare les curseurs macOS
export function prepareCursors() {
  if (process.platform !== 'darwin') return Promise.resolve()
  try {
    macCursors = JSON.parse(fs.readFileSync(path.join(CACHE, 'cursors.json'), 'utf8'))
    return Promise.resolve()
  } catch {}
  fs.mkdirSync(CACHE, { recursive: true })
  const wanted = [...new Set(Object.values(MAC_CURSORS))]
  return new Promise(resolve => {
    execFile('osascript', ['-l', 'JavaScript', '-e', JXA, CACHE, JSON.stringify(wanted)], (error, stdout, stderr) => {
      let result = { cursors: {}, errors: {} }
      try { result = JSON.parse(stdout) } catch {}
      if (error) result.errors.osascript = String(stderr || error.message)
      try { fs.writeFileSync(path.join(CACHE, 'export.json'), JSON.stringify(result, null, 2)) } catch {}
      if (Object.keys(result.cursors).length) macCursors = result.cursors
      // Gardé pour les prochains lancements seulement si la flèche y est ;
      // sinon on réessaie la prochaine fois
      if (result.cursors.arrowCursor) {
        fs.writeFileSync(path.join(CACHE, 'cursors.json'), JSON.stringify(result.cursors, null, 2))
      }
      resolve()
    })
  })
}

// Sprite pour un type de curseur, en pixels de la vidéo (scale = 2 sur Retina)
//   → { key, url, width, height, x, y } ou null pour 'none'
export function cursorSprite(type, scale, custom) {
  if (type === 'none') return null
  if (type === 'custom' && custom) {
    // taille et point chaud en pixels de l'image, qui est à l'échelle imageScale
    const { image, imageScale, size, hotspot } = custom
    const k = scale / (imageScale || 1)
    const { width, height } = size?.width ? size : image.getSize()
    return { key: `custom-${custom.id}`, url: image.toDataURL(), width: width * k, height: height * k, x: hotspot.x * k, y: hotspot.y * k }
  }
  const name = MAC_CURSORS[type] || 'arrowCursor'
  const mac = macCursors?.[name] || macCursors?.arrowCursor
  if (mac) {
    const file = path.join(CACHE, `${macCursors[name] ? name : 'arrowCursor'}.png`)
    return { key: `mac-${name}`, url: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`,
      width: mac.width * scale, height: mac.height * scale, x: mac.x * scale, y: mac.y * scale }
  }
  const fb = FALLBACK[type === 'vertical-text' ? 'text' : type] || FALLBACK.default
  return { key: `fallback-${fb === FALLBACK.text ? 'text' : 'default'}`, url: `data:image/svg+xml,${encodeURIComponent(fb.svg)}`,
    width: fb.width * scale, height: fb.height * scale, x: fb.x * scale, y: fb.y * scale }
}
