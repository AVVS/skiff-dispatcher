'use strict';

var url = require('url');
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var _ = require('lodash');
var propagate = require('propagate');

// skiff parts
var Skiff = require('skiff-redis');
var Gossip = require('sombrero-gossip');
var defaultOptions = require('./defaultOptions.js');
var Server = require('./server.js');
var Peer = require('./peer.js');
var callbackQueue = require('callback-queue');

/**
 * Creates task dispatcher node
 * @param {String} skiffURL
 * @param {Object} options
 */
function Node(skiffURL, options) {
    var connectionData;

    // instanciate ee
    EventEmitter.call(this);

    // bind methods and get default options
    _.bindAll(this);
    _.defaults(options, defaultOptions);

    if (!skiffURL) {
        throw new Error('need skiff URL');
    }

    this.id = skiffURL;
    this._options = options;

    // init metadata
    connectionData = url.parse(skiffURL);
    this.metadata = {
        gossipPort: options.gossip.port,
        hostname: connectionData.hostname,
        port: options.port
    };
    options.skiff.metadata = this.metadata;

    // init skiff node
    // determines cluster leader and performs fail over if leader dies
    this.skiff = new Skiff(skiffURL, options.skiff);
    this.skiff.on('joined', this._onPeerJoined);
    this.skiff.on('reconnected', this._onPeerJoined);
    this.skiff.on('leader', this._onLeader);
    this.skiff.on('left', this._removePeerGossip);

    propagate(this.skiff, this);

    // setup gossip cluster - basically in-memory shared storage
    // useful for holding shared cluster state
    this._remotes = {};

    this._redisServer = new Server(this);
    this._transportServer = options.transport.listen(options.port, options.hostname, this._redisServer, this.__transportListening);

    this.gossip = new Gossip(this._options.gossip);
    this.gossip.on('error', this._proxyError);
    this.gossip.on('cluster change', this._onGossipClusterChange);
}
inherits(Node, EventEmitter);

//
// Cluster rpc-allowed operations
//

/**
 * Get resourceId of resourceType, if not exists - create it first.
 * The operation flow is the following: check local storage (gossip cluster),
 * if there is no result of this operation, queue this operation locally
 * and make a remote call
 *
 * @param  {String}   resourceId   - unique resource id, used for request queueing
 * @param  {String}   resourceType - resource type, determines what has to be done
 * @param  {Array}    args         - args to be applied to resource type
 * @param  {Function} next         - invoked when method completes
 *
 */
Node.prototype.getsetnx = function (resourceId, resourceType, args, next) {

    if (typeof resourceId !== 'string' || !resourceId) {
        return setImmediate(next, new Error('resourceId must be a truthy string'));
    }

    if (typeof resourceType !== 'string' || !this.allowedRemoteCalls[resourceType]) {
        return setImmediate(next, new Error('remote call ' + resourceType + ' is not allowed'));
    }

    var cluster = this.gossip.cluster;
    var operationKey = [ resourceType, resourceId ].join('~');
    var operationResult = cluster.get(operationKey);

    if (operationResult !== null && operationResult !== undefined) {
        return setImmediate(next, null, operationResult);
    }

    var callback = callbackQueue.add(operationKey, next);
    if (!callback) {
        // callback will be invoked later when ongoing operation will be completed
        return;
    }

    var currentLeader = cluster.get('leader');
    if (currentLeader === this.id) {
        return setImmediate(this[resourceType], resourceId, args, next);
    }

    setImmediate(this._remoteCall, currentLeader, 'getsetnx', [ resourceId, resourceType, args ], callback);
};

/**
 * Deletes specific resource type from shared storage, can be performed from either node
 * @param  {String}   resourceId
 * @param  {String}   resourceType
 * @param  {Function} next
 */
Node.prototype.del = function (resourceId, resourceType, next) {
    this.update(resourceId, resourceType, null, next);
};

/**
 * Updates specific resource type from shared storage, can be performed from either node
 *
 * @param  {String}   resourceId
 * @param  {String}   resourceType
 * @param  {Mixed}    value
 * @param  {Function} next
 *
 */
