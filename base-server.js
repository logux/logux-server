'use strict'

const ServerConnection = require('logux-sync').ServerConnection
const MemoryStore = require('logux-core').MemoryStore
const NanoEvents = require('nanoevents')
const WebSocket = require('uws')
const shortid = require('shortid')
const https = require('https')
const http = require('http')
const path = require('path')
const Log = require('logux-core').Log
const fs = require('fs')

const promisify = require('./promisify')
const Client = require('./client')

const PEM_PREAMBLE = '-----BEGIN'

function isPem (content) {
  if (typeof content === 'object' && content.pem) {
    return true
  } else {
    return content.toString().trim().indexOf(PEM_PREAMBLE) === 0
  }
}

function readFile (root, file) {
  file = file.toString()
  if (!path.isAbsolute(file)) {
    file = path.join(root, file)
  }
  return promisify(done => {
    fs.readFile(file, done)
  })
}

function forcePromise (callback) {
  let result
  try {
    result = callback()
  } catch (e) {
    return Promise.reject(e)
  }
  if (typeof result !== 'object' || typeof result.then !== 'function') {
    return Promise.resolve(result)
  } else {
    return result
  }
}

/**
 * Basic Logux Server API without good UI. Use it only if you need
 * to create some special hacks on top of Logux Server.
 *
 * In most use cases you should use {@link Server}.
 *
 * @param {object} options Server options.
 * @param {string} options.subprotocol Server current application
 *                                     subprotocol version in SemVer format.
 * @param {string} options.supports npm’s version requirements for client
 *                                  subprotocol version.
 * @param {string|number} [options.nodeId] Unique server ID. Be default,
 *                                         `server:` with compacted UUID.
 * @param {string} [options.root=process.cwd()] Application root to load files
 *                                              and show errors.
 * @param {number} [options.timeout=20000] Timeout in milliseconds
 *                                         to disconnect connection.
 * @param {number} [options.ping=10000] Milliseconds since last message to test
 *                                      connection by sending ping.
 * @param {Store} [options.store] Store to save log. Will be `MemoryStore`,
 *                                by default.
 * @param {"production"|"development"} [options.env] Development or production
 *                                                   server mode. By default,
 *                                                   it will be taken from
 *                                                   `NODE_ENV` environment
 *                                                   variable. On empty
 *                                                   `NODE_ENV` it will
 *                                                   be `"development"`.
 * @param {number} [options.pid] Process ID, to display in reporter.
 * @param {http.Server} [options.server] HTTP server to connect WebSocket
 *                                       server to it.
 *                                       Same as in ws.WebSocketServer.
 * @param {number} [option.port=1337] Port to bind server. It will create
 *                                    HTTP server manually to connect
 *                                    WebSocket server to it.
 * @param {string} [option.host="127.0.0.1"] IP-address to bind server.
 * @param {string} [option.key] SSL key or path to it. Path could be relative
 *                              from server root. It is required in production
 *                              mode, because WSS is highly recommended.
 * @param {string} [option.cert] SSL certificate or path to it. Path could
 *                               be relative from server root. It is required
 *                               in production mode, because WSS
 *                               is highly recommended.
 * @param {function} [reporter] Function to show current server status.
 *
 * @example
 * import { BaseServer } from 'logux-server'
 * class MyLoguxHack extends BaseServer {
 *   …
 * }
 */
