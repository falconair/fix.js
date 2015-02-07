#!/usr/bin/env node

var util = require('util');
var fs = require('fs');
var FIXClient = require('../src/fixClient.js');
var _ = require('underscore');


var sendercompid = "CLIENT";
var targetcompid = "SERVER";
var port = 9878;

if (process.argv.length > 3) {
  sendercompid = process.argv[2];
  targetcompid = process.argv[3];
}
if (process.argv.length > 4) {
  port = parseInt(process.argv[4]);
}

console.log("FIX client listening on port " + port + " with server " + targetcompid + " and client id " + sendercompid);

var client = new FIXClient("FIX.4.2", sendercompid, targetcompid, {});
client.init(function(clientx) {

  console.log("client initiated:" + _.keys(client));

  client.createConnection({
    port: port
  }, function(session) {
    session.on('logon', function() {
      util.log(">>>>>CLIENT-LOGON");
    });
    session.on('msg', function(msg) {
      util.log(">>>>>CLIENT:" + JSON.stringify(msg));
    });
    session.on('outmsg', function(msg) {
      util.log("<<<<<CLIENT:" + JSON.stringify(msg));
    });
    session.on('msg-resync', function(msg) {
      util.log(">>>>>CLIENT-RESYNC:" + JSON.stringify(msg));
    });
    session.on('outmsg-resync', function(msg) {
      util.log("<<<<<CLIENT-RESYNC:" + JSON.stringify(msg));
    });
    session.on('error', function(msg) {
      util.log(">> >> >>CLIENT:" + JSON.stringify(msg));
    });
    session.on('state', function(msg) {
      //util.log("-----CLIENT:"+JSON.stringify(msg));
    });
    session.on('disconnect', function(msg) {
      util.log("-------CLIENT:" + JSON.stringify(msg));
    });

    session.sendLogon();
  });

});

console.log("client exiting");