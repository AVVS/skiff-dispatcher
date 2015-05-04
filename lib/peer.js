'use strict';

var transport = require('skiff-transport-json');

/**
 * Creates RPC client
 * @param {String} hostname
 * @param {Number} port
 */
function Peer(hostname, port) {
    return transport.connect(hostname, port);
}

module.exports = Peer;
