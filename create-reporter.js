let os = require('os')
let bunyan = require('bunyan')

let HumanFormatter = require('./human-formatter')

const ERROR_CODES = {
  EADDRINUSE: e => {
    let wayToFix = {
      win32: 'Run `cmd.exe` as an administrator\n' +
             'C:\\> netstat -a -b -n -o\n' +
             'C:\\> taskkill /F /PID `<processid>`',
      // macos
      darwin: `$ sudo lsof -i ${ e.port }\n` +
              '$ sudo kill -9 `<processid>`',
      linux: '$ su - root\n' +
             `# netstat -nlp | grep ${ e.port }\n` +
             'Proto   Local Address   State    PID/Program name\n' +
             `tcp     0.0.0.0:${ e.port }    LISTEN   \`777\`/node\n` +
             '# sudo kill -9 `777`'
      // todo: describe 'aix', 'freebsd', 'openbsd', 'sunos', 'android'
    }

    return {
      msg: `Port \`${ e.port }\` already in use`,
      note: 'Another Logux server or other app already running on this port. ' +
            'Maybe you didn’t not stop server from other project ' +
            'or previous version of this server was not killed.\n\n' +
            (wayToFix[os.platform()] || '')
    }
  },
  EACCES: (e, environment) => {
    let wayToFix = {
      development: 'In dev mode it can be done with sudo:\n' +
                   '$ sudo npm start',
      production: `$ su - \`<username>\`\n` +
                  `$ npm start -p ${ e.port }`
    }

    return {
      msg: `You are not allowed to run server on port \`${ e.port }\``,
      note: `Non-privileged users can't start a listening socket on ports ` +
            `below 1024. Try to change user or take another port.\n\n` +
            (wayToFix[environment] || wayToFix.production)
    }
  },
  LOGUX_NO_CONTROL_PASSWORD: e => ({
    msg: e.message,
    note: 'Call `npx nanoid-cli` and set result as `controlPassword` ' +
          'or `LOGUX_CONTROL_PASSWORD` environment variable'
  })
}

const REPORTERS = {
  listen: r => {
    let details = {
      loguxServer: r.loguxServer,
      environment: r.environment,
      nodeId: r.nodeId,
      subprotocol: r.subprotocol,
      supports: r.supports
    }

    if (r.environment === 'development') {
      details.note = [
        'Server was started in non-secure development mode',
        'Press Ctrl-C to shutdown server'
      ]
    }

    if (r.server) {
      details.server = r.server
    } else {
      let wsProtocol = r.cert ? 'wss://' : 'ws://'
      details.listen = `${ wsProtocol }${ r.host }:${ r.port }/`
    }

    let controlDomain = `http://${ r.controlHost }:${ r.controlPort }`
    details.healthCheck = controlDomain + '/status'
    if (r.controlPassword) {
      details.backendListen = controlDomain
    }

    if (r.backend) {
      details.backendSend = r.backend
    }

    if (r.redis) {
      details.redis = r.redis
    }

    for (let i in r.notes) details[i] = r.notes[i]

    return { msg: 'Logux server is listening', details }
  },

  connect: () => ({ msg: 'Client was connected' }),

  authenticated: () => ({ msg: 'User was authenticated' }),

  disconnect: () => ({ msg: 'Client was disconnected' }),

  destroy: () => ({ msg: 'Shutting down Logux server' }),

  add: () => ({ msg: 'Action was added' }),

  clean: () => ({ msg: 'Action was cleaned' }),

  processed: () => ({ msg: 'Action was processed' }),

  subscribed: () => ({ msg: 'Client was subscribed' }),

  unsubscribed: () => ({ msg: 'Client was unsubscribed' }),

  unauthenticated: () => ({ level: 'warn', msg: 'Bad authentication' }),

  useless: () => ({ level: 'warn', msg: 'Useless action' }),

  denied: () => ({ level: 'warn', msg: 'Action was denied' }),

  zombie: () => ({ level: 'warn', msg: 'Zombie client was disconnected' }),

  unknownType: record => ({
    level: /^ server(:| )/.test(record.actionId) ? 'error' : 'warn',
    msg: 'Action with unknown type'
  }),

  wrongChannel: () => ({
    level: 'warn',
    msg: 'Wrong channel name'
  }),

  clientError: record => {
    let result = {
      level: 'warn', details: { }
    }
    if (record.err.received) {
      result.msg = `Client error: ${ record.err.description }`
    } else {
      result.msg = `Sync error: ${ record.err.description }`
    }
    for (let i in record) {
      if (i !== 'err') {
        result.details[i] = record[i]
      }
    }
    return result
  },

  error: record => {
    let result = {
      level: record.fatal ? 'fatal' : 'error',
      msg: record.err.message,
      details: {
        err: {
          message: record.err.message,
          name: record.err.name,
          stack: record.err.stack
        }
      }
    }

    let helper = ERROR_CODES[record.err.code]
    if (helper) {
      let help = helper(record.err, record.environment)
      result.msg = help.msg
      result.details.note = help.note
      delete result.details.err.stack
    } else if (record.err.logux) {
      result.details.note = record.err.note
      delete result.details.err
    }

    if (record.err.name === 'LoguxError') {
      delete result.details.err.stack
    }

    for (let i in record) {
      if (i !== 'err' && i !== 'fatal') {
        result.details[i] = record[i]
      }
    }

    return result
  }
}

function createReporter (options) {
  let logger
  if (options.bunyan) {
    logger = options.bunyan
  } else {
    let streams
    if (options.reporter === 'human') {
      let env = options.env || process.env.NODE_ENV || 'development'
      let color = env !== 'development' ? false : undefined
      streams = [
        {
          type: 'raw',
          stream: new HumanFormatter({ basepath: options.root, color })
        }
      ]
    }
    logger = bunyan.createLogger({ name: 'logux-server', streams })
  }

  function reporter (type, details) {
    let report = REPORTERS[type](details)
    let level = report.level || 'info'
    reporter.logger[level](report.details || details || { }, report.msg)
  }
  reporter.logger = logger
  return reporter
}

module.exports = createReporter
