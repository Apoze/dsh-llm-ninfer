import { copyFileSync } from 'node:fs'
copyFileSync(new URL('../client/index.js', import.meta.url), new URL('../lib/client.js', import.meta.url))
