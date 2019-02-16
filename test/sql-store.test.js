'use strict'

const TestTime = require('logux-core').TestTime

const pgDb = 'logux_test'
const pgUser = 'postgres'
const pgPass = ''
const pgOpts = { dialect: 'postgres' }

const SQLStore = require('../sql-store')

let store, other

afterEach(() => {
  const destroying = Promise.all([
    store ? store.destroy() : null,
    other ? other.destroy() : null
  ]).then(() => {
    store = undefined
    other = undefined
  })
  return destroying
})

function connectDb (opts) {
  if (opts) {
    opts.dialect = 'postgres'
  } else {
    opts = pgOpts
  }
  opts.logging = false
  return new SQLStore(pgDb, pgUser, pgPass, opts)
}

function all (request, list) {
  if (!list) list = []
  return request.then(page => {
    list = list.concat(page.entries)
    if (page.next) {
      return all(page.next(), list)
    } else {
      return list
    }
  })
}

function check (indexed, created, added) {
  if (!added) added = created
  return all(indexed.get({ order: 'created' })).then(entries => {
    expect(entries).toEqual(created)
  }).then(() => all(indexed.get({ order: 'added' }))
  ).then(entries => {
    expect(entries).toEqual(added)
  })
}

function nope () { }

it('fails without connection info', () => {
  expect(() => { new SQLStore() }).toThrowError()
})

it('connects to db and creates tables', () => {
  store = connectDb()
  return store.init().then(() => {
    expect(store.db.isDefined('logux_logs')).toBeTruthy()
  })
})

it('changes prefix for tables', () => {
  store = connectDb({ prefix: 'custom' })
  return store.init().then(() => {
    expect(store.db.isDefined('custom_logs')).toBeTruthy()
  })
})

it('is empty in the beginning', () => {
  store = connectDb()
  return check(store, []).then(() => store.getLastAdded()
  ).then(added => {
    expect(added).toEqual(0)
    return store.getLastSynced()
  }).then(synced => {
    expect(synced).toEqual({ sent: 0, received: 0 })
  })
})

it('updates last sent value', () => {
  store = connectDb()
  return store.setLastSynced(
    { sent: 1 }
  ).then(() => store.getLastSynced()
  ).then(synced => expect(synced).toEqual({ sent: 1, received: 0 })
  ).then(() => store.setLastSynced({ sent: 2, received: 1 })
  ).then(() => store.getLastSynced()
  ).then(synced => expect(synced).toEqual({ sent: 2, received: 1 })
  ).then(() => {
    other = new SQLStore(pgDb, pgUser, pgPass, pgOpts)
    return other.getLastSynced()
  }).then(synced => expect(synced).toEqual({ sent: 2, received: 1 }))
})

it('stores entries sorted', () => {
  store = connectDb()

  return store.add({ type: '1' }, { id: [1, 'a'], time: 1 }
  ).then(() => store.add({ type: '2' }, { id: [1, 'c'], time: 2 })
  ).then(() => store.add({ type: '3' }, { id: [1, 'b'], time: 2 })
  ).then(() => check(store, [
    [{ type: '2' }, { added: 2, id: [1, 'c'], time: 2 }],
    [{ type: '3' }, { added: 3, id: [1, 'b'], time: 2 }],
    [{ type: '1' }, { added: 1, id: [1, 'a'], time: 1 }]
  ], [
    [{ type: '3' }, { added: 3, id: [1, 'b'], time: 2 }],
    [{ type: '2' }, { added: 2, id: [1, 'c'], time: 2 }],
    [{ type: '1' }, { added: 1, id: [1, 'a'], time: 1 }]
  ]))
})

it('stores any metadata', () => {
  store = connectDb()
  return store.add(
    { type: 'A' },
    { id: [1, 'a'], time: 1, test: 1 }
  ).then(() => check(store, [
    [{ type: 'A' }, { added: 1, id: [1, 'a'], time: 1, test: 1 }]
  ]))
})

it('ignores entries with same ID', () => {
  store = connectDb()
  const logId = [1, 'a', 1]
  return store.add({ a: 1 }, { id: logId, time: 1 }).then(meta => {
    expect(meta).toEqual({ id: logId, time: 1, added: 1 })
    return store.add({ a: 2 }, { id: logId, time: 2 })
  }).then(meta => {
    expect(meta).toBeFalsy()
    return check(store, [
      [{ a: 1 }, { id: logId, time: 1, added: 1 }]
    ])
  })
})

it('returns last added', () => {
  store = connectDb()
  return store.add({ type: 'A' }, { id: [1], time: 1 }
  ).then(() => store.add({ type: 'B' }, { id: [2], time: 2 })
  ).then(() => store.getLastAdded()
  ).then(added => expect(added).toBe(2)
  ).then(() => {
    other = connectDb()
    return other.getLastAdded()
  }).then(added => expect(added).toBe(2))
})

it('checks that action ID is used in log', () => {
  store = connectDb()
  return store.add({ type: 'A' }, { id: [1], time: 1 }
  ).then(() => store.has([1])
  ).then(result => {
    expect(result).toBeTruthy()
    return store.has([2])
  }).then(result => expect(result).toBeFalsy())
})

it('changes meta', () => {
  store = connectDb()
  return store.add({ }, { id: [1], time: 1, a: 1 }
  ).then(() => store.changeMeta([1], { a: 2, b: 2 })
  ).then(result => {
    expect(result).toBeTruthy()
    return check(store, [
      [{ }, { id: [1], time: 1, added: 1, a: 2, b: 2 }]
    ])
  })
})

