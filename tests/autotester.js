#!/usr/bin/env node

var fs = require('fs');
var util = require('util');
var FIXSession = require("../src/fixSession.js");
var fixutil = require("../src/fixutils.js");

if (process.argv.length < 3) {
  console.log("Usage: node autotester.js <testcase> [<isVerbose>]");
  process.exit(-1);
}

var testcase = process.argv[2];
var isVerbose = process.argv[3] || false;
var lines = [];
var responses = [];

var isErrorFree = true;

fs.readFile(testcase, function(err, data) {
  if (err) throw err;
  var txt = data.toString().split('\n');
  for (s in txt) {
    var line = txt[s];

    if (line.length < 2) {
      continue;
    }

    var command = line.charAt(0);

    if (command === "#") {
      continue;
    }

    var fixstr = line.substr(1, line.length);

    if(command == 'I' || command == 'E'){
      fixstr=fixstr.replace('<TIME>',fixutil.getUTCTimeStamp());
      fixstr=fixstr.replace('52=00000000-00:00:00','52='+fixutil.getUTCTimeStamp());
      fixstr=fixstr.replace('10=0\u0001','');
      fixstr = fixstr + '10='+fixutil.checksum(fixstr)+'\u0001';
    }

    var fixarr = fixstr.split('\u0001');

    var fixdata = {};
    for (i in fixarr) {
      var keyval = fixarr[i].split('=');
      fixdata[keyval[0]] = keyval[1];
    }

    lines.push({
      command: command,
      detail: fixstr,
      fix: fixdata
    });

    //read command
    if (command === "E") {
      responses.push(fixdata);
    }
  }

  responses.reverse();

  processTestScript(lines);


  //if(isErrorFree) console.log(testcase+": PASS");
  //else console.log(testcase+": PASS");
});

function processTestScript(lines){
  var sess = null;
  for (var idx = 0; idx < lines.length; idx++) {
    if(isVerbose) console.log("\n\n");
    
    var line = lines[idx];

    if (line.command === "i" && line.detail === "CONNECT") {
      var nextfix = lines[idx + 1];

      var version = nextfix.fix["8"];
      var sender = nextfix.fix["56"];
      var target = nextfix.fix["49"];

      sess = new FIXSession(version, sender, target, {});
      sess.on('state', function(state) {
        if(isVerbose) console.log("State change: " + JSON.stringify(state));
      });
      sess.on('outmsg', function(act) {
        var exp = responses.pop();

        if(isVerbose) console.log("Expected:"+JSON.stringify(exp));
        if(isVerbose) console.log("Actual  :"+JSON.stringify(act));


        var isError = false;
        var errors = [];

        for (actidx in act) {
          if (exp[actidx] === "<TIME>" || exp[actidx] == "00000000-00:00:00") {
            continue;
          }
          if (act[actidx] !== exp[actidx]) {
            //if(isVerbose) console.log("Tag "+idx+"'s expected val ["+exp[idx]+"] does not match actual ["+act[idx]+"]");
            var err = "[ERROR] Tag " + actidx + "'s expected val [" + exp[actidx] + "] does not match actual [" + act[actidx] + "]";
            if(isVerbose) console.log(err);
            isError = true;
            isErrorFree = false;
            errors.push(err);
          }
        }

        if (isError) {
          if(isVerbose) console.error("Expected:" + JSON.stringify(exp));
          if(isVerbose) console.error("Actual  :" + JSON.stringify(act));

          for (actidx in errors) {
            console.error(errors[idx]);
          }
        }
      });

    }

    if (line.command === "i" && line.detail === "DISCONNECT") {
      sess.endSession();

    }

    if (line.command === "I") {
      if(isVerbose) console.log("Sending:" + JSON.stringify(line.fix));
      sess.processIncomingMsg(line.fix);
    }

    if (line.command === "E") {
      if(isVerbose) console.log("Receiving:" + JSON.stringify(line.fix));
      //continue;
    }
  }
}
