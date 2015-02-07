#!/usr/bin/env node

var util = require('util');
var FIXServer = require('../src/fixServer.js');

var compid = "SERVER";
var port = 9878;

if(process.argv.length > 2){
        compid = process.argv[2];
}

if(process.argv.length > 3){
        port = process.argv[3];
}

console.log("FIX Server listening on port "+port+" with id "+ compid);

var server = new FIXServer(compid,{});
server.on('logon',function(id){
        util.log(">>>>>SERVER-LOGON("+id+")");
});
server.on('msg',function(id, msg){
        util.log(">>>>>SERVER("+id+"):"+JSON.stringify(msg));
});
server.on('outmsg',function(id, msg){
        util.log("<<<<<SERVER("+id+"):"+JSON.stringify(msg));
});
server.on('msg-resync',function(id, msg){
        util.log(">>>>>SERVER-RESYNC("+id+"):"+JSON.stringify(msg));
});
server.on('outmsg-resync',function(id, msg){
        util.log("<<<<<SERVER-RESYNC("+id+"):"+JSON.stringify(msg));
});
server.on('state',function(id, msg){
        //util.log("-----SERVER("+id+"):"+JSON.stringify(msg));
});
server.on('error',function(id, msg){
        util.log(">> >> >>SERVER("+id+"):"+JSON.stringify(msg));
});
server.listen(port);
