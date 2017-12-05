# Logux Server

<img align="right" width="95" height="95" title="Logux logo"
     src="https://cdn.rawgit.com/logux/logux/master/logo.svg">

Logux is a client-server communication protocol. It synchronizes actions
between clients and server logs.

This framework helps you to write Logux server and define back-end callbacks
for each client’s event type.

<a href="https://evilmartians.com/?utm_source=logux-server">
  <img src="https://evilmartians.com/badges/sponsored-by-evil-martians.svg"
       alt="Sponsored by Evil Martians" width="236" height="54">
</a>


## Getting Started

### Installation

Install [Node.js](https://nodejs.org/en/download/).

Create new Node.js project:

```sh
mkdir PROJECT_NAME
cd PROJECT_NAME
npm init
```

Install Logux Server:

```sh
npm install --save logux-server logux-core
```


### Create Main File

Create `server.js` with this boilerplate:

```js
const Server = require('logux-server').Server

const app = new Server(
  Server.loadOptions(process, {
    subprotocol: '1.0.0',
    supports: '1.x',
    root: __dirname
  })
)

app.auth((userId, token) => {
  // TODO Check token and return a Promise with true or false.
})

app.listen()
```


### Write Business Logic

Logux is a communication protocol. It doesn’t know anything about your database.
You need to write custom logic inside your action callbacks.

```js
app.type('CHANGE_NAME', {
  access (action, meta, creator) {
    return action.user === creator.userId
  },
  process (action) {
    return users.find({ id: action.user }).then(user => {
      user.update({ name: action.name })
    })
  }
})
```

Read [`logux-core`] docs for `app.log` API.

If you already have business logic written in PHP, Ruby, Java — don’t worry.
You can do whatever you want in the action listener.
For one, you may just call the legacy REST API:

```js
  process (action) {
    request.put(`http://example.com/users/${action.user}`).form({
      name: action.name
    })
  }
```

[`logux-core`]: https://github.com/logux/logux-core


### Control Data Access

By default other clients will not receive new actions.

There are 3 ways to send new action to client.

* Set `nodeIds: ['10:h40vj5']` in action’s metadata.
* Set `users: ['10']` in action’s metadata.
* Using channels.

Before using channel, you need to define it:

```js
app.channel('user/:id', (params, action, meta, creator) => {
  if (params.id !== creator.userId) {
    // Access denied
    return false
  } else {
    // Sending initial state
    db.loadUser(params.id).then(user => {
      app.log.add(
        { type: 'USER_NAME', name: user.name },
        {
          nodeIds: [creator.nodeId],
          time: user.nameChangedAt * 1000
        })
    })
    return true
  }
})
```

Then server or clients could create actions with `channels: ['user/10']`
in action’s metadata.

`logux/subscribe` action will subscribe client to a channel:

```js
client.log.add({ type: 'logux/subscribe', channel: 'user/10' })
```

To send action to channel, add `channels` metadata:

```js
client.log.add(
  { type: 'CHANGE_NAME', name: 'New', user: 10 },
  { channels: ['user/10'] }
)
```

Note, that everyone could send actions to a channel. If you don’t want it,
check metadata in `access()` callbacks inside `type()` definition.

### Test Your Logic Locally

You can run your server with:

```sh
npm start
```

Use `ws://localhost:1337` URL in [Logux Client].

[Logux Client]: https://github.com/logux/logux-client


### Get SSL Certificate

Logux uses WebSockets for communicating between client and server.
Without SSL, old proxies and firewalls can block WebSockets connection.
Also, SSL will obviously help to prevent many attacks against your server.

Probably the best way to get a free SSL certificate is [Let’s Encrypt].

Save certificate PEM-files to `cert.pem` and `key.pem` in your project directory
or change `listen()` options to correct certificate paths.

[Let’s Encrypt]: https://letsencrypt.org/


### Start Production Server

Use your favorite DevOps tools to start Logux server in `production` mode:

```sh
NODE_ENV=production npm start
```

You DevOps tools could set Logux Server options via arguments
or environment variables:

Command-line   | Environment  | Description
---------------|--------------|------------------------
`-h`, `--host` | `LOGUX_HOST` | Host to bind server
`-p`, `--port` | `LOGUX_PORT` | Port to bind server
`-k`, `--key`  | `LOGUX_KEY`  | Path to SSL key
`-c`, `--cert` | `LOGUX_CERT` | Path to SSL certificate
