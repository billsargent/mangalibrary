import Fastify from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { AUTH_TOKEN_HEADER, MemorySessionStore, SESSION_COOKIE, registerAuth } from './session.js'

async function buildApp() {
  const app = Fastify()
  await registerAuth(app, { store: new MemorySessionStore() })
  app.get('/api/v1/protected', { preHandler: (await import('./session.js')).requireUser }, async () => ({ ok: true }))
  await app.ready()
  return app
}

describe('auth session', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    app = await buildApp()
  })

  it('issues and resumes a session via X-Auth-Token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json', [AUTH_TOKEN_HEADER]: '' },
      payload: { email: 'admin@example.com', password: 'secret' },
    })
    expect(login.statusCode).toBe(200)

    const token = login.headers[AUTH_TOKEN_HEADER]
    expect(typeof token).toBe('string')
    expect(String(token).length).toBeGreaterThan(20)

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { [AUTH_TOKEN_HEADER]: String(token) } })
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe('admin@example.com')

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/me' })
    expect(anonymous.statusCode).toBe(401)
  })

  it('sets a session cookie that can be replayed', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'admin@example.com', password: 'secret' },
    })

    const setCookie = login.headers['set-cookie']
    expect(String(setCookie)).toContain(`${SESSION_COOKIE}=`)

    const cookie = String(setCookie).split(';')[0]!
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe('admin@example.com')
  })

  it('upgrades an X-Auth-Token session to a cookie via /login/set-cookie', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json', [AUTH_TOKEN_HEADER]: '' },
      payload: { email: 'admin@example.com', password: 'secret' },
    })
    const token = String(login.headers[AUTH_TOKEN_HEADER])

    const setCookie = await app.inject({
      method: 'POST',
      url: '/api/v1/login/set-cookie',
      headers: { [AUTH_TOKEN_HEADER]: token },
    })
    expect(setCookie.statusCode).toBe(204)
    expect(String(setCookie.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=`)
  })

  it('rejects protected routes without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/protected' })
    expect(res.statusCode).toBe(401)
  })

  it('logs out and invalidates the session', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      headers: { 'content-type': 'application/json', [AUTH_TOKEN_HEADER]: '' },
      payload: { email: 'admin@example.com', password: 'secret' },
    })
    const token = String(login.headers[AUTH_TOKEN_HEADER])

    const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: { [AUTH_TOKEN_HEADER]: token } })
    expect(logout.statusCode).toBe(204)

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { [AUTH_TOKEN_HEADER]: token } })
    expect(me.statusCode).toBe(401)
  })
})
