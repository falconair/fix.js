"use strict";

var util = require('util');
var net = require('net');
var events = require('events');
var filedatastore = require('./filedatastore.js');
var fixutils = require('./fixutils.js');
var FIXSession = require('./fixSession.js');
var FixFrameDecoder = require('./fixFrameDecoder');
var _ = require('underscore');


module.exports = FIXServer;

/*==================================================*/
/*====================FIXServer====================*/
/*==================================================*/
function FIXServer(compID, options){
        var self = this;

        var servers = {};
        var server = net.createServer(function(socket){
            //connected
            var frameDecoder = new FixFrameDecoder();
            var fixSession = null;
            var perserverself = this;

            frameDecoder.on('msg',function(msgtxt){
                var msg = fixutils.convertToMap(msgtxt);

                if(_.isUndefined(perserverself.fixSession )){
                    var fixVersion = msg[8];
                    var senderCompID = msg[56];
                    var targetCompID = msg[49];

                    var extendedOptions = _.extend(options,{shouldRespondToLogon:true, datastore:filedatastore.filedatastore});
                    perserverself.fixSession = new FIXSession(fixVersion, senderCompID, targetCompID, extendedOptions);

                    var serverid = perserverself.fixSession.getID();
                    servers[serverid ] = perserverself.fixSession;

                    perserverself.fixSession.on('msg',function(msg){ self.emit('msg',serverid, msg); });
                    perserverself.fixSession.on('state',function(msg){ self.emit('state',serverid ,msg); });
                    perserverself.fixSession.on('logon',function(){ self.emit('logon',serverid); });
                    perserverself.fixSession.on('error',function(type,msg){ self.emit('error',serverid ,type,msg); });

                    perserverself.fixSession.on('outmsg',function(msg){
                        var outstr = fixutils.convertMapToFIX(msg);
                        socket.write(outstr);
                        self.emit('outmsg',serverid ,msg);
                    });


                    perserverself.fixSession.init(function(){
                        perserverself.fixSession.processIncomingMsg(msg);
                    });


                }
                else{
                    perserverself.fixSession.processIncomingMsg(msg);
                }

            });

            frameDecoder.on('error',function(type, msg){
                if(perserverself.fixSession === null || _.isUndefined(perserverself.fixSession)){
                    self.emit('error','UNKNOWN',type,msg);
                }
                else{
                    self.emit('error',serverid,type,msg);
                }
                if(type === 'FATAL'){
                    socket.end();
                }
            });

            socket.on('data',function(data){

                frameDecoder.processData(data);
            });

            socket.on('end', function(){
                if(!_.isUndefined(perserverself.fixSession)){
                    delete servers[perserverself.fixSession.getID()];
                    perserverself.fixSession.modifyBehavior({shouldSendHeartbeats:false, shouldExpectHeartbeats:false});
                    //TODO self.emit('disconnect',serverid);
                }
            });
        });


        this.listen = function(){
            server.listen.apply(server,arguments);
            //server.listen(arguments);
        };
}
util.inherits(FIXServer, events.EventEmitter);
