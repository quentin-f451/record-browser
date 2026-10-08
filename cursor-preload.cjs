// Chargé dans chaque page en mode bureau (monde isolé : le site ne le voit
// pas). Pendant une vidéo, affiche une copie du curseur quand Chromium ne
// dessine pas le sien dans la capture (voir cursorCopy dans capture.mjs).
// Elle est placée sous le vrai curseur, au même endroit : à l'écran, on n'en
// voit qu'un.
const { ipcRenderer } = require('electron')

let host = null
let image = null
let active = false    // une vidéo est en cours
let wanted = false    // capture.mjs demande la copie
let inside = false    // la souris est sur la page
let sprite = null
let x = 0
let y = 0

function ensure() {
  if (host?.isConnected || !document.documentElement) return
  // Élément hors de portée des styles du site : styles en ligne !important,
  // image dans un shadow DOM fermé
  host = document.createElement('rec-cursor')
  host.style.cssText = [
    'all: initial', 'position: fixed', 'left: 0', 'top: 0', 'width: 0', 'height: 0',
    'z-index: 2147483647', 'pointer-events: none', 'display: none',
    'transition: none', 'animation: none', 'will-change: transform',
  ].map(rule => `${rule} !important`).join(';')
  const root = host.attachShadow({ mode: 'closed' })
  image = document.createElement('img')
  image.style.cssText = 'position: absolute; left: 0; top: 0; max-width: none;'
  root.append(image)
  document.documentElement.append(host)
  if (sprite) applySprite()
}

function applySprite() {
  image.src = sprite.url
  image.style.width = `${sprite.width}px`
  image.style.height = `${sprite.height}px`
}

function render() {
  if (!active && !host) return
  ensure()
  if (!host) return
  const show = active && wanted && inside && sprite
  host.style.setProperty('display', show ? 'block' : 'none', 'important')
  if (show) host.style.setProperty('transform', `translate(${x - sprite.x}px, ${y - sprite.y}px)`, 'important')
}

// Position exacte, dans les coordonnées de la page
addEventListener('mousemove', event => {
  x = event.clientX
  y = event.clientY
  inside = true
  if (active) render()
}, { capture: true, passive: true })
document.addEventListener('mouseleave', () => { inside = false; render() }, true)
addEventListener('mouseout', event => { if (!event.relatedTarget) { inside = false; render() } }, true)
addEventListener('mousedown', () => { if (active) ipcRenderer.send('cursor:click') }, true)

ipcRenderer.on('cursor:at', (_event, at) => { x = at.x; y = at.y; inside = at.inside; render() })
ipcRenderer.on('cursor:active', (_event, on) => { active = on; render() })
ipcRenderer.on('cursor:show', (_event, on) => { wanted = on; render() })
ipcRenderer.on('cursor:sprite', (_event, data) => {
  sprite = data
  ensure()
  if (image && sprite) applySprite()
  render()
})
