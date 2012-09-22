#!/usr/bin/env node

var util = require('util');
var fix = require('../fix.js');

var server = new fix.FIXServer("SERVER",{});
server.onMsg(function(id, msg){
        util.log(">>>>>SERVER("+id+"):"+JSON.stringify(msg));        
});
server.onOutMsg(function(id, msg){
        util.log("<<<<<SERVER("+id+"):"+JSON.stringify(msg));        
});
server.onStateChange(function(id, msg){
        //util.log("-----SERVER("+id+"):"+JSON.stringify(msg));        
});
server.onError(function(id, msg){
        util.log(">> >> >>SERVER("+id+"):"+JSON.stringify(msg));        
});
server.listen(1234);