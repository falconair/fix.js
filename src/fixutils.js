"use strict";
var _ = require('underscore');

var SOHCHAR = exports.SOHCHAR = String.fromCharCode(1);

exports.getCurrentUTCTimeStamp = function() {
  return getUTCTimeStamp(new Date());
}

var getUTCTimeStamp = exports.getUTCTimeStamp = function(datetime) {
  const timestamp = datetime || new Date();
  const year = timestamp.getUTCFullYear();
  const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const day = String(timestamp.getUTCDate()).padStart(2, '0');
  const hours = String(timestamp.getUTCHours()).padStart(2, '0');
  const minutes = String(timestamp.getUTCMinutes()).padStart(2, '0');
  const seconds = String(timestamp.getUTCSeconds()).padStart(2, '0');
  const millis = String(timestamp.getUTCMilliseconds()).padStart(3, '0');

  return `${year}${month}${day}-${hours}:${minutes}:${seconds}.${millis}`;
};

var checksum = exports.checksum = function(str) {
  var chksm = 0;
  for (var i = 0; i < str.length; i++) {
    chksm += str.charCodeAt(i);
  }

  chksm = chksm % 256;

  var checksumstr = '';
  if (chksm < 10) {
    checksumstr = '00' + (chksm + '');
  } else if (chksm >= 10 && chksm < 100) {
    checksumstr = '0' + (chksm + '');
  } else {
    checksumstr = '' + (chksm + '');
  }

  return checksumstr;
}

var convertMapToFIX = exports.convertMapToFIX = function(map) {
  return convertToFIX(map, map[8], map[52], map[49], map[56], map[34]);
}

//TODO: No one calls thsi function directly, so make it?
//var convertToFIX = exports.convertToFIX = function(msgraw, fixVersion, timeStamp, senderCompID, targetCompID, outgoingSeqNum) {
var convertToFIX = function(msgraw, fixVersion, timeStamp, senderCompID, targetCompID, outgoingSeqNum) {
    //sys.log('c2F:'+JSON.stringify(msgraw));
  //defensive copy
  var msg = {};
  for (var tag in msgraw) {
    if (msgraw.hasOwnProperty(tag)) msg[tag] = msgraw[tag];
  }

  //These will be calculated, so remove them (how to simulate bad len and checksum?)
  delete msg['9']; //bodylength
  delete msg['10']; //checksum

  //TODO why is there a timestamp when a timeStamp is passed in?
  //var timestamp = new Date();
  var headermsgarr = [];
  var bodymsgarr = [];
  //var trailermsgarr = [];

  //msg['8'] = fixVersion; //fixversion
  //msg['52'] = timeStamp; //timestamp
  //msg['49'] = senderCompID; //sendercompid
  //msg['56'] = targetCompID; //targetcompid
  //msg['34'] = outgoingSeqNum; //seqnum


  headermsgarr.push('35=' + msg['35'], SOHCHAR);
  if (_.isNumber(timeStamp)) {
    headermsgarr.push('52=' + getUTCTimeStamp(new Date(timeStamp)), SOHCHAR);
  } else {
    headermsgarr.push('52=' + timeStamp, SOHCHAR);
  }
  headermsgarr.push('49=' + senderCompID, SOHCHAR);
  headermsgarr.push('56=' + targetCompID, SOHCHAR);
  headermsgarr.push('34=' + outgoingSeqNum, SOHCHAR);


  for (var tag in msg) {
    if (msg.hasOwnProperty(tag) 
      && tag !== '8' 
      && tag !== '9' 
      && tag !== '35' 
      && tag !== '10' 
      && tag !== '52' 
      && tag !== '49' 
      && tag !== '56' 
      && tag !== '34' 
      && tag !== ""){
        bodymsgarr.push(tag, '=', msg[tag], SOHCHAR);
      } 
  }

  var headermsg = headermsgarr.join('');
  //var trailermsg = trailermsgarr.join('');
  var bodymsg = bodymsgarr.join('');

  var outmsgarr = [];
  outmsgarr.push('8=', fixVersion, SOHCHAR);
  //outmsgarr.push('9=', (headermsg.length + bodymsg.length + trailermsg.length), SOHCHAR);
  outmsgarr.push('9=', (headermsg.length + bodymsg.length), SOHCHAR);
  outmsgarr.push(headermsg);
  outmsgarr.push(bodymsg);
  //outmsgarr.push(trailermsg);

  var outmsg = outmsgarr.join('');

  console.log('header', headermsg);
  console.log('bodymsg', bodymsg);
  console.log('outmsg', outmsg);

  outmsg += '10=' + checksum(outmsg) + SOHCHAR;

  return outmsg;

}

var convertToMap = exports.convertToMap = function(msg) {
  var fix = {};
  var keyvals = msg.split(SOHCHAR);
  for (var kv in Object.keys(keyvals)) {
    var kvpair = keyvals[kv].split('=');
    fix[kvpair[0]] = kvpair[1];
  }

  //TODO: Somehow an empty string is ending up in maps, look for it properly
  delete fix[''];

  return fix;

}

var memoryStore = exports.memoryStore = function(id) {
  console.log("Using default message store for id " + id);
  return new function() {
    var dataarray = [];
    this.add = function(id, data) {
      dataarray.push(data);
    };
    this.each = function(id, func) {
      _.each(dataarray, function(msg) {
        func(msg, false);
      });
      func(null, true);
    };
    //this.eachWithStartEnd = function(start, end, func){_.each(dataarray,func);};
  }
}