Node.prototype.update = function (resourceId, resourceType, value, next) {

    if (typeof resourceId !== 'string' || !resourceId) {
        return setImmediate(next, new Error('resourceId must be a truthy string'));
    }

    if (typeof resourceType !== 'string' || !this.allowedRemoteCalls[resourceType]) {
        return setImmediate(next, new Error('remote call ' + resourceType + ' is not allowed'));
    }

    if (value === undefined) {
        return setImmediate(next, new Error('value cant be set to undefined'));
    }

    var cluster = this.gossip.cluster;
    var operationKey = [ resourceType, resourceId ].join('~');
    var currentValue = cluster.get(operationKey);

    if (currentValue === value) {
        return setImmediate(next);
    }

    var currentLeader = cluster.get('leader');
    if (currentLeader === this.id) {
        cluster.set(operationKey, value);
        return setImmediate(next);
    }

    setImmediate(this._remoteCall, currentLeader, 'update', [ resourceId, resourceType, value ], next);
};

//
// Cluster topology section, public
//

Node.prototype.join = function join(url, options, next) {
    this.skiff.join(url, options || null, next);
};

Node.prototype.leave = function leave(url, next) {
    this.skiff.leave(url, next);
};

Node.prototype.open = function open(next) {
    this.skiff.open(next);
};

Node.prototype.close = function close(next) {
    var self = this;
    this._transportServer.close(function () {
        self.gossip.stop(function () {
            self.skiff.close(next);
        });
    });
};

//
// cluster setup section, private
//

/**
 * Performs RPC call
 * @param {String}   node   - node id to perform the operation on
 * @param {String}   method - method to invoke
 * @param {Array}    args   - arguments to pass
 * @param {Function} next   - callback that will be eventually called
 */
Node.prototype._remoteCall = function (node, method, args, next) {
    var remote = this._remote(node);
    var invoke = function (client) {
        var m = client[method];
        if (!m) {
            return next(new Error('Method not found: ' + method));
        }
        args.push(next);
        m.apply(client, args);
    };

    if (!remote) {
        return next(new Error('could not find remote metadata for URL ' + node));
    } else if (remote.connected) {
        invoke(remote.client);
    } else {
        remote.once('connect', invoke);
    }
};

/**
 * Establishes peer connection when it's first required to
 * @param  {String} node - node id
 * @return {TransportConnection}
 */
Node.prototype._remote = function (node) {
    var remote = this._remotes[node];
    if (!remote) {
        var meta = this.skiff.peerMeta(node);
        if (meta) {
            remote = this._remotes[node] = new Peer(meta.hostname, meta.port);
        }
    }

    return remote;
};

/**
 * Sets waitForNode option. It means that operation will only complete
 * after the command that was performed on the leader is propagated to the
 * local client
 *
 * @param {Object} options
 * @param {String} nodeId - optionally overwrite, which node we are waiting to commit
 */
Node.prototype._waitForNode = function (options, nodeId) {
    if (!options) {
        options = {};
    }
    options.waitForNode = nodeId || this.id;
    return options;
};

/**
 * When peer joins cluster, make it join gossip cluster as well
 * @param {Object} peer
 */
Node.prototype._onPeerJoined = function (peer) {
    if (peer && peer.id !== this.id && peer.metadata && peer.metadata.gossipPort) {
        this.gossip.addPeer({
            id: peer.id,
            hostname: peer.metadata.hostname,
            port: peer.metadata.gossipPort
        });
    }
};

/**
 * When node becomes a leader, set appropriate record in the shared doc
 */
Node.prototype._onLeader = function () {
    this._gossipLeader(this.id);
};

/**
 * When peer disconnected, remove it from shared store, too
 * @param {Object} peer
 */
Node.prototype._removePeerGossip = function (peer) {
    this.gossip.removePeer(peer.id);
};

/**
 * Promote this node to leader on the gossip cluster
 * @param {String} leaderId
 */
Node.prototype._gossipLeader = function (leaderId) {
    var cluster = this.gossip.cluster;
    var currentLeader = cluster.get('leader');
    if (currentLeader !== leaderId) {
        cluster.set('leader', leaderId);
    }
};

/**
 * Notifies when transport (gossip cluster) had connected to it
 * @param {Error} err
 */
Node.prototype._transportListening = function (err) {
    if (err) {
        this.emit('error', err);
        return;
    }

    this.emit('transport-connected');
};

/**
 * Proxies error emitted by some other EE
 * @param {Error} err
 */
Node.prototype._proxyError = function (err) {
    if (err) {
        this.emit('error', err);
    }
};

/**
 * Emitted when cluster change event was emitted on the gossip cluster
 */
Node.prototype._onGossipClusterChange = function () {
    this.emit('cluster change');
};

module.exports = Node;
