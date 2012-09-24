#!/usr/bin/env node

var util = require('util');
var fix = require('../fix.js');

var sendercompid = "CLIENT";
var sendercompid = "SERVER";
if(process.argv.length > 3){
        sendercompid = process.argv[2];
        targetcompid = process.argv[3];
}

var client = new fix.FIXClient("FIX.4.2",sendercompid,targetcompid,{});
client.createConnection({port:9878}, function(session){
    session.on('msg',function(msg){
        util.log(">>>>>CLIENT:"+JSON.stringify(msg));
    });
    session.on('outmsg',function(msg){
        util.log("<<<<<CLIENT:"+JSON.stringify(msg));
    });
    session.on('error',function(msg){
        util.log(">> >> >>CLIENT:"+JSON.stringify(msg));
    });
    session.on('state',function(msg){
        //util.log("-----CLIENT:"+JSON.stringify(msg));
    });
    
    session.sendLogon();
});