class BaseServer {
  constructor (options, reporter) {
    /**
     * Server options.
     * @type {object}
     *
     * @example
     * console.log(app.options.nodeId + ' was started')
     */
    this.options = options || { }

    this.reporter = reporter || function () { }

    if (typeof this.options.subprotocol === 'undefined') {
      throw new Error('Missed subprotocol version')
    }
    if (typeof this.options.supports === 'undefined') {
      throw new Error('Missed supported subprotocol major versions')
    }
    if (typeof this.options.nodeId === 'undefined') {
      this.options.nodeId = `server:${ shortid.generate() }`
    }

    if (this.options.key && !this.options.cert) {
      throw new Error('You must set cert option too if you use key option')
    }
    if (!this.options.key && this.options.cert) {
      throw new Error('You must set key option too if you use cert option')
    }

    if (!this.options.server) {
      if (!this.options.port) this.options.port = 1337
      if (!this.options.host) this.options.host = '127.0.0.1'
    }

    /**
     * Server unique ID.
     * @type {string}
     *
     * @example
     * console.log('Error was raised on ' + app.nodeId)
     */
    this.nodeId = this.options.nodeId

    this.options.root = this.options.root || process.cwd()

    const store = this.options.store || new MemoryStore()

    /**
     * Server actions log.
     * @type {Log}
     *
     * @example
     * app.log.each(finder)
     */
    this.log = new Log({ store, nodeId: this.nodeId })

    this.log.on('preadd', (action, meta) => {
      if (!meta.server) meta.server = this.nodeId
      if (!meta.status) meta.status = 'waiting'
    })

    this.log.on('add', (action, meta) => {
      this.reporter('add', this, action, meta)

      if (this.destroing) return
      if (meta.status !== 'waiting') return

      if (!this.types[action.type]) {
        this.unknownAction(action, meta)
      } else {
        this.process(action, meta)
      }
    })
    this.log.on('clean', (action, meta) => {
      this.reporter('clean', this, action, meta)
    })

    /**
     * Production or development mode.
     * @type {"production"|"development"}
     *
     * @example
     * if (app.env === 'development') {
     *   logDebugData()
     * }
     */
    this.env = this.options.env || process.env.NODE_ENV || 'development'

    this.emitter = new NanoEvents()
    this.on('error', (e, action, meta) => {
      this.reporter('runtimeError', this, e, action, meta)
      if (this.env === 'development') this.debugError(e)
    })

    this.unbind = []

    /**
     * Connected clients.
     * @type {Client[]}
     *
     * @example
     * for (let nodeId in app.clients) {
     *   console.log(app.clients[nodeId].remoteAddress)
     * }
     */
    this.clients = { }
    this.nodeIds = { }
    this.types = { }
    this.processing = 0

    this.lastClient = 0

    this.unbind.push(() => {
      for (const i in this.clients) this.clients[i].destroy()
    })
    this.unbind.push(() => new Promise(resolve => {
      if (this.processing === 0) {
        resolve()
      } else {
        this.on('processed', () => {
          if (this.processing === 0) resolve()
        })
      }
    }))
  }

  /**
   * Set authenticate function. It will receive client credentials
   * and node ID. It should return a Promise with `true` or `false`.
   *
   * @param {authenticator} authenticator The authentication callback.
   *
   * @return {undefined}
   *
   * @example
   * app.auth((userId, token) => {
   *   return findUserByToken(token).then(user => {
   *     return !!user && userId === user.id
   *   })
   * })
   */
  auth (authenticator) {
    this.authenticator = function () {
      return forcePromise(() => authenticator.apply(this, arguments))
    }
  }

  /**
   * Start WebSocket server and listen for clients.
   *
   * @return {Promise} When the server has been bound.
   */
  listen () {
    if (!this.authenticator) {
      throw new Error('You must set authentication callback by app.auth()')
    }

    let promise = Promise.resolve()

    if (this.options.server) {
      this.ws = new WebSocket.Server({ server: this.options.server })
    } else {
      const before = []
      if (this.options.key && !isPem(this.options.key)) {
        before.push(readFile(this.options.root, this.options.key))
      } else {
        before.push(Promise.resolve(this.options.key))
      }
      if (this.options.cert && !isPem(this.options.cert)) {
        before.push(readFile(this.options.root, this.options.cert))
      } else {
        before.push(Promise.resolve(this.options.cert))
      }

      promise = promise
        .then(() => Promise.all(before))
        .then(keys => new Promise((resolve, reject) => {
          if (keys[0]) {
            this.http = https.createServer({ key: keys[0], cert: keys[1] })
          } else {
            this.http = http.createServer()
          }

          this.ws = new WebSocket.Server({ server: this.http })

          this.ws.on('error', reject)

          this.http.listen(this.options.port, this.options.host, resolve)
        }))
    }

    this.unbind.push(() => promisify(done => {
      promise.then(() => {
        this.ws.close()
        if (this.http) {
          this.http.close(done)
        } else {
          done()
        }
      })
    }))

    return promise.then(() => {
      this.ws.on('connection', ws => {
        this.lastClient += 1
        const connection = new ServerConnection(ws)
        const client = new Client(this, connection, this.lastClient)
        this.clients[this.lastClient] = client
      })
    }).then(() => {
      this.reporter('listen', this)
    })
  }

  /**
   * Subscribe for synchronization events. It implements nanoevents API.
   * Supported events:
   *
   * * `error`: server error.
   * * `processed`: action processing was finished.
   *
   * @param {"error"|"processed"} event The event name.
   * @param {listener} listener The listener function.
   *
   * @return {function} Unbind listener from event.
   *
   * @example
   * sync.on('error', error => {
   *   trackError(error)
   * })
   */
  on (event, listener) {
    return this.emitter.on(event, listener)
  }

