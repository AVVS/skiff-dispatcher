'use strict';

var ALLOWED_REMOTE_CALLS = [];

/**
 * Sets up skiff server that will be performing remote procedures
 * Basically a proxy to skiff node defined in index file
 *
 * @param {Skiff Node} skiff
 *
 */
function Server(skiff) {
    this.skiff = skiff;
}

Server.remoteMethods = ALLOWED_REMOTE_CALLS;

module.exports = Server;
