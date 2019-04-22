let { ServerConnection, MemoryStore, Log } = require('@logux/core')
let NanoEvents = require('nanoevents')
let UrlPattern = require('url-pattern')
let WebSocket = require('ws')
let nanoid = require('nanoid')
let https = require('https')
let http = require('http')
let path = require('path')
let fs = require('fs')

let startControlServer = require('./start-control-server')
let bindBackendProxy = require('./bind-backend-proxy')
let forcePromise = require('./force-promise')
let ServerClient = require('./server-client')
let parseNodeId = require('./parse-node-id')
let promisify = require('./promisify')
let Context = require('./context')
let pkg = require('./package.json')

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

function optionError (msg) {
  let error = new Error(msg)
  error.logux = true
  error.note = 'Check server constructor and Logux Server documentation'
  throw error
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
 * @param {string} [options.root=process.cwd()] Application root to load files
 *                                              and show errors.
 * @param {number} [options.timeout=20000] Timeout in milliseconds
 *                                         to disconnect connection.
 * @param {number} [options.ping=10000] Milliseconds since last message to test
 *                                      connection by sending ping.
 * @param {string} [options.backend] URL to PHP, Ruby on Rails,
 *                                   or other backend to process actions
 *                                   and authentication.
 * @param {string} [option.redis] URL to Redis for Logux Server Pro scaling.
 * @param {number} [options.controlHost="127.0.0.1"] Host to bind HTTP server
 *                                                   to control Logux server.
 * @param {number} [options.controlPort=31338] Port to control the server.
 * @param {string} [options.controlPassword] Password to control the server.
 * @param {Store} [options.store] Store to save log. Will be
 *                                {@link MemoryStore}, by default.
 * @param {TestTime} [options.time] Test time to test server.
 * @param {string} [options.id] Custom random ID to be used in node ID.
 * @param {"production"|"development"} [options.env] Development or production
 *                                                   server mode. By default,
 *                                                   it will be taken from
 *                                                   `NODE_ENV` environment
 *                                                   variable. On empty
 *                                                   `NODE_ENV` it will
 *                                                   be `"development"`.
 * @param {number} [options.pid] Process ID, to display in reporter.
 * @param {http.Server} [options.server] HTTP server to connect WebSocket
 *                                       server to it. Same as in `ws.Server`.
 * @param {number} [options.port=31337] Port to bind server. It will create
 *                                      HTTP server manually to connect
 *                                      WebSocket server to it.
 * @param {string} [options.host="127.0.0.1"] IP-address to bind server.
 * @param {string} [options.key] SSL key or path to it. Path could be relative
 *                               from server root. It is required in production
 *                               mode, because WSS is highly recommended.
 * @param {string} [options.cert] SSL certificate or path to it. Path could
 *                                be relative from server root. It is required
 *                                in production mode, because WSS
 *                                is highly recommended.
 * @param {function} [options.reporter] Function to show current server status.
 *
 * @example
 * const { BaseServer } = require('@logux/server')
 * class MyLoguxHack extends BaseServer {
 *   …
 * }
 */
class BaseServer {
  constructor (options) {
    /**
     * Server options.
     * @type {object}
     *
     * @example
     * console.log('Server options', server.options.subprotocol)
     */
    this.options = options || { }

    this.reporter = this.options.reporter || function () { }

    /**
     * Production or development mode.
     * @type {"production"|"development"}
     *
     * @example
     * if (server.env === 'development') {
     *   logDebugData()
     * }
     */
    this.env = this.options.env || process.env.NODE_ENV || 'development'

    if (typeof this.options.subprotocol === 'undefined') {
      throw optionError('Missed `subprotocol` option in server constructor')
    }
    if (typeof this.options.supports === 'undefined') {
      throw optionError('Missed `supports` option in server constructor')
    }

    if (this.options.key && !this.options.cert) {
      throw optionError('You must set `cert` option if you use `key` option')
    }
    if (!this.options.key && this.options.cert) {
      throw optionError('You must set `key` option if you use `cert` option')
    }

    if (!this.options.server) {
      if (!this.options.port) this.options.port = 31337
      if (!this.options.host) this.options.host = '127.0.0.1'
    }
    if (!this.options.controlPort) this.options.controlPort = 31338
    if (!this.options.controlHost) this.options.controlHost = '127.0.0.1'

    /**
     * Server unique ID.
     * @type {string}
     *
     * @example
     * console.log('Error was raised on ' + server.nodeId)
     */
    this.nodeId = `server:${ this.options.id || nanoid(8) }`

    this.options.root = this.options.root || process.cwd()

    let store = this.options.store || new MemoryStore()

    let log
    if (this.options.time) {
      log = this.options.time.nextLog({ store, nodeId: this.nodeId })
    } else {
      log = new Log({ store, nodeId: this.nodeId })
    }
    /**
     * Server actions log.
     * @type {Log}
     *
     * @example
     * server.log.each(finder)
     */
    this.log = log

    this.log.on('preadd', (action, meta) => {
      let isLogux = action.type.slice(0, 6) === 'logux/'
      if (!meta.server) {
        meta.server = this.nodeId
      }
      if (!meta.status && !isLogux) {
        meta.status = 'waiting'
      }
      if (meta.id.split(' ')[1] === this.nodeId) {
        if (!meta.subprotocol) {
          meta.subprotocol = this.options.subprotocol
        }
        if (!this.options.backend && !this.types[action.type] && !isLogux) {
          meta.status = 'processed'
        }
      }
    })

    this.log.on('add', (action, meta) => {
      let start = Date.now()
      this.reporter('add', { action, meta })

      if (this.destroying) return

      if (action.type === 'logux/subscribe') {
        if (meta.server === this.nodeId) {
          this.subscribeAction(action, meta, start)
        }
        return
      }

      if (action.type === 'logux/unsubscribe') {
        if (meta.server === this.nodeId) {
          this.unsubscribeAction(action, meta)
        }
        return
      }

      if (this.isUseless(action, meta)) {
        this.reporter('useless', { action, meta })
      }

      this.sendAction(action, meta)

      if (meta.status === 'waiting') {
        let type = this.types[action.type]
        if (!type) {
          type = this.otherProcessor
        }
        if (!type) {
          this.internalUnkownType(action, meta)
          return
        }
        if (type.process) {
          this.processAction(type, action, meta, start)
        } else {
          this.markAsProcessed(meta)
        }
      }
    })
    this.log.on('clean', (action, meta) => {
      this.reporter('clean', { actionId: meta.id })
    })

    this.emitter = new NanoEvents()
    this.on('fatal', err => {
      this.reporter('error', { err, fatal: true })
    })
    this.on('error', (err, action, meta) => {
      if (meta) {
        this.reporter('error', { err, actionId: meta.id })
      } else if (err.nodeId) {
        this.reporter('error', { err, nodeId: err.nodeId })
      } else if (err.connectionId) {
        this.reporter('error', { err, connectionId: err.connectionId })
      }
      if (this.env === 'development') this.debugError(err)
    })
    this.on('clientError', err => {
      if (err.nodeId) {
        this.reporter('clientError', { err, nodeId: err.nodeId })
      } else if (err.connectionId) {
        this.reporter('clientError', { err, connectionId: err.connectionId })
      }
    })
    this.on('connected', client => {
      this.reporter('connect', {
        connectionId: client.key,
        ipAddress: client.remoteAddress
      })
    })
    this.on('disconnected', client => {
      if (!client.zombie) {
        if (client.nodeId) {
          this.reporter('disconnect', { nodeId: client.nodeId })
        } else {
          this.reporter('disconnect', { connectionId: client.key })
        }
      }
    })

    this.unbind = []

    /**
     * Connected clients.
     * @type {ServerClient[]}
     *
     * @example
     * for (let i in server.connected) {
     *   console.log(server.connected[i].remoteAddress)
     * }
     */
    this.connected = { }
    this.nodeIds = { }
    this.clientIds = { }
    this.userIds = { }
    this.types = { }
    this.processing = 0

    this.lastClient = 0

    this.channels = []
    this.subscribers = { }

    this.authAttempts = { }
    this.unknownTypes = { }
    this.wrongChannels = { }

    this.timeouts = { }
    this.lastTimeout = 0

    this.controls = {
      '/status': {
        safe: true,
        request () {
          return { body: 'OK' }
        }
      }
    }

    this.listenNotes = { }
    if (this.options.backend) {
      bindBackendProxy(this)
    }

    this.unbind.push(() => {
      for (let i in this.connected) this.connected[i].destroy()
      for (let i in this.timeouts) {
        clearTimeout(this.timeouts[i])
      }
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
   * server.auth(async (userId, token) => {
   *   const user = await findUserByToken(token)
   *   return !!user && userId === user.id
   * })
   */
  auth (authenticator) {
    this.authenticator = function (...args) {
      return forcePromise(() => authenticator(...args))
    }
  }

  /**
   * Start WebSocket server and listen for clients.
   *
   * @return {Promise} When the server has been bound.
   */
  listen () {
    if (!this.authenticator) {
      throw new Error('You must set authentication callback by server.auth()')
    }

    let promise = Promise.resolve()

    if (this.options.server) {
      this.ws = new WebSocket.Server({ server: this.options.server })
    } else {
      let before = []
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
          if (keys[0] && keys[0].pem) {
            this.http = https.createServer({ key: keys[0].pem, cert: keys[1] })
          } else if (keys[0]) {
            this.http = https.createServer({ key: keys[0], cert: keys[1] })
          } else {
            this.http = http.createServer()
          }

          this.ws = new WebSocket.Server({ server: this.http })
          this.ws.on('error', reject)

          this.http.listen(this.options.port, this.options.host, resolve)
        }))
    }

    promise = promise.then(() => {
      return startControlServer(this)
    })

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
        this.addClient(new ServerConnection(ws))
      })
    }).then(() => {
      this.reporter('listen', {
        controlPassword: this.options.controlPassword,
        controlHost: this.options.controlHost,
        controlPort: this.options.controlPort,
        loguxServer: pkg.version,
        environment: this.env,
        subprotocol: this.options.subprotocol,
        supports: this.options.supports,
        backend: this.options.backend,
        server: !!this.options.server,
        nodeId: this.nodeId,
        redis: this.options.redis,
        notes: this.listenNotes,
        cert: !!this.options.cert,
        host: this.options.host,
        port: this.options.port
      })
    })
  }

  /**
   * Subscribe for synchronization events. It implements nanoevents API.
   * Supported events:
   *
   * * `error`: server error.
   * * `clientError`: wrong client behaviour.
   * * `connected`: new client was connected.
   * * `disconnected`: client was disconnected.
   * * `processed`: action processing was finished.
   * * `subscribed`: channel initial data was loaded.
   *
   * @param {
   *   "error"|"clientError"|"connected"|"processed"|"disconnected"|
   *   "subscribing"|"subscribed"|"unsubscribed"
   * } event The event name.
   * @param {listener} listener The listener function.
   *
   * @return {function} Unbind listener from event.
   *
   * @example
   * server.on('error', error => {
   *   trackError(error)
   * })
   */
  on (event, listener) {
    return this.emitter.on(event, listener)
  }

  /**
   * Stop server and unbind all listeners.
   *
   * @return {Promise} Promise when all listeners will be removed.
   *
   * @example
   * afterEach(() => {
   *   testServer.destroy()
   * })
   */
  destroy () {
    this.destroying = true
    this.reporter('destroy')
    return Promise.all(this.unbind.map(i => i()))
  }

  /**
   * Define action type’s callbacks.
   *
   * @param {string} name The action’s type.
   * @param {object} callbacks Callbacks for actions with this type.
   * @param {authorizer} callback.access Check does user can do this action.
   * @param {processor} [callback.process] Action business logic.
   *
   * @return {undefined}
   *
   * @example
   * server.type('CHANGE_NAME', {
   *   access (ctx, action, meta) {
   *     return action.user === ctx.userId
   *   },
   *   process (ctx, action, meta) {
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
    this.types[name] = callbacks
  }

  /**
   * Define callbacks for actions, which type was not defined
   * by any {@link Server#type}. Useful for proxy or some hacks.
   *
   * Without this settings, server will call {@link Server#unknownType}
   * on unknown type.
   *
   * @param {object} callbacks Callbacks for actions with this type.
   * @param {authorizer} callback.access Check does user can do this action.
   * @param {processor} [callback.process] Action business logic.
   *
   * @return {undefined}
   *
   * @example
   * server.otherType(
   *   async access (ctx, action, meta) {
   *     const response = await phpBackend.checkByHTTP(action, meta)
   *     if (response.code === 404) {
   *       this.unknownType(action, meta)
   *       retur false
   *     } else {
   *       return response.body === 'granted'
   *     }
   *   }
   *   async process (ctx, action, meta) {
   *     return await phpBackend.sendHTTP(action, meta)
   *   }
   * })
   */
  otherType (callbacks) {
    if (this.otherProcessor) {
      throw new Error(`Callbacks for unknown types are already defined`)
    }
    if (!callbacks || !callbacks.access) {
      throw new Error(`Unknown type must have access callback`)
    }
    this.otherProcessor = callbacks
  }

  /**
   * Define the channel.
   *
   * @param {string|regexp} pattern Pattern or regular expression
   *                                for channel name.
   * @param {objects} callbacks Callback during subscription process.
   * @param {channelAuthorizer} callbacks.access Checks user access for channel.
   * @param {filterCreator} [callback.filter] Generates custom filter
   *                                          for channel’s actions.
   * @param {initialized} [callbacks.init] Creates actions with initial state.
   *
   * @return {undefined}
   *
   * @example
   * server.channel('user/:id', {
   *   access (ctx, action, meta) {
   *     return ctx.params.id === ctx.userId
   *   }
   *   filter (ctx, action, meta) {
   *     return (otherCtx, otherAction, otherMeta) => {
   *       return !action.hidden
   *     }
   *   }
   *   async init (ctx, action, meta) {
   *     const user = await db.loadUser(ctx.params.id)
   *     server.log.add(
   *       { type: 'USER_NAME', name: user.name },
   *       { clients: [ctx.clientId] })
   *     )
   *   }
   * })
   */
  channel (pattern, callbacks) {
    if (!callbacks || !callbacks.access) {
      throw new Error(`Channel ${ pattern } must have access callback`)
    }
    let channel = Object.assign({ }, callbacks)
    if (typeof pattern === 'string') {
      channel.pattern = new UrlPattern(pattern)
    } else {
      channel.regexp = pattern
    }
    this.channels.push(channel)
  }

  /**
   * Set callbacks for unknown channel subscription.
   *
   * @param {objects} callbacks Callback during subscription process.
   * @param {channelAuthorizer} callbacks.access Checks user access for channel.
   * @param {filterCreator} [callback.filter] Generates custom filter
   *                                          for channel’s actions.
   * @param {initialized} [callbacks.init] Creates actions with initial state.
   *
   * @return {undefined}
   *
   * @example
   * server.otherChannel({
   *   async access (ctx, action, meta) {
   *     const res = await phpBackend.checkChannel(ctx.params[0], ctx.userId)
   *     if (res.code === 404) {
   *       this.wrongChannel(action, meta)
   *       return false
   *     } else {
   *       return response.body === 'granted'
   *     }
   *   }
   * })
   */
  otherChannel (callbacks) {
    if (!callbacks || !callbacks.access) {
      throw new Error(`Unknown channel must have access callback`)
    }
    if (this.otherSubscriber) {
      throw new Error(`Callbacks for unknown channel are already defined`)
    }
    let channel = Object.assign({ }, callbacks)
    channel.pattern = {
      match (name) {
        return [name]
      }
    }
    this.otherSubscriber = channel
  }

  /**
   * Undo action from client.
   *
   * @param {Meta} meta The action’s metadata.
   * @param {string} [reason] Optional code for reason.
   *
   * @return {undefined}
   *
   * @example
   * if (couldNotFixConflict(action, meta)) {
   *   server.undo(meta)
   * }
   */
  undo (meta, reason) {
    let undoMeta = { status: 'processed' }

    if (meta.users) undoMeta.users = meta.users.slice(0)
    if (meta.nodes) undoMeta.nodes = meta.nodes.slice(0)
    if (meta.reasons) undoMeta.reasons = meta.reasons.slice(0)
    if (meta.channels) undoMeta.channels = meta.channels.slice(0)

    undoMeta.clients = [parseNodeId(meta.id).clientId]
    if (meta.clients) undoMeta.clients = undoMeta.clients.concat(meta.clients)

    this.log.add({ type: 'logux/undo', id: meta.id, reason }, undoMeta)
  }

  /**
   * Send runtime error stacktrace to all clients.
   *
   * @param {Error} error Runtime error instance.
   *
   * @return {undefined}
   *
   * @example
   * process.on('uncaughtException', e => {
   *   server.debugError(e)
   * })
   */
  debugError (error) {
    for (let i in this.connected) {
      if (this.connected[i].connection.connected) {
        try {
          this.connected[i].connection.send(['debug', 'error', error.stack])
        } catch (e) { }
      }
    }
  }

  /**
   * Send action, received by other server, to all clients of current server.
   * This method is for multi-server configuration only.
   *
   * @param {Action} action New action.
   * @param {Meta} meta Action’s metadata.
   *
   * @return {undefined}
   *
   * @example
   * server.log.on('add', (action, meta) => {
   *   if (meta.server === server.nodeId) {
   *     sendToOtherServers(action, meta)
   *   }
   * })
   * onReceivingFromOtherServer((action, meta) => {
   *   server.sendAction(action, meta)
   * })
   */
  sendAction (action, meta) {
    if (meta.nodes) {
      for (let id of meta.nodes) {
        if (this.nodeIds[id]) {
          this.nodeIds[id].node.onAdd(action, meta)
        }
      }
    }

    if (meta.clients) {
      for (let id of meta.clients) {
        if (this.clientIds[id]) {
          this.clientIds[id].node.onAdd(action, meta)
        }
      }
    }

    if (meta.users) {
      for (let userId of meta.users) {
        if (this.userIds[userId]) {
          for (let client of this.userIds[userId]) {
            client.node.onAdd(action, meta)
          }
        }
      }
    }

    if (meta.channels) {
      let ctx = this.createContext(meta)
      for (let channel of meta.channels) {
        if (this.subscribers[channel]) {
          for (let nodeId in this.subscribers[channel]) {
            let filter = this.subscribers[channel][nodeId]
            if (typeof filter === 'function') {
              filter = filter(ctx, action, meta)
            }
            if (filter && this.nodeIds[nodeId]) {
              this.nodeIds[nodeId].node.onAdd(action, meta)
            }
          }
        }
      }
    }
  }

  /**
   * Add new client for server. You should call this method manually
   * mostly for test purposes.
   *
   * @param {Connection} connection Logux connection to client.
   *
   * @return {number} Client ID,
   *
   * @example
   * server.addClient(test.right)
   */
  addClient (connection) {
    this.lastClient += 1
    let node = new ServerClient(this, connection, this.lastClient)
    this.connected[this.lastClient] = node
    return this.lastClient
  }

  /**
   * If you receive action with unknown type, this method will mark this action
   * with `error` status and undo it on the clients.
   *
   * If you didn’t set {@link Server#otherType},
   * Logux will call it automatically.
   *
   * @param {Action} action The action with unknown type.
   * @param {Meta} meta Action’s metadata.
   *
   * @return {undefined}
   *
   * @example
   * server.otherType({
   *   access (ctx, action, meta) {
   *     if (action.type.startsWith('myapp/')) {
   *       return proxy.access(action, meta)
   *     } else {
   *       server.unknownType(action, meta)
   *     }
   *   }
   * })
   */
  unknownType (action, meta) {
    this.internalUnkownType(action, meta)
    this.unknownTypes[meta.id] = true
  }

  /**
   * Report that client try to subscribe for unknown channel.
   *
   * Logux call it automatically,
   * if you will not set {@link Server#otherChannel}.
   *
   * @param {Action} action The subscribe action.
   * @param {Meta} meta Action’s metadata.
   *
   * @return {undefined}
   *
   * @example
   * server.otherChannel({
   *   async access (ctx, action, meta) {
   *     const res = phpBackend.checkChannel(params[0], ctx.userId)
   *     if (res.code === 404) {
   *       this.wrongChannel(action, meta)
   *       return false
   *     } else {
   *       return response.body === 'granted'
   *     }
   *   }
   * })
   */
  wrongChannel (action, meta) {
    this.internalWrongChannel(action, meta)
    this.wrongChannels[meta.id] = true
  }

  internalUnkownType (action, meta) {
    this.log.changeMeta(meta.id, { status: 'error' })
    this.reporter('unknownType', { type: action.type, actionId: meta.id })
    if (parseNodeId(meta.id).userId !== 'server') {
      this.undo(meta, 'error')
    }
    this.debugActionError(meta, `Action with unknown type ${ action.type }`)
  }

  internalWrongChannel (action, meta) {
    this.reporter('wrongChannel', {
      actionId: meta.id,
      channel: action.channel
    })
    this.undo(meta, 'error')
    this.debugActionError(meta, `Wrong channel name ${ action.channel }`)
  }

  async processAction (type, action, meta, start) {
    let ctx = this.createContext(meta)

    let latency
    this.processing += 1
    try {
      await type.process(ctx, action, meta)
      latency = Date.now() - start
      this.reporter('processed', { actionId: meta.id, latency })
      this.markAsProcessed(meta)
    } catch (e) {
      this.log.changeMeta(meta.id, { status: 'error' })
      this.undo(meta, 'error')
      this.emitter.emit('error', e, action, meta)
    }
    if (typeof latency === 'undefined') latency = Date.now() - start
    this.processing -= 1
    this.emitter.emit('processed', action, meta, latency)
  }

  markAsProcessed (meta) {
    this.log.changeMeta(meta.id, { status: 'processed' })
    let data = parseNodeId(meta.id)
    if (data.userId !== 'server') {
      this.log.add(
        { type: 'logux/processed', id: meta.id },
        { clients: [data.clientId], status: 'processed' }
      )
    }
  }

  createContext (meta) {
    let data = parseNodeId(meta.id)

    let subprotocol
    if (meta.subprotocol) {
      subprotocol = meta.subprotocol
    } else if (this.clientIds[data.clientId]) {
      subprotocol = this.clientIds[data.clientId].node.remoteSubprotocol
    }

    return new Context(data.nodeId, data.clientId, data.userId, subprotocol)
  }

  subscribeAction (action, meta, start) {
    if (typeof action.channel !== 'string') {
      this.wrongChannel(action, meta)
      return
    }

    let channels = this.channels
    if (this.otherSubscriber) {
      channels = this.channels.concat([this.otherSubscriber])
    }

    let match
    for (let i of channels) {
      if (i.pattern) {
        match = i.pattern.match(action.channel)
      } else {
        match = action.channel.match(i.regexp)
      }

      let subscribed = false
      if (match) {
        let ctx = this.createContext(meta)
        ctx.params = match

        forcePromise(() => {
          return i.access(ctx, action, meta)
        }).then(access => {
          if (this.wrongChannels[meta.id]) {
            delete this.wrongChannels[meta.id]
            return false
          }
          if (!access) {
            this.denyAction(meta)
            return false
          }

          let client = this.clientIds[ctx.clientId]
          if (!client) {
            this.emitter.emit('subscriptionCancelled')
            return false
          }

          let filter = i.filter && i.filter(ctx, action, meta)

          this.reporter('subscribed', {
            actionId: meta.id,
            channel: action.channel
          })

          if (!this.subscribers[action.channel]) {
            this.subscribers[action.channel] = { }
            this.emitter.emit('subscribing', action, meta)
          }
          this.subscribers[action.channel][ctx.nodeId] = filter || true
          subscribed = true

          let emitter = this.emitter
          function emitSubscribed () {
            emitter.emit('subscribed', action, meta, Date.now() - start)
            return true
          }

          if (i.init) {
            return forcePromise(() => {
              return i.init(ctx, action, meta)
            }).then(() => emitSubscribed())
          } else {
            return emitSubscribed()
          }
        }).then(access => {
          if (access) this.markAsProcessed(meta)
        }).catch(e => {
          this.emitter.emit('error', e, action, meta)
          this.undo(meta, 'error')
          if (subscribed) {
            this.unsubscribeAction(action, meta)
          }
        })
        break
      }
    }

    if (!match) this.wrongChannel(action, meta)
  }

  unsubscribeAction (action, meta) {
    if (typeof action.channel !== 'string') {
      this.wrongChannel(action, meta)
      return
    }

    let nodeId = meta.id.split(' ')[1]
    if (this.subscribers[action.channel]) {
      delete this.subscribers[action.channel][nodeId]
      if (Object.keys(this.subscribers[action.channel]).length === 0) {
        delete this.subscribers[action.channel]
      }
    }

    this.emitter.emit('unsubscribed', action, meta)
    this.reporter('unsubscribed', {
      actionId: meta.id,
      channel: action.channel
    })
    this.markAsProcessed(meta)
  }

  denyAction (meta) {
    this.reporter('denied', { actionId: meta.id })
    this.undo(meta, 'denied')
    this.debugActionError(meta, `Action "${ meta.id }" was denied`)
  }

  debugActionError (meta, msg) {
    if (this.env === 'development') {
      let clientId = parseNodeId(meta.id).clientId
      if (this.clientIds[clientId]) {
        this.clientIds[clientId].connection.send(['debug', 'error', msg])
      }
    }
  }

  setTimeout (callback, ms) {
    this.lastTimeout += 1
    let id = this.lastTimeout
    this.timeouts[id] = setTimeout(() => {
      delete this.timeouts[id]
      callback()
    }, ms)
  }

  isUseless (action, meta) {
    if (meta.status !== 'processed' || this.types[action.type]) {
      return false
    }
    for (let i of ['channels', 'nodes', 'clients', 'users']) {
      if (Array.isArray(meta[i]) && meta[i].length > 0) return false
    }
    return true
  }

  rememberBadAuth (ip) {
    this.authAttempts[ip] = (this.authAttempts[ip] || 0) + 1
    this.setTimeout(() => {
      if (this.authAttempts[ip] === 1) {
        delete this.authAttempts[ip]
      } else {
        this.authAttempts[ip] -= 1
      }
    }, 3000)
  }

  isBruteforce (ip) {
    let attempts = this.authAttempts[ip]
    return attempts && attempts >= 3
  }
}

