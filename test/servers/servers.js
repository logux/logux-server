var spawn = require('child_process').spawn
var path = require('path')

var DATE = /\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d/g

function exec (name) {
  return new Promise(function (resolve) {
    var out = ''
    var server = spawn(path.join(__dirname, name))
    server.stderr.on('data', function (chank) {
      out += chank
    })
    server.on('close', function (exitCode) {
      var fixed = out.replace(DATE, '1970-01-01 00:00:00')
                     .replace(/PID:(\s+)\d+/, 'PID:$121384')
      resolve([fixed, exitCode])
    })
    setTimeout(function () {
      server.kill('SIGINT')
    }, 500)
  })
}

module.exports = {

  destroy: function () {
    return exec('destroy.js')
  },

  unbind: function () {
    return exec('unbind.js')
  },

  throw: function () {
    return exec('throw.js')
  },

  uncatch: function () {
    return exec('uncatch.js')
  },

  loadoptions: function () {
    return exec('loadoptions.js')
  }

}
