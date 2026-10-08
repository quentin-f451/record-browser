#!/usr/bin/env node
// rec tectoniques.com | rec -m tectoniques.com | rec 393x852 tectoniques.com
// Cmd+S : capture · Cmd+E : vidéo. Fichiers sur le Bureau, numérotés à la suite
// de ceux du Bureau et du dossier d'où la commande est lancée.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electron from 'electron' // le paquet electron exporte le chemin de l'exécutable
import { parseArgs } from './args.mjs'

const args = process.argv.slice(2)
if (!parseArgs(args).url) {
  console.log(`Usage :
  rec <url>              plein écran (bureau)
  rec -m <url>           mobile, 506×900 pt
  rec <L>x<H> <url>      taille au choix, ex. rec 393x852 tectoniques.com

Dans la fenêtre : Cmd+S capture d'écran, Cmd+E démarre / arrête une vidéo.
Les fichiers vont sur le Bureau (image-…-n.png, video-…-n.mp4), numérotés à la
suite de ceux du Bureau et du dossier courant. Le curseur n'apparaît que dans
les vidéos bureau.`)
  process.exit(1)
}

const app = fileURLToPath(new URL('./rec.mjs', import.meta.url))

// detached + stdio ignoré : le terminal est libéré tout de suite,
// et les messages de Chromium (sandbox_extension…) ne s'affichent pas
spawn(electron, [app, ...args, `--out=${process.cwd()}`], { detached: true, stdio: 'ignore' }).unref()
