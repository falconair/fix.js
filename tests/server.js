#!/usr/bin/env node

var util = require('util');
var fix = require('../fix.js');

var compid = "SERVER";
if(process.argv.length > 2){
        compid = process.argv[2];
}

var server = new fix.FIXServer(compid,{});
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
server.listen(9878);