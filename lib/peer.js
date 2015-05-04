'use strict';

var transport = require('skiff-transport-json');

/**
 * Creates RPC client
 * @param {String} hostname
 * @param {Number} port
 */
function Peer(allowedRemoteCalls, hostname, port) {
    return transport.connect(allowedRemoteCalls, hostname, port);
}

module.exports = Peer;
