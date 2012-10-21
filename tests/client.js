#!/usr/bin/env node

var util = require('util');
var fs = require('fs');
var fix = require('../fix.js');

var sendercompid = "CLIENT";
var targetcompid = "SERVER";
var port = 9878;

if(process.argv.length > 3){
        sendercompid = process.argv[2];
        targetcompid = process.argv[3];
}
if(process.argv.length > 4){
	port = parseInt(process.argv[4]);
}

console.log("FIX Server listening on port "+port+" with server "+ targetcompid+" and client id "+sendercompid);

var datastore = function(id){
    return new function(){
        this.add = function(id, data){
            console.log("Appending line to file "+id+":"+data);
            fs.appendFile("logs/"+id,data,function(error){
                if(error){
                    console.log("ERROR writing data to file "+id+" because of error:"+error);                    
                }
            });
        };
        this.each = function(id,func){
            console.log("Reading from file "+id);
            //fs.exists("logs/"+id, function(exists){
                if(fs.existsSync("logs/"+id)){
                //if(exists){
                    console.log("Message file for id "+id+" exists. Reading now.");
                    var stream = fs.createReadStream("logs/"+id,{flags:'r', encoding:'ascii'});
                    stream.on('data',function(data){
                        console.log("Restoring messages: "+data);
                        func(data);
                    });
                    stream.on('end', function(){
                        console.log("Done reading resync file for id "+id);
                    });
                }
                else{
                    console.log("No message file for id "+id+" exists");
                }
            //});
        };
    }
}

var client = new fix.FIXClient("FIX.4.2",sendercompid,targetcompid,{datastore:datastore});
client.createConnection({port:port}, function(session){
    session.on('logon',function(){
        util.log(">>>>>CLIENT-LOGON");
    });
    session.on('msg',function(msg){
        util.log(">>>>>CLIENT:"+JSON.stringify(msg));
    });
    session.on('outmsg',function(msg){
        util.log("<<<<<CLIENT:"+JSON.stringify(msg));
    });
    session.on('msg-resync',function(msg){
        util.log(">>>>>CLIENT-RESYNC:"+JSON.stringify(msg));
    });
    session.on('outmsg-resync',function(msg){
        util.log("<<<<<CLIENT-RESYNC:"+JSON.stringify(msg));
    });
    session.on('error',function(msg){
        util.log(">> >> >>CLIENT:"+JSON.stringify(msg));
    });
    session.on('state',function(msg){
        //util.log("-----CLIENT:"+JSON.stringify(msg));
    });
    session.on('disconnect',function(msg){
        util.log("-------CLIENT:"+JSON.stringify(msg));
    });
    
    session.sendLogon();
});


