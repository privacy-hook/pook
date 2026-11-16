import { buildApp } from '../app.js'
import { env } from '../config.js'
import { serve } from '../engines/server/serve.js'

const { app } = buildApp(env.MODE)
const { server } = serve(app, { port: env.PORT, host: env.HOST })
server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
