# Skiff dispatcher

Cluster that is connected together, has shared in-memory state, allows queued
tasks on the leader and then passes control to followers that requested to perform
the operation, or any other peer for that matter.

This module contains only basic structure and needs to be extended to suit your needs.
By itself it's pretty much useless

Cluster state is persisted to redis, each node has it's own copy of cluster's metadata
that is eventually synced.

`npm install skiff-dispatcher -S`

## Usage

```js

var Dispatcher = require('skiff-dispatcher');
var _ = require('lodash');


Dispatcher.attachRemoteCall('methodName', function rpcEnabledCall(resourceId, resourceType, arg1, arg2, ..., next) {
    // func
});

```
