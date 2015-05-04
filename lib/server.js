'use strict';

var ALLOWED_REMOTE_CALLS = [ 'getsetnx', 'update' ];

/**
 * Sets up skiff server that will be performing remote procedures
 * Basically a proxy to skiff node defined in index file
 *
 * @param {Skiff Node} skiff
 *
 */
function Server(skiffDispatcher) {
    this.skiffDispatcher = skiffDispatcher;
}

Server.prototype.getsetnx = function () {
    return this.skiffDispatcher.getsetnx.apply(this.skiffDispatcher, arguments);
};

Server.prototype.update = function () {
    return this.skiffDispatcher.update.apply(this.skiffDispatcher, arguments);
};

Server.remoteMethods = ALLOWED_REMOTE_CALLS;

module.exports = Server;