module.exports = BaseServer

/**
 * @callback authenticator
 * @param {string} userId User ID.
 * @param {any} credentials The client credentials.
 * @param {Client} client Client object.
 * @return {boolean|Promise} `true` or Promise with `true`
 *                           if credentials was correct
 */

/**
 * @callback authorizer
 * @param {Context} ctx Information about node, who create this action.
 * @param {Action} action The action data.
 * @param {Meta} meta The action metadata.
 * @return {boolean|Promise} `true` or Promise with `true` if client are allowed
 *                           to use this action.
 */

/**
 * @callback processor
 * @param {Context} ctx Information about node, who create this action.
 * @param {Action} action The action data.
 * @param {Meta} meta The action metadata.
 * @return {Promise|undefined} Promise when processing will be finished.
 */

/**
 * @callback filter
 * @param {Context} ctx Information about node, who create this action.
 * @param {Action} action The action data.
 * @param {Meta} meta The action metadata.
 * @return {boolean} Should action be sent to client.
 */

/**
 * @callback channelAuthorizer
 * @param {ChannelContext} ctx Information about node, who create this action.
 * @param {Action} action The action data.
 * @param {Meta} meta The action metadata.
 * @return {boolean|Promise} Promise with boolean.
 *                           On `false` subscription will be denied.
 */

/**
 * @callback filterCreator
 * @param {ChannelContext} ctx Information about node, who create this action.
 * @param {Action} action The action data.
 * @param {Meta} meta The action metadata.
 * @return {filter|undefined} Actions filter.
 */

/**
 * @callback initialized
 * @param {ChannelContext} ctx Information about node, who create this action.
 * @param {Action} action The action data.
 * @param {Meta} meta The action metadata.
 * @return {Promise|undefined} Promise during initial actions loading.
 */
