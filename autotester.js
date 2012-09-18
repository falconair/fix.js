#!/usr/bin/env node

var fs = require('fs');
var fix = require("./fix.js");

if(process.argv.length <1){
    console.log("Usage: node autotester.jar <testcase>");
    process.exit(-1);
}

var testcase = process.argv[2];
var lines = [];
var responses = [];

fs.readFile(testcase, function(err,data){
    if(err) throw err;
    var txt = data.toString().split('\n');
    for(s in txt){
        var line = txt[s];
        var command = line.charAt(0);
        var fixstr = line.substr(1,line.length);
        var fixarr = fixstr.split('\u0001');
        
        var fixdata = {};
        for(i in fixarr){
            var keyval = fixarr[i].split('=');
            fixdata[keyval[0]] = keyval[1];
        }
        
        lines.push({command:command, detail:fixstr, fix:fixdata});
        
        //read command
        if(command === "R"){
            responses.push(fixdata);
        }
    }
    
    responses.reverse();
    var sess = null;
    
    for(var idx = 0; idx< lines.length; idx++){
        var line = lines[idx];
        //console.log(JSON.stringify(line));
        
        if(line.command === "e" && line.detail === "CONNECT"){
            var nextfix = lines[idx+1];

            var version = nextfix.fix["8"];
            var sender = nextfix.fix["56"];
            var target = nextfix.fix["49"];
            
            sess = new fix.fixSession(version,sender,target, {});
            sess.onOutMsg(function(act){
                var exp = responses.pop();
                console.log("Expected:"+JSON.stringify(exp));
                console.log("Actual:"+JSON.stringify(act));
                
                for(idx in act){
                    if(exp[idx] === "<TIME>"){
                        continue;
                    }
                    if(act[idx] !== exp[idx]){
                        console.log("Tag "+idx+"'s expected val ["+exp[idx]+"] does not match actual ["+act[idx]+"]");
                    }
                }
            });

        }
        
        if(line.command === "e" && line.detail === "DISCONNECT"){
            sess.endSession();

        }
        
        if(line.command === "E"){
            sess.processIncomingMsg(line.fix);
        }
    }
});

