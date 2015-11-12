#!/usr/bin/env node

var util = require('util');
var fs = require('fs');
var FIXClient = require('../src/fixClient.js');
var _ = require('underscore');


var sendercompid;
var targetcompid;
var port = 9878;
var host = "localhost";
var fixVersion = "FIX.4.2";

if (process.argv.length === 7) {
  host = process.argv[2];
  port = parseInt(process.argv[3]);
  fixVersion = process.argv[4];
  sendercompid = process.argv[5];
  targetcompid = process.argv[6];
} else {
  console.log("Usage: %s host port FIXVersion sendercompid targetcompid", process.argv[1]);
  process.exit();
}

console.log("FIX client connecting to %s:%s (%s %s)", host, port, sendercompid, targetcompid);

var client = new FIXClient(fixVersion, sendercompid, targetcompid, {});
client.init(function(clientx) {
  console.log("client initiated:" + _.keys(client));
  client.createConnection({
    port: port,
    host: host
  }, function(session) {
    session.on('logon', function () {
      console.log(">>>>> CLIENT-LOGON");
    });
    session.on('msg', function (msg) {
      console.log(">>>>> CLIENT: %j", msg);
    });
    session.on('outmsg', function (msg) {
      console.log("<<<<< OUT MSG: %j", msg);
    });
    session.on('msg-resync', function (msg) {
      console.log(">>>>> CLIENT-RESYNC: %j", msg);
    });
    session.on('outmsg-resync', function (msg) {
      console.log("<<<<< CLIENT-RESYNC: %j", msg);
    });
    session.on('error', function (msg) {
      console.log(">> >> >> ERROR: %j", msg);
    });
    session.on('state', function (msg) {
      // util.log("-----CLIENT:"+JSON.stringify(msg));
    });
    session.on('disconnect', function (msg) {
      console.log("----- DISCONNECT: %j", msg);
    });

    session.sendLogon();
  });

});

console.log("client exiting");
