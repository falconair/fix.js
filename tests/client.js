#!/usr/bin/env node

var util = require('util');
var fix = require('../fix.js');

var client = new fix.FIXClient("FIX.4.2","CLIENT","SERVER",{});
client.createConnection({port:1234}, function(session){
    session.onMsg(function(msg){
        util.log(">>>>>CLIENT:"+JSON.stringify(msg));
    });
    session.onOutMsg(function(msg){
        util.log("<<<<<CLIENT:"+JSON.stringify(msg));
    });
    session.onError(function(msg){
        util.log(">> >> >>CLIENT:"+JSON.stringify(msg));
    });
    session.onStateChange(function(msg){
        //util.log("-----CLIENT:"+JSON.stringify(msg));
    });
    
    session.sendLogon();
});