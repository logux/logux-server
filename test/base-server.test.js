/* eslint-disable no-invalid-this */

var createTestTimer = require('logux-core').createTestTimer
var MemoryStore = require('logux-core').MemoryStore
var WebSocket = require('ws')
var https = require('https')
var http = require('http')
var path = require('path')
var Log = require('logux-core').Log
var fs = require('fs')

var BaseServer = require('../base-server')
var promisify = require('../promisify')

var defaultKey = fs.readFileSync(path.join(__dirname, 'fixtures/key.pem'))
var defaultCert = fs.readFileSync(path.join(__dirname, 'fixtures/cert.pem'))

var lastPort = 9111
function uniqPort () {
  lastPort += 1
  return lastPort
}

var defaultOptions = {
  subprotocol: '0.0.0',
  supports: '0.x'
}

function createServer (options) {
  var app = new BaseServer(options || defaultOptions)
  app.auth(function () {
    return Promise.resolve(true)
  })
  return app
}

function createReporter (test) {
  test.reports = []
  test.app = new BaseServer(defaultOptions, function () {
    test.reports.push(Array.prototype.slice.call(arguments, 0))
  })
  test.app.auth(function () {
    return Promise.resolve(true)
  })
}

var originEnv = process.env.NODE_ENV
afterEach(function () {
  process.env.NODE_ENV = originEnv
  var test = this

  var promise = test.app ? test.app.destroy() : Promise.resolve()
  return promise.then(function () {
    if (test.server) {
      return promisify(function (done) {
        test.server.close(done)
      })
    } else {
      return true
    }
  })
})

it('saves server options', function () {
  var app = new BaseServer(defaultOptions)
  expect(app.options.supports).toEqual('0.x')
})

it('generates node ID', function () {
  var app = new BaseServer(defaultOptions)
  expect(app.options.nodeId).toMatch(/server:[\w\d]+/)
})

it('throws on missed subprotocol', function () {
  expect(function () {
    new BaseServer({ })
  }).toThrowError(/subprotocol version/)
})

it('throws on missed supported subprotocols', function () {
  expect(function () {
    new BaseServer({ subprotocol: '0.0.0' })
  }).toThrowError(/supported subprotocol/)
})

it('sets development environment by default', function () {
  delete process.env.NODE_ENV
  var app = new BaseServer(defaultOptions)
  expect(app.env).toEqual('development')
})

it('takes environment from NODE_ENV', function () {
  process.env.NODE_ENV = 'production'
  var app = new BaseServer(defaultOptions)
  expect(app.env).toEqual('production')
})

it('sets environment from user', function () {
  var app = new BaseServer({
    env: 'production',
    subprotocol: '0.0.0',
    supports: '0.x'
  })
  expect(app.env).toEqual('production')
})

it('uses cwd as default root', function () {
  var app = new BaseServer(defaultOptions)
  expect(app.options.root).toEqual(process.cwd())
})

it('uses user root', function () {
  var app = new BaseServer({
    subprotocol: '0.0.0',
    supports: '0.x',
    root: '/a'
  })
  expect(app.options.root).toEqual('/a')
})

it('creates log with default timer and store', function () {
  var app = new BaseServer(defaultOptions)
  expect(app.log instanceof Log).toBeTruthy()
  expect(app.log.store instanceof MemoryStore).toBeTruthy()
  var time = app.log.timer()
  expect(typeof time[0]).toEqual('number')
  expect(time[1]).toEqual(app.options.nodeId)
  expect(time[2]).toEqual(0)
})

it('creates log with custom timer and store', function () {
  var timer = createTestTimer()
  var store = new MemoryStore()
  var app = new BaseServer({
    subprotocol: '0.0.0',
    supports: '0.x',
    store: store,
    timer: timer
  })
  expect(app.log.store).toBe(store)
  expect(app.log.timer).toBe(timer)
})

it('destroys application without runned server', function () {
  var app = new BaseServer(defaultOptions)
  return app.destroy().then(function () {
    return app.destroy()
  })
})

it('throws without authenticator', function () {
  var app = new BaseServer(defaultOptions)
  expect(function () {
    app.listen()
  }).toThrowError(/authentication/)
})

it('uses 1337 port by default', function () {
  this.app = createServer()
  this.app.listen()
  expect(this.app.listenOptions.port).toEqual(1337)
})

it('uses user port', function () {
  this.app = createServer()
  this.app.listen({ port: 31337 })
  expect(this.app.listenOptions.port).toEqual(31337)
})

it('uses 127.0.0.1 to bind server by default', function () {
  this.app = createServer()
  this.app.listen({ port: uniqPort() })
  expect(this.app.listenOptions.host).toEqual('127.0.0.1')
})

it('throws a error on key without certificate', function () {
  var app = createServer()
  expect(function () {
    app.listen({
      key: defaultKey
    })
  }).toThrowError(/set cert option/)
})

