#!/usr/bin/env node

var assert = require('assert');
var util = require('util');
var fix = require('../fix.js');



function fixSessionTest() {
  var f = new fix.FIXSession("FIX.4.2", "SNDRCMPID", "TRGTCMPID", {});

  f.on('outmsg', function(msg) {
    assert.equal(msg[35], "A", "Expected outgoing message to be logon 'A'");
    assert.equal(msg[8], "FIX.4.2");
    assert.equal(msg[49], "SNDRCMPID");
    assert.equal(msg[56], "TRGTCMPID");
    //assert.equal(msg[52],"A");
  });

  f.sendLogon();

}

function fixSessionTest2() {
  var outCounter = 1;
  var f = new fix.FIXSession("FIX.4.2", "SNDRCMPID", "TRGTCMPID", {});

  f.on('outmsg', function(msg) {
    console.log("OUT:" + JSON.stringify(msg));

    if (outCounter === 1) {
      assert.equal(msg[35], "A", "Expected outgoing message to be logon 'A'");
      assert.equal(msg[8], "FIX.4.2");
      assert.equal(msg[49], "SNDRCMPID");
      assert.equal(msg[56], "TRGTCMPID");
      //assert.equal(msg[52],"A");
    }
    if (outCounter === 2) {
      assert.equal(msg[35], "0", "Expected outgoing message to be heartbeat '0'");
      assert.equal(msg[8], "FIX.4.2");
      assert.equal(msg[49], "SNDRCMPID");
      assert.equal(msg[56], "TRGTCMPID");
      //assert.equal(msg[52],"A");
    }
    outCounter++;
  });

  f.on('error', function(msg) {
    console.log("ERROR:" + JSON.stringify(msg));
  });

  f.on('msg', function(msg) {
    console.log("MSG:" + JSON.stringify(msg));
  });

  f.processIncomingMsg({
    8: "FIX.4.2",
    49: "SNDRCMPID",
    56: "TRGTCMPID",
    52: new Date().getTime(),
    34: 1,
    35: "A",
    108: "10"
  });
  f = null;
}

function testClient() {

  var fixc = new fix.FIXClient("FIX.4.2", "SNDRCMPID", "TRGTCMPID", {});
  //fixc.connect("remotehost",8080);
  fixc.connect("debug", function(session, error) {
    //connection attempt resulted in error
    assert.fail(error, error);

    session.sendLogon();

    //connected
    fix.on('msg', function(msg) {
      assert.equal(msg[34], "A", "Expected first message to be logon 'A'");
    });
  });

  //fixc.setOption("send-heartbeats","true");

}

//Execute tests
//fixSessionTest();
//fixSessionTest2();
