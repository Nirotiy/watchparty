import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import policy from './policy.cjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
const manifest = fileURLToPath(new URL('../../src-tauri/Cargo.toml', import.meta.url))
execFileSync('cargo', ['build', '--manifest-path', manifest, '--no-default-features', '--bins'], { stdio: 'inherit', windowsHide: true })
await mkdir(join(directory, 'native'), { recursive: true })
await copyFile(fileURLToPath(new URL('../../src-tauri/target/debug/watchparty-native-sidecar.exe', import.meta.url)), join(directory, 'native/watchparty-native-sidecar.exe'))
await copyFile(fileURLToPath(new URL('../../src-tauri/target/debug/banguru-profile-cleanup.exe', import.meta.url)), join(directory, 'native/banguru-profile-cleanup.exe'))
const preload = (await readFile(join(directory, 'preload.cjs'), 'utf8'))
  .replace('/* COMMANDS */ []', JSON.stringify(policy.commands))
  .replace('/* EVENTS */ []', JSON.stringify(policy.events))
await writeFile(join(directory, 'preload-built.cjs'), preload)
