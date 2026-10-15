'use strict';

// The compiled addon. Every module in lib/ reaches native code through here.
module.exports = require('bindings')('ortools_node');
