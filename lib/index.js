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

    this._redisServer = new Server(this.skiff);
    this._transportServer = options.transport.listen(options.port, options.hostname, this._redisServer, this.__transportListening);

    this.gossip = new Gossip(this._options.gossip);
    this.gossip.on('error', this._proxyError);
    this.gossip.on('cluster change', this._onGossipClusterChange);
}
inherits(Node, EventEmitter);

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