  /**
   * Add one-time listener for synchronization events.
   * See {@link BaseServer#on} for supported events.
   *
   * @param {"error"|"processed"} event The event name.
   * @param {listener} listener The listener function.
   *
   * @return {function} Unbind listener from event.
   *
   * @example
   * sync.once('processed', () => {
   *   console.log('First work done')
   * })
   */
  once (event, listener) {
    return this.emitter.once(event, listener)
  }

  /**
   * Stop server and unbind all listeners.
   *
   * @return {Promise} Promise when all listeners will be removed.
   *
   * @example
   * afterEach(() => {
   *   testApp.destroy()
   * })
   */
  destroy () {
    this.destroing = true
    this.reporter('destroy', this)
    return Promise.all(this.unbind.map(i => i()))
  }

  /**
   * Define action type’s callbacks.
   *
   * @param {string} name The action’s type.
   * @param {object} callbacks Callbacks for actions with this type.
   * @param {authorizer} callback.access Check does user can do this action.
   * @param {processor} callback.process Action business logic.
   *
   * @return {undefined}
   *
   * @example
   * app.type('CHANGE_NAME', {
   *   access (action, meta) {
   *     return action.user === meta.user
   *   },
   *   process (action, meta) {
   *     if (isFirstOlder(lastNameChange(action.user), meta)) {
   *       return db.changeUserName({ id: action.user, name: action.name })
   *     }
   *   }
   * })
   */
  type (name, callbacks) {
    if (this.types[name]) {
      throw new Error(`Action type ${ name } was already defined`)
    }
    if (!callbacks || !callbacks.access) {
      throw new Error(`Action type ${ name } must have access callback`)
    }
    if (!callbacks.process) {
      throw new Error(`Action type ${ name } must have process callback`)
    }
    this.types[name] = callbacks
  }

  /**
   * Send runtime error stacktrace to all clients.
   *
   * @param {Error} error Runtime error instance.
   *
   * @return {undefined}
   *
   * @example
   * process.on('uncaughtException', app.debugError)
   */
  debugError (error) {
    for (const i in this.clients) {
      this.clients[i].connection.send(['debug', 'error', error.stack])
    }
  }

  unknownAction (action, meta) {
    if (meta.user) {
      this.badAction(meta.id, 'error', 'unknowType')
    } else {
      this.log.changeMeta(meta.id, { status: 'processed' })
    }
  }

  process (action, meta) {
    const start = Date.now()
    const type = this.types[action.type]
    const user = this.getUser(meta.id[1])

    forcePromise(() => type.access(action, meta, user)).then(result => {
      if (!result) {
        this.reporter('denied', this, action, meta)
        this.badAction(meta.id, 'denied', 'denied')
        return false
      }
      if (this.destroing) {
        return false
      }

      this.processing += 1
      return forcePromise(() => type.process(action, meta, user)).then(() => {
        this.reporter('processed', this, action, meta, Date.now() - start)
        this.processing -= 1
        this.emitter.emit('processed', action, meta)
      }).catch(e => {
        this.badAction(meta.id, 'error', 'error')
        this.emitter.emit('error', e, action, meta)
        this.processing -= 1
        this.emitter.emit('processed', action, meta)
      })
    }).catch(e => {
      this.badAction(meta.id, 'error', 'error')
      this.emitter.emit('error', e, action, meta)
    })
  }

  badAction (id, status, reason) {
    this.log.changeMeta(id, { status })
    this.log.add(
      { type: 'logux/undo', reason, id },
      { reasons: ['error'], status: 'processed' })
  }

  getUser (nodeId) {
    const pos = nodeId.indexOf(':')
    if (pos !== -1) {
      return nodeId.slice(0, pos)
    } else {
      return false
    }
  }
}

module.exports = BaseServer

/**
 * @callback authenticator
 * @param {string} id User ID.
 * @param {any} credentials The client credentials.
 * @param {Client} client Client object.
 * @return {boolean|Promise} `true` or Promise with `true`
 *                           if credentials was correct
 */

/**
 * @callback authorizer
 * @param {Action} action The action data.
 * @param {Meta} meta The action metadata.
 * @param {string|"server"} user User ID of action author. It will be `"server"`
 *                               if user was created by server.
 * @return {boolean|Promise} `true` or Promise with `true` if client are allowed
 *                           to use this action.
 */

/**
 * @callback processor
 * @param {Action} action The action data.
 * @param {Meta} meta The action metadata.
 * @param {string|"server"} user User ID of action author. It will be `"server"`
 *                               if user was created by server.
 * @return {Promise|undefined} Promise when processing will be finished.
 */
