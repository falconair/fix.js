"use strict";

var util = require('util');
var net = require('net');
var events = require('events');
var fixutils = require('./fixutils.js');
var FixFrameDecoder = require('./fixFrameDecoder');
var filedatastore = require('./filedatastore.js');
var FIXSession = require('./fixSession.js');
var _ = require('underscore');

module.exports = FIXClient;

/*==================================================*/
/*====================FIXClient====================*/
/*==================================================*/
function FIXClient(fixVersion, senderCompID, targetCompID, options) {

  var self = this;
  var socket = null;

  var extendedOptions = _.extend(options, {
    datastore: filedatastore.filedatastore
  });
  var session = new FIXSession(fixVersion, senderCompID, targetCompID, extendedOptions);
  //session.init(donefunc(self));
  //session.init(function(){donefunc(self)});

  /*******Public*******/

  //[PUBLIC] get unique ID of this session
  this.getID = function() {
    var serverName = fixVersion + "-" + senderCompID + "-" + targetCompID;
    return serverName;
  }

  //TODO on('syncmsg',...) crash recovery
  //TODO on('syncoutmsg',...) crash recovery

  //callback subscription methods
  //[PUBLIC] listen to incoming messages (user apps subscribe here)
  //arguments: json object
  //this.onMsg = function(callback){ session.onMsg(callback); }

  //[PUBLIC] listen to outgoing messages (only used by admin apps)
  //arguments: json object
  //this.onOutMsg = function(callback){ session.onOutMsg(callback); }

  //[PUBLIC] listen to error messages
  //arguments: type -- (FATAL, ERROR, etc.) -- fatal means session is gone
  //arguments: description -- text description
  //this.onError = function(callback){ session.onError(callback); }

  //[PUBLIC] listen to state changes (only used by admin apps)
  //arguments: json object -- example: {loggedIn:true}
  //this.onStateChange = function(callback){ session.onStateChange(callback); }

  //[PUBLIC] listen to end of session alerts (only used by system apps)
  //  for example, tcp connector uses this to find out when to disconnect
  //this.onEndSession = function(callback){ session.onEndSession(callback); }

  //[PUBLIC] Sends FIX json to counter party
  this.sendMsg = function(msg) {
    session.sendMsg(msg);
  }

  //[PUBLIC] Sends logon FIX json to counter party
  this.sendLogon = function() {
    session.sendLogon();
  }

  //[PUBLIC] Sends logoff FIX json to counter party
  this.sendLogoff = function() {
    session.sendLogoff();
  }

  //[PUBLIC] Modify's one or more 'behabior' control variables.
  //  Neverever used outside of testing
  this.modifyBehavior = function(data) {
    session.modifyBehavior(data);
  }

  //[PUBLIC] initializes session
  this.init = function(donecallback) {
    session.init(donecallback);
  }


  this.createConnection = function(options, listener) {
    self.socket = net.createConnection(options, function() {

      //client connected, create fix session
      var fixFrameDecoder = new FixFrameDecoder();
      fixFrameDecoder.on('msg', function(datatxt) {
        var data = fixutils.convertToMap(datatxt);
        session.processIncomingMsg(data);
      });
      fixFrameDecoder.on('error', function(type, error) {
        //TODO handle
      });

      //TODO users of clients need to subscribe to outgoing/incoming msgs, error, etc.
      session.on('outmsg', function(msg) {
        var outstr = fixutils.convertMapToFIX(msg);
        self.socket.write(outstr);
        self.emit('outmsg', msg);
      });
      session.on('endsession', function() {
        self.socket.end();
        self.emit('endsession');
      });
      session.on('msg', function(msg) {
        self.emit('msg', msg);
      });
      session.on('logon', function() {
        self.emit('logon');
      });

      self.socket.on('connect', function() {
        self.emit('connect');
      });

      self.socket.on('data', function(data) {
        fixFrameDecoder.processData(data);
      });

      self.socket.on('end', function(data) {
        session.modifyBehavior({
          shouldSendHeartbeats: false,
          shouldExpectHeartbeats: false
        });
        self.emit('disconnect');
      });

      //pass on this session to client
      listener(self);

    });
  }
}
util.inherits(FIXClient, events.EventEmitter);