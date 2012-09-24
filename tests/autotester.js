#!/usr/bin/env node

var fs = require('fs');
var util = require('util');
var fix = require("../fix.js");

if(process.argv.length <1){
    util.log("Usage: node autotester.jar <testcase>");
    process.exit(-1);
}

var testcase = process.argv[2];
var lines = [];
var responses = [];

var isErrorFree = true;

fs.readFile(testcase, function(err,data){
    if(err) throw err;
    var txt = data.toString().split('\n');
    for(s in txt){
        var line = txt[s];
        
        if(line.length < 2){ continue; }
        
        var command = line.charAt(0);
        
        if(command === "#"){ continue;}
        
        var fixstr = line.substr(1,line.length);
        var fixarr = fixstr.split('\u0001');
        
        var fixdata = {};
        for(i in fixarr){
            var keyval = fixarr[i].split('=');
            fixdata[keyval[0]] = keyval[1];
        }
        
        lines.push({command:command, detail:fixstr, fix:fixdata});
        
        //read command
        if(command === "E"){
            responses.push(fixdata);
        }
    }
    
    responses.reverse();
    var sess = null;
    
    
    for(var idx = 0; idx< lines.length; idx++){
        var line = lines[idx];
        
        if(line.command === "i" && line.detail === "CONNECT"){
            var nextfix = lines[idx+1];

            var version = nextfix.fix["8"];
            var sender = nextfix.fix["56"];
            var target = nextfix.fix["49"];
            
            sess = new fix.FIXSession(version,sender,target, {});
            sess.on('state',function(state){
                util.log("State change: "+JSON.stringify(state));
            });
            sess.on('outmsg',function(act){
                var exp = responses.pop();
                
                //util.log("Expected:"+JSON.stringify(exp));
                //util.log("Actual:"+JSON.stringify(act));

                
                var isError = false;
                var errors = [];
                
                for(actidx in act){
                    if(exp[actidx] === "<TIME>" || exp[actidx] == "00000000-00:00:00"){
                        continue;
                    }
                    if(act[actidx] !== exp[actidx]){
                        //util.log("Tag "+idx+"'s expected val ["+exp[idx]+"] does not match actual ["+act[idx]+"]");
                        var err = "[ERROR] Tag "+actidx+"'s expected val ["+exp[actidx]+"] does not match actual ["+act[actidx]+"]";
                        isError = true;
                        isErrorFree = false;
                        errors.push(err);
                    }
                }
                
                if(isError){
                    util.log("Expected:"+JSON.stringify(exp));
                    util.log("Actual:"+JSON.stringify(act));
                    
                    for(actidx in errors){
                        util.error(errors[idx]);
                    }
                }
            });

        }
        
        if(line.command === "i" && line.detail === "DISCONNECT"){
            sess.endSession();

        }
        
        if(line.command === "I"){
            util.log("Sending:"+JSON.stringify(line.fix));
            sess.processIncomingMsg(line.fix);
        }
        
        if(line.command === "E"){
            util.log("Receiving:"+JSON.stringify(line.fix));
            //continue;
        }
    }
    
    //if(isErrorFree) util.log(testcase+": PASS");
    //else util.log(testcase+": PASS");
});



