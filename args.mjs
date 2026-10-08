// Lecture des arguments, partagée par cli.mjs et rec.mjs
//   rec example.com           → plein écran (bureau)
//   rec -m example.com        → fenêtre « mobile » 506×900 pt
//   rec 393x852 example.com   → fenêtre de la taille indiquée (en points)
//   rec ./page.html           → un fichier local marche aussi
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DESKTOP = { width: 1680, height: 1050 } // 3360×2100 px sur un écran Retina
export const MOBILE = { width: 506, height: 900 }   // 9:16, 1012×1800 px sur un écran Retina

export function parseArgs(argv) {
  let size = null
  let target = null
  let out = null
  for (const arg of argv) {
    if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else if (arg === '-m' || arg === '--mobile') size ??= { ...MOBILE }
    else if (/^\d+x\d+$/.test(arg)) {
      const [width, height] = arg.split('x').map(Number)
      size = { width, height }
    } else if (!arg.startsWith('-')) target ??= arg
  }
  let url = null
  if (target?.includes('://')) url = target
  else if (target && fs.existsSync(target)) url = pathToFileURL(path.resolve(target)).href
  else if (target) url = `https://${target}`
  return { url, size, out }
}