it('resolves to false on unknown ID in changeMeta', () => {
  store = connectDb()
  return store.changeMeta([1], { a: 1 }
  ).then(result => expect(result).toBeFalsy())
})

it('works with real log', () => {
  store = connectDb()
  const log = TestTime.getLog(store)
  const entries = []
  return Promise.all([
    log.add({ type: 'A' }, { id: [2], reasons: ['test'] }),
    log.add({ type: 'B' }, { id: [1], reasons: ['test'] })
  ]).then(() => log.each(action => entries.push(action))
  ).then(() => expect(entries).toEqual([{ type: 'A' }, { type: 'B' }]))
})

it('removes entries', () => {
  store = connectDb()
  return store.add({ type: '1' }, { id: [1, 'node', 0], time: 1 }
  ).then(() => store.add({ type: '2' }, { id: [2, 'node', 0], time: 2 })
  ).then(() => store.add({ type: '3' }, { id: [3, 'node', 0], time: 3 })
  ).then(() => store.remove([2, 'node', 0])
  ).then(entry => {
    expect(entry).toEqual([
      { type: '2' }, { id: [2, 'node', 0], time: 2, added: 2 }
    ])
    return check(store, [
      [{ type: '3' }, { id: [3, 'node', 0], time: 3, added: 3 }],
      [{ type: '1' }, { id: [1, 'node', 0], time: 1, added: 1 }]
    ])
  })
})

it('ignores unknown entry', () => {
  store = connectDb()
  return store.remove([2]).then(removed => expect(removed).toBeFalsy())
})

/*
it('removes reasons and actions without reason', function () {
  store = new IndexedStore()
  var removed = []
  return Promise.all([
    store.add({ type: '1' }, { id: [1], time: 1, reasons: ['a'] }),
    store.add({ type: '2' }, { id: [2], time: 2, reasons: ['a'] }),
    store.add({ type: '3' }, { id: [3], time: 3, reasons: ['a', 'b'] }),
    store.add({ type: '4' }, { id: [4], time: 4, reasons: ['b'] })
  ]).then(function () {
    return store.removeReason('a', { }, function (action, meta) {
      removed.push([action, meta])
    })
  }).then(function () {
    expect(removed).toEqual([
      [{ type: '1' }, { added: 1, id: [1], time: 1, reasons: [] }],
      [{ type: '2' }, { added: 2, id: [2], time: 2, reasons: [] }]
    ])
    return check(store, [
      [{ type: '4' }, { added: 4, id: [4], time: 4, reasons: ['b'] }],
      [{ type: '3' }, { added: 3, id: [3], time: 3, reasons: ['b'] }]
    ])
  })
})

it('removes reason with minimum added', function () {
  store = new IndexedStore()
  return Promise.all([
    store.add({ type: '1' }, { id: [1], time: 1, reasons: ['a'] }),
    store.add({ type: '2' }, { id: [2], time: 2, reasons: ['a'] }),
    store.add({ type: '3' }, { id: [3], time: 3, reasons: ['a'] })
  ]).then(function () {
    return store.removeReason('a', { minAdded: 2 }, nope)
  }).then(function () {
    return check(store, [
      [{ type: '1' }, { added: 1, id: [1], time: 1, reasons: ['a'] }]
    ])
  })
})

it('removes reason with maximum added', function () {
  store = new IndexedStore()
  return Promise.all([
    store.add({ type: '1' }, { id: [1], time: 1, reasons: ['a'] }),
    store.add({ type: '2' }, { id: [2], time: 2, reasons: ['a'] }),
    store.add({ type: '3' }, { id: [3], time: 3, reasons: ['a'] })
  ]).then(function () {
    return store.removeReason('a', { maxAdded: 2 }, nope)
  }).then(function () {
    return check(store, [
      [{ type: '3' }, { added: 3, id: [3], time: 3, reasons: ['a'] }]
    ])
  })
})

it('removes reason with minimum and maximum added', function () {
  store = new IndexedStore()
  return Promise.all([
    store.add({ type: '1' }, { id: [1], time: 1, reasons: ['a'] }),
    store.add({ type: '2' }, { id: [2], time: 2, reasons: ['a'] }),
    store.add({ type: '3' }, { id: [3], time: 3, reasons: ['a'] })
  ]).then(function () {
    return store.removeReason('a', { maxAdded: 2, minAdded: 2 }, nope)
  }).then(function () {
    return check(store, [
      [{ type: '3' }, { added: 3, id: [3], time: 3, reasons: ['a'] }],
      [{ type: '1' }, { added: 1, id: [1], time: 1, reasons: ['a'] }]
    ])
  })
})

it('removes reason with zero at maximum added', function () {
  store = new IndexedStore()
  return store.add({ }, { id: [1], time: 1, reasons: ['a'] }).then(function () {
    return store.removeReason('a', { maxAdded: 0 }, nope)
  }).then(function () {
    return check(store, [
      [{ }, { added: 1, id: [1], time: 1, reasons: ['a'] }]
    ])
  })
})

it('updates reasons cache', function () {
  store = new IndexedStore()
  return store.add({ }, { id: [1], time: 1, reasons: ['a'] }).then(function () {
    return store.changeMeta([1], { reasons: ['a', 'b', 'c'] })
  }).then(function () {
    return store.removeReason('b', { }, nope)
  }).then(function () {
    return check(store, [
      [{ }, { added: 1, id: [1], time: 1, reasons: ['a', 'c'] }]
    ])
  })
})
*/
