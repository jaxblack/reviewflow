import { buildApp } from './app.js'

const app = await buildApp({
  logger: true,
  serveStatic: process.env.NODE_ENV === 'production',
})

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
await app.listen({ host, port })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close()
    process.exit(0)
  })
}