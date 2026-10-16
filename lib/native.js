'use strict';

// The compiled addon. Every module in lib/ reaches native code through here;
// lib/loader.js decides which build to load.
module.exports = require('./loader').loadAddon();
