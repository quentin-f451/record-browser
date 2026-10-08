#!/usr/bin/env node
// rec example.com | rec -m example.com | rec 393x852 example.com
// Cmd+S : capture · Cmd+E : vidéo. Fichiers sur le Bureau, numérotés à la suite
// de ceux du Bureau et du dossier d'où la commande est lancée.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from './args.mjs'

const args = process.argv.slice(2)
if (!parseArgs(args).url) {
  console.log(`Usage :
  rec <url>              plein écran (bureau)
  rec -m <url>           mobile, 506×900 pt
  rec <L>x<H> <url>      taille au choix, ex. rec 393x852 example.com

Dans la fenêtre : Cmd+S capture d'écran, Cmd+E démarre / arrête une vidéo.
Les fichiers vont sur le Bureau (image-…-n.png, video-…-n.mp4), numérotés à la
suite de ceux du Bureau et du dossier courant. Le curseur n'apparaît que dans
les vidéos bureau.`)
  process.exit(1)
}

// Le paquet electron exporte le chemin de l'application Electron. Il la
// télécharge la première fois qu'on le charge (pas de script d'installation,
// donc rien à autoriser dans npm ou pnpm).
const electronDir = path.dirname(createRequire(import.meta.url).resolve('electron/package.json'))
if (!fs.existsSync(path.join(electronDir, 'path.txt'))) {
  console.log('Premier lancement : téléchargement d\'Electron (~100 Mo, une seule fois)…')
}
const { default: electron } = await import('electron')

const app = fileURLToPath(new URL('./rec.mjs', import.meta.url))

// detached + stdio ignoré : le terminal est libéré tout de suite,
// et les messages de Chromium (sandbox_extension…) ne s'affichent pas
spawn(electron, [app, ...args, `--out=${process.cwd()}`], { detached: true, stdio: 'ignore' }).unref()
