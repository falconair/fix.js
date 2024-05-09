//npm test
//node --test test.js
//node --test --coverage test.js

const assert = require('assert');
const { describe, it } = require('node:test');
const fix = require('../src/fix.js');
const fixutils = require('../src/fixutils.js');
const FIXSession = require('../src/fixSession.js');

describe('FIXSession', () => {

  it('should parse FIX correctly', () => {
    fixMap = fixutils.convertToMap("8=FIX.4.19=6135=A34=149=EXEC52=20121105-23:24:0656=BANZAI98=0108=3010=003");

    assert.equal(fixMap[8]  , 'FIX.4.1');
    assert.equal(fixMap[9]  , 61);
    assert.equal(fixMap[10] , '003');
    assert.equal(fixMap[34] , '1');
    assert.equal(fixMap[35] , 'A');
    assert.equal(fixMap[49] , 'EXEC');
    //assert.equal(fixMap[52] , 'DATE');
    assert.equal(fixMap[56] , 'BANZAI');
    assert.equal(fixMap[98] , '0');
    assert.equal(fixMap[108], '30');
    assert.ok(!('' in fixMap));

  });
  
  // it('should build FIX correctly', () => {

  //   fixIN = "8=FIX.4.19=6135=A34=149=EXEC52=20121105-23:24:0656=BANZAI98=0108=3010=003";
  //   fixMap = fixutils.convertToMap(fixIN);

  //   fixOUT = fixutils.convertMapToFIX(fixMap);

  //   assert.equal(fixIN, fixOUT);

  // });

  it('should send a logon message', () => {
    const f = new FIXSession("FIX.4.2", "SNDRCMPID", "TRGTCMPID", {});
    f.on('outmsg', function(msg) {
      assert.equal(msg[35], "A", "Expected outgoing message to be logon 'A'");
      assert.equal(msg[8], "FIX.4.2");
      assert.equal(msg[49], "SNDRCMPID");
      assert.equal(msg[56], "TRGTCMPID");
    });
    f.sendLogon();
  });

  it('should handle incoming messages', () => {
    let outCounter = 1;
    const f = new FIXSession("FIX.4.2", "SNDRCMPID", "TRGTCMPID", {shouldSendHeartbeats: false, shouldExpectHeartbeats: false});
    f.on('outmsg', function(msg) {
      console.log("OUT:" + JSON.stringify(msg));
      if (outCounter === 1) {
        assert.equal(msg[35], "A", "Expected outgoing message to be logon 'A'");
        assert.equal(msg[8], "FIX.4.2");
        assert.equal(msg[49], "SNDRCMPID");
        assert.equal(msg[56], "TRGTCMPID");
      }
      if (outCounter === 2) {
        assert.equal(msg[35], "0", "Expected outgoing message to be heartbeat '0'");
        assert.equal(msg[8], "FIX.4.2");
        assert.equal(msg[49], "SNDRCMPID");
        assert.equal(msg[56], "TRGTCMPID");
      }
      outCounter++;
    });

    f.on('error', function(msg) { console.error("ERROR:" + JSON.stringify(msg)); });

    f.on('msg', function(msg) { console.log("MSG:" + JSON.stringify(msg)); });

    f.processIncomingMsg({
      8: "FIX.4.2",
      49: "SNDRCMPID",
      56: "TRGTCMPID",
      52: new Date().getTime(),
      34: 1,
      35: "A",
      108: "10"
    });

    f.endSession()

  });
});

// describe('FIXClient', () => {
//   it('should connect and send a logon message', () => {
//     const fixc = new fix.FIXClient("FIX.4.2", "SNDRCMPID", "TRGTCMPID", {});
//     fixc.connect("debug", function(session, error) {
//       assert.ifError(error);
//       session.sendLogon();
//       fix.on('msg', function(msg) {
//         assert.equal(msg[34], "A", "Expected first message to be logon 'A'");
//       });
//     });
//   });
// });