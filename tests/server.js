#!/usr/bin/env node

var util = require('util');
var fix = require('../fix.js');

var server = new fix.FIXServer("SERVER",{});
server.on('msg',function(id, msg){
        util.log(">>>>>SERVER("+id+"):"+JSON.stringify(msg));        
});
server.on('outmsg',function(id, msg){
        util.log("<<<<<SERVER("+id+"):"+JSON.stringify(msg));        
});
server.on('state',function(id, msg){
        //util.log("-----SERVER("+id+"):"+JSON.stringify(msg));        
});
server.on('error',function(id, msg){
        util.log(">> >> >>SERVER("+id+"):"+JSON.stringify(msg));        
});
server.listen(1234);