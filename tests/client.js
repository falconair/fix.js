#!/usr/bin/env node

var util = require('util');
var fix = require('../fix.js');

var client = new fix.FIXClient("FIX.4.2","CLIENT","SERVER",{});
client.createConnection({port:1234}, function(session){
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