it('throws a error on certificate without key', function () {
  var app = createServer()
  expect(function () {
    app.listen({
      cert: defaultCert
    })
  }).toThrowError(/set key option/)
})

it('throws a error on no security in production', function () {
  var app = createServer({
    env: 'production',
    subprotocol: '0.0.0',
    supports: '0.x'
  })
  expect(function () {
    app.listen({ port: uniqPort() })
  }).toThrowError(/SSL/)
})

it('uses HTTPS', function () {
  var app = createServer()
  this.app = app
  return app.listen({
    cert: defaultCert,
    key: defaultKey
  }).then(function () {
    expect(app.http instanceof https.Server).toBeTruthy()
  })
})

it('loads keys by absolute path', function () {
  var app = createServer()
  this.app = app
  return app.listen({
    cert: path.join(__dirname, 'fixtures/cert.pem'),
    key: path.join(__dirname, 'fixtures/key.pem')
  }).then(function () {
    expect(app.http instanceof https.Server).toBeTruthy()
  })
})

it('loads keys by relative path', function () {
  var app = createServer({
    subprotocol: '0.0.0',
    supports: '0.x',
    root: __dirname
  })
  this.app = app
  return app.listen({
    cert: 'fixtures/cert.pem',
    key: 'fixtures/key.pem'
  }).then(function () {
    expect(app.http instanceof https.Server).toBeTruthy()
  })
})

it('supports object in SSL key', function () {
  var app = createServer()
  this.app = app
  var key = defaultKey
  return app.listen({
    cert: defaultCert,
    key: { pem: key }
  }).then(function () {
    expect(app.http instanceof https.Server).toBeTruthy()
  })
})

it('reporters on start listening', function () {
  createReporter(this)
  var test = this

  var promise = this.app.listen({ port: uniqPort() })
  expect(this.reports).toEqual([])

  return promise.then(function () {
    expect(test.reports).toEqual([['listen', test.app]])
  })
})

it('reporters on destroing', function () {
  createReporter(this)

  var promise = this.app.destroy()
  expect(this.reports).toEqual([['destroy', this.app]])

  return promise
})

it('creates a client on connection', function () {
  createReporter(this)
  var test = this

  return test.app.listen({ port: uniqPort() }).then(function () {
    test.reports = []

    var ws = new WebSocket('ws://localhost:' + test.app.listenOptions.port)
    return new Promise(function (resolve, reject) {
      ws.onopen = resolve
      ws.onerror = reject
    })
  }).then(function () {
    expect(Object.keys(test.app.clients).length).toBe(1)

    var client = test.app.clients[1]
    expect(client.remoteAddress).toEqual('127.0.0.1')
    expect(test.reports).toEqual([['connect', test.app, '127.0.0.1']])
  })
})

it('accepts custom HTTP server', function () {
  createReporter(this)
  var test = this
  var port = uniqPort()
  test.server = http.createServer()

  return promisify(function (done) {
    test.server.listen(port, done)
  }).then(function () {
    return test.app.listen({ server: test.server })
  }).then(function () {
    test.reports = []

    var ws = new WebSocket('ws://localhost:' + port)
    return new Promise(function (resolve, reject) {
      ws.onopen = resolve
      ws.onerror = reject
    })
  }).then(function () {
    expect(Object.keys(test.app.clients).length).toBe(1)
  })
})

it('loads options from cli', function () {
  var app = createServer()
  var key = defaultKey
  var cert = defaultCert
  var argv = ['', '--port', '1234', '--host', '127.0.0.1']
  process.argv = process.argv.concat(argv)
  var options = app.loadOptions(process, { key: key, cert: cert })
  expect(options).toEqual({
    port: '1234',
    host: '127.0.0.1',
    key: key,
    cert: cert
  })
})

it('loads options from environment', function () {
  var app = createServer()
  var key = defaultKey
  var cert = defaultCert
  process.env.LOGUX_PORT = '1234'
  process.env.LOGUX_HOST = '127.0.0.1'
  var options = app.loadOptions(process, { key: key, cert: cert })
  expect(options).toEqual({
    port: '1234',
    host: '127.0.0.1',
    key: key,
    cert: cert
  })
})

it('loads options even if defaults are not passed', function () {
  var app = createServer()
  var argv = ['', '--port', '1234', '--host', '127.0.0.1']
  process.argv = process.argv.concat(argv)
  process.env.LOGUX_KEY = defaultKey
  process.env.LOGUX_CERT = defaultCert
  var options = app.loadOptions(process)
  expect(options).toEqual({
    port: '1234',
    host: '127.0.0.1',
    key: process.env.LOGUX_KEY,
    cert: process.env.LOGUX_CERT
  })
})

it('disconnects on clients on destroy', function () {
  var app = createServer()
  app.clients[1] = { destroy: jest.fn() }
  app.destroy()
  expect(app.clients[1].destroy).toBeCalled()
